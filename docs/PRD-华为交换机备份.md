# PRD — 华为交换机备份管理（Switch Backup Console）

**版本**：v2.1（9/15：v1.0+v2.0 已部署上线；v2.0.1 温度修复+字体对齐；v2.1 定时备份（v1.1 范围）已开发+部署上线，见 §3.6）
**日期**：2026-09-14
**模块归属**：admin-spa 侧边栏新增「交换机管理」分组（与 RADIUS 管理 / VPN 管理 / 零信任 并列）
**URL**：`#/sw`、`#/sw-backups`、`#/sw-analysis`
**部署基座**：192.168.110.106（FastAPI + MariaDB + Nginx，与现有 radius-admin 同进程）
**目标设备**：华为 S57 系列交换机（VRP），预留 AC6003 扩展

---

## 1. 背景与目标

### 1.1 现状（运维痛点）

当前交换机配置备份依赖人工：SSH 登录设备 → 手工执行 `display current-configuration` → 粘贴到本地文件归档。

| 痛点 | 后果 |
|---|---|
| 无备份台账 | 不知道哪台设备多久没备份、上次备份是谁做的 |
| 无版本管理 | 配置变更后无法 diff 对比，出问题难以回溯 |
| 还原无流程 | 故障恢复时手工粘贴配置，风险高、无留痕 |
| 状态不可见 | 设备离线/CPU 告警/端口 down 只有登设备才知道 |

### 1.2 目标

把「SSH 手工备份」升级为「平台化管理」：

1. **管设备**：交换机台账（IP、凭据、分组、连接状态）
2. **备得出**：手动 + 定时自动备份，版本化存储、diff 对比、保留策略
3. **还得了**：选历史版本 → 预览 diff → 强确认 → 先自动备份当前再下发（可回滚）
4. **看得见**：在线分析——设备在线状态、CPU/内存、端口状态、最近告警

### 1.3 非目标（本期不做）

- 不做多厂商适配（仅华为 VRP；Cisco/华三留扩展位）
- 不做配置下发编排/批量变更（仅"整份还原"一种写操作）
- 不做 SNMP/Telemetry 采集通道（一期全走 SSH 命令行采集）
- 不做拓扑发现（设备手工录入）

---

## 2. 分期交付

| 版本 | 内容 | 状态 |
|---|---|---|
| **v1.0** | 设备台账 + 凭据管理 + 手动备份 + 版本历史 + diff 查看 | ✅ 已开发+单测通过（2026-09-14，待部署实测） |
| **v1.1** | 定时备份任务 + 保留策略 + 备份失败通知 | ✅ 已开发+部署（2026-09-15，按 §3.6 设计交付；备份失败通知=执行记录明细+任务最近执行状态，钉钉/邮件渠道待决策） |
| **v1.2** | 还原任务（diff 预览 + 强确认 + 自动前置备份） | 待开发 |
| **v2.0** | 在线分析（状态巡检 + CPU/内存/端口/告警采集与展示） | ✅ 已开发+部署（2026-09-14，手动巡检；定时巡检待 v1.1 调度就绪后挂载） |
| **v2.0.1** | 温度解析修复（`display temperature all` 回落）+ 前端字体对齐准入页 | ✅ 已修复+部署（2026-09-15） |

### v1.0 交付物（2026-09-14）

| 层 | 文件 | 说明 |
|---|---|---|
| 建表 | `scripts/sql/002_switch_backup.sql` | 6 张 sw_* 表（v1.0 实际用到 5 张，health_snapshot 为 v2.0 预留） |
| 加密 | `src/backend/core/sw_crypto.py` | AES-256-GCM，主密钥 env `SW_MASTER_KEY` |
| SSH | `src/backend/core/sw_ssh.py` | invoke_shell + 提示符正则 + screen-length 0 + VRP 解析纯函数 + diff |
| 引擎 | `src/backend/core/sw_backup.py` | 占版本号(异步) → SSH 抓取(to_thread) → 落盘落库(异步) 三段式 |
| 路由 | `src/backend/routers/sw.py` | 设备 CRUD/测试/备份/版本/内容/下载/diff；main.py 已注册（仅 +2 行） |
| 前端 | `pages/SwDevices.jsx` `pages/SwBackups.jsx` + Sidebar「交换机管理」组 + 路由 | 复用 Toast/Confirm/FormModal 基础件 |
| 测试 | `tools/test/test_sw_modules.py` | 23 用例全过：加密往返/错误密钥/VRP 解析/配置清洗/diff/提示符正则 |
| 验证 | vite build 0 error · oxlint 0 error · py_compile 5 文件通过 | — |

### v1.0 部署步骤（已执行 2026-09-14 15:58）

1. 建表：`mysql radius < scripts/sql/002_switch_backup.sql`（192.168.110.106）✅
2. 配置主密钥：systemd drop-in `sw-master.conf`（留档 `/var/backups/sw-master-key-20260914-155858.conf`）✅
3. 上传后端文件 + main.py；上传前端 dist；重启 radius-admin ✅
4. 页面实测：添加交换机 → 连接测试 → 立即备份 → 版本历史/diff/下载（用户进行中）

### v2.0 交付物（2026-09-14，在线分析）

| 层 | 文件 | 说明 |
|---|---|---|
| 采集 | `core/sw_ssh.py` | `collect_health_blocking`（单会话采集 version/cpu/mem/interfaces/alarms/environment，可选命令失败不致命）+ `parse_interfaces`（过滤 Vlanif/LoopBack 等逻辑口）/`parse_environment`/`parse_alarms` |
| 路由 | `routers/sw.py` | `POST /sw/analysis/run`（串行巡检、设备间隔 1s）、`GET /sw/analysis/overview`（最新快照 + 连续 3 次离线防抖）、`GET /sw/analysis/devices/{id}`（详情 + ≤7 天历史）；快照落 `sw_health_snapshot` 30 天滚动清理 |
| 前端 | `pages/SwHealth.jsx` + Sidebar「在线分析」+ 路由 `/sw-analysis` | 总览 stat 卡 + 设备表（状态灯/CPU/内存迷你条/温度/告警）+ 立即巡检 + 详情弹窗（SVG 24h 趋势/端口表/告警列表） |
| 测试 | `tools/test/test_sw_modules.py` | 新增 §5/§6 共 19 用例（brief 新旧表头/environment 两种形态/告警过滤与上限/mock 单命令失败容错），合计 42/42 |
| 部署 | `tools/deploy/deploy_sw_v2.py` | 增量部署（3 后端文件 MD5 + 前端覆盖 + 重启 + 回归），DEPLOY_OK |

> 注：定时巡检（5 分钟）依赖 v1.1 的 APScheduler 落地，当前为「手动立即巡检」模式。

> v1.0~v1.2 为「备份还原」主线，v2.0 为「在线分析」线，可并行预研。

---

## 3. 功能详述

### 3.1 设备管理（交换机列表）

**页面**：`#/sw`（侧边栏新增「交换机管理」分组，位于「零信任」与「系统」之间，含三个子页：设备管理 / 备份与还原 / 在线分析——与 VPN 管理、零信任分组同层级同交互）
**页面示例（评审用）**：`docs/mockups/交换机管理-页面示例.html`（静态 HTML，样式逐类复刻 admin-spa 现行设计系统，含还原强确认弹窗交互演示）
**建表脚本**：`scripts/sql/002_switch_backup.sql`（v0.2 已具体化，6 张表可直接执行）

| 字段 | 说明 | 必填 | 示例 |
|---|---|---|---|
| 设备名称 | 唯一标识，运维友好命名 | ✅ | `S57-2F-Core-01` |
| 管理 IP | SSH 可达的带内/带外地址 | ✅ | `172.18.x.x` |
| 型号 | 影响 SSH 交互提示符匹配 | ✅ | `S5735-L48T4X`（下拉+自定义） |
| SSH 端口 | 默认 22 | ✅ | 22 |
| 凭据 | 用户名/密码（见 §3.2） | ✅ | — |
| 分组/标签 | 位置或用途分组 | ➖ | `2F`、`IDC` |
| 备注 | ➖ | ➖ | — |
| 启用状态 | 停用后不参与定时备份/巡检 | ✅ | 启用 |

**操作**：添加 / 编辑 / 删除（**有关联备份记录的设备禁删**，提示先清理或仅停用）/ 连接测试 / 批量导入（CSV）。

**连接测试**：立即 SSH 登录执行 `display version`，返回：✅ 成功（带 VRP 版本、运行时长）/ ❌ 失败（凭据错误 / 网络不可达 / SSH 超时，分别给出文案）。

### 3.2 凭据管理（安全要求）

| 规则 | 设计 |
|---|---|
| 存储 | 密码 **AES-256-GCM 加密**后入库，主密钥放服务端环境变量（`SW_MASTER_KEY`），数据库泄露不泄露明文 |
| 共享 | 支持「共享凭据组」（多台设备同一账号）与「设备独立凭据」两种模式 |
| 展示 | 列表/详情**永不回显密码**，编辑时留空 = 不变 |
| 审计 | 凭据增删改写入审计日志（谁、何时、哪台设备） |

### 3.3 备份任务

**手动备份**（v1.0）：设备列表行内按钮 + 多选批量「立即备份」。

**备份执行流程**：

```
SSH 登录 → 关闭分页(screen-length 0 temporary) → display current-configuration
→ 抓取完整配置文本 → 本地落盘 → 元数据入库 → 与上一版本 diff → 完成
```

**备份记录字段**：

| 字段 | 说明 |
|---|---|
| 版本号 | 同设备自增 v1, v2, ... |
| 备份时间 | — |
| 触发方式 | 手动（含操作人）/ 定时任务名 |
| 配置大小 / 行数 | — |
| 与上版 diff 摘要 | `+N 行 / -N 行`（首版显示"初始版本"） |
| 状态 | ✅ 成功 / ❌ 失败（含失败原因） |

**定时备份**（v1.1）：任务 = 设备集合（按分组或多选）+ 周期（每天/每周/自定义 cron）+ 保留策略（如保留最近 30 份 + 永久保留每日最后一份）。后端 APScheduler 执行，与现有 CoA 后台线程同进程模式。**详细设计见 §3.6**。

**版本查看**：任一版本可在线浏览全文 + 与任意历史版本双栏 diff（复用 monaco-diff 或简易双栏高亮）+ 下载 `.cfg`。

### 3.4 还原任务（高危）

**入口**：备份版本详情 → 「还原到此设备」。

**流程（L4 级危险操作，四步闸门）**：

1. **选择范围**：整份还原（本期唯一模式）
2. **diff 预览**：展示「当前运行配置 ↔ 将还原配置」的差异，红绿高亮
3. **强确认**：弹窗要求**手动输入设备名称**才可执行，文案明示后果：
   > "还原将覆盖 `S57-2F-Core-01` 当前全部配置，可能导致该设备承载的业务中断。系统会先自动备份当前配置（可回滚）。请输入设备名称确认。"
4. **执行**：
   - **前置自动备份**：先抓取当前 running-config 存为新版本（标记 `还原前快照`，可用于回滚）
   - SSH 下发：`screen-length 0 temporary` → 逐段粘贴配置 → `save` 保存到 vrpcfg.zip
   - **回滚**：还原后 10 分钟内页面上方常驻「还原完成，[回滚到还原前快照]」提示条
5. **留痕**：还原记录（操作人、时间、源版本、前置快照版本、结果）永久保留

> 说明：本期采用「SSH 粘贴下发」实现，不做 S57 `configuration replace`（VRP 各版本语义不一，先保守）。下发分块大小 4KB，块间隔 200ms，防止 CLI 缓冲溢出。

### 3.5 交换机在线分析（v2.0）

**页面**：`#/sw-analysis`

**采集**（定时巡检，默认每 5 分钟，后台线程/协程，串行逐台防 SSH 并发风暴）：

| 采集项 | 命令 | 解析结果 |
|---|---|---|
| 在线状态 | SSH 登录成功即在线 | 🟢在线 / 🔴离线（连续 3 次失败才标记，防抖） |
| 基本信息 | `display version` | VRP 版本、已运行时长 |
| CPU | `display cpu-usage` | 百分比 |
| 内存 | `display memory-usage` | 百分比 |
| 端口状态 | `display interface brief` | up/down、速率、双工 |
| 端口流量 | `display interface` | 入/出速率、错包、丢包 |
| 告警 | `display alarm urgent` | 当前活动告警 |
| 环境 | `display environment` | 温度、风扇、电源（S57 支持） |

**展示**：

```
┌──────────────────────────────────────────────────────────────┐
│ 交换机在线分析                              [↻ 立即巡检]      │
├──────────────────────────────────────────────────────────────┤
│ 总览卡：🟢 8 在线 / 🔴 1 离线 ｜ CPU 告警 2 台 ｜ 活动告警 5 条 │
├──────────────────────────────────────────────────────────────┤
│ 设备列表（状态灯 + CPU/内存迷你条 + 最近备份时间 + [详情]）    │
├──────────────────────────────────────────────────────────────┤
│ 设备详情：                                                    │
│   [CPU/内存 24h 趋势折线]  [端口列表: up/down/速率/流量/错包]  │
│   [当前告警列表]  [最近备份版本 + 一键备份]                    │
└──────────────────────────────────────────────────────────────┘
```

**阈值与状态灯**：CPU ≥80% 🟡 / ≥95% 🔴；内存 ≥80% 🟡 / ≥95% 🔴；温度 ≥65°C 🟡（对齐 R750 压测基线口径）。

### 3.6 定时备份任务（v1.1 详细设计，2026-09-15；**当日开发+部署上线 ✅**）

#### 3.6.1 功能需求

| # | 需求 | 说明 |
|---|---|---|
| 1 | 任务模型 | 任务 = 设备集合（按分组标签或手动多选）+ cron 周期 + 保留策略 + 启用开关 |
| 2 | 周期配置 | 预设模板：每天 02:00 / 每周日 02:00 / 每月 1 日 02:00 / 自定义 cron 表达式（5 段，前端校验 + 下次执行时间实时预览） |
| 3 | 执行方式 | APScheduler `BackgroundScheduler` + `CronTrigger`，与 radius-admin 同进程（同 v2.0 巡检调度基座）；任务内设备**串行执行、间隔 1s**，防 SSH 并发风暴 |
| 4 | 备份落库 | 定时触发的备份记录 `trigger_type=scheduled`，`operator=任务名`（与手动备份共用三段式引擎，零重复代码） |
| 5 | 保留策略 | 每设备保留最近 N 份（默认 30，任务可覆盖）；可选「每日最后一份永久保留」；清理时**记录与文件同删**（复用 v1.0 删除逻辑） |
| 6 | 失败处理 | 单台失败不中断任务内后续设备；失败原因落 `fail_reason`；任务级 `last_run_status/last_run_at` 刷新 |
| 7 | 防冲突 | 同设备已有备份进行中（手动/定时撞车）→ 本次跳过并记录 skip 日志；全任务互斥锁防重复触发 |
| 8 | 通知 | 站内：备份与还原页失败徽标 + 任务详情最近执行列表；可选钉钉机器人 webhook（见决策点） |
| 9 | 恢复能力 | 服务重启后自动重载 enabled 任务；错过的触发（misfire）**不补跑**（`misfire_grace_time=3600, coalesce=True`） |
| 10 | 顺带挂载 | 5 分钟定时巡检（v2.0 遗留项）注册到同一调度器，一并落地 |

#### 3.6.2 数据模型（复用 `sw_backup_task`，微调）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | int PK | — |
| name | varchar(64) | 任务名，唯一 |
| device_scope | json | `{"mode": "group"|"list", "groups": ["2F"], "device_ids": [1,3]}` |
| cron_expr | varchar(32) | 5 段 cron，后端二次校验 |
| retention_count | int | 每设备保留份数，默认 30 |
| retention_daily | tinyint | 每日最后一份永久保留 0/1，默认 0 |
| enabled | tinyint | 启用/停用 |
| last_run_at / last_run_status | — | 最近执行时间与结果（success/partial/failed） |
| remark | varchar(255) | 备注（新增） |

#### 3.6.3 API（前缀 `/sw`，全部落审计）

| Method | Path | 说明 |
|---|---|---|
| GET/POST | `/sw/tasks` | 任务列表（含下次执行时间预览）/ 新建 |
| PUT/DELETE | `/sw/tasks/{id}` | 编辑（热更新调度）/ 删除（不删历史备份记录） |
| POST | `/sw/tasks/{id}/run` | 立即执行一次（走定时同链路，便于验证） |
| GET | `/sw/tasks/{id}/runs` | 最近执行记录（任务视角聚合，含 skipped 明细） |

#### 3.6.4 前端（Sidebar「交换机管理」组新增第四项「定时任务」，`#/sw-tasks`）

- 任务列表：名称 / 设备数 / cron 人话描述（"每天 02:00"）/ 下次执行 / 上次结果徽标 / 启停 / [立即执行][编辑][删除]
- 新建/编辑：FormModal —— 名称、设备范围（分组下拉或多选设备）、周期（预设下拉+自定义 cron 输入框+下次执行时间预览）、保留份数、每日末份开关、备注
- 详情抽屉：该任务最近 50 条执行记录（含每台设备的成功/失败/跳过）

#### 3.6.5 调度实现要点

```
main.py 启动 → init_scheduler() → 读 sw_backup_task(enabled=1)
  → 每个 job: cron 触发 → 遍历 scope 设备（串行+1s 间隔）
    → device.enabled? 无并发锁冲突? → sw_backup.run_backup(device, trigger='scheduled')
    → 全部完成后: 刷新 last_run_*，按 retention_count 清理旧版本
任务 CRUD → 热更新对应 job（modify_job / remove_job），无需重启服务
```

- 调度器随 FastAPI lifespan 启停；jobstore 用内存（任务定义以 DB 为准，重启重载）
- 备份执行沿用 `asyncio.to_thread` 包装，不阻塞事件循环

#### 3.6.6 验收标准

1. 创建「每天 02:00」任务含 2 台设备 → 到点自动产生 `trigger_type=scheduled` 备份记录
2. 保留策略：设保留 3 份 → 第 4 次成功后最旧记录与 .cfg 文件同删
3. 断网设备备份失败 → 任务继续完成其余设备，任务状态 partial + 失败原因可见
4. 服务重启（systemctl restart radius-admin）→ 任务自动恢复调度，无需手工干预
5. 停用设备被任务跳过并记录 skip
6. 手动备份与定时触发撞车 → 后到者跳过，不产生半份文件

---

## 4. 数据模型（MariaDB）

| 表 | 关键字段 |
|---|---|
| `sw_device` | id, name, mgmt_ip, model, ssh_port, credential_id, group_tag, enabled, last_online_at, created_at |
| `sw_credential` | id, name(共享组名), username, password_enc(AES-256-GCM), is_shared |
| `sw_backup_task` | id, name, device_scope(分组/多选), cron_expr, retention_count, retention_daily, enabled, last_run_at, last_run_status |
| `sw_backup_record` | id, device_id, version_no, trigger_type(manual/scheduled/restore-snapshot), operator, size_bytes, line_count, diff_added, diff_removed, status, fail_reason, file_path, created_at |
| `sw_restore_record` | id, device_id, source_record_id, pre_snapshot_id, operator, status, result_msg, created_at |
| `sw_health_snapshot` | id, device_id, online, cpu_pct, mem_pct, uptime, alarm_json, interfaces_json, temp_max, created_at（保留 30 天，按天聚合降采样） |

配置文件本体：`/opt/radius-admin/sw-backups/{device_name}/v{n}_{timestamp}.cfg`（权限 600）。

---

## 5. API 设计（FastAPI，前缀 `/sw`）

| Method | Path | 说明 |
|---|---|---|
| GET/POST | `/sw/devices` | 列表 / 新增 |
| PUT/DELETE | `/sw/devices/{id}` | 编辑 / 删除（有备份记录则 409） |
| POST | `/sw/devices/{id}/test` | 连接测试 |
| POST | `/sw/devices/{id}/backup` | 立即备份 |
| GET | `/sw/devices/{id}/backups` | 版本历史 |
| GET | `/sw/backups/{record_id}/content` | 版本全文 |
| GET | `/sw/backups/{record_id}/diff?target={record_id2}` | 双版本 diff |
| POST | `/sw/restore` | 还原（body: source_record_id，后端二次校验设备状态） |
| GET/POST/PUT/DELETE | `/sw/tasks` … | 定时任务 CRUD（v1.1） |
| GET | `/sw/analysis/overview` | 在线分析总览 |
| GET | `/sw/analysis/devices/{id}` | 单设备详情（趋势/端口/告警） |
| POST | `/sw/analysis/run` | 立即巡检 |

鉴权：复用现有 admin token；写操作（备份/还原/设备增删）全部落审计。

---

## 6. 技术方案要点

| 项 | 选型 | 理由 |
|---|---|---|
| SSH 交互 | `paramiko` + invoke_shell（VRP 提示符正则 `[<\[].*[>\]]` 匹配） | 现有代码已大量使用 paramiko，无新依赖风险 |
| 定时调度 | APScheduler（BackgroundScheduler） | 与 Portal ACK 后台线程同模式，不引入 celery |
| 配置 diff | `difflib.unified_diff` | 标准库足够 |
| 凭据加密 | `cryptography` AES-256-GCM + env 主密钥 | 复用调证工具 AES-256 既有经验 |
| 前端 | admin-spa 现有栈（React + 现有组件体系） | Toast/ConfirmModal/FormModal 基础件直接复用，还原强确认用 ConfirmModal 的"输入关键字"模式 |

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| SSH 明文密码进命令历史/日志 | 密码仅存加密库；日志全程脱敏；API 永不回显 |
| 还原下发中断导致半配置 | 前置快照 + 10 分钟回滚提示条；下发失败自动提示立即还原快照 |
| 多设备并发巡检压垮 SSH/网管 VLAN | 巡检串行 + 设备间隔 1s；超时 10s 单台 |
| 配置文件含敏感信息（SNMP community、密钥） | 存储目录 600 权限；下载走鉴权接口，不开放静态目录 |
| 交换机账号权限过大 | 建议建专用只读备份账号（备份仅需 view 权限；还原才需 system 权限），PRD 附最小权限命令清单 |

---

## 8. 待你确认的决策点

1. **还原是否进 v1.0**？当前排在 v1.2（保守）；若急用可提前。
2. **凭据**：是否需要对接现有 NetAgent/RADIUS 体系做统一凭据，还是独立管理？
3. **在线分析采集频率**：默认 5 分钟，是否有更细需求？
4. **目标设备范围**：仅 S57 接入层，还是含 AC6003 与核心交换机？
5. **定时备份默认窗口**（§3.6）：建议凌晨 02:00-05:00、按分组错峰（如 2F 02:00 / IDC 03:00），是否认可？
6. **失败通知渠道**：仅站内展示，还是接钉钉机器人/邮件推送？
7. **保留策略默认值**：每设备 30 份 + 每日末份永久保留（关），是否合适？
8. **多实例风险确认**：APScheduler 内存 jobstore 依赖 radius-admin 单 worker 部署（现状如此）；若未来多 worker 需改 DB 锁或独立调度进程，本期不做。
