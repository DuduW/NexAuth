# NetAgent 客户端编译标准操作流程 (PRD)

> 版本: v1.5 | 日期: 2026-08-13 | 维护人: Double

---

## 一、产物定义

| 字段 | 值 |
|------|-----|
| 文件名 | `netagent.exe` |
| 入口包 | `./`（根目录 main.go） |
| 窗口标题 | `Netagent` |
| 目标平台 | Windows amd64 |
| 窗口类型 | GUI（无控制台） |
| 管理员权限 | **asInvoker**（无 UAC 盾牌图标） |
| 窗口尺寸 | 920 × 640（固定，不缩放） |
| 图标 | `build/appicon.png` → `build/windows/icon.ico` → `.syso` 嵌入 |

---

## 二、编译环境

### 2.1 Go 工具链

| 字段 | 值 |
|------|-----|
| Go 版本 | **1.22.10**（项目自带，非系统安装） |
| GOROOT | `D:\radius\tools\go` |
| GOPATH | `D:\radius\tools\go-gopath` |
| GOCACHE | `D:\radius\tools\go-cache2`（备用，cache2 稳定） |
| GOPROXY | `https://goproxy.cn,direct` |
| PATH | `D:\radius\tools\go\bin` |

> ⚠️ **禁止使用** `C:\Users\double\go-standalone\Go`（go1.23.4，标准库读取异常，`go build` 报 `package X is not in std`）

### 2.2 前端

| 字段 | 值 |
|------|-----|
| Node | 系统自带（`C:\Program Files\nodejs`） |
| 前端框架 | React + Vite + TailwindCSS |
| 前端路径 | `client/frontend` |
| 构建产物 | `client/frontend/dist` |
| Go embed | `//go:embed all:frontend/dist` |

### 2.3 图标工具链

| 工具 | 路径 | 说明 |
|------|------|------|
| gen_syso.exe | `D:\radius\tmp_winres\gen_syso.exe` | Go 编译的 syso 生成器 |
| gen_syso 源码 | `D:\radius\client\winres\gen_syso.go` | 依赖 `github.com/tc-hib/winres v0.1.5` |
| icon.ico | `D:\radius\client\build\windows\icon.ico` | 6 尺寸 PNG 压缩 ICO |

---

## 三、完整编译步骤

### Step 1: 构建前端（仅当前端代码有改动时）

```bash
cd D:\radius\client\frontend
npx vite build
# 产物：frontend/dist/assets/index-*.js, index-*.css
# Go embed 自动打包，无需手动复制
```

### Step 2: 生成图标（仅当 appicon.png 有改动时）

```python
# D:\radius\scripts\gen_icon.py
from PIL import Image
import struct, io

src = 'D:/radius/client/build/appicon.png'
img = Image.open(src).convert('RGBA')
sizes = [(256,256),(128,128),(64,64),(48,48),(32,32),(16,16)]

images = []
for w,h in sizes:
    buf = io.BytesIO()
    img.resize((w,h), Image.LANCZOS).save(buf, format='PNG')
    images.append(buf.getvalue())

header = struct.pack('<HHH', 0, 1, len(sizes))
header_size = 6 + 16 * len(sizes)
entries = b''
cur = header_size
for i, (w,h) in enumerate(sizes):
    entries += struct.pack('<BBBBHHII',
        w if w<256 else 0, h if h<256 else 0, 0, 0, 1, 32,
        len(images[i]), cur)
    cur += len(images[i])

with open('D:/radius/client/build/windows/icon.ico', 'wb') as f:
    f.write(header + entries + b''.join(images))
```

```bash
# 重新生成 syso 资源文件
export GOROOT=D:\radius\tools\go GOPATH=D:\radius\tools\go-gopath GOCACHE=D:\radius\tools\go-cache
export PATH="/d/radius/tools/go/bin:$PATH"
cd D:\radius\tmp_winres
./gen_syso.exe   # 输出 → D:\radius\client\netagent_windows_amd64.syso
```

### Step 3: 编译 exe

```bash
export GOROOT=D:\radius\tools\go
export GOPATH=D:\radius\tools\go-gopath
export GOCACHE=D:\radius\tools\go-cache2
export PATH="/d/radius/tools/go/bin:$PATH"
export GOPROXY=https://goproxy.cn,direct

cd D:\radius\client

go build \
  -tags "desktop,production" \
  -ldflags="-s -w -H windowsgui" \
  -o build/bin/netagent.exe \
  .
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `-tags "desktop,production"` | **是** | 缺少会弹错误对话框 |
| `-ldflags="-s -w"` | 推荐 | 去除调试符号，缩小体积 |
| `-ldflags="-H windowsgui"` | **是** | 隐藏控制台窗口 |
| `netagent_windows_amd64.syso` | **是** | 图标资源，放在 client/ 根目录 |

### Step 4: 部署到桌面

```bash
cp D:/radius/client/build/bin/netagent.exe C:/Users/double/Desktop/NetAgent.exe
cp D:/radius/client/build/bin/netagent.exe C:/Users/double/NetAgent.exe
```

---

## 四、踩坑记录 & 关键约束

### 4.1 Build Tags（最重要）

> `internal/app/app_default_windows.go` 的 build constraint：
> `//go:build !dev && !production && !bindings && windows`

**不带 tags 编译**的 exe 运行时 Wails 框架检测到并弹出 "Wails applications will not build without the correct build tags" 对话框后退出。

**必须**用 `-tags "desktop,production"`（或 `dev`/`production`/`bindings` 任一）。

### 4.2 Wails build 不可用

`wails build` 在 go1.23.4 和 go1.22.10 下均崩溃（go/types nil pointer panic，wails v2.7.0 的 `golang.org/x/tools@v0.6.0` 与新 Go 兼容性问题）。

**使用 `go build` + `.syso` 方案替代。**

### 4.3 图标嵌入方式

- `wails build` 自动用 `build/windows/icon.ico` 生成 `.syso` 并嵌入。
- **直接 `go build` 不会自动嵌入图标**，需手动生成 `.syso` 放在包根目录。
- 生成的 `.syso` 文件名必须是 `<package>_windows_amd64.syso`（或 `resource_windows_amd64.syso`），Go 编译器自动链接。

### 4.4 入口包选择

- **根 `./main.go`**（全功能）：含 NAC 准入认证、VPN 多节点、OTP 双因素、多 VPN Profile。
- **`./cmd/wails/main.go`**（简化版）：仅基础 WireGuard 拨入，无 NAC/VPN 管理功能。

**当前使用根 `./main.go`。** 注意 `cmd/wails/` 使用 `gui/dist` 前端路径，与根路径不同。

### 4.5 登录接口

客户端 Login 调用 `POST {serverURL}/api/v1/auth/login`，服务端需返回：

```json
{
  "code": 0,
  "data": {
    "access_token": "jwt...",
    "allowed_nodes": "",
    "nodes": []
  }
}
```

注意 `allowed_nodes` 字段类型为 **string**（空字符串），不是数组。客户端 Go struct 定义为 `AllowedNodes string`。

### 4.6 TOTP 动态码处理

客户端 `NacDialIn()` 方法不再传 OTPCode（totp 置空），因为登录时已验证动态码。服务端 `/api/nac/auth` 在 `totp` 为空时跳过动态码校验。

### 4.7 VPN 服务器地址独立配置

- **API 服务器**（serverURL）：用于 `/api/v1/auth/login`、`/api/nac/auth`、`/api/nac/status`
- **VPN 服务器**（vpnServer）：WireGuard endpoint，格式 `IP:Port`，默认 `192.168.110.106:37440`
- 存储在 `ClientConfig.VpnServer`，通过 `SaveSettings(serverURL, vpnServer, username, password)` 持久化

### 4.8 NAC MAC 选取逻辑

`getLocalMAC()` 选取策略：
1. `net.Dial("udp", "8.8.8.8:53")` → 找默认网关网卡
2. 验证该网卡非虚拟适配器 → 返回
3. 若是虚拟网卡 → 遍历所有物理网卡，WiFi > 以太网 > 其他

跳过：Hyper-V, VMware, vEthernet, WireGuard, Tailscale, ZeroTier, OpenVPN, Bluetooth, WSL, Teredo, ISATAP, TAP-, Npcap

### 4.9 GOCACHE 污染问题

`tools/go-cache` 多次出现 `Access is denied` 和 `package X is not in std`。**使用 `tools/go-cache2` 替代。**

### 4.10 VPN 端口

WireGuard 服务端实际监听 **UDP 37440**（非 8001）。DB `vpn_server_config.port` 和 `wg0.conf` 已同步。客户端默认端口 `37440`。

---

## 五、快速构建脚本

```bash
#!/bin/bash
# D:\radius\scripts\build_client.sh
set -e

export GOROOT=D:/radius/tools/go
export GOPATH=D:/radius/tools/go-gopath
export GOCACHE=D:/radius/tools/go-cache
export GOPROXY=https://goproxy.cn,direct
export PATH=/d/radius/tools/go/bin:$PATH

echo "=== NetAgent Build $(date) ==="

# Step 1: 前端（可选，注释掉则用上次构建产物）
echo "[1/3] Frontend..."
cd D:/radius/client/frontend
npx vite build --outDir dist

# Step 2: 图标（可选，仅当 appicon.png 改动时）
echo "[2/3] Icon..."
cd D:/radius/tmp_winres
./gen_syso.exe

# Step 3: 编译
echo "[3/3] Go Build..."
cd D:/radius/client
go build -tags "desktop,production" -ldflags="-s -w -H windowsgui" -o build/bin/netagent.exe .

echo "=== Done: build/bin/netagent.exe ($(ls -la build/bin/netagent.exe | awk '{print $5}')) ==="
```

---

## 六、服务端依赖接口

### 6.1 客户端登录接口

```
POST /api/v1/auth/login
```

请求体：
```json
{"username": "double", "password": "CHANGE_ME_SSH_PASS", "otp_code": ""}
```

返回：
```json
{
  "code": 0,
  "data": {
    "access_token": "eyJhbGciOiJIUzI1NiIs...",
    "allowed_nodes": "",
    "nodes": []
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `access_token` | string | 是 | JWT，有效期 8 小时 |
| `allowed_nodes` | string | 是 | **空字符串**（不用数组！客户端 Go struct 定义 `AllowedNodes string`） |
| `nodes` | array | 否 | 可选节点列表，客户端展示/连接用 |

服务端实现：`routers/auth.py` → `POST /v1/auth/login`（通过 `/api` prefix 成为 `/api/v1/auth/login`）

### 6.2 MAC 免认证管理

| 接口 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 列表 | GET | `/api/macs?mac=xx&username=xx` | 支持模糊搜索 |
| 删除 | DELETE | `/api/macs/{mac}` | **级联删除三张表** |

**radmacbypass 表结构**（台账表，不参与 RADIUS 认证）：
| 字段 | 说明 |
|------|------|
| `mac` | MAC 去分隔符（UNIQUE） |
| `username` | 登录用户名（台账，NAC 免认证时填登录名） |
| `expires_at` | 6 个月有效期 |

**删除必须同时清理**：
| 表 | 清理内容 | SQL |
|----|---------|-----|
| `radmacbypass` | 台账记录 | `DELETE FROM radmacbypass WHERE mac IN (%s, %s)` |
| `radcheck` | **真正生效的免认证账号** | `DELETE FROM radcheck WHERE username=%s`（MAC 无分隔符） |
| `radusergroup` | MAC 用户分组 | `DELETE FROM radusergroup WHERE username=%s` |

> ⚠️ Portal 框架（`portal_server.py`）在用户认证成功后调用 `auto_register_mac()` 同时写入 `radmacbypass` + `radcheck`。只删 `radmacbypass` 会导致 radcheck 残留，免认证仍然生效。

> ⚠️ **认证机制（关键）**：华为交换机做 MAC 认证旁路时，用 **MAC（去分隔符）作为 RADIUS username 和 password** 发起 Access-Request，FreeRADIUS 查 `radcheck`（`WHERE username='%{SQL-User-Name}'`）验证。因此 `radcheck.username` 必须保持 MAC，不能改成登录用户名。`radmacbypass` 表（mac/username）只是管理台账，**不参与认证**——页面上显示的「用户名」是登录名，仅用于后台识别"这个 MAC 是谁的"。

### 6.3 NAC 准入认证

```
POST /api/nac/auth
```

请求体：
```json
{"username": "double", "password": "CHANGE_ME_SSH_PASS", "mac": "58:6c:25:49:16:b9", "client_ip": "192.168.30.128"}
```

返回：
```json
{
  "status": "authenticated",
  "username": "double",
  "group": "admin",
  "ip": "192.168.30.128",
  "mac": "58:6c:25:49:16:b9",
  "message": "准入认证成功，MAC 58:6c:25:49:16:b9 已注册免认证"
}
```

| 字段 | 说明 |
|------|------|
| `mac` | 客户端自动获取默认网关网卡 MAC 上报 |
| `client_ip` | 客户端本机 IP |
| MAC 注册 | 自动写入 `radmacbypass` + `radcheck` + `radusergroup` 三张表 |

### 6.4 NAC 白名单状态查询

```
GET /api/nac/status?mac=586c254916b9&username=double
```

返回（在白名单）：
```json
{"whitelisted": true, "mac": "586c254916b9", "username": "double", "expires_at": "2027-02-12"}
```

返回（不在白名单）：
```json
{"whitelisted": false}
```

客户端登录后自动调用此接口，若在白名单则直接显示"已接入"。

### 6.5 VPN 密钥架构（WireGuard）

#### 6.5.1 设计原则

**所有密钥由服务端统一生成和管理**，客户端不自行生成密钥。

- 密钥对在**授权时一次性生成**（管理员点击"生成对端"），存入 DB 后终身复用
- 后续 VPN 连接直接读取 DB 中的私钥，**不再重新签发**
- 撤销 VPN 权限时删除对端记录（公钥从 wg0 移除）
- 原因：多用户场景下，统一管理降低复杂度；部分客户端环境无法自生成密钥

#### 6.5.2 密钥存储

```
vpn_server_config (DB)           vpn_peers (DB, 每用户一行)
┌──────────────────────┐        ┌──────────────────────────┐
│ public_key  ← 向外发布 │        │ public_key  ← 同步到 wg0   │
│ private_key ← 不外出  │        │ private_key ← 返回给客户端  │
│ port: 37440          │        │ address: 10.99.0.x      │
└──────────────────────┘        └──────────────────────────┘

wg0.conf                         客户端
[Interface]                      收到 client_private_key 后配置 WG
PrivateKey = <server_private>
[Peer]
PublicKey = <client_public>
AllowedIPs = 10.99.0.x/32
```

> ⚠️ **wg0.conf 中 peer 的 AllowedIPs 只放客户端虚拟 IP**（如 `10.99.0.4/32`），**禁止放 `0.0.0.0/0`**，否则 `wg-quick up` 会接管服务器默认路由导致断网。

#### 6.5.3 密钥交互流程

```
步骤 1 客户端  ── POST /api/vpn/connect {"username": "double"} ──►
步骤 2 服务端  wg genkey → 客户端私钥  +  wg pubkey → 客户端公钥
步骤 3 服务端  密钥对写入 DB (vpn_peers.public_key / .private_key)
步骤 4 服务端  wg syncconf 热加载到 wg0（不断网）
步骤 5 客户端  ◄── {client_private_key, server_public_key, port, ...} ──
步骤 6 客户端  用私钥写入 WireGuard 配置
步骤 7 双方    UDP 握手，DH 协商共享密钥，隧道建立
```

核心：`DH(客户端私钥, 服务端公钥) = DH(服务端私钥, 客户端公钥)`，两边算出相同的共享密钥。

#### 6.5.4 VPN 连接 API

```
POST /api/vpn/connect
```

请求：
```json
{"username": "double", "otp_code": ""}
```

返回：
```json
{
  "code": 0,
  "data": {
    "virtual_ip": "10.99.0.4",
    "client_private_key": "AGA7Do2z5y...",
    "server_public_key": "7qkMGAfCr...",
    "server_port": 37440,
    "dns": ["172.18.18.18"],
    "allowed_ips": "172.18.0.0/24",
    "split_tunnel_strategy": "split"
  }
}
```

| 字段 | 说明 |
|------|------|
| `client_private_key` | 服务端签发的客户端私钥，用于 WireGuard 配置 |
| `server_public_key` | 服务端公钥，用于客户端 WG peer 配置 |
| `server_port` | WireGuard 服务监听 UDP 端口 |
| `virtual_ip` | 分配给此客户端的隧道 IP |

#### 6.5.5 WireGuard 配置模板

服务端返回的数据在客户端生成以下配置：

```ini
[Interface]
PrivateKey = <client_private_key>
Address = <virtual_ip>/24
DNS = <dns>

[Peer]
PublicKey = <server_public_key>
Endpoint = 192.168.110.106:<server_port>
AllowedIPs = <allowed_ips>
PersistentKeepalive = 25
```

#### 6.5.6 VPN 权限管理页面

路径：`/admin-spa/#/vpnperm`

```
┌──────────┬───────────┬──────────────────────┬──────────────┐
│ 用户     │ IP        │ 公钥                 │ 操作         │
├──────────┼───────────┼──────────────────────┼──────────────┤
│ wangchong│ 10.99.0.2 │ nYiARXMwmb9GE40Z...  │ 下载/编辑/撤销│
│ xuyj     │ 10.99.0.3 │ uk3ompjhM+asuKod...  │ 下载/编辑/撤销│
│ double   │ 10.99.0.4 │ entOuKVSPadQ/c3j...  │ 下载/编辑/撤销│
└──────────┴───────────┴──────────────────────┴──────────────┘
```

操作说明：
- **下载配置**：生成 `.conf` 文件供手动客户端使用
- **编辑权限**：管理用户的 AllowedIPs 可访问资源
- **撤销**：删除对端记录 + 从 wg0 移除 peer 公钥
- **生成对端**：为新用户分配 IP + 生成密钥对 + 创建 WG peer

#### 6.5.7 安全注意事项

| 风险 | 缓解 |
|------|------|
| DB 被拖库 → 私钥泄露 | 仅内网部署，DB 端口不对外开放 |
| API 返回私钥被截获 | HTTPS（生产环境）+ 仅内网使用 |
| wg-quick down 断网 | **只用 `wg syncconf`**，不断网 |
| Peer AllowedIPs = 0.0.0.0/0 | 只放客户端虚拟 IP |
| 私钥落盘在客户端 | 连接断开后清除本地 WG 配置 |

## 七、版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-13 | v1.5 | MAC 免认证：radmacbypass 统一用 username 存登录名（去掉 actual_user 字段），清理历史 username=MAC 脏数据；VPN 拨入/断开优化（DestroyTunnel 重试+停服务兜底）；流量上报+访问日志 |
| 2026-08-12 | v1.3 | 密钥一次性生成终身复用、VPN 权限页 show 公钥列、/vpn/connect 改用 DB 已有密钥 |
