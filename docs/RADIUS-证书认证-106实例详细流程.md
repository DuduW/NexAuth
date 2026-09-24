# RADIUS 证书认证（EAP-TLS）106 实例详细流程

> **文档版本**：v1.0  
> **基于实测**：192.168.110.106 FreeRADIUS 3.0.26 + AC6003 SSID test022  
> **整理时间**：2026-09-17  
> **核心结论**：test022 在 AC 侧已配置为纯 802.1X，未开 MAC/Portal 截胡；当前弹账号密码框的根因是 **Windows 终端默认走 PEAP-MSCHAPv2 + 106 上 EAP-TLS 策略入口未挂接**。

---

## 一、环境与角色

| 角色 | 实体 | 关键信息 |
|------|------|---------|
| 终端 / Supplicant | Windows 笔记本/手机 | 需导入 ca.pem、客户端证书，WLAN 方法设为「智能卡或其他证书」 |
| Authenticator | AC6003 + AP | NAS-IP = 192.168.30.15，RADIUS 模板 default 指向 192.168.110.106:1812 |
| Authentication Server | FreeRADIUS 3.0.26 | 路径 /etc/freeradius/3.0/，Ubuntu/Debian 布局 |
| CA | qcc-radius-ca-2026 | 当前 106 上 certs/ 目录为 8/31 bootstrap 自签测试 CA，生产需替换 |

---

## 二、总体流程概览

```text
终端连 test022
   │
   ├─ 802.1X 触发（EAPOL-Start / EAP-Identity）
   │
   ├─ AC6003 封装 RADIUS Access-Request -> 192.168.110.106:1812
   │
   ├─ 106 校验 NAS（clients.conf）-> rlm_eap 分发
   │
   ├─ EAP 方法协商：终端请求 EAP-TLS（type 13）
   │
   ├─ TLS 握手：ClientHello / ServerHello+server.pem / CertificateRequest / ClientCert+私钥签名 / Finished
   │
   ├─ 关卡 B：OpenSSL 验证客户端证书（链/有效期/EKU/CRL）+ CertificateVerify 验签
   │
   ├─ 身份提取：CN/OU/Serial/Expiration 写入 session-state
   │
   ├─ 策略决策：check-eap-tls（106 当前未启用，直接放行）
   │      目标：SQL 三表联动 radius_certs -> radusergroup -> radgroupreply
   │
   ├─ Access-Accept 携带 Tunnel 三件套 + HUAWEI VSA QoS
   │
   ├─ AC6003 切换 VLAN、限速
   │
   └─ 终端上线，Accounting 写入 radacct
```

---

## 三、分阶段详细说明

### 阶段 0：证书预置（一次性）

**终端侧**：

1. 导入 `ca.pem`（qcc-radius-ca-2026）到「受信任的根证书颁发机构」
2. 导入客户端证书（含私钥，通常为 pfx）到「个人」存储
3. WLAN `test022` 的安全方法改为「智能卡或其他证书」

**106 证书目录**：

```text
/etc/freeradius/3.0/certs/ca.pem      # 信任锚
/etc/freeradius/3.0/certs/server.pem  # 服务器证书
/etc/freeradius/3.0/certs/server.key  # 服务器私钥
```

> **注意**：终端和 RADIUS 使用同一张根证书作为信任起点。服务器证书 SAN 必须包含 NAS 对接地址，否则终端验服务器会失败。

---

### 阶段 1：终端关联 test022

**AC6003 配置链路（实测）**：

```text
vap-profile test022
  -> ssid-profile test022
  -> security-profile test022 (wpa-wpa2 dot1x aes)
  -> authentication-profile test022
       -> dot1x-access-profile test022
       -> authentication-scheme test022 (authentication-mode radius)
       -> radius-server default
```

**关键结论**：test022 没有 `mac-access-profile`，也没有 `portal-access-profile`，是纯 802.1X 链路。和 test011（MAC + Portal）完全不同。

---

### 阶段 2：802.1X 触发（EAP over LAN）

| 方向 | 报文 | 说明 |
|------|------|------|
| 终端 -> AP -> AC | EAPOL-Start | 终端发起 802.1X |
| AC -> 终端 | EAP-Identity Request | AC 询问身份 |
| 终端 -> AC | EAP-Identity Response | 终端回应身份标识 |

> AC6003 在此阶段只是透传 EAP 报文，不解析证书内容。

---

### 阶段 3：RADIUS Access-Request 到达 106

**106 接收报文后首先做 NAS 校验**：

- 来源 IP：192.168.30.15
- RADIUS 属性 `NAS-IP-Address = 192.168.30.15`
- `clients.conf` 核对 `shared-key`

**Access-Request 关键属性**：

```text
User-Name                    # 外层身份，可伪造
NAS-Port-Type = Wireless-802.11
Called-Station-Id = AP-MAC:test022
Calling-Station-Id = Client-MAC
```

**106 上 RADIUS 监听确认**：

```bash
ss -ulnp | grep 1812
# 应看到 0.0.0.0:1812 由 freeradius 监听
```

---

### 阶段 4：EAP 方法协商

**106 配置位置**：`/etc/freeradius/3.0/mods-available/eap`

```text
eap {
    default_eap_type = md5   # 第 27 行，当前未切 tls
    ...
    tls {                    # 第 760 行
        tls = tls-common
        # virtual_server = check-eap-tls   # 第 770 行，当前被注释
    }
}
```

**协商逻辑**：

| EAP Type | 数值 | 结果 |
|----------|------|------|
| EAP-TLS | 13 | 进入 tls 段，做双向证书认证 |
| PEAP | 25 | 进入 peap 段，终端弹账号密码框 |
| MD5 | 4 | 进入 md5 段，明文质询 |

**现状风险**：106 上 `md5 / ttls / peap / tls` 全部启用。Windows 默认使用 PEAP-MSCHAPv2，因此会弹账号密码框；106 也会配合完成 PEAP 认证。

---

### 阶段 5：TLS 握手（EAP-TLS）

EAP-TLS 把完整 TLS 握手装进 RADIUS 报文。每个消息超过 1024 字节时，rlm_eap 拆成多个 `EAP-Message` 属性，封装在 `Access-Challenge` / `Access-Request` 里往返。

**握手子步骤**：

1. **ClientHello**：终端发起，携带支持的密码套件
2. **ServerHello + server.pem**：106 回应，出示服务器证书
3. **CertificateRequest**：106 要求终端出示客户端证书
4. **Client Certificate + CertificateVerify**：终端出示证书，并用私钥对握手摘要签名
5. **Finished**：双方完成密钥协商

**106 实际配置**：

```text
mods-available/eap:177  tls-common
    private_key_file = /etc/freeradius/3.0/certs/server.key
    certificate_file = /etc/freeradius/3.0/certs/server.pem
```

---

### 阶段 6：服务器验证客户端证书（关卡 B）

验证由 OpenSSL 自动完成，配置只决定信任锚和策略。

| 关卡 | 验证内容 | 106 配置 | 失败表现 |
|------|---------|---------|---------|
| ① 签名链 | 客户端证书能否追到 `ca_file` | `ca_file = ${cadir}/ca.pem` | TLS alert: unknown CA |
| ② 有效期 | 当前时间在 notBefore/notAfter 内 | 系统时间比对 | certificate expired |
| ③ EKU | 必须含 clientAuth | TLS 层检查 | certificate purpose not allowed |
| ④ CRL 吊销 | 序列号不在吊销列表 | **当前未配置** | 吊销证书仍可通过 |

**CertificateVerify**：四道验证全过后，用客户端公钥验证其对握手摘要的私钥签名，证明「证书主人确实持有对应私钥」。

---

### 阶段 7：身份提取到 session-state

证书验证通过后，rlm_eap_tls 自动把证书字段写入 `session-state`：

```text
session-state.TLS-Client-Cert-Common-Name = double
session-state.TLS-Client-Cert-Subject     = CN=double,OU=BOSS,DC=qcc
session-state.TLS-Client-Cert-Issuer      = CN=qcc-radius-ca-2026
session-state.TLS-Client-Cert-Serial      = 证书序列号
session-state.TLS-Client-Cert-Expiration  = 到期时间
```

> 外层 `User-Name` 是明文可伪造的，授权必须以 `session-state` 中的证书字段为准。

---

### 阶段 8：策略决策（profile 关联）

#### 现状：直接放行

```text
mods-available/eap:770
    # virtual_server = check-eap-tls   # 被注释

sites-enabled/
    default -> 已启用
    inner-tunnel -> 已启用
    check-eap-tls -> 无软链，未加载
```

结果：证书验过即 `Access-Accept`，无 VLAN/QoS 下发。

#### 目标：启用 check-eap-tls

需要完成：

1. `mods-available/eap` 中取消 `virtual_server = check-eap-tls` 注释
2. `ln -s ../sites-available/check-eap-tls /etc/freeradius/3.0/sites-enabled/`
3. 重写 `check-eap-tls`，加入 OU/CN 白名单 + `reject` 兜底
4. 通过 SQL 三表联动取 VLAN/QoS

**check-eap-tls 模板示例**：

```text
server check-eap-tls {
    authorize {
        update request {
            User-Name := "%{session-state.TLS-Client-Cert-Common-Name}"
        }

        if ("%{session-state.TLS-Client-Cert-Subject}" =~ /OU=BOSS/) {
            update reply {
                Tunnel-Type := VLAN
                Tunnel-Medium-Type := IEEE-802
                Tunnel-Private-Group-Id := "16"
                HUAWEI-Input-Average-Rate := 50000000
                HUAWEI-Output-Average-Rate := 50000000
            }
            update control { Auth-Type := Accept }
        }
        elsif ("%{session-state.TLS-Client-Cert-Subject}" =~ /OU=TECH/) {
            update reply {
                Tunnel-Type := VLAN
                Tunnel-Medium-Type := IEEE-802
                Tunnel-Private-Group-Id := "81"
                HUAWEI-Input-Average-Rate := 50000000
                HUAWEI-Output-Average-Rate := 50000000
            }
            update control { Auth-Type := Accept }
        }
        else {
            reject
        }

        auth_log
    }
}
```

---

### 阶段 8 展开：SQL 三表联动（目标状态）

| 步骤 | 数据表 | SQL 示例 | 返回 |
|------|--------|---------|------|
| ① 证书绑定 | `radius_certs` | `SELECT bound_username FROM radius_certs WHERE cn='double' AND status='valid'` | `double` |
| ② 用户分组 | `radusergroup` | `SELECT groupname FROM radusergroup WHERE username='double'` | `boss_profile` |
| ③ 组属性 | `radgroupreply` | `SELECT attribute,value FROM radgroupreply WHERE groupname='boss_profile'` | VLAN + QoS |

**radgroupreply 示例数据**：

```sql
INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES
('boss_profile', 'Tunnel-Private-Group-Id', ':=', '16'),
('boss_profile', 'HUAWEI-Input-Average-Rate', ':=', '50000000'),
('boss_profile', 'HUAWEI-Output-Average-Rate', ':=', '50000000');
```

---

### 阶段 9：Access-Accept 授权下发

RADIUS 回复属性合并到 `Access-Accept`：

| 属性 | 值 | 作用 |
|------|-----|------|
| Tunnel-Type | VLAN (13) | 标识用途为 VLAN 分配 |
| Tunnel-Medium-Type | IEEE-802 (6) | 载体类型 |
| Tunnel-Private-Group-Id | "16" / "81" | 目标 VLAN ID |
| HUAWEI-Input-Average-Rate | 50000000 bit/s | 上行限速 50 Mbps |
| HUAWEI-Output-Average-Rate | 50000000 bit/s | 下行限速 50 Mbps |

---

### 阶段 10：NAS 执行准入策略

AC6003 收到 `Access-Accept` 后：

1. 解析 Tunnel 三件套，把用户会话切换到 VLAN 16（BOSS 有线）或 VLAN 81（TECH 无线）
2. 解析 HUAWEI VSA，对用户流量做 50 Mbps 限速
3. 终端从目标 VLAN 获取 DHCP IP，完成准入

---

### 阶段 11：审计与记账

| 事件 | 报文 | 落库 |
|------|------|------|
| 终端上线 | Accounting-Start | `radacct` 新增记录 |
| 终端下线 | Accounting-Stop | `radacct` 更新时长/流量 |
| 认证结果 | post-auth | `radpostauth` 记录 Accept/Reject + CN + 时间 |

---

## 四、106 现状缺口清单

| # | 缺口 | 影响 |
|---|------|------|
| 1 | `eap:27 default_eap_type = md5` 未切 tls | 终端不主动请求 TLS 时无法进入证书流程 |
| 2 | `eap:770 virtual_server = check-eap-tls` 被注释 | 证书验过后没有策略入口 |
| 3 | `sites-enabled` 缺少 `check-eap-tls` 软链 | 虚拟服务器不加载 |
| 4 | `check-eap-tls` 模板仍是默认 Accept 全放行 | 未写 OU/CN 白名单，所有人都能过 |
| 5 | `certs/` 目录是 8/31 bootstrap 自签测试 CA | 未换成生产 CA `qcc-radius-ca-2026` |
| 6 | `check_crl` 未配置 | 吊销证书无法识别 |
| 7 | PEAP / TTLS / MD5 全开 | 终端默认 PEAP 会弹账号密码框 |

---

## 五、整改步骤

### 5.1 准备阶段（建议先做）

1. 备份当前配置：
   ```bash
   cp /etc/freeradius/3.0/mods-available/eap /etc/freeradius/3.0/mods-available/eap.bak.$(date +%Y%m%d)
   cp /etc/freeradius/3.0/sites-available/check-eap-tls /etc/freeradius/3.0/sites-available/check-eap-tls.bak.$(date +%Y%m%d)
   ```

2. 替换生产 CA 证书链：
   ```bash
   # 用 qcc-radius-ca-2026 签发 server.pem，确保 SAN 含 192.168.110.106
   # 替换 /etc/freeradius/3.0/certs/ca.pem 为生产根证书
   # 替换 server.pem / server.key
   ```

### 5.2 FreeRADIUS 配置整改

1. 修改 `/etc/freeradius/3.0/mods-available/eap`：
   - `default_eap_type = tls`
   - 在 tls 段加 `virtual_server = check-eap-tls`
   - 可选：注释掉 `md5 / ttls / peap` 块，强制只走 TLS

2. 重写 `/etc/freeradius/3.0/sites-available/check-eap-tls`：
   - 加入 OU/CN 白名单
   - 加入 `reject` 兜底
   - 配置 VLAN/QoS 下发

3. 启用软链：
   ```bash
   ln -s ../sites-available/check-eap-tls /etc/freeradius/3.0/sites-enabled/check-eap-tls
   ```

4. 配置 CRL：
   ```text
   check_crl = yes
   crl_file = ${cadir}/crl.pem
   ```

### 5.3 验证与重启

```bash
# 语法检查
radiusd -XC

# 前台观察实时握手
systemctl stop freeradius && freeradius -X

# 确认无报错后重启
systemctl start freeradius
```

---

## 六、终端侧配置确认

Windows 连接 test022 时：

1. 网络和 Internet -> WLAN -> 管理已知网络 -> test022 -> 属性
2. 安全 -> 企业身份验证方法：
   - 选择 **Microsoft: 智能卡或其他证书**
3. 点击「设置」：
   - 勾选受信任的根证书颁发机构：`qcc-radius-ca-2026`
   - 认证方式选择用户证书或计算机证书

---

## 七、排障地图

| 现象 | 定位 | 排查点 |
|------|------|--------|
| 终端弹账号密码框 | 阶段 4 | 终端 WLAN 方法未改为 EAP-TLS；或 106 仍启用 PEAP |
| TLS 握手失败 | 阶段 5~6 | server.pem SAN 是否含 NAS 对接地址；ca.pem 是否导入终端；客户端证书 EKU 是否含 clientAuth |
| 证书验过但无 VLAN | 阶段 8 | `virtual_server` 是否挂接；`check-eap-tls` 是否软链启用；OU 正则是否匹配 |
| 上错 VLAN / 不限速 | 阶段 8~9 | `radgroupreply` 属性值；`check-eap-tls` 中 reply 是否正确写入 |
| 已吊销证书仍能登录 | 阶段 6 | `check_crl` 是否启用；CRL 文件是否最新 |

---

## 八、关键日志观察

```bash
freeradius -X | grep -E "EAP-(Type|Response)|TLS|session-state|check-eap-tls|Access-Accept|Access-Reject"
```

正常证书认证应看到：

```text
eap: Peer sent EAP Response (type 13)            # 13 = EAP-TLS
(TLS) verify return:1 ... Trusted                # 证书链验证通过
session-state: TLS-Client-Cert-Common-Name = "double"
check-eap-tls: ... Auth-Type := Accept
Sending Access-Accept ... Tunnel-Private-Group-Id = "16"
```

---

## 九、附：报文类型速查

| RADIUS 报文 | 方向 | 含义 |
|-------------|------|------|
| Access-Request | AC -> 106 | 请求认证 |
| Access-Challenge | 106 -> AC | 要求继续 EAP/TLS 握手 |
| Access-Accept | 106 -> AC | 认证通过，携带授权属性 |
| Access-Reject | 106 -> AC | 认证失败 |
| Accounting-Request Start | AC -> 106 | 终端上线记账 |
| Accounting-Request Stop | AC -> 106 | 终端下线记账 |

---

## 十、变更记录

| 日期 | 版本 | 变更内容 |
|------|------|---------|
| 2026-09-17 | v1.0 | 基于 106 实测配置整理完整流程与整改清单 |
