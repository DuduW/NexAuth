# FreeRADIUS 纯 Portal 认证部署方案

## 适配华为 AC / 交换机 · Portal Web 认证 · 动态 VLAN/ACL · CoA 强制下线

> **目标场景**：园区网络纯 Portal（Web）认证，终端连接网络后通过浏览器页面输入用户名密码完成认证，FreeRADIUS 作为 AAA 后端统一验证并下发 VLAN/ACL/限速策略，支持管理员远程踢人。

---

## 一、为什么选 Portal 而不是 802.1X

| 对比维度 | Portal 认证 | 802.1X 认证 |
|----------|------------|-------------|
| **客户端要求** | 无，有浏览器即可 | 需要操作系统原生支持或安装客户端 |
| **打印机/IP 电话/IoT** | 可通过 MAC 旁路认证 | 需要设备支持 802.1X Supplicant |
| **访客体验** | 连接 Wi-Fi → 弹出页面 → 输账号密码 | 需要预先配置 Wi-Fi 安全参数 |
| **部署复杂度** | 低（Portal 页面 + RADIUS） | 中（证书 + 客户端配置 + GPO/ MDM） |
| **安全性** | 用户名密码明文传输（Portal 页面 HTTPS 可加密） | PEAP/MSCHAPv2 隧道加密 |
| **适合场景** | 访客 Wi-Fi、商场/酒店/校园 Portal 认证、ISP 宽带 | 企业内网办公终端、高安全机房 |

> **结论**：如果你的终端类型多样（手机/PC/打印机/IoT）、追求零客户端部署、有访客接入需求，Portal 认证是更合适的选择。

---

## 二、技术架构

### 2.1 整体架构

```
┌──────────────────────────────────────────────────────┐
│                  FreeRADIUS 服务器                     │
│                                                      │
│  ┌───────────────┐  ┌──────────────┐                 │
│  │ freeradius    │  │  MariaDB     │                 │
│  │ (AAA 引擎)    │◄─┤ (账号/分组/  │                 │
│  │ PAP / CHAP    │  │  计费存储)    │                 │
│  └───────┬───────┘  └──────────────┘                 │
│          │          ┌──────────────┐                 │
│          │          │ daloRADIUS   │  Web 管理面板   │
│          │          └──────────────┘                 │
└──────────┼────────────────────────────────────────────┘
           │ RADIUS UDP (1812 Auth / 1813 Acct / 3799 CoA)
           │
    ┌──────┴──────────────────────┐
    │      华为交换机 / AC         │
    │  ┌──────────────────────┐   │
    │  │ 内置 Portal Server    │   │  ← 提供登录页面
    │  │ (监听 2000 端口)      │   │
    │  └──────────────────────┘   │
    │  ┌──────────────────────┐   │
    │  │ RADIUS Client (NAS)   │   │  ← 向 FreeRADIUS 发认证
    │  └──────────────────────┘   │
    └──────────────┬───────────────┘
                   │ Portal 页面 / RADIUS
    ┌──────────────┴───────────────┐
    │         终端设备               │
    │   手机 / PC / 打印机 / IoT    │
    │   (有浏览器即可认证)           │
    └──────────────────────────────┘
```

### 2.2 Portal 认证流程

```
 终端                  华为 AC/交换机                FreeRADIUS
  │                        │                           │
  │  1. 连接 SSID          │                           │
  │  2. 获取 IP (DHCP)     │                           │
  │  3. 访问任意网址        │                           │
  │ ──────────────────────►│                           │
  │                        │  4. 截获 HTTP，重定向      │
  │  5. Portal 登录页       │  (http://1.1.1.1 →       │
  │  ◄─────────────────────│   Portal 页面)             │
  │                        │                           │
  │  6. 输入用户名/密码     │                           │
  │ ──────────────────────►│                           │
  │                        │  7. RADIUS                │
  │                        │   Access-Request          │
  │                        │  (PAP/CHAP)               │
  │                        │ ─────────────────────────►│
  │                        │                           │  8. 数据库验证
  │                        │  9. Access-Accept         │
  │                        │  (VLAN/ACL/限速/时长)      │
  │                        │ ◄─────────────────────────│
  │                        │                           │
  │ 10. 认证成功页面        │  11. 开始计费 (Acct-Start) │
  │ ◄──────────────────────│ ─────────────────────────►│
  │                        │                           │
  │ 12. 正常上网            │                           │
  │ ◄══════════════════════►│                           │
  │                        │                           │
  │                        │  13. 定期上报计费          │
  │                        │   (Acct-Interim)          │
  │                        │ ─────────────────────────►│
  │                        │                           │
  │ 14. 用户主动断开/超时   │  15. 计费结束             │
  │                        │   (Acct-Stop)             │
  │                        │ ─────────────────────────►│
```

---

## 三、部署环境规划

| 项目 | 推荐值 |
|------|--------|
| **OS** | Ubuntu 22.04 LTS |
| **配置** | 2C4G / 50G 磁盘 |
| **FreeRADIUS IP** | `10.10.30.100` |
| **华为 AC 源 IP** | `10.10.30.10` |
| **华为交换机源 IP** | `10.10.30.11` |
| **共享密钥** | `Huawei@Radius123` |
| **数据库密码** | `CHANGE_ME_DB_PASS` |
| **访客 VLAN** | `200`（Portal 用户认证后划入） |
| **认证前 VLAN** | `99`（未认证隔离） |

---

## 四、FreeRADIUS 安装部署

### 4.1 系统初始化

```bash
apt update && apt upgrade -y

apt install -y \
  freeradius freeradius-mysql \
  mariadb-server \
  apache2 \
  php php-mysql php-gd php-curl php-mbstring php-xml \
  libapache2-mod-php \
  git unzip
```

### 4.2 数据库初始化

```bash
sudo mysql -u root
```

```sql
CREATE DATABASE radius
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'radius'@'localhost' IDENTIFIED BY 'CHANGE_ME_DB_PASS';
GRANT ALL PRIVILEGES ON radius.* TO 'radius'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

导入表结构：

```bash
mysql -u radius -p radius < /etc/freeradius/3.0/mods-config/sql/main/mysql/schema.sql
```

### 4.3 启用 SQL 模块

```bash
ln -sf /etc/freeradius/3.0/mods-available/sql /etc/freeradius/3.0/mods-enabled/
```

编辑 `/etc/freeradius/3.0/mods-enabled/sql`：

```ini
sql {
    dialect = "mysql"
    driver = "rlm_sql_${dialect}"
    server = "localhost"
    port = 3306
    login = "radius"
    password = "CHANGE_ME_DB_PASS"
    radius_db = "radius"
    read_clients = no
}
```

### 4.4 配置华为设备客户端

编辑 `/etc/freeradius/3.0/clients.conf`：

```ini
client huawei-ac {
    ipaddr      = 10.10.30.10
    secret      = Huawei@Radius123
    shortname   = AC_MAIN
    nastype     = other
}

client huawei-sw {
    ipaddr      = 10.10.30.11
    secret      = Huawei@Radius123
    shortname   = SW_ACC
    nastype     = other
}
```

### 4.5 认证站点接入 SQL

> **Portal 认证只用 PAP/CHAP，无需配置 EAP 模块。**

编辑 `/etc/freeradius/3.0/sites-enabled/default`：

```plaintext
authorize {
    preprocess
    suffix
    files
    sql               # 从数据库读取用户信息
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
    Auth-Type SQL {
        sql
    }
}

accounting {
    detail
    unix
    sql               # 计费写入数据库
}
```

### 4.6 安装 daloRADIUS 管理面板

```bash
cd /var/www/html
git clone https://github.com/lirantal/daloradius.git
mv daloradius daloradius-web
chown -R www-data:www-data /var/www/html/daloradius-web
```

导入表结构：

```bash
mysql -u radius -p radius < /var/www/html/daloradius-web/contrib/db/fr2-mysql-daloradius-and-freeradius.sql
```

配置数据库连接 `/var/www/html/daloradius-web/library/daloradius.conf.php`：

```php
$configValues['CONFIG_DB_HOST'] = 'localhost';
$configValues['CONFIG_DB_PORT'] = '3306';
$configValues['CONFIG_DB_USER'] = 'radius';
$configValues['CONFIG_DB_PASS'] = 'CHANGE_ME_DB_PASS';
$configValues['CONFIG_DB_NAME'] = 'radius';
$configValues['FREERADIUS_VERSION'] = '3';
```

访问：`http://10.10.30.100/daloradius-web`（默认 `administrator` / `radius`）

### 4.7 防火墙 & 启动

```bash
ufw allow 1812/udp    # RADIUS Auth
ufw allow 1813/udp    # RADIUS Acct
ufw allow 3799/udp    # CoA/DM
ufw allow 80/tcp      # daloRADIUS

freeradius -XC         # 检查语法
systemctl enable freeradius
systemctl start freeradius
```

---

## 五、华为设备 Portal 配置

### 5.1 方式一：华为内置 Portal（推荐，零额外组件）

利用华为设备自带的简易 Portal 登录页面，无需部署外部 Portal Server。

#### 5.1.1 交换机有线 Portal

```plaintext
#
# ==== RADIUS 模板 ====
#
radius-server template FR-RADIUS
 radius-server authentication 10.10.30.100 1812 source ip-address 10.10.30.11 weight 80
 radius-server accounting 10.10.30.100 1813 source ip-address 10.10.30.11 weight 80
 radius-server shared-key cipher Huawei@Radius123
 radius-server retransmit 2 timeout 5
#
radius-server coa enable
radius-server client ip-address 10.10.30.100 shared-key cipher Huawei@Radius123

#
# ==== Portal 服务器（内置） ====
#
portal server portal-local
 server-ip 10.10.30.11              # 本设备 IP
 port 2000                           # Portal 协议端口
 shared-key cipher Huawei@Radius123
 protocol http                       # 生产建议 https（需 SSL 策略）

#
# ==== Portal 接入模板 ====
#
portal-access-profile name portal-guest
 portal-server portal-local

#
# ==== 免认证规则（Portal 认证前允许的流量） ====
# 至少放行：DNS、FreeRADIUS 服务器、Portal 页面自身
#
free-rule-template name portal-free
 free-rule 1 destination ip 10.10.30.100 mask 32        # FreeRADIUS
 free-rule 2 destination ip any udp 53                  # DNS
 free-rule 3 destination ip 10.10.30.11 mask 32         # Portal 页面自身

#
# ==== AAA ====
#
aaa
 authentication-scheme portal-auth
  authentication-mode radius
 authorization-scheme portal-authz
  authorization-mode radius
 accounting-scheme portal-acct
  accounting-mode radius
  accounting start-fail online                           # 计费失败也不踢人

domain default
 authentication-scheme portal-auth
 authorization-scheme portal-authz
 accounting-scheme portal-acct
 radius-server FR-RADIUS

#
# ==== 接口配置 ====
#
interface GigabitEthernet0/0/1
 port link-type access
 port default vlan 99                     # 认证前隔离 VLAN
 authentication portal                    # ← Portal 认证（非 802.1X）
 portal free-rule-template portal-free
 portal access-profile portal-guest
```

**用户流程**：终端插网线 → 获取 VLAN 99 的 IP → 打开浏览器访问任意网站 → 弹出 Portal 登录页 → 输入账号密码 → 认证通过 → 继续上网。

#### 5.1.2 AC 无线 Portal

```plaintext
#
# ==== RADIUS / Portal / AAA 同交换机 ====
#

#
# ==== WLAN 配置 ====
#
wlan
 security-profile name open-portal
  security open                           # 开放 SSID，不加密
#
 ssid-profile name Guest-WiFi
  ssid Guest-WiFi
#
 vap-profile name guest-vap
  forward-mode tunnel
  service-vlan vlan-id 200               # 业务 VLAN（可被 RADIUS 动态覆盖）
  ssid-profile Guest-WiFi
  security-profile open-portal
  authentication portal                  # Portal 认证
  portal-access-profile portal-guest
```

**用户流程**：手机连接 `Guest-WiFi` SSID → 自动弹出 Portal 登录页（iOS/Android 原生支持）→ 输入账号密码 → 上网。

### 5.2 方式二：外置 Portal Server（可定制品牌页面）

如果需要定制 Portal 页面的 Logo、广告、社交媒体登录等功能，需部署独立的 Portal Server。

#### 5.2.1 部署 Python Portal Server

```python
#!/usr/bin/env python3
"""
portal_server.py — 定制 Portal 登录服务 + FreeRADIUS 后端
"""

import pyrad.packet
from pyrad.client import Client
from pyrad.dictionary import Dictionary
from flask import Flask, request, render_template_string

app = Flask(__name__)

RADIUS_SERVER = "127.0.0.1"
RADIUS_SECRET = b"testing123"

LOGIN_PAGE = """
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>公司访客认证</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Microsoft YaHei', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
         display: flex; justify-content: center; align-items: center; min-height: 100vh; }
  .card { background: white; border-radius: 16px; padding: 48px 40px; width: 380px;
          box-shadow: 0 20px 60px rgba(0,0,0,.3); text-align: center; }
  .logo { font-size: 48px; margin-bottom: 8px; }
  h2 { color: #333; margin-bottom: 24px; font-weight: 500; }
  .input-group { margin-bottom: 16px; text-align: left; }
  label { display: block; color: #666; font-size: 14px; margin-bottom: 6px; }
  input { width: 100%; padding: 12px 16px; border: 2px solid #e8e8e8; border-radius: 8px;
          font-size: 15px; transition: border-color .3s; outline: none; }
  input:focus { border-color: #667eea; }
  button { width: 100%; padding: 14px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
           color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer;
           margin-top: 8px; transition: opacity .3s; }
  button:hover { opacity: 0.9; }
  .footer { margin-top: 24px; font-size: 12px; color: #999; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">🌐</div>
  <h2>访客 Wi-Fi 认证</h2>
  <form method="POST">
    <div class="input-group">
      <label>手机号 / 用户名</label>
      <input name="username" placeholder="请输入手机号" required autofocus>
    </div>
    <div class="input-group">
      <label>验证码 / 密码</label>
      <input name="password" type="password" placeholder="请输入密码" required>
    </div>
    <button type="submit">立即上网</button>
  </form>
  <div class="footer">如有问题请联系 IT 服务台</div>
</div>
</body>
</html>
"""


def radius_auth(username: str, password: str) -> tuple[bool, str]:
    """向 FreeRADIUS 发送 PAP 认证请求。"""
    client = Client(
        server=RADIUS_SERVER,
        secret=RADIUS_SECRET,
        dict=Dictionary("/usr/share/freeradius/dictionary"),
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
        return False, f"认证服务异常: {e}"


@app.route("/", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        success, msg = radius_auth(username, password)
        if success:
            return f"<html><body style='text-align:center;padding-top:100px;font-family:sans-serif'><h2>认证成功</h2><p>请关闭此页面继续上网</p></body></html>"
        else:
            # 登录失败，重新显示页面并提示错误
            return render_template_string(
                LOGIN_PAGE.replace(
                    '<button type="submit">立即上网</button>',
                    f'<p style="color:#e74c3c;margin-bottom:8px">{msg}</p><button type="submit">重试</button>',
                )
            )
    return render_template_string(LOGIN_PAGE)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=False)
```

```bash
# 安装依赖并启动
pip3 install pyrad flask
python3 portal_server.py
```

#### 5.2.2 华为设备对接外置 Portal

```plaintext
#
# 华为 AC/交换机上指向外置 Portal Server
#
portal server portal-external
 server-ip 10.10.30.200               # Portal Server IP
 port 50100                            # Portal 协议端口（与 portal_server.py 不同，这是华为协议端口）
 shared-key cipher Huawei@Radius123
 protocol http

portal-access-profile name portal-custom
 portal-server portal-external
```

> **注意**：外置 Portal Server 需要实现华为 Portal 协议（Challenge → Request → Auth-Ack 三次握手），不是简单的 HTTP POST。上述 Python 示例仅展示架构，完整实现需按华为 Portal 协议规范开发。

### 5.3 多 SSID / 多场景 Portal

```
         ┌──────────────────────────────────┐
         │          FreeRADIUS               │
         │   Called-Station-ID 策略分发      │
         └────────────┬─────────────────────┘
                      │
        ┌─────────────┼─────────────┐
        │             │             │
   ┌────▼────┐  ┌────▼────┐  ┌────▼────┐
   │Guest-WiFi│  │Staff-Portal│ │Meeting │
   │ VLAN 200│  │ VLAN 300   │ │ VLAN 400│
   │ 限速4M  │  │ 不限速     │ │ 限时2h  │
   └─────────┘  └───────────┘ └─────────┘
```

华为 AC 侧配置多个 VAP + 多 Portal 模板：

```plaintext
# 访客 VAP
vap-profile name guest-vap
 ssid-profile guest-ssid
 authentication portal
 portal-access-profile portal-guest

# 员工临时 Portal（例如工卡丢失时备用）
vap-profile name staff-portal-vap
 ssid-profile staff-portal-ssid
 authentication portal
 portal-access-profile portal-staff

# 会议室临时接入
vap-profile name meeting-vap
 ssid-profile meeting-ssid
 authentication portal
 portal-access-profile portal-meeting
```

FreeRADIUS 按 SSID 分流策略 (`/etc/freeradius/3.0/policy.d/portal-policy`)：

```plaintext
if (&Called-Station-ID =~ /Guest-WiFi/) {
    update reply {
        Tunnel-Type := VLAN
        Tunnel-Medium-Type := IEEE-802
        Tunnel-Private-Group-ID := "200"
        Session-Timeout := 86400
        Idle-Timeout := 1800
        HW-Input-Committed-Information-Rate := 2048000       # 上行 2M
        HW-Output-Committed-Information-Rate := 4096000      # 下行 4M
    }
}
elsif (&Called-Station-ID =~ /Staff-Portal/) {
    update reply {
        Tunnel-Type := VLAN
        Tunnel-Medium-Type := IEEE-802
        Tunnel-Private-Group-ID := "300"
    }
}
elsif (&Called-Station-ID =~ /Meeting/) {
    update reply {
        Tunnel-Type := VLAN
        Tunnel-Medium-Type := IEEE-802
        Tunnel-Private-Group-ID := "400"
        Session-Timeout := 7200                              # 会议室 2 小时
    }
}
```

---

## 六、用户与策略管理

### 6.1 创建 Portal 用户

**方式一：daloRADIUS 界面**

Management → Users → New User → 填写用户名密码 → 加入分组。

**方式二：数据库直操作**

```sql
-- 创建用户
INSERT INTO radcheck (username, attribute, op, value) VALUES
('guest01', 'Cleartext-Password', ':=', 'Guest@123'),
('guest02', 'Cleartext-Password', ':=', 'Guest@456');

-- 加入分组
INSERT INTO radusergroup (username, groupname, priority) VALUES
('guest01', 'group-guest', 1),
('guest02', 'group-guest', 1);
```

**方式三：批量生成访客账号**

```sql
-- 批量生成 100 个访客账号（username: guest001-guest100, password: 随机6位）
-- 用脚本生成 SQL：
```

```python
#!/usr/bin/env python3
"""批量生成访客账号 SQL"""
import random, string

for i in range(1, 101):
    username = f"guest{i:03d}"
    password = ''.join(random.choices(string.ascii_letters + string.digits, k=8))
    print(f"INSERT INTO radcheck (username, attribute, op, value) VALUES ('{username}', 'Cleartext-Password', ':=', '{password}');")
    print(f"INSERT INTO radusergroup (username, groupname, priority) VALUES ('{username}', 'group-guest', 1);")
```

### 6.2 分组策略（VLAN / ACL / 限速 / 时长）

**通过 SQL 批量配置分组属性**：

```sql
-- 访客组：VLAN 200 + 限速 4M + 24小时超时
INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES
('group-guest', 'Tunnel-Type',                   ':=', 'VLAN'),
('group-guest', 'Tunnel-Medium-Type',            ':=', 'IEEE-802'),
('group-guest', 'Tunnel-Private-Group-ID',       ':=', '200'),
('group-guest', 'Session-Timeout',               ':=', '86400'),
('group-guest', 'Idle-Timeout',                  ':=', '1800'),
('group-guest', 'HW-Input-Committed-Information-Rate',  ':=', '2048000'),
('group-guest', 'HW-Output-Committed-Information-Rate', ':=', '4096000');

-- 员工组：VLAN 300 + 不限速
INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES
('group-staff', 'Tunnel-Type',             ':=', 'VLAN'),
('group-staff', 'Tunnel-Medium-Type',      ':=', 'IEEE-802'),
('group-staff', 'Tunnel-Private-Group-ID', ':=', '300');

-- VIP 组：VLAN 500 + ACL 3000 + 不限时
INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES
('group-vip', 'Tunnel-Type',             ':=', 'VLAN'),
('group-vip', 'Tunnel-Medium-Type',      ':=', 'IEEE-802'),
('group-vip', 'Tunnel-Private-Group-ID', ':=', '500'),
('group-vip', 'Filter-ID',               ':=', 'vip-acl-3000');
```

### 6.3 常用 RADIUS 授权属性速查

| 属性 | 值示例 | 说明 |
|------|--------|------|
| `Tunnel-Type` | `VLAN` | 隧道类型 = VLAN |
| `Tunnel-Medium-Type` | `IEEE-802` | 隧道介质 |
| `Tunnel-Private-Group-ID` | `200` | 目标 VLAN ID |
| `Session-Timeout` | `86400` | 会话总时长（秒），到期强制断开 |
| `Idle-Timeout` | `1800` | 空闲超时（秒） |
| `Filter-ID` | `vip-acl-3000` | 华为设备上预定义的 ACL 编号/名称 |
| `HW-Input-Committed-Information-Rate` | `2048000` | 上行承诺速率（bps） |
| `HW-Output-Committed-Information-Rate` | `4096000` | 下行承诺速率（bps） |
| `Reply-Message` | `欢迎使用访客网络` | 认证成功后的提示消息 |
| `Acct-Interim-Interval` | `600` | 计费更新间隔（秒） |

---

## 七、CoA 强制用户下线

Portal 用户的 CoA 踢人机制与 802.1X 完全相同。FreeRADIUS 通过 UDP 3799 发送 Disconnect-Message，华为设备收到后断开终端连接。

### 7.1 前提

- FreeRADIUS 监听 3799（默认）
- 华为设备已配 `radius-server coa enable` + `radius-server client ip-address x.x.x.x`

### 7.2 Python CoA 脚本

```python
#!/usr/bin/env python3
"""
coa_disconnect.py — 踢 Portal 用户下线
用法: python3 coa_disconnect.py --user guest01
"""

import argparse, hashlib, hmac, os, socket, struct, sys

RADIUS_DISCONNECT_REQUEST = 40
RADIUS_PORT = 3799
ATTR_USER_NAME = 1
ATTR_NAS_IP_ADDRESS = 4
ATTR_FRAMED_IP_ADDRESS = 8
ATTR_CALLING_STATION_ID = 31
ATTR_MESSAGE_AUTH = 80

RADIUS_SECRET = b"Huawei@Radius123"
SERVER_IP = "10.10.30.100"


def encode_attr(t: int, v: bytes) -> bytes:
    return struct.pack("!BB", t, 2 + len(v)) + v


def encode_ip(ip: str) -> bytes:
    return socket.inet_aton(ip)


def make_auth() -> bytes:
    return os.urandom(16)


def build_dm(ident: int, auth: bytes, attrs: list, secret: bytes) -> bytes:
    # 先算 Message-Authenticator
    avp = b""
    for t, v in attrs + [(ATTR_MESSAGE_AUTH, b"\x00" * 16)]:
        avp += encode_attr(t, v)
    header = struct.pack("!BBH", RADIUS_DISCONNECT_REQUEST, ident, 20 + len(avp))
    hmac_md5 = hmac.new(secret, header + auth + avp, hashlib.md5).digest()

    # 构造最终报文
    avp_final = b""
    for t, v in attrs:
        avp_final += encode_attr(t, v)
    avp_final += encode_attr(ATTR_MESSAGE_AUTH, hmac_md5)
    header = struct.pack("!BBH", RADIUS_DISCONNECT_REQUEST, ident, 20 + len(avp_final))
    return header + auth + avp_final


def send(attrs: list, secret: bytes) -> tuple[int, str]:
    ident = os.urandom(1)[0] & 0xFF
    auth = make_auth()
    packet = build_dm(ident, auth, attrs, secret)

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(5)
        s.sendto(packet, (SERVER_IP, RADIUS_PORT))
        try:
            data, _ = s.recvfrom(4096)
            code = data[0]
            if code == 41:
                return 0, "Disconnect-ACK — 踢人成功"
            elif code == 42:
                return 1, "Disconnect-NAK — 用户可能已不在线"
            return 2, f"未知响应码 {code}"
        except socket.timeout:
            return 3, "超时 — FreeRADIUS 未响应"


def main():
    parser = argparse.ArgumentParser(description="CoA 强制踢用户下线")
    g = parser.add_mutually_exclusive_group(required=True)
    g.add_argument("--user", help="用户名")
    g.add_argument("--framed-ip", help="终端 IP")
    g.add_argument("--mac", help="终端 MAC (xx-xx-xx-xx-xx-xx)")
    parser.add_argument("--nas", help="指定 NAS IP")
    args = parser.parse_args()

    attrs = []
    if args.user:
        attrs.append((ATTR_USER_NAME, args.user.encode()))
    if args.framed_ip:
        attrs.append((ATTR_FRAMED_IP_ADDRESS, encode_ip(args.framed_ip)))
    if args.mac:
        attrs.append((ATTR_CALLING_STATION_ID, args.mac.encode()))
    if args.nas:
        attrs.append((ATTR_NAS_IP_ADDRESS, encode_ip(args.nas)))

    print(f"发送 DM → FreeRADIUS {SERVER_IP}:{RADIUS_PORT}")
    code, msg = send(attrs, RADIUS_SECRET)
    print(f"{'✓' if code == 0 else '✗'} {msg}")
    sys.exit(code)


if __name__ == "__main__":
    main()
```

### 7.3 使用示例

```bash
# 踢指定用户
python3 coa_disconnect.py --user guest01

# 踢指定 IP
python3 coa_disconnect.py --framed-ip 192.168.200.50

# 踢指定 MAC
python3 coa_disconnect.py --mac 00-11-22-33-44-55
```

### 7.4 通过 daloRADIUS 踢人

Reports → Online Users → 找到目标 → 点击 **Disconnect**。

---

## 八、测试验证

### 8.1 本地 RADIUS 测试

```bash
# 创建测试用户
echo 'testuser Cleartext-Password := "test123"' >> /etc/freeradius/3.0/users
systemctl reload freeradius

# PAP 认证测试
radtest testuser test123 127.0.0.1 0 testing123
# 预期：Received Access-Accept
```

### 8.2 前台调试

```bash
systemctl stop freeradius
freeradius -X
```

在终端发起 Portal 登录，观察日志中的 `Access-Request` → `Access-Accept` 流程和返回属性。

### 8.3 端到端验证清单

| 检查项 | 操作 | 预期 |
|--------|------|------|
| RADIUS 服务 | `ss -uln \| grep 1812` | LISTEN |
| 本地 radtest | `radtest testuser test123 127.0.0.1 0 testing123` | Access-Accept |
| Portal 页面可达 | 连接访客 SSID → 访问 `http://1.1.1.1` | 弹出登录页 |
| Portal 认证成功 | 输入正确账号密码 | 页面显示"认证成功"，可以上网 |
| Portal 认证拒绝 | 输入错误密码 | 页面显示错误提示 |
| 动态 VLAN | `display access-user` | 用户 VLAN 与配置一致 |
| 计费记录 | `SELECT * FROM radacct ORDER BY acctstarttime DESC LIMIT 5;` | 有 Start 记录 |
| CoA 踢人 | `python3 coa_disconnect.py --user guest01` | 终端断连，回到 Portal 页 |
| 会话超时 | 等待 Session-Timeout 到期 | 终端自动断开 |

### 8.4 华为设备侧常用命令

```bash
# 查看 Portal 服务器状态
display portal server

# 查看 Portal 在线用户
display portal user all

# 查看所有在线用户
display access-user

# 查看 RADIUS 统计
display radius-server statistics

# 手动踢用户
portal cut-user username guest01
```

---

## 九、故障排查清单

| 现象 | 原因 | 排查 |
|------|------|------|
| **Portal 页面不弹出** | DNS 未放行 / 免认证规则未配 | `free-rule` 添加 DNS 和 Portal 服务器 IP |
| **Portal 页面弹出但输入后无反应** | Portal 协议端口不通 / 共享密钥不一致 | `display portal server` 查看状态，抓包 `udp port 2000` |
| **认证失败（Access-Reject）** | 用户名密码错误 / 数据库查不到 | `freeradius -X` 查看拒绝原因 |
| **认证成功但不能上网** | ACL 未放行 / 网关不通 | 检查用户 IP、网关、DNS 配置 |
| **认证成功但 VLAN 不对** | 分组属性缺失 / `Called-Station-ID` 策略未命中 | 查看 `radgroupreply` 表，`freeradius -X` 检查返回属性 |
| **HTTPS 网站打不开（Portal 场景）** | HSTS 导致浏览器拒绝 Portal 重定向 | 引导用户先访问 `http://neverssl.com` |
| **Unknown client** | `clients.conf` 没写华为设备 IP | `freeradius -X` 中找到报错行，确认源 IP |
| **daloRADIUS 白屏** | PHP 扩展缺失 | `apt install php-gd php-curl php-mbstring php-xml` |
| **计费记录为空** | `sql` 模块未在 accounting 区块启用 | 检查 `sites-enabled/default` 的 `accounting { sql }` |

---

## 十、生产优化建议

### 10.1 安全加固

```bash
# Portal 登录页走 HTTPS
portal server portal-local
 protocol https
 ssl-policy portal-ssl

# 限制 RADIUS 仅接受管理网段
iptables -A INPUT -p udp --dport 1812 -s 10.10.30.0/24 -j ACCEPT
iptables -A INPUT -p udp --dport 1812 -j DROP

# 共享密钥至少 16 位
openssl rand -base64 16
```

### 10.2 数据库维护

```sql
-- 清理 90 天前计费记录
DELETE FROM radacct WHERE acctstoptime < DATE_SUB(NOW(), INTERVAL 90 DAY);

-- 定期备份
-- crontab: 0 2 * * * mysqldump -u radius -p'CHANGE_ME_DB_PASS' radius | gzip > /backup/radius_$(date +\%Y\%m\%d).sql.gz
```

### 10.3 性能调优

| 配置 | 文件 | 建议值 |
|------|------|--------|
| 最大并发 | `radiusd.conf` | `max_requests = 4096` |
| SQL 连接池 | `mods-enabled/sql` | `pool { max = 32 }` |
| 日志 | `radiusd.conf` | `auth_badpass = no, auth_goodpass = no`（只记失败） |

### 10.4 高可用

```plaintext
# 华为侧双 RADIUS
radius-server template FR-RADIUS
 radius-server authentication 10.10.30.100 1812 weight 80
 radius-server authentication 10.10.30.101 1812 weight 40
 radius-server accounting 10.10.30.100 1813 weight 80
 radius-server accounting 10.10.30.101 1813 weight 40
```

两台 FreeRADIUS + MariaDB Galera Cluster 或主从复制。

### 10.5 Portal 页面 HTTPS + 域名

生产环境建议为 Portal 页面申请合法域名和证书：

```plaintext
# 华为侧指向 HTTPS Portal
portal server portal-local
 server-ip 10.10.30.11
 port 2000
 protocol https
 ssl-policy portal-ssl
 redirect-url https://portal.yourcompany.com/login
```

> 合法证书可避免浏览器证书警告，提升访客体验。

---

## 十一、附录

### A. 一键初始化数据库脚本

```bash
#!/bin/bash
set -e
DB="radius"
USER="radius"
PASS="CHANGE_ME_DB_PASS"

sudo mysql -e "
  CREATE DATABASE IF NOT EXISTS ${DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER IF NOT EXISTS '${USER}'@'localhost' IDENTIFIED BY '${PASS}';
  GRANT ALL ON ${DB}.* TO '${USER}'@'localhost';
  FLUSH PRIVILEGES;
"

mysql -u ${USER} -p${PASS} ${DB} < /etc/freeradius/3.0/mods-config/sql/main/mysql/schema.sql
mysql -u ${USER} -p${PASS} ${DB} < /var/www/html/daloradius-web/contrib/db/fr2-mysql-daloradius-and-freeradius.sql

# 预置分组和测试用户
mysql -u ${USER} -p${PASS} ${DB} <<'EOF'
INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES
('group-guest', 'Tunnel-Type', ':=', 'VLAN'),
('group-guest', 'Tunnel-Medium-Type', ':=', 'IEEE-802'),
('group-guest', 'Tunnel-Private-Group-ID', ':=', '200'),
('group-guest', 'Session-Timeout', ':=', '86400'),
('group-guest', 'Idle-Timeout', ':=', '1800');

INSERT INTO radcheck (username, attribute, op, value) VALUES
('testguest', 'Cleartext-Password', ':=', 'Test@123');
INSERT INTO radusergroup (username, groupname, priority) VALUES
('testguest', 'group-guest', 1);
EOF

echo ">>> 数据库初始化完成"
```

### B. 常用命令

```bash
# 服务
systemctl start|stop|restart|reload freeradius
journalctl -u freeradius -f

# 语法检查 & 调试
freeradius -XC
freeradius -X

# 端口
ss -uln | grep -E '1812|1813|3799'

# 数据库
mysql -u radius -p radius -e "SELECT username,value FROM radcheck;"
mysql -u radius -p radius -e "SELECT username,groupname FROM radusergroup;"
mysql -u radius -p radius -e "SELECT username,acctstarttime,acctstoptime FROM radacct ORDER BY acctstarttime DESC LIMIT 20;"

# 抓包
tcpdump -i any -n udp port 1812 -A   # 认证报文
tcpdump -i any -n udp port 2000 -A   # Portal 协议
```
