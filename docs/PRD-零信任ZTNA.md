# 零信任 ZTNA 落地方案 — PRD

| 文档信息 | |
|---|---|
| 版本 | v0.1（待评审） |
| 日期 | 2026-09-21 |
| 作者 | 吴大宝（产品负责人）+ AI 交付 |
| 状态 | **草案 — 等待用户确认后实施** |
| 前序文档 | docs/PRD-零信任网关.md（v1.4，现状基线） |
| 关联代码 | src/backend/routers/zt.py、src/frontend/src/pages/Zt*.jsx、/opt/zt_acl_sync.py、client/（NetAgent） |

---

## 0. 一句话方案

> 在已跑通的 Headscale+Tailscale Mesh 上，补齐「**设备准入、策略模型、生效闭环、审计深度、客户端体验**」五块拼图，把"能用的 Mesh"升级为"可运营的零信任网络（ZTNA）"，VPN 保持现状不动。

---

## 1. 现状盘点（基线 = PRD-零信任网关 v1.4）

### 1.1 已有资产（全部保留复用）

| 能力 | 实现 | 状态 |
|---|---|---|
| 控制面 | Headscale v0.29.3（:8081，sqlite） | ✅ 生产 |
| 数据面 | Tailscale Mesh 100.64.0.0/10，服务器节点 100.64.0.1 做 subnet router（通告 172.18/16、192.168/16） | ✅ 生产 |
| 用户/分组 | 复用 radusergroup（分组名 = ACL group_name） | ✅ |
| ACL 存储 | zt_acl_rule 表（组→域名/CIDR/端口） | ✅ |
| ACL 同步 | /opt/zt_acl_sync.py cron 60s → headscale policy set（域名自动解析为 IP，HuJSON v2） | ✅ |
| 审计 | 服务端 conntrack 采集 allow 流量写 zt_access_log | ✅（仅 allow，deny 已确认接受不记） |
| 管理台 | admin-spa 零信任 4 页（设备/分组/ACL/审计） | ✅ |
| 客户端 | NetAgent 紫色 ZT 卡（tailscale up + 预授权 key） | ✅ |

### 1.2 差距分析（本 PRD 要解决的问题）

| # | 缺口 | 现状痛点 | 风险 |
|---|---|---|---|
| G1 | **设备无生命周期** | 节点注册后永久有效，离职/换机不回收 | 离职设备仍在 Mesh 内 🔴 |
| G2 | **策略无生效时间与审批** | valid_from/valid_until 字段有但同步脚本不消费 | "临时授权"变成"永久授权" 🟡 |
| G3 | **同步链路单向无对账** | cron 盲推 policy set，失败无告警、无版本 | 策略静默失效不可知 🔴 |
| G4 | **审计缺上下文** | 只有 IP 五元组，无"哪条规则放行" | 排查要人肉比对规则 🟡 |
| G5 | **客户端黑盒** | ZT 卡只显示"已接入"，不知道自己能访问什么 | 用户报障"连不上"无从下手 🟡 |
| G6 | **Key 管理粗放** | 预授权 key 87600h（10 年）reusable | 一把万能钥匙 🔴 |
| G7 | **域名 ACL 依赖 DNS 解析时效** | 同步时解析一次，IP 变更后规则过期 | CDN 域名规则漂移 🟡 |

---

## 2. 目标与非目标

### 2.1 目标

| # | 目标 | 验收 |
|---|---|---|
| T1 | 设备全生命周期管理：注册→审批→在网→回收，离职一键下线 | 设备回收 ≤1 分钟全网生效 |
| T2 | 策略时效与状态机：启用/停用/即将到期/已过期自动处置 | 到期规则自动从 policy 摘除 |
| T3 | 同步闭环：版本化 + 对账 + 失败告警 + 一键回滚 | policy get 与 DB 期望 diff=0 |
| T4 | 审计上下文：每条 allow 日志关联命中的规则名 | 日志可回答"谁因哪条规则访问了什么" |
| T5 | 客户端透明化：ZT 卡显示可达资源 + 连接质量 | 用户自查"能访问什么"零求助 |
| T6 | Key 治理：短时效一次性 key + 用量审计 | 无 10 年 reusable key |

### 2.2 非目标

- ❌ 不动 VPN（WireGuard 通道保持现状，不做两套合并）
- ❌ 不做 L7 应用层识别（保持 L3/L4：IP:端口）
- ❌ 不记录 deny 审计（v1.4 已决策接受，维持）
- ❌ 不做多租户

---

## 3. 总体架构

```
┌───────────────────────────────────────────────────────────────┐
│                        管理平面                                 │
│  admin-spa 零信任分区（本次重设计 5 页）                          │
│  ① 安全总览  ② 设备管理  ③ 策略中心  ④ Key/准入  ⑤ 审计中心     │
└────────────────────────────┬──────────────────────────────────┘
                             │ REST /api/zt/*
┌────────────────────────────▼──────────────────────────────────┐
│                        控制平面（FastAPI zt.py 扩展）            │
│  设备生命周期引擎          策略编译器          同步/对账引擎       │
│  ·注册审批工作流           ·规则状态机          ·版本化快照        │
│  ·到期自动回收             ·时效计算            ·policy get 对账   │
│  ·tag 标记(machine/        ·域名解析缓存        ·失败告警+回滚     │
│    server/guest)          ·端口展开            ·手动立即同步      │
└──────┬─────────────────────┬───────────────────┬───────────────┘
       │                     │                   │
       ▼                     ▼                   ▼
┌──────────────┐   ┌──────────────────┐  ┌─────────────────────┐
│ Headscale    │   │ MariaDB radius   │  │ zt_sync v2（替代     │
│ ·nodes list  │   │ radusergroup     │  │ cron 脚本，常驻      │
│ ·node expire │   │ zt_acl_rule(+新) │  │ systemd 服务）       │
│ ·node delete │   │ zt_device(新)    │  │ 编译→set→对账→告警   │
│ ·preauthkeys │   │ zt_key_log(新)   │  │ 事件触发+5min 对账   │
│ ·policy set  │   │ zt_access_log    │  │                     │
└──────┬───────┘   └──────────────────┘  └──────────┬──────────┘
       │                                            │
       ▼            ┌───────────────────────────────▼──┐
┌──────────────┐    │        数据平面（不动）             │
│ Tailscale    │    │  Mesh 100.64.0.0/10               │
│ 客户端节点    │    │  subnet router 100.64.0.1         │
│ (NetAgent)   │    │  → 172.18.0.0/16, 192.168.0.0/16  │
└──────────────┘    └───────────────────────────────────┘
```

**设计原则**：数据面完全不动（Mesh 稳定性第一），只在管理/控制平面做增强；所有增强向后兼容——现有 zt_acl_rule 表加列不重建，zt_sync v2 部署当天即可接管旧 cron。

---

## 4. 数据模型（增量演进，不推倒）

### 4.1 新表 zt_device（设备台账，补 G1）

```sql
CREATE TABLE zt_device (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  node_id       INT              COMMENT 'Headscale node id',
  username      VARCHAR(64) NOT NULL,
  hostname      VARCHAR(128),
  os            VARCHAR(64),
  tailscale_ip  VARCHAR(45),
  tag           ENUM('machine','server','guest') DEFAULT 'machine',
  status        ENUM('pending','approved','expired','revoked') DEFAULT 'pending',
  owner_dept    VARCHAR(64)      COMMENT '归属部门（手工补录）',
  first_seen    DATETIME,
  approved_by   VARCHAR(64),
  approved_at   DATETIME,
  expire_at     DATETIME         COMMENT '设备有效期，NULL=永久（仅 server tag 可）',
  last_seen     DATETIME         COMMENT 'Headscale last_seen 镜像',
  remark        VARCHAR(256)
);
```

生命周期状态机：

```
 pending ──审批──▶ approved ──到期──▶ expired ──续期──▶ approved
                    │                    │
                    └──手动回收/离职──────▶ revoked（headscale node delete，不可逆）
```

### 4.2 zt_acl_rule 加列（补 G2/G4，不重建）

```sql
ALTER TABLE zt_acl_rule
  ADD COLUMN effective_now TINYINT GENERATED ALWAYS AS (
    status=1 AND (valid_from IS NULL OR valid_from<=NOW())
             AND (valid_until IS NULL OR valid_until>NOW())
  ) VIRTUAL,
  ADD COLUMN sync_state ENUM('pending','synced','failed') DEFAULT 'pending',
  ADD COLUMN last_synced_at DATETIME,
  ADD COLUMN last_error VARCHAR(256);
```

> 编译器只取 `effective_now=1` 的规则；到期自动出局，无需人工干预（补 G2）。sync_state 让每条规则的下发状态可见（补 G3 的规则粒度）。

### 4.3 新表 zt_key_log（Key 用量审计，补 G6）

```sql
CREATE TABLE zt_key_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  key_id INT, username VARCHAR(64),
  action ENUM('create','use','expire'),
  node_id INT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 4.4 zt_access_log 加列（补 G4 审计上下文）

```sql
ALTER TABLE zt_access_log
  ADD COLUMN rule_id INT COMMENT '命中的 zt_acl_rule.id',
  ADD COLUMN rule_name VARCHAR(128);
```

conntrack 采集器写入时反查命中的规则（编译产物缓存 IP→规则映射）。

---

## 5. 功能需求

### FR-1 安全总览（页面 ①）

| 元素 | 内容 |
|---|---|
| 顶部 6 卡 | 在线设备 / 待审批设备(红点) / 生效规则数 / 即将到期规则(≤7天,橙) / 今日 allow 事件 / 同步状态(版本+延迟+●) |
| 中部 | Mesh 拓扑示意（subnet router + 在线节点点阵）|
| 底部 | 待办列表：待审批设备 / 同步失败规则 / 即将到期规则（各带跳转） |
| 接口 | GET /zt/overview（聚合 dashboard + 同步引擎心跳） |

### FR-2 设备管理（页面 ②，核心补 G1/G5）

**列表列**：设备名 / 用户 / Tailscale IP / tag / 状态(●) / 最近在线 / 有效期至 / 归属部门 / 操作

**操作集**：
- 审批（pending→approved，回写 approved_by/at）
- 续期（expire_at +90d 默认，可自定义）
- 回收（revoked：`headscale nodes delete -i <id>`，二次确认弹窗展示该设备将失去的所有访问）
- 改 tag（machine/server/guest；guest tag 自动叠加最严格策略）
- 标签筛选 + 用户筛选 + 状态筛选；到期前 7 天列表黄标

**离职场景 SOP**（页面顶部"离职下线"按钮）：输用户名 → 展示其全部设备+活跃策略 → 一键全部回收 + 从所有组移除。

**接口**：GET/POST /zt/devices2（新生命周期接口，兼容保留 /zt/devices）；POST /zt/devices2/{id}/approve|renew|revoke|tag

### FR-3 策略中心（页面 ③，补 G2/G3）

在现有 ZtAcl 页基础上增强：

| 增强点 | 说明 |
|---|---|
| 状态列 | 每条规则显示：生效中/未开始/已过期/已停用/同步失败（红） |
| 时效字段强化 | valid_from/until 行内编辑；"复制为新规则"快速续期 |
| 同步状态 | sync_state 徽章 + last_error tooltip；顶部"立即同步"按钮 |
| 域名解析缓存展示 | 域名规则展开显示当前解析的 IP 列表 + 解析时间，IP 漂移检测（补 G7：解析变化即触发重编译） |
| 生效预览 | 选定组 → 展开该组成员最终合并的可达资源（IP:端口级矩阵） |

### FR-4 Key/准入治理（页面 ④，补 G6）

- 预授权 key 列表：时长/是否 reusable/已用次数/关联设备
- 新建 key 默认：**一次性 + 24h 有效**（替代 10 年 reusable）
- NetAgent 注册流程改为：客户端请求 → 服务端临时生成 key → 即用即焚（key 不落客户端磁盘）
- 历史 key 一键作废

### FR-5 审计中心（页面 ⑤，补 G4）

- 现有 ZtLog 增强：新增"命中规则"列（规则名超链跳策略页）
- 聚合视图：按用户/按目标资源/按规则 三个维度的小计卡片
- 导出：CSV（复用现有模式）

### FR-6 zt_sync v2 同步引擎（后端核心，补 G3）

替代 /opt/zt_acl_sync.py 的 cron 方案，`/opt/zt-sync/zt_sync.py` systemd 常驻：

```
事件驱动（zt_acl_rule 变更通知）──▶ 立即编译
定时对账（每 5min）──────────────▶ diff = 期望 policy vs headscale policy get
                                    ├─ 一致 → 心跳入库
                                    ├─ 不一致 → 重推（最多3次）→ 仍失败 → 回滚上一版本 + 告警
                                    └─ 域名重解析（每小时）→ IP 漂移则重编译
版本化：每次成功 set 前，快照存 /opt/zt-sync/versions/<ts>.json + MariaDB
回滚：管理台策略中心 → 版本历史 → 一键恢复任意快照
告警通道：写 zt_sync_alert 表 + admin-spa 总览红灯（本期不做外部推送）
```

### FR-7 NetAgent 客户端增强（补 G5，轻量）

- ZT 卡展开显示：Mesh IP / 连接质量（直连 or DERP 中继）/ **可达资源清单**（GET /zt/my-access，Bearer JWT，5min 缓存）
- 断开改为 `tailscale down` + 服务端 zt_device_status 标记（已有接口复用）

## 6. 非功能需求

| # | 需求 | 指标 |
|---|---|---|
| N1 | 策略生效延迟 | 规则保存→Mesh 生效 ≤10s（事件驱动） |
| N2 | 对账精度 | 5min 周期 diff=0；漂移自动纠正 |
| N3 | 回滚 | 任意历史版本 ≤30s 恢复 |
| N4 | 兼容 | zt_acl_rule/zt_access_log 只加列不改列；/zt/devices 老接口保留 |
| N5 | 数据面零变更 | 不重启 headscale/tailscale 服务部署同步引擎 |

## 7. 里程碑

| 期 | 内容 | 交付物 | 验收 |
|---|---|---|---|
| M0 | PRD v1.0 + 页面效果图（本轮） | 本文档 + 设计稿 | 用户评审通过 |
| M1 | zt_sync v2 引擎 + 表结构增量 | zt-sync 服务 + SQL + 单测 | T3 对账 diff=0 |
| M2 | 设备生命周期 + Key 治理 | zt.py 新接口 + 设备/Key 页 | T1 离职下线 SOP 演练 |
| M3 | 策略中心增强 + 审计上下文 | ZtAcl/ZtLog 改版 | T2/T4 |
| M4 | NetAgent 增强 + 收尾 | NetAgent v3.x + 文档 | T5 |

## 8. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| headscale policy set 语法版本差异 | 🟡 | M1 首周在测试 policy 验证，编译器按实际版本适配 |
| 设备回收误删在线业务节点 | 🟡 | 回收二次确认展示影响面；server tag 设备需输入节点名确认 |
| 域名→IP 解析在 CDN 场景漂移 | 🟡 | 每小时重解析 + 漂移告警；建议关键系统直接用 CIDR |
| zt_sync v2 与旧 cron 并发写 policy | 🔴 | M1 上线即 systemctl disable 旧 cron（部署清单第一步） |
| sqlite（Headscale）并发锁 | 🟢 | policy set 串行队列化，单飞行 |

## 9. 待确认决策点

| # | 决策点 | 选项 |
|---|---|---|
| D1 | 设备默认有效期 | A. 90 天自动到期续期（推荐）/ B. 永久+人工年检 |
| D2 | guest tag 策略 | A. 仅允许访问指定 DMZ 资源（推荐）/ B. 与普通设备同权 |
| D3 | 审计保留期 | A. 180 天后归档（推荐）/ B. 永久在线 |
| D4 | 旧 cron 脚本处置 | A. M1 上线即停用（推荐）/ B. 保留 1 周双跑观察 |
