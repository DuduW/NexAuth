# PRD — NetAgent VPN 客户端重设计

| 项目 | 内容 |
|------|------|
| 版本 | v1.0（草案，待审查） |
| 日期 | 2026-09-16 |
| 范围 | `D:\radius\client`（Go + Wails v2 桌面客户端）重设计 |
| 关联 | 零信任网关方案1（FreeRADIUS + MariaDB + Headscale + Nginx + NetAgent） |
| 后端 | 192.168.110.106（nginx /netagent.exe、RADIUS UDP 1812、FastAPI :8000） |

---

## 1. 背景与问题

### 1.1 现状：三层架构、双轨并行

当前 client 代码存在**三套连接实现、互不相通**：

```
┌─────────────────────────────────────────────────────────┐
│ GUI（gui/src，React+TS+Tailwind，深色主题）                │
│   LoginPanel → ConnectionPanel / SettingsPanel + StatusBar│
└──────────────┬──────────────────────────┬───────────────┘
               │ window.go.main.App.*     │
┌──────────────▼──────────────┐  ┌────────▼────────────────┐
│ 轨道A：cmd/wails/main.go     │  │ 轨道B：internal/core     │
│ 裸 HTTP（自己拼 JSON）        │  │ VPNClient 完整引擎       │
│ /api/auth/login (totp)      │  │ /api/v1/auth/login       │
│ /api/vpn/peers/{u}/conf     │  │ 多节点/分流/重连/流量上报  │
│ exec wireguard.exe wg0      │  │ (GUI 完全未使用!)         │
└─────────────────────────────┘  └────────▲────────────────┘
                                          │ 也未被 GUI 使用
                                ┌─────────┴───────────────┐
                                │ 轨道C：internal/multivpn │
                                │ 多 profile YAML 管理      │
                                │ (仅 cmd/multivpn CLI用)   │
                                └─────────────────────────┘
```

### 1.2 问题清单（按严重度）

| # | 级别 | 问题 | 证据位置 | 影响 |
|---|------|------|----------|------|
| Q1 | 🔴 P0 | **双轨并行**：wails 绑定层绕过 core 引擎，自己裸 HTTP 调用，core.VPNClient 的多节点/重连/分流/流量上报全部闲置 | `cmd/wails/main.go` L56-158 | 功能割裂，重连/分流等已开发能力用户不可见 |
| Q2 | 🔴 P0 | **API 契约不一致**：wails 层调 `/api/auth/login`（字段 `totp`，期待顶层 `token`）；core 与后端真实契约是 `/api/v1/auth/login`（字段 `otp_code`，返回 `{code, data:{access_token, nodes}}`） | wails main.go L63/L171 vs core/auth.go L80 vs 后端 auth.py L66-102 | 登录路径随后端演进必然失效 |
| Q3 | 🔴 P0 | **GetStats 返回硬编码假数据**（12582912 字节 / 10.99.0.4 / 00:01:00） | wails main.go L148-159 | 用户看到的流量统计是假的 |
| Q4 | 🔴 P0 | **Login 签名不匹配**：Go 侧 `Login(serverURL, username, password, otpCode)` 4 参数，前端 useVPN.ts 声明 3 参数（无 otpCode）→ Wails 绑定调用失败或 OTP 永远传不进去 | wails main.go L162 vs useVPN.ts L13 | TOTP 双因子在 GUI 上实际不可用 |
| Q5 | 🟡 P1 | **无节点选择**：后端登录已返回 `nodes[]`（含 endpoint/status），core 已实现 `ConnectByNodeID`/`DisconnectNode`，GUI 无任何节点 UI | core/client.go L562；useVPN.ts 无节点 API | 多节点能力（如 suzhou-office / IDC 路由）用户无法操作 |
| Q6 | 🟡 P1 | **无重连感知**：core 有指数退避重连（1s→30s 无限重试），但 wails 层 `GetState` 只 exec `wg show wg0` 探测，断线即永久断开 | wails main.go L134-145 vs core/reconnect.go | 网络抖动后隧道不会自动恢复 |
| Q7 | 🟡 P1 | **密码明文落盘**：SaveSettings 将密码写入 `~/.netagent/config.json`（0600 但仍是明文）；profiles.yaml 密码 0644 | wails main.go L206-216；multivpn/profile.go L83 | 凭据泄露风险 |
| Q8 | 🟡 P1 | **UI 英文 + 深色主题**：与 admin-spa（浅灰 #f5f5f7 + 白卡片 + #0b3d62 深海军蓝）风格完全不符，且未中文化 | App.tsx / 全部组件 | 与管理平台视觉体系割裂 |
| Q9 | 🟡 P1 | **登录页默认服务器地址过期**：写死 `http://192.168.110.173:8080`，当前后端为 106 | LoginPanel.tsx L15 | 新用户开箱即连不上 |
| Q10 | 🟢 P2 | GetNACStatus 返回硬编码（"detected" / 192.168.30.15） | wails main.go L219-224 | NAC 状态展示为假数据 |
| Q11 | 🟢 P2 | 无流量上报可视化、无连接日志、无诊断信息（tunnel.go 错误只在 slog） | — | 排障依赖日志文件 |
| Q12 | 🟢 P2 | 窗口 400×600 固定，无系统托盘、无开机自启、无最小化到托盘 | wails main.go L238-240 | 桌面体验不完整 |
| Q13 | 🟢 P2 | multivpn（多 profile + Via 链式依赖）与单客户端模式完全独立，配置两套（config.json / profiles.yaml） | multivpn/profile.go L43 | 配置碎片化 |

---

## 2. 目标与非目标

### 2.1 目标

1. **G1 统一引擎**：GUI 唯一通道 = wails 绑定层 → `core.VPNClient`，删除绑定层全部裸 HTTP 代码（Q1/Q2/Q3）。
2. **G2 契约对齐**：登录统一走 `/api/v1/auth/login`（`otp_code` 字段、`{code,data}` 包装），登录即解析 `nodes[]`（Q2）。
3. **G3 TOTP 可用**：登录页含动态码输入，Go/TS 签名一致（Q4）。
4. **G4 多节点 UI**：节点列表 + 每节点独立连接/断开/状态/流量（Q5）。
5. **G5 断线重连可见**：reconnecting 状态、重连次数、手动重试（Q6）。
6. **G6 凭据安全**：密码不落盘；token 仅内存持有；配置文件只存 serverURL/username/autoConnect（Q7）。
7. **G7 UI 中文化 + admin-spa 风格**：浅灰背景 + 白卡片 + #0b3d62 主色 + 14~16px 圆角（Q8/Q9）。
8. **G8 可观测**：连接日志（时间+事件+错误）、实时速率（非累计值）（Q11）。

### 2.2 非目标（本期不做）

- ❌ macOS/Linux 原生适配（platform 层保留接口，本期只保证 Windows）
- ❌ multivpn 多 profile 并入 GUI（保留 CLI 形态，Phase 3 评估）
- ❌ 管理端功能（peers/permissions/resources/user-access 等管理 API 不进客户端）
- ❌ HTTPS 证书校验（依赖独立 PRD《PRD-HTTPS与Cookie认证改造.md》，客户端届时跟随）
- ❌ NAC Portal 自动认证自动化（GetNACStatus 仅展示真实探测值或移除，Q10 随 Phase 1 处理）

---

## 3. 重设计架构

### 3.1 目标架构

```
┌────────────────────────────────────────────────────┐
│ GUI（React+TS，重写为中文 + admin-spa 风格）          │
│  登录页 → 主窗口：节点 | 概览 | 日志 | 设置            │
└───────────────┬────────────────────────────────────┘
                │ window.go.main.App.*（唯一桥）
┌───────────────▼────────────────────────────────────┐
│ wails 绑定层（cmd/wails/main.go，重写为薄适配层）      │
│  App{ vpn *core.VPNClient }  ← 不再自己发 HTTP       │
│  方法 = core 公开能力的 1:1 映射 + 事件转发            │
└───────────────┬────────────────────────────────────┘
┌───────────────▼────────────────────────────────────┐
│ core 引擎（保留现有能力，补齐绑定）                    │
│  auth：/api/v1/auth/login(otp_code) + connect/{node} │
│  client：单/多节点、密钥生成、状态机、回调             │
│  tunnel：wireguard.exe install/uninstall            │
│  reconnect：1s→30s 指数退避                          │
│  split_tunnel / dns / traffic-report（60s 周期）     │
└────────────────────────────────────────────────────┘
```

### 3.2 Wails 绑定方法（重设计后）

| 方法 | 参数 | 返回 | 对应 core 能力 |
|------|------|------|----------------|
| Login | serverURL, username, password, otpCode | `{success, message, nodes[]}` | AuthLoginWithNodes |
| Logout | — | — | Disconnect + 清 token（密码丢弃） |
| GetNodes | — | `nodes[]`（id/name/status/endpoint） | GetNodes |
| ConnectNode | nodeID | error | ConnectByNodeID |
| DisconnectNode | nodeID | error | DisconnectNode |
| DisconnectAll | — | — | Disconnect |
| GetState | — | `disconnected/connecting/connected/reconnecting` | CurrentState |
| GetNodeInfos | — | `[{nodeId,nodeName,virtualIP,bytesIn,bytesOut}]` | GetNodeInfos |
| GetStats | — | 聚合 ConnectionStats（真实值） | GetStats |
| GetSplitTunnel | — | `{enabled, mode, rules}` | GetSplitTunnelConfig |
| SetSplitTunnel | enabled | — | FetchSplitRulesFromServer + Set |
| GetLogs | — | `[{time,level,event,detail}]`（环形缓冲最近200条） | 新增：core 事件总线 |
| SaveSettings | serverURL, username, autoConnect | — | SaveConfig（无密码字段） |

事件推送（替代 2s 轮询，Wails Events）：`vpn:state`（状态变更）、`vpn:stats`（1s 节流）、`vpn:log`。

### 3.3 需新增的 core 能力（小增量）

| 能力 | 说明 |
|------|------|
| 事件日志总线 | slog 之外维护内存环形缓冲（200 条），供 GUI 展示 |
| 实时速率 | GetStats 基础上由绑定层计算 Δbytes/Δt（1s 窗口） |
| 密码内存化 | Login 后 ClientConfig.Password 清空，token 足够（connect/{node} 不再要密码） |

---

## 4. 信息架构与页面设计

### 4.1 信息架构

```
登录页（未登录）
└─ 主窗口（登录后，左侧竖排导航 or 顶 Tab，窗口 460×680）
   ├─ 节点页（默认）
   │   ├─ 节点卡片×N：名称/状态灯/Virtual IP/↑↓流量/[连接|断开]按钮
   │   └─ 全部断开按钮
   ├─ 概览页
   │   ├─ 总状态卡（聚合状态/在线节点数/总时长/总↑↓）
   │   ├─ 实时速率卡（↓ x.xx MB/s / ↑ x.xx MB/s）
   │   └─ 分流卡（模式 开/关 + 规则数 + 开关）
   ├─ 日志页（时间/级别/事件表，自动滚动，导出按钮）
   └─ 设置页
       ├─ 服务器（只读 + 「切换服务器」→ 回登录页）
       ├─ 偏好（自动连接开关；开机自启开关[Phase 2]）
       ├─ 关于（版本/协议/后端地址）
       └─ 退出登录
```

### 4.2 视觉规范（对齐 admin-spa）

| 元素 | 规格 |
|------|------|
| 背景 | `#f5f5f7` |
| 卡片 | 白底 `#ffffff`，圆角 14px，内边距 16px，无重阴影 |
| 主色 | `#0b3d62`（按钮/激活态/链接） |
| 状态色 | 🟢 已连接 `#34c759` / 🟡 连接中 `#ff9f0a` / 🔴 断开 `#ff3b30` / 🟠 重连中 `#ff9500` |
| 文本 | 主 `#1d1d1f`，次 `#86868b` |
| 字体 | 系统默认中文栈（Microsoft YaHei UI），数字可用等宽 |
| 判定/状态文案 | 单行不换行（沿用压测报告规范） |

### 4.3 登录页字段

| 字段 | 说明 |
|------|------|
| 服务器地址 | 默认 `192.168.110.106`（可带/不带 http://），持久化 |
| 用户名 | radcheck 账号 |
| 密码 | password，不持久化 |
| 动态码 | TOTP 6 位（radtotp 启用时必填），输入框自动聚焦数字键盘 |

---

## 5. API 契约映射（客户端 ↔ 后端）

| 用途 | 后端端点 | 客户端调用方 | 现状 |
|------|----------|--------------|------|
| 登录（+TOTP） | POST `/api/v1/auth/login` `{username,password,otp_code}` → `{code,data:{access_token,nodes[]}}` | core/auth.go Login ✅ | wails 层用错端点（Q2），重设计后统一走 core |
| 连接（默认节点） | POST `/api/vpn/connect` `{username,otp_code}` + Bearer | core/auth.go Connect ✅ | 保留 |
| 连接指定节点 | POST `/api/vpn/connect/{nodeID}` `{public_key}` + Bearer | core/auth.go ConnectToNode ✅ | GUI 未暴露（Q5） |
| 断开通知 | POST `/api/vpn/disconnect` + Bearer | core/auth.go Disconnect ✅ | 保留 |
| 流量上报 | POST `/api/vpn/traffic-report`（60s Δ + final） | core/auth.go ReportTraffic ✅ | 保留 |
| 访问上报 | POST `/api/vpn/visit-report` | core/auth.go ReportVisits ✅ | 保留 |
| 分流规则 | GET `/api/vpn/split-rules` | core/auth.go GetSplitRules ✅ | GUI 未暴露 |
| ~~旧登录~~ | ~~POST `/api/auth/login` (totp)~~ | ~~wails main.go~~ | **删除** |
| ~~Peer conf 下载~~ | ~~GET `/api/vpn/peers/{u}/conf`~~ | ~~wails main.go~~ | **删除**（改走 connect 下发） |

> 管理端 29 端点中的 peers/permissions/resources/user-access/stats/access-log/traffic-log/visit-log 均不进客户端。

---

## 6. 安全设计

| 项 | 方案 |
|----|------|
| 密码 | 登录成功后即从内存清空；永不写盘；重连依赖 token + public_key，无需密码 |
| Token | 仅内存持有；登出/断开即弃 |
| config.json | 仅存 `server_url / username / auto_connect`，无敏感字段 |
| WireGuard 私钥 | 连接时临时生成（ConnectByNodeID 已如此），会话结束销毁；不落盘 |
| wg0.conf | 由隧道服务托管，客户端目录不残留含私钥的 conf |
| 权限 | 维持 asInvoker manifest（无 UAC 盾牌） |

---

## 7. 分期计划

### Phase 0 — 绑定层重构（先行，纯 Go，无 UI 变更）

| 任务 | 验收 |
|------|------|
| T0.1 删除 wails main.go 全部裸 HTTP（Connect/Disconnect/GetState/GetStats/Login 旧实现） | 编译通过，无 http.Post 残留 |
| T0.2 App 持有 `*core.VPNClient`，实现 3.2 节全部绑定方法 | 每方法有对应 core 调用 |
| T0.3 Login 4 参数对齐 + 登录成功解析 nodes[] | useVPN.ts 与 Go 签名一致 |
| T0.4 密码内存化（SaveSettings 去掉 password 参数） | config.json 无密码 |
| T0.5 core 新增事件日志总线 + 实时速率计算 | GetLogs 可返回记录 |

### Phase 1 — GUI 重写（中文化 + admin-spa 风格 + 四页信息架构）

| 任务 | 验收 |
|------|------|
| T1.1 登录页重写（含动态码字段，默认 106） | TOTP 可登录 |
| T1.2 节点页（卡片 + 独立连接/断开） | 多节点并发连接实测通过 |
| T1.3 概览页（总状态/速率/分流开关） | 速率为真实 Δ 计算值 |
| T1.4 日志页（环形缓冲展示 + 导出） | 可见连接/重连/错误事件 |
| T1.5 设置页重写 + 状态栏中文化 | 风格走查过（#f5f5f7/#0b3d62/白卡片） |
| T1.6 Wails Events 替代 2s 轮询 | 状态变更 <500ms 反映到 UI |

### Phase 2 — 桌面体验增强（可选，验收 Phase 1 后排期）

系统托盘（最小化到托盘/托盘菜单快速断开）、开机自启、断网诊断（wg.exe 探测 + 日志一键导出）、GetNACStatus 真实化或移除。

### Phase 3 — 评估项（不在承诺内）

multivpn 多 profile 并入 GUI、Windows 服务模式（无用户会话预连接）。

---

## 8. 验收标准（总）

| # | 标准 |
|---|------|
| A1 | 全代码无第二套 HTTP 调用路径；grep `api/auth/login`、`peers/.*conf` 在 client 目录 0 命中 |
| A2 | TOTP 登录 → 节点列表出现 → 连接任一节点 → Virtual IP 下发 → 隧道建立（`wg show` 可见） |
| A3 | 同时连接 ≥2 节点，各自独立断开不影响其余 |
| A4 | 拔网线 30s 再恢复，客户端自动重连并状态可见（reconnecting → connected） |
| A5 | 流量统计为真实值（与 `wg show <if> transfer` 对账误差 <5%） |
| A6 | config.json、profiles.yaml、内存快照中均无明文密码 |
| A7 | UI 全中文；主色 #0b3d62；背景 #f5f5f7；与 admin-spa 截图并排走查通过 |
| A8 | 编译命令不变：`go build -tags "desktop,production" -ldflags="-s -w -H windowsgui" -o build/bin/netagent.exe .` |

---

## 9. 风险与决策点

| # | 风险/决策 | 建议 |
|---|-----------|------|
| D1 | `/api/vpn/connect` 请求体字段在本次侦察中被内容审批拦截未逐字核对（core 发送 `{username, otp_code}`，public_key 是否也要随体发送待确认） | Phase 0 动手前先在 106 用 curl 实测一次 connect 端点确认契约 |
| D2 | wireguard.exe 未安装时的降级体验（当前静默保存 conf） | Phase 1 日志页明示「未检测到 WireGuard，请安装」，并提供下载链接（106 /netagent 同源） |
| D3 | Wails Events 在 Windows WebView2 的稳定性 | 保留轮询兜底开关（设置页隐藏项） |
| D4 | 移除密码落盘后，auto_connect 场景无密码可用 | auto_connect 仅在 token 有效期内可用；失效则弹登录页（token 续期策略后端定） |
| D5 | 杀软误报历史（Trojan/Adduser.e） | 维持现有命名规范 NetAgent-v1.0.{ts}.exe + asInvoker，重设计不改变构建链 |

---

## 10. 交付物清单

| 交付物 | 路径 |
|--------|------|
| 本 PRD | `D:\radius\docs\PRD-VPN客户端重设计.md` |
| 重设计代码 | `D:\radius\client`（Phase 0 起） |
| 构建产物 | `build/bin/netagent.exe`（命名 NetAgent-v1.0.{YYYYMMDD-HHmmss}.exe 发布） |
| 更新文档 | `client/README.md`、`CLIENT_BUILD_README.md`（随 Phase 1 同步） |
