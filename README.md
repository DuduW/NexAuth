# NexAuth · 网枢

> 企业网络准入与认证一体化管理平台
> RADIUS 认证 / Portal / VPN / 数字资产 / 交换机管理 —— 一个中枢，全部管住

![Tech](https://img.shields.io/badge/FreeRADIUS-3.0-blue) ![Tech](https://img.shields.io/badge/FastAPI-Python-green) ![Tech](https://img.shields.io/badge/React-18-61dafb) ![Platform](https://img.shields.io/badge/Ubuntu-22.04-e95420)

---

## 一、这是什么

NexAuth（网枢）面向企业网络运维，把分散的网络准入、认证、资产与设备管理收敛到**一个平台**：

```
终端(802.1X / Portal / MAC 旁路) → NAS(AC/S57 交换机)
        → FreeRADIUS(NexAuth 核心) → MariaDB
                    ↑ API
        管理后台 admin-spa(React) + NetAgent 客户端 + VPN(WireGuard)
```

- **单节点部署**：一台 Ubuntu 22.04 即可运行全部组件
- **克隆式交付**：一键部署包在新机器 10 分钟内拉起同款平台（[见下](#四一键部署)）
- **中文全栈**：界面、文档、注释全中文

## 二、主要功能

### 1. 准入与认证中心
| 功能 | 说明 |
|------|------|
| 802.1X EAP-TLS | 证书认证（自建 CA 签发/吊销/下载 P12），SSID 级对接华为 AC |
| MAC 旁路免认证 | 打印机/IoT 设备三表联动（radmacbypass+radcheck+radusergroup），6 个月有效期自动注册 |
| Portal 认证 | 华为 Portal 协议服务端（UDP 50100），Web 认证页 + ACK 联动 |
| TOTP 双因子 | Google Authenticator 动态码，后台登录强制，QR 本地生成 |
| Profile 策略 | VLAN / QoS 限速（华为 VSA）/ ACL 随 Access-Accept 下发，按用户/组绑定 |
| 链路拓扑 | 全链路 SVG 拓扑（终端→NAS→RADIUS→后端），端口徽章实时状态 |

### 2. 运行监控
- 在线会话（5 分钟活动窗口判定）、认证日志、记账查询三合一
- 快捷排障条：一键带参跳转定位

### 3. VPN 管理（WireGuard）
- 节点/peer 管理、conf 一键下载
- 服务端会话采集（30s 扫描，官方客户端同等纳管）
- 连接 / 访问 / 流量三日志

### 4. 数字资产管理
- 网段管理（IPv4/IPv6 双栈）、地址台账（分配/预留/冲突/审计）
- 公网资产 + NAT 映射 + 域名备案关联

### 5. 设备资产管理（华为交换机）
- 设备清单（SSH 凭据 AES-256-GCM 加密存储）
- 配置备份（版本化 / diff 对比 / 下载归档）+ 定时任务（cron）
- 在线分析：全量巡检 + **单台巡检**（CPU/内存/温度/告警/接口，离线防抖）

### 6. 系统管理
- 服务器状态、三种界面风格（Carbon / Ant Design / Apple）× 明暗主题
- 中文/English 切换

## 三、技术栈

| 层 | 技术 |
|----|------|
| RADIUS | FreeRADIUS 3.0（rlm_sql / rlm_eap / detail） |
| 后端 | Python 3.10 · FastAPI · aiomysql · APScheduler（161 端点 / 23 路由模块） |
| 前端 | React 18 · Vite · react-router（40 页面，风格层可切换） |
| 数据库 | MariaDB 10.6（70 表） |
| 采集 | paramiko（VRP 交互）· crontab（记账入库等 5 任务） |
| 安全 | JWT · TOTP · AES-256-GCM 凭据加密 · 登录锁定（5 次锁 15 分钟） |

## 四、一键部署

部署包 `dist/nac-platform-deploy.tar.gz`（或在 `deploy-pkg/` 目录自行打包）面向**全新 Ubuntu 22.04**：

```bash
tar xzf nac-platform-deploy.tar.gz
cd deploy-pkg
sudo bash install.sh          # 交互式（推荐）
sudo bash install.sh --auto   # 全自动（测试环境）
```

- 约 3~10 分钟完成，结束时输出 **19 项自检**
- **不含任何源环境数据**：种子库仅初始 admin 账号；EAP 证书部署时全新自签
- 卸载辅助：`/opt/deploy-uninstall.sh`

详细说明见 [`deploy-pkg/README.md`](deploy-pkg/README.md)，架构与接口文档见 [`docs/`](docs/)。

### 从源码构建前端

```bash
cd src/frontend
npm install && npm run build   # 产物 dist/ 上传至 nginx 站点目录
```

## 五、目录结构

```
NexAuth/
├─ src/
│  ├─ backend/          # FastAPI 后端（routers/ 23 模块 + core/）
│  └─ frontend/         # React 前端（40 页面 + nac/ Panel 复用层）
├─ docs/                # PRD / 架构手册 / 各专项设计文档
├─ deploy-pkg/          # 一键部署包（install.sh + payload 物料）
└─ tools/               # 运维脚本（本地使用）
```

## 六、访问入口（部署完成后）

| 入口 | 地址 | 用途 |
|------|------|------|
| 管理后台 | `http://<IP>/admin-spa/` | 平台管理（初始 admin） |
| API | `http://<IP>:8000/api/` | JWT 接口 |
| Portal 认证页 | `http://<IP>:8080/` | 终端用户 WiFi 认证 |
| RADIUS | UDP 1812 / 1813 / 3799 | 认证 / 记账 / CoA |

> ⚠️ 生产上线前：改初始密码、更换 RADIUS 共享密钥、分发新 CA、NAS 逐台灰度切流。

## License

Internal use.
