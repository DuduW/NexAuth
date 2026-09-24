# 开源 RADIUS 方案选型推荐

## 适配华为 AC / 交换机 802.1X · Portal · WLAN 认证

> **选型目标**：在华为园区网络场景下（802.1X 有线准入 + WLAN 无线认证 + Portal 访客认证），从功能覆盖、华为兼容性、运维成本、生态成熟度四个维度综合评价开源 RADIUS 方案。

---

## 一、方案全景对比

### 1.1 候选方案总览

| 方案 | 语言 | 许可证 | 定位 | 活跃度 |
|------|------|--------|------|--------|
| **FreeRADIUS** | C | GPLv2 | 通用 AAA 引擎 | ★★★★★ 极活跃 |
| **ToughRADIUS** | Go | AGPLv3 | 现代 RADIUS + 计费 + Portal | ★★★★ 活跃 |
| **PacketFence** | Perl/Go | GPLv2 | 完整 NAC 准入控制平台 | ★★★★ 活跃 |
| **CoovaChilli** | C | GPLv2 | Captive Portal 接入控制器 | ★★★ 维护中 |
| **OpenPortal** | Java | 开源 | 华为 Portal 协议服务端 | ★ 低 |
| **tac_plus** | C | 自定 | TACACS+ 设备管理认证 | ★ 低 |

### 1.2 核心能力矩阵

| 能力维度 | FreeRADIUS | ToughRADIUS | PacketFence | CoovaChilli |
|----------|:----------:|:-----------:|:-----------:|:-----------:|
| **RADIUS Auth (PAP/CHAP)** | ✅ | ✅ | ✅ | ✅ (client) |
| **EAP-PEAP (MSCHAPv2)** | ✅ | ✅ | ✅ | ❌ |
| **EAP-TLS (证书认证)** | ✅ | ✅ | ✅ | ❌ |
| **EAP-TTLS** | ✅ | ✅ | ✅ | ❌ |
| **802.1X 有线** | ✅ | ✅ | ✅ | ❌ |
| **802.1X 无线 (WPA2/3-Enterprise)** | ✅ | ✅ | ✅ | ❌ |
| **动态 VLAN 下发** | ✅ | ✅ | ✅ | ✅ |
| **CoA / DM (强制下线)** | ✅ | ✅ | ✅ | ✅ |
| **MAC 旁路认证 (MAB)** | ✅ | ✅ | ✅ | ✅ |
| **Portal 认证** | ⚠️ 需外挂 | ✅ 内置 | ✅ 内置 | ✅ 内置 |
| **华为 Portal 协议** | ⚠️ 需 OpenPortal | ❌ | ❌ | ❌ |
| **计费 / 流量统计** | ✅ | ✅ | ✅ | ✅ |
| **Web 管理界面** | ⚠️ daloRADIUS | ✅ 内置 React | ✅ 内置 | ❌ |
| **REST API** | ❌ | ✅ | ✅ | ✅ |
| **LDAP/AD 集成** | ✅ | ✅ | ✅ | ❌ |
| **SQL 后端** | ✅ MySQL/PG | ✅ PG/SQLite | ✅ MySQL/PG | ❌ |
| **RadSec (RADIUS over TLS)** | ✅ | ✅ | ❌ | ❌ |
| **华为 VSA 属性** | ✅ | ✅ | ✅ | ❌ |
| **设备 Profiling** | ❌ | ❌ | ✅ | ❌ |
| **策略引擎** | ⚠️ unlang | ❌ | ✅ | ❌ |
| **高可用** | ✅ 代理链 | ✅ 集群 | ✅ | ❌ |
| **Docker 部署** | ✅ 官方镜像 | ✅ | ✅ | ✅ |

---

## 二、逐方案详评

### 2.1 FreeRADIUS — 首选推荐 ★★★★★

**一句话定位**：全球部署最广的开源 RADIUS 服务器，华为设备兼容性最好，社区资料最丰富。

#### 优势

| 维度 | 说明 |
|------|------|
| **华为兼容性** | 华为官方文档中的 RADIUS 对接示例均基于 FreeRADIUS；华为交换机 / AC 的所有 RADIUS 属性（VSA、Tunnel、Filter-ID、HW-Input-Committed-Information-Rate 等）全部原生支持 |
| **EAP 认证** | 内置完整的 EAP 协议栈：PEAP、EAP-TLS、EAP-TTLS、EAP-FAST、EAP-MD5、EAP-MSCHAPv2，是 802.1X 场景的事实标准 |
| **模块生态** | 200+ 可加载模块（rlm_sql、rlm_ldap、rlm_perl、rlm_python、rlm_rest 等），几乎可以对接任何后端 |
| **策略引擎** | unlang 策略语言可实现复杂条件逻辑：按时间、NAS-IP、Called-Station-ID(SSID)、用户组动态下发不同 VLAN/ACL |
| **生产验证** | 1999 年至今，全球数百万生产部署，包括大学（eduroam）、运营商、大型企业 |
| **中文社区** | CSDN、知乎、华为论坛大量中文资料，排错门槛低 |

#### 劣势

| 维度 | 说明 |
|------|------|
| **Web 管理** | 不自带，需外挂 daloRADIUS（PHP，界面较老）或自建管理面板 |
| **配置门槛** | 纯文本配置 + unlang 策略，学习曲线陡峭 |
| **Portal 认证** | 不自带 Portal 页面，需自行开发或对接第三方（CoovaChilli / OpenPortal） |
| **API** | 无原生 REST API，自动化需通过 radclient CLI 或直接操作 SQL |

#### 适用场景

- ✅ **802.1X 有线 + 无线准入**（核心场景）
- ✅ **动态 VLAN / ACL 下发**
- ✅ **对接企业 AD/LDAP 实现域账号统一认证**
- ✅ **需要精细化策略控制**（按 SSID/时间/NAS 不同策略）
- ⚠️ ISP 计费场景（需要大量自开发，不如 ToughRADIUS 开箱即用）
- ⚠️ 纯 Portal 访客场景（Portal 页面需自建）

#### 典型架构

```
                    ┌──────────────┐
                    │  daloRADIUS  │  Web 管理面板
                    └──────┬───────┘
                           │ SQL
                    ┌──────▼───────┐
    AD/LDAP  ◄──────│  FreeRADIUS  │──────►  MariaDB / PostgreSQL
                    └──────┬───────┘
                           │ RADIUS (UDP 1812/1813/3799)
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐ ┌───▼───┐ ┌─────▼─────┐
        │ 华为 AC    │ │交换机  │ │ 华为 AP   │
        │ (WLAN)    │ │(有线)  │ │ (Fit AP)  │
        └───────────┘ └───────┘ └───────────┘
```

---

### 2.2 ToughRADIUS — ISP / 计费场景首选 ★★★★

**一句话定位**：Go 语言实现的新一代 RADIUS，内置 Web 管理 + 计费 + Portal，适合运营商和商业 Wi-Fi。

> **重要更新（2026）**：ToughRADIUS 现已支持完整的 EAP 协议栈（EAP-TLS、PEAPv0/EAP-MSCHAPv2、EAP-TTLS），802.1X 能力大幅提升。

#### 优势

| 维度 | 说明 |
|------|------|
| **一体化** | RADIUS 引擎 + Web 管理 + Portal 页面 + 计费引擎 + REST API，一个二进制搞定 |
| **现代化** | Go 高并发、React 管理面板、PostgreSQL 后端、Docker 原生支持 |
| **计费完善** | 预付费/后付费、按时间/流量计费、套餐管理、在线支付（微信/支付宝） |
| **Portal 内置** | 自带 Portal 认证页面，无需额外开发 |
| **API 友好** | 完整 REST API，适合自动化编排 |
| **部署简单** | 单二进制，一条命令启动 |

#### 劣势

| 维度 | 说明 |
|------|------|
| **华为 Portal 协议** | 不支持华为私有 Portal 协议（华为 AC/BAS PORTAL 协议），只能对接标准 RADIUS Portal |
| **策略灵活度** | 没有 unlang 级别的策略引擎，复杂条件逻辑不如 FreeRADIUS |
| **TACACS+** | 不支持，只能做 RADIUS |
| **社区与资料** | 生态和中文资料远不如 FreeRADIUS |
| **AD 集成** | LDAP 支持不如 FreeRADIUS 成熟 |
| **许可证** | AGPLv3（比 GPLv2 更严格，SaaS 场景需注意） |

#### 适用场景

- ✅ **ISP / 运营商宽带计费**
- ✅ **酒店 / 商场 / 机场 Wi-Fi 认证 + 计费**
- ✅ **校园网 Portal 认证 + 流量计费**
- ✅ **需要开箱即用的 Web 管理面板**
- ✅ **团队缺乏 RADIUS 深度经验**
- ⚠️ 纯 802.1X 企业准入（FreeRADIUS 更成熟）
- ❌ 需要对接华为私有 Portal 协议

---

### 2.3 PacketFence — 完整 NAC 准入控制 ★★★

**一句话定位**：基于 FreeRADIUS 的完整 NAC 平台，提供设备识别、合规检查、自动隔离、访客自助注册等能力。

#### 优势

| 维度 | 说明 |
|------|------|
| **设备 Profiling** | DHCP fingerprinting + MAC OUI + HTTP User-Agent 自动识别设备类型 |
| **自动隔离** | 不合规设备自动划入隔离 VLAN，修复后自动恢复 |
| **访客自助** | 内置访客注册 Portal（邮箱验证 / SMS / 赞助人审批） |
| **BYOD 支持** | MDM 集成、证书自动签发 |
| **策略引擎** | 基于设备类型、用户角色、时间、合规状态的多维策略 |

#### 劣势

| 维度 | 说明 |
|------|------|
| **重量级** | 组件繁多（FreeRADIUS + pfsetacls + pfdhcp + pfmon + pfcron + ...），运维成本高 |
| **华为优化有限** | 对 Cisco 设备优化最好，华为 SNMP/CLI 联动不如 Cisco |
| **Portal 无华为协议** | Portal 认证基于标准 HTTP 重定向，不走华为私有协议 |
| **性能** | 大规模部署需要单独调优 |
| **学习曲线** | 组件多、配置复杂 |

#### 适用场景

- ✅ **需要设备合规检查的企业**（Windows 补丁、杀毒软件检查）
- ✅ **BYOD 园区网络**
- ✅ **多厂商设备混合环境**（Cisco + Huawei + Aruba）
- ⚠️ 只需 802.1X 认证的场景（杀鸡用牛刀）
- ❌ 小规模部署（几百用户以内，运维成本不成比例）

---

### 2.4 CoovaChilli — Captive Portal 接入控制器 ★★★

**一句话定位**：专注于 Captive Portal 场景，作为网络侧网关拦截流量并触发 Portal 认证，配合 FreeRADIUS 实现完整的 Portal 认证链路。

#### 优势

| 维度 | 说明 |
|------|------|
| **Portal 原生** | Captive Portal 是其核心能力，支持 UAM、WISPr、MAC 认证 |
| **带宽控制** | 内置 tc 流量整形，可做每用户限速 |
| **轻量** | 可在 OpenWrt 路由器上运行 |
| **RADIUS 对接** | 内置 RADIUS client，可与 FreeRADIUS 完美配合 |

#### 劣势

| 维度 | 说明 |
|------|------|
| **不独立使用** | 不是完整的 RADIUS 服务器，需要配合 FreeRADIUS |
| **CentOS/Ubuntu** | 主要面向 OpenWrt 和嵌入式场景，x86 部署资料少 |
| **华为适用性** | 华为有自己的 Portal 协议，CoovaChilli 不与华为直接对接；只能用于旁挂 Portal 网关场景 |

#### 适用场景

- ✅ **OpenWrt 路由器热点 Portal**
- ✅ **配合 FreeRADIUS 构建 Portal 认证链路**（CoovaChilli 做网关 + FreeRADIUS 做 AAA）
- ⚠️ 与华为 AC/交换机配合使用（华为有自己的 Portal 流程，CoovaChilli 无法替代）
- ❌ 需要华为 Portal 协议对接

---

### 2.5 OpenPortal — 华为私有 Portal 协议对接 ★★

**一句话定位**：Java 实现的开源华为 Portal 协议服务端，解决华为 Portal 私有协议对接问题。

#### 关键信息

- **GitHub**: `github.com/freeubuntu/OpenPortal` / `github.com/lishuocool`
- **协议**: 华为 AC/BAS PORTAL 协议（非标准 RADIUS，华为私有）
- **端口**: Portal 协议使用自定义端口（默认 2000 for AC, 50100 for Portal Server）
- **配套**: 同一作者还提供了 ToughRadius（早期版本）和 AC 模拟器

#### 优势

| 维度 | 说明 |
|------|------|
| **华为专用** | 唯一直接支持华为私有 Portal 协议的开源实现 |
| **简单** | 代码量小，逻辑清晰 |

#### 劣势

| 维度 | 说明 |
|------|------|
| **维护状态** | 几乎停更 |
| **功能单一** | 仅解决 Portal 协议对接，不含认证逻辑 |
| **生产风险** | 无人维护的代码不适合生产直接上线 |

#### 适用场景

- ⚠️ 仅当必须使用华为私有 Portal 协议且无法使用标准 RADIUS Portal 时
- ⚠️ 建议作为协议参考实现，生产环境优先选择其他方案

---

## 三、华为设备对接兼容性分析

### 3.1 华为 RADIUS 对接要点

华为设备与 RADIUS 服务器的对接核心在于以下几点，**所有主流开源 RADIUS 方案都满足**：

| 对接要点 | FreeRADIUS | ToughRADIUS | PacketFence |
|----------|:----------:|:-----------:|:-----------:|
| 标准 RADIUS (RFC 2865/2866) | ✅ | ✅ | ✅ |
| EAP 中继（`dot1x authentication-method eap`） | ✅ | ✅ | ✅ |
| Tunnel 属性 VLAN 下发 | ✅ | ✅ | ✅ |
| CoA/DM (UDP 3799) | ✅ | ✅ | ✅ |
| 华为 VSA 属性（HW-*） | ✅ | ✅ | ✅ |
| Filter-ID ACL 下发 | ✅ | ✅ | ✅ |
| Session-Timeout / Idle-Timeout | ✅ | ✅ | ✅ |
| 计费报文（Start/Interim/Stop） | ✅ | ✅ | ✅ |

### 3.2 华为 Portal 协议的差异

这是关键分歧点。华为支持**两种** Portal 认证方式：

| 方式 | 协议 | 说明 |
|------|------|------|
| **华为私有 Portal 协议** | 华为自定义（Portal/HTTP 协议） | 华为 AC/BAS 设备独有的 Portal 交互协议，AC 与 Portal Server 之间通过私有协议通信 |
| **标准 RADIUS Portal** | RFC 标准 RADIUS | 通过 RADIUS Access-Request 传递 Portal 用户名密码，Portal Server 向 RADIUS 发认证请求 |

**建议**：新部署优先使用标准 RADIUS Portal 方式，避免锁定华为私有协议。华为的 `iMaster NCE-Campus` 云平台也支持标准 RADIUS 中继认证。

### 3.3 华为 WLAN AC 特殊适配

华为 AC 的 WLAN 认证涉及 VAP 模板、安全模板、SSID 模板的组合配置。FreeRADIUS 对此有最完善的社区案例支撑，特别是：

- `Called-Station-ID` 携带 SSID，可用于按 SSID 下发不同策略
- `NAS-Port-Type = 19 (IEEE 802.11)` 标识无线用户
- 动态业务 VLAN 下发与 `authorization-mode radius` 配合

---

## 四、场景化推荐矩阵

### 4.1 按场景推荐

| 场景 | 首选 | 备选 | 理由 |
|------|:----:|:----:|------|
| **802.1X 企业准入（有线+无线）** | 🥇 FreeRADIUS | ToughRADIUS | FreeRADIUS 的 unlang 策略引擎 + EAP 协议栈是 802.1X 场景的最佳选择 |
| **Portal 访客认证（标准 RADIUS）** | 🥇 ToughRADIUS | FreeRADIUS + CoovaChilli | ToughRADIUS 内置 Portal + 计费，一体化交付；FreeRADIUS 组合方案灵活但需要集成工作 |
| **ISP / 运营商计费** | 🥇 ToughRADIUS | FreeRADIUS | ToughRADIUS 内置预付费/后付费/套餐/支付，开箱即用 |
| **华为私有 Portal 协议对接** | 🥇 自研 | OpenPortal (参考) | OpenPortal 已停更，建议参考其协议实现自研或改用标准 RADIUS Portal |
| **完整 NAC (设备合规+隔离)** | 🥇 PacketFence | FreeRADIUS + 自研 | 需要合规检查和自动隔离的企业场景 |
| **AD 域账号 802.1X 认证** | 🥇 FreeRADIUS | PacketFence | FreeRADIUS + LDAP 模块配置最成熟 |
| **轻量部署 / 小规模** | 🥇 ToughRADIUS | FreeRADIUS (Docker) | ToughRADIUS 一条命令启动 |
| **高安全场景（证书认证）** | 🥇 FreeRADIUS | PacketFence | EAP-TLS 支持最完整 |

### 4.2 按团队能力推荐

| 团队特征 | 推荐 | 理由 |
|----------|:----:|------|
| 资深网络工程师，熟悉 RADIUS | FreeRADIUS | 灵活性最大，策略能力最强 |
| 开发团队为主，需要 API | ToughRADIUS | REST API + React 面板，开发友好 |
| 安全团队，需要合规检查 | PacketFence | 完整 NAC 能力 |
| 运维人力有限，追求简单 | ToughRADIUS | 部署和运维成本最低 |

---

## 五、综合结论

### 核心推荐：FreeRADIUS

> **针对「华为 AC / 交换机 802.1X + Portal + WLAN 认证」场景，FreeRADIUS 是首选方案。**

理由：
1. **华为兼容性最强** — 官方文档的 RADIUS 对接示例均基于 FreeRADIUS，华为 VSA 属性完整支持
2. **802.1X 能力最成熟** — 25 年积累的 EAP 协议栈，全球 eduroam 等大规模 802.1X 部署的首选
3. **策略最灵活** — unlang 策略语言可实现按 SSID、按 NAS、按时段、按用户组的差异化 VLAN/ACL 下发
4. **生态最完善** — 中文资料丰富，排错容易，社区支持好
5. **可组合性强** — 需要 Portal 时可对接 CoovaChilli 或自建；需要 Web 管理可加 daloRADIUS

### 补充推荐：ToughRADIUS

> **如果需求偏向 ISP 计费 + Portal 认证，且团队对 Go 技术栈友好，ToughRADIUS 是最佳现代化选择。**

理由：
1. 一条命令部署，内置 Web + Portal + 计费
2. Go 高并发性能好
3. 2026 年已补齐 EAP 协议栈
4. REST API 适合与现有系统集成

### 组合推荐：分场景使用

```
           ┌──────────────────────────────────┐
           │          FreeRADIUS              │
           │  802.1X 准入 + LDAP/AD 集成       │
           │  动态 VLAN + ACL + CoA           │
           └──────────────┬───────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
  ┌─────▼─────┐   ┌──────▼──────┐   ┌─────▼──────┐
  │ daloRADIUS│   │ CoovaChilli │   │ 自建 Portal │
  │ Web 管理  │   │ Portal 网关  │   │ (Nginx+Flask)│
  └───────────┘   └─────────────┘   └────────────┘
```

- **802.1X 准入** → FreeRADIUS 主力
- **Portal 认证** → FreeRADIUS 做 AAA 后端 + CoovaChilli / 自建 Portal 页面
- **Web 管理** → daloRADIUS（日常运营）/ 自建面板（定制需求强）
- **自动化** → FreeRADIUS REST 模块（`rlm_rest`）+ Ansible/Terraform 编排
- **计费** → 如果计费需求强，可单独部署 ToughRADIUS 处理计费，FreeRADIUS 处理 802.1X

---

## 六、不推荐的选择

| 方案 | 原因 |
|------|------|
| **tac_plus** | 只支持 TACACS+，不支持 RADIUS，无法用于 802.1X / Portal / WLAN |
| **Windows NPS** | 非开源，依赖 Windows Server 许可证；华为兼容性不如 FreeRADIUS；无 unlang 级策略能力 |
| **MikroTik RADIUS** | 只对 MikroTik 设备优化，华为属性支持不完整 |
| **ClearOS RADIUS** | 本质是 FreeRADIUS + Web 面板的打包，不如直接上 ToughRADIUS |

---

## 七、附录：各方案快速部署对比

| 部署方式 | FreeRADIUS | ToughRADIUS | PacketFence |
|----------|------------|-------------|-------------|
| **APT 安装** | `apt install freeradius` | ❌ 需编译 | ❌ 需安装脚本 |
| **Docker** | `docker run freeradius/freeradius-server` | `docker run talkincode/toughradius` | 官方 docker-compose |
| **默认端口** | 1812/1813/3799 | 1812/1813/2083(Web) | 80/443(Web) + RADIUS |
| **管理面板 URL** | http://IP/daloradius-web | http://IP:1816 | https://IP:1443 |
| **首次启动时间** | ~3 分钟 | ~30 秒 | ~15 分钟 |
| **最小内存** | 256M | 128M | 4G |
