# RADIUS Profile 下发 VLAN / QoS / ACL — PRD 设计说明

| 文档信息 | |
|---|---|
| 版本 | v1.1 |
| 日期 | 2026-08-27 |
| 作者 | 齐活林（交付总监） |
| 状态 | **前后端已实现上线** |
| 关联项目 | D:\radius（FreeRADIUS + 华为 AC6003 + S57 交换机） |

---

## 1. 背景与目标

### 1.1 现状

| 组件 | 状态 | 说明 |
|------|------|------|
| FreeRADIUS | ✅ | 用户认证（radcheck + TOTP 双因子） |
| daloRADIUS 框架 | ✅ | 管理 UI + dictionary 字典 |
| MariaDB | ✅ | radius 库（radusergroup / radgroupreply 等） |
| 华为 AC6003 | ✅ | 无线控制器，VRP V200R019C00SPC500 |
| 华为 S57 | ✅ | 有线交换机，MAC 认证 / 802.1X |
| NAS 表 | ✅ | 192.168.30.15（secret: Huawei@Radius123） |

已有能力：用户认证、TOTP 双因子、MAC 免认证（radmacbypass 三表）、QoS 限速（`group-guest` 组已在用 `Huawei-Input/Output-Average-Rate`）。

### 1.2 目标

以 **用户组（Profile）** 为核心，统一实现三类网络策略的 RADIUS 下发，做到「同一用户按所属组自动获得：隔离网段（VLAN）+ 限速（QoS）+ 访问权限（ACL）」。

---

## 2. 核心概念：Profile = 用户组 + 回复属性

在 FreeRADIUS / daloRADIUS 体系里，**没有独立的 "profile" 表**。所谓 Profile，本质是两张表的组合：

| 表 | 作用 | 语义 |
|----|------|------|
| `radusergroup` | 用户 → 组 的映射 | 「double 属于 ops 组」 |
| `radgroupreply` | 组 → 回复属性 | 「ops 组的用户，认证成功后下发这些属性」 |

**下发链路**：

```
用户认证成功
  → FreeRADIUS 查出该用户所属的所有组
  → 汇总这些组的 radgroupreply 属性
  → 打包进 Access-Accept 报文
  → 返回给 NAS（AC / 交换机）
  → NAS 按属性执行（划 VLAN / 限速 / 套 ACL）
```

> 关键：`radgroupreply` 的 `op` 字段固定用 `:=`（赋值下发）。`radgroupcheck` 的 `op` 是 `==`（认证时校验），两者别混。

---

## 3. 三种能力总览

| 能力 | 下发属性 | 下发的是 | 作用层 | NAS 侧前提 |
|------|---------|---------|-------|-----------|
| **VLAN** | `Tunnel-Type` + `Tunnel-Medium-Type` + `Tunnel-Private-Group-Id` | **值**（VLAN 号） | 二层隔离 | 创建 VLAN + 开授权 VLAN |
| **QoS** | `Huawei-*-Average-Rate`（AC）/ `HW-*-Information-Rate`（交换机） | **值**（速率 bps） | 限速 | 原生支持 |
| **ACL** | `Filter-Id` / `HW-Data-Filter` | **名字**（引用预定义 ACL） | 访问控制 | 预先建好 ACL |

**核心区别（务必理解）**：

```
VLAN / QoS：RADIUS 直接下发"值"，NAS 拿到就能执行。
ACL      ：RADIUS 只下发"名字"，ACL 的规则内容必须预先在交换机上定义，
           RADIUS 不负责传规则，只负责"点名套用"。
```

---

## 4. VLAN 下发设计

### 4.1 标准属性（RFC 3580，通用）

| 属性 | 值 | 含义 |
|------|-----|------|
| `Tunnel-Type` | `13`（或 `VLAN`） | 隧道类型 = VLAN |
| `Tunnel-Medium-Type` | `6`（或 `IEEE-802`） | 介质 = 以太网 |
| `Tunnel-Private-Group-Id` | `100` | VLAN ID |

> 字典已内置（`dictionary.rfc2868`），无需额外配置。

### 4.2 radgroupreply 配置示例（组 ops 进 VLAN 100）

```
groupname=ops, attribute=Tunnel-Type,            op=:=, value=VLAN
groupname=ops, attribute=Tunnel-Medium-Type,     op=:=, value=IEEE-802
groupname=ops, attribute=Tunnel-Private-Group-Id, op=:=, value=100
```

### 4.3 生效条件（交换机侧，缺一不可）

1. 交换机端口已配 **MAC 认证 / 802.1X**；
2. 端口允许 **RADIUS 授权 VLAN**（华为 `authorization vlan` 相关）；
3. VLAN 100 已在交换机上**提前创建**。

---

## 5. QoS 下发设计

### 5.1 两套属性（无线 AC 与有线交换机不同）

| 设备 | 属性 | 单位 | 说明 |
|------|------|------|------|
| 华为 AC6003（无线） | `Huawei-Input-Average-Rate` | bps | 入方向平均速率（**已在用**） |
| 华为 AC6003（无线） | `Huawei-Output-Average-Rate` | bps | 出方向平均速率（**已在用**） |
| 华为 S57（有线） | `HW-Input-Committed-Information-Rate` | bps | 入方向 CIR（保证速率） |
| 华为 S57（有线） | `HW-Input-Peak-Information-Rate` | bps | 入方向 PIR（峰值速率） |
| 华为 S57（有线） | `HW-Output-Committed-Information-Rate` | bps | 出方向 CIR |
| 华为 S57（有线） | `HW-Output-Peak-Information-Rate` | bps | 出方向 PIR |

### 5.2 现有配置参考（group-guest，4M 入 / 8M 出）

```
groupname=group-guest, attribute=Huawei-Input-Average-Rate,  op=:=, value=4096000
groupname=group-guest, attribute=Huawei-Output-Average-Rate, op=:=, value=8192000
```

> 单位是 **bps**：`4096000` = 4 Mbps，`8192000` = 8 Mbps。

### 5.3 有线侧示例（S57，入 10M / 出 20M）

```
groupname=staff, attribute=HW-Input-Committed-Information-Rate,  op=:=, value=10240000
groupname=staff, attribute=HW-Input-Peak-Information-Rate,       op=:=, value=10240000
groupname=staff, attribute=HW-Output-Committed-Information-Rate, op=:=, value=20480000
groupname=staff, attribute=HW-Output-Peak-Information-Rate,      op=:=, value=20480000
```

---

## 6. ACL 下发设计

### 6.1 属性选择

| 属性 | 类型 | 适用 |
|------|------|------|
| `Filter-Id` | 标准（RFC 2865） | 通用，引用交换机上预定义的 ACL 名 |
| `HW-Data-Filter` | 华为私有 VSA | 华为交换机原生数据过滤 |

字典均已内置（`Filter-Id` 在 `dictionary.rfc2865`，`HW-Data-Filter` 在华为 VSA 字典）。

### 6.2 配置示例

```
groupname=ops, attribute=Filter-Id, op=:=, value=3000
```

或华为原生：

```
groupname=ops, attribute=HW-Data-Filter, op=:=, value=3000
```

### 6.3 完整链路

```
① 网络管理员在华为交换机预先建 ACL（如 acl 3000：deny 访问 172.18.204.0/24）
② 后台给 ops 组配 reply 属性 Filter-Id := 3000
③ 终端认证 → FreeRADIUS 命中 ops 组 → Access-Accept 携带 Filter-Id=3000
④ 华为交换机把 ACL 3000 套用到该用户端口/会话
⑤ 该用户流量被 ACL 3000 过滤
```

> ⚠️ ACL 的**规则内容**必须在交换机上用命令配好，RADIUS 只下发「名字」。RADIUS 侧改了 Filter-Id 值，如果交换机上没有对应 ACL，下发会失败或无效果。

---

## 7. 数据模型

核心表 `radgroupreply`（组回复属性）：

| 字段 | 说明 | 示例 |
|------|------|------|
| `groupname` | 组名（关联 radusergroup） | `ops` |
| `attribute` | 属性名（关联 dictionary） | `Tunnel-Private-Group-Id` |
| `op` | 操作符（下发固定 `:=`） | `:=` |
| `value` | 属性值 | `100` |

一张表同时承载 VLAN + QoS + ACL 三类属性，靠 `attribute` 字段区分。

---

## 8. 实施步骤

| 步骤 | 动作 | 涉及方 |
|------|------|--------|
| 1 | 确认目标组（如 ops / staff / guest）与对应策略 | 管理员 |
| 2 | 交换机侧：创建 VLAN、建 ACL、开授权 VLAN | 网络工程师 |
| 3 | RADIUS 侧：给目标组 INSERT 对应的 radgroupreply 属性 | 开发/运维 |
| 4 | 用户重新认证（触发 Access-Accept 下发） | 终端 |
| 5 | 验证：查 VLAN 归属 / 测速 / 访问 ACL 拦截目标 | QA |

### 8.1 落地 SQL 示例（ops 组：VLAN 100 + ACL 3000 + 入 10M 限速）

```sql
INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES
('ops', 'Tunnel-Type',            ':=', 'VLAN'),
('ops', 'Tunnel-Medium-Type',     ':=', 'IEEE-802'),
('ops', 'Tunnel-Private-Group-Id',':=', '100'),
('ops', 'Filter-Id',              ':=', '3000'),
('ops', 'HW-Input-Committed-Information-Rate',  ':=', '10240000'),
('ops', 'HW-Output-Committed-Information-Rate', ':=', '20480000');
```

---

## 9. 交换机侧前提条件（汇总）

| 能力 | 交换机侧必须满足 |
|------|----------------|
| VLAN | 端口配认证模式 + 允许 RADIUS 授权 VLAN + VLAN 已创建 |
| QoS | 无特殊（华为原生支持速率属性） |
| ACL | 预先用命令创建对应编号/名称的 ACL |

---

## 10. 风险与边界

1. **ACL 内容不归 RADIUS 管**：规则要交换机侧定义，两边编号必须对得上，否则静默失效。
2. **有线/无线属性不通用**：AC6003 用 `Huawei-*-Average-Rate`，S57 用 `HW-*-Information-Rate`，混用会导致下发无效。
3. **属性值单位**：QoS 速率统一用 **bps**（bit/s），不是 Bps。
4. **下发即时性**：用户需重新认证（或触发 CoA）才重新拿到新属性，已在线用户改策略后需踢线重连。
5. **与零信任的关系**：本方案是「入网即隔离/限速/过滤」（交换机侧），零信任 zt_acl_rule 是「应用层细粒度控权」（Tailscale 侧），两者定位不同、可叠加，勿混淆。

---

## 11. 实现说明（已上线）

### 11.1 后端接口（`routers/groups.py`）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/groups/{g}/profile` | 结构化解析：把 radgroupreply 属性反向解析为 `{vlan, qos_up_mbps, qos_down_mbps, acl_id, raw[]}`；QoS 从两套属性任取非空值，bps→Mbps 无损换算；未识别属性进 `raw` 原样保留 |
| PUT | `/groups/{g}/profile` | 幂等保存：**显式事务**内先清理旧模板属性再写入新值，raw 自定义属性不动；失败自动回滚 |
| GET | `/groups` | 新增 `profile_attrs` 字段（每组已配下发属性计数），列表页显示徽章 |

**属性映射规则**：

```
表单 VLAN=100        → Tunnel-Type := VLAN
                      Tunnel-Medium-Type := IEEE-802
                      Tunnel-Private-Group-Id := 100      （3 条）
表单 上行 10Mbps     → Huawei-Input-Average-Rate  := 10000000   （AC 无线）
                      HW-Input-Committed-Information-Rate := 10000000 （S57 有线）
表单 下行 20Mbps     → Huawei/Output 两套同理                    （2×2 条）
表单 ACL=3000        → Filter-Id := 3000                         （1 条）
```

### 11.2 前端页面（admin-spa「用户组管理」）

每个组新增 **Profile** 按钮 → 展开行内编辑面板：

| 字段 | 说明 |
|------|------|
| VLAN ID | 空 = 不隔离；填入即三件套下发 |
| 上行限速 (Mbps) | Input 方向 = 用户发出流量 |
| 下行限速 (Mbps) | Output 方向 = 用户收到流量 |
| ACL 编号/名称 | 需交换机预建对应 ACL |

底部展示 raw 自定义属性（只读提示"保存时保留不动"）。列表新增「下发属性」列（N 项徽章）。

### 11.3 兼容历史数据

- 现有 `group-guest`（4.096M 入 / 8.192M 出）可正确解析回显，重新保存无损往返。
- 换算精度：整 Mbps 显示整数，非整保留全部小数（`4096000 bps ↔ 4.096 Mbps` 双向无损）。

### 11.4 踩坑记录

1. ⚠️ `radgroupreply` 表**没有 `priority` 列**——初版 INSERT 带 priority 导致保存失败且先删后插丢了 group-guest 数据（已恢复）。同款 bug 存在于旧的 `POST /groups/{g}/reply` 接口，一并修复。
2. 教训：对已有数据的 DELETE+INSERT 必须包事务（现实现 `conn.begin()` + 失败 rollback）。

---

## 12. 二期设计：用户 Profile 页面（定义模板 + 用户授权）

> 状态：**已实现上线（v1.3）**。目标：把「按组配策略」升级为「Profile 模板库 + 用户一键授权」。

### 12.1 核心概念

**Profile = 命名的策略模板**（VLAN + QoS + ACL 的组合）。定义一次，反复授权给多个用户；用户换绑即时切换策略。

与一期「用户组 Profile」的关系：Profile 底层仍复用 `radgroupreply`（组回复属性），只是在之上加了元数据与授权视图——**FreeRADIUS 零配置改动**。

### 12.2 数据模型

| 存储 | 内容 | 说明 |
|------|------|------|
| 新表 `radius_profiles` (id, name UNIQUE, description, created_at) | 模板清单（人定义的） | 元数据 |
| `radgroupreply` (groupname = profile 名) | 实际下发属性 | 复用一期结构化读写 |
| `radusergroup` (username, groupname = profile 名) | 授权关系 | FreeRADIUS 原生链路 |

### 12.3 排他规则（关键决策）

一个用户同时绑多个含 VLAN/QoS 的 Profile 会产生属性冲突（两个 VLAN 号、两套限速同时下发）。

- **采用：一用户一 Profile（排他换绑）**——授权新 Profile 自动解除旧绑定
- 业务分组（IT/ops 等）与 Profile 并存不受影响；防呆检查：若旧绑定组里含策略属性则提示确认

### 12.4 后端 API

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/profiles` | 列表（描述 / 属性概要 VLAN·上行·下行·ACL / 绑定人数） |
| POST | `/profiles` | 新建 `{name, description}` → 写元数据 + radgroupcheck 占位 |
| PUT / DELETE | `/profiles/{id}` | 改描述 / 删除（有绑定用户时拒绝并提示先解绑） |
| PUT | `/profiles/{id}/attrs` | 结构化保存属性（内部调用一期的 group profile 同款逻辑） |
| PUT | `/users/{u}/assign-profile` | `{name \| none}` 排他换绑 |

### 12.5 前端

1. 新页面 **「用户 Profile」**（路由 `/user-profiles`，侧边栏新入口）：列表 + 「新建 Profile」+ 行内展开属性编辑（同 Groups 页面样式）
2. **用户管理页**每行新增「授权 Profile」下拉（列出全部模板 + 未授权），选择即换绑
3. Profile 名即 groupname，用户在 Groups 页看到的同名组就是它的底层实现（同一数据两种视角）

### 12.6 生效与边界

- 授权/换绑后需重新认证或 CoA 踢线才拿到新策略
- ACL 编号仍需交换机预建（不变）
- 删除有绑定的 Profile 必须先解绑用户，防止属性残留

---

## 13. 版本记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-27 | v1.3 | 二期实现上线：radius_profiles 表 + profiles.py 全套接口 + 「用户 Profile」页面（/user-profiles）+ 用户管理页授权下拉。踩坑：新建表 collation 必须对齐 daloRADIUS 原生表（utf8mb4_unicode_ci），否则 JOIN 报 1267；无参数 SQL 里 DATE_FORMAT 的 %% 不展开 |
| 2026-08-27 | v1.2 | 新增二期设计（第 12 章）：用户 Profile 页面——radius_profiles 元数据 + 复用 radgroupreply/radusergroup，一用户一 Profile 排他换绑 |
| 2026-08-27 | v1.1 | 前后端实现上线：Profile 结构化接口 + 用户组管理页可视化配置；修复 radgroupreply 无 priority 列的历史 bug；数据先删后插改事务化 |
| 2026-08-27 | v1.0 | 初版：VLAN / QoS / ACL 三类下发的属性、数据模型、实施步骤、前提与风险 |
