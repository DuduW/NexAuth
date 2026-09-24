# PRD — 证书认证（Client Certificate Console）

**版本**：v1.3（9/3 EAP-TLS 联调收尾：P5c 改用 control:SQL-User-Name，规避 eap 反伪造检查；新增 §16 端到端认证流程详解）
**日期**：2026-08-31
**模块归属**：RADIUS 管理 → 证书认证（独立页面，与 Profile / RADIUS 参数 / Portal 服务 并列）
**URL**：`#/certs`
**前置**：CA（QCC RADIUS Root CA，10 年）与 RADIUS 服务端证书（radius.qcc.com，825 天）已在 `/etc/freeradius/3.0/certs/` 落地

---

## 1. 背景与目标

### 1.1 现状
| 角色 | 路径 | 状态 |
|---|---|---|
| CA 根证书 | `/etc/freeradius/3.0/certs/ca.pem` | ✅ QCC RADIUS Root CA，剩 ~3586 天 |
| CA 根私钥 | `/etc/freeradius/3.0/certs/ca.key` | ✅ `root:root 600`，密码 `qcc-radius-ca-2026` |
| RADIUS 服务端证书 | `/etc/freeradius/3.0/certs/server.pem` + `.key` | ✅ CN=`radius.qcc.com`，剩 ~790 天 |
| DH 参数 | `/etc/freeradius/3.0/certs/dh` | ✅ 1024 位 |

签发流程现状（问题）：必须 ssh 登 192.168.110.106，手敲 `gen_certs.sh`，运维痛点：
- 看不到还剩多少天到期
- 看不到签发了哪些证书
- 没法追踪每张证书绑给了哪个员工
- 续签/补签全凭记忆
- 员工证书要批量发时，shell 流程不可扩展

### 1.2 目标
把"ssh 敲 openssl"升级成"页面点几下"：
1. **看得见**：CA 当前状态、已签发证书清单、剩余天数、健康告警
2. **发得出**：签发客户端证书 + 立即下载 P12（员工双击导入系统证书库）
3. **管得住**：作废（Revoke）单张证书，文件归档，状态可查

### 1.3 非目标（本期不做）
- 不签发 RADIUS 服务端证书（radius.qcc.com）——运维直接走 `gen_certs.sh`
- 不做 ACME / Let's Encrypt 公共证书
- 不做硬件 token / 智能卡
- 不做跨 CA 信任链联邦

---

## 2. 三阶段交付

| 版本 | 内容 | 状态 | 节奏 |
|---|---|---|---|
| **v1.0** | 客户端证书签发（页面 + API + P12 + 作废） | ✅ 已交付 | 8/31 |
| **v1.2** | EAP-TLS 上线联调：eap 模块 ca_file 修正 + 证书身份→账号映射（profile 复用） | ✅ 已交付 | 9/2 |
| **v1.3** | P5c 修复：eap 反伪造检查 Identity≠User-Name 拒绝，改 control:SQL-User-Name（不重写 User-Name） | ✅ 已交付 | 9/3 |
| v1.1 | P12 自动清理过期 + CRL 自动生成 + RADIUS 服务端证书切换提示 | 待办 | 9 月上 |
| v2.0 | NetAgent 自动申请客户端证书（ACME-like 简化）+ EAP-TLS 一键接入 | 远期 | 9 月下 |

---

## 3. 页面布局（沿用 vpnperm 风格）

**位置**：侧边栏「RADIUS 管理」分组下，与 Profile / RADIUS 参数 / RADIUS 配置 / Portal 服务 同级独立页面。

```
┌──────────────────────────────────────────────────────────────┐
│ 证书认证                                  [↻ 刷新] [一键体检] │
│ 为员工签发 EAP-TLS / VPN 客户端证书...                       │
├──────────────────────────────────────────────────────────────┤
│ ⚠️ [告警条]   X 张证书将于 30 天内到期 / 已过期             │
├──────────────────────────────────────────────────────────────┤
│ 🟢 [CA 状态卡]  QCC RADIUS Root CA                            │
│   Subject: CN=QCC RADIUS Root CA,O=GreatLD                   │
│   有效期: 2026-08-31 → 2036-08-31                            │
│   Key Size: 4096 bits · 自签                                  │
│   SHA-256: A2D8...0E0B                                       │
│   [下载 CA (PEM)] [下载 CA (DER)]                            │
├──────────────────────────────────────────────────────────────┤
│ ┌─ 签发新证书 ──────────────┐ ┌─ 客户端证书清单 ──────────┐  │
│ │ 绑给员工:  [double ▼]     │ │ [有效] [已吊销] [全部]    │  │
│ │ 证书 CN:    client-double...│ │ CN / 绑给 / 签发 / 到期 / │  │
│ │ SAN:        email:..        │ │ 状态 / 指纹 / 操作       │  │
│ │ 有效期:     [730] 天        │ │ 🟢🟡🔴⚫⚪ 状态灯         │  │
│ │ Key Size:   [2048▼]        │ │ [查看][PEM][P12][吊销]  │  │
│ │ P12 口令:   [________]      │ │                          │  │
│ │ CA 私钥口令:[________]      │ │                          │  │
│ │ [签发 + 下载 P12]           │ │                          │  │
│ └────────────────────────────┘ └──────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**详情抽屉**（点「查看」滑出）：Subject、Issuer、SAN、Serial、有效期、SHA-256 指纹、状态、原始 PEM。

---

## 4. 数据模型

```sql
CREATE TABLE radius_certs (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  serial_hex         VARCHAR(40)  NOT NULL UNIQUE,
  cn                 VARCHAR(128) NOT NULL,
  san                TEXT,
  user_id            INT,                          -- 软外键 → radcheck.id
  bound_username     VARCHAR(64),                 -- 冗余方便检索
  purpose            ENUM('client') NOT NULL DEFAULT 'client',
  issuer             VARCHAR(255) NOT NULL,
  subject            VARCHAR(255) NOT NULL,
  not_before         DATETIME NOT NULL,
  not_after          DATETIME NOT NULL,
  fingerprint_sha256 CHAR(64) NOT NULL,
  key_size           INT NOT NULL DEFAULT 2048,
  status             ENUM('valid','revoked','expired') DEFAULT 'valid',
  revoked_at         DATETIME,
  revoke_reason      VARCHAR(255),
  cert_pem_path      VARCHAR(255) NOT NULL,
  key_pem_path       VARCHAR(255),
  p12_path           VARCHAR(255),
  issued_by          VARCHAR(64) DEFAULT 'admin',
  issued_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status_exp (status, not_after),
  INDEX idx_user       (user_id),
  INDEX idx_bound_user (bound_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

**软外键**：避免动现有 radcheck 表结构，删除用户时手动 cascade（v1.1 做联级 revoke）。

**文件布局**：
```
/etc/freeradius/3.0/certs/
├── ca.{pem,key}              # CA（不变）
├── server.{pem,key}          # RADIUS 服务端证书（不变）
├── dh                        # DH 参数
├── issued/                   # 客户端证书签发产物
│   ├── client-{user}-{cn}-{serial8}.pem
│   ├── client-{user}-{cn}-{serial8}.key   (chmod 600)
│   └── client-{user}-{cn}-{serial8}.p12   (含 CA 链)
└── revoked/                  # 作废归档
```

---

## 5. 签发流程

1. 管理员在页面选 `bound user`（radcheck 现有 user，排除 MAC 形式）
2. 自动填 CN = `client-{username}-{YYYYMMDD}`，可改
3. 填 SAN（可选）：`email:xxx`、`dns:xxx`、`ip:xxx`，支持逗号多值
4. 默认 730 天有效期，不超 CA 剩余天数
5. 输入 P12 passphrase（员工导入用）+ CA 私钥 passphrase（一次性）
6. 点「签发 + 下载 P12」：
   - 生成 RSA 2048/3072/4096 私钥
   - 创建 CSR
   - 用 CA 私钥签发证书（EKU=clientAuth、SAN、KU=digitalSignature+keyEncipherment）
   - 用 P12 passphrase 打包 PKCS12（含 CA 链）
   - 文件落 `issued/`
   - 元数据落 `radius_certs` 表
   - 浏览器立即开始下载 `.p12`

---

## 6. 后端 API

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/certs/ca` | GET | CA 元数据（subject/issuer/dates/fingerprint/key_size） |
| `/api/certs/ca/download?fmt=pem\|der` | GET | 下载 CA 公钥 |
| `/api/certs/users` | GET | 可绑定用户列表（来自 radcheck Cleartext-Password，过滤 MAC 形式） |
| `/api/certs` | GET | 客户端证书清单（`?status=valid\|revoked\|all&user_id=N`） |
| `/api/certs` | POST | 签发新证书 |
| `/api/certs/{id}` | GET | 详情（含 cert_pem 原文） |
| `/api/certs/{id}/download?as=pem\|p12` | GET | 下载证书/P12（Bearer auth，Blob 推送） |
| `/api/certs/{id}/revoke` | POST | 作废（要求 reason） |
| `/api/certs/alerts?days=30` | GET | N 天内到期 / 已过期 |
| `/api/certs/health` | GET | 一键体检（CA 文件 + 1812 监听） |

### POST /api/certs body
```json
{
  "user_id": 12,
  "bound_username": "double",
  "cn": "client-double-20260831",
  "san": "email:double@qcc.com",
  "validity_days": 730,
  "key_size": 2048,
  "p12_passphrase": "T0ps3cret!",
  "ca_passphrase": "qcc-radius-ca-2026"
}
```

返回含 `p12_b64`（base64 编码的 PKCS12 字节流），前端立即触发下载。

---

## 7. 安全设计

| 风险 | 缓解 |
|---|---|
| CA 私钥泄漏 = 全信任链崩 | 私钥磁盘 `root:root 600`，运行时短时加载到内存 |
| CA 私钥密码泄漏 | 一次性 POST 校验，**不进 DB、不进日志** |
| P12 passphrase 泄漏 | 短期返回给前端展示（base64），不持久化；管理员与员工线下单独传达 |
| 误操作签发 | 默认 CN auto-fill 可改；签发前可编辑 |
| 中间人替换证书 | SAN 严格、EKU=clientAuth、Subject 含 bound username |
| 离职员工证书未撤销 | 状态指示器明示，v1.1 做联级删除 |
| 并发签发竞态 | `threading.Lock` 串行化签名操作 |
| 路由 401 | 后端依赖现有 Bearer auth，前端用 fetch + Auth header 推下载 |
| 作废可逆性 | 文件物理移到 `revoked/`，DB 标记 status=revoked；不可逆操作 |

---

## 8. 文件改动清单（v1.0 已完成）

| 路径 | 改动 | 行数 |
|---|---|---|
| `scripts/sql/001_radius_certs.sql` | 新增，radius_certs 建表 | ~20 |
| `scripts/test_cert_sign.py` | 新增，本地单元测试 | ~95 |
| `scripts/deploy_certs_console.sh` | 新增，sshpass 一键部署 | ~95 |
| `src/backend/core/cert_authority.py` | 新增，cryptography 封装 | ~250 |
| `src/backend/routers/certs.py` | 新增，FastAPI 路由 | ~240 |
| `src/backend/main.py` | 注册 `certs.router` | +2 |
| `src/frontend/src/pages/CertManager.jsx` | 新增，主页面 | ~270 |
| `src/frontend/src/App.jsx` | 加 `/certs` 路由 | +1 |
| `src/frontend/src/components/Sidebar.jsx` | 加「证书认证」菜单项 | +1 |
| `docs/PRD-证书认证.md` | 本文档 | - |

---

## 9. 部署工作流

由于 sandbox 无直连 192.168.110.106 的 SSH 通道，部署由用户在本地执行：

```bash
cd D:\radius
bash scripts/deploy_certs_console.sh
```

脚本步骤：
1. 后端 3 个 Python 文件 scp 到 `/opt/radius-admin/src/backend/`
2. SQL migration scp + 远端执行（建 `radius_certs` 表）
3. `systemctl restart radius-admin`
4. 前端 3 个 JSX 文件 scp + 远端 `npm run build` + 同步到 `/var/www/html/admin-spa/`

**降级方案**（无 sshpass）：
```bash
# PowerShell 直接 scp（交互提示输入密码）
scp src\backend\core\cert_authority.py root@192.168.110.106:/opt/radius-admin/src/backend/core/
scp src\backend\routers\certs.py     root@192.168.110.106:/opt/radius-admin/src/backend/routers/
scp src\backend\main.py              root@192.168.110.106:/opt/radius-admin/src/backend/main.py
scp scripts\sql\001_radius_certs.sql root@192.168.110.106:/tmp/
scp -r src\frontend\dist\.           root@192.168.110.106:/var/www/html/admin-spa/

ssh root@192.168.110.106 "mysql radius < /tmp/001_radius_certs.sql && systemctl restart radius-admin"
```

---

## 10. 测试验证（v1.0 已通过）

`scripts/test_cert_sign.py` 跑通：
- ✅ 临时生成 CA → `ca_meta()` 读取元数据
- ✅ 错误密码被拒（CAPassphraseInvalid）
- ✅ `sign_client()` 签发成功，issuer 校验通过，EKU=clientAuth、SAN 解析（email+dns）
- ✅ P12 打包 4195 字节，DER 头 `3082105f`
- ✅ OpenSSL 命令行可解 P12（`openssl pkcs12 -info`）
- ✅ `revoke()` 把文件移到 `revoked/` 目录
- ✅ `health_check()` 返回完整字段

前端：`vite build` 通过，363.46 KB / gzip 98.58 KB，无警告。

后端：`main.py` + `core/cert_authority.py` + `routers/certs.py` AST 解析全部通过。

---

## 11. 关键决策（含迭代历程）

| 决策点 | 选项 | 选择 | 理由 |
|---|---|---|---|
| 页面位置 | 独立 / RADIUS 配置 tab / 侧边栏嵌套 | **独立页面**（vpnperm 同级） | 与 Profile / RADIUS 参数风格统一，URL 直接可分享 |
| 证书范围 | 服务端 + 客户端 / 仅客户端 | **仅客户端** | 服务端那张 825 天内不需要重签，运维直接走 gen_certs.sh |
| P12 打包 | v1.0 做 / v1.1 做 | **v1.0** | 员工体验关键，少一步命令行 |
| user 绑定 | 自由文本 / 强外键 / 下拉 | **下拉 + 软外键** | 防错字 + 不破坏现有 radcheck |
| 签发实现 | shell openssl / Python cryptography | **cryptography** | 可锁（threading.Lock）、可测（test_cert_sign.py 一次过）、无 shell 注入 |
| CA 私钥存哪 | 磁盘 / DB / HSM | **磁盘原位** | 已在 `/etc/freeradius/3.0/certs/`，无迁移成本 |
| CA 私钥密码 | DB 字段 / 一次性 POST / 内存常量 | **一次性 POST** | 不进 DB 不进日志，最小暴露面 |
| FreeRADIUS 联动 | 自动 reload / 一键提示 / 不联动 | **v1.0 不联动** | 客户端证书签发跟 RADIUS 服务端无关 |
| 下载鉴权 | URL token / Bearer auth + Blob | **Bearer + Blob** | 复用现有 fetchApi 鉴权模式 |

---

## 12. 验收清单（v1.0 部署后验证）

- [ ] `curl http://192.168.110.106/api/certs/health` 返回 200，ca_cert_exists=True
- [ ] 浏览器访问 `http://192.168.110.106/admin-spa/#/certs`
- [ ] 侧边栏「RADIUS 管理」分组下有「证书认证」菜单项
- [ ] 页面打开可见 CA 状态卡（subject/issuer/剩余 N 天）+ 已签发证书清单（首次为空）
- [ ] 选员工「double」→ 自动填 CN `client-double-20260831`
- [ ] 输入 P12 口令 + CA 私钥口令 → 点「签发+下载 P12」
- [ ] 浏览器立即开始下载 `client-double-20260831-XXXXXXXX.p12`
- [ ] Windows 双击 .p12 → 导入系统证书库成功（验证 P12 完整性）
- [ ] 清单上看到新行，状态指示器 🟢 + 剩余天数
- [ ] 点「吊销」→ 输入原因 → 文件移到 `revoked/`，清单状态变 ⚪
- [ ] 30 天内到期的证书标 🟡 / 🔴
- [ ] 风格对齐 vpnperm 页（浅灰背景 + 白色卡片 + 大圆角 + iOS 系统配色）
- [ ] FreeRADIUS 服务端那张 radius.qcc.com 不受影响，1812/18120 正常监听

---

## 13. 历程（8/31 三轮迭代）

| 时间 | 用户反馈 | 行动 |
|---|---|---|
| 17:30 | 「证书哪里获取，整理一个证书颁发的页面」 | 写 PRD v1.0（独立页面），写 cert_authority.py + routers/certs.py + CertManager.jsx + SQL + 部署脚本 |
| 17:55 | 「我希望在后他页面上给 client 颁发证书」 | 调整 PRD：仅客户端 + P12 + user_id 下拉 |
| 18:25 | 「证书管理放 RADIUS 管理 中一个子页面」 | 改成 RADIUS 配置 tab 形态 + useSearchParams + Navigate 重定向 |
| 18:33 | 「RADIUS 管理 就像 RADIUS 参数，添加证书认证的一个页面」 | **回滚到独立页面**（当前形态） |

---

## 14. 后续待办

- [ ] **v1.1**：P12 自动清理（>30 天到期的客户端证书提醒）+ CRL 自动生成 + RADIUS 服务端证书切换入口
- [ ] **v1.1**：删除用户时联级 revoke 该用户所有证书
- [x] **v1.3**：EAP-TLS + profile 下发联调通过（9/3，test022 实测 Accept + VLAN 51）
- [ ] **v2.0**：NetAgent 自动申请证书（ACME-like 流程，员工点 NetAgent 一键签发 EAP-TLS 客户端证书）
- [ ] **v2.0**：服务端证书切到 Let’s Encrypt（每年自动续）
- [ ] **改进**：后端签名操作改 asyncio.Lock（兼容 FastAPI 异步并发）
- [ ] **改进**：CA 密码用环境变量 + 服务端 reload（避免每次手动输）

---

## 15. EAP-TLS 上线联调修复（9/2，v1.2）

AC6003 开 SSID test022（802.1X EAP-TLS → 192.168.110.106:1812）联调，两轮修复：

### 15.1 Access-Reject「error 20: unable to get local issuer certificate」

- **根因**：`mods-available/eap` 的 `ca_file` 指向系统公共 CA 库（`/etc/ssl/certs/ca-certificates.crt`），不含 QCC RADIUS Root CA，服务端验客户端证书链失败。
- **修复**：line 228 → `ca_file = ${cadir}/ca.pem`，重启 freeradius。备份 `eap.bak-*`。
- 教训：签发体系（ca.pem/server.pem/issued/）建好后，**必须核对 eap 模块实际加载的信任库**。

### 15.2 证书认证时 Profile（VLAN/QoS/ACL）不生效

- **根因**：profile 走 `User-Name → radusergroup → radgroupreply` SQL 链路；证书认证时 User-Name = 证书 CN（如 `client-double-20260901`），radusergroup 里没有该行 → 组属性不下发。
- **修复（P5）**：`sites-enabled/default` authorize 段、`sql` 之前插入证书身份映射。**初版直接重写 User-Name，9/3 实测发现破坏 eap 反伪造检查，已升级为 P5c（见 15.4）**。最终生效的 P5c 配置：

```unlang
# sites-enabled/default  authorize 段（sql 之前）
if (&User-Name =~ /^client-[A-Za-z0-9._-]+$/) {
    if ("%{sql:SELECT bound_username FROM radius_certs WHERE cn = '%{User-Name}' AND status = 'valid' LIMIT 1}" != "") {
        update control {
            SQL-User-Name := "%{sql:SELECT bound_username FROM radius_certs WHERE cn = '%{User-Name}' AND status = 'valid' LIMIT 1}"
        }
    }
}
```

```ini
# mods-enabled/sql
sql_user_name = "%{%{control:SQL-User-Name}:-%{User-Name}}"
```

- 效果：User-Name 保持证书 CN（eap 反伪造检查 Identity==User-Name 通过）；sql 模块优先用 control:SQL-User-Name=bound 账号（如 double）查 radusergroup/profile51，VLAN 51 / QoS / ACL 一并下发。
- 副作用（预期内）：radpostauth / 认证日志中证书认证的 username 记录为映射后的账号（double），不再是证书 CN。
- 边界：账号名以 `client-` 开头的用户会先查 radius_certs（查不到则原样放行，无影响）；吊销证书后映射立即失效（status='valid' 条件）。
- 配置备份：`sites-enabled/default.bak-*` 与 `mods-enabled/sql.bak-*` 存放于 `/etc/freeradius/3.0/backup-sites/`（**不能放 sites-enabled/ 内**，会被当第二站点加载导致 Duplicate virtual server 启动失败）。

### 15.3 EAP-Identity Access-Reject：radgroupcheck Auth-Type 劫持

- **现象**：终端 identity 填 `double` 时 Reject 在 EAP-Identity 轮（TLS 未启动），radius.log 报 `Login incorrect: [double/<via Auth-Type = Accept>]`。
- **根因**：`radgroupcheck` 遗留 daloRADIUS 的 `Auth-Type := Accept`（it/admin/it-test/guest-std/profile51）。authorize 中 sql 先于 eap 执行 → 属于这些组的用户 Auth-Type 被 Accept 覆盖 → eap 不接管 → Reject。identity=证书 CN 时成功纯属偶然（CN 不属于任何组）。
- **修复**：备份 `/root/radgroupcheck-backup-20260902.sql` 后删除全部 `Auth-Type := Accept` 行，仅保留 `daloRADIUS-Disabled-Users` 的 Reject。无需重启（radgroupcheck 每请求实时读取）。
- **正向副作用**：这些组用户的 PAP 从"无条件 Accept（不验密码）"恢复为真实密码校验。
- **验证**：radtest double → Access-Accept 且携带 profile51 全属性（VLAN 51 / 2M/2M QoS / Filter-Id 3000）。
- **教训**：`radcheck` / `radgroupcheck` 中的 `Auth-Type` 行是 EAP 认证杀手；EAP-Identity 轮拒绝优先排查这两张表。
- **关于 OU 方案**：曾考虑在证书 Subject 里嵌 OU 组实现 profile 下发（OU → 组属性）。当前设计不需要：P5 映射（CN → bound_username → radusergroup）已实现**用户级**粒度，比 OU 的**组织级**粒度更细。OU 方案可作为 v2.x 的粗粒度兜底（无需 DB 查询，纯 unlang 匹配 TLS-Client-Cert-Subject）。

### 15.4 EAP-TLS Access-Reject：eap 反伪造检查 Identity≠User-Name（P5b→P5c）

- **现象**：9/3 09:51 / 09:57 用户重连 test022 仍 Access-Reject，但已进入 **EAP-TLS 阶段**（不再是 EAP-Identity），说明 15.3 的 Auth-Type 劫持已清除、eap 已接管。
- **调试取证**：挂 freeradius `-X` 调试窗口抓 `/tmp/rdebug6.log`，铁证为：

```
(2) eap: Identity does not match User-Name.  Authentication failed
(2) eap: Failed in handler → [eap] = invalid → Access-Reject
```

- **根因**：rlm_eap 的反伪造检查在**每一轮** EAP 处理时都做（不只身份轮）——比较 EAP-Identity（首轮发来的 `client-double-20260901`）与当前请求的 User-Name。P5/P5b 的 `update request { User-Name := ... }` 把 User-Name 改成 `double`，eap 随即判 Identity≠User-Name → invalid → Reject。P5b 的「只在 0x0D 轮重写」仍触发太早（客户端首个 TLS 数据轮含 ClientHello 就匹配 0x0D）。
- **修复（P5c）**：换思路——**根本不重写 User-Name**，改让 rlm_sql 优先用 control:SQL-User-Name 查 profile：
  1. `mods-enabled/sql`：`sql_user_name = "%{%{control:SQL-User-Name}:-%{User-Name}}"`
  2. `sites-enabled/default` authorize：`update request { User-Name := ... }` → `update control { SQL-User-Name := ... }`
- 效果链路：User-Name 保持证书 CN → eap 反伪造检查 Identity==User-Name **通过**；sql 用 SQL-User-Name=double 查 radusergroup → profile51 全属性下发。
- 验证：`freeradius -C` 通过；服务 active；radtest PAP Accept + VLAN 51 + 2M/2M + Filter-Id 3000 回归；**用户重连 test022 → EAP-TLS Access-Accept，profile 随证书认证下发成功** ✅。
- 教训：rlm_eap 的 User-Name 是身份契约，**任何在 authorize 里重写 User-Name 的逻辑都会破坏 EAP 握手**。需要按其它字段影响 sql 查询时，用 `control:SQL-User-Name` + sql 模板 `%{%{control:SQL-User-Name}:-%{User-Name}}`，这是 FreeRADIUS 文档化的标准做法。

### 15.5 服务静默宕机事故与加固（9/2 晚 → 9/3 上午）

- **事故**：清理 -X 调试实例时 `pkill -f capture_eap.sh` 把执行命令的 shell 自身也杀了（命令行包含该关键字），后续 `systemctl start` 未执行，freeradius 宕机一夜，终端表现为「无法连接到此网络」且 RADIUS 零日志（不是拒绝，是根本没收到包）。
- **加固**：systemd drop-in `/etc/systemd/system/freeradius.service.d/restart.conf`，`Restart=always / RestartSec=5`（原为 `on-failure`，正常 stop 不自愈）。
- 教训：`pkill -f` 的模式串绝不能出现在当前命令行自身中（自匹配自杀）；远程后台长跑任务用 `setsid ... < /dev/null >文件 2>&1 &` 脱离会话；排障先查 `systemctl is-active` + 端口监听——「无报错」也可能是服务根本没跑。

---

## 16. 证书认证流程（端到端详解）

> 本章节描述从「管理员签发证书」到「终端连上 WiFi 拿到 VLAN/QoS/ACL」的完整链路。**v1.3 联调通过后**的最终流程，所有组件均已上线生效。

### 16.1 角色与组件

| 角色 | 实例 | 职责 |
|---|---|---|
| **CA** | `/etc/freeradius/3.0/certs/ca.pem` + `ca.key`（密码 `qcc-radius-ca-2026`） | 给所有客户端/服务端证书签名，是终端和服务端共同信任的根 |
| **签发控制台** | http://192.168.110.106/admin-spa/#/certs | 管理员登录后签发/吊销客户端证书 |
| **RADIUS 服务** | FreeRADIUS 3.0 @ 192.168.110.106:1812 | 接收 AC 的 Access-Request，跑 EAP-TLS 握手，查 radius_certs/radusergroup，回 Access-Accept/Reject |
| **AC** | HUAWEI AC6003 @ 192.168.30.15 | SSID test022 的认证方（Authenticator），把终端的 EAP 消息透传到 RADIUS |
| **终端 supplicant** | Windows WLAN AutoConfig / macOS / iOS | 持有客户端证书私钥，完成 EAP-TLS 客户端侧握手 |
| **radius_certs 表** | MySQL `radius.radius_certs` | 证书台账：cn / bound_username / status / 证书文件路径 / 有效期 |

### 16.2 端到端时序总览

```
[管理员]              [终端]            [AC]            [RADIUS]         [MariaDB]
    |                    |                |                |                 |
  1.登录控制台           |                |                |                 |
  2.填表签发 ────────────────────────────────────────────► SELECT bound_username
  3.下载 P12            |                |                |                 |
    |                    |                |                |                 |
  4.导入 P12 到个人存储 + CA 到根信任     |                |                 |
    |                    |                |                |                 |
  5.连接 test022 ─────► 关联请求 ──────► |                |                 |
    |                    |                |                |                 |
  6.EAP-Response/Identity(client-CN)────► | ─────────────► |                 |
    |                    |                |  Access-Request |                 |
    |                    |                |                | 查 radcheck (无)  |
    |                    |                |                | eap 模块接管     |
    |                    |                |                |                 |
  7.EAP-TLS 4 轮握手 ◄─────────────────► | ◄────────────► |                 |
    |                    |                |  透传 EAP 消息   |                 |
    |                    |                |                | TLS 握手 + 链校验 |
    |                    |                |                | control:SQL-    |
    |                    |                |                |  User-Name 设 double
    |                    |                |                | ───────────────►│
    |                    |                |                | ◄──────────────│
    |                    |                |                |  radusergroup+   |
    |                    |                |                |  radgroupreply  |
    |                    |                |                | (VLAN/QoS/ACL)  |
    |                    |                |                |                 |
  8.Access-Accept + profile 属性 ◄───────────────────────|                 |
    |                    |                |                |                 |
  9.4-way Handshake → 关联成功 → 终端拿到 VLAN 51 IP      |                 |
```

### 16.3 阶段详解

#### 阶段 A：管理员签发证书（控制台）

**入口**：http://192.168.110.106/admin-spa/#/certs → 签发表单

**字段说明**：

| 字段 | 取值 | 说明 |
|---|---|---|
| 用户 | 下拉选 `double`（来自 radcheck） | 证书要绑定的真实账号 |
| 证书 CN | 自动生成 `client-{username}-{YYYYMMDD}`（如 `client-double-20260901`） | 终端 EAP-Identity 字段填这个 |
| SAN | 可填 `email:double@qcc.com` / `dns:` / `ip:` | 留空可，校验由后端做 |
| 用途 | `client-auth`（EKU） | 限定只能用于客户端认证 |
| 有效期 | 1 年 | not_after 写入 radius_certs |
| CA 私钥密码 | `qcc-radius-ca-2026` | 解锁 ca.key 给签名用，固定值 |
| P12 口令 | ≥8 位自设 | 给 .p12 文件加密，员工导入时用 |

**后端处理（`POST /api/certs`，`routers/certs.py`）**：

1. 校验 CA 口令：`cert_authority.load_ca()` 用口令解密 `ca.key`，失败回 422「CA 私钥密码错误」
2. 校验 SAN 格式（email 必含 `@`、ip 合法、dns 空跳过）
3. `asyncio.Lock` 串行化签名（防并发）→ `cryptography.x509.CertificateBuilder` 签发：
   - Subject：`CN=client-double-20260901`
   - Issuer：CA 自身 Subject（`CN=qcc-radius-ca-2026`）
   - EKU：`CLIENT_AUTH`
   - SAN：用户填的项
   - not_before = now、not_after = now + 1y
4. `package_p12()` 把 cert + key + ca 打包成 PKCS12（PBE3SHA1/AES256）
5. 落盘：`/etc/freeradius/3.0/certs/issued/{cn}.pem` + `.key` + `.p12`
6. 写 `radius_certs` 表：cn / bound_username / serial_hex / fingerprint_sha256 / status='valid' / not_before / not_after / 文件路径
7. 返回前端证书清单 + 下载链接

**关键文件**：

| 路径 | 内容 |
|---|---|
| `/etc/freeradius/3.0/certs/ca.pem` | CA 公钥证书（10 年有效，所有客户端要信任它） |
| `/etc/freeradius/3.0/certs/ca.key` | CA 私钥（密码 `qcc-radius-ca-2026` 保护） |
| `/etc/freeradius/3.0/certs/issued/{cn}.pem` | 客户端证书 |
| `/etc/freeradius/3.0/certs/issued/{cn}.key` | 客户端私钥（无密码） |
| `/etc/freeradius/3.0/certs/issued/{cn}.p12` | 打包给终端导入的 PKCS12 文件 |

#### 阶段 B：终端导入 P12（Windows 示例）

1. **管理员把 .p12 文件交给员工**（邮件/U盘，不要明文发 P12 口令）
2. 员工双击 .p12 → 「当前用户」→ 「个人」存储 → 输入 P12 口令 → 完成
3. **同时把 ca.pem 发给员工**，双击 → 「受信任的根证书颁发机构」→ 完成
   - 否则 TLS 握手时终端不信任服务端证书 → error 20 反向出现（客户端报「找不到签发者」）
4. 验证：`certmgr.msc` → 个人 → 证书 → 能看到 `client-double-20260901`；受信任根 → 能看到 `qcc-radius-ca-2026`

#### 阶段 C：AC 端 SSID 配置（一次性）

```
# 安全模板（关键！必须是 802.1X，不能是 PSK/Portal）
wlan security-profile name sec-test022
 security wpa2 dot1x aes        # ← 这一行决定终端能否选证书

# VAP 模板绑定 RADIUS 方案
wlan vap-profile name vap-test022
 security-profile sec-test022
 radius-server profile QLink-RADIUS   # 主认证 192.168.110.106
 service-vlan vlan-id 51
 ssid-profile name ssid-test022
```

> **判断依据**：终端连 SSID 时**出现「选择证书」对话框** → 安全模板配对；只弹密码框或网页 → 模板配错，终端永远不会走证书。

#### 阶段 D：EAP-TLS 4 轮握手详解

终端点连接 test022 后，触发以下握手（基于 RFC 5216 + RFC 3748）：

| 轮次 | 方向 | 消息 | 内容 / 作用 |
|---|---|---|---|
| **1** | 终端→AC→RADIUS | `EAP-Response/Identity` | User-Name = 证书 CN（`client-double-20260901`）。RADIUS 此时记录认证方式 `EAP-Identity`，进 radpostauth |
| **2** | RADIUS→AC→终端 | `EAP-Request/EAP-TLS(Start)` | 通知终端开始 TLS 握手 |
| **3** | 终端→RADIUS | `EAP-Response/EAP-TLS(ClientHello)` | 终端发起 TLS，含支持的密码套件、随机数 |
| **4** | RADIUS→终端 | `ServerHello + Certificate + ServerKeyExchange + CertificateRequest + ServerHelloDone` | 服务端证书（`server.pem`）+ 索要客户端证书 + 服务端签名 |
| **5** | 终端→RADIUS | `Certificate + ClientKeyExchange + CertificateVerify + ChangeCipherSpec + Finished` | 客户端证书 + 证明持有私钥 + 加密切换 |
| **6** | RADIUS→终端 | `ChangeCipherSpec + Finished` | 服务端完成 TLS 握手 |
| **7** | RADIUS→AC | `EAP-Success` | rlm_eap 返回 ok → 进入 authorize 下半段查 profile |

**服务端在轮 4/5 做的两项关键校验**：

- **轮 4**：用 `ca_file=${cadir}/ca.pem`（**v1.2 修复后**）信任库校验客户端证书链。若 ca_file 仍指向 `/etc/ssl/certs/ca-certificates.crt`（系统公共库）→ error 20 `unable to get local issuer certificate`（§15.1）
- **每轮**：`rlm_eap` 检查 `EAP-Identity == User-Name`（反伪造）。若 authorize 段把 User-Name 重写为 `double` → `Identity does not match User-Name. Authentication failed`（§15.4 P5b 失败原因）

#### 阶段 E：profile 下发（P5c 机制，关键）

TLS 握手成功后，**继续在同一会话的 authorize 段**执行以下链路（顺序至关重要）：

```unlang
# sites-enabled/default authorize 段（节选，按实际执行顺序）
authorize {
    preprocess
    filter_username
    suffix
    eap { ok = return }                      # ← EAP 握手在轮 7 完成时返回 ok，跳出本轮
    # ↓ TLS 成功后才进到这里（之前每轮都被 eap 拦截）
    
    # P5c: 证书 CN → bound_username 映射，但 NOT 改 User-Name（避免破坏 eap 反伪造）
    if (&User-Name =~ /^client-[A-Za-z0-9._-]+$/) {
        if ("%{sql:SELECT bound_username FROM radius_certs WHERE cn = '%{User-Name}' AND status = 'valid' LIMIT 1}" != "") {
            update control {
                SQL-User-Name := "%{sql:SELECT bound_username FROM radius_certs WHERE cn = '%{User-Name}' AND status = 'valid' LIMIT 1}"
            }
        }
    }
    
    sql                                       # ← 用 SQL-User-Name 查 radusergroup
    expiration
    ...
}
```

配合 `mods-enabled/sql` 的用户名模板：

```
sql_user_name = "%{%{control:SQL-User-Name}:-%{User-Name}}"
```

**效果链路**：

| 步骤 | User-Name | control:SQL-User-Name | sql 查组用的账号 | 命中 radusergroup |
|---|---|---|---|---|
| eap 校验（每轮） | `client-double-20260901` | — | — | eap 反伪造 ✅ Identity==User-Name |
| P5c 映射 | `client-double-20260901`（不变） | `double` | — | — |
| sql 查组 | `client-double-20260901`（不变） | `double` | **`double`**（优先用 control） | ✅ 命中 `double → it-test + profile51` |
| 回复 | — | — | — | Access-Accept 带 profile 属性 |

**最终 Access-Accept 携带的 profile 属性**（实测）：

```
Tunnel-Type: VLAN
Tunnel-Medium-Type: IEEE-802
Tunnel-Private-Group-Id: 51                        # VLAN 51
Huawei-Input-Average-Rate: 2000                    # 2 Mbps 上行限速
Huawei-Output-Average-Rate: 2000                  # 2 Mbps 下行限速
Filter-Id: 3000                                   # ACL 3000
```

#### 阶段 F：终端拿到 IP，进入业务 VLAN

1. AC 收到 Access-Accept → 4-way Handshake → 关联成功
2. AC 把终端划入 VLAN 51（受 Tunnel-Private-Group-Id 指示）
3. 终端 DHCP 拿 VLAN 51 网段 IP → 业务可达

### 16.4 吊销链路

1. 管理员在控制台点「吊销」→ `routers/certs.py` 调 `cert_authority.revoke()`
2. 写 `radius_certs.status='revoked'`、`revoked_at=now()`
3. 生成/更新 CRL（**v1.1 待办**，当前依赖 status 字段判定）
4. **下次该证书认证时**：
   - P5c 的 SQL `WHERE status='valid'` 查不到 bound_username → `control:SQL-User-Name` 不设
   - sql 模块回退用 User-Name（证书 CN）查 radusergroup → 查不到组
   - TLS 握手若仍通过（CRL 未生效）→ Access-Accept 但**无任何 profile 属性**
   - 终端拿到默认 VLAN（可能是 guest），无法访问业务网段
5. CRL 生效后（v1.1 上线）：TLS 握手在轮 5 直接 fail → Access-Reject

### 16.5 关键校验点与失败排查表

| 现象 | 可能根因 | 排查命令 | 对应章节 |
|---|---|---|---|
| 终端「无法连接到此网络」，RADIUS 零日志 | freeradius 服务没跑 | `systemctl is-active freeradius; ss -ulpn \| grep 1812` | §15.5 |
| `EAP-Identity Access-Reject` | radgroupcheck 遗留 `Auth-Type := Accept` 劫持 | `SELECT * FROM radgroupcheck WHERE attribute='Auth-Type'` | §15.3 |
| `EAP-TLS Access-Reject` + `error 20: unable to get local issuer certificate` | eap 模块 ca_file 指向系统公共库 | `grep ca_file /etc/freeradius/3.0/mods-available/eap` | §15.1 |
| `EAP-TLS Access-Reject` + `Identity does not match User-Name` | P5/P5b 重写 User-Name 破坏 eap 反伪造 | `grep P5 /etc/freeradius/3.0/sites-enabled/default` | §15.4 |
| `EAP-TLS Access-Accept` 但无 VLAN/限速 | P5c 映射未生效（sql_user_name 模板错或 status≠valid） | `SELECT bound_username,status FROM radius_certs WHERE cn='...'` | §15.2 |
| 终端弹不出「选证书」对话框 | AC 安全模板非 `wpa2 dot1x` | `display security-profile all` | §16.3 阶段 C |
| 终端报「不信任 CA」 | ca.pem 未导入「受信任根」 | 终端 `certmgr.msc` 查 | §16.3 阶段 B |
| 签发 422「CA 私钥密码错误」 | 表单填错或和 P12 口令搞混 | 填 `qcc-radius-ca-2026` | §16.3 阶段 A |
| 签发 500（SAN email 空） | SAN 格式不合法 | email 必含 `@`，ip 必合法 | §16.3 阶段 A |

### 16.6 与其他认证方式的关系（并行架构）

| 认证方式 | User-Name 来源 | profile 加载方式 | 是否走 eap | 是否需 radius_certs 映射 |
|---|---|---|---|---|
| **PAP/CHAP**（账号密码） | 终端填的账号（`double`） | sql 直接用 User-Name 查 radusergroup | 否 | 否 |
| **Portal** | Portal Server ACK 后回填 | 同上 | 否 | 否 |
| **TOTP 2FA** | PAP 通过后叠加 rlm_python3 校验 | 同上 | 否 | 否 |
| **MAC 旁路** | MAC（无分隔符） | 走 radmacbypass 表 | 否 | 否 |
| **EAP-PEAP**（账号密码 over TLS） | 终端 identity + 内层 User-Name | 内层 User-Name 查 radusergroup | 是（外层 TLS） | 否 |
| **EAP-TLS**（证书） | 证书 CN（`client-*`） | **P5c 映射** → control:SQL-User-Name 查 radusergroup | 是 | **是** |

**并行原则**：所有方式在同一 RADIUS 服务、同一 `sites-enabled/default` 配置下共存，由不同条件分支路由。EAP-TLS 是唯一需要 P5c 映射的，因为它的 User-Name 是证书 CN 而非账号。
