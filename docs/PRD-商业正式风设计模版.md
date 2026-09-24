# PRD — 商业正式风前端设计模版（Enterprise Formal UI Template）

| 项 | 内容 |
|---|---|
| 版本 | v1.0（评审稿） |
| 日期 | 2026-09-22 |
| 作者 | 前端页面开发工程师 |
| 状态 | ⏳ 待决策（D1~D4 见第 9 章） |
| 关联 | `docs/design/enterprise-formal-template.html`（实例） |
| 风格基准 | IBM Carbon Design System（主）+ Ant Design Pro（辅） |

---

## 1. 需求背景

用户要求「跳出原有思维」——现有 admin-spa 是 Apple/iOS 轻盈风（浅灰底 + 白卡片 + 大圆角 + 蓝紫主色），需调研业界**正式、商业级**的设计风格并产出模版对比决策。

### 1.1 网络调研结论（2026-09-22）

| 设计体系 | 定位 | 核心特征 | 可借鉴点 |
|---|---|---|---|
| **IBM Carbon** | 国际企业级标杆，为高密度数据界面而生 | 2x 网格（8px 基准单位）、IBM Plex 字体、冷灰中性色、**默认 0px 直角**、密度优先于装饰、无阴影层级（用色阶表达高度） | 数据表格、Tile 卡片、通知横幅、UI Shell（顶栏+侧栏）、图表配色序列 |
| Ant Design Pro | 国内中后台事实标准 | 24 列栅格、PageContainer 页容器、ProTable 查询表格范式、Token 主题化 | 面包屑、查询区固定高度、表格工具栏、主键列蓝色高亮 |
| Atlassian / Fluent 2 | 语义 Token / 跨端 | 语义色命名 | 深浅主题同源 Token |

### 1.2 为什么选 Carbon 为主轴

- 与现有风格**差异最大**：直角 vs 圆角、冷灰 vs 暖白、克制 vs 轻盈——「正式、商业」关键词的最佳诠释。
- 为**数据密度**场景而生（8 小时盯屏的运维/分析师场景），与运维平台诉求天然匹配。
- 规范完整公开（Apache 2.0），无版权风险。

## 2. 风格定位对比

| 维度 | 现有 Apple 轻盈风 | 本模版 Carbon 正式风 |
|---|---|---|
| 圆角 | 14~16px 大圆角 | **0px 直角**（仅 Tag 4px） |
| 主色 | #1450C8 亮蓝 | **#0f62fe IBM Blue** |
| 背景 | #eef1f6 暖白 | **#f4f4f4 冷灰** |
| 侧边栏 | 浅色 #fafbfd | **深色 #161616**（经典企业 Shell） |
| 字体 | PingFang SC | **IBM Plex Sans + Plex Mono**（数字/日志） |
| 层级表达 | 阴影 + 圆角 | **1px 边框 + 色阶**（无阴影） |
| 信息密度 | 中（宽松留白） | **高（紧凑 8px 节奏）** |
| 气质 | 消费级轻盈 | **商业级严肃** |
| 适合 | 内部工具、已有 37 页 | 对外汇报、客户交付、新商业平台 |

## 3. 设计 Tokens

```css
:root {
  /* 色彩（Carbon 官方值） */
  --interactive: #0f62fe;      /* 主交互蓝 */
  --link: #0043ce;
  --danger:  #da1e28;  --warning: #f1c21b;  --success: #24a148;
  --text-primary: #161616; --text-secondary: #525252; --text-placeholder: #a8a8a8;
  --layer-01: #f4f4f4;   /* 页面底 */
  --layer-02: #ffffff;   /* 容器 */
  --layer-accent: #e0e0e0;
  --border-subtle: #e0e0e0; --border-strong: #a8a8a8;
  /* 字体 */
  --font-sans: "IBM Plex Sans", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: "IBM Plex Mono", Consolas, monospace;
  /* 网格：8px 基准（2x grid mini unit） */
  --space-1: 8px; --space-2: 16px; --space-3: 24px; --space-4: 32px;
  --radius: 0px; --radius-tag: 4px;
}
```

**栅格**：16 列 / 32px gutter（Carbon Wide 模式）；页面采用 High-density 模型（全宽利用，不居中限宽）。

**字号阶梯**：页题 28 / 区块题 16 / 正文 14 / 辅助 12（数字一律 Plex Mono 等宽）。

## 4. 布局规范（Carbon UI Shell）

```
┌──────────────────────────────────────────────┐
│ 顶栏 48px 白底：产品标识 │ 面包屑 │ 环境Tag │ 用户 │
├───────────┬──────────────────────────────────┤
│ 侧栏 240px │ 内容区 #f4f4f4                    │
│ 深色#161616│ ─ 页题行（h1 28px + 主/次按钮右对齐）│
│ 分组菜单   │ ─ 行内通知（仅异常时）              │
│ active=   │ ─ KPI Tile 行 ×4                  │
│ 左侧3px蓝条│ ─ 数据表格 Tile（全宽）             │
│           │ ─ 状态/水位 + 日志/时间线 双列      │
└───────────┴──────────────────────────────────┘
```

## 5. 组件规范（9 个，均含深色 g90 形态）

| # | 组件 | Carbon 规范要点 |
|---|---|---|
| 1 | KPI Tile | 白底 1px 边框直角；label 12px 灰全大写；数值 28px Plex Mono；底部环比趋势 |
| 2 | 数据表格 | 表头 12px/600 + 排序 caret；行高 44px 紧凑；hover #e8e8e8；主键列蓝色链接；操作列 ghost 按钮 |
| 3 | Tag 状态标签 | 4px 圆角 + 前置色点：正常绿 #24a148 / 异常红 #da1e28 / 注意黄 #f1c21b / 未知灰 |
| 4 | 行内通知 | 左 3px 色条 + 浅色底：danger / warning / info；标题加粗 + 描述 + 关闭钮 |
| 5 | 容量指示条 | 6px 细条 + 3px 圆角端点；数值色与条同色；85% 阈值刻度线 |
| 6 | 终端日志窗 | #161616 底 + Plex Mono 12px；时间戳灰 / OK 绿 / FAIL 红 / 命令蓝 |
| 7 | 事件时间线 | 左侧 1px 竖线 + 12px 状态节点；时间列 Mono 右对齐 |
| 8 | 按钮组 | Primary 蓝实底 / Secondary 白底灰边 / Ghost 纯文字蓝 / Danger 红；高度 40px，直角 |
| 9 | 面包屑 | 顶栏内 14px：`总览 / 网络准入 / 运维总览`，当前项黑、父级蓝 |

## 6. 深色模式（Carbon g90）

- 页面底 #161616 / 容器 #212121 / 侧栏 #000000 / 文字 #f4f4f4 / 边框 #393939。
- 主蓝在深色下提亮为 #78a9ff（保证对比度）；状态色同步提亮。
- 终端窗两种主题下恒深色。

## 7. 字体加载策略

- IBM Plex Sans / Mono 走 Google Fonts CDN + 系统字体兜底（离线/被墙时降级 PingFang/微软雅黑，布局不塌）。
- 若正式采用：下载 woff2 自托管到 106（`/admin-spa/fonts/`），不依赖外网。

## 8. 若采用：落地策略（三选一）

| 方案 | 内容 | 工作量 |
|---|---|---|
| **A. 独立新平台**（推荐） | Ceph 运维平台 / 交换机管理 2.0 等新 0→1 项目直接用本风格；admin-spa 存量 37 页不动 | 按新页面逐个 0 成本套用 |
| B. 双主题并存 | admin-spa 增加「正式主题」换肤（Token 替换层），用户可切换 | 3~5 天 + 全站回归 |
| C. 全站迁移 | admin-spa 整体改造成 Carbon 风 | 2~3 周，风险高不推荐 |

## 9. 决策点（请逐项拍板）

| # | 决策项 | 选项 |
|---|---|---|
| D1 | 风格取向 | 🅰 保持现有 Apple 轻盈风 / 🅱 采用 Carbon 正式风 / 🅲 两者并存（新平台 B 风、存量 A 风） |
| D2 | 若采用，落地策略 | A 独立新平台（推荐）/ B 双主题 / C 全站迁移 |
| D3 | 直角接受度 | 全直角（纯正 Carbon）/ 卡片 2px 微圆角折中 |
| D4 | 字体 | 自托管 IBM Plex（推荐）/ 仅系统字体 |

## 10. 验收标准

1. 实例 HTML 双主题渲染无破损（Chrome/Edge 1366 / 1920 两档宽度）。
2. 表格 44px 行高下 1920 屏一屏可见 ≥12 行数据。
3. 所有数值/时间使用等宽字体，列宽不跳动。
4. 色彩对比度满足 WCAG AA（正文 ≥4.5:1）。

---

*实例效果请打开 `docs/design/enterprise-formal-template.html`（右上角切换深浅主题）。*
