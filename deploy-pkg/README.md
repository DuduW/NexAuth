# 企业网络管理平台 · 一键部署包

> 版本 v1.6 · 2026-09-24 · 目标系统 Ubuntu 22.04 LTS
> 源环境：192.168.110.106（克隆式部署——仅克隆**代码与配置结构**）
> **不含任何源环境数据**：数据库种子为全新最小集（仅初始 admin 账号），EAP 证书部署时本机全新自签
> **已在干净 Ubuntu 22.04 虚机（192.168.110.125）完成端到端实测：全新装机 19/19 自检通过**

---

## 1. 包内容

```
nac-platform-deploy-v16.tar.gz
└─ deploy-pkg/
   ├─ install.sh          # 一键安装脚本 v1.6（bash，含 20+ 处失败防线 + 19 项自检）
   ├─ README.md           # 本说明
   └─ payload/            # 部署物料（源机实测收集，软链已实体化）
      ├─ freeradius/      # FreeRADIUS 配置（263 文件）
      │  ├─ radiusd.conf      #   主配置
      │  ├─ clients.conf      #   NAS 客户端定义
      │  ├─ dictionary        #   本地扩展字典（含 Auth-Method 102 自定义属性）
      │  ├─ sites-enabled/    #   default + inner-tunnel（实体文件）
      │  ├─ mods-enabled/     #   sql/eap/expiration/logintime 等（实体文件）
      │  ├─ mods-config/      #   全量模块配置（含 sql/main/mysql 查询）
      │  ├─ policy.d/         #   策略（含 check-eap-tls 等）
      │  └─ certs/            #   仅自签骨架（Makefile/bootstrap/*.cnf/dh）——安装时全新生成证书
      ├─ opt/             # 应用代码
      │  ├─ radius-admin/     #   FastAPI 后端（23 路由文件 / 161 端点）
      │  ├─ portal_server.py  #   华为 Portal 协议服务（:8080 / UDP 50100）
      │  ├─ detail_sync.py    #   记账入库（cron 每分钟）
      │  ├─ vpn_visit_collector.py / health_check.sh
      │  └─ zt_*.py           #   零信任遗留采集（cron 可选）
      ├─ systemd/         # radius-admin.service / portal-server.service
      ├─ nginx/           # nginx 站点配置（:80，/api/ 反代 :8000）
      ├─ db/
      │  ├─ schema.sql        # 66 张表结构（含 DROP TABLE，重装即清库）
      │  └─ seed.sql          # 最小种子（5 条：admin 账号/admin 组/group-guest/本机测试 NAS）
      └─ frontend/admin-spa/  # 前端构建产物（压缩后约 3MB）
```

## 2. 部署要求

| 项 | 要求 |
|---|------|
| 操作系统 | Ubuntu 22.04 LTS（其他版本未验证，脚本会告警但继续） |
| 权限 | root（`sudo bash install.sh`） |
| 网络 | 可出网（apt 安装 freeradius/mariadb/nginx + pip 下载 Python 依赖） |
| 磁盘 | 根分区剩余 ≥ 2GB（脚本预检） |
| 端口 | 80(nginx) / 8000(API) / 8080(Portal Web) / 1812、1813、3799/UDP(RADIUS) / 50100/UDP(Portal) / 3306(MySQL, 仅本机) |
| 机器状态 | 全新机最佳；重装机注意：**会覆盖 /etc/freeradius/3.0**（原配置备份为 3.0.orig）、**radcheck 有数据时导库需输入 yes 确认** |

## 3. 快速部署（三步）

```bash
# 1. 解压（任意目录）—— 包内自带顶层 deploy-pkg/ 目录
tar xzf nac-platform-deploy-v15.tar.gz
cd deploy-pkg

# 2. （可选）改配置区：数据库名/账号密码/共享密钥
vi install.sh        # 顶部「配置区」，密码避免使用 & 和 | 字符

# 3. 安装
sudo bash install.sh           # 交互式（推荐，会提示 DB root 密码与数据重置确认）
sudo bash install.sh --auto    # 全自动（测试环境；已有数据时自动跳过导库）
```

安装约 3~10 分钟（实测：系统依赖已装时 35 秒；全新机视 apt/pip 网速，PyPI 慢时 pip 会断点续传重试），结束时输出 **18 项自检结果**与访问信息，日志在 `/var/log/deploy-install.log`。

> **非交互运行提示**：通过管道/远程脚本调用（stdin 非终端）时，脚本自动按默认值处理（socket 免密连 DB、有数据跳过导库），不会卡在 read 等待。

### 安装脚本做了什么（9 步）

| 步骤 | 动作 | 失败防护 |
|------|------|----------|
| 1 | apt 装 freeradius/mariadb/nginx/python 等 | 失败即中止并提示看日志 |
| 2 | 建 venv + pip 装 10 个 Python 依赖；系统 python 补 pymysql | import 自检 |
| 3 | MariaDB 建库建账号 + 导入 schema/seed | root 连接预检；**有数据时需输 yes 确认重置** |
| 4 | 铺 FreeRADIUS 配置（每次全新铺放防嵌套）+ 密码回填 + `freeradius -XC` 校验 | 校验失败打印错误并中止 |
| 5 | 部署 /opt 应用 + DB 密码回填（后端配置与 3 个脚本） | 回填后 grep 验证 |
| 6 | systemd 单元（ExecStart 自动改指 venv）+ SW_MASTER_KEY 随机生成注入 | 启动失败自动 dump journal 尾 20 行 |
| 7 | nginx 站点（/api/ 反代，300s 超时） | nginx -t 预检 |
| 8 | admin-spa 前端铺放 | index.html 存在性检查 |
| 9 | cron 任务（detail_sync 每分钟等 3 条，幂等去重） | — |

## 4. 部署完成后的访问信息

| 入口 | 地址 | 凭据 |
|------|------|------|
| 管理后台 | `http://<新机IP>/admin-spa/` | 初始账号 `admin`（**密码来自源环境 radcheck，务必立即改**） |
| API | `http://<新机IP>:8000/api/` | 同后台账号（JWT） |
| Portal 认证页 | `http://<新机IP>:8080/` | 终端用户 WiFi 认证用 |
| RADIUS | `<新机IP>` UDP 1812/1813/3799 | 共享密钥默认 `Huawei@Radius123` |

## 5. 生产上线前必做（安全清单）

| # | 项 | 操作 |
|---|---|------|
| 1 | **改后台账号密码** | 初始 `admin / admin123`（安装完成输出有提示），登录后台后立即在「用户列表」改密 |
| 2 | **改 DB 密码** | `install.sh` 配置区改 DB_PASS 重跑，或手工同步 4 处：`/opt/radius-admin/core/config.py`、`/etc/freeradius/3.0/mods-enabled/sql`、`/opt/portal_server.py`、`/opt/detail_sync.py`，然后 `systemctl restart radius-admin freeradius` |
| 3 | **改 RADIUS 共享密钥** | `/etc/freeradius/3.0/clients.conf` 与 AC/交换机侧同步修改 |
| 4 | **新 CA 分发** | 证书为部署机全新自签：把 `/etc/freeradius/3.0/certs/ca.pem` 分发给 AC/需要 EAP-TLS 的终端重新信任 |
| 5 | **NAS 指向切换** | AC6003：`radius-server template default` 下服务器 IP 改新机；交换机同理（**逐台灰度，勿一刀切**） |
| 6 | **备份 SW_MASTER_KEY** | `systemctl show radius-admin -p Environment` 查看；丢失 = 已录入的交换机凭据不可解密 |
| 7 | 防火墙 | 按需放行 80/8000/8080 + UDP 1812/1813/3799/50100，**3306 勿对外** |

## 6. 与源环境（106）的差异说明

| 项 | 差异 | 影响 |
|---|------|------|
| 数据库数据 | **不带任何源环境数据**（seed 仅 5 条最小集） | 全新开始：用户/设备/账号/日志均为空，装机后自行添加 |
| EAP 证书 | **部署时本机全新自签**（不复制源机证书） | 全新 CA（默认主体 QCC RADIUS Root CA，10 年期）——AC/终端需重新信任；客户端证书经管理后台重新签发 |
| SW_MASTER_KEY | 新机随机生成 | 交换机管理凭据在新机页面录入（加密密钥与源机无关） |
| VPN 配置 | 不带源环境 VPN 数据 | 新机若做 VPN 网关，在「节点管理」重新配置 |
| 零信任 | zt_* cron 未安装（已下线功能） | NetAgent 若还调 /zt/* 接口，新机后端同样保留兼容 |

## 7. 常见问题（FAQ）

**Q1：自检有 ❌ 怎么办？**
逐条看 `/var/log/deploy-install.log`（每项自检的原始输出都在）。服务类失败先 `journalctl -u <服务名> -n 50`。

**Q2：想重新执行 install.sh？**
安全。FreeRADIUS 每次全新铺放；DB 有数据时会询问；cron 幂等去重。**唯一注意**：第 3 步导库需输 `yes` 才会清数据重建。

**Q3：FreeRADIUS 起不来？**
`freeradius -XC` 看语法错误；多为 clients.conf 里引用了不通的网段（源机定义了 10.10.30.x/192.168.30.x 的 client，新机网络若无这些段不影响启动，只是这些 client 永远不会命中）。

**Q4：忘记后台密码？**
MariaDB 直接改：`mysql -u radius -p radius -e "UPDATE radcheck SET value='新密码' WHERE username='admin' AND attribute='Cleartext-Password'"`（注意有 admin 组才能登录后台）。

**Q5：如何卸载？**
`bash /opt/deploy-uninstall.sh`（安装时自动生成；保留 freeradius 配置与数据库，需人工确认后移除）。

**Q6：如何升级包内代码？**
payload 对应目录替换后重新 `tar` 打包；或部署后直接替换 `/opt/radius-admin` 对应文件 + `systemctl restart radius-admin`（后端）/ `nginx` 目录下前端文件（前端）。

## 8. 重新打包（开发机）

```bash
cd D:\radius
tar czf dist/nac-platform-deploy-<版本号>.tar.gz deploy-pkg   # 目录整体打包（勿用文件列表，会丢顶层目录）
```

> 打包前自查三件事：
> 1. `sed -i 's/\r$//' deploy-pkg/install.sh` + `bash -n` 语法校验；
> 2. payload 里 mods-enabled/sites-enabled 必须是**实体文件**（源端 `cp -L` 收集）——软链经 Windows 中转会变 0 字节文件，导致 FreeRADIUS 无法加载 sql/eap 模块；
> 3. `payload/freeradius/` 必须含 `radiusd.conf` 与 `dictionary`（v1.3/v1.4 实测踩坑：缺任一 freeradius -XC 直接失败）。

## 9. 实测记录（v1.6 · 2026-09-24 · 192.168.110.125）

| 轮次 | 结果 | 发现与修复 |
|------|------|------------|
| R1 | ❌ 解压散落 | 包无顶层目录 → 改目录整体打包 |
| R2 | ⏳ pip 慢 | PyPI 断点续传重试（非脚本问题，等待即可） |
| R3 | ❌ -XC 失败 | 物料缺 radiusd.conf/mods-config 全量 → v2 重收集 263 文件 |
| R3.5 | ❌ Unknown attribute | 缺本地 dictionary（Auth-Method 102）→ 补齐 |
| R4 | ❌ radius-admin 崩 | 缺 python-multipart → 依赖清单补全 |
| R5 | ✅ 18/18 | v1.5 全通过（当时 seed 带源数据） |
| 功能 | ✅ | radtest 认证 Accept（含 Huawei 限速 VSA 下发）；记账 Start→detail→detail_sync→radacct→/api/online 全链路复现 |
| R6 | ❌ xpextensions 缺失 | 证书骨架漏文件 → 补齐 |
| R7 | ❌ client.crt 拒签 | 源机 client.cnf 国家=FR 与 CA(CN) 不一致 + client.crt 非必需 → 改只签 ca.pem+server（make 目标修正 server.crt→server 完整链 .p12→.pem） |
| **R8（全新装机）** | ✅ **19/19** | 库 drop 后全新安装：seed 仅 admin 一条账号、radacct=0、证书当日自签（CA 10 年 / server 2 年）、后台 admin/admin123 可登录 |

## 10. 已知限制

- install.sh 输出横幅文案仍印 v1.1（纯注释性文字，不影响功能）；
- 源机 DB 实为 MariaDB 10.6（Ubuntu 22.04 官方源），非 MySQL 8；
- 部署机时区需为 Asia/Shanghai（与业务口径一致），脚本不处理时区；
- daloRADIUS 遗留的 20+ 张表随 schema 一起导入（无业务引用，可忽略）；
- 全新自签 CA 的默认主体为 certs 骨架内置值（C=CN/ST=Jiangsu/O=QCC/CN=QCC RADIUS Root CA），如需定制请在安装后修改 `certs/*.cnf` 重新 make。
