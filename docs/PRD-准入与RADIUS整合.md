# PRD：准入与认证中心 — RADIUS 单页整合（v3 修订）

> **v3（2026-09-23）**：应用户澄清，形态从「单页四页签」改为「**侧边栏分组下四个独立路由页面**」——运行监控 `/nac/monitor`、准入策略 `/nac/policy`、服务配置 `/nac/config`、链路拓扑 `/nac/topo`。Panel 组件层不变（S2~S5 产物全部复用），仅重构骨架层。原 v2 单页版历史见文末。

| 项目 | 内容 |
|---|---|
| 文档版本 | **v2.0（修订版，替代 v1.0）** — 按用户澄清：不做分组重组，**9 页真正合并为 1 个页面** |
| 编写日期 | 2026-09-23 |
| 落地位置 | 192.168.110.106 `/admin-spa`（前端）+ `/opt/radius-admin`（后端） |
| 涉及现状 | 「网络准入」4 页 +「RADIUS 中心」5 页，共 9 个独立路由 |
| 交付模式 | 先设计后实施：本 PRD + HTML 原型确认后分阶段交付 |

---

## 1. 需求澄清（v2 修订依据）

用户明确：**「刚刚的 nac-console，新的 radius 相关整理成一个页面」**——不是侧边栏分组微调，而是像现有 `/radius-config`（4 tabs）那样，把 9 个页面的功能**全部收进一个集中控制台页面**，一个页面管所有 RADIUS 与准入。

### 现状 9 页 → 单页整合

| 现页面 | 现路由 | 整合后归属（Tab） |
|---|---|---|
| 在线设备 | `/online` | Tab ① 运行监控 |
| 认证日志 | `/authlog` | Tab ① 运行监控 |
| 记账查询 | `/accounting | Tab ① 运行监控 |
| MAC 免认证 | `/macpass` | Tab ② 准入策略 |
| Profile 管理 | `/user-profiles` | Tab ② 准入策略 |
| RADIUS 参数 | `/qos` | Tab ② 准入策略 |
| RADIUS 配置（4 子 tabs） | `/radius-config` | Tab ③ 服务配置（NAS/字典/私有属性/组控制） |
| Portal 服务 | `/portal` | Tab ③ 服务配置 |
| 证书管理 | `/certs` | Tab ③ 服务配置 |

---

## 2. 单页信息架构（三层导航）

```
页面：准入与认证中心 /nac（单页，内部三层导航）
│
├─ 顶部：6 指标卡（在线终端/24h认证/成功率/旁路生效/NAS健康/活动Profile）
├─ 快捷排障搜索条（用户/MAC → 一键带参过滤当前 Tab 或跳对应 Tab）
│
├─ L1 页签（4 个）：
│   ① 运行监控 │ ② 准入策略 │ ③ 服务配置 │ ④ 链路拓扑
│
├─ L2 子页签（按 L1 展开）：
│   ① 在线会话 · 认证日志 · 记账查询
│   ② MAC 免认证 · Profile · RADIUS 参数
│   ③ NAS 设备 · 属性字典 · 私有属性 · 组控制 · Portal · 证书
│   ④ 认证链路图（节点实时数字 + 点击跳 Tab）
│
└─ L3 内容区：各子模块完整功能（表格/CRUD/抽屉，复用现有页面组件）
```

**交互细节（与现有 /radius-config 4-tab 一致的体验）：**

- L1 页签常驻；L2 子页签仅显示当前 L1 下的子项（水平排布，超出可横向滚动）；
- 每个 L2 子模块 = 现有页面主体内容**原样搬入**（表格/搜索/CRUD 表单/抽屉），不做功能删减；
- URL hash 同步：`/nac#/monitor/online`、`/nac#/policy/profiles` —— 可收藏、可回退；
- 全局搜索命中后，自动切换到对应 L1/L2 并带入过滤条件。

---

## 3. 关键设计决策

### 3.1 组件级复用（不重写）

9 个页面主体已稳定，整合采用**提取-搬入**策略：

| 现有资产 | 复用方式 |
|---|---|
| `Online.jsx` / `AuthLog.jsx` / `Accounting.jsx` 主体 | 提取为 `<OnlinePanel/>` 等子组件，搬入 /nac 对应 L2 |
| `MacBypass.jsx` / `UserProfiles.jsx` / `QosPolicy.jsx` 主体 | 同上 `<MacBypassPanel/>` … |
| `RadiusConfig.jsx` 的 4 个表格组件 | 原样搬入 L3（NAS/Dict/UserReply/GroupCheck 四个子 Tab） |
| `PortalManager.jsx` / `CertManager.jsx` 主体 | 搬入 |
| CollapsePanel / badge / stat-card / FormModal / Toast | 全部复用 |

提取时每个页面拆成 `XxxPanel`（去 page-header 与外层 padding，保留全部业务逻辑），原路由文件变成薄壳 re-export，保证旧路由不回归。

### 3.2 路由与兼容（铁律）

- 新路由 `/nac` 为唯一新页面；**旧 9 路由全部保留**（薄壳渲染同一 Panel 组件），书签/外链零影响；
- 侧边栏改为「准入与认证」一组，入口仅**一个**：准入与认证中心（/nac）——原 9 个子项从侧边栏移除，功能全部在 /nac 内部导航；
- 顶栏面包屑同步：准入与认证 / 准入与认证中心。

### 3.3 状态与数据加载

- 每个 Panel 组件自带数据加载（现页面逻辑不变）；
- **按需加载**：仅当前 L2 子 Tab 激活时才 fetch（避免 9 模块同时请求打爆后端）；切走后保留状态（keep-alive 式缓存），不重复拉取；
- 顶部指标卡由 `/api/nac/overview` 聚合接口一次性返回（只读 COUNT，见 3.4）。

### 3.4 后端增量（极简）

仅 1 个只读聚合接口：

```
GET /api/nac/overview → {
  online_count, auth_24h:{total,ok,fail,rate}, mac_bypass_active,
  nas:{total,stale}, profiles_active,
}
```

所有 L2 子 Tab 的 CRUD 仍走现有接口（/nas、/macpass、/user-profiles、/qos …），后端零改造。

### 3.5 性能预算

| 指标 | 预算 |
|---|---|
| /nac 首次可交互 | ≤ 3s（与现页面一致） |
| Tab 切换 | 纯前端 < 100ms（已加载缓存） |
| 指标卡接口 | ≤ 500ms（COUNT + LIMIT 8，radpostauth 走 created_at 索引） |
| lazy chunk | /nac 单独 chunk，不影响其他页面首屏 |

---

## 4. 前端实现路径（增量、可回退）

| 步骤 | 内容 | 验证点 |
|---|---|---路由
|---|---|---|
| S1 | 建 `pages/NacCenter.jsx` 骨架（指标卡 + L1/L2 导航 + hash 路由）+ `/api/nac/overview` | 骨架渲染、hash 切换、指标数字与独立页抽查一致 |
| S2 | 提取 ① 运行监控 3 Panel（Online/AuthLog/Accounting）搬入 | 3 模块功能等价（搜索/分页/操作全保留），旧路由同源渲染 |
| S3 | 提取 ② 准入策略 3 Panel（MacBypass/UserProfiles/QosPolicy） | 同上 + CRUD 冒烟（增删改各 1 次） |
| S4 | 提取 ③ 服务配置 6 Panel（NAS/字典/私有属性/组控制/Portal/证书） | 同上 + NAS Secret 打码/审计联动正常 |
| S5 | ④ 链路拓扑（SVG 链路图 + 节点数字 + 点击切 Tab）+ 快捷排障搜索 | 节点数字与指标卡一致；搜索带参跳转正确 |
| S6 | 侧边栏收敛为单入口 + 面包屑/标题/i18n 同步 + 全量构建部署 106 | 旧 9 路由全部可达；/nac 全功能可用；端到端 8 项验证 |

每步走「实现 → 本地 build → 部署 106 → 验证」再进下一步，任意步可独立回退（Panel 提取是纯新增文件，旧页面不受影响）。

### 实施状态（2026-09-23 全部完工，v3 四页面形态）

| 步骤 | 状态 | 完成摘要 |
|---|---|---|
| S1 | ✅ 完成 | `/api/nac/overview` 聚合接口（radpostauth 用 `class` 列判活跃 NAS、`reply LIKE 'Access-Accept%'` 判成功） |
| S2 | ✅ 完成 | MonitorPanels.jsx 三 Panel（Online/AuthLog/Acct）；三旧页薄壳 |
| S3 | ✅ 完成 | PolicyPanels.jsx 三 Panel（MacBypass/UserProfiles/QosPolicy）；Profile CRUD 闭环冒烟通过 |
| S4 | ✅ 完成 | ConfigPanels.jsx 四 Panel + ServicePanels.jsx 两 Panel；NAS 冒烟揪出并修复后端存量 bug：`PUT /api/nas/{id}` 改 Pydantic body model + 404/400 校验 + commit |
| S5 | ✅ 完成 | TopoPanel.jsx SVG 链路图 + 快捷排障 sessionStorage 带参跳转 |
| S6 | ✅ 完成 | v2 单页版侧边栏收敛 + 全量验证（后被 v3 取代骨架层） |
| **v3** | ✅ 完成 | **四页面形态**：`/nac/monitor|policy|config|topo` 四独立路由（?tab= 深链），侧边栏分组四入口；`/nac` 与旧 hash（`#/policy/profiles`）自动重定向；NacCenter.jsx 缩为重定向壳 |

### v3 产物结构
```
src/frontend/src/
├── pages/
│   ├── NacCenter.jsx          # /nac 重定向壳（兼容旧 hash 收藏）
│   ├── NacMonitor.jsx         # /nac/monitor 运行监控（含快捷排障条）
│   ├── NacPolicy.jsx          # /nac/policy 准入策略
│   ├── NacConfig.jsx          # /nac/config 服务配置
│   └── NacTopo.jsx            # /nac/topo 链路拓扑
├── components/nac/
│   ├── NacSubTabs.jsx         # 共享 L2 子页签条（?tab= 同步）
│   ├── MonitorPanels.jsx      # OnlinePanel / AuthLogPanel / AcctPanel
│   ├── PolicyPanels.jsx       # MacPassPanel / ProfilesPanel / QosPanel
│   ├── ConfigPanels.jsx       # NasPanel / DictPanel / UserReplyPanel / GroupCheckPanel
│   ├── ServicePanels.jsx      # PortalPanel / CertsPanel
│   └── TopoPanel.jsx          # SVG 链路拓扑
└── 9 个旧 pages/*.jsx         # 薄壳渲染同一 Panel，路由直达零回归
```
回滚点：`/var/backups/admin-spa-s6-*`（v3 部署前）、`/var/backups/admin-spa-s5-*`（S6 部署前）。

---

## 5. 风险与对策

| 飉险 | 对策 |
|---|---|
| 单页体积过大（9 模块） | Panel 组件 lazy 分包；L2 按需 fetch + keep-alive；/nac 独立 chunk |
| 提取搬入引入回归 | Panel = 原页面主体原样搬（只去 header），旧路由薄壳同源渲染，一次提取两处受益 |
| 用户习惯改变（侧边栏 9 项 → 1 入口） | 旧路由永久保留可直达；/nac 内 hash 定位可收藏 |
| 指标卡慢查询 | 只 COUNT + LIMIT 8；radpostauth.created_at 索引复查 |
| 与 Carbon 风格不一致 | 全部复用现有 CSS 类（panel/badge/btn/stat-card），零新样式体系 |

---

## 6. 待确认决策点

1. **TOTP 动态码**是否也并入（作为 服务配置的第 7 个子 Tab）？或保持「用户与组」不动？（当前：保持不动）
2. **侧边栏形态**：~~单入口 vs 9 子项~~ → v3 已定为分组下四页面入口（运行监控/准入策略/服务配置/链路拓扑）。
3. **记账查询**数据量较大（radacct 全表），并入后是否加默认时间范围（如默认近 24h）？（当前：未加默认范围，保持原交互）
4. **链路拓扑**形态：SVG 横向示意（推荐轻量）vs 可交互拓扑画布（重）？（已按推荐落地：SVG 轻量版）
5. **v2 单页版的指标卡行**（6 指标 + 总览数字）在 v3 四页面形态下未保留——是否需要在「运行监控」页顶部恢复指标卡行？（待确认）

---

*配套原型：`docs/design/nac-console.html` 已更新为 v2 — 单页四页签版（顶部指标卡 + 快捷排障 + 4 个 L1 页签 + 12 个 L2 子模块演示 + 旧页归置说明）。确认后回复「方案A 执行」启动 S1。*
