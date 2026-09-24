# PRD：AI 网络排障助手（NetAssist）— 接入现有 admin-spa

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.0（草案，待审查） |
| 编写日期 | 2026-09-23 |
| 借鉴来源 | 《我把网络故障甩给 AI，Seed-2.1-pro-0915 看一眼拓扑图就自己修好了》（NetOps Agent 项目，GitHub: Leterhong/NetOps-Agent） |
| 落地位置 | 192.168.110.106 `/opt/radius-admin`（后端）+ `/admin-spa`（前端） |
| 定位 | AI 安全运维平台的**网络排障子系统先行落地**（复用现有交换机管理、vpn_probe、ELK/Prometheus 数据） |
| 交付模式 | 先设计后实施：本 PRD 审查通过后分 Phase 实施，逐项验证 |

---

## 1. 背景与目标

### 1.1 来源文章核心思想

来源项目 NetOps Agent 实现了「一张拓扑图 + 一句故障描述 → AI 自主取证、定位根因、提案修复、人工审批后执行、真实 Diff、自动再验证、一键出报告」的完整闭环。其最有价值的不是模型本身，而是**工程约束**：

> 模型负责理解与决策，工程负责不让它越界。

六条可迁移的设计原则：

1. **看→查→修→验 四步闭环**：每步都有明确的技术约束，不许跳步。
2. **工具注册表 + 权限硬声明**：写工具（`device_configure`）在模型侧**永久 DENIED**——不是靠提示词约束，是注册表权限声明 + 执行器硬拦截。模型任何状态下都拿不到写权限。
3. **证据全部落库**：每次工具调用记录时间戳/设备/命令/参数/真实回显/状态（PLANNED/RUNNING/SUCCESS/FAILED/TIMEOUT/DENIED）/尝试次数/耗时。
4. **只读模式的诚实**：诊断阶段直接声明 `verified=false`、业务未恢复、需要授权——不因为「看起来像」就宣布修好了。
5. **不许提前宣布完成**：修复后按故障签名跑验证矩阵（配置核查 + ping + 业务端口探测），验证结果回灌模型复核；二次失败强制 `verified=false` 并记幻觉标记。
6. **报告 = 证据快照**：报告全部章节由落库证据现算，不由模型自由撰写——「报告写得漂亮但和实际不符」从根上被禁止。

### 1.2 与现有系统的差距

| 现状 | 差距 |
|---|---|
| 交换机管理模块已有 SSH 凭据库、备份恢复、ACL 规则定义 + SSH 自动下发 | ACL 下发是「直接执行」，无提案-审批-Diff-回滚流程 |
| vpn_probe 已服务端采集 VPN 会话/流量证据 | 证据只在 MySQL 里，未进入任何排障决策链 |
| ELK（syslog-analysis-*）/ Prometheus / SNMP 已在采集 | 数据孤岛，人工排查时需要逐个系统查 |
| FreeRADIUS 三节点 + radwho/认证日志 | 跨系统故障（认证+网络+VPN）需人工关联 |
| AI 安全运维平台（0→1）规划中 | 缺一个可先行落地、风险可控的子场景 |

### 1.3 产品目标

1. 一句中文故障描述（如「研发部门无法访问 192.168.30.100，疑似跨交换机 VLAN 问题」）→ AI 在**授权设备范围内**自主调用只读工具取证 → 给出根因 + 证据链 + 置信度。
2. 修复类操作走**审批门**：模型只产提案（设备/风险等级/命令/理由/预测 Diff），人点「允许执行」才下发；执行前后自动快照、真实 Diff、自动回滚预案。
3. 全程证据落库、可审计、一键生成排障报告。
4. Phase 1 **纯只读**，对生产网零风险，可快速上线验证价值。

### 1.4 明确不做的（边界）

- ❌ 不做全自动修复（模型永不直接改配置，唯一例外见 5.6 审批门）。
- ❌ 不替代交换机备份管理系统（复用其凭据库与备份表）。
- ❌ 不做通用聊天机器人（只有工具化的排障任务）。
- ❌ Phase 1 不接 VLM 拓扑识别（放 Phase 3，先跑通文本闭环）。

---

## 2. 借鉴点映射表（文章能力 → 本系统落地）

| # | 文章能力 | 落地到本系统 | 优先级 |
|---|---|---|---|
| 1 | 工具注册表（description/schema/permission/timeout/retry，function calling 暴露） | 排障工具注册表，16 个工具，只读/写/验证三类，权限硬声明 | P0 |
| 2 | 12 态状态机（理解→规划→调用→分析→重规划→…→结论） | 12 态任务状态机 + 失败必须重规划 | P0 |
| 3 | 证据全部落库（Evidence 页纵向铺开） | `ai_tool_call` 表 + 前端证据链页 | P0 |
| 4 | 幻觉检测（无证据宣称恢复/失败宣称成功/引用未执行命令） | 三条规则的任务级红色告警 | P1 |
| 5 | 审批门（AWAITING_APPROVAL + 风险等级 + 预测 Diff + 允许/拒绝） | 改造现有 ACL 下发流程为提案-审批-执行 | P1 |
| 6 | before/after 快照 + sha256 + 真实 unified Diff | 复用 sw_backup 表，新增 `ai_change` 表 | P1 |
| 7 | 再验证矩阵（配置核查 + ping + 端口探测，回灌复核，二次失败强制 verified=false） | 按故障签名的验证矩阵 + 回灌复核 | P1 |
| 8 | 报告 = 证据快照（11 章现算，MD/DOCX/PDF 同源） | 排障报告一键生成（Markdown + HTML 先行） | P0 |
| 9 | 模型配置页（OpenAI Compatible、Fernet 加密、掩码、健康检查） | `ai_model_config` 表 + 设置页 | P0 |
| 10 | 只读守卫（devices 模块硬拦截） | 华为 VRP 只读命令白名单 + 二次校验 | P0 |
| 11 | VLM 拓扑识别（Schema 强制输出 + uncertainties 认输字段） | 网络资产管理增强（上传拓扑图→结构化资产） | P2 |
| 12 | 设计审查规则引擎（11 规则族 + AI 联合审查，无证据不许出结论） | 交换机/RADIUS 配置基线审查 | P2 |
| 13 | 有状态 Mock VRP 故障实验室 | 测试实验网演练（7 台设备 Mock 太重，先做 2 台） | P3 |
| 14 | 多模型同条件对比（客观指标、CSV 导出） | 模型选型依据 | P3 |
| 15 | 实测参数：超时 120s / 思考模式默认关 / 429 退避 6s 重试一次 / 接入点 ID≠模型 ID | LLM 客户端默认配置 | P0 |
| 16 | 演示模式（?present=1 隐藏管理元素） | admin-spa 汇报场景可选 | P3 |

---

## 3. 总体设计：看 → 查 → 修 → 验

```
┌─────────────────────────────────────────────────────────────────┐
│ admin-spa（Carbon 风格）                                          │
│  AI 排障任务页 │ 证据链页 │ 审批面板 │ Diff 视图 │ 模型配置页      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ REST + SSE（进度流）
┌──────────────────────────▼──────────────────────────────────────┐
│ FastAPI（/opt/radius-admin，新增 ai/ 模块）                       │
│  ┌────────────┐ ┌────────────┐ ┌───────────┐ ┌───────────────┐  │
│  │ 任务状态机  │ │ 工具注册表  │ │ 审批门     │ │ 报告生成器     │  │
│  │ (12 态)    │ │ (16 工具)  │ │ (写通道)  │ │ (证据快照式)  │  │
│  └─────┬──────┘ └─────┬──────┘ └─────┬─────┘ └───────┬───────┘  │
│        │              │              │               │          │
│  ┌─────▼──────────────▼──────────────▼───────────────▼───────┐  │
│  │ MySQL radius 库：ai_task / ai_tool_call / ai_change /       │  │
│  │ ai_verification / ai_model_config（复用 sw_*、vpn_* 表）    │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ 工具执行层（只读白名单 / 审批后写）
   ┌───────────┬───────────┼───────────┬─────────────┬───────────┐
   ▼           ▼           ▼           ▼             ▼           ▼
 华为设备    FreeRADIUS   vpn_probe   ELK          Prometheus   SNMP
 (SSH/VRP)  (radwho/     (MySQL)   (syslog-      (指标)      (远程卡
  只读白名单  认证日志)               analysis-*)               OID)
```

**四步闭环在本系统的落地：**

| 步骤 | 文章做法 | 本系统做法 |
|---|---|---|
| **看** | VLM 识图 → Schema JSON | Phase 1 用「设备范围选择器」替代识图：从交换机管理模块资产中勾选授权范围（Phase 3 再加 VLM 识拓扑图） |
| **查** | 18 工具只读取证 | 16 工具：display 命令族（白名单）+ ping/tracert + RADIUS/VPN/ELK/Prometheus 查询 |
| **修** | 提案 → 审批门 → 快照 → 下发 → Diff | 提案（复用现有 ACL 下发通道）→ 审批门 → `sw_backup` 快照 → 逐行下发 → difflib 真实 Diff → 回滚预案 |
| **验** | 验证矩阵 + 回灌复核 | 同款：配置核查 + ping + 端口探测，回灌模型复核，二次失败强制 `verified=false` |

---

## 4. 数据库设计（MySQL radius 库新增 5 表）

```sql
-- 1) 模型配置（密钥 Fernet 加密存储，前端只见掩码）
CREATE TABLE ai_model_config (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(64)  NOT NULL COMMENT '显示名',
  base_url      VARCHAR(255) NOT NULL COMMENT 'OpenAI Compatible Base URL',
  model_id      VARCHAR(128) NOT NULL COMMENT '接入点 ID（非模型直调 ID！）',
  api_key_enc   VARCHAR(512) NOT NULL COMMENT 'Fernet 加密后的 API Key',
  enabled       TINYINT DEFAULT 1,
  is_current    TINYINT DEFAULT 0 COMMENT '当前模型（全局唯一）',
  support_vision TINYINT DEFAULT 0,
  req_count     INT DEFAULT 0,  ok_count INT DEFAULT 0,
  avg_latency_ms INT DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2) 排障任务
CREATE TABLE ai_task (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  title         VARCHAR(200) NOT NULL,
  symptom       TEXT NOT NULL COMMENT '一句人话故障描述',
  scope_devices JSON COMMENT '授权设备范围（资产 ID 列表）',
  status        VARCHAR(32) NOT NULL COMMENT '12 态，见 5.4',
  root_cause    TEXT COMMENT '根因结论',
  confidence    INT COMMENT '0-100',
  proposed_fix  JSON COMMENT '修复提案 [{device,risk,commands,reason}]',
  verified      TINYINT COMMENT 'NULL=未涉及 / 0=未通过 / 1=通过',
  business_recovered TINYINT,
  hallucination_flags JSON COMMENT '命中的幻觉规则列表',
  token_in      INT DEFAULT 0,  token_out INT DEFAULT 0,
  tool_calls    INT DEFAULT 0,
  duration_sec  INT DEFAULT 0,
  created_by    VARCHAR(64),  approved_by VARCHAR(64),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at   DATETIME NULL
);

-- 3) 工具调用证据（核心审计表）
CREATE TABLE ai_tool_call (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  task_id       INT NOT NULL,
  seq           INT NOT NULL COMMENT '第几次调用',
  tool_name     VARCHAR(64) NOT NULL,
  params        JSON NOT NULL,
  device        VARCHAR(64) COMMENT '目标设备（如有）',
  status        VARCHAR(16) NOT NULL COMMENT 'PLANNED/RUNNING/SUCCESS/FAILED/TIMEOUT/DENIED',
  result        LONGTEXT COMMENT '真实回显（截断至 64KB）',
  attempts      INT DEFAULT 1,
  latency_ms    INT DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_task (task_id)
);

-- 4) 变更记录（审批门产物）
CREATE TABLE ai_change (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  task_id       INT NOT NULL,
  device        VARCHAR(64) NOT NULL,
  risk_level    VARCHAR(8) NOT NULL COMMENT 'low/medium/high',
  commands      JSON NOT NULL COMMENT '待下发 VRP 命令序列',
  reason        TEXT,
  predicted_diff TEXT COMMENT 'undo+新配置 生成的预测 Diff',
  before_snap_id INT COMMENT 'sw_backup 表 ID',
  after_snap_id  INT,
  real_diff     LONGTEXT COMMENT 'difflib unified diff',
  status        VARCHAR(16) COMMENT 'PENDING/APPROVED/DENIED/EXECUTED/ROLLED_BACK',
  approved_by   VARCHAR(64),  executed_at DATETIME NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5) 再验证矩阵
CREATE TABLE ai_verification (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  task_id       INT NOT NULL,
  change_id     INT,
  check_name    VARCHAR(128) NOT NULL,
  check_type    VARCHAR(32) COMMENT 'config/ping/port/custom',
  result        VARCHAR(8) COMMENT 'PASS/FAIL/SKIP',
  detail        TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 5. 功能需求详述

### 5.1 模型配置页（P0）

| 需求项 | 说明 |
|---|---|
| 多配置并存 | 支持 N 套 OpenAI Compatible 配置（火山方舟 / DeepSeek / Qwen / 本地 vLLM），全局唯一「当前模型」 |
| 密钥安全 | API Key 用 Fernet 加密落库（密钥经环境变量 `AI_MASTER_KEY` 注入，复用 sw-master.conf drop-in 模式）；前端/接口只回掩码 `sk-****abcd` |
| 健康检查 | 「测试连接」按钮：发一次最小 chat 请求，记录成功/失败/延迟，更新 `req_count/ok_count/avg_latency_ms` |
| 未配置守卫 | 无当前模型时创建排障任务直接返回 **409** 并引导去配置页（文章同款：不偷偷调默认模型） |
| 客户端默认参数 | **超时 120s**（默认 20s 会超时）、**429 时 6s 退避重试 1 次**、**扩展思考默认关**（需深度推理再开）、**Model ID 必须填接入点 ID**（表单 placeholder 明确提示，防 404） |

### 5.2 排障任务创建（P0）

- 输入：① 故障现象（中文一句话，必填）；② 授权设备范围（从交换机管理模块资产树勾选，必填，**默认只勾测试设备**）；③ 可选补充（时间范围、受影响用户/网段、截图说明）。
- 创建后任务进 `UNDERSTANDING` 态，通过 SSE 向前端推送状态机步进与工具调用实时流。
- 注入面板同款诚实原则：任务详情页明确显示「模型可见信息 / 不可见信息（如已知根因）」。

### 5.3 工具注册表（P0，核心）

每个工具带 `description / input_schema / output_schema / permission / timeout / retry`，按 OpenAI function calling 协议暴露。**权限在注册表硬声明 + 执行器二次校验**：

| # | 工具 | 类型 | permission | 说明 |
|---|---|---|---|---|
| 1 | `asset_query` | 只读 | ALLOWED | 查设备资产/接口/VLAN 台账（交换机管理模块数据） |
| 2 | `device_cli_read` | 只读 | ALLOWED | **白名单内** display 命令执行（见下） |
| 3 | `device_config_get` | 只读 | ALLOWED | 取设备当前配置（复用备份通道，含 sha256） |
| 4 | `interface_status` | 只读 | ALLOWED | display interface brief 解析为 JSON |
| 5 | `vlan_query` | 只读 | ALLOWED | display vlan / display port vlan |
| 6 | `arp_query` / `mac_query` | 只读 | ALLOWED | ARP / MAC 表 |
| 7 | `acl_query` | 只读 | ALLOWED | display acl all |
| 8 | `route_query` / `ospf_peer` | 只读 | ALLOWED | 路由表 / OSPF 邻居 |
| 9 | `ping_probe` | 只读 | ALLOWED | 从指定设备 ping（解析丢包率） |
| 10 | `tracert_probe` | 只读 | ALLOWED | tracert |
| 11 | `port_probe` | 只读 | ALLOWED | 业务端口探测（区分「ICMP 通但端口被 ACL 挡」） |
| 12 | `radius_radwho` | 只读 | ALLOWED | FreeRADIUS 在线用户（.200/.163/.229） |
| 13 | `radius_auth_log` | 只读 | ALLOWED | radpostauth 认证日志（用户/结果/时间） |
| 14 | `vpn_session_query` | 只读 | ALLOWED | vpn_probe 采集的会话/流量/上下线记录 |
| 15 | `elk_log_search` | 只读 | ALLOWED | ELK 查询 syslog-analysis-*（secure/messages/boot.log） |
| 16 | `device_config_write` | **写** | **DENIED（模型侧永久）** | 唯一写通道，仅审批后由执行器调用（见 5.6） |

**display 命令白名单（只读守卫，Phase 1 首版）：**

```
display version / display current-configuration / display vlan /
display port vlan / display interface brief / display interface <IF> /
display arp / display mac-address / display acl all /
display ip routing-table / display ospf peer / display stp brief /
display eth-trunk / display link-state / display transceiver
```

白名单外命令一律拒绝并返回 `DENIED + 原因`，同时落 `ai_tool_call`。禁止 `screen-length` 等交互命令（分页用 `screen-length 0 temporary` 由执行器自动前置）。

### 5.4 任务状态机（P0）

12 态，失败必须重规划（文章同款两条铁律）：

```
PENDING → UNDERSTANDING → PLANNING → TOOL_CALLING → ANALYZING
                ▲                                     │
                └──────── REPLAN（读错误→重新规划）◄──┘（确定性失败不重试；
                                              超时/传输错误按 retry 退避重试）
ANALYZING → ROOT_CAUSED ──(有修复提案)──► AWAITING_APPROVAL
                │                              │ approve            deny
                │(无需修复)                    ▼                    ▼
                │                        EXECUTING → VERIFYING   CLOSED
                ▼                            │         │
            COMPLETED ◄──(全部通过)──────────┘         │
                ▲                                   (二次失败)
                │(verified=false + 幻觉标记 + 自动 REPLAN 一次)──► FAILED
```

- 每次 REPLAN 在 `ai_tool_call` 落 `replan` 步骤记录，**不许假装拿到了结果**。
- 只读阶段的结论必须携带 `verified=false` + 「需授权执行修复」声明（只读模式的诚实）。
- 健康基线行为：若取证后未复现故障，如实输出「未复现，N 个假设全部排除」，不硬凑根因。

### 5.5 证据链展示页（P0）

- 按「故障现象 → 假设（H1/H2/…）→ 工具调用 → 设备真实返回 → 分析 → 结论」纵向 Timeline 铺开。
- 每个节点可展开看原始回显 JSON。
- 右侧常驻：Token 统计（输入/输出）、工具调用次数、耗时、状态机步进条。
- 数据全部来自 `ai_tool_call` 现查，无缓存无填充——**没数据就是真实的 0**。

### 5.6 审批门与变更管理（P1，改造现有 ACL 下发通道）

- 模型产出 `proposed_fix`：设备 / 风险等级（low/medium/high）/ VRP 命令序列 / 理由 / 预测 Diff（`undo + 新配置` 生成，界面标注「执行后以真实 Diff 为准」）。
- 任务转 `AWAITING_APPROVAL`，前端弹审批面板（风险色块 + 命令 + 预测 Diff + 允许/拒绝按钮）。
- 点「允许执行」后的**固定顺序**：
  1. `display current-configuration` 生成 before 快照（全文 + sha256，存 `sw_backup`）；
  2. 经设备适配器 `system-view` 逐行下发（**不自动 save**，报告风险提示中写明）；
  3. 再抓 after 快照；
  4. `difflib` 生成真实 unified Diff 落 `ai_change.real_diff`；
  5. 预置回滚命令（reverse of undo）待命，再验证失败可一键回滚。
- 审计：`approved_by / executed_at` 强制记录；高危命令（interface shutdown / undo 操作 / ACL 变更）额外标红，需二次确认。

### 5.7 再验证矩阵（P1）

- 按故障签名（trunk / vlan / acl / route / auth / vpn）预置 2~4 项检查：配置核查（display 解析比对）+ ping + 端口探测。
- 全部通过才允许输出 `COMPLETED · verified=true · business_recovered=true`。
- **回灌复核**：真实 Diff + 验证结果回灌模型复核；任一失败或业务 ping 不通 → 结论只能是「配置已修改但业务未恢复」→ 自动 REPLAN 一次 → 二次仍失败强制 `verified=false` + 幻觉标记。

### 5.8 幻觉检测（P1，三条规则）

| 规则 | 判定 | 处置 |
|---|---|---|
| H1 无连通性证据宣称恢复 | 结论含「已恢复/已通」但证据链无 PASS 的 ping/port_probe | 任务页+证据页红色告警 |
| H2 工具失败宣称成功 | 结论引用了 status≠SUCCESS 的调用结果 | 同上 |
| H3 引用未执行的命令 | 结论中的命令在 ai_tool_call 无 SUCCESS 记录 | 同上 |

命中即写 `ai_task.hallucination_flags`，任务列表打红色「幻觉」标记。

### 5.9 排障报告生成（P0，Phase 1 只读版即可用）

- 一键生成《网络故障处理报告》，**全部章节由落库证据现算**（任务信息/现象/范围/证据链/根因/提案/变更 Diff/再验证/结论/风险提示/附录 Token 统计）。
- 格式：Markdown + HTML（打印友好）先行；DOCX/PDF 后续按需。
- 命名：`网络故障处理报告-任务{id}-{yyyyMMdd-HHmm}.md`，存 `/opt/radius-admin/reports/` 并提供下载。

### 5.10 VLM 拓扑识别（P2）

- 上传拓扑图 → 强制 Schema 输出 JSON（devices/connections/vlans/ip_addresses/routing/observations/**uncertainties**）。
- 三条硬规则：认不出的一律进 `uncertainties` **禁止猜测补全**；链路两端设备名必须与 devices 完全一致；低置信度设备自动追加不确定项。
- 识别结果归一化落到可交互拓扑画布（终端→接入→核心→路由分层，链路按 Trunk/Access/LACP/路由着色），与资产库比对合并。

### 5.11 配置设计审查（P2）

- 规则引擎先行（确定性）：VLAN/Trunk 配对、IP 冲突、ACL 空洞（如 `rule permit any any` 后续永不命中）、OSPF 邻居不对称、备份缺失。
- AI 联合审查可选叠加，**每条结论必须带等级/位置/证据引文/影响/整改建议**，无证据结论直接丢弃。
- 健康基线自测：对已知健康设备跑一遍应 0 误报。

### 5.12 故障实验室（P3，可选）

- 2 台华为 VRP Mock 设备（有状态：配置变更联动连通性/ARP/MAC/阻断流），预置 Case 库（Trunk 未放行 VLAN / ACL 误拦 / 端口 VLAN 错配 / RADIUS 密钥不一致）。
- 用途：新模型/新工具上线前演练 + 多模型对比基准。

---

## 6. API 设计（FastAPI，前缀 `/api/ai`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PUT/DELETE | `/models` `/models/{id}` | 模型配置 CRUD（密钥只写不读） |
| POST | `/models/{id}/test` | 连通测试（最小 chat 请求） |
| POST | `/models/{id}/activate` | 设为当前模型 |
| POST | `/tasks` | 创建排障任务（symptom + scope_devices） |
| GET | `/tasks` `/tasks/{id}` | 列表 / 详情（含状态机与统计） |
| GET | `/tasks/{id}/events` | SSE 实时进度流（状态机步进 + 工具调用） |
| GET | `/tasks/{id}/evidence` | 证据链（ai_tool_call 全量） |
| POST | `/tasks/{id}/approve` `/{id}/deny` | 审批门操作（记录 approved_by） |
| POST | `/tasks/{id}/rollback` | 一键回滚（reverse undo） |
| POST | `/tasks/{id}/report` | 生成报告（返回下载路径） |
| GET | `/tools` | 工具注册表清单（含 permission，供前端展示） |

权限：沿用现有 admin-spa 登录态；审批操作要求 `admin` 角色。

---

## 7. 前端页面（admin-spa 新增，严格 Carbon 风格）

| 页面 | 路由 | 内容 |
|---|---|---|
| AI 排障 | `/ai-tasks` | 任务列表（状态徽章/幻觉标记/耗时/Token）+ 新建任务抽屉（现象输入 + 设备范围树） |
| 任务详情 | `/ai-tasks/:id` | 状态机步进条 + Timeline 证据链（节点展开原始回显）+ 假设卡片 + Token 统计侧栏 |
| 审批面板 | 任务详情内嵌 | AWAITING_APPROVAL 时弹出：风险色块 + 命令列表 + 预测/真实 Diff（+绿/−红）+ 允许/拒绝 |
| 验证清单 | 任务详情内嵌 | 再验证矩阵逐项 PASS/FAIL + 业务恢复结论条 |
| 模型配置 | `/ai-models` | 配置卡片列表（掩码密钥/成功率和延迟/当前模型标记）+ 新建表单 |
| 报告预览 | 任务详情内嵌 | Markdown 渲染 + 下载（.md/.html） |

交互细节：SSE 步进实时刷新；Diff 视图等宽字体（IBM Plex Mono）；DENIED 工具在证据链显示灰色锁形图标。

---

## 8. 安全设计汇总

| 层 | 措施 |
|---|---|
| 模型 | 写工具注册表 permission=DENIED 硬声明，不进 function 列表 |
| 执行器 | 写操作前二次校验「任务状态=APPROVED 且 change 记录存在」，否则拒绝并告警 |
| 设备 | 只读命令白名单 + screen-length 前置 + 逐命令超时 + 凭据来自 sw 凭据库（不落日志） |
| 变更 | before/after 快照 + sha256 + 真实 Diff + 回滚命令预置 + 不自动 save |
| 密钥 | API Key Fernet 加密（`AI_MASTER_KEY` 走 systemd drop-in，同 SW_MASTER_KEY 模式） |
| 审计 | ai_tool_call / ai_change / ai_verification 全量落库，审批人不可抵赖 |
| 范围 | 任务级设备白名单（scope_devices），工具调用越界直接 DENIED |

---

## 9. 分期交付计划

| Phase | 范围 | 验收标准 |
|---|---|---|
| **P1 只读闭环** | 模型配置页 + 工具注册表（15 只读）+ 12 态状态机 + 证据链页 + 任务页 + 报告（只读版） | 在**测试交换机**上完成一次真实只读排障：根因结论带证据链与置信度，全程工具调用落库，一键出报告；未配置模型返回 409 |
| **P2 修复闭环** | 审批门 + device_config_write 通道 + 快照/Diff/回滚 + 再验证矩阵 + 幻觉检测 + ACL 下发流程改造 | 测试网注入 Case（如 Trunk 未放行 VLAN）→ 提案 → 审批 → 真实 Diff → 3 项验证全过 → verified=true；拒绝路径与回滚路径各演练一次 |
| **P3 智能增强** | VLM 拓扑识别（Schema+uncertainties）+ 配置审查规则引擎 + 演示模式 | 上传拓扑图识别设备/链路/VLAN 且不确定项如实列出；健康基线审查 0 误报 |
| **P4 实验室（可选）** | 有状态 Mock VRP ×2 + Case 库 + 多模型对比 | 新模型上线前演练通过；对比报告 CSV 导出 |

每个 Phase 按「实现 → 后端自测（py_compile + 接口冒烟）→ 前端构建 → 106 部署 → 端到端验证」五步走完才进下一个（对齐现有 SOP）。

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 超时（视觉长 JSON/多轮调用） | 客户端默认超时 120s；SSE 心跳防前端断连 |
| 429 突发限流 | 6s 退避重试 1 次，超过则任务 FAILED 可续跑 |
| 成本失控 | 任务级 Token 统计落库 + 列表页汇总；工具结果截断（64KB）控制上下文 |
| 生产设备误操作 | Phase 1 纯只读；P2 起默认 scope 仅测试设备；审批门 + 回滚 + 不自动 save |
| 模型幻觉 | 三规则检测 + verified 强制门 + 证据快照式报告 |
| 接入点 ID 填错（404） | 表单提示 + 连通测试前置 |
| display 回显分页截断 | screen-length 0 temporary 由执行器自动前置 |

---

## 11. 与现有模块的关系

| 现有模块 | 关系 |
|---|---|
| 交换机管理（sw_*） | 复用资产/凭据/备份表；ACL 下发通道升级为审批门流程 |
| vpn_probe | `vpn_session_query` 工具直接查其产出（会话/流量/上下线） |
| ELK / Prometheus / SNMP | 作为只读工具接入，证据自动进排障链 |
| FreeRADIUS 三节点 | radwho + radpostauth 工具，认证类故障可跨系统关联 |
| AI 安全运维平台（0→1 规划） | 本模块 = 平台的网络排障子系统，表结构/工具注册表可直接复用扩展 |

---

## 12. 待确认决策点

1. **模型选型**：火山方舟（Seed 系列）/ DeepSeek / Qwen / 本地 vLLM，先接哪家？（建议：先接一家 OpenAI Compatible 验证闭环，配置页本身支持随时切换）
2. **P2 审批角色**：仅 admin 可审批，还是增加「网络管理员」角色？
3. **测试设备范围**：Phase 1 授权哪些设备做真实只读排障演练？（建议：测试交换机 + 一台 FreeRADIUS 节点）
4. **报告格式**：MD + HTML 是否满足，还是需要 DOCX/PDF？
5. **是否需要演示模式**（?present=1）用于汇报场景？

---

*审查通过后按 Phase 1 开始实施；实施期间本 PRD 与 docs/ 同步维护。*
