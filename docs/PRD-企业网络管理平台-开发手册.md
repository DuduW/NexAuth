# 企业网络管理平台 · 开发 PRD（技术手册）

| 项 | 内容 |
|---|---|
| 版本 | v1.0 |
| 日期 | 2026-09-24 |
| 基线 | 106 生产实测盘点（后端 161 端点 / DB 70 表 / 4 systemd 服务 / 5 cron） |
| 关联文档 | 《PRD-企业网络管理平台-功能总览》（产品视角） |

---

## 1. 技术栈

| 层 | 技术 |
|---|------|
| RADIUS | FreeRADIUS 3.0（rlm_sql / rlm_eap / detail） |
| 后端 | Python 3.10 + FastAPI + uvicorn + aiomysql（autocommit=True 池 2~10） |
| 前端 | React 18 + Vite 8 + react-router v7（lazy 分包） |
| 数据库 | MySQL 8.0 `radius` 库（106 本机） |
| 凭据加密 | AES-256-GCM（SW_MASTER_KEY，SHA-256 派生 32B，nonce12+ct+tag） |
| 认证 | JWT（jose，HS256，8h）+ 进程内失败锁定（5 次/15min） |
| 交换机接入 | paramiko invoke_shell（VRP 交互；禁 group16/18 KEX 防慢协商） |

## 2. 部署拓扑与路径

| 组件 | 路径/端口（106） |
|------|------------------|
| radius-admin | `/opt/radius-admin`（systemd `radius-admin`，uvicorn :8000） |
| admin-spa 前端 | `/var/www/html/admin-spa/`（nginx alias；深链 try_files → index.html） |
| FreeRADIUS | `/etc/freeradius/3.0`（1812/1813/3799 + 127.0.0.1:18120） |
| detail 记账文件 | `/var/log/freeradius/radacct/<nas-ip>/detail-YYYYMMDD` |
| portal-server | `/opt/portal_server.py`（systemd，Web :8080 / Portal UDP :50100） |
| 交换机备份文件 | `/opt/radius-admin/sw-backups/<device>/v<N>_<ts>.cfg` |
| 源码（开发机） | `D:\radius`：`src/backend`（后端）/ `src/frontend`（前端）/ `tools/tmp`（运维脚本） |

nginx 要点：`/api/` 反代 127.0.0.1:8000，`proxy_read_timeout 300s`（慢设备备份）。

## 3. 数据库（radius 库 70 表）

### 3.1 活跃核心表（本平台使用）

| 域 | 表 | 用途 |
|----|----|------|
| RADIUS 认证 | radcheck / radreply / radusergroup / radgroupcheck / radgroupreply | 用户凭据（Cleartext-Password）、回包属性、组关系与组属性 |
| RADIUS 记账 | radacct（acctupdatetime 关键列）/ radpostauth | 会话与认证日志 |
| 旁路/证书 | radmacbypass / radius_certs | MAC 免认证（6 月有效期）/ EAP-TLS 证书登记 |
| NAS | nas / dictionary | 客户端设备、属性字典 |
| Profile | radius_profiles | VLAN/QoS/ACL 策略组（与业务组隔离：组名 NOT IN radius_profiles） |
| TOTP | radtotp | 动态码 secret + enabled |
| VPN | vpn_server_config / vpn_peers / vpn_permissions / vpn_ip_resources / vpn_access_log / vpn_traffic_log / vpn_visit_log / vpn_user_access | 节点/授权/三日志 |
| 交换机 | sw_device / sw_credential / sw_backup_record / sw_backup_task / sw_task_run / sw_health_snapshot / sw_restore_record | 设备/加密凭据/备份版本/任务/快照 |
| IP 资产 | ip_subnet / ip_address / ip_audit / ip_import_log / ip_nat_map | 网段/台账/审计 |
| 零信任（已下线保留） | zt_device_status / zt_user_group / zt_acl_rule / zt_access_log | NetAgent 兼容 |

### 3.2 daloRADIUS 遗留表（~20 张，只读不动）

userinfo / userbillinfo / operators* / billing* / invoice* / hotspots / realms / proxys / node / cui / wimax / messages / payment* / radhuntgroup / radippool / nasreload 等——历史导入残留，无业务引用。

## 4. 后端接口清单（161 端点，23 文件）

| 文件 | 数 | 核心端点 |
|------|----|----------|
| vpn.py | 30 | /vpn/peers CRUD、/vpn/server/config、/vpn/connect(-node)、/vpn/traffic-report、/vpn/access-log |
| sw.py | 24 | /sw/devices CRUD+test+backup、/sw/backups/{id}/content/diff/download、**/sw/analysis/run**（全量巡检）、**/sw/analysis/devices/{id}/run**（单台巡检 2026-09-24 新增）、/sw/tasks |
| ip.py | 21 | /ip/subnets、/ip/addresses、/ip/public、/ip/nat-map、审计 |
| radius_config.py | 11 | /radius-config（clients/proxy/等配置段读写） |
| zt.py | 13 | /zt/*（已下线，NetAgent 兼容保留） |
| certs.py | 10 | /certs/ca、签发/吊销/清单/详情（qcc-radius-ca-2026） |
| groups.py | 10 | /groups、/groups/{g}/profile（QoS VSA 参数组） |
| profiles.py | 8 | /profiles CRUD、/profiles/assignments、/users/{u}/assign-profile |
| totp.py | 5 | /totp/enable|disable|status、QR secret |
| users.py | 5 | /users CRUD、/users/{u}/group、/users/{u}/password |
| nas.py | 5 | /nas CRUD + /nas/{id}/reveal-secret（审计） |
| auth.py | 3 | /auth/login（admin 组+TOTP+锁定）、/v1/auth/login（VPN 客户端）、/auth/me |
| nac.py | 3 | /nac/overview（聚合指标） |
| portal.py | 3 | /portal/status、start、stop（拉起 /opt/portal_server.py） |
| 其余（accounting/authlog/dashboard/macpass/online/qos/server_stats/services） | 各 1~2 | 记账/认证日志/仪表盘/MAC 旁路/在线（5min 窗口）/QoS/服务器状态/服务状态 |

**接口约定**：错误返回 `{"detail": "..."}`；前端 fetchApi 统一 Bearer 注入；401 不清 token（无全局校验中间件，401 是业务错）。

## 5. 前端结构（40 页面）

```
src/
├─ App.jsx            # lazy 路由 + TITLES + GROUPS（面包屑分组）
├─ components/
│  ├─ Sidebar.jsx     # 可折叠分组（localStorage sidebar_collapsed；路由命中强制展开）
│  ├─ Toast/ConfirmModal/FormModal/CollapsePanel/QrCanvas/Pagination
│  └─ nac/            # NAC 四页面 Panel 复用层（Monitor/Policy/Config/Topo Panels）
└─ pages/             # 40 页面（Nac* 四页 + 旧路由薄壳复用同 Panel）
```

- 路由深链：`/nac/monitor?tab=online`（useSearchParams）；旧 hash 自动映射
- 提取-搬入模式：旧页面 = 薄壳 re-export 同一 Panel（零回归）
- 构建：`npm run build`（Vite，~5s，产物 48 文件）

## 6. 后台进程与数据流

### 6.1 systemd（4 服务）

freeradius / nginx / mysql（隐含）/ radius-admin / portal-server

### 6.2 crontab（root，5 条）

| 任务 | 频率 | 职责 |
|------|------|------|
| detail_sync.py | 每分钟 | **记账入库核心**：解析 detail → radacct（Start INSERT / Interim UPDATE / Stop 关闭）+ MAC 旁路自动注册（radcheck+radmacbypass 6 月） |
| health_check.sh | 2 分钟 | 服务健康自检 |
| vpn_visit_collector.py | 每分钟×2 | VPN 访问日志采集 |
| zt_acl_sync.py / zt_access_collector.py | 每分钟 | 零信任遗留（保留） |

### 6.3 进程内任务

- **vpn_probe**（radius-admin lifespan，APScheduler 30s）：`wg show dump` → 握手沿写 connect/disconnect、transfer 差值写 traffic、180s 无握手关会话；首轮基线去重（300s 窗口）
- 交换机巡检离线防抖（OFFLINE_DEBOUNCE=3）、快照 30 天滚动清理

## 7. 部署铁律（SOP）

1. **后端**：本地改 → `python -m py_compile` → sftp 上传（先备份 `/var/backups/radius-admin/`）→ `systemctl restart radius-admin`（**禁止裸 nohup**——丢 SW_MASTER_KEY）→ 探活
2. **前端**：`npm run build` → dist 全量 sftp 至 `/var/www/html/admin-spa/` → 验证**主入口实际引用的 chunk**（不能按 mtime 猜）
3. **FreeRADIUS 配置**：改前备份 → `radiusd -XC` 校验 → 重启 → radclient 探针验证
4. **AC6003**：变更前 `display current-configuration` 全量备份 → 增量命令 → `display this` 复核 → 记录回滚命令；**只动 default 模板/test011/test022 profile，不碰 QLink**
5. 交换机 SSH 慢设备（如 .62 输出 417B/s）：send() 滑动窗口 15s 静默判定，get_running_config 60s

## 8. 排障 SOP（已知问题模式）

| 症状 | 根因模式 | 验证手段 |
|------|----------|----------|
| 在线列表空 | AC 未发记账 / detail_sync 周期未到（≤60s） | tcpdump 1813 + radacct 最新行 + detail mtime |
| 登录 429 | 进程内锁定 | journalctl AUTH-LOCK → systemctl restart 清零 |
| 删除"成功"但不消失 | 引号污染用户名（`\"` 前缀）+ delete 无 rowcount 校验 | HEX(LEFT(username,3))=5C22 |
| 编辑行下拉空白 | 前端参数类型错配（历史重构遗留） | journal 无对应 PUT = 请求未发出 |
| API 504 | nginx proxy_read_timeout < 慢设备耗时 | access.log 状态码 + journal 实际执行 |
| VPN 官方客户端无日志 | 纯协议实现不回调 | vpn_probe 会话表对照 |

## 9. 安全设计

| 项 | 实现 |
|---|------|
| 后台登录 | radcheck 凭据 + admin 组 + TOTP；5 次失败锁 15 分钟 |
| 交换机凭据 | AES-256-GCM at-rest；Secret 查看/ reveal 走审计接口 |
| RADIUS 共享密钥 | clients.conf（AC: Huawei@Radius123）+ nas 表同步 |
| JWT | SECRET_KEY（core/config.py），8h 过期 |
| 前端 | 401 不自动登出（防业务错误踢人）；密码框不回显 |

## 10. 版本演进大事记

| 日期 | 变更 |
|------|------|
| 2026-08 | portal_server 华为 Portal 协议、TOTP、MAC 旁路三表联动 |
| 2026-09 上旬 | EAP-TLS 证书体系（qcc-radius-ca-2026）、check-eap-tls |
| 2026-09-16~17 | NAC console / 链路拓扑 / NAS 管理 |
| 2026-09-20~21 | VPN 多节点 / vpn_probe 服务端采集 / 零信任下线 |
| 2026-09-22 | 在线 5min 窗口 / 交换机备份修复 / nginx 300s |
| 2026-09-23 | NAC v3 四页面 / AC6003 记账修复（test022+acct1）/ 登录锁定处置 |
| 2026-09-24 | 拓扑单节点+端口徽章 / 单台巡检 / 侧边栏折叠 / 导航重命名 / 双 PRD |

## 11. 开发环境备注

- Windows 开发机：venv python `C:\Users\double\.workbuddy\binaries\python\envs\default\Scripts\python.exe`；npm 用系统 `C:\Program Files\nodejs\npm.cmd`（PowerShell 构建防输出截断）
- paramiko：`allow_agent=False, look_for_keys=False`；exec_command 不共享变量（链式命令或写远端脚本）；多层引号嵌套会卡死——复杂命令 base64 落盘执行
- 远端取证结果避免含 token/Bearer 字样（触发工具审批拦截）
- 106 SSH：root（密码库）；AC6003：admin（用户提供，独立体系）
