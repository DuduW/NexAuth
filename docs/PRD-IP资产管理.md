# PRD — IP 资产管理（IPv4 / IPv6）

**项目**：Radius Admin（admin-spa）新增 IP 资产管理模块
**作者**：AI 起草，吴大宝评审
**状态**：📝 设计稿（PRD + 页面模板）待评审，未开发
**版本**：v0.3（2026-09-16 增加 §3.8 批量导入功能）
**关联**：`docs/PRD-华为交换机备份.md`（设备台账可关联）、NetAgent 零信任网关（10.99.0.0/24）、RADIUS 在线用户（MAC↔IP）

---

## 1. 背景与目标

### 1.1 背景
- 公司运维约 **1000 台服务器** + OpenStack VM + Ceph 集群 + 网络设备，跨多个网段（192.168.x.x 办公/管理、172.18.x.x IDC、10.99.0.0/24 零信任 WireGuard 等），当前 IP 分配靠 Excel/记忆，**无统一台账**。
- 常见痛点：新机器上架不知道哪些 IP 空闲；IP 冲突排查靠人肉 ping；下线设备 IP 未回收造成浪费；**公网 IP 散落在防火墙/云控制台/Excel 里，谁也说不清一共多少个公网地址、哪些还在用、NAT 映射指向哪台内网机器、备案和合约什么时候到期**；IPv6 规划（数据中心 RoCEv2 / 新机房）即将铺开，需要提前建立 v4+v6 统一管理能力。

### 1.2 目标（v1.0 可量化）
| 目标 | 指标 |
|---|---|
| 台账全覆盖 | 网段、IP、状态、归属人/设备 录入即可查，检索 < 1s |
| 状态可视 | 每网段利用率一眼可见（已用/保留/空闲/冲突 四态） |
| 双栈支持 | IPv4（0-32 前缀）与 IPv6（0-128 前缀）同表同界面管理 |
| 公网资产可视 | 公网地址/段统一登记：运营商、带宽、备案、域名、NAT 映射、合约到期 一屏可查 |
| 存量快速入库 | Excel/CSV 批量导入（网段/地址/NAT 映射三模板），先校验预览再入库，失败行不污染数据 |
| 溯源 | 每次分配/回收/变更留审计记录（谁、何时、改了什么） |

### 1.3 非目标（v1.0 不做）
- ❌ 自动扫描发现（ping sweep / ARP / SNMP 探测）→ v1.1
- ❌ IP 申请审批流（工单联动）→ v1.2
- ❌ DNS/DDI 集成、DHCP 配置下发 → 暂不考虑
- ❌ 与 NetBox 等开源 IPAM 对接/替换

---

## 2. 名词与约束

| 名词 | 说明 |
|---|---|
| 网段（subnet） | 一个 CIDR 前缀，如 `192.168.30.0/24`、`2408:8756::/48`，v4/v6 统一建模 |
| 地址（address） | 网段内单个 IP，状态 ∈ {已分配 allocated / 预留 reserved / 空闲 free / 冲突 conflict / 禁用 disabled} |
| 区域（zone） | 逻辑分区：办公 / IDC / 零信任 / 存储 / 测试 / DMZ，用于权限与筛选 |
| **公网地址（public）** | 运营商分配的公网 IPv4/IPv6（单地址或网段），scope=public 单独建模展示；私网 scope=private |
| **NAT 映射（nat_map）** | 公网地址（含端口）→ 私网地址（含端口）的一条转发规则，协议 ∈ {tcp/udp/any}；1:1 映射端口填 0 |
| 规范化 | 存储前统一转小写压缩形式（IPv6 `2408:8756:0::` → `2408:8756::`），IPv4 点分十进制 |

**关键约束**
1. **IPv6 地址长度 128 位**，MySQL 的 `INT`/`INET_ATON` 家族无法承载；统一用 `VARBINARY(16)` 存二进制 + `ip_text CHAR(45)` 存规范化文本（应用层 Python `ipaddress` 模块做解析/校验，不依赖 MariaDB `INET6_ATON`，规避 10.5 以下版本兼容问题）。
2. IPv6 网段可用地址数可达 2^64 以上，**前端统计禁止直接求和展示**，> 2^32 时显示科学计数近似（如 `≈ 1.8×10¹⁹`），后端用 Decimal。
3. `网络地址` 与 `广播地址`（仅 v4）默认置为 `disabled`，不计入可用容量。
4. 所有 IP 展示使用等宽字体（与站内 `<code>` 全局 12px 一致），IPv6 允许换行不截断。

---

## 3. 功能需求

### 3.1 网段管理（v1.0）
- 新建网段：CIDR（自动校验 v4/v6 与前缀范围）、名称、VLAN ID（可选，与交换机 VLAN 体系对应）、区域、网关、DNS1/DNS2、备注、启用开关。**CIDR 唯一**，重复返回 409。
- 编辑 / 启停 / 删除（删除前校验：网段内存在非空闲地址 → 409 拒绝，需先清空）。
- 列表展示：CIDR、版本徽标（v4 蓝 / v6 紫）、VLAN、区域、网关、**容量与利用率条**（已用/预留/空闲着色）、地址数、操作。
- 筛选：版本（全部/v4/v6）、区域、关键字（CIDR/名称）。
- 排序：默认按 CIDR 数值序（v4 先于 v6 可切换）。

### 3.2 地址台账（v1.0）
- **自动展开空闲地址**：网段创建后，v4 /24 自动生成 254 条空闲记录（网络/广播位不生成）；前缀宽于 /24 的 v4 网段与宽于 /120 的 v6 网段不预生成（前缀登记模式）。
- 地址字段：IP、状态徽标、主机名、MAC（可选）、资产类型（物理机/VM/网络设备/打印机/其他）、资产引用（可关联 sw_device / OpenStack VM 名）、使用人、部门、用途、分配时间、到期时间（可选）。
- 分配：空闲地址上点「分配」→ 弹窗录入主机名/资产/使用人/用途 → 状态变 allocated，写审计。
- 回收：已分配地址「释放」→ 确认弹窗（输入 IP 确认）→ 状态回 free，字段清空，写审计。
- 冲突标记：手动标记 conflict + 备注；v1.1 自动发现可自动置位。
- 批量：多选分配/释放/导出 CSV（含全字段）。
- 检索：关键字（IP/主机名/MAC/使用人）、状态多选、网段限定、区域联动；IP 列支持 `192.168.30.` 前缀即时过滤。

### 3.3 统计看板（v1.0）
- 统计卡 ×4：网段数（v4/v6 分列）、总地址容量、已分配数（利用率 %）、本周新增分配。
- 每网段利用率条：🟢 <60% / 🟡 60-85% / 🔴 >85%（与 Ceph 容量阈值习惯一致）。

### 3.4 审计日志（v1.0）
- `ip_audit`：ip_id、action（allocate/release/reserve/disable/mark_conflict/edit）、actor、before/after JSON、时间。
- 台账行「历史」按钮 → 侧滑/弹窗展示该 IP 全部变更，倒序。

### 3.5 IPv6 专项
| 能力 | 方案 |
|---|---|
| 录入校验 | 前后端均用 `ipaddress` 语义校验，接受缩写/全写，存储统一规范化 |
| 展示 | 缩写形式；悬停 title 显示完整展开形式；`code` 样式等宽 |
| 容量 | `/64` 以上前缀不展开地址列表，只做「前缀登记 + 已用计数」模式 |
| 网段树 | v6 支持父子前缀（`/48 → /64` 层级展示，缩进树），v1.0 平铺 + 前缀长度排序，树形 v1.1 |
| 双栈设备 | 同一资产可关联 v4 + v6 两条地址记录（通过 asset_ref 关联） |

### 3.6 自动发现（v1.1，候选）
- 每网段 ping sweep（fping 并发）+ ARP 表抓取（联动交换机模块 SSH：`display arp`）+ RADIUS 在线用户 MAC→IP 对照，把「在线但台账无主」的地址自动标 conflict/建议录入。
- 定时任务复用 sw_scheduler（APScheduler 同进程模式）。

### 3.7 公网地址资产管理（v0.2 新增，v1.0 范围）

公网地址（IPv4/IPv6）与私网**同一张表建模**（scope 区分），但提供独立页面与专属字段，避免公网信息淹没在私网台账里。

#### 3.7.1 公网登记
- **两种粒度**：① 运营商分配的**公网网段**（如 `58.210.x.64/29`，scope=public 的 subnet，可展开子地址）；② 零散**单公网 IP**（云主机 EIP 等，挂到虚拟网段 `公网-散地址/128` 或按运营商归组）。
- 公网专属字段：**运营商**（电信/联通/移动/云厂商）、**线路**（如苏州电信专线-A）、**带宽 Mbps**、**合约到期日**、**ICP 备案号**、用途备注。
- 状态复用五态 + 公网语境展示：在用（allocated）/ 未启用（reserved）/ 已退回（disabled）。

#### 3.7.2 NAT 映射（公网 ↔ 私网）
- 每条映射：公网 IP:端口 → 私网 IP:端口，协议 tcp/udp/any（1:1 全端口 any、端口填 0）。
- 私网侧自动关联 ip_address 记录（按 addr 精确匹配，未录入时提示先录入私网台账）。
- 映射变更（新增/修改/删除）全部进 ip_audit（action=nat_add/nat_edit/nat_del）。
- **反向校验**：私网地址「释放」时，若存在活跃 NAT 映射 → 409 拒绝并提示先删除映射（防公网暴露残留）。

#### 3.7.3 域名关联
- 公网地址可关联域名（多值，逗号分隔或逐条添加）：域名、解析记录类型（A/AAAA/CNAME）、备案号继承。
- 台账与公网页展示域名徽标，悬停显示备案号。

#### 3.7.4 到期与合规提醒
- 统计卡：**合约 90 天内到期**、**备案信息缺失**（在用公网地址无备案号且用途含 Web/对外服务）两个风险计数，🔴 徽标。
- v1.0 仅列表内红色提示 + 排序置顶；自动通知（钉钉）→ v1.1 候选。

#### 3.7.5 暴露面（v1.1 候选，不在 v1.0）
- 公网 IP 存活探测 + 端口扫描（联动 SOC 工具链 / SafeLine WAF 日志）自动生成暴露端口清单，与 NAT 映射做 diff（有映射无流量 → 建议回收）。

### 3.8 批量导入（v0.3 新增，v1.0 范围）

存量 Excel/CSV 一键入库，**先校验预览、确认后才写库**，与 PRD §9 决策点 6（防火墙 NAT 规则基线导入）配套。

#### 3.8.1 三类模板
| 模板 | 关键列 | 入库目标 |
|---|---|---|
| **网段** | CIDR、名称、版本(自动识别)、区域、VLAN、网关、DNS、scope、运营商、线路、带宽、合约到期、备案号、备注 | `ip_subnet`（v4 网段自动生成空闲地址） |
| **地址台账** | IP、状态、主机名、MAC、资产类型、资产引用、使用人、部门、用途、分配时间、到期时间、域名(JSON/分号分隔)、备注 | `ip_address`（IP 所属网段按前缀自动匹配，未命中 → 错误行） |
| **NAT 映射** | 公网IP、公网端口、协议、私网IP、私网端口、备注 | `ip_nat_map`（公私网 IP 按文本精确匹配已入库记录，未命中 → 错误行） |

- 模板下载按钮随页面提供（xlsx 格式，含示例行 + 填写说明 sheet）。

#### 3.8.2 导入流程（四步）
1. **上传**：.xlsx / .csv，≤ 10MB、≤ 20000 行；自动识别表头（列名匹配模板，多余列忽略）。
2. **校验预览**：逐行解析 → 结果分三色：🟢 新增 / 🟡 更新（唯一键已存在）/ 🔴 错误（格式/网段未命中/枚举非法，含行号+原因）；页面展示前 200 行预览 + 三色计数。
3. **确认执行**（三选一）：
   - **跳过冲突**（默认）：🟡 行不处理，仅入 🟢 行；
   - **覆盖更新**：🟡 行按新值更新（差异进审计）；
   - **严格模式**：任一 🔴 行 → 整体拒绝，全部不入库。
4. **结果报告**：成功 N / 更新 M / 失败 K，🔴 错误明细可下载（原行 + 原因列），导入批次入 `ip_import_log`。

#### 3.8.3 一致性与审计
- 写库按 500 行/批事务，失败回滚当前批并续批（跳过冲突模式下）；严格模式单事务全量。
- 地址导入自动校验 IP 属于网段、IPv6 规范化、去重键 `(version, addr)`；NAT 映射校验端口 0 规则（=0 则 proto 必须 any）。
- 导入产生的地址变更审计 action=`import`，before/after 汇总指向批次号。
- 导入公网地址含合约/备案字段时，同步刷新公网资产页统计。

---

## 4. 数据模型（草案，004_ip_asset.sql）

```sql
-- 网段
CREATE TABLE ip_subnet (
  id INT AUTO_INCREMENT PRIMARY KEY,
  version TINYINT NOT NULL,                -- 4 / 6
  cidr VARCHAR(50) NOT NULL,               -- 规范化文本，如 192.168.30.0/24
  net_addr VARBINARY(16) NOT NULL,         -- 网络地址二进制
  prefix_len TINYINT NOT NULL,             -- v4:0-32  v6:0-128
  name VARCHAR(64) NOT NULL,
  zone VARCHAR(20) NOT NULL DEFAULT 'office',  -- office/idc/zt/storage/test/dmz
  vlan_id INT NULL,
  gateway VARCHAR(45) NULL,
  dns1 VARCHAR(45) NULL, dns2 VARCHAR(45) NULL,
  -- ↓ v0.2 公网专属字段（scope='public' 时使用）
  scope VARCHAR(10) NOT NULL DEFAULT 'private',  -- private / public
  isp VARCHAR(20) NULL,                    -- 运营商：telecom/unicom/mobile/cloud
  line_name VARCHAR(64) NULL,              -- 线路名称，如 苏州电信专线-A
  bandwidth_mbps INT NULL,
  contract_end DATE NULL,                  -- 合约到期
  icp_no VARCHAR(64) NULL,                 -- ICP 备案号
  note VARCHAR(255) NULL,
  enabled TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_cidr (version, cidr)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 地址
CREATE TABLE ip_address (
  id INT AUTO_INCREMENT PRIMARY KEY,
  subnet_id INT NOT NULL,
  version TINYINT NOT NULL,
  addr VARBINARY(16) NOT NULL,             -- 地址二进制
  ip_text VARCHAR(45) NOT NULL,            -- 规范化文本
  status VARCHAR(12) NOT NULL DEFAULT 'free',  -- allocated/reserved/free/conflict/disabled
  hostname VARCHAR(64) NULL,
  mac VARCHAR(17) NULL,
  asset_type VARCHAR(20) NULL,             -- physical/vm/network/printer/other
  asset_ref VARCHAR(64) NULL,              -- 关联 sw_device.name / VM 名等
  owner VARCHAR(32) NULL, dept VARCHAR(32) NULL,
  purpose VARCHAR(128) NULL,
  -- ↓ v0.2 公网专属字段（公网地址 / 对外服务地址使用）
  domains TEXT NULL,                       -- 关联域名，JSON 数组 [{name,rr,icp_no}]
  note VARCHAR(255) NULL,
  assigned_at DATETIME NULL, expires_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_addr (version, addr),
  KEY idx_subnet_status (subnet_id, status),
  KEY idx_hostname (hostname), KEY idx_owner (owner), KEY idx_mac (mac)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 审计
CREATE TABLE ip_audit (
  id INT AUTO_INCREMENT PRIMARY KEY,
  ip_id INT NOT NULL, subnet_id INT NOT NULL,
  action VARCHAR(16) NOT NULL,
  actor VARCHAR(32) NOT NULL,
  before_json TEXT NULL, after_json TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ip (ip_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 公网↔私网 NAT 映射（v0.2 新增）
CREATE TABLE ip_nat_map (
  id INT AUTO_INCREMENT PRIMARY KEY,
  public_ip_id INT NOT NULL,               -- ip_address.id（scope=public）
  public_port SMALLINT NOT NULL DEFAULT 0, -- 0 = 1:1 全端口
  private_ip_id INT NOT NULL,              -- ip_address.id（scope=private）
  private_port SMALLINT NOT NULL DEFAULT 0,
  proto VARCHAR(8) NOT NULL DEFAULT 'tcp', -- tcp/udp/any
  note VARCHAR(128) NULL,
  created_by VARCHAR(32) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_map (public_ip_id, public_port, proto, private_ip_id, private_port),
  KEY idx_priv (private_ip_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 导入批次（v0.3 新增）
CREATE TABLE ip_import_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(10) NOT NULL,               -- subnet/address/nat
  file_name VARCHAR(255) NOT NULL,
  total_rows INT NOT NULL, inserted INT NOT NULL, updated INT NOT NULL, failed INT NOT NULL,
  mode VARCHAR(12) NOT NULL,               -- skip/overwrite/strict
  error_json MEDIUMTEXT NULL,              -- 错误行明细 [{row, reason}]
  created_by VARCHAR(32) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 5. API 设计（routers/ip.py，前缀 /api/ip）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/ip/subnets` | 网段列表（筛选：version/zone/q），含统计 |
| POST | `/ip/subnets` | 新建（409 重复 CIDR；自动生成 v4 空闲记录） |
| PUT | `/ip/subnets/{id}` | 编辑 |
| DELETE | `/ip/subnets/{id}` | 删除（有非空闲地址 → 409） |
| GET | `/ip/addresses` | 台账（subnet_id/status[]/q/zone/page） |
| POST | `/ip/addresses/{id}/allocate` | 分配 |
| POST | `/ip/addresses/{id}/release` | 释放 |
| POST | `/ip/addresses/{id}/status` | 状态变更（reserved/conflict/disabled） |
| POST | `/ip/addresses/batch` | 批量分配/释放 |
| GET | `/ip/addresses/export` | CSV 导出 |
| GET | `/ip/audit?ip_id=` | 审计记录 |
| GET | `/ip/stats` | 统计卡数据 |
| GET | `/ip/public` | 公网资产列表（含 ISP/带宽/备案/合约/域名/映射数，scope=public） |
| POST | `/ip/nat` | 新增 NAT 映射（校验公私网 scope；私网地址不存在 → 422 提示先录入） |
| PUT | `/ip/nat/{id}` | 修改映射 |
| DELETE | `/ip/nat/{id}` | 删除映射（写审计） |
| GET | `/ip/nat?private_ip_id=` | 按私网地址反查映射 |
| GET | `/ip/import/template?kind=subnet\|address\|nat` | 下载导入模板（xlsx，含示例与说明 sheet） |
| POST | `/ip/import/preview` | 上传文件 → 逐行校验，返回三色预览（新增/更新/错误，不写库） |
| POST | `/ip/import/commit` | 确认执行（携带 preview 返回的批次 token + mode），返回结果报告 |
| GET | `/ip/import/logs` | 导入批次历史（含错误明细下载） |

复用现有基础件：`fetchApi`、Toast、ConfirmModal（危险操作输入确认）、FormModal（checks 多选状态筛选）、Pagination。

---

## 6. 页面设计

页面模板：`docs/mockup-IP资产管理.html`（静态示例，样式对齐 admin-spa）

### 6.1 侧边栏入口
「网络资产」新组（或挂入现有分组），含三个入口：
- 🌐 **网段管理** `#/ip-subnets`（色 `#2BBD7E`）
- 📋 **地址台账** `#/ip-addresses`（色 `#9B7FDB`）
- 🌍 **公网资产** `#/ip-public`（色 `#E8684A`，v0.2 新增）

### 6.2 网段管理页
```
页头：IP · 网段管理 ｜ 副标题：IPv4 / IPv6 双栈网段台账（CIDR 唯一，v4 网段自动生成空闲地址）
[统计卡 ×4：网段数(v4/v6) ｜ 总地址容量 ｜ 已分配(利用率) ｜ 本周新增]
[panel 网段列表]
  筛选条：版本(全部/v4/v6) · 区域 · 关键字 + [新建网段] 按钮
  表：CIDR ｜ 版本徽标 ｜ VLAN ｜ 名称 ｜ 区域 ｜ 网关 ｜ 利用率条(已用/预留/空闲) ｜ 操作(编辑·地址·停用)
```

### 6.3 地址台账页
```
页头：IP · 地址台账 ｜ 副标题：地址分配与回收（全部操作留审计记录）
[筛选条：网段下拉 · 状态多选徽标 · 资产类型 · 关键字(IP/主机名/MAC/使用人) · [导出 CSV]]
[panel 地址表]
  IP(等宽) ｜ 状态徽标 ｜ 主机名 ｜ MAC ｜ 资产(类型+引用) ｜ 使用人/部门 ｜ 用途 ｜ 分配时间 ｜ 操作(分配/释放·预留·冲突·历史)
  空闲行淡化展示；冲突行 🔴 徽标 + 备注 tooltip
[分页 50/页]
```

### 6.4 公网资产页（v0.2 新增）
```
页头：IP · 公网资产 ｜ 副标题：公网 IPv4/IPv6 地址、NAT 映射与域名备案统一台账
[统计卡 ×4：公网地址数(v4/v6) ｜ 活跃 NAT 映射数 ｜ 🔴 合约90天内到期 ｜ 🔴 备案缺失]
[panel 公网地址表]
  公网 IP(等宽) ｜ 运营商徽标 ｜ 线路/带宽 ｜ 状态 ｜ 关联域名(徽标+备案 tooltip) ｜ NAT 映射数(点击展开) ｜ 合约到期 ｜ 操作(映射·编辑·历史)
  合约 90 天内到期 → 日期红色；映射行展开显示 公网IP:端口 → 私网IP:端口 (协议) → 点击私网 IP 跳转地址台账
[panel NAT 映射明细]（或行内展开二选一，评审时定）
  公网:端口 ｜ 协议 ｜ → ｜ 私网:端口 ｜ 私网主机名 ｜ 用途 ｜ 创建时间 ｜ 操作(编辑·删除)
[+ 新增映射] 弹窗：公网地址(下拉 scope=public) · 公网端口(0=1:1) · 协议 · 私网地址(下拉/搜索) · 私网端口 · 备注
```

### 6.5 批量导入交互（v0.3 新增，三页共用组件）
```
入口：网段管理 / 地址台账 / 公网资产 三页页头均加 [⬆ 导入] 按钮（outline 次按钮，位于导出 CSV 左侧）
[ImportModal 三步]
  ① 上传：拖拽区(.xlsx/.csv ≤10MB·2万行) + [下载模板] 链接（kind 随当前页自动确定）
  ② 预览：三色计数条（🟢新增 128 · 🟡更新 12 · 🔴错误 3）+ 前 200 行表格（错误行红底+行号+原因列）
          + 模式单选：跳过冲突(默认) / 覆盖更新 / 严格模式(有错误则全部不入库)
  ③ 结果：成功 N / 更新 M / 失败 K + [下载错误明细] + [完成]（成功后列表自动刷新）
```

### 6.6 关键交互
1. **分配弹窗**（FormModal）：主机名、资产类型、资产引用、使用人、部门、用途、到期时间（可选）→ 成功 toast + 行内刷新。
2. **释放确认**（ConfirmModal）：输入 IP 全文确认（对齐删除备份的 `v{版本号}` 习惯）。
3. **冲突标记**：点 🔴 → 弹窗填冲突说明（对端 MAC/现象）。
4. **IPv6 行**：v6 地址前加紫色 `v6` 小徽标；title 悬停展开完整形式。
5. **利用率条**：三色分段（已用深蓝/预留黄/空闲灰），悬停显示精确数字。

---

## 7. 异常态与边界

| 场景 | 处理 |
|---|---|
| CIDR 非法/主机位非零 | 前后端双重校验，前端即时提示「请输入网络地址，如 192.168.30.0/24」 |
| 分配时地址已被他人占用（并发） | UPDATE where status='free' 原子扣减，失败返回 409「该地址刚被分配」 |
| v6 大网段地址列表 | prefix > 64 的网段禁用「地址」跳转，仅前缀登记模式 |
| 网段停用后 | 不允许新分配，已有地址不回收 |
| 导出数据量 | 流式分批写 CSV，>5 万条异步生成 |
| IPv6 MAC 归属（EUI-64） | v1.0 不做推断，仅记录手工 MAC |
| NAT 映射指向的私网地址被释放 | 释放前反向校验 ip_nat_map，有活跃映射 → 409「请先删除公网映射」 |
| 公网地址误录入为私网 scope | 编辑可改 scope；scope 变更时校验已有 NAT 映射一致性 |
| 公网端口范围 | 1-65535；0 仅表示 1:1 全端口且此时 proto 必须为 any |
| 备案号格式 | 简单正则（如 苏ICP备xxxxxxxx号）非强制校验，缺失仅提示不阻断 |
| 导入文件超限 | >10MB 或 >2 万行 → 拒绝并提示拆分；表头列名不匹配 → 拒绝并展示期望列名 |
| 导入 IP 不属于任何网段 | 🔴 错误行「IP 192.168.31.5 未命中任何已录入网段」，不入库 |
| 导入 NAT 映射引用的 IP 未入库 | 🔴 错误行提示先导入地址台账（模板顺序：网段→地址→NAT） |
| 导入中断（服务重启/超时） | 批次标记 failed，已完成批保持；重传文件重新预览（幂等，靠唯一键去重） |

---

## 8. 验收标准（v1.0）

1. 新建 `192.168.30.0/24`，自动生成 254 条 free；列表利用率条正确显示 0/0/254。
2. 分配 `192.168.30.107` 给主机 test-sw，状态、统计卡、审计同步更新；再次分配返回 409。
3. 输入释放时确认文本不匹配 → 无法提交。
4. 新建 `2408:8756::/48`（v6），列表正确显示紫色 v6 徽标与 `≈ 1.2×10²⁴` 容量；录入 `2408:8756::107/128` 地址成功且规范化展示。
5. 关键字 `30.107` / 状态 `conflict` / 区域 `idc` 组合筛选结果正确；CSV 导出字段完整。
6. 登记公网网段 `58.210.x.64/29`（电信）+ 单地址 EIP；建立映射 `58.210.x.66:443 → 192.168.110.106:4433 (tcp)`；公网资产页统计与映射展开正确。
7. 释放 `192.168.110.106` 时因存在活跃 NAT 映射被 409 拒绝；删除映射后方可释放。
8. 合约到期日 < 90 天的公网地址统计卡计数 +1 并红色显示。
9. 导入验收：下载「地址台账」模板 → 填 10 行（含 1 行非法 IP、1 行重复）→ 上传预览显示 🟢8/🟡1/🔴2 → 「跳过冲突」执行后台账 +8 行；错误明细下载含行号与原因；`ip_import_log` 生成批次记录。
10. 导入 NAT 映射模板（公网 1 条 + 私网未入库 1 条）→ 预览 1🟢1🔴；执行后公网资产页映射数联动 +1。
11. 回归：交换机三页、定时任务、既有准入页面全部 200 无报错。

---

## 9. 决策点（需确认后开发）

1. **v6 地址生成模式**：/64 以上不预生成（推荐 ✅），还是给 /64 也生成（2^64 条不可行，仅确认不采用）？
2. **区域枚举**：办公/IDC/零信任/存储/测试/DMZ 六类是否够？是否需要二级（IDC-苏州 / IDC-上海）？
3. **初始数据**：是否需要我按现有已知网段（192.168.30.0/24、192.168.110.0/24、10.99.0.0/24、172.18.0.0/24 等）预录入一批网段 + 已知设备 IP？
4. **权限**：IP 分配/回收是否仅 admin 组，还是 it-test 组也可只读+申请？
5. **v1.1 自动发现优先级**：是否随 v1.0 同期做（涉及交换机 ARP 联动，工作量约 +40%）？
6. **公网数据初始录入**（v0.2）：现有公网地址/段清单（运营商、线路、带宽、备案号、NAT 映射）由谁提供？建议先导入防火墙现有 NAT 规则作为基线。
7. **NAT 映射展示方式**（v0.2）：公网资产页内「行内展开」还是独立「NAT 映射明细 panel」（推荐行内展开 ✅，公网映射少时更直观）？
8. **域名备案核对**（v0.2）：备案号是否需要对接第三方核验接口（如 beian.miit.gov.cn 查询），还是 v1.0 仅手工登记？
9. **导入格式**（v0.3）：v1.0 同时支持 .xlsx + .csv（推荐 ✅，xlsx 模板带说明 sheet）；是否还需要支持粘贴文本框导入（小批量免下载模板）？
10. **导入权限**（v0.3）：批量导入/覆盖更新是否仅限 admin 组？覆盖更新会批量改写台账，建议收紧。

---

## 10. 分期计划

| 阶段 | 范围 | 状态 |
|---|---|---|
| **v1.0** | 网段管理 + 地址台账（分配/回收/预留/冲突） + 统计看板 + 审计 + CSV 导出 + IPv6 双栈 + 公网资产管理（登记/NAT 映射/域名备案/到期提醒）+ **批量导入（三模板/预览校验/三种模式/错误明细）** | 📝 设计稿待评审 |
| **v1.1** | 自动发现（ping sweep + 交换机 ARP + RADIUS 在线用户联动） + v6 前缀树 + 公网暴露面探测（端口扫描/SafeLine 联动）+ 合约到期钉钉通知 | 待排期 |
| **v1.2** | IP 申请审批流（对接宜搭工单） + 到期提醒 + Dashboard 趋势 | 待排期 |
