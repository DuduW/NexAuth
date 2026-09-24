# PRD — 运维页面渲染风格模版（Ops UI Style Template）

| 项 | 内容 |
|---|---|
| 版本 | v1.0（评审稿） |
| 日期 | 2026-09-22 |
| 作者 | 前端页面开发工程师 |
| 状态 | ⏳ 待决策（D1~D5 见第 10 章） |
| 关联 | admin-spa（`D:\radius\src\frontend`）、`index.css`、`CollapsePanel.jsx` |

---

## 1. 背景与目标

现有 admin-spa 已具备统一的基础风格（浅色背景 + 白卡片 + 大圆角 + 蓝主色 + 深色模式），但运维场景高频出现的**信息表达组件**仍缺规范：服务健康状态、容量水位、日志流、事件时间线、趋势迷你图、告警横幅等，各页面自行实现导致表现不一致。

本 PRD 定义一套「运维常用页面渲染风格模版」：

- **目标 1**：沉淀一套运维特色组件规范（KPI 卡 / 状态灯 / 水位条 / 日志窗口 / 时间线 / sparkline / 告警横幅）。
- **目标 2**：与现有 `index.css` **增量兼容**——变量名、圆角、色彩体系完全沿用，不推翻现有页面。
- **目标 3**：提供单文件实例 HTML（`docs/design/ops-style-template.html`），浏览器直接打开即可评审，含深/浅主题切换。

## 2. 适用范围

| 范围 | 说明 |
|---|---|
| ✅ 适用 | admin-spa 全部新页面；ServerStats / Dashboard / 日志类 / 交换机管理 / Ceph 运维平台等运维数据页 |
| ⚠️ 参考 | NetAgent 客户端（Wails + React，仅参考 tokens，不共享代码） |
| ❌ 不适用 | daloRADIUS（PHP 遗留）、报告类 HTML（报告有独立的海报风格规范） |

## 3. 设计原则

1. **信息密度优先**：运维页面一屏看全关键指标；卡片间距紧凑（14~18px），表格行高 36~40px。
2. **状态即颜色**：🟢 正常 / 🟡 注意 / 🔴 异常 / ⚪ 未知，四态全域统一，阈值色变规则全局一致。
3. **数字等宽右对齐**：所有数值列 `font-variant-numeric: tabular-nums` + 右对齐（已有 `th.num/td.num`）。
4. **增量不推翻**：新组件类名一律以 `ops-` 前缀挂载到现有样式体系，老页面零改动。
5. **深浅双主题**：每个组件必须同时定义浅色与 `.dark` 深色样式。

## 4. 设计 Tokens（与现有一致，新增 3 个）

```css
:root {
  /* 既有：沿用 index.css，不改动 */
  --blue: #1450C8; --green: #2BBD7E; --red: #c23c34; --orange: #E0742A;
  --dark: #1f2430; --gray: #6b7488; --muted: #8b94a6; --border: #e2e7f0;
  --bg-light: #fafbfd; --bg-title: #f7f9fc;

  /* 新增（仅 3 个） */
  --ok:      var(--green);        /* 状态灯-正常 */
  --warn:    #E0A52A;             /* 状态灯-注意（区别于 orange） */
  --crit:    var(--red);          /* 状态灯-异常 */
  --mono: "JetBrains Mono", Consolas, "Courier New", monospace;  /* 日志/终端/代码 */
}
```

| 类别 | 规范 |
|---|---|
| 字体 | 界面 PingFang SC / Microsoft YaHei；日志与命令行一律 `--mono` |
| 圆角 | 卡片 14~16px、按钮 8px、chip 999px（沿用现有） |
| 间距 | 页面留白 28×32px；卡片间距 14~18px；panel-body 16×20px（沿用现有） |
| 状态色阈值 | 使用率 <70% 绿、70~85% 黄、>85% 红（对齐 Ceph 近满阈值 85%） |

## 5. 布局规范

```
┌────────┬──────────────────────────────────────┐
│        │ 页头（h1 22px + 操作按钮右对齐）          │
│ 侧边栏   │ 告警横幅（可选，仅异常时出现）            │
│ 210px  │ KPI 卡行（grid auto-fit minmax 180px）  │
│ sticky │ 主区 ≤1400px 居中                        │
│        │ panel 卡片纵向堆叠（可折叠）               │
└────────┴──────────────────────────────────────┘
```

- 侧边栏 / 页头 / `.main` 限宽：完全沿用现有结构，无变化。
- KPI 行与 panel 之间留 20px；KPI 卡 hover 上浮 2px（沿用 `.stat-card`）。

## 6. 组件规范（核心，共 10 个）

### 6.1 KPI 统计卡（ops-kpi，扩展自 .stat-card）

```html
<div class="stat-card">
  <div class="label">今日认证</div>
  <div class="value">12,847</div>
  <div class="kpi-foot">
    <svg class="spark">…</svg>            <!-- 7 点 sparkline，24×36 -->
    <span class="trend up">+6.2%</span>   <!-- up 绿 / down 红 / flat 灰 -->
  </div>
</div>
```

- 迷你趋势线（sparkline）：SVG polyline，无坐标轴，最后一帧高亮圆点。
- 环比箭头：↑ 绿 / ↓ 红（流量方向语义：涨=好=绿）。

### 6.2 服务状态灯网格（ops-health）

```html
<div class="health-grid">
  <div class="health-cell ok"   title="运行中 46 天">● radiusd</div>
  <div class="health-cell warn" title="最近 1 次重启">● mariadb</div>
  <div class="health-cell crit" title="3 次重试失败">● nginx</div>
  <div class="health-cell off">○ 未知</div>
</div>
```

- 四态：`ok` 绿 / `warn` 黄 / `crit` 红 / `off` 灰；圆点呼吸动画仅 crit 有。
- 网格 `repeat(auto-fill, minmax(150px, 1fr))`，单元格即 tooltip 载体。

### 6.3 容量水位条（ops-meter）

```html
<div class="meter">
  <div class="meter-head"><span>s3-2024 使用率</span><b class="c-warn">82.5%</b></div>
  <div class="meter-bar"><i class="fill warn" style="width:82.5%"></i><em class="thresh" style="left:85%"></em></div>
</div>
```

- 填充色按 4.4 节阈值自动切换；`thresh` 竖线标注告警阈值（85%）。
- 数字与色带同色，一眼对齐。

### 6.4 数据表格（沿用 + 约定）

- 状态列用 badge：`badge-success`（接受/在线/成功）、`badge-danger`（拒绝/失败）、`badge-warning`（超时/降级）、`badge-default`（历史）。
- 数值列 `num` 类；时间列等宽字体 `--mono`（`09-22 20:15:33` 等宽不跳动）。
- 行操作按钮统一 `btn-outline btn-sm`，危险操作 `btn-danger btn-sm`。

### 6.5 日志流 / 终端窗口（ops-term）

```html
<div class="term">
  <div class="term-bar"><i></i><i></i><i></i><span>radiusd -X / tail -f</span></div>
  <pre class="term-body">Mon Sep 22 20:15:33 2026 : Auth: (1234) Login OK: [double/&lt;via Tunnel-Type&gt;]</pre>
</div>
```

- 深色窗口（浅色主题下也是深色，终端语义），macOS 三色窗口点装饰。
- 日志着色：`OK/成功` 绿、`FAIL/Reject` 红、时间戳灰、其余默认色。
- 自动滚动到底部；等宽 12px；行高 1.6。

### 6.6 事件时间线（ops-timeline）

```html
<div class="tl">
  <div class="tl-item ok"><i class="tl-dot"></i><div class="tl-time">20:15:33</div><div class="tl-body">CoA 下发成功 → 10.99.0.4</div></div>
  <div class="tl-item crit"><i class="tl-dot"></i><div class="tl-time">19:02:10</div><div class="tl-body">EAP-TLS 握手失败 ×3</div></div>
</div>
```

- 竖线贯穿 + 节点圆点按状态着色；时间列等宽右对齐。
- 用于：认证事件流、备份任务历史、变更审计。

### 6.7 告警横幅（ops-banner）

```html
<div class="banner crit"><b>🔴 2 项异常</b><span>nginx 重启 3 次 · s3-2024 使用率 82.5%（阈值 85%）</span><button>查看</button></div>
```

- 三级：`crit`（红底浅纹）/ `warn`（橙）/ `info`（蓝）；仅异常时渲染，可关闭。

### 6.8 折叠面板（复用 CollapsePanel）

- 已上线组件，规范不变：默认展开、标题栏整行点击、`storageKey` 记忆。

### 6.9 空态与骨架屏（ops-empty / ops-skel）

- 空态：图标 + 一句话 + 行动按钮（如「还没有 VPN 连接 → 前往下载配置」）。
- 骨架屏：加载中数据区显示 3 行灰阶呼吸条，避免表格跳变。

### 6.10 键值描述列表（ops-kv）

```html
<div class="kv"><span>设备型号</span><b>S5735-L48T4X</b></div>
```

- 两列网格，label 灰 / value 深色等宽（IP、MAC、序列号场景）。

## 7. 交互规范

| 场景 | 规范 |
|---|---|
| 加载 | 骨架屏（首屏）/ spinner（按钮内 / 局部刷新）；>300ms 才显示，防闪烁 |
| 反馈 | 成功/失败统一 Toast（已有）；危险操作强制 Modal 二次确认（已有） |
| 刷新 | 手动刷新按钮带旋转动画；自动轮询 30s，页面不可见时暂停（`visibilitychange`） |
| 折叠 | CollapsePanel 统一，禁止页面私造折叠实现 |
| 表格 | >50 行分页（已有 Pagination）；列排序 hover 出现箭头 |

## 8. 深色模式

- 沿用 `.dark` class 方案；所有 `ops-*` 组件必须提供 `.dark` 覆写。
- 终端窗口组件在两种主题下保持深色不变。
- 状态色在深色下降低饱和度 15%（避免刺眼），如 green → `#3ecf8e`。

## 9. 融合方案（二选一，需决策）

| 方案 | 内容 | 工作量 | 风险 |
|---|---|---|---|
| **A. 增量扩展（推荐）** | 新组件样式追加为 `index.css` 的「Ops 组件库」段落（约 200 行），新建页面直接用；老页面不动 | 0.5 天 | 极低：纯 CSS 追加，无 JS 改动 |
| B. tokens 重构 | 抽出 `design-tokens.css` + `ops-components.css` 两文件，全部页面 import 改造 | 2~3 天 | 中：需回归全部 37 个页面 |

## 10. 决策点（请逐项拍板）

| # | 决策项 | 选项 |
|---|---|---|
| D1 | 是否采用本模版 | ✅ 采用 / ❌ 不采用 / ⚠️ 部分采用（指定组件） |
| D2 | 融合方案 | A 增量扩展（推荐）/ B tokens 重构 |
| D3 | 注意色 | 新增 `--warn: #E0A52A`（与现有 orange #E0742A 并存）/ 直接复用 orange |
| D4 | 终端窗口浅色主题下是否保持深色 | 保持深色（推荐）/ 跟随主题 |
| D5 | 首个落地页面 | ServerStats（改造成本最低）/ Dashboard / 新页面直接套用 |

## 11. 验收标准

1. 实例 HTML（`ops-style-template.html`）在 Chrome/Edge 深浅主题下渲染无布局破损。
2. 10 个组件均有：浅色样式、深色样式、空态三形态。
3. 状态色阈值（70/85）与 Ceph 监控口径一致。
4. 落地后老页面（37 个）零视觉回归。

---

*评审通过后按「方案 A 执行」推进；实例效果请打开 `docs/design/ops-style-template.html`。*
