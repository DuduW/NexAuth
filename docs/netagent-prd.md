# NetAgent 统一网络客户端 PRD v2.1

> **平台**: Windows 10/11, macOS 12+  
> **技术栈**: Go + Wails (WebView UI) + wireguard-go  
> **目录**: `radius/client/`

---

## 一、主界面（已实施）

登录后三卡并列：

```
┌──────────┬──────────────┬──────────┐
│ 准入 NAC  │ 零信任接入    │ VPN 隧道  │
│  蓝盾图标  │  紫锁图标      │  绿波图标  │
│  已认证    │  未接入       │  未连接    │
│ [拨入]    │ [零信任接入]  │ [拨入]    │
└──────────┴──────────────┴──────────┘
```

| 卡片 | 颜色 | 说明 |
|------|------|------|
| 准入 NAC | 蓝 | 已认证/已拨入，Portal 静默认证 |
| **零信任接入** | **紫** | Headscale + Tailscale Mesh，点击接入 → 获取 100.64.0.x |
| VPN 隧道 | 绿 | WireGuard wg0，点击拨入 → 获取 10.99.0.x |

---

## 二、零信任接入交互（待对接）

### 2.1 理想流程

```
用户点击 [零信任接入]
  → Go backend 生成预授权 KEY (Headscale API)
  → 执行: tailscale up --login-server https://192.168.110.106:8081 --auth-key <KEY>
  → 等待: tailscale 注册节点 → 分配 100.64.0.x
  → 回调: 通知前端状态变更（未接入 → 已接入）
  → 刷新: 加载 ACL 策略（zt_acl_rule → Headscale ACL JSON）
```

### 2.2 当前状态

| 环节 | 状态 |
|------|------|
| UI 三卡并列 | ✅ |
| 零信任接入按钮 | ✅ UI 占位（`handleZtAccess` 存根） |
| Headscale API 对接 | ❌ 未实现 |
| tailscale up 执行 | ❌ 未实现 |
| ACL 策略同步 | ❌ 未实现 |

### 2.3 需要新增的 API

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/zt/preauth` | POST | 为用户生成 Headscale 预授权 KEY |
| `/api/zt/mesh-status` | GET | 查询用户 Mesh 状态（IP / 在线） |
| `/api/zt/acl-sync` | POST | 触发 zt_acl_rule → Headscale ACL JSON 同步 |

---

## 三、两套网络共存

```
NetAgent Client
  │
  ├─ WireGuard (wg0)           ──── 传统 VPN ────
  │   IP: 10.99.0.4/24                           │
  │   AllowedIPs: 172.18.0.0/24                  │
  │                                               │
  └─ Tailscale (ts0)           ─── 零信任 ────   │
      IP: 100.64.0.x                              │
      ACL: *.qcc.com (按分组)                     │
      Headscale: 192.168.110.106:8081             │
```

| 维度 | WireGuard | Tailscale |
|------|-----------|-----------|
| 控制粒度 | IP 段 (CIDR) | 域名/端口/分组 (ACL) |
| IP 分配 | 固定 10.99.0.x | 动态 100.64.0.x |
| 适用场景 | 传统内网访问 | 零信任精准授权 |

---

## 四、技术架构

```
client/
├── cmd/wails/main.go      # Wails 入口
├── internal/
│   ├── api/auth.go         # 登录 API
│   ├── api/vpn.go          # VPN 配置/Peer/节点 API
│   ├── core/client.go      # Wails 后端绑定 (Go ↔ React)
│   ├── core/config.go      # 配置管理
│   ├── core/logger.go      # 日志
│   └── vpn/wg.go           # WireGuard 控制
├── frontend/               # React 前端
│   └── src/components/
│       ├── LoginPage.tsx    # 登录
│       ├── VPNPage.tsx      # 主界面（三卡并列）
│       └── ...
└── build/                  # 构建输出
```

---

## 五、核心依赖

```go
// Wails 桌面框架
github.com/wailsapp/wails/v2

// WireGuard
golang.zx2c4.com/wireguard

// React + Vite (前端)
react  / react-dom / react-router-dom
```

---

## 六、API 清单

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/auth/login` | POST | 登录获取 Token |
| `/api/vpn/peers/{user}/conf` | GET | 下载 WG 配置 |
| `/api/vpn/nodes` | GET | 获取可用节点 |
| `/api/vpn/connect/{nodeId}` | POST | 连接指定节点 |
| `/api/vpn/stats` | GET | 连接状态统计 |
| `/api/dashboard/stats` | GET | 首页统计 |

---

## 七、开发里程碑

| 阶段 | 内容 | 状态 |
|------|------|:--:|
| M1 | Wails 骨架 + React 登录 | ✅ |
| M2 | WireGuard VPN 拨入/断开 | ✅ |
| M3 | 节点管理 + 多节点连接 | ✅ |
| M4 | 准入三卡并列 UI | ✅ |
| M5 | 反向代理 + 客户端下载 | ✅ |
| M6 | **Headscale 零信任接入** | ⏳ |
| M7 | ACL 策略同步 | ⏳ |
