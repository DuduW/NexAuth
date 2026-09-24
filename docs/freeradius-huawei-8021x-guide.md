# FreeRADIUS 完整部署方案

## 适配华为 AC / 交换机：802.1X · Portal · WLAN · 动态 VLAN · CoA 强制下线

> **目标场景**：园区网络准入控制，覆盖 802.1X 有线/无线认证、Portal 访客认证、WLAN 安全认证，FreeRADIUS 作为统一 AAA 后端，按用户/分组下发不同 VLAN/ACL，支持管理员远程踢用户下线。

---

## 一、基础介绍

### 1.1 FreeRADIUS 是什么

FreeRADIUS 是全球部署最广泛的开源 RADIUS AAA 服务器。标准兼容性极好，是华为交换机 / AC 官方推荐的开源 RADIUS 方案。

| 项目 | 说明 |
|------|------|
| **版本** | 3.0.x（主流稳定版，Ubuntu 22.04 apt 默认） |
| **认证端口** | UDP 1812（Authentication） |
| **计费端口** | UDP 1813（Accounting） |
| **CoA/DM 端口** | UDP 3799（Change of Authorization / Disconnect Message） |
| **认证协议** | PAP / CHAP / MSCHAPv2 / PEAP / EAP-TLS / EAP-TTLS |
| **VLAN 下发** | 标准 RADIUS Tunnel 属性（Tunnel-Type / Tunnel-Medium-Type / Tunnel-Private-Group-ID） |
| **CoA** | 支持 DM（Disconnect Message）强制下线、动态修改在线用户权限 |

### 1.2 组件架构

```
┌─────────────────────────────────────────────────────┐
│                  FreeRADIUS 服务器                     │
│  ┌───────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ freeradius    │  │  MariaDB     │  │ daloRADIUS │ │
│  │ (核心AAA引擎)  │◄─┤ (账号/分组/  │◄─┤ (Web管理)  │ │
│  │               │  │  计费存储)    │  │            │ │
│  └───────┬───────┘  └──────────────┘  └────────────┘ │
│          │                                            │
└──────────┼────────────────────────────────────────────┘
           │ RADIUS UDP (1812/1813/3799)
           │
    ┌──────┴──────┐
    │ 华为交换机/AC │── NAS 接入服务器（802.1X Authenticator）
    └──────┬──────┘
           │ 802.1X (EAP over LAN / WLAN)
    ┌──────┴──────┐
    │  终端设备     │── Supplicant（PC / 手机 / 打印机）
    └─────────────┘
```

---

## 二、组网架构

### 园区标准部署拓扑

```
终端PC/手机 ──802.1X──► 华为接入交换机/AC ──RADIUS UDP──► FreeRADIUS
   (Supplicant)         (NAS / Authenticator)              (AAA Server)
                              │
                     VLAN 99 ← 认证前隔离
                     VLAN 100 ← 员工 VLAN（动态下发）
                     VLAN 200 ← 访客 VLAN（动态下发）
                     VLAN 300 ← IT 运维 VLAN
```

**设备角色**：

| 角色 | 设备 | 职责 |
|------|------|------|
| Supplicant | 终端 PC / 手机 | 发起 802.1X 认证请求 |
| Authenticator (NAS) | 华为交换机 / AC | 转发 EAP 报文到 RADIUS，执行 VLAN 切换 |
| AAA Server | FreeRADIUS | 认证用户，下发 VLAN / ACL / Session-Timeout 等属性 |

---

## 三、部署环境规划

### 3.1 服务器规格

| 项目 | 推荐配置 |
|------|----------|
| **OS** | Ubuntu 22.04 LTS / Debian 12 |
| **CPU** | 2C（企业大规模建议 4C） |
| **内存** | 4G（用户 > 5000 建议 8G） |
| **磁盘** | 50G+ |
| **网络** | 静态 IP，千兆网卡 |

### 3.2 规划参数（示例）

| 参数 | 值 |
|------|-----|
| FreeRADIUS 服务器 IP | `10.10.30.100` |
| 华为 AC 源 IP | `10.10.30.10` |
| 华为接入交换机源 IP | `10.10.30.11` |
| 共享密钥 | `Huawei@Radius123` |
| RADIUS DB 密码 | `CHANGE_ME_DB_PASS` |
| daloRADIUS 管理员 | `administrator / radius` |
| 认证前隔离 VLAN | `99` |
| 员工 VLAN | `100` |
| 访客 VLAN | `200` |

---

## 四、分步安装部署（Ubuntu 22.04）

### 4.1 系统更新 & 依赖安装

```bash
apt update && apt upgrade -y

apt install -y \
  freeradius freeradius-mysql \
  mariadb-server \
  apache2 \
  php php-mysql php-gd php-curl php-mbstring php-xml php-zip \
  libapache2-mod-php \
  git unzip wget
```

> **说明**：`php-gd`（图形库）、`php-curl`、`php-mbstring`、`php-xml` 是 daloRADIUS Web 管理界面必需的扩展，缺一个页面都会报错。

### 4.2 MariaDB 数据库初始化

```bash
mysql -u root
```

执行以下 SQL：

```sql
CREATE DATABASE radius
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'radius'@'localhost' IDENTIFIED BY 'CHANGE_ME_DB_PASS';
GRANT ALL PRIVILEGES ON radius.* TO 'radius'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

> **注意**：Ubuntu 22.04 的 MariaDB 默认使用 `unix_socket` 插件认证 root。如果 `mysql -u root` 报 `Access denied`，请改用 `sudo mysql -u root`。

### 4.3 导入 FreeRADIUS 表结构 & 启用 SQL 模块

```bash
# 导入标准表结构
mysql -u radius -p radius < /etc/freeradius/3.0/mods-config/sql/main/mysql/schema.sql
```

验证表是否创建成功：

```bash
mysql -u radius -p radius -e "SHOW TABLES;"
```

预期输出应包含 `radcheck`, `radreply`, `radgroupcheck`, `radgroupreply`, `radacct`, `radusergroup` 等表。

**启用 SQL 模块**：

```bash
ln -sf /etc/freeradius/3.0/mods-available/sql /etc/freeradius/3.0/mods-enabled/
```

**编辑 SQL 模块配置** `/etc/freeradius/3.0/mods-enabled/sql`：

```ini
sql {
    dialect = "mysql"
    driver = "rlm_sql_${dialect}"

    server = "localhost"
    port = 3306
    login = "radius"
    password = "CHANGE_ME_DB_PASS"

    radius_db = "radius"

    # 从 clients.conf 读取 NAS 客户端，不从 nas 表读
    read_clients = no

    # 生产环境注释掉 TLS 相关配置（自签名证书场景）
    # tls {
    #     ...
    # }
}
```

### 4.4 配置华为设备客户端

每一台华为 AC、汇聚交换机都需要一条 `client` 配置。**必须与华为设备侧的源 IP 和共享密钥完全一致**。

编辑 `/etc/freeradius/3.0/clients.conf`：

```ini
client huawei-ac-main {
    ipaddr          = 10.10.30.10          # AC 的 VLANIF 源 IP（即 radius-server source-ip）
    secret          = Huawei@Radius123      # 与华为侧 radius-server shared-key 一致
    shortname       = AC_MAIN
    nastype         = other
}

client huawei-sw-floor3 {
    ipaddr          = 10.10.30.11
    secret          = Huawei@Radius123
    shortname       = SW_FLOOR3
    nastype         = other
}
```

> **关键**：`ipaddr` 务必是华为设备发送 RADIUS 报文使用的源 IP。华为默认用出接口 IP，建议通过 `radius-server source-ip x.x.x.x` 显式指定。

### 4.5 启用 EAP（PEAP-MSCHAPv2）

802.1X 使用 EAP 协议承载认证，最常见的是 PEAP（外层 TLS 加密隧道 + 内层 MSCHAPv2 密码认证）。

```bash
# 启用 EAP 模块（Ubuntu apt 安装通常已在 mods-enabled 中）
ln -sf /etc/freeradius/3.0/mods-available/eap /etc/freeradius/3.0/mods-enabled/
```

编辑 `/etc/freeradius/3.0/mods-enabled/eap`：

```ini
eap {
    default_eap_type = peap
    timer_expire     = 60
    ignore_unknown_eap_types = no
    cisco_accounting_username_bug = no
    max_sessions = ${max_requests}

    md5 {
    }
    leap {
    }
    gtc {
        auth_type = PAP
    }
    tls-config tls-common {
        private_key_password = whatever
        private_key_file = ${certdir}/server.pem
        certificate_file = ${certdir}/server.pem
        ca_file = ${cadir}/ca.pem
        dh_file = ${certdir}/dh
        random_file = ${certdir}/random
        fragment_size = 1024
        include_length = yes
        auto_chain = yes
        check_crl = no
        check_all_crl = no
        ca_path = ${cadir}
        cipher_list = "PROFILE=SYSTEM"
        ecdh_curve = "prime256v1"
        disable_tlsv1_2 = no
        disable_tlsv1_1 = yes
        disable_tlsv1 = yes
    }
    tls-config tls-inner {
        private_key_password = whatever
        private_key_file = ${certdir}/server.pem
        certificate_file = ${certdir}/server.pem
        ca_file = ${cadir}/ca.pem
        dh_file = ${certdir}/dh
        random_file = ${certdir}/random
        fragment_size = 1024
        include_length = yes
        auto_chain = yes
        check_crl = no
        check_all_crl = no
        ca_path = ${cadir}
        cipher_list = "PROFILE=SYSTEM"
        ecdh_curve = "prime256v1"
    }
    peap {
        default_eap_type = mschapv2
        copy_request_to_tunnel = no
        use_tunneled_reply = no
        proxy_tunneled_request_as_eap = yes
        virtual_server = "inner-tunnel"
    }
    mschapv2 {
    }
}
```

> **安全提示**：上述 TLS 配置使用 FreeRADIUS 自带的测试证书（`/etc/freeradius/3.0/certs/`），仅用于功能验证。生产环境必须替换为合法 CA 签发的证书，否则客户端每次都会弹证书信任警告。

### 4.6 配置认证站点接入 SQL

编辑 `/etc/freeradius/3.0/sites-enabled/default`：

```plaintext
authorize {
    filter_username
    preprocess
    suffix
    files
    sql                     # ← 添加这一行
    expiration
    logintime
    pap
}

authenticate {
    Auth-Type PAP {
        pap
    }
    Auth-Type CHAP {
        chap
    }
    Auth-Type MS-CHAP {
        mschap
    }
    Auth-Type SQL {
        sql                 # ← 确认 sql 在 authenticate 中已启用
    }
    eap
}
```

编辑 `/etc/freeradius/3.0/sites-enabled/inner-tunnel`（PEAP 内层隧道）：

```plaintext
authorize {
    filter_username
    filter_inner_identity
    update control {
        &Proxy-To-Realm := LOCAL
    }
    suffix
    files
    sql                     # ← 添加这一行
    pap
}

authenticate {
    Auth-Type PAP {
        pap
    }
    Auth-Type MS-CHAP {
        mschap
    }
    Auth-Type SQL {
        sql                 # ← 确认启用
    }
    mschap
    pap
}
```

### 4.7 安装 daloRADIUS Web 管理

```bash
# 克隆 daloRADIUS
cd /var/www/html
git clone https://github.com/lirantal/daloradius.git
mv daloradius daloradius-web

# 设置权限
chown -R www-data:www-data /var/www/html/daloradius-web
chmod -R 755 /var/www/html/daloradius-web
```

**导入 daloRADIUS 扩展表**：

> 文件名因版本可能不同，用通配符匹配：

```bash
# 先确认 SQL 文件位置
ls /var/www/html/daloradius-web/contrib/db/

# 导入（文件名可能是 fr2-mysql-daloradius-and-freeradius.sql 或 mysql-daloradius.sql）
mysql -u radius -p radius < /var/www/html/daloradius-web/contrib/db/fr2-mysql-daloradius-and-freeradius.sql
```

**配置 daloRADIUS 数据库连接**：

```bash
cp /var/www/html/daloradius-web/library/daloradius.conf.php.sample \
   /var/www/html/daloradius-web/library/daloradius.conf.php
```

编辑 `/var/www/html/daloradius-web/library/daloradius.conf.php`：

```php
<?php
$configValues['CONFIG_DB_HOST'] = 'localhost';
$configValues['CONFIG_DB_PORT'] = '3306';
$configValues['CONFIG_DB_USER'] = 'radius';
$configValues['CONFIG_DB_PASS'] = 'CHANGE_ME_DB_PASS';
$configValues['CONFIG_DB_NAME'] = 'radius';
$configValues['FREERADIUS_VERSION'] = '3';
$configValues['CONFIG_PATH_DALO_VARIABLE_DATA'] = '/var/www/html/daloradius-web/var';
?>
```

**Apache 重写 & 权限**：

```bash
a2enmod rewrite
systemctl restart apache2
```

**访问地址**：

```
http://10.10.30.100/daloradius-web
```

默认账号：`administrator` / `radius`（首次登录建议立即修改）。

### 4.8 防火墙 & 服务启动

```bash
# 防火墙规则
ufw allow 1812/udp    # RADIUS Authentication
ufw allow 1813/udp    # RADIUS Accounting
ufw allow 3799/udp    # CoA / Disconnect Message
ufw allow 80/tcp      # daloRADIUS Web

# 语法校验
freeradius -XC

# 前台调试（排错专用，Ctrl+C 停止）
systemctl stop freeradius
freeradius -X

# 正常启动
systemctl enable freeradius
systemctl start freeradius
systemctl status freeradius
```

---

## 五、动态 VLAN 下发

### 5.1 原理

认证成功（Access-Accept）时，FreeRADIUS 在响应报文中携带三条标准 Tunnel 属性，华为交换机收到后自动把该终端的端口切换到目标 VLAN。

这三条属性 **缺一不可**：

| 属性 | 值 | 含义 |
|------|-----|------|
| `Tunnel-Type` | `13` (VLAN) | 隧道类型为 VLAN |
| `Tunnel-Medium-Type` | `6` (IEEE-802) | 隧道介质为 802 系列 |
| `Tunnel-Private-Group-ID` | `"100"` | 目标 VLAN ID |

### 5.2 方式一：单用户 VLAN（daloRADIUS 操作）

1. 进入 daloRADIUS → **Management** → **Users** → **Edit User**
2. 在 **Reply Attributes** 区域添加三条属性：

```
Attribute: Tunnel-Type
op: :=
Value: VLAN

Attribute: Tunnel-Medium-Type
op: :=
Value: IEEE-802

Attribute: Tunnel-Private-Group-ID
op: :=
Value: 100
```

### 5.3 方式二：分组 VLAN（推荐，运维友好）

1. daloRADIUS → **Management** → **Groups** → **New Group**
2. 创建分组，例如 `staff-vlan100`、`guest-vlan200`、`it-vlan300`
3. 在 Group 的 **Reply Attributes** 中统一添加三条 Tunnel 属性
4. 将用户加入对应分组即可自动继承 VLAN 属性

### 5.4 数据库直操作（批量导入）

**分组 VLAN 属性（radgroupreply）**：

```sql
-- 员工组 VLAN 100
INSERT INTO radgroupreply (groupname, attribute, op, value)
VALUES
  ('staff-vlan100', 'Tunnel-Type',            ':=', 'VLAN'),
  ('staff-vlan100', 'Tunnel-Medium-Type',     ':=', 'IEEE-802'),
  ('staff-vlan100', 'Tunnel-Private-Group-ID',':=', '100');

-- 访客组 VLAN 200
INSERT INTO radgroupreply (groupname, attribute, op, value)
VALUES
  ('guest-vlan200', 'Tunnel-Type',            ':=', 'VLAN'),
  ('guest-vlan200', 'Tunnel-Medium-Type',     ':=', 'IEEE-802'),
  ('guest-vlan200', 'Tunnel-Private-Group-ID',':=', '200');

-- IT 组 VLAN 300
INSERT INTO radgroupreply (groupname, attribute, op, value)
VALUES
  ('it-vlan300', 'Tunnel-Type',            ':=', 'VLAN'),
  ('it-vlan300', 'Tunnel-Medium-Type',     ':=', 'IEEE-802'),
  ('it-vlan300', 'Tunnel-Private-Group-ID',':=', '300');
```

**将用户加入分组（radusergroup）**：

```sql
INSERT INTO radusergroup (username, groupname, priority)
VALUES
  ('zhangsan', 'staff-vlan100', 1),
  ('lisi',     'it-vlan300',     1),
  ('guest01',  'guest-vlan200',  1);
```

**用户密码（radcheck）**：

```sql
INSERT INTO radcheck (username, attribute, op, value)
VALUES
  ('zhangsan', 'Cleartext-Password', ':=', 'P@ss1234'),
  ('lisi',     'Cleartext-Password', ':=', 'P@ss1234');
```

> **注意**：数据库直操作后必须重启 FreeRADIUS 或发送 HUP 信号使其重载：
> ```bash
> systemctl reload freeradius
> ```

---

## 六、华为设备侧配置

### 6.1 交换机 802.1X 完整配置

```plaintext
#
# RADIUS 服务器模板
#
radius-server template FR-RADIUS
 radius-server authentication 10.10.30.100 1812 source ip-address 10.10.30.11 weight 80
 radius-server accounting 10.10.30.100 1813 source ip-address 10.10.30.11 weight 80
 radius-server shared-key cipher Huawei@Radius123
 radius-server retransmit 2 timeout 5
#
# CoA/DM 功能
#
radius-server coa enable
radius-server client ip-address 10.10.30.100 shared-key cipher Huawei@Radius123

#
# AAA 方案
#
aaa
 authentication-scheme dot1x-auth
  authentication-mode radius
 authorization-scheme dot1x-authz
  authorization-mode radius
 accounting-scheme dot1x-acct
  accounting-mode radius
  accounting start-fail online

#
# 域
#
domain default
 authentication-scheme dot1x-auth
 authorization-scheme dot1x-authz
 accounting-scheme dot1x-acct
 radius-server FR-RADIUS

#
# 全局启用 802.1X
#
dot1x enable
dot1x timer tx-period 10

#
# 接口配置（核心！）
#
interface GigabitEthernet0/0/1
 description [802.1X-Client-Port]
 port link-type access
 port default vlan 99                    # 认证前隔离 VLAN（未认证时在此 VLAN）
 dot1x enable
 dot1x port-method portbased             # 基于端口认证
 dot1x authentication-method eap         # EAP 中继模式
 dot1x dynamic-vlan enable               # ★★★ 核心！开启动态 VLAN 切换
 dot1x port-control auto
 dot1x reauthenticate
 dot1x timer reauthenticate-period 86400 # 24 小时重认证一次
```

### 6.2 华为 AC 无线 802.1X 配置要点

```plaintext
#
# RADIUS 模板（同交换机）
#
radius-server template FR-RADIUS
 radius-server authentication 10.10.30.100 1812 source ip-address 10.10.30.10 weight 80
 radius-server accounting 10.10.30.100 1813 source ip-address 10.10.30.10 weight 80
 radius-server shared-key cipher Huawei@Radius123
#
radius-server coa enable
radius-server client ip-address 10.10.30.100 shared-key cipher Huawei@Radius123

#
# AAA
#
aaa
 authentication-scheme dot1x-auth
  authentication-mode radius
 authorization-scheme dot1x-authz
  authorization-mode radius
 accounting-scheme dot1x-acct
  accounting-mode radius

domain default
 authentication-scheme dot1x-auth
 authorization-scheme dot1x-authz
 accounting-scheme dot1x-acct
 radius-server FR-RADIUS

#
# WLAN 安全模板
#
wlan
 security-profile name dot1x-security
  security wpa2 dot1x aes
  pmf optional
#
 ssid-profile name company-ssid
  ssid Company-WiFi
#
 vap-profile name company-vap
  forward-mode tunnel
  service-vlan vlan-id 100          # 业务 VLAN（可被 RADIUS 动态覆盖）
  ssid-profile company-ssid
  security-profile dot1x-security
  authentication dot1x
```

> **AC 注意**：无线场景 VLAN 由 VAP 模板 + RADIUS 动态下发共同决定。配置 `authorization-mode radius` 后，AC 会接受 RADIUS 返回的 Tunnel 属性覆盖默认业务 VLAN。

---

## 七、Portal 认证（Portal + FreeRADIUS）

### 7.1 Portal 认证流程概述

Portal 认证又称 Web 认证，用户在浏览器中输入用户名密码完成认证，适用于访客、BYOD、临时接入等场景。

```
终端浏览器 ──HTTP──► 华为交换机/AC ──重定向──► Portal Server (登录页面)
                                                    │
                                         用户输入 用户名/密码
                                                    │
                                          POST 到 Portal Server
                                                    │
                                        Portal Server ──RADIUS(1812)──► FreeRADIUS
                                                    │
                                        Access-Accept ←── FreeRADIUS
                                                    │
                                        Portal Server ──通知 AC 放行用户──► 终端上网
```

### 7.2 华为 Portal 的两种实现方式

| 方式 | 协议 | Portal Server 位置 | FreeRADIUS 角色 |
|------|------|--------------------|-----------------|
| **方式一：华为私有 Portal 协议** | 华为自定义协议（Portal/HTTP） | 独立部署的 Portal Server | 纯 RADIUS AAA 后端，Portal Server 向 FreeRADIUS 发 RADIUS 请求 |
| **方式二：内置 Portal（推荐）** | HTTP / HTTPS | 华为设备内置 | 纯 RADIUS AAA 后端，华为设备自己处理 Portal 页面并转发到 RADIUS |

> **推荐方式二**：华为设备自带简易 Portal 页面，无需额外部署 Portal Server，运维最简单。但页面不可定制，如需定制品牌/广告/社交媒体登录，仍需外置 Portal Server。

### 7.3 方式一：外置 Portal Server + FreeRADIUS（定制需求）

#### 架构角色

| 组件 | 说明 |
|------|------|
| **华为交换机/AC** | 截获未认证 HTTP 请求 → 重定向到 Portal Server URL |
| **Portal Server** | 提供登录页面 → 接收用户名密码 → 调用 FreeRADIUS 做认证 → 通知 AC 放行用户 |
| **FreeRADIUS** | 纯 RADIUS AAA 后端，验证用户密码，返回授权属性（VLAN/ACL/限速） |

#### FreeRADIUS 配置：适配 Portal 认证

Portal 认证走的是 PAP 或 CHAP（非 EAP），FreeRADIUS 默认即支持，无需额外配置 EAP 模块。关键是返回的授权属性。

**需要为用户/分组配置的 RADIUS Reply 属性**：

```
# 基础属性
Session-Timeout = 86400           # 会话超时（秒），24小时
Idle-Timeout = 1800               # 空闲超时（秒），30分钟

# 华为限速属性（VSA，可选）
HW-Input-Committed-Information-Rate = 2048000   # 上行 2Mbps
HW-Output-Committed-Information-Rate = 4096000  # 下行 4Mbps

# ACL 下发（可选）
Filter-ID = "guest-acl-3000"      # 华为设备上预定义的 ACL 名称

# VLAN 下发（可选，Portal 场景通常固定 VLAN）
Tunnel-Type = VLAN
Tunnel-Medium-Type = IEEE-802
Tunnel-Private-Group-ID = "200"    # 访客 VLAN
```

**daloRADIUS 操作**：Groups → `guest-portal` → Group Reply Attributes 添加上述属性。

**数据库直操作**：

```sql
INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES
('guest-portal', 'Session-Timeout',  ':=', '86400'),
('guest-portal', 'Idle-Timeout',     ':=', '1800'),
('guest-portal', 'Tunnel-Type',      ':=', 'VLAN'),
('guest-portal', 'Tunnel-Medium-Type',':=', 'IEEE-802'),
('guest-portal', 'Tunnel-Private-Group-ID', ':=', '200');
```

#### Portal Server 实现（Python 示例 — 轻量级）

```python
#!/usr/bin/env python3
"""
portal_server.py — 简易 Portal 登录服务（配合 FreeRADIUS + 华为设备）
监听 50100 端口，提供登录页面，调用 radclient 做 RADIUS 认证后通知 AC 放行。

依赖：pip install pyrad flask
"""

import hashlib
import hmac
import struct
from flask import Flask, request, redirect, render_template_string

app = Flask(__name__)

# 配置
PORTAL_PORT = 50100
RADIUS_SERVER = "127.0.0.1"
RADIUS_SECRET = b"testing123"
AC_LOGIN_URL = "http://10.10.30.11:8080/portal"   # 华为 AC Portal 回调地址

LOGIN_HTML = """
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>访客认证</title>
<style>
  body { font-family: sans-serif; display: flex; justify-content: center;
         align-items: center; height: 100vh; background: #f0f2f5; }
  .login-box { background: white; padding: 40px; border-radius: 8px;
               box-shadow: 0 2px 12px rgba(0,0,0,.1); width: 360px; }
  h2 { text-align: center; color: #333; }
  input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd;
          border-radius: 4px; box-sizing: border-box; }
  button { width: 100%; padding: 12px; background: #1890ff; color: white;
           border: none; border-radius: 4px; font-size: 16px; cursor: pointer; }
  button:hover { background: #40a9ff; }
</style>
</head>
<body>
<div class="login-box">
  <h2>访客 Wi-Fi 认证</h2>
  <form method="POST">
    <input name="username" placeholder="用户名 / 手机号" required>
    <input name="password" type="password" placeholder="密码" required>
    <button type="submit">登录上网</button>
  </form>
</div>
</body>
</html>
"""


def radius_auth(username: str, password: str) -> tuple[bool, str]:
    """向 FreeRADIUS 发送 PAP 认证请求。"""
    import pyrad.packet
    from pyrad.client import Client
    from pyrad.dictionary import Dictionary

    client = Client(
        server=RADIUS_SERVER,
        secret=RADIUS_SECRET,
        dict=Dictionary("dictionary"),
        authport=1812,
    )
    req = client.CreateAuthPacket(
        code=pyrad.packet.AccessRequest,
        User_Name=username,
    )
    req["User-Password"] = req.PwCrypt(password)
    req["NAS-IP-Address"] = "10.10.30.11"
    req["Service-Type"] = "Login-User"

    try:
        reply = client.SendPacket(req)
        if reply.code == pyrad.packet.AccessAccept:
            return True, "认证成功"
        else:
            return False, "用户名或密码错误"
    except Exception as e:
        return False, str(e)


@app.route("/", methods=["GET", "POST"])
def login():
    user_ip = request.args.get("userip", "")
    user_mac = request.args.get("usermac", "")

    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        success, msg = radius_auth(username, password)

        if success:
            # 通知华为 AC 放行该用户（华为私有 Portal 协议）
            # 格式由华为 Portal 协议定义，这里是简化示意
            # 实际需实现华为 Portal 协议的 Challenge/Request/Ack 交互
            return f"<h3>认证成功！请关闭此页面继续上网。</h3>"
        else:
            return render_template_string(
                LOGIN_HTML.replace(
                    '<button type="submit">登录上网</button>',
                    f'<p style="color:red">{msg}</p><button type="submit">重试</button>',
                )
            )

    return render_template_string(LOGIN_HTML)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORTAL_PORT, debug=False)
```

### 7.4 方式二：华为内置 Portal + FreeRADIUS（最简单，推荐）

#### 华为交换机侧配置（内置 Portal）

```plaintext
#
# 1. RADIUS 服务器模板（同 802.1X，复用即可）
#
radius-server template FR-RADIUS
 radius-server authentication 10.10.30.100 1812 source ip-address 10.10.30.11 weight 80
 radius-server accounting 10.10.30.100 1813 source ip-address 10.10.30.11 weight 80
 radius-server shared-key cipher Huawei@Radius123
#
# 2. Portal 服务器模板（指向华为设备自己 = 内置 Portal）
#
portal server portal-builtin
 server-ip 10.10.30.11           # 本设备 IP，内置 Portal 监听地址
 port 2000                        # Portal 协议端口（华为默认）
 shared-key cipher Huawei@Radius123
 protocol http                    # 或 https（需 SSL 策略）
#
# 3. Portal 接入模板
#
portal-access-profile name portal-guest
 portal-server portal-builtin
#
# 4. 免认证规则（允许访问 DNS 和 Portal 页面）
#
free-rule-template name portal-free
 free-rule 1 destination ip 10.10.30.100 mask 32   # FreeRADIUS 服务器
 free-rule 2 destination ip any udp 53              # DNS 放行
#
# 5. AAA 认证方案（Portal 用 RADIUS 认证）
#
aaa
 authentication-scheme portal-auth
  authentication-mode radius
 authorization-scheme portal-authz
  authorization-mode radius
 accounting-scheme portal-acct
  accounting-mode radius
#
# 6. 域（Portal 用户可与 802.1X 用户共用同一个 domain）
#
domain default
 authentication-scheme portal-auth
 authorization-scheme portal-authz
 accounting-scheme portal-acct
 radius-server FR-RADIUS
#
# 7. 接口启用 Portal 认证
#
interface Vlanif200                     # 访客 VLAN 三层接口
 ip address 192.168.200.1 255.255.255.0
 portal enable
 portal free-rule-template portal-free
 portal access-profile portal-guest
#
# 8. 可选：无线场景 VAP 模板绑定 Portal
#
wlan
 vap-profile name guest-vap
  forward-mode tunnel
  service-vlan vlan-id 200
  ssid-profile guest-ssid
  security-profile open-security       # 开放 SSID，无需密码
  authentication portal                 # Portal 认证（非 802.1X）
```

#### 华为 AC 无线 Portal 配置要点

```plaintext
#
# WLAN 安全模板：开放 + Portal
#
wlan
 security-profile name open-portal
  security open                       # 开放 SSID，不加密
#
 ssid-profile name Guest-WiFi
  ssid Guest-WiFi
#
 vap-profile name guest-vap
  forward-mode tunnel
  service-vlan vlan-id 200
  ssid-profile Guest-WiFi
  security-profile open-portal
  authentication portal               # Portal 认证模式
  portal-access-profile portal-guest
```

> **用户流程**：连接 `Guest-WiFi` SSID → 自动获取 192.168.200.x 地址 → 打开浏览器访问任意网站 → 华为 AC 重定向到内置 Portal 页面 → 输入用户名密码 → AC 发 RADIUS Access-Request 到 FreeRADIUS → 认证通过 → 上网。

### 7.5 802.1X + Portal 混合场景（同一台设备）

园区网络常见需求：**员工走 802.1X，访客走 Portal**。

```plaintext
#
# 接口级混合配置
#
interface GigabitEthernet0/0/1
 port link-type hybrid
 port hybrid pvid vlan 99
 port hybrid untagged vlan 99

 # 全局启用 802.1X 和 MAC 认证
 authentication dot1x
 authentication mac-authentication
 authentication portal

 # 认证顺序：先 MAC 旁路 → Portal → 802.1X（根据需要调整）
 authentication order mac-authentication portal dot1x

 # 认证前域 + 认证域分离
 authentication event authen-fail action authorize vlan 200  # 认证失败放访客 VLAN
 authentication event no-response action authorize vlan 200  # 无响应放访客 VLAN
```

**FreeRADIUS 侧配置**：根据 `Called-Station-ID`（SSID）或 `NAS-Port-Type` 区分员工/访客，下发不同 VLAN：

```plaintext
# /etc/freeradius/3.0/policy.d/huawei-policy
# 按 SSID 分流策略（unlang）

if (&Called-Station-ID =~ /Guest-WiFi/) {
    # 访客 SSID → 返回 Portal 属性
    update reply {
        Tunnel-Type := VLAN
        Tunnel-Medium-Type := IEEE-802
        Tunnel-Private-Group-ID := "200"
        Session-Timeout := 28800
    }
}
elsif (&Called-Station-ID =~ /Company-WiFi/) {
    # 员工 SSID → 返回员工 VLAN
    update reply {
        Tunnel-Type := VLAN
        Tunnel-Medium-Type := IEEE-802
        Tunnel-Private-Group-ID := "100"
    }
}
```

### 7.6 Portal + FreeRADIUS 关键注意点

| 要点 | 说明 |
|------|------|
| **华为内置 Portal 页面不可定制** | 只有华为默认登录框，无品牌 Logo / 广告位 |
| **外置 Portal 需实现华为私有协议** | 华为 Portal 协议非标准 HTTP/RADIUS，需按华为规范实现 Challenge/Request/Ack 交互 |
| **FreeRADIUS 无需特殊配置** | Portal 认证在 RADIUS 层面就是标准 PAP/CHAP，FreeRADIUS 原生支持 |
| **ACL 下发用 Filter-ID** | 不要在 Portal 场景用 `Tunnel-Private-Group-ID` 做 ACL，用 `Filter-ID` 指向设备预定义 ACL |
| **DNS 放行规则** | Portal 认证前用户必须能解析 DNS，否则浏览器重定向失败 |
| **HTTPS 重定向** | 用户访问 `https://xxx` 时浏览器会报证书错误（中间人效果），这是协议固有问题，无优雅解法 |
| **CoA 踢人同样适用于 Portal 用户** | 第七章的 CoA 脚本对 Portal 用户同样有效 |

---

## 八、CoA 强制用户下线

### 8.1 原理

FreeRADIUS 监听 UDP 3799 端口，接收 CoA / DM 请求。管理员发送 Disconnect-Message (DM) 报文到 FreeRADIUS，FreeRADIUS 转发给华为设备，华为设备断开指定用户连接。

```
管理员 ──DM(3799)──► FreeRADIUS ──DM──► 华为交换机/AC ──► 终端断开
```

### 8.2 前提条件

- FreeRADIUS：监听 UDP 3799（默认开启）
- 华为设备：`radius-server coa enable` + `radius-server client ip-address x.x.x.x`
- CoA 客户端写在 `/etc/freeradius/3.0/clients.conf` 或数据库中

### 8.3 CoA 踢用户 Python 脚本

```python
#!/usr/bin/env python3
"""
coa_disconnect.py — 通过 FreeRADIUS 的 CoA 代理发送 Disconnect-Message 踢用户下线

用法:
    python3 coa_disconnect.py --user zhangsan
    python3 coa_disconnect.py --user zhangsan --nas 10.10.30.11
    python3 coa_disconnect.py --framed-ip 192.168.100.50
"""

import argparse
import hashlib
import hmac
import os
import socket
import struct
import sys

# ── RADIUS 报文常量 ──────────────────────────────────
RADIUS_DISCONNECT_REQUEST = 40                 # Disconnect-Request 类型码
RADIUS_PORT                = 3799               # CoA / DM 端口

# 属性编号
ATTR_USER_NAME          = 1
ATTR_NAS_IP_ADDRESS     = 4
ATTR_FRAMED_IP_ADDRESS  = 8
ATTR_CALLING_STATION_ID = 31
ATTR_NAS_IDENTIFIER     = 32
ATTR_ACCT_SESSION_ID    = 44
ATTR_EVENT_TIMESTAMP    = 55
ATTR_MESSAGE_AUTH       = 80

RADIUS_SECRET = b"Huawei@Radius123"             # 与 FreeRADIUS clients.conf 一致
SERVER_IP     = "10.10.30.100"


def encode_radius_attr(attr_type: int, value: bytes) -> bytes:
    """编码一个 RADIUS 属性 (Type-Length-Value)。"""
    length = 2 + len(value)
    return struct.pack("!BB", attr_type, length) + value


def encode_ip_addr(ip_str: str) -> bytes:
    """将 IP 字符串编码为 4 字节网络序。"""
    return socket.inet_aton(ip_str)


def make_authenticator() -> bytes:
    """生成 16 字节随机 Authenticator。"""
    return os.urandom(16)


def make_message_authenticator(packet: bytes, secret: bytes) -> bytes:
    """
    计算 Message-Authenticator (RFC 3579 §3.2)。
    HMAC-MD5(secret, 整个包 + Message-Authenticator 属性的 value 置零)。
    """
    return hmac.new(secret, packet, hashlib.md5).digest()


def build_disconnect_packet(
    identifier: int,
    authenticator: bytes,
    attrs: list[tuple[int, bytes]],
    secret: bytes,
) -> bytes:
    """构造 Disconnect-Request 报文（含 Message-Authenticator 签名）。"""
    # 阶段一：先构造不含 Message-Authenticator 的属性区
    attrs_without_hmac = attrs[:]

    # 预留 Message-Authenticator 占位（16 字节全零）
    zero_hmac = encode_radius_attr(ATTR_MESSAGE_AUTH, b"\x00" * 16)
    attrs_with_placeholder = attrs_without_hmac + [(ATTR_MESSAGE_AUTH, b"\x00" * 16)]

    # 编码属性区（不含 HMAC 属性体，用于长度计算）
    avp_body = b""
    for t, v in attrs_with_placeholder:
        avp_body += encode_radius_attr(t, v)

    # 构造包体：code(1) + id(1) + len(2) + authenticator(16) + attributes
    pkt_len = 20 + len(avp_body)
    header = struct.pack("!BBH", RADIUS_DISCONNECT_REQUEST, identifier, pkt_len)
    packet_without_auth = header + authenticator + avp_body

    # 计算 Message-Authenticator
    hmac_val = make_message_authenticator(packet_without_auth, secret)

    # 阶段二：用真实 HMAC 替换占位
    real_hmac_attr = encode_radius_attr(ATTR_MESSAGE_AUTH, hmac_val)
    avp_final = b""
    for t, v in attrs:
        avp_final += encode_radius_attr(t, v)
    avp_final += real_hmac_attr

    pkt_len = 20 + len(avp_final)
    header = struct.pack("!BBH", RADIUS_DISCONNECT_REQUEST, identifier, pkt_len)
    return header + authenticator + avp_final


def send_disconnect(attrs: list[tuple[int, bytes]], secret: bytes) -> tuple[int, str]:
    """发送 Disconnect-Request 并等待响应。"""
    identifier = os.urandom(1)[0] & 0xFF
    authenticator = make_authenticator()
    packet = build_disconnect_packet(identifier, authenticator, attrs, secret)

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(5)
        sock.sendto(packet, (SERVER_IP, RADIUS_PORT))

        try:
            data, _ = sock.recvfrom(4096)
            # 解析响应：code(1) + id(1) + len(2)
            resp_code = data[0]
            resp_id = data[1]
            if resp_code == 41:  # Disconnect-ACK
                return 0, f"Disconnect-ACK (id={resp_id})"
            elif resp_code == 42:  # Disconnect-NAK
                return 1, f"Disconnect-NAK (id={resp_id}) — 用户可能已不在线或 NAS 不可达"
            else:
                return 2, f"未知响应码 {resp_code} (id={resp_id})"
        except socket.timeout:
            return 3, "超时 — FreeRADIUS 未响应 CoA 请求"


def main():
    parser = argparse.ArgumentParser(description="CoA 强制踢用户下线")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--user", help="用户名 (User-Name)")
    group.add_argument("--framed-ip", help="终端 IP (Framed-IP-Address)")
    group.add_argument("--calling-station", help="终端 MAC (Calling-Station-Id)")
    group.add_argument("--session-id", help="计费会话 ID (Acct-Session-Id)")
    parser.add_argument("--nas", help="指定 NAS IP (默认广播所有 NAS)")
    parser.add_argument("--secret", default=RADIUS_SECRET.decode(),
                        help="共享密钥")
    args = parser.parse_args()

    secret = args.secret.encode()

    attrs = []
    if args.user:
        attrs.append((ATTR_USER_NAME, args.user.encode()))
    if args.framed_ip:
        attrs.append((ATTR_FRAMED_IP_ADDRESS, encode_ip_addr(args.framed_ip)))
    if args.calling_station:
        attrs.append((ATTR_CALLING_STATION_ID, args.calling_station.encode()))
    if args.session_id:
        attrs.append((ATTR_ACCT_SESSION_ID, args.session_id.encode()))
    if args.nas:
        attrs.append((ATTR_NAS_IP_ADDRESS, encode_ip_addr(args.nas)))

    if not attrs:
        print("ERROR: 至少需要 user / framed-ip / calling-station / session-id 之一")
        sys.exit(1)

    print(f"发送 Disconnect-Request → FreeRADIUS {SERVER_IP}:{RADIUS_PORT}")
    print(f"属性: { {t: v.hex() if len(v) <= 4 else v.hex()[:20]+'...' for t, v in attrs} }")

    code, msg = send_disconnect(attrs, secret)
    if code == 0:
        print(f"✓ {msg}")
    else:
        print(f"✗ {msg}", file=sys.stderr)
    sys.exit(code)


if __name__ == "__main__":
    main()
```

### 8.4 CoA 使用示例

```bash
# 踢指定用户
python3 coa_disconnect.py --user zhangsan

# 踢指定 IP 的终端
python3 coa_disconnect.py --framed-ip 192.168.100.50

# 踢指定 MAC 的终端（精确）
python3 coa_disconnect.py --calling-station 00-11-22-33-44-55

# 踢指定 NAS 上的用户
python3 coa_disconnect.py --user zhangsan --nas 10.10.30.11

# 通过计费会话 ID 踢（最精确）
python3 coa_disconnect.py --session-id "0A0A1E0B-00000001"
```

### 8.5 通过 daloRADIUS 踢用户

daloRADIUS 内置了 CoA 功能：
1. **Reports** → **Online Users**
2. 找到目标用户 → 点击 **Disconnect** 按钮

前提是在 daloRADIUS 的 CoA 配置中正确填写了 NAS secret。

---

## 九、测试验证

### 9.1 本地账号连通性测试

```bash
# 先在数据库或 users 文件中创建测试账号
# 编辑 /etc/freeradius/3.0/users，添加：
echo 'testuser Cleartext-Password := "test123"' >> /etc/freeradius/3.0/users
systemctl reload freeradius

# radtest 测试
radtest testuser test123 127.0.0.1 0 testing123

# 预期输出最后一行：
# Received Access-Accept Id 123 from 127.0.0.1:1812 to 127.0.0.1:32768 length 20
```

### 9.2 前台调试模式（排查必用）

```bash
systemctl stop freeradius
freeradius -X 2>&1 | tee /tmp/radius-debug.log
```

然后在终端发起 802.1X 认证，观察日志输出：
- `Login OK` → 认证成功
- 检查返回的属性中是否包含 `Tunnel-Type = VLAN` 等三条属性
- 检查是否有 `SQL` 模块的相关日志

### 9.3 华为设备侧验证

```bash
# 查看 RADIUS 服务器状态
display radius-server configuration
display radius-server statistics

# 查看 802.1X 会话
display dot1x sessions

# 查看在线用户
display access-user

# 查看接口 VLAN 状态（认证成功后应切换到动态 VLAN）
display interface GigabitEthernet0/0/1
```

### 9.4 端到端验证清单

| 检查项 | 命令/操作 | 预期结果 |
|--------|-----------|----------|
| FreeRADIUS 语法 | `freeradius -XC` | `Configuration appears to be OK` |
| 本地 radtest | `radtest testuser test123 127.0.0.1 0 testing123` | `Access-Accept` |
| 端口监听 | `ss -uln \| grep -E '1812\|1813\|3799'` | 三个端口均有 LISTEN |
| 华为到 RADIUS 连通 | `ping 10.10.30.100` | 通 |
| 终端认证 | 手机/PC 连接 802.1X SSID | 成功获取 VLAN 对应 IP |
| 动态 VLAN | `display dot1x sessions` | VLAN 与分组一致 |
| CoA 踢人 | 执行 Python 脚本 | 终端断连 → 重新认证 |
| **Portal：DNS 放行** | 未认证终端执行 `nslookup baidu.com` | 能解析 DNS |
| **Portal：重定向** | 连接访客 SSID，浏览器访问 `http://1.1.1.1` | 弹出 Portal 登录页 |
| **Portal：认证** | 在 Portal 页输入账号密码登录 | 提示"认证成功"，可以上网 |
| **Portal：在线用户** | `display access-user` | Portal 用户出现在在线列表中 |
| **混合场景** | 同一端口：员工 802.1X → VLAN 100，访客 Portal → VLAN 200 | 各自获取对应 VLAN IP |

---

## 十、故障排查清单

| 现象 | 原因 | 排查动作 |
|------|------|----------|
| **Unknown client** | `clients.conf` 没写华为设备源 IP | 在调试日志中找 `Unknown client` 行，确认报文的 `NAS-IP-Address` 值 |
| **Invalid signature / 签名错误** | 两端 shared secret 不一致（最常见！） | 逐字符比对 `clients.conf` 和华为 `display radius-server` 中的密钥，注意前后不能有空格 |
| **Access-Reject** | 账号/密码错误、EAP 协商失败、数据库查不到用户 | `freeradius -X` 查看具体拒绝原因 |
| **认证成功但 VLAN 不切换** | ①接口未配 `dot1x dynamic-vlan enable` ②缺少三条 Tunnel 属性 ③属性值格式错误 | 拿 `freeradius -X` 日志看 Access-Accept 的返回属性；检查交换机接口配置 |
| **EAP 协商失败** | 证书问题、客户端配置问题 | Windows 客户端常见：检查证书信任、手动添加 Wi-Fi 配置时关闭"验证服务器证书"用于测试 |
| **防火墙拦截** | UDP 1812/1813/3799 未放行 | `tcpdump -i eth0 port 1812` 在 RADIUS 服务器上看是否收到报文 |
| **daloRADIUS 页面白屏** | PHP 扩展缺失 | `apt install php-gd php-curl php-mbstring php-xml` 后重启 Apache |
| **daloRADIUS 登录后空白** | 表结构不全 | 确认导入了 daloRADIUS 的 SQL 文件，检查 `operators` 等表是否存在 |
| **SQL 模块未生效** | 软链接或配置不正确 | 检查 `/etc/freeradius/3.0/mods-enabled/sql` 是否存在，且指向正确的文件 |
| **FreeRADIUS 启动失败** | 配置语法错误 | `freeradius -XC` 查看具体报错行 |
| **Portal：终端看不到登录页面** | ①DNS 未放行 ②`portal free-rule` 未配置 ③Portal Server 不可达 | `tcpdump -i eth0 port 2000` 检查 Portal 协议报文 |
| **Portal：登录后无法上网** | ①ACL 未正确下发 ②计费报文失败导致设备不下发权限 | `freeradius -X` 检查 Access-Accept 属性、查看 `radacct` 表计费记录 |
| **Portal：HTTPS 重定向失败** | 浏览器检测到中间人攻击（HSTS 域名） | 引导用户先访问 `http://neverssl.com` 或 `http://1.1.1.1` 触发 Portal |
| **Portal：华为私有协议对接失败** | Portal 协议版本/密钥/端口不匹配 | 检查华为 `portal server` 配置的 `port` 和 `shared-key`，抓包对比协议交互 |
| **Portal：内置 Portal 页面 CSS/JS 加载失败** | 华为设备 ACL 拦截了自身 Portal 资源 | `portal free-rule` 添加设备自身 IP 和 Portal 资源域名 |

---

## 十一、生产优化建议

### 11.1 系统层面

```bash
# 设置静态 IP，禁止 DHCP
# /etc/netplan/01-netcfg.yaml

# 关闭 FreeRADIUS 调试日志（/etc/freeradius/3.0/radiusd.conf）
# log { destination = syslog }   # 生产改用 syslog，不用 stdout

# 定期备份数据库
# crontab: 0 2 * * * mysqldump -u radius -p'CHANGE_ME_DB_PASS' radius | gzip > /backup/radius_$(date +\%Y\%m\%d).sql.gz
```

### 11.2 性能调优

| 配置项 | 文件 | 建议值 | 说明 |
|--------|------|--------|------|
| 最大请求数 | `radiusd.conf` | `max_requests = 4096` | 并发认证请求上限 |
| 线程池 | `radiusd.conf` | 等于 CPU 核数 | `num_threads` |
| 数据库连接池 | `mods-enabled/sql` | `pool { max = 32 }` | SQL 连接池大小 |
| 日志级别 | `radiusd.conf` | `auth = yes, auth_badpass = no, auth_goodpass = no` | 只记录失败日志，减少 I/O |

### 11.3 数据库维护

```sql
-- 清理 90 天前的计费记录
DELETE FROM radacct WHERE acctstoptime < DATE_SUB(NOW(), INTERVAL 90 DAY);

-- 建议做成定时任务
```

### 11.4 高可用部署

```
         ┌─────────────────┐
         │  华为交换机/AC    │
         │  radius-server   │
         │   primary: .100  │
         │  secondary: .101 │
         └───┬─────────┬───┘
             │         │
    ┌────────▼──┐  ┌──▼────────┐
    │ FR-01     │  │ FR-02     │
    │ .100      │  │ .101      │
    │ MariaDB ◄─┼──┼─► MariaDB │  (Galera Cluster 或 主从)
    │ daloRADIUS│  │ daloRADIUS│
    └───────────┘  └───────────┘
```

华为侧配置双 RADIUS 服务器：

```plaintext
radius-server template FR-RADIUS
 radius-server authentication 10.10.30.100 1812 source ip-address x.x.x.x weight 80
 radius-server authentication 10.10.30.101 1812 source ip-address x.x.x.x weight 40
 radius-server accounting 10.10.30.100 1813 source ip-address x.x.x.x weight 80
 radius-server accounting 10.10.30.101 1813 source ip-address x.x.x.x weight 40
 radius-server shared-key cipher Huawei@Radius123
```

> 华为默认优先选 weight 更高的服务器；weight 相同则按配置顺序。

### 11.5 对接企业 AD / LDAP（简化账号管理）

无需在 FreeRADIUS 中单独创建用户，直接验证域账号：

```bash
apt install freeradius-ldap
ln -s /etc/freeradius/3.0/mods-available/ldap /etc/freeradius/3.0/mods-enabled/
```

配置 `/etc/freeradius/3.0/mods-enabled/ldap`，指向 AD 域控后，用户用域账号密码即可完成 802.1X 认证。分组和 VLAN 映射仍通过 FreeRADIUS 本地 `radusergroup` 表控制。

> **注意**：该场景需要将 `authorize` 中的 `sql` 和 `ldap` 配合使用：LDAP 负责认证密码，SQL 负责授权属性（VLAN 等）。

---

## 十二、附录

### A. 完整数据库初始化一键脚本

```bash
#!/bin/bash
# init-radius-db.sh — 一键初始化 FreeRADIUS + daloRADIUS 数据库

set -e

DB_NAME="radius"
DB_USER="radius"
DB_PASS="CHANGE_ME_DB_PASS"
FR_SCHEMA="/etc/freeradius/3.0/mods-config/sql/main/mysql/schema.sql"
DALO_SCHEMA="/var/www/html/daloradius-web/contrib/db/fr2-mysql-daloradius-and-freeradius.sql"

echo ">>> 创建数据库和用户..."
sudo mysql -e "
  CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
  GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
  FLUSH PRIVILEGES;
"

echo ">>> 导入 FreeRADIUS 表结构..."
mysql -u ${DB_USER} -p${DB_PASS} ${DB_NAME} < ${FR_SCHEMA}

echo ">>> 导入 daloRADIUS 表结构..."
mysql -u ${DB_USER} -p${DB_PASS} ${DB_NAME} < ${DALO_SCHEMA}

echo ">>> 导入预置数据（分组 VLAN 属性）..."
mysql -u ${DB_USER} -p${DB_PASS} ${DB_NAME} <<'EOF'
INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES
('staff-vlan100', 'Tunnel-Type',            ':=', 'VLAN'),
('staff-vlan100', 'Tunnel-Medium-Type',     ':=', 'IEEE-802'),
('staff-vlan100', 'Tunnel-Private-Group-ID',':=', '100'),
('guest-vlan200', 'Tunnel-Type',            ':=', 'VLAN'),
('guest-vlan200', 'Tunnel-Medium-Type',     ':=', 'IEEE-802'),
('guest-vlan200', 'Tunnel-Private-Group-ID',':=', '200');

-- 创建测试用户
INSERT INTO radcheck (username, attribute, op, value) VALUES
('teststaff', 'Cleartext-Password', ':=', 'Test@123'),
('testguest', 'Cleartext-Password', ':=', 'Test@123');

INSERT INTO radusergroup (username, groupname, priority) VALUES
('teststaff', 'staff-vlan100', 1),
('testguest', 'guest-vlan200', 1);
EOF

echo ">>> 数据库初始化完成！"
```

### B. 常用命令速查

```bash
# 服务控制
systemctl start|stop|restart|reload freeradius
systemctl status freeradius
journalctl -u freeradius -f             # 查看服务日志

# 语法检查
freeradius -XC                           # 配置语法检查
freeradius -X                            # 前台调试

# 端口监听确认
ss -uln | grep -E '1812|1813|3799'

# 抓包排错
tcpdump -i any -n udp port 1812 -A       # 抓认证报文
tcpdump -i any -n udp port 3799 -A       # 抓 CoA 报文

# 数据库
mysql -u radius -p radius -e "SELECT * FROM radcheck;"
mysql -u radius -p radius -e "SELECT * FROM radusergroup;"
mysql -u radius -p radius -e "SELECT * FROM radgroupreply;"

# 导出/恢复数据库
mysqldump -u radius -p radius > radius_backup.sql
mysql -u radius -p radius < radius_backup.sql
```

### C. 参考资源

| 资源 | 链接 |
|------|------|
| FreeRADIUS 官方文档 | https://wiki.freeradius.org/ |
| FreeRADIUS SQL 配置 | https://wiki.freeradius.org/guide/SQL-HOWTO |
| daloRADIUS GitHub | https://github.com/lirantal/daloradius |
| 华为 802.1X 配置指南 | https://support.huawei.com/enterprise/ |
| RFC 2865 (RADIUS) | https://tools.ietf.org/html/rfc2865 |
| RFC 3576 (CoA/DM) | https://tools.ietf.org/html/rfc3576 |
| RFC 3580 (802.1X RADIUS) | https://tools.ietf.org/html/rfc3580 |
