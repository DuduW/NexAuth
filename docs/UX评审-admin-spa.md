# admin-spa 管理后台 UX 评审报告

> 评审对象：`D:\radius\src\frontend\src\`（React SPA，27 个页面 + Sidebar + 全局样式）
> 评审日期：2026-09-04 ｜ 评审视角：资深 UX（管理员效率、操作安全、一致性、可维护性）
> 严重程度定义：**P0** = 阻断/数据风险/功能失效；**P1** = 体验显著受损；**P2** = 打磨项

---

## 0. 落地状态（2026-09-04 第一轮实施）

**一期止血已全部完成并构建验证通过**（`vite build` 0 error、`oxlint` 0 error），覆盖全部 14 项 P0 + 原生弹窗全量治理：

| 变更 | 说明 |
|------|------|
| ✅ 新增基础件 | `components/Toast.jsx`（成功 2.6s 自动消失 / 失败常驻）、`ConfirmModal.jsx`（危险确认 + 后果说明 + 输入关键字确认模式）、`FormModal.jsx`（替代 prompt 的表单对话框）、`QrCanvas.jsx`（qrious 本地二维码）、`Pagination.jsx`（共享分页，页码省略） |
| ✅ P0-1/2 服务高危操作 | VpnNode 停止 VPN、PortalManager 停止/重启 Portal 均加二次确认（说明断开影响面）+ 操作中禁用 |
| ✅ P0-3 改密 | Users 页 prompt → FormModal 双输入 + 一致性校验 + ≥6 位强度 |
| ✅ P0-4 QR 本地化 | TotpManager/Users 的 TOTP 二维码改 qrious 本地生成（密钥不再出网），并增加"密钥仅本次显示"强提示 |
| ✅ P0-5 默认凭据 | Login 页"默认账号 admin/admins"提示已删除 |
| ✅ P0-6 日志分页 | VpnConnLog/VpnVisitLog 由 slice(0,20) 改为 limit=500 + 完整分页，数据可达 |
| ✅ P0-7 页大小 | Accounting 页大小选择器修复（state 化） |
| ✅ P0-8 table_size | QosPolicy 表头改 `tr('value_label')`（新增 i18n key） |
| ✅ P0-9 i18n 响应式 | `tr()` + `setLang()` + `subscribeLang()`，App 顶层订阅强制重渲染，语言切换即时生效 |
| ✅ P0-10 属性删除确认 | RadiusConfig 用户私有属性/组认证控制/NAS 删除均加后果确认 |
| ✅ P0-11 吊销 | CertManager prompt → FormModal（预设原因下拉 + 备注 + 后果警示） |
| ✅ P0-12 ZtGroups | 后端核实：零信任分组与 RADIUS 分组共用 radusergroup，`/groups/{name}` 为设计共用而非错调接口；确认文案已补充"共用数据"后果说明 |
| ✅ P0-13 撤销文案 | VpnPerm 撤销对端/badge 移除授权均改为后果确认（原"撤销?"已废弃） |
| ✅ P0-14 清空日志 | AuthLog 清空改强确认（需输入"清空"二字） |
| ✅ 弹窗治理 | 原生 alert/confirm/prompt 由 40 处 → **0 处**（含二期范围 Groups/MacBypass/NasManagement/UserProfiles/ZtAcl 一并收敛）；写操作补 try/catch + Toast |
| ✅ 附带 | VpnAccessLog 标题改"VPN 接入日志"消除与 VpnVisitLog 同名混淆；App.jsx 死代码 EmptyMsg 修复；QosPolicy 死 onClick 清理 |

**部署**：`scp -r src/frontend/dist/. root@192.168.110.106:/var/www/html/admin-spa/`

**遗留（二期建议）**：api.js 请求层统一兜底、useTableData Hook（loading/error/empty 三态）、时间格式化工具（substring(0,19) 仍存）、响应式适配、Dashboard/ServerStats 静默失败与假占位、i18n 硬编码中文 15 页补 key、敏感字段 URL query 传输改 POST body。

---

## 1. 总体结论

**结论先行：当前后台"功能可用、体验毛坯"。** 视觉层（浅灰底 + 白卡片 + 大圆角）已有统一语言，但交互层存在三类系统性债务：

1. **操作安全网缺失** —— 高危操作（重启 Portal、停止 VPN、吊销证书、删除规则）要么无确认，要么一句"撤销?"不说明后果，管理员一次误点即可造成全网用户断连。
2. **反馈系统失效** —— 40 处原生 `alert/confirm/prompt` 与 45 处静默 `catch(console.error)` 并存：要么粗暴打断，要么彻底无反馈；3 个页面把接口失败**伪装成空数据**。
3. **i18n 形同虚设** —— 15/27 页 100% 硬编码中文，Settings 切换语言后界面不刷新（`tr()` 非响应式），另有页面引用了不存在的 i18n key 直接渲染原始字符串。

关键量化证据：

| 指标 | 现状 |
|------|------|
| 原生弹窗调用（alert/confirm/prompt） | **40 处 / 17 页** |
| 静默 catch（用户零感知） | **45 处** |
| 有加载态的页面 | **4 / 27**（`.spinner` 类已定义但零使用） |
| 硬编码中文未走 i18n | **15 / 27 页** |
| 危险确认文案说明后果的 | 仅 2 处（UserProfiles、VpnNode） |
| 数据截断不可达 | 2 页（VpnConnLog / VpnVisitLog 只显示前 20 条） |
| 响应式 @media 查询 | **0 处**（表格无横向滚动容器） |

---

## 2. P0 问题清单（必须优先修复）

| # | 位置 | 问题 | UX 影响 | 建议 |
|---|------|------|---------|------|
| P0-1 | `VpnNode.jsx:69-70` | 启动/停止 VPN 服务**无确认、无防连点** | 误点即断开全部在线 VPN 用户 | 加二次确认（说明影响面）+ 操作中禁用 |
| P0-2 | `PortalManager.jsx:12-17` | 启动/停止/重启 Portal 服务无确认、无 try/catch | 重启踢掉所有 Portal 在线用户 | 同上；按钮区用危险色区分 |
| P0-3 | `Users.jsx:46` | 改密用 `prompt()` 明文输入，无强度校验、无二次确认 | 密码可见、易设弱密码 | 改为 Modal：双输入框 + 强度条 + 可见性切换 |
| P0-4 | `TotpManager.jsx:103`、`Users.jsx:201` | TOTP 密钥经 `api.qrserver.com` 第三方服务生成二维码 | **密钥明文出网**，安全+信任双重风险 | 本地生成（qrious.min.js，Portal 页已有先例） |
| P0-5 | `Login.jsx:82` | 登录页明文展示 `默认账号: admin / admins` | 严重安全隐患 | 删除该行；部署文档中说明 |
| P0-6 | `VpnConnLog.jsx:19`、`VpnVisitLog.jsx:19` | `slice(0,20)` 截断且无翻页，badge 显示"20/N"但**其余数据不可达** | 审计数据丢失，合规风险 | 复用 ZtLog 的服务端分页 |
| P0-7 | `Accounting.jsx:60` | "每页条数"选择器坏死（`sz` 为常量 20，onChange 无效） | 功能假象，用户困惑 | 修为 state 或移除该控件 |
| P0-8 | `QosPolicy.jsx:65` | 引用不存在的 i18n key `table_size`，表头渲染原始字符串 "table_size" | 界面直接显示代码字符串 | 补 key 或改硬编码 |
| P0-9 | `Settings.jsx:9` | 切换语言只写 localStorage，`tr()` 非响应式，界面不更新且无提示 | i18n 功能**实际失效** | i18n 改为 Context + state，切换即重渲染 |
| P0-10 | `RadiusConfig.jsx:92,108` | 用户/组属性删除**点击即删无任何确认** | 误删认证属性，用户直接无法入网 | 加确认 + 说明后果 |
| P0-11 | `CertManager.jsx:123` | 吊销证书用原生 `prompt()` 输入原因 | 高危不可逆操作用最脆弱的交互 | 改 Modal：预设原因选项 + 后果警示 |
| P0-12 | `ZtGroups.jsx:43` | 删除零信任分组调用的是 `/groups/{name}`（RADIUS 准入分组接口），疑似**调错接口** | 可能删错业务数据 | 与后端核对，应为 `/zt/groups/...` |
| P0-13 | `VpnPerm.jsx:125` | 撤销授权确认文案仅"撤销?"（半角问号），未说明撤销范围 | 管理员不知撤的是什么 | 文案改为"撤销 {用户} 对 {资源} 的授权？其 VPN 对端将失效" |
| P0-14 | `AuthLog.jsx:30` | "清空日志"原生 confirm 未说明不可恢复 | 审计日志一键蒸发 | 强确认（输入"清空"二字）+ 后果说明 |

---

## 3. P1 问题清单（体验显著受损）

### 3.1 反馈与错误处理（全局最大短板）

| # | 问题 | 证据 | 建议 |
|---|------|------|------|
| P1-1 | 成功/失败反馈全靠 `alert`（约 15 处 `alert(err.message)` 英文直出） | CertManager ×4、Users ×2、VpnNode ×3、Groups ×2 等 | 统一 **Toast 组件**（成功 2s 自动消失 / 失败常驻可关闭），错误文案映射为中文 |
| P1-2 | 45 处 `.catch(console.error)` 静默失败 | Dashboard 7 个请求全部静默、Online、MacBypass、VpnAccessLog 等 | 请求层（`api.js`）统一兜底：失败弹 Toast + 页面级错误条 |
| P1-3 | **失败伪装成空态** | ZtDevices.jsx:9、ZtGroups.jsx:13、ZtLog.jsx:16 `catch(()=>setLoading(false))` → 显示"暂无数据" | 空态与错误态必须分离："加载失败，点击重试" |
| P1-4 | 约 15 个写操作无 try/catch（未处理 Promise 拒绝） | NasManagement.save、QosPolicy.save、RadiusConfig 全部、VpnPerm 多处 | 统一包进请求层 |

### 3.2 加载与数据呈现

| # | 问题 | 证据 | 建议 |
|---|------|------|------|
| P1-5 | 23/27 页无加载态，白屏或闪旧数据 | 已定义 `.spinner` 但零使用 | 表格区统一 skeleton/spinner + "加载中" |
| P1-6 | 分页覆盖不一致 | VpnAccessLog/VpnTrafficLog 一次拉 500 条全量渲染；ZtLog 页码无省略全量铺开 | 统一分页组件（复用 Users 页实现），日志类全部服务端分页 |
| P1-7 | `ServerStats.jsx:110-113` VPN 区块四卡片**写死显示 `-`** | 用户误以为功能未完成 | 未接入数据的模块先下线或标注"即将上线" |
| P1-8 | 表单防重复提交缺失（约 15 个表单） | 仅 4 页有提交中禁用 | 提交按钮统一 loading + disabled 规范 |
| P1-9 | `Users.jsx:134` 操作列 6-7 个按钮并排 | 信息过载、误点率高 | 主操作外露（编辑/改密），其余收进"更多"下拉 |
| P1-10 | `VpnPerm.jsx:50-53` 点击 badge 即移除授权，无确认，仅 title 提示 | 极易误点 | 加确认 Popover 或改为显式删除按钮 |

### 3.3 导航与信息架构

| # | 问题 | 建议 |
|---|------|------|
| P1-11 | `VpnAccessLog` 与 `VpnVisitLog` 页面标题完全相同（"VPN 访问日志"），两个路由导航困惑 | 改名区分或合并为一个页加 Tab |
| P1-12 | `NasManagement.jsx` 与 `RadiusConfig.jsx` NAS tab 两套并行 NAS 管理 UI，行为不一致 | 合并为单一入口，RadiusConfig 只保留属性配置 |
| P1-13 | Sidebar 26 个入口分 7 组，无搜索、不可折叠；色点语义不明（装饰性 > 功能性） | 保留分组但弱化色点；入口可加徽标数（如在线设备数） |
| P1-14 | `QosPolicy.jsx:59` 速率要求用户填 bps（"如 8192000 = 8M"） | 改 Mbps 输入 + 单位下拉，前端换算 |
| P1-15 | `Dashboard.jsx:53` 表头"操作"列渲染的却是状态 badge，列语义错位 | 列名改"状态" |

---

## 4. P2 打磨项

| # | 问题 | 建议 |
|---|------|------|
| P2-1 | 时间格式约 15 处 `substring(0,19)` ISO 原文截断；`Accounting.jsx:26-28` 用 UTC 取日期，东八区 0-8 点取到前一天 | 统一 `fmtTime()` 工具：`toLocaleString('zh-CN', {hour12:false})` + 相对时间（x 分钟前） |
| P2-2 | 零响应式：无 @media、表格无 overflow-x、Sidebar 固定 210px、CertManager 固定 380px 双栏 + 480px 抽屉 | 表格包 `.table-scroll`；窄屏 Sidebar 折叠为图标；抽屉改 max-width: 90vw |
| P2-3 | 硬编码中文 15 页（VPN 6 页 + 零信任 4 页 + CertManager/PortalManager/UserProfiles 等） | 补 i18n key；新页面 PRD 中把"走 i18n"列为验收项 |
| P2-4 | CertManager 详情抽屉 `background:'white'` 写死，深色模式下刺眼 | 改用 CSS 变量 |
| P2-5 | `Online.jsx:51` 时间 `substring(5,16)` 砍掉年份，跨年误导 | 统一时间工具 |
| P2-6 | `App.jsx:48` `EmptyMsg` 引用未定义的 `useT`（死代码，路由用到即崩） | 删除或修复 |
| P2-7 | 空态覆盖较好但文案无引导动作 | 空态加引导按钮（如"暂无用户 → 新建用户"） |
| P2-8 | `NasManagement.jsx:20`、`Users.jsx:48` 等 secret/密码走 URL query 明文，会进访问日志 | 改 POST body 传输 |

---

## 5. 系统化改进方案（不只修点，要修面）

零散的 40 个弹窗逐个修不经济，建议先建 4 个**全局基础件**，一次性替换：

### 5.1 反馈三件套（预计 1 个工作日，消除 P0/P1 中约 60% 问题）

```
components/
├── Toast.jsx        # 成功(2s自动消失)/失败(常驻+重试)/警告，右上角堆叠
├── ConfirmModal.jsx # 危险操作确认：标题+后果说明+危险色按钮；
│                    # 极高危(清空日志)支持"输入关键字确认"模式
└── FormModal.jsx    # 替代 prompt：改密/吊销原因等输入场景
```

替换优先级：VpnNode → PortalManager → Users → CertManager → VpnPerm → 其余。

### 5.2 请求层统一兜底（`api.js`，约 2 小时）

- `fetchApi` 内统一 catch → 抛 Toast，页面不再需要各自 `.catch(console.error)`；
- 401 统一跳登录（当前 token 失效体验未验证，建议一并处理）；
- 提供 `useTableData()` Hook：内置 loading / error / empty 三态 + 分页逻辑，各列表页接入即解决"无加载态 + 失败伪装空态 + 分页不一致"三个共性问题。

### 5.3 时间与格式化工具（`utils/format.js`，约 1 小时）

- `fmtTime()`（本地化 + 时区正确）、`relTime()`（相对时间）、`fmtBytes()`/`fmtDur()` 已有两处实现，收拢为一份；
- 全局替换 `substring(0,19)` 类调用。

### 5.4 i18n 修复（约 0.5 个工作日）

1. `tr()` 改为 React Context，语言切换触发重渲染（修 P0-9）；
2. 补 `table_size` 等缺失 key；
3. 15 页硬编码中文按"VPN → 零信任 → 证书/Portal"顺序分批补 key。

### 5.5 危险操作分级规范（写入团队约定）

| 级别 | 操作示例 | 交互要求 |
|------|---------|---------|
| L1 可逆 | 编辑、重命名 | 无需确认，Toast 反馈即可 |
| L2 不可逆单点 | 删除用户/规则/Profile | ConfirmModal + 后果说明 |
| L3 不可逆影响面大 | 吊销证书、清空日志、撤销授权 | ConfirmModal + 后果 + 影响数量 |
| L4 全局服务 | 重启 Portal、停止 VPN | ConfirmModal + 红色按钮 + 明确"将断开 N 个在线用户" |

---

## 6. 落地路线图

| 阶段 | 内容 | 消除问题 | 预估工作量 |
|------|------|---------|-----------|
| **一期：止血**（本周） | P0-1~P0-6、P0-14（服务确认、改密 Modal、QR 本地化、删默认凭据、日志分页） | 全部安全与数据风险项 | 1.5 天 |
| **二期：建制**（下周） | 反馈三件套 + 请求层兜底 + useTableData Hook + i18n Context 化 | P0-7~P0-13、P1-1~P1-6 | 2 天 |
| **三期：打磨**（按需） | 时间工具、响应式、空态引导、操作列收敛、导航合并 | P1-7~P1-15、全部 P2 | 2 天 |

---

## 7. 值得保留并推广为规范的现有范式

| 范式 | 出处 | 推广方向 |
|------|------|---------|
| 有关联数据禁止删除（有成员的组/Profile 禁删） | Groups.jsx:71、UserProfiles.jsx:93 | 推广到 ZtGroups、QosPolicy |
| 删除确认文案说明后果（"N 个用户绑定"） | UserProfiles.jsx:46 | 作为 ConfirmModal 的文案模板 |
| 提交中禁用防重复 | CertManager.jsx:274、Login.jsx:71 | 收进 FormModal 默认行为 |
| 服务端分页 + 筛选翻页保留 | ZtLog.jsx | 作为 useTableData Hook 蓝本 |
| 未保存修改提示 | Users.jsx:172 | 推广到所有行内编辑页 |
| 登录页内联错误 + loading | Login.jsx | 作为表单页标杆（但须删掉默认凭据行） |
