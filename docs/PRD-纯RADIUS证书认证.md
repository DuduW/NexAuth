# PRD — 纯 RADIUS 实现证书认证 + Profile 下发（无数据库版）

**版本**：v0.2（设计稿，待审查 — 新增 §6 认证流程详解）
**日期**：2026-09-03
**模块归属**：RADIUS 服务端 / EAP-TLS
**前置**：FreeRADIUS 3.0 + OpenSSL CA 已落地（`/etc/freeradius/3.0/certs/`，密码 `qcc-radius-ca-2026`）
**关联文档**：[PRD-证书认证.md](./PRD-证书认证.md)（数据库版，v1.3 已上线）

---

## 1. 背景与目标

### 1.1 背景

当前 v1.3 上线的证书认证方案（[PRD-证书认证.md §15-16](./PRD-证书认证.md)）依赖 MariaDB：
- 证书签发时写 `radius_certs.bound_username`
- 认证时 P5c 用 SQL 查 `bound_username` 写进 `control:SQL-User-Name`
- sql 模块用 `control:SQL-User-Name` 查 `radusergroup` → `radgroupreply` 取出 profile 属性

这套链路依赖：
1. **MySQL 服务可用**（宕了 EAP-TLS 仍能过但 profile 不下发，落到默认 VLAN）
2. **radius_certs 表数据完整**（缺行 = 静默失败）
3. **radusergroup + radgroupreply 双表**（缺一不可）

### 1.2 目标

提供一套**纯 FreeRADIUS 文件配置**的方案，完全不依赖数据库即可完成：
- EAP-TLS 证书认证
- 按 profile 下发 VLAN / QoS / ACL 属性
- 证书吊销（基于 CRL 文件）

### 1.3 适用场景

| 场景 | 是否推荐 |
|---|---|
| 网络设备定位的纯认证 + VLAN/QoS（无 portal、无 TOTP、无 MAC 旁路台账） | ✅ 推荐 |
| 既要证书认证、又要 portal / TOTP / MAC 旁路台账 | ❌ 不推荐（仍走数据库版） |
| 边缘节点 RADIUS 备份（无 DB 容灾） | ✅ 推荐 |
| 员工数 < 500、profile 模板 < 20 的中小规模 | ✅ 推荐 |
| 员工数 > 500、需个人级细粒度 profile 频繁变更 | ⚠️ 可用但维护成本高 |

### 1.4 非目标（本期不做）

- 不替代数据库版（两套可并存，由不同 SSID 路由）
- 不实现证书签发控制台（仍走现有 /admin-spa/#/certs，仅签发时 Subject 加 OU 字段）
- 不实现 NetAgent 自动申请证书（v2.0 远期）
- 不做高可用集群（单点 RADIUS + CRL 文件）

---

## 2. 与数据库版对比

| 维度 | 数据库版（v1.3） | 纯 RADIUS 版（本 PRD） |
|---|---|---|
| profile 下发依据 | `radius_certs.bound_username → radusergroup → radgroupreply` | 证书 Subject OU 字段（unlang 正则匹配） |
| 新增员工 | 签发证书 + 写 radius_certs + 加 radusergroup | **签发证书（OU 指定 profile）即可** |
| 员工改 profile | 改 radusergroup + radgroupreply | 重签证书（换 OU） |
| profile 粒度 | **个人级**（每员工独立） | **组织级**（一 OU 一套），个人覆盖需额外 CN 匹配 |
| 吊销生效机制 | radius_certs.status='revoked' → 下次认证无 profile | CRL 文件 → 下次 TLS 握手直接 Reject |
| 依赖组件 | FreeRADIUS + MariaDB + radius_certs 表 | **FreeRADIUS + OpenSSL CRL** |
| 配置变更频率 | 数据库行增删 | 签发证书时指定 OU（配置文件稳定） |
| 失败兜底 | DB 挂 → profile 丢失 → 默认 VLAN | CRL 文件过期 → TLS 全部 Reject（更激进） |
| 可观测性 | radius_certs 表查询 + radpostauth | OpenSSL 列 issued 目录 + radpostauth |

---

## 3. 技术方案选择

### 3.1 四种可选方案

| 方案 | 匹配字段 | 粒度 | 维护成本 | 推荐 |
|---|---|---|---|---|
| **A** | 证书 Subject CN（如 `CN=double`） | 个人级 | 高（每员工一段 unlang） | ⚠️ 不单独用 |
| **B** | 证书 Subject OU（如 `OU=profile51`） | 组织级 | 低（一 OU 一段） | ✅ **主推** |
| **C** | 证书 SAN DNS（如 `DNS:profile51.qcc.com`） | 标签级 | 中 | 备选 |
| **D** | 证书 custom OID 扩展 | 自定义 | 高（需维护 OID 注册） | ❌ 不推荐 |

### 3.2 选定方案：B + A 组合

**B（OU）做组织级默认策略**，**A（CN）做个人级覆盖**。

理由：
- OU 是 X.509 标准字段，所有终端兼容
- OU 是字符串可正则匹配，unlang 简洁
- 一个 OU 对应一个 profile 模板，新增员工只签发证书不用改 radius 配置
- CN 覆盖仅用于「同 OU 但需特殊待遇」的少数员工（如 double 给 4M 而非 2M）

### 3.3 Subject 字段设计规范

签发证书时 Subject 必须严格按以下格式：

```
/C=CN/ST=Beijing/L=Beijing/O=QCC/OU={profile-id}/CN=client-{username}-{YYYYMMDD}
```

**示例**：

| 员工 | profile | Subject |
|---|---|---|
| double | profile51 | `/C=CN/ST=Beijing/L=Beijing/O=QCC/OU=profile51/CN=client-double-20260901` |
| aiwen | profile50 | `/C=CN/ST=Beijing/L=Beijing/O=QCC/OU=profile50/CN=client-aiwen-20260901` |
| guest 用户 | guest | `/C=CN/ST=Beijing/L=Beijing/O=QCC/OU=guest/CN=client-guest001-20260901` |

**OU 取值规则**：
- OU 命名 = profile 模板 ID（与 radgroupreply.groupname 一致，便于回切数据库版）
- 必须全小写、无空格、可包含数字
- 不允许 `OU=profile51a` 这种近名（避免正则误匹配），OU 用 `=` 严格匹配

---

## 4. Profile 模板定义

### 4.1 OU → 属性映射表

| OU | groupname | VLAN | 上行限速 | 下行限速 | ACL | 用途 |
|---|---|---|---|---|---|---|
| `profile51` | profile51 | 51 | 2 Mbps | 2 Mbps | 3000 | IT 部门（参考现有 profile51） |
| `profile50` | profile50 | 50 | 4 Mbps | 4 Mbps | 3000 | 业务部门 |
| `guest` | guest | 99 | 1 Mbps | 1 Mbps | 3001 | 访客 |
| `admin` | admin | 10 | 不限速 | 不限速 | 3002 | 网络管理员 |
| `default` | default | 999 | 512 Kbps | 512 Kbps | 3003 | 兜底（OU 缺失或未匹配） |

> 属性值严格对齐数据库版 `radgroupreply` 表，保证两套方案可互换。

### 4.2 华为 VSA 与标准属性对照

```
Tunnel-Type = VLAN                              # 标准属性（13）
Tunnel-Medium-Type = IEEE-802                   # 标准属性（6）
Tunnel-Private-Group-Id = {VLAN-ID}             # 标准属性（字符串形式）
Huawei-Input-Average-Rate = {上行 bps}           # 华为 VSA（2636/4/1）
Huawei-Output-Average-Rate = {下行 bps}         # 华为 VSA（2636/4/2）
Filter-Id = "{ACL-ID}"                          # 标准属性（字符串）
```

---

## 5. FreeRADIUS 配置详解

### 5.1 mods-available/eap（启用 CRL 检查）

```ini
eap {
    default_eap_type = tls
    timer_expire = 60
    ignore_unknown_eap_type = no

    tls-config tls-common {
        private_key_password = qcc-radius-server-2026
        private_key_file = ${certdir}/server.key
        certificate_file = ${certdir}/server.pem
        ca_file = ${certdir}/ca.pem          # v1.2 已修复：指向 QCC CA，不是系统公共库
        ca_path = ${certdir}
        # ↓↓↓ 纯 RADIUS 版新增 ↓↓↓
        crl_file = ${certdir}/crl.pem        # CRL 文件路径
        check_crl = yes                      # 启用吊销检查
        # ↑↑↑ 纯 RADIUS 版新增 ↑↑↑
        cipher_list = "DEFAULT"
        cipher_server_preference = yes
        tls_min_version = 1.2
        ecdh_curve = "prime256v1"
    }
}
```

**关键**：
- `crl_file` 指向 CRL 文件（v1.1 数据库版未启用，纯 RADIUS 版必须启用）
- `check_crl = yes` 让 rlm_eap_tls 在 TLS 握手轮 5 校验客户端证书时检查 CRL，被吊销证书 → TLS fail → Access-Reject

### 5.2 sites-available/default（authorize 段 unlang）

```unlang
authorize {
    preprocess
    filter_username
    suffix

    # EAP 握手在前（每轮 eap 都会做反伪造检查，不要在它之前重写 User-Name）
    eap {
        ok = return
        updated = return
    }

    # ↓↓↓ EAP-TLS 握手成功后进入这里 ↓↓↓
    # TLS-Client-Cert-* 属性由 rlm_eap_tls 在 TLS 成功后填充

    # 1. 默认 profile 兜底（先 set，后面 OU 匹配再覆盖）
    update reply {
        Tunnel-Type := VLAN
        Tunnel-Medium-Type := IEEE-802
        Tunnel-Private-Group-Id := 999
        Huawei-Input-Average-Rate := 512000
        Huawei-Output-Average-Rate := 512000
        Filter-Id := "3003"
    }

    # 2. OU 匹配：组织级 profile（主策略）
    if (&TLS-Client-Cert-Subject =~ /OU=profile51/) {
        update reply {
            Tunnel-Private-Group-Id := 51
            Huawei-Input-Average-Rate := 2000000
            Huawei-Output-Average-Rate := 2000000
            Filter-Id := "3000"
        }
    }
    elsif (&TLS-Client-Cert-Subject =~ /OU=profile50/) {
        update reply {
            Tunnel-Private-Group-Id := 50
            Huawei-Input-Average-Rate := 4000000
            Huawei-Output-Average-Rate := 4000000
            Filter-Id := "3000"
        }
    }
    elsif (&TLS-Client-Cert-Subject =~ /OU=guest/) {
        update reply {
            Tunnel-Private-Group-Id := 99
            Huawei-Input-Average-Rate := 1000000
            Huawei-Output-Average-Rate := 1000000
            Filter-Id := "3001"
        }
    }
    elsif (&TLS-Client-Cert-Subject =~ /OU=admin/) {
        update reply {
            Tunnel-Private-Group-Id := 10
            # 不限速：不设 Huawei-* 属性
            Filter-Id := "3002"
        }
    }

    # 3. CN 覆盖：个人级 profile（仅当同 OU 下需特殊待遇时）
    #    覆盖优先级高于 OU（写在 OU 之后）
    if (&TLS-Client-Cert-Subject =~ /CN=client-double-[0-9]+/) {
        update reply {
            Huawei-Input-Average-Rate := 4000000   # double 4M 上行（覆盖 profile51 的 2M）
            Huawei-Output-Average-Rate := 4000000  # double 4M 下行
        }
    }

    # 4. 非 EAP-TLS 认证（PAP/Portal/MAC 旁路）走 sql 路径
    #    与数据库版共存：只在 EAP-TLS 成功后才有 TLS-Client-Cert-* 属性
    #    PAP 走原 sql + radusergroup 链路不变
    sql
    expiration
}
```

### 5.3 sites-available/default（post-auth 段）

```unlang
post-auth {
    # 记录认证日志（radpostauth 表，可选，需 sql 模块）
    # 如果完全无数据库，注释掉下面这段，改用 detail 文件记录
    # sql
    # exec
    # remove_reply_name_if_called_from_merged_acct
    # update reply { ... }
    Post-Auth-Type Accept {
        -sql
    }
    ...
}
```

> 完全无 DB 时，post-auth 不写日志表，认证审计依赖 `radacct/192.168.30.15/detail-YYYYMMDD` 文件（NAS 端记账）。

---

## 6. EAP-TLS 认证流程详解

本章详述从终端发起连接到 AC 下发 VLAN/QoS/ACL 的端到端流程，覆盖协议栈、报文时序、FreeRADIUS 内部处理、TLS 握手、证书解析、CRL 校验、Profile 下发与失败兜底全链路。

### 6.1 认证协议栈（四层封装）

EAP-TLS 认证自下而上分四层，每层封装上一层：

```
┌─────────────────────────────────────────────┐
│  Layer 4: TLS 1.2/1.3                        │  密钥协商 + 证书交换 + 加密通道
│  (Transport Layer Security)                  │
├─────────────────────────────────────────────┤
│  Layer 3: EAP-TLS (RFC 5216)                 │  TLS 流量分片成 EAP 消息
│  (Extensible Authentication Protocol - TLS)   │  EAP-Code: Request/Response
├─────────────────────────────────────────────┤
│  Layer 2: EAP (RFC 3748)                     │  Type=13(EAP-TLS)/Type=1(Identity)
│  (Extensible Authentication Protocol)         │  Type 字段标识认证方法
├─────────────────────────────────────────────┤
│  Layer 1: 802.1X / EAPoL (IEEE 802.1X-2010)  │  以太网帧 Ethertype=0x888E
│  (Port-Based Network Access Control)         │  AC/AP 之间走 RADIUS(EAP)
└─────────────────────────────────────────────┘
```

| 层 | 协议 | 职责 | 本方案涉及组件 |
|---|---|---|---|
| L1 | 802.1X EAPoL | 终端 ↔ AP 物理端口访问控制、EAPoL 封装 | 终端 supplicant、AP/AC Authenticator |
| L2 | EAP (RFC 3748) | EAP-Request/Response 消息、Type 协商 | AC 与 RADIUS 间 RADIUS EAP-Message 属性 |
| L3 | EAP-TLS (RFC 5216) | Type=13、Start/分片/重组 TLS 数据 | FreeRADIUS rlm_eap_tls 模块 |
| L4 | TLS 1.2 | 证书校验、密钥交换、Finished 校验 | OpenSSL（FreeRADIUS 内嵌） |

### 6.2 端到端认证时序（终端 ↔ AP ↔ AC ↔ RADIUS）

下图展示一次成功的 EAP-TLS 认证完整 8 轮交互（含 TLS 4 轮握手 + Identity + Success/Failure）：

```
终端(Supplicant)        AP/AC(Authenticator)        RADIUS Server
     │                         │                          │
     │ ① EAPoL-Start           │                          │
     ├────────────────────────>│                          │
     │                         │ ② RADIUS Access-Request  │
     │                         │   (User-Name="",          │
     │                         │    EAP-Message=Identity)  │
     │                         ├─────────────────────────>│
     │                         │                          │
     │                         │ ③ RADIUS Access-Challenge │
     │                         │   (EAP-Request/          │
     │                         │    EAP-TLS Start)         │
     │                         │<─────────────────────────┤
     │ ④ EAP-Response/         │                          │
     │    EAP-TLS(ClientHello) │                          │
     ├────────────────────────>│ ⑤ Access-Request          │
     │                         │   (EAP-Message=TLS       │
     │                         │    ClientHello 分片)       │
     │                         ├─────────────────────────>│
     │                         │                          │
     │                         │ ⑥ Access-Challenge        │  RADIUS 校验 CA 签名链
     │                         │   (EAP-Request/EAP-TLS   │  发 ServerHello/Cert/
     │                         │    ServerHello/Cert/      │  ServerKeyExchange/
     │                         │    ServerKeyExchange/     │  CertificateRequest
     │                         │    CertificateRequest)   │
     │                         │<─────────────────────────┤
     │ ⑦ EAP-Response/         │                          │
     │    EAP-TLS(ClientCert +  │                          │  终端发客户端证书
     │    ClientKeyExchange +   │                          │  rlm_eap_tls 校验证书签名
     │    CertificateVerify +   │                          │  + CRL 吊销检查
     │    ChangeCipherSpec +    │                          │
     │    Finished)             │                          │
     ├────────────────────────>│ ⑧ Access-Request          │
     │                         │   (EAP-Message=TLS       │
     │                         │    Client data 分片)      │
     │                         ├─────────────────────────>│
     │                         │                          │
     │                         │ ⑨ Access-Challenge        │  RADIUS 发
     │                         │   (EAP-Request/EAP-TLS   │  ChangeCipherSpec+Finished
     │                         │    Server Finished)       │  完成 TLS 握手
     │                         │<─────────────────────────┤
     │ ⑩ EAP-Response/         │                          │
     │    EAP-TLS(Finished ACK)│                          │
     ├────────────────────────>│ ⑪ Access-Request          │
     │                         ├─────────────────────────>│
     │                         │                          │
     │                         │ ⑫ Access-Accept          │  ★ Profile 下发点
     │                         │   (EAP-Success,          │  Tunnel-Private-Group-Id=51
     │                         │    VLAN/QoS/ACL 属性)    │  Huawei-Input/Output-Rate
     │                         │<─────────────────────────┤
     │ ⑬ EAP-Success           │                          │
     │<────────────────────────┤                          │
     │                         │                          │
     │ ⑭ DHCP（VLAN 51 内）    │                          │  AC 根据返回属性切换
     ├────────────────────────>│                          │  端口到 VLAN 51
     │<────────────────────────┤                          │
     │                         │                          │
```

| 步骤 | 报文 | 方向 | 关键字段 | FreeRADIUS 处理 |
|---|---|---|---|---|
| ① | EAPoL-Start | 终端→AP | EAPoL Type=1 | — |
| ② | Access-Request | AP→RADIUS | User-Name="", NAS-IP, EAP-Message=Identity | authorize 段：preprocess → suffix |
| ③ | Access-Challenge | RADIUS→AP | EAP-Request/EAP-TLS Start (Type=13, S=1) | eap 段发 Start，等终端 ClientHello |
| ④⑤ | ClientHello | 终端→AP→RADIUS | TLS version, cipher suites, SNI | eap 段接收，OpenSSL 处理 |
| ⑥ | ServerHello+Cert+... | RADIUS→AP→终端 | server cert, key exchange, cert request | eap 段发，请求终端证书 |
| ⑦⑧ | ClientCert+... | 终端→AP→RADIUS | 客户端证书、密钥交换、签名 | **★ 校验证书签名链 + CRL 吊销** |
| ⑨ | Server Finished | RADIUS→AP→终端 | ChangeCipherSpec+Finished | TLS 握手完成 |
| ⑩⑪ | Finished ACK | 终端→AP→RADIUS | 客户端 Finished | eap ok → 进入 authorize 后段 |
| ⑫ | **Access-Accept** | RADIUS→AP | **VLAN+QoS+ACL 属性** | **★ Profile 下发点（update reply）** |
| ⑬ | EAP-Success | AP→终端 | EAP Code=Success | — |
| ⑭ | DHCP | 终端→AP | 在 VLAN 51 内获取 IP | AC 应用属性切端口 |

### 6.3 FreeRADIUS 内部处理流程

FreeRADIUS `authorize` + `post-auth` 段对 EAP-TLS 的处理分三阶段：

```
Access-Request 到达
       │
       v
┌─────────────────────────────────────────────────────────┐
│ 阶段 1: authorize 前置（每轮都执行）                   │
│   preprocess → filter_username → suffix                  │
│   (User-Name 规整、Realm 剥离)                            │
└─────────────────────────────────────────────────────────┘
       │
       v
┌─────────────────────────────────────────────────────────┐
│ 阶段 2: eap 段（多轮 TLS 握手，期间反复进入）           │
│   eap {                                                   │
│     - 第 1 轮：EAP-Response/Identity                      │
│       rlm_eap 读取 EAP-Message，识别 Type=1(Identity)     │
│       设定 eap_type=tls，记 Identity 为 User-Name         │
│       发 EAP-Request/EAP-TLS Start 等终端 ClientHello    │
│                                                          │
│     - 第 2-N 轮：EAP-Response/EAP-TLS (Type=13)          │
│       rlm_eap_tls 把 EAP-Message 分片重组为完整 TLS 记录  │
│       交给 OpenSSL 处理：                                 │
│         · ClientHello → 选 cipher、发 ServerHello         │
│         · 发 Server 证书 + CertificateRequest             │
│         · 收 Client 证书 → 校验签名链到 CA              │
│         · CRL 吊销检查（check_crl=yes）                  │
│         · 密钥交换、ChangeCipherSpec、Finished           │
│                                                          │
│     ★ 反伪造检查：                                        │
│       rlm_eap_tls 每轮比对 EAP-Identity 与 User-Name      │
│       不一致 → Reject（v1.3 P5 教训）                     │
│       纯 RADIUS 版不改 User-Name，无此风险                │
│                                                          │
│     - TLS 成功：eap 返回 ok → return（跳过后续 authorize）│
│     - TLS 失败：eap 返回 fail → Reject                   │
│   }                                                       │
└─────────────────────────────────────────────────────────┘
       │ (TLS 成功后)
       v
┌─────────────────────────────────────────────────────────┐
│ 阶段 3: authorize 后段（仅 TLS 成功轮进入一次）          │
│   ★ TLS-Client-Cert-* 属性已被 rlm_eap_tls 填充：         │
│     - TLS-Client-Cert-Subject = "C=CN,ST=...,OU=...,     │
│        CN=client-double-20260901"                         │
│     - TLS-Client-Cert-Serial = "1003"                    │
│     - TLS-Client-Cert-Valid-Since = "20260901000000Z"   │
│                                                          │
│   1) 默认兜底 update reply（VLAN 999 / 512K / ACL 3003）  │
│   2) OU 正则匹配覆盖属性（profile51/guest/admin...）      │
│   3) CN 正则匹配个人级覆盖（如 double 4M）              │
│                                                          │
│   → 进入 post-auth                                        │
└─────────────────────────────────────────────────────────┘
       │
       v
┌─────────────────────────────────────────────────────────┐
│ 阶段 4: post-auth                                         │
│   Post-Auth-Type Accept {                                 │
│     - sql（可选，无 DB 注释掉）                           │
│     - update reply（最终属性精修）                        │
│   }                                                       │
│   → Access-Accept + reply 属性返回 AC                    │
└─────────────────────────────────────────────────────────┘
```

### 6.4 TLS 握手 5 轮详解

EAP-TLS 的 TLS 握手将标准 TLS 流分片为 EAP-Message 属性传输。完整握手共 5 轮：

| 轮次 | 报文 | TLS 子消息 | RADIUS 处理 |
|---|---|---|---|
| 1 | ClientHello | Version, Random, CipherSuites, SNI(可选) | OpenSSL 选 cipher、生成 ServerRandom |
| 2 | ServerHello + Certificate + ServerKeyExchange + CertificateRequest + ServerHelloDone | Server 证书（让终端校验服务端） + 索要客户端证书 | 终端校验 server 证书 → 信任 CA |
| 3 | Certificate + ClientKeyExchange + CertificateVerify + ChangeCipherSpec + Finished | **客户端证书** + 密钥交换 + 签名证明持有私钥 | **★ rlm_eap_tls 校验证书签名链到 CA** |
| 4 | Server ChangeCipherSpec + Finished | 服务器切换到加密通道 + Finished MAC 校验 | TLS 握手完成 |
| 5 | (空 Finished ACK) | 终端发 ACK，无 TLS 数据 | rlm_eap_tls 设 ok → 进入 authorize 后段 |

**关键校验点**：
- **轮 2**：终端校验 server 证书 → 必须信任 `ca.pem`（终端需导入 CA 根证书，否则终端侧报错）
- **轮 3**：rlm_eap_tls 校验客户端证书
  - 签名链：客户端证书 → CA 签名链完整
  - 有效期：`notBefore ≤ now ≤ notAfter`
  - **CRL 吊销检查**（`check_crl=yes`）：证书序列号在 CRL 中 → TLS fail → Reject
  - 用途扩展：`extendedKeyUsage = clientAuth`
- **轮 5**：TLS 成功后，rlm_eap_tls 在 request 上下文填充 `TLS-Client-Cert-*` 属性，供 authorize 后段 unlang 使用

### 6.5 证书 Subject 解析流程

TLS 握手成功后，rlm_eap_tls 把证书 Subject（RFC 4514 DN 格式）填入 `TLS-Client-Cert-Subject`，unlang 用正则匹配 OU/CN：

```
证书 Subject (来自 rlm_eap_tls)
       │
       │ TLS-Client-Cert-Subject = "C=CN, ST=Beijing, L=Beijing,
       │                             O=QCC, OU=profile51,
       │                             CN=client-double-20260901"
       v
┌──────────────────────────────────────────────────┐
│ 1. 默认兜底：update reply 设 VLAN 999 / 512K    │
│    (无论 OU 是什么，先设默认值)                  │
└──────────────────────────────────────────────────┘
       │
       v
┌──────────────────────────────────────────────────┐
│ 2. OU 匹配链（elsif 互斥，命中即跳后续）         │
│    if (&TLS-Client-Cert-Subject =~ /OU=profile51/)│
│       → update reply: VLAN 51, 2M, ACL 3000     │
│    elsif (OU=profile50)                           │
│       → VLAN 50, 4M, ACL 3000                    │
│    elsif (OU=guest)                               │
│       → VLAN 99, 1M, ACL 3001                   │
│    elsif (OU=admin)                               │
│       → VLAN 10, 不限速, ACL 3002               │
│    (无匹配 → 保留默认兜底 VLAN 999)              │
└──────────────────────────────────────────────────┘
       │
       v
┌──────────────────────────────────────────────────┐
│ 3. CN 覆盖（个人级，仅少数人）                   │
│    if (&TLS-Client-Cert-Subject =~               │
│        /CN=client-double-[0-9]+/)                │
│       → update reply: 4M（覆盖 OU 的 2M）       │
│    (CN 不匹配 → 保留 OU 的属性)                 │
└──────────────────────────────────────────────────┘
       │
       v
   reply 属性最终值 → Access-Accept
```

**正则匹配示例**：
- OU 命中：`/OU=profile51/` 匹配 `OU=profile51`，**不**匹配 `OU=profile5`（避免前缀误匹配）
- CN 命中：`/CN=client-double-[0-9]+/` 匹配 `CN=client-double-20260901`、`CN=client-double-20261001`（重签后仍命中）

### 6.6 CRL 吊销检查流程

CRL 检查在 TLS 握手轮 3（客户端发证书）执行：

```
客户端证书到达 rlm_eap_tls
       │
       v
┌─────────────────────────────────────────────┐
│ 1. 证书签名链校验                            │
│    客户端证书 → CA(ca.pem) 签名链完整？       │
│    不完整 → TLS fail → Access-Reject         │
└─────────────────────────────────────────────┘
       │ (签名链 OK)
       v
┌─────────────────────────────────────────────┐
│ 2. 有效期校验                                │
│    notBefore ≤ now ≤ notAfter？              │
│    过期/未生效 → TLS fail → Access-Reject    │
└─────────────────────────────────────────────┘
       │ (有效期 OK)
       v
┌─────────────────────────────────────────────┐
│ 3. CRL 吊销检查（check_crl=yes）             │
│    读取 crl.pem（已 load 进内存）             │
│    证书序列号 ∈ CRL revokedSerials？         │
│    ├── 在 CRL 中 → TLS fail → Access-Reject  │  ★ 吊销即时生效
│    └── 不在 CRL 中 → 继续 TLS 握手            │
└─────────────────────────────────────────────┘
       │ (证书未被吊销)
       v
┌─────────────────────────────────────────────┐
│ 4. CRL 文件有效期校验                        │
│    now ≤ nextUpdate？                         │
│    CRL 过期 → rlm_eap_tls 保守拒绝全部        │  ★ CRL 过期 = 全员 Reject
│    TLS 连接（避免用旧吊销列表）               │
└─────────────────────────────────────────────┘
```

**吊销生效时机**：
- 证书签发时序列号记入 `index.txt`
- `openssl ca -revoke` 把状态改为 `R`（revoked）
- `openssl ca -gencrl` 生成新 `crl.pem`（含 revokedSerials）
- `systemctl reload freeradius` 或 `kill -HUP` 让 rlm_eap_tls 重载 CRL
- **下次终端认证 → TLS 握手轮 3 检查到序列号 → Reject**

**CRL 重载方式**：
- `systemctl reload`：优雅重载，不中断现有连接
- `kill -HUP`：同上，发送 SIGHUP
- **注意**：CRL 重载不影响已建立的 TLS 会话，仅影响新认证

### 6.7 Profile 下发与 AC 应用流程

Access-Accept 携带的 RADIUS 属性被 AC 应用到端口的过程：

```
RADIUS Access-Accept
   │
   │ reply 属性：
   │   Tunnel-Type = VLAN(13)
   │   Tunnel-Medium-Type = IEEE-802(6)
   │   Tunnel-Private-Group-Id = "51"
   │   Huawei-Input-Average-Rate = 2000000   (2 Mbps, bps)
   │   Huawei-Output-Average-Rate = 2000000 (2 Mbps, bps)
   │   Filter-Id = "3000"
   │
   v
┌─────────────────────────────────────────────────┐
│ AC 收到 Access-Accept                            │
└─────────────────────────────────────────────────┘
       │
       v
┌─────────────────────────────────────────────────┐
│ 1. VLAN 下发                                     │
│    Tunnel-Type + Tunnel-Medium-Type +           │
│    Tunnel-Private-Group-Id → AC 把用户端口      │
│    切换到 VLAN 51                                │
│    (华为 AC6003：用户上下文绑定 VLAN)            │
└─────────────────────────────────────────────────┘
       │
       v
┌─────────────────────────────────────────────────┐
│ 2. QoS 限速下发                                  │
│    Huawei-Input-Average-Rate (VSA 2636/4/1) →    │
│    AC 上行限速 2 Mbps                            │
│    Huawei-Output-Average-Rate (VSA 2636/4/2) →  │
│    AC 下行限速 2 Mbps                            │
│    (用户流量在 AC 侧队列调度)                    │
└─────────────────────────────────────────────────┘
       │
       v
┌─────────────────────────────────────────────────┐
│ 3. ACL 下发                                      │
│    Filter-Id = "3000" → AC 在用户上下文挂载     │
│    ACL 3000（已预配置在 AC，允许/拒绝规则）      │
│    (ACL 在 AC 侧匹配，不在交换机)                │
└─────────────────────────────────────────────────┘
       │
       v
   用户端口授权完成
   终端在 VLAN 51 内发起 DHCP → 获取 IP → 通信
```

**属性单位注意**：
- `Huawei-*-Average-Rate` 单位为 **bps**，2 Mbps = 2000000，**不是** 2
- `Tunnel-Private-Group-Id` 字符串形式 `"51"`，不是整数
- `Filter-Id` 字符串形式 `"3000"`，AC 据此匹配本地 ACL

### 6.8 失败场景与处理矩阵

| 场景 | 失败点 | RADIUS 行为 | 终端表现 | AC 行为 |
|---|---|---|---|---|
| 证书过期 | TLS 握手轮 3 有效期校验 | TLS fail → Access-Reject | 提示证书已过期 | 端口保持未授权 |
| 证书未生效 | 同上（notBefore > now） | TLS fail → Access-Reject | 提示证书无效 | 端口保持未授权 |
| 证书被吊销 | TLS 握手轮 3 CRL 检查 | TLS fail → Access-Reject | 提示无法连接 | 端口保持未授权 |
| 证书 CA 不信任 | TLS 握手轮 3 签名链校验 | TLS fail → Access-Reject | 提示不受信任 CA | 端口保持未授权 |
| **CRL 文件过期** | TLS 握手轮 3 CRL nextUpdate | **全员 Reject**（保守策略） | 全员无法连接 | 全员端口未授权 |
| CRL 文件缺失 | rlm_eap_tls 启动检查 | **freeradius 启动失败** | 全员无法认证 | 端口未授权 |
| OU 未匹配任何分支 | authorize 后段 OU 链无命中 | Access-Accept + 默认兜底 VLAN 999 / 512K | 正常连接但限速严重 | 端口切 VLAN 999 |
| CN 个人覆盖命中 | authorize 后段 CN 链 | Access-Accept + 覆盖属性 | 正常连接 | 端口按覆盖属性 |
| eap 模块未启用 `check_crl` | — | 证书不校验 CRL | 吊销证书仍可连接 | — |
| User-Name ≠ EAP-Identity | eap 反伪造检查 | Access-Reject | 提示认证失败 | 端口未授权 |
| FreeRADIUS 服务宕 | — | 无响应（AC 超时） | AC 切到备用 RADIUS 或拒绝 | 端口未授权（取决于 AC 策略） |
| 客户端私钥与证书不匹配 | TLS 握手轮 3 CertificateVerify | TLS fail → Access-Reject | 提示证书无效 | 端口保持未授权 |

### 6.9 认证成功 vs 失败对比

| 维度 | 成功路径 | 失败路径（证书问题） | 失败路径（CRL 问题） |
|---|---|---|---|
| TLS 握手 | 5 轮全部完成 | 轮 3 失败 | 轮 3 失败或全员失败 |
| rlm_eap_tls 返回 | ok | fail | fail（或保守拒绝） |
| authorize 后段 | 进入，填 TLS-Client-Cert-* | 不进入 | 不进入 |
| update reply | 设 VLAN/QoS/ACL | 无 | 无 |
| RADIUS 最终报文 | Access-Accept | Access-Reject | Access-Reject |
| AC 端口 | 切 VLAN + 限速 + ACL | 保持未授权 | 保持未授权 |
| 终端 | DHCP + 正常通信 | 提示无法连接 | 提示无法连接 |
| radpostauth 记录 | Pass | Reject | Reject |
| 审计依据 | TLS-Client-Cert-Subject/CN | EAP-Identity（CN） | EAP-Identity（CN） |

### 6.10 与数据库版认证流程差异

| 阶段 | 数据库版（v1.3） | 纯 RADIUS 版（本 PRD） |
|---|---|---|
| TLS 握手 | 相同（5 轮） | 相同 |
| 客户端证书校验 | 相同（签名链 + 有效期） | **多一步 CRL 吊销检查** |
| User-Name 处理 | P5c 重写 control:SQL-User-Name | **不改 User-Name**（无反伪造风险） |
| Profile 来源 | radusergroup → radgroupreply（SQL 查询） | **TLS-Client-Cert-Subject OU 正则匹配** |
| 数据库依赖 | 必须有 MariaDB（radius_certs + radusergroup + radgroupreply） | **无依赖**（CRL 文件 + unlang） |
| 失败兜底 | DB 挂 → profile 丢失 → 默认 VLAN | CRL 过期 → 全员 Reject（更激进） |
| 个人级 profile | radusergroup 每员工独立行 | CN 正则覆盖（仅少数人） |
| 吊销生效 | radius_certs.status='revoked' → 无 profile | CRL 文件 → TLS 直接 Reject（更彻底） |

---

## 7. 签发流程（OpenSSL 命令）

### 7.1 初始化 CA（已存在，跳过）

当前 CA：`/etc/freeradius/3.0/certs/ca.pem` + `ca.key`，密码 `qcc-radius-ca-2026`。

### 7.2 签发客户端证书（带 OU）

```bash
CN=client-double-20260901
OU=profile51
DAYS=365

# 1. 生成私钥
openssl genrsa -out /etc/freeradius/3.0/certs/issued/${CN}.key 2048

# 2. 生成 CSR（Subject 必须含 OU）
openssl req -new -key /etc/freeradius/3.0/certs/issued/${CN}.key \
  -subj "/C=CN/ST=Beijing/L=Beijing/O=QCC/OU=${OU}/CN=${CN}" \
  -out /tmp/${CN}.csr

# 3. 用 CA 签名
openssl ca -batch -config /etc/freeradius/3.0/certs/openssl.cnf \
  -extensions client_cert \
  -days ${DAYS} \
  -in /tmp/${CN}.csr \
  -out /etc/freeradius/3.0/certs/issued/${CN}.pem \
  -passin pass:qcc-radius-ca-2026

# 4. 打包 P12（含 CA）
openssl pkcs12 -export \
  -in /etc/freeradius/3.0/certs/issued/${CN}.pem \
  -inkey /etc/freeradius/3.0/certs/issued/${CN}.key \
  -certfile /etc/freeradius/3.0/certs/ca.pem \
  -name "${CN}" \
  -passout pass:${P12_PASS} \
  -out /etc/freeradius/3.0/certs/issued/${CN}.p12
```

### 7.3 验证签发的 Subject 含 OU

```bash
openssl x509 -in /etc/freeradius/3.0/certs/issued/client-double-20260901.pem \
  -noout -subject
# 期望输出：
# subject=C = CN, ST = Beijing, L = Beijing, O = QCC, OU = profile51, CN = client-double-20260901
```

### 7.4 签发脚本封装（建议）

提供 `/opt/radius-admin/scripts/issue_cert.sh`：

```bash
#!/bin/bash
# 用法：issue_cert.sh <username> <profile-ou> <p12-pass>
USERNAME=$1
OU=$2
P12PASS=$3
DATE=$(date +%Y%m%d)
CN="client-${USERNAME}-${DATE}"
...（上述 4 步封装）
echo "✓ 证书签发完成: ${CN}"
echo "  OU=${OU} → profile 自动下发"
echo "  P12 文件: /etc/freeradius/3.0/certs/issued/${CN}.p12"
```

---

## 8. 吊销流程（CRL 文件）

### 8.1 吊销单张证书

```bash
openssl ca -config /etc/freeradius/3.0/certs/openssl.cnf \
  -revoke /etc/freeradius/3.0/certs/issued/client-double-20260901.pem \
  -passin pass:qcc-radius-ca-2026
```

### 8.2 重新生成 CRL

```bash
openssl ca -config /etc/freeradius/3.0/certs/openssl.cnf \
  -gencrl \
  -out /etc/freeradius/3.0/certs/crl.pem \
  -passin pass:qcc-radius-ca-2026
```

### 8.3 让 FreeRADIUS 重载 CRL

```bash
systemctl reload freeradius
# 或（不中断连接的优雅重载）
kill -HUP $(pgrep -x freeradius)
```

### 8.4 CRL 自动化（cron）

```bash
# /etc/cron.d/freeradius-crl
# 每天凌晨 2 点重新生成 CRL（包含所有已吊销证书）
0 2 * * * root openssl ca -config /etc/freeradius/3.0/certs/openssl.cnf -gencrl -out /etc/freeradius/3.0/certs/crl.pem -passin pass:qcc-radius-ca-2026 && kill -HUP $(pgrep -x freeradius)
```

> **注意**：OpenSSL `ca` 命令需要在 `openssl.cnf` 配置 `database = index.txt` 记录所有签发/吊销状态。若当前 CA 是用 `x509 -req` 直接签的（无 index.txt），需迁移到 `ca` 命令工作流，或手动维护 CRL（复杂，不推荐）。

### 8.5 CRL 失效保护

CRL 文件有 `nextUpdate` 字段，过期后 rlm_eap_tls 拒绝所有连接（保守策略）。

```bash
# 查看当前 CRL 有效期
openssl crl -in /etc/freeradius/3.0/certs/crl.pem -noout -lastupdate -nextupdate
```

cron 必须在 `nextUpdate` 之前更新（建议有效期 30 天，cron 每天跑）。

---

## 9. Profile 模板变更流程

### 9.1 新增 OU（如新增 finance 部门）

1. 编辑 `sites-enabled/default`，在 OU 匹配链加一段：
   ```unlang
   elsif (&TLS-Client-Cert-Subject =~ /OU=finance/) {
       update reply {
           Tunnel-Private-Group-Id := 60
           Huawei-Input-Average-Rate := 3000000
           Huawei-Output-Average-Rate := 3000000
           Filter-Id := "3004"
       }
   }
   ```
2. `freeradius -C` 语法检查
3. `systemctl reload freeradius`
4. 后续签发的 finance 员工证书 OU 填 `finance` 即可

### 9.2 修改已有 OU 的 profile（如 profile51 改限速）

1. 改 `sites-enabled/default` 对应段的 `Huawei-Input-Average-Rate` 值
2. `systemctl reload freeradius`
3. 已签发的证书**无需重签**（OU 没变，属性即时更新）

> 数据库版要改 `radgroupreply` 表，纯 RADIUS 版要改 `sites-enabled/default` 文件 —— 维护成本类似，但纯 RADIUS 版可走 git 版本控制。

### 9.3 个人级覆盖的增删

- 新增个人覆盖：加 `if (&TLS-Client-Cert-Subject =~ /CN=client-<username>-[0-9]+/)` 段
- 删除个人覆盖：注释掉对应段
- 重签证书换 CN 会让旧覆盖自动失效（CN 正则不匹配）

---

## 10. 部署步骤

### 10.1 准备

```bash
# 1. 备份当前配置（数据库版）
cp /etc/freeradius/3.0/sites-enabled/default /etc/freeradius/3.0/backup-sites/default.bak-$(date +%Y%m%d%H%M%S)-db
cp /etc/freeradius/3.0/mods-available/eap /etc/freeradius/3.0/backup-sites/eap.bak-$(date +%Y%m%d%H%M%S)-db

# 2. 确保 OpenSSL CA 有 index.txt（若没有需初始化）
ls /etc/freeradius/3.0/certs/index.txt || touch /etc/freeradius/3.0/certs/index.txt
ls /etc/freeradius/3.0/certs/serial || echo "1000" > /etc/freeradius/3.0/certs/serial
```

### 10.2 应用配置

```bash
# 1. 修改 eap 模块（加 crl_file + check_crl）
# 2. 修改 sites-enabled/default（按 §5.2 unlang）

# 3. 语法检查
freeradius -C

# 4. 启动 CRL cron
systemctl enable --now cron
cat > /etc/cron.d/freeradius-crl <<'EOF'
0 2 * * * root openssl ca -config /etc/freeradius/3.0/certs/openssl.cnf -gencrl -out /etc/freeradius/3.0/certs/crl.pem -passin pass:qcc-radius-ca-2026 && kill -HUP $(pgrep -x freeradius)
EOF

# 5. 首次生成 CRL（即使没有吊销也要有空 CRL）
openssl ca -config /etc/freeradius/3.0/certs/openssl.cnf -gencrl -out /etc/freeradius/3.0/certs/crl.pem -passin pass:qcc-radius-ca-2026

# 6. 重启
systemctl restart freeradius
```

### 10.3 验证

```bash
# 1. PAP 回归（确保数据库版链路没被破坏）
radtest double CHANGE_ME_SSH_PASS 127.0.0.1 0 testing123 | grep -E "Access-|Tunnel-Private"
# 期望：Access-Accept + Tunnel-Private-Group-Id = 51

# 2. EAP-TLS 测试（需终端用带 OU 的证书）
# 终端连接 test022，预期：
#   Access-Accept + Tunnel-Private-Group-Id = 51（OU=profile51）
#   radpostauth 显示 auth_method=EAP-TLS

# 3. 吊销测试
#   吊销 client-double-20260901 → 重新生成 CRL → reload
#   终端重连 → 预期 Access-Reject（TLS 握手失败）
```

---

## 11. 验收清单

- [ ] `freeradius -C` 语法通过
- [ ] `systemctl is-active freeradius` = active，1812/1813 监听
- [ ] PAP 回归：`radtest double` Accept + VLAN 51 + 2M + Filter-Id 3000
- [ ] EAP-TLS 测试：终端连 test022，Access-Accept + VLAN 51 + 2M（OU=profile51）
- [ ] EAP-TLS 测试：OU=guest 的证书，Access-Accept + VLAN 99 + 1M
- [ ] EAP-TLS 测试：OU 缺失的证书，Access-Accept + VLAN 999（默认兜底）
- [ ] 个人覆盖测试：double 的证书（OU=profile51 + CN=client-double-*）Accept + VLAN 51 + **4M**（CN 覆盖）
- [ ] 吊销测试：吊销证书 → 重生成 CRL → reload → 终端重连 → Access-Reject
- [ ] CRL cron 跑通：手动触发一次 cron，CRL 文件 mtime 更新
- [ ] 数据库版与纯 RADIUS 版并存：PAP 仍走 sql 路径，EAP-TLS 走 OU 路径，互不干扰

---

## 12. 已知风险与边界

### 12.1 OU 正则匹配的坑

**风险**：OU 字段是字符串，正则可能误匹配。

**缓解**：
- OU 严格用 `=` 匹配（`OU=profile51` 而非 `OU=profile5`）
- OU 命名避免前缀冲突（不用 `profile51a`、`profile510`，改用 `profile-51`、`profile-50`）
- 测试用例覆盖：签一张 OU=profile5 的证书，验证**不**匹配 `OU=profile51`

### 12.2 CRL 文件过期导致全部 Reject

**风险**：CRL cron 失效超过 `nextUpdate`，rlm_eap_tls 拒绝所有 EAP-TLS 连接。

**缓解**：
- CRL `default_crl_days = 30`（openssl.cnf）
- cron 每天跑（容忍 30 天失败窗口）
- 监控 CRL `nextUpdate` 字段，过期前 7 天告警

### 12.3 CN 覆盖的脆弱性

**风险**：CN=client-double-20260901 重签后会变成 client-double-20261001，CN 正则 `/CN=client-double-[0-9]+/` 仍匹配，但若用户离职忘删 CN 覆盖段，新员工重用 CN 会误触发覆盖。

**缓解**：
- CN 覆盖仅用于「同 OU 下需特殊待遇」的少数员工，不超过 5 人
- CN 覆盖段加注释标注员工姓名和生效日期
- 离职流程必须删除 CN 覆盖段（与吊销证书同步）

### 12.4 不支持个人级独立 profile

**风险**：纯 RADIUS 版只能 OU 级粒度（除非 CN 覆盖，但 CN 覆盖维护成本高）。

**缓解**：
- 需要「同 OU 下不同 profile」的场景，仍走数据库版（两套并存）
- 或为该员工单独签一张不同 OU 的证书（如 OU=profile51-special）

### 12.5 签发流程失去 radius_certs 表的台账能力

**风险**：纯 RADIUS 版没有 radius_certs 表，证书列表查询只能用 OpenSSL。

**缓解**：
- 签发脚本同时维护一份 CSV 台账 `/etc/freeradius/3.0/certs/issued/ledger.csv`（CN, OU, bound_user, not_after, status）
- 控制台 /admin-spa/#/certs 仍可用，但「证书清单」改为读 CSV 而非 radius_certs 表（需前端改造）

### 12.6 与数据库版的共存策略

| 项 | 数据库版（v1.3） | 纯 RADIUS 版（本 PRD） | 共存方式 |
|---|---|---|---|
| SSID test022 | EAP-TLS + P5c 映射 | EAP-TLS + OU 匹配 | 二选一（不可同 SSID 两套） |
| SSID test011 | EAP-TLS + P5c 映射（保留） | — | 数据库版独占 |
| 新 SSID（如 test033） | — | EAP-TLS + OU 匹配 | 纯 RADIUS 版独占 |
| PAP / Portal / TOTP | sql + radusergroup | sql + radusergroup | **共用**，不冲突 |
| MAC 旁路 | radmacbypass + radcheck | radmacbypass + radcheck | **共用**，不冲突 |

**推荐做法**：现有 SSID 继续走数据库版（已稳定），新 SSID / 边缘节点 / 备份 RADIUS 走纯 RADIUS 版。两套配置在同一 freeradius 实例可并存（authorize 段按 SSID 分支判断）。

---

## 13. 后续待办

- [ ] **v1.0**：本 PRD 审查通过后，开新分支 `cert-pure-radius` 实施
- [ ] **v1.0**：`openssl.cnf` 迁移到 `ca` 命令工作流（若当前是 `x509 -req` 直接签）
- [ ] **v1.0**：CRL 监控脚本（nextUpdate 7 天告警）
- [ ] **v1.1**：签发脚本 `issue_cert.sh` 封装 + 控制台按钮触发
- [ ] **v1.1**：CSV 台账替代 radius_certs 表（控制台前端改造）
- [ ] **v1.2**：OU 命名冲突检测（签发时校验 OU 在 §4.1 映射表内）
- [ ] **v2.0**：与 NetAgent 客户端集成（自动申请带 OU 的证书）

---

## 14. 关键决策记录

| 决策 | 选择 | 理由 | 时间 |
|---|---|---|---|
| profile 下发依据 | 证书 Subject OU | X.509 标准字段、unlang 简洁、组织级粒度足够 | 2026-09-03 |
| 个人级覆盖 | CN 正则匹配（限定 ≤5 人） | OU 粒度不足时的兜底，避免大规模 CN 维护 | 2026-09-03 |
| 吊销机制 | CRL 文件 + check_crl=yes | 不依赖 DB、TLS 握手层直接 Reject、与 X.509 标准一致 | 2026-09-03 |
| 与数据库版关系 | 并存（不同 SSID 路由） | 数据库版已稳定上线、不破坏现有 test011/test022 | 2026-09-03 |
| CRL 自动化 | cron 每天凌晨 2 点 | 容忍 30 天失败窗口、nextUpdate 充裕 | 2026-09-03 |
| 默认兜底 VLAN | 999（512K 限速） | 严格于数据库版（DB 挂时落默认 VLAN 但不限速） | 2026-09-03 |

---

**审查要点**：
1. §3.3 Subject 字段格式是否同意（`/C=CN/ST=Beijing/L=Beijing/O=QCC/OU={profile-id}/CN=client-{username}-{YYYYMMDD}`）
2. §4.1 OU → profile 映射表是否与现有 radgroupreply 一致
3. §5.2 unlang 配置的逻辑分支顺序（默认兜底 → OU 匹配 → CN 覆盖）是否同意
4. §6 认证流程详解的端到端时序、TLS 握手 5 轮、CRL 检查时机是否准确（§6.2~§6.6）
5. §6.8 失败场景矩阵是否覆盖了所有可能的失败路径（CRL 过期 → 全员 Reject 的保守策略是否同意）
6. §8.4 CRL cron 每天 2 点是否合适
7. §12.6 共存策略（新 SSID 走纯 RADIUS、旧 SSID 保留数据库版）是否同意

待审查通过后开 v1.0 实施分支。
