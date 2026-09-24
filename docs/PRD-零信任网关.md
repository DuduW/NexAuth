# 轻量自研零信任网关 — PRD（方案 1）

| 文档信息 | |
|---|---|
| 版本 | v1.4 |
| 日期 | 2026-08-14 |
| 作者 | 齐活林（交付总监） |
| 状态 | **核心链路已跑通** |
| 关联项目 | D:\radius（FreeRADIUS + NetAgent + WireGuard + Headscale） |

---

## 1. 项目背景

### 1.1 现状

| 组件 | 状态 | 端口 | 说明 |
|------|------|------|------|
| FreeRADIUS | ✅ | 1812/1813 | 用户认证，radcheck + radtotp |
| MariaDB | ✅ | 3306 | radius 库 + zt_* 策略表 |
| WireGuard | ✅ | UDP 8001 | 传统 VPN（保留共存），10.99.0.0/24 |
| NetAgent 客户端 | ✅ | - | Wails + React，三卡并列 UI |
| Nginx | ✅ | 80/443 | 反向代理 |
| FastAPI | ✅ | 8000 | radius-admin 管理 API |
| **Headscale** | ✅ | **8081** | **零信任控制面**，节点注册 + ACL 策略下发 |
| **Tailscale** | ✅ | **41641** | **零信任数据面**，WireGuard 加密隧道 |
| **zt_* 表** | ✅ | - | zt_user_group / zt_acl_rule / zt_access_log |

### 1.2 目标

在现有 WireGuard 基础上增加 Headscale + Tailscale 零信任 Mesh 层，实现：

1. **精准授权**：基于用户/分组的域名级 ACL
2. **最小权限**：默认拒绝，显式授权
3. **全链路审计**：每次访问记录到 zt_access_log
4. **与 WireGuard 共存**：端口分离，两套网络并行

---

## 2. 架构

```
                     公网
         ┌───────────┼───────────┐
         ▼           ▼           ▼
    Nginx :80    WireGuard  Headscale  ← 新增 ✅
    (Web入口)     (传统VPN)   (零信任Mesh)
         │         :8001        :8081
         │           │           │
         │     ┌─────┴─────┐    │
         │     │           │    │
         │   Tailscale   Tailscale  ← 客户端/服务器
         │   (客户端)    (服务器)
         │     │           │
         ▼     ▼           ▼
  ┌────────────────────────────────────┐
  │ 双网卡并存                          │
  │                                    │
  │  WireGuard: 10.99.0.x/24 (传统VPN)   │
  │  Tailscale: 100.64.0.x/10 (零信任)   │
  │                                    │
  │  内网资源: 172.18.0.0/24            │
  └────────────────────────────────────┘
```

### 2.1 双层校验

| 层 | 位置 | 职责 | 状态 |
|---|------|------|------|
| 网络层 | WireGuard AllowedIPs | 决定哪些 IP 段走隧道 | ✅ |
| 应用层 | Headscale ACL + zt_acl_rule | 隧道内域名/端口鉴权 | ⏳ 待同步 |

---

## 2A. 零信任架构详解（核心概念）

> 本节用通俗语言解释零信任，是理解整套系统的关键。

### 2A.1 一句话理解：传统 VPN vs 零信任

```
传统 VPN（WireGuard）：
  用户拨入 → 隧道打通 → 就能访问"整个内网"
  问题：连上 = 全通，权限太粗，内网被打通后风险大

零信任（Headscale + Tailscale）：
  用户设备注册进 Mesh → 隧道打通 → 但"每次访问"都要过 ACL 鉴权
  原则：默认拒绝，只有 ACL 明确允许的才放行
  粒度：精确到「哪个组的人 → 访问哪个域名/IP/端口」
```

核心区别：**VPN 解决"连不连得上"，零信任解决"连上之后能不能访问这个资源"。** 两者共存互补。

#### 主要区别对照表（结合本项目实际）

| 维度 | 本项目 WireGuard VPN | 本项目 Tailscale 零信任 |
|------|---------------------|------------------------|
| **信任模型** | 连上 = 信任（城堡+护城河） | 默认不信任，每次访问都验证 |
| **权限粒度** | 网段级：AllowedIPs 允许 `172.18.0.0/24`，进去后全通 | 资源级：ACL 精确到 `IP:端口` |
| **拓扑** | 星型，所有客户端连到 VPN 服务器 | Mesh，设备之间点对点直连 |
| **接入方式** | 手动拨入 + 手动配密钥 | 注册一次，密钥自动协商 |
| **判定位置** | 服务器侧（进了隧道就放行） | 设备本机（每次访问查 ACL） |
| **网段** | wg0 接口 `10.99.0.0/24` | tailscale0 接口 `100.64.0.0/10` |

#### 三个最直观的体感区别

1. **粗 vs 细**：VPN 拨入后 `172.18.0.0/24` 整个网段随你访问；零信任里只被授权了 greatld 那几个 IP，`ping 100.64.0.1` 这种未授权的直接不通。
2. **全通 vs 默认拒**：VPN 连上后内网是「敞开的」；零信任是「关着的」——policy 里 `acls: []` 就是全拒，加一条规则才开一扇门。
3. **连上 ≠ 能用**：零信任里，设备接入（拿到 100.64.0.x）只是「进了园区」，能不能进某个房间还要看 ACL 授权，两步分离。VPN 里这两步是绑死的。

#### 一句话比喻

- **VPN** = 公司大门刷卡：进大门后，整栋楼随便逛。
- **零信任** = 每个房间单独刷卡：进了大门，还得有对应房间的门禁卡才能进那个房间。

所以两者在项目里**并存**：VPN 是「远程连回内网」的通道，零信任是「内网里精细控权」的层，解决不同层面的问题，互补而非替代。

### 2A.2 控制面 vs 数据面（关键区分）

零信任网络拆成两个平面，职责完全分离：

| 平面 | 组件 | 类比 | 职责 |
|------|------|------|------|
| **控制面** | Headscale (:8081) | 保安队长 | 节点注册/认证、分配 Mesh IP、**下发 ACL 策略**、协调谁跟谁组网 |
| **数据面** | Tailscale (:41641) | 快递员 | 设备之间实际传数据，底层用 WireGuard 加密隧道 |

```
        ┌────────────────────────────────┐
        │   Headscale（控制面）:8081      │
        │   ① 设备注册 → 发身份           │
        │   ② 分配 Mesh IP (100.64.x)    │
        │   ③ 下发 ACL 策略               │
        └──────────┬─────────────────────┘
                   │ 控制指令
        ┌──────────┴──────────┐
        ▼                     ▼
   Tailscale A            Tailscale B
   (员工设备)             (内网网关)
   100.64.0.5            100.64.0.1
        └──────── 点对点 WireGuard 隧道 ────────┘
                  （数据面，不经过 Headscale）
```

**重点**：数据面是**点对点直连**的——A 访问 B 时，数据直接在 A↔B 之间加密传输，**不经过 Headscale 服务器**。Headscale 只负责"告诉 A 和 B 对方的地址、密钥、以及 ACL 规则"，然后 A/B 自己建立加密隧道。这就是"零信任"的精髓：控制面和数据面分离，服务器不接触业务数据。

### 2A.3 ACL 策略如何生效（完整链路）

```
① 管理员在后台配置规则
   （组 "ops" → 允许访问 172.18.0.0/24、*.corp.com:443）
        ↓ 存到 MySQL
② zt_acl_rule 表（组→访问规则）
        ↓ 同步脚本（待实现）
③ 生成 Headscale ACL JSON
   （Tailscale 官方 policy 语法）
        ↓ headscale policy set
④ Headscale 把策略下发给每个 Tailscale 节点
        ↓
⑤ 节点执行：用户访问目标时，本机 Tailscale 检查 ACL
   - 允许 → 放行，写 zt_access_log(action=allow)
   - 拒绝 → 拦截，写 zt_access_log(action=deny)
```

**注意**：第 ②→④ 步的「ACL 同步脚本」当前**尚未实现**（见第 9 章）。目前 zt_acl_rule 表只是规则存储，还没打通到 Headscale 执行层。这是下一步工作的重点。

### 2A.4 三层数据模型（核心）

零信任的授权逻辑是「人 → 组 → 规则」两级映射：

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  用户(User)  │────▶│  分组(Group)      │────▶│  ACL 规则(Rule)  │
│  double      │     │  ops / staff /    │     │  允许访问的       │
│  wangchong   │     │  guest / admin    │     │  域名/CIDR/端口   │
└─────────────┘     └──────────────────┘     └─────────────────┘
     │ 属于               │ 分组名就是           │ 规则挂载在组上
     │                    │ 权限的载体           │
     ▼                    ▼                     ▼
  radusergroup         radusergroup          zt_acl_rule 表
  (用户组管理)         (分组列表)            (组→访问规则)
```

| 层 | 存储 | 说明 |
|----|------|------|
| 用户→组 | `radusergroup` | **复用用户组管理**（2026-08-14 改造），不再是独立 zt_user_group |
| 组→规则 | `zt_acl_rule` | 一个组可挂多条规则（域名/CIDR/端口，priority 决定优先级） |
| 访问审计 | `zt_access_log` | 每次 allow/deny 决策记录 username + target + action |

**关键设计**：`radusergroup` 里的分组名（如 `ops`、`staff`）就是零信任 ACL 里 `group_name` 的取值——**分组名是连接用户和 ACL 规则的桥梁**。所以「用户组管理」和「零信任分组」现在是同一份数据，改任何一边另一边同步生效。

### 2A.5 一次访问的完整判定流程（举例）

> 场景：员工 double（属于 ops 组）访问内网系统 `gitlab.corp.com`

```
double 设备 (Tailscale 100.64.0.5)
   │ 请求 gitlab.corp.com:443
   ▼
Tailscale 本机 ACL 引擎
   │ 查：double 属于哪些组？ → radusergroup → [ops]
   │ 查：ops 组的规则？ → zt_acl_rule → 允许 *.corp.com:443
   ▼
命中允许规则 → 建立到 100.64.0.1 的加密隧道 → 转发到内网
   │
   ▼
写审计：zt_access_log(username=double, target=gitlab.corp.com, action=allow)

反之，若 double 访问一个 ACL 没允许的资源 → action=deny，被拦截
```

这就是「默认拒绝、显式授权、全程审计」的完整闭环。

---

---

## 3. 技术栈

### 3.1 开发语言

| 场景 | 规范 | 框架 |
|------|------|------|
| **API 接口** | Python3 | **FastAPI** |
| **前端页面** | TypeScript + React | **Vite** |
| **客户端** | Go + React | **Wails** |
| **数据库** | MariaDB | SQL |
| **控制面** | Headscale v0.29.3 | Go 原生二进制 |

### 3.2 代码位置

| 代码 | 路径 | 访问地址 |
|------|------|---------|
| 管理 API | `src/backend/routers/zt.py` | `http://192.168.110.106/api/zt/*` |
| 管理后台 | `src/frontend/` | `http://192.168.110.106/admin-spa/` |
| Headscale 配置 | `/etc/headscale/config.yaml` | `127.0.0.1:8081` |
| Headscale 数据库 | `/var/lib/headscale/db.sqlite` | - |
| Tailscale 状态 | `/var/lib/tailscale/` | - |

---

## 4. Headscale + Tailscale 角色

### 4.1 Headscale（控制面）

```
            ┌─────────────────────────┐
            │       Headscale :8081    │
            │  - 节点注册/认证          │
            │  - Mesh IP 分配          │
            │  - ACL 策略下发           │
            │  - 协调 Mesh 组网         │
            └──────────┬──────────────┘
                       │
         ┌─────────────┼─────────────┐
         ▼             ▼             ▼
     Tailscale     Tailscale     Tailscale
     (客户端A)     (服务器)      (客户端B)
     100.64.0.x    100.64.0.1    100.64.0.y
```

### 4.2 Tailscale（数据面）

| 节点 | IP | 角色 |
|------|------|------|
| Tailscale (服务器) | `100.64.0.1` | 内网网关，访问 IDC 资源 |
| Tailscale (客户端) | `100.64.0.x` | 员工设备，Mesh 组成员 |

底层使用 WireGuard 加密隧道，但由 Headscale 自动管理密钥和路由。

### 4.3 端口规划

| 端口 | 服务 | 公网 | 状态 |
|------|------|------|------|
| 80/443 | Nginx | ✅ | 已有 |
| 8001 | WireGuard VPN | ✅ | 已有 |
| **8081** | **Headscale API** | ✅ | **新增** |
| **41641** | **Tailscale DERP** | ✅ | **新增** |
| **3478** | **STUN** | ✅ | **新增** |
| 1812/1813 | FreeRADIUS | ❌ | 已有 |
| 3306 | MariaDB | ❌ | 已有 |

---

## 5. 数据库设计

### 5.1 用户-分组映射（复用 radusergroup）

> ⚠️ **2026-08-14 改造**：零信任分组不再用独立的 `zt_user_group` 表，改为**复用用户组管理（radusergroup）**。分组名就是用户组名，零信任 ACL 的 `group_name` 直接引用它。

**当前使用的表 `radusergroup`**（FreeRADIUS 标准表，用户组管理共用）：

```sql
CREATE TABLE radusergroup (
    id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username   VARCHAR(64) NOT NULL,   -- FreeRADIUS 用户名
    groupname  VARCHAR(64) NOT NULL,   -- 分组名（= 零信任 group_name）
    priority   INT NOT NULL DEFAULT 1,
    KEY username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

语义说明：
- **一个用户可属多个组**（username 无唯一键，靠 priority 区分）——这是 RADIUS 标准语义
- 零信任接口 `/zt/groups` 的 GET/POST/DELETE 直接操作此表
- 过滤规则：`groupname NOT LIKE 'disabled%'` 且 `!= 'daloRADIUS-Dynamic-Fallback'`

> 原独立表 `zt_user_group`（UNIQUE username，一用户一组）已废弃，数据已迁移至 radusergroup。

### 5.2 zt_acl_rule（ACL 规则 → Headscale ACL JSON）

```sql
CREATE TABLE zt_acl_rule (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    group_name      VARCHAR(64) NOT NULL,
    rule_name       VARCHAR(128) NOT NULL,
    allow_domains   TEXT COMMENT '允许域名',
    allow_cidrs     TEXT COMMENT '允许 IP/CIDR',
    allow_ports     VARCHAR(256) COMMENT '允许端口',
    priority        INT DEFAULT 100,
    valid_from      DATETIME,
    valid_until     DATETIME,
    status          TINYINT DEFAULT 1,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 5.3 zt_access_log（审计日志）

```sql
CREATE TABLE zt_access_log (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    username    VARCHAR(64) NOT NULL,
    group_name  VARCHAR(64),
    src_ip      VARCHAR(45),
    target      VARCHAR(256),
    action      ENUM('allow','deny') NOT NULL,
    reason      VARCHAR(256),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_user (username),
    KEY idx_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 5.4 当前数据

**radusergroup（分组 = 用户组）:** `double → admin`、`double → ops`、`wangchong → admin`、`xuyj → group-guest` 等

**zt_acl_rule:** 待配置

**zt_access_log:** 待接入

---

## 6. 管理后台

> URL: `http://192.168.110.106/admin-spa/`

### 6.1 首页仪表盘

准入 + VPN + **零信任**（分组用户 / ACL 规则 / Mesh 网段）

### 6.2 零信任菜单（3 页）

| 页面 | 路由 | 功能 | 状态 |
|------|------|------|------|
| 分组管理 | `/admin-spa/zt-groups` | 用户分配（下拉+筛选）、分组列表含用户数；**分组在「用户组管理」中创建/删除** | ✅ |
| ACL 规则 | `/admin-spa/zt-acl` | 域名/IP/端口/优先级 CRUD | ✅ |
| 审计日志 | `/admin-spa/zt-log` | 按用户/动作检索，分页 | ✅ |

> 分组管理与「用户管理 → 用户组管理」共享 radusergroup，两边数据一致。

### 6.3 服务器状态

服务状态面板已包含 Headscale (:8081) + Tailscale (:41641)

---

## 7. 客户端

> 桌面: `C:\Users\double\Desktop\NetAgent.exe`

### 7.1 当前已实施

| 准入 NAC | 零信任接入 | VPN 隧道 |
|-----------|-----------|----------|
| ✅ 已认证/拨入 | ✅ UI 占位 | ✅ 连接/断开 |
| 蓝色卡片 | 紫色卡片 | 绿色卡片 |

### 7.2 待对接

| 环节 | 说明 |
|------|------|
| `handleZtAccess` → `tailscale up` | 按钮点击 → 执行 tailscale 注册 |
| Headscale preauth KEY | Go backend 调用 Headscale API 获取预授权 KEY |
| Mesh 状态回调 | `tailscale status` → 更新 UI（未接入/已接入） |
| ACL 策略同步 | `zt_acl_rule` → `headscale policy set` |

---

## 8. 实施状态

| 阶段 | 内容 | 状态 |
|------|------|------|
| Headscale 部署 | 二进制 + 配置 + systemd + TLS 证书 | ✅ |
| Tailscale 服务器节点 | 注册到 Headscale，100.64.0.1 | ✅ |
| Tailscale 客户端节点 | Windows 客户端接入（tailscale up + 预授权 key） | ✅ |
| Subnet router | 服务器通告 172.18.0.0/16 + 192.168.0.0/16 | ✅ |
| DB 建表 | zt_acl_rule / zt_access_log（分组复用 radusergroup） | ✅ |
| FastAPI zt.py | CRUD + dashboard + devices + access + log 查询 | ✅ |
| 管理前端 | ZtDevices / ZtGroups / ZtAcl / ZtLog + 首页统计 | ✅ |
| Headscale ↔ 客户端对接 | Go backend 调 /zt/access 拿 key + tailscale up | ✅ |
| ACL 策略同步 | zt_acl_rule → Headscale ACL JSON（cron 60s，域名自动解析成 IP） | ✅ |
| 审计日志写入 | 服务端 conntrack 采集 100.64.0.x 流量写 zt_access_log（仅 allow） | ✅ |

> ⚠️ 已知限制：
> ① **域名 ACL 需转成 IP/CIDR**——Tailscale ACL 不支持域名通配符（`*.greatld.com` 无法下发），同步时域名解析成 IP 映射；通配符子域名需用 CIDR 覆盖网段。
> ② **审计日志仅记录 allow，不记录 deny（已确认接受现状）**——原因：Tailscale ACL 判定在客户端本机，被拒绝的流量在本机就被丢弃、永不到达服务器，服务端 conntrack 观察不到 deny。记录 deny 需 Tailscale 商业版 netlog（付费 + 数据出域），Headscale 开源版无此能力。决策：只记录「成功访问」（allow），满足访问审计主需求；deny 通过 ACL 规则本身反推，不实时记录。

---

## 9. ACL 策略同步（已实现）

脚本 `/opt/zt_acl_sync.py`，cron 每 60 秒执行：

```
Admin 修改 zt_acl_rule 表
  → 同步脚本（Python，cron 60s）
  → 读 radusergroup（用户→组）+ zt_acl_rule（组→规则）
  → 同步 FreeRADIUS 用户 → Headscale user（<用户名>@qcc.com）
  → 域名 allow_domains 自动解析成 IP（去掉 *. 前缀，DNS 解析主域名）
  → 生成 Tailscale v2 ACL policy（HuJSON）
  → headscale policy set（policy.mode = database）
  → Tailscale 客户端即时生效
```

**关键约束**：
- Tailscale/Headscale 的 ACL 是 IP/CIDR 级，**不支持域名通配符**（`*.greatld.com` 无法直接下发）
- 域名会解析成 IP 后映射；但通配符子域名（`api.xxx.com`）解析不到，需改用 CIDR 覆盖网段
- Headscale user 名用 email 格式（v2 policy 要求 groups 成员含 @）

**Subnet router**（域名→内网 IP 访问的前提）：
- 服务器 `tailscale up --advertise-routes=172.18.0.0/16,192.168.0.0/16`
- `headscale nodes approve-routes --identifier 1 --routes ...` 批准

---

## 10. 运维

| 操作 | 命令 |
|------|------|
| 查看 Headscale 状态 | `systemctl status headscale` |
| 查看 Tailscale 状态 | `tailscale status` |
| 查看节点列表 | `headscale nodes list` |
| 创建预授权 KEY | `headscale preauthkeys create --user 1 --reusable --expiration 87600h` |
| 查看 ACL 策略 | `headscale policy get` |
| 设置 ACL 策略 | `headscale policy set /path/to/acl.json` |
