# WireGuard VPN Server 集成方案 v1.0

> 服务器: 192.168.110.106 | 协议: WireGuard UDP :8001 | 后端: FastAPI :8000

---

## 一、架构

```
                    互联网
                      │
               ┌──────▼──────┐
               │  WireGuard   │  UDP :8001
               │  wg0 接口    │  10.99.0.1
               │  (kernel)    │
               └──────┬──────┘
                      │
               ┌──────▼──────┐
               │   FastAPI    │  :8000 (通过 nginx /api/vpn/*)
               │              │
               │  ┌── wg 命令 (show/set/conf)
               │  ├── iptables (NAT/转发)
               │  ├── IP 分配器 (自研)
               │  └── MySQL (vpn_* 表)
               └──────────────┘
```

## 二、数据模型（MySQL radius 库）

# 节点管理

服务状态

🔴 未运行







## 三、IP 地址分配策略

```
规则: 用户 = IP，一一绑定，永不变化

操作映射:
┌──────────────┬──────────────────────────┐
│ 操作          │ IP 行为                   │
├──────────────┼──────────────────────────┤
│ 授权用户       │ 分配最小可用 IP (10.99.0.2+) │
│ 禁用用户       │ IP 保留不释放              │
│ 重新启用       │ 恢复原 IP                 │
│ 删除用户       │ IP 释放回池               │
│ 重新授权       │ 恢复原记录 + 原 IP         │
│ 重装客户端     │ 重新下载 .conf，IP 不变    │
└──────────────┴──────────────────────────┘

算法:
  SELECT MAX(INET_ATON(address)) FROM vpn_peers
  → 转换为 IP → 递增 → 检查未被占用

子网: 10.99.0.0/24 → 可用 10.99.0.2 ~ 10.99.0.254 (253 个)
```

## 四、API 设计

```
基础路径: /api/vpn     （全部通过 JWT 鉴权）

# ── 服务器 ──
GET    /server/status          → {running, peers, subnet, port}
GET    /server/config          → {subnet, port, dns, mtu, public_key}
PUT    /server/config          → 更新配置 + 重写 wg0.conf + 重启

# ── 对端管理 ──
GET    /peers                  → [{username, address, public_key, enabled, traffic}]
POST   /peers                  → 创建 (选用户 → 分配IP → 生成密钥 → 写入wg)
DELETE /peers/{username}       → 删除 (释放IP → 移除wg peer)
PUT    /peers/{username}       → 启用/禁用
GET    /peers/{username}/conf  → 下载完整 .conf 文件
GET    /pool                   → {used, available, subnet}

# ── 权限管理 ──
GET    /permissions            → [{username, enabled, address}]
POST   /permissions/{username} → 授权 (= 创建 peer + 分配IP)
DELETE /permissions/{username} → 撤销 (= 禁用 peer, IP 保留)

# ── 日志 ──
GET    /access-log             → [{username, action, ip, created_at}]
       参数: ?username=&from=&to=&limit=
GET    /traffic-log            → [{username, up_bytes, down_bytes, session}]
       参数: ?username=&from=&to=&limit=

# ── 统计 ──
GET    /stats                  → {online, total_peers, today_connections, total_traffic}
```

## 五、SPA 前端 4 页面

```
VPN 管理 (侧边栏一级)
├── VPN 节点 (/vpn)
│   ├── 服务状态卡片: 运行中/已停止、端口、子网
│   ├── 配置编辑: 子网/DNS/MTU/端口 → 保存重启
│   ├── IP 池: 已分配 X/253 个
│   ├── 对端列表: 用户 | IP | 公钥(截断) | 流量 | 状态 | 操作
│   └── 操作: [启用/禁用] [下载.conf] [删除]
│
├── 权限管理 (/vpnperm)
│   ├── 授权表单: 选择用户 → 授权 → 弹出分配的 IP + 下载.conf
│   ├── 已授权列表: 用户 | IP | 公钥 | 状态 | 操作
│   └── 操作: [下载.conf] [禁用/启用] [删除]
│
├── 访问日志 (/vpnaccess)
│   └── 表格: 时间 | 用户 | 动作(connect/disconnect) | 来源IP | 详情
│      筛选: 用户名、时间范围、分页
│
└── 流量日志 (/vpntraffic)
    └── 表格: 用户 | IP | 上行 | 下行 | 总流量 | 在线时长
       筛选: 用户名、时间范围、分页
```

## 六、首页 & 服务器状态集成

```
首页概览  →  VPN 数据 区块
  在线: N    今日连接: N    流量: X GB    活跃用户: N

服务器状态  →  VPN 数据 区块
  VPN在线: N    总连接数: N    流量: X GB    活跃用户: N
```

## 七、客户端配置模板

用户 double 下载的 `double.conf`：

```ini
[Interface]
PrivateKey = <生成的私钥>
Address = 10.99.0.2/24        ← 永久分配
DNS = 223.5.5.5

[Peer]
PublicKey = <服务器公钥>
Endpoint = 192.168.110.106:8001
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
```

## 八、部署步骤

```
1. apt install wireguard-tools qrencode
2. 创建 vpn_peers + vpn_server_config 表
3. 实现 router/vpn.py（5 模块 16 接口）
4. 实现 4 个 SPA 页面
5. 初始化 wg0: ip link add wg0 type wireguard
6. 配置 iptables NAT + IP 转发
7. 首页 + 服务器状态 VPN 数据对接
8. systemd: wg-quick@wg0 开机自启
```

## 九、安全

- API 全部 JWT 鉴权
- 密钥生成: `wg genkey | tee privatekey | wg pubkey > publickey`
- .conf 下载仅管理员可见
- 日志记录所有操作
