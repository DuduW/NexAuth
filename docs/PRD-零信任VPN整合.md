# 零信任 × VPN 整合 — PRD

> ⚠️ **2026-09-21 17:34 已否决**：用户明确「不需要页面整合，需要零信任自身的具体方案」。本档归档留参，后续方向见 `docs/PRD-零信任ZTNA.md`。

| 文档信息 | |
|---|---|
| 版本 | v0.1（已否决归档） |
| 日期 | 2026-09-21 |
| 作者 | 吴大宝（产品负责人）+ AI 交付 |
| 状态 | **草案 — 等待用户确认后实施** |
| 关联文档 | docs/PRD-零信任网关.md（v1.4）、docs/PRD-NetAgent客户端.md |
| 关联代码 | src/backend/routers/{vpn.py, zt.py}、src/frontend/src/pages/{Vpn*,Zt*}、client/（NetAgent） |

---

## 1. 背景与问题

### 1.1 现状：两套并行体系

系统当前有两条独立远程接入通道，**身份、权限、审计三张皮**：

| 维度 | VPN（WireGuard） | 零信任（Headscale+Tailscale） |
|---|---|---|
| 定位 | 远程连回内网的传统通道 | 内网精细控权的 Mesh 层 |
| 隧道 | wg0 `10.99.0.0/24`（UDP 8001） | tailscale0 `100.64.0.0/10`（:41641，控制面 :8081） |
| 授权粒度 | **网段级**（vpn_user_access → vpn_ip_resources） | **域名/CIDR/端口级**（radusergroup → zt_acl_rule） |
| 授权数据 | 专用表，与零信任不共享 | 复用 radusergroup 用户组 |
| 客户端 | NetAgent 双卡并存（VPN 卡 metric 10） | NetAgent 双卡并存（ZT 卡 metric 5 优先） |
| 管理 UI | admin-spa「VPN 管理」5 页 | admin-spa「零信任」4 页 |
| 审计 | vpn_access_log / traffic / visit | zt_access_log（allow/deny 决策） |

### 1.2 痛点（整合动因）

| # | 痛点 | 影响 |
|---|---|---|
| P1 | **授权模型两套**：VPN 授权资源和零信任 ACL 规则各自维护，无关联 | 同一个人"零信任只能访问 3 台服务器，但 VPN 一拨入整个 172.18 网段全通"，零信任形同虚设 |
| P2 | **管理入口两处**：管理员要分别在"VPN 管理""零信任"两个菜单下操作 | 运维心智负担大，容易漏配 |
| P3 | **审计割裂**：一个用户白天 VPN 拨入、晚上零信任接入，日志分散在 5 张表 | 安全事件回溯需要跨表拼接 |
| P4 | **ACL 同步引擎缺失**：zt_acl_rule 只是存储，未打通 Headscale policy 执行层（旧 PRD 第 9 章遗留） | 零信任规则"配了不生效"，是零信任体系最大缺口 |
| P5 | 客户端两张卡各连各的，无统一状态视图 | 用户不清楚"我现在到底能访问什么" |

### 1.3 整合原则（产品哲学）

> **一个身份、一套权限、一个入口、按需选择通道。**

- **不是替代，是融合**：VPN 保留（解决"连得上"），零信任升级（解决"管得细"）
- **策略单一事实源**：权限只在一处定义，两条通道都按同一份策略执行
- **渐进式**：分四期落地，每期可独立交付验证，不推倒重来

---

## 2. 目标与非目标

### 2.1 目标（G1-G4）

| # | 目标 | 度量 |
|---|---|---|
| G1 | **统一策略中心**：一套"主体→资源→动作"策略同时驱动 VPN AllowedIPs 与零信任 ACL | 同一用户两通道可见资源 100% 一致 |
| G2 | **策略生效闭环**：zt_acl_rule → Headscale policy 同步引擎上线（补 P4） | 后台改规则 ≤10s 两侧生效 |
| G3 | **统一管理入口**：admin-spa 新增「统一接入」一级分区，合并运营视图 | 原 9 页收敛为 1 总览 + 5 功能页 |
| G4 | **统一审计**：任一用户跨两通道的访问行为可单页检索 | 一键查出用户全链路时间线 |

### 2.2 非目标（明确不做）

- ❌ 不替换 WireGuard / Headscale 任一底座（保留双通道架构）
- ❌ 不做客户端大改版（NetAgent 只加"统一状态"模块，不动现有三卡布局）
- ❌ 不做多租户 / SaaS 化
- ❌ 不做 per-application 级（L7）策略，本期保持 L3/L4（IP:端口）
- **最小化对现有功能的影响**：既有 VPN 5 页与零信任 4 页在本期保留可用（只加新分区，不删旧页），下线放到期末评估

---

## 3. 总体架构

### 3.1 整合后架构图

```
                          ┌────────────────────────────────┐
                          │   admin-spa「统一接入」分区      │
                          │  总览 / 策略中心 / 用户视图 /     │
                          │  会话管理 / 统一审计             │
                          └───────────────┬────────────────┘
                                          │ REST
                          ┌───────────────▼────────────────┐
                          │  FastAPI (8000)                │
                          │  ├─ routers/unified.py（新）     │
                          │  │   策略编译：主体→资源→动作      │
                          │  ├─ routers/vpn.py（已有）       │
                          │  └─ routers/zt.py（已有）        │
                          └──────┬─────────────────┬───────┘
                                 │                 │
              ┌──────────────────▼────┐   ┌────────▼──────────────────┐
              │ 策略分发（新组件）       │   │ MariaDB / radius 库       │
              │ ① 编译 VPN 视图:        │   │  un_policy_*（新表族）     │
              │   AllowedIPs per user  │   │  + 既有 vpn_* / zt_* 保留  │
              │ ② 编译 ZT 视图:         │   └──────────────────────────┘
              │   Headscale ACL JSON   │
              └───────┬────────┬───────┘
                      │        │
          ┌───────────▼──┐  ┌──▼──────────────────────┐
          │ WireGuard wg0│  │ Headscale :8081          │
          │ :8001        │  │ policy set → 各节点生效   │
          │ (VPN 通道)    │  │ (零信任通道)              │
          └───────┬──────┘  └──────┬──────────────────┘
                  │                │
              ┌───▼────────────────▼───┐
              │ NetAgent 客户端          │
              │ 双卡：ZT(metric 5) +    │
              │ VPN(metric 10)          │
              └────────────────────────┘
```

### 3.2 核心设计：统一策略模型（单向同步）

**关键决策**：新建 `un_policy_*` 表族作为策略单一事实源，**单向编译**到两个执行面：

```
管理员在「策略中心」定义：
  主体（用户/组）──▶ 资源（CIDR/域名段/IP 资源）──▶ 通道（both/vpn/zt）──▶ 动作（allow/deny）
        │                        │
        ▼                        ▼
  ┌───────────────── 编译器（FastAPI 内）──────────────────┐
  │ VPN 视图：user → AllowedIPs 汇总（含隧道网段保障）        │
  │ ZT 视图：group → Headscale ACL JSON（grants 语法）       │
  └───────────────────────────────────────────────────────┘
        │                        │
        ▼                        ▼
  vpn_connect 下发 allowed_ips   headscale policy set
  （wg set 热加载）              （节点即时生效）
```

为什么单向而非双向同步：双向同步必然出现冲突仲裁问题；单向（un_policy → 两执行面）模型简单、可测试、可回滚（un_policy 表保留历史版本快照）。

### 3.3 数据模型（新表族）

```sql
-- 统一策略：主体→资源绑定（策略单一事实源）
CREATE TABLE un_policy_binding (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subject_type ENUM('user','group') NOT NULL,      -- user 或 group
  subject_name VARCHAR(64) NOT NULL,               -- 用户名或 radusergroup.groupname
  resource_id INT NOT NULL,                        -- FK → vpn_ip_resources（复用资源库）
  channel ENUM('both','vpn','zt') DEFAULT 'both',  -- 生效通道
  action ENUM('allow','deny') DEFAULT 'allow',
  priority INT DEFAULT 100,
  status TINYINT DEFAULT 1,
  created_by VARCHAR(64),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_subject_resource (subject_type, subject_name, resource_id)
);

-- 策略编译版本与分发状态
CREATE TABLE un_policy_version (
  id INT AUTO_INCREMENT PRIMARY KEY,
  version_tag VARCHAR(40) NOT NULL,                -- 如 v20260921.1
  compiled_by VARCHAR(64),
  vpn_allowedips_snapshot JSON,                    -- 编译产物快照（回滚用）
  zt_policy_snapshot JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 统一审计视图（聚合不搬数据，视图 + 网关字段）
CREATE OR REPLACE VIEW v_unified_audit AS
SELECT 'vpn' AS channel, username, ip AS source_ip, 'connect' AS action, detail AS target, created_at
  FROM vpn_access_log
UNION ALL
SELECT 'zt', username, '', action, CONCAT(target,' ',COALESCE(reason,'')), created_at
  FROM zt_access_log
UNION ALL
SELECT 'vpn', username, virtual_ip, 'traffic', CONCAT('up=',up_bytes,' down=',down_bytes), session_start
  FROM vpn_traffic_log;
```

要点：
- **资源库复用** `vpn_ip_resources`（name/type/value/description），零信任侧域名类资源直接用 type=domain
- **既有表全部保留**：vpn_user_access / zt_acl_rule 在过渡期作为只读镜像，期末（M3 后）评估下线
- 分组桥接：subject_type=group 时 subject_name 即 radusergroup.groupname，与零信任三层数据模型一致

### 3.4 策略编译与分发（补 P4，同步引擎）

```
触发方式：a) 策略中心保存时自动；b) 定时兜底每 5min 对账；c) 手动"立即同步"

① 编译 VPN 视图：
   对每个 enabled 的 vpn_peers：
     allowed_ips = 该用户（含其所有组展开）allow 资源 ∩ channel∈(both,vpn) 的 CIDR 并集
                 + 隧道网段（ensure_tunnel_subnet 已有逻辑）
   → UPDATE vpn_peers.allowed_ips + wg set 热加载（不中断现有会话）

② 编译 ZT 视图（Headscale ACL JSON，grants 语法）：
   { "groups": {"group:ops": ["double@"]},
     "acls"/"grants": [{ "src": ["group:ops"], "dst": ["172.18.0.10:443"], "ip": ["*"] }] }
   → headscale policy set -f /tmp/policy.json
   → 失败回滚到上一 un_policy_version 快照 + 告警

③ 对账（幂等）：
   wg show wg0 与 vpn_peers 期望值 diff；headscale policy get 与快照 diff；不一致自动重推
```

编译冲突规则（同主体同资源多规则时）：
1. deny 优先于 allow（安全优先）
2. user 规则优先于 group 规则（精准优先）
3. 同级按 priority 升序，命中即止

---

## 4. 功能需求

### 4.1 FR-1 统一接入总览（新页 `/unified`）

| 项 | 内容 |
|---|---|
| 布局 | 顶部 6 张状态卡 + 中部双通道对比卡 + 底部最近会话表 |
| 状态卡 | 在线 VPN 会话数 / 在线 ZT 设备数 / 策略版本（当前 version_tag + 同步状态●）/ 今日告警 / 授权用户数 / 资源总数 |
| 双通道卡 | 左：WireGuard（端口/peer 数/今日流量/健康●）右：Tailscale（节点数/在线率/ACL 规则数/同步延迟） |
| 最近会话 | v_unified_audit 最近 20 条，badge 标注通道（VPN 蓝 / ZT 紫） |
| 数据接口 | GET /unified/overview（聚合 vpn.server/status + zt/dashboard + 策略版本） |

### 4.2 FR-2 策略中心（新页 `/unified/policy`，核心页）

**三栏布局：左=主体树、中=策略列表、右=资源选择器**

| 区域 | 内容 |
|---|---|
| 左栏 主体树 | 用户组（radusergroup 去重）+ 单用户（radcheck），搜索过滤，显示每主体策略数 |
| 中栏 策略列表 | 该主体的绑定列表：资源名 / CIDR 或域名 / 通道chips（both/vpn/zt 可切换）/ 动作/action / priority / 状态开关 |
| 右栏 资源选择器 | vpn_ip_resources 全量列表（复用现有 IP 资产数据），支持新建资源（type: cidr/domain/host），勾选即绑定 |
| 顶部操作 | 【新增绑定】【立即同步】【查看编译预览】【版本历史】 |
| 编译预览弹窗 | 展示本次将生成的 VPN AllowedIPs 与 ZT ACL JSON，管理员确认后再下发（防误操作） |
| 保存行为 | 写 un_policy_binding → 触发编译 → 快照入 un_policy_version → 分发两侧 → 前端刷新同步状态 |

接口：GET/POST/PUT/DELETE /unified/policy；POST /unified/policy/compile-preview；POST /unified/policy/sync；GET /unified/policy/versions

### 4.3 FR-3 用户接入视图（新页 `/unified/user/:name`）

单一用户 360° 视图（整合 P3）：

- 身份卡：所属组（radusergroup）、VPN peer 状态、ZT 设备状态
- **我的资源**：按当前策略编译出的该用户可见资源清单（两通道合并去重），标注每资源生效通道
- 会话时间线：该用户所有 VPN 连接 + ZT 接入记录（时间轴混排）
- 快捷操作：临时授权（填资源+时长，到期自动回收）、全通道下线（wg remove peer + headscale 节点失效）

### 4.4 FR-4 会话管理（新页 `/unified/sessions`）

- 全局会话表：通道 / 用户 / 虚 IP 或 Mesh IP / 源 IP / 开始时间 / 流量 / 状态
- 筛选：通道、用户、时间范围
- 操作：单会话断开（VPN=CoA Disconnect 思路 wg peer remove；ZT=headscale node disable）
- 数据源：wg show dump + headscale nodes list 合并

### 4.5 FR-5 统一审计（新页 `/unified/audit`）

- 查询 v_unified_audit：通道 / 用户 / 动作(allow/deny/traffic) / 时间范围 / 关键字
- 支持"按用户聚合时间线"导出（复用 FR-3 视图）
- 保留策略：与现有 zt_access_log 同步保留

### 4.6 FR-6 NetAgent 客户端"统一状态"模块（轻量）

- VPN 卡与 ZT 卡上方加"接入总览"条：当前身份、双通道连接状态、**可达资源摘要**（从 /unified/user/self 拉取，缓存 5min）
- 接口：GET /unified/user/self（Bearer JWT，返回编译后的个人资源视图）
- 不改动现有三卡布局与操作逻辑

### 4.7 FR-7 存量数据迁移（一次性）

| 源 | 目标 | 规则 |
|---|---|---|
| vpn_user_access × vpn_ip_resources | un_policy_binding(subject=user, channel=both) | 1:1 平移，action=allow |
| zt_acl_rule | un_policy_binding(subject=group, channel=zt) | allow_cidrs→资源库（不存在则自动建 resource）；allow_domains→type=domain 资源；allow_ports 编译进 dst |

迁移工具：scripts/migrate_to_unified.py（dry-run 模式先出报告，确认后执行，可回滚——un_policy 表清空即可重来）

## 5. 非功能需求

| # | 需求 | 指标 |
|---|---|---|
| N1 | 策略同步延迟 | 保存 → 双通道生效 ≤10s |
| N2 | 同步失败安全 | policy set 失败自动回滚上一版本快照 + admin-spa 告警卡 |
| N3 | 兼容性 | 迁移后首月，既有 vpn.py / zt.py 接口行为不变（NetAgent 旧版仍可用） |
| N4 | 幂等 | 对账任务重复执行无副作用 |
| N5 | 权限 | admin-spa 管理员登录态（复用现有 JWT） |
| N6 | UI 风格 | 严格对齐现有 admin-spa（#f5f5f7 底 + 白卡 + 14~16px 圆角 + #1450C8 主色）——本轮页面设计稿已按此规范 |

## 6. 里程碑

| 阶段 | 内容 | 交付物 | 验收 |
|---|---|--- PRD v1.0 + 新页面设计稿（本轮） | 用户评审通过 |
| M1 同步引擎 | un_policy 表族 + 编译器 + Headscale policy 同步 + 对账 | scripts/ + unified.py 路由 + 单测 | G2：改规则 10s 生效 |
| M2 管理页面 | 总览 / 策略中心 / 用户视图 / 会话 / 统一审计 5 页 | admin-spa 新分区 | G3 |
| M3 客户端 | NetAgent 统一状态条 + /unified/user/self | NetAgent v3.x | G1 用户侧体感 |
| M4 收尾 | 存量迁移 + 旧页下线评估 + 文档 | 迁移报告 + v1.1 文档 | G4 全链路演练 |

## 7. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| Headscale policy 语法版本差异（acls vs grants） | 🟡 | M1 先在测试 policy 文件上验证，编译器按 headscale 实际版本适配 |
| VPN 侧 allowed_ips 变更影响在线会话 | 🟡 | 编译只 UPDATE + wg set 热加载不删 peer；deny 规则对 VPN 的语义=从并集剔除，自然收缩 |
| 双通道策略不一致窗口 | 🟢 | 对账 5min 兜底 + 总览页"同步状态"红灯可见 |
| 迁移期间新旧表并存的一致性 | 🟢 | 单向编译，旧表只读不写 |

## 8. 待用户确认的决策点

| # | 决策点 | 选项 |
|---|---|---|
| D1 | 整合深度 | A. 本 PRD 的"统一策略+渐进融合"（推荐）／B. 激进：VPN 仅保留为 ZT 的逃生通道 |
| D2 | 策略中心交互形态 | A. 三栏（主体树+策略+资源）（推荐）／B. 类似 VpnPerm 的扁平表格 |
| D3 | FR-6 客户端模块 | A. 本期做轻量状态条（推荐）／B. 下期再做 |
| D4 | 旧页面处置 | A. M4 前保留（推荐）／B. M2 上线即隐藏旧入口 |
