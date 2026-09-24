# PRD — admin-spa HTTPS + httpOnly Cookie 认证改造（v1.0）

> 对应测试报告 P1-2（HTTP 明文）与 P3-9（Token 存 localStorage）
> 原则：先设计后实施；分两阶段独立交付，每阶段可独立回滚
> 日期：2026-09-20 · 状态：待审查

---

## 0. 背景与现状（本会话已核实）

| 事实 | 来源 |
|------|------|
| nginx 反代 `/api` → 127.0.0.1:8000（uvicorn systemd radius-admin） | 部署链路 |
| 106 `/etc/freeradius/3.0/certs/` 有 CA（ca.pem/ca.key，8/31 bootstrap 测试链） | 会话前期 SSH 实测 |
| **后端 API 无任何鉴权中间件**——token 仅前端用于判断登录态，任何知道 IP 的人可直接调 API | api.js 注释 + grep 无 Depends/verify | 
| 登录 JWT 8h，存 localStorage（`token` + `admin_user`） | Login.jsx |
| NetAgent 客户端走 `/api/v1/auth/login` 返回 access_token，后续请求带 `Authorization: Bearer` | auth.py vpn_login |
| 刚上线的登录锁定取 IP 已支持 `X-Forwarded-For` | auth.py `_client_ip` |

**⚠️ 方案必须附带修复的新发现（P1 级）**：后端 API 无鉴权。报告只测了前端，实际上绕过前端直调 API（如 `POST /api/users` 建号）完全可行。Cookie 改造正好补上这层——给全部 router 挂 `require_auth` 依赖。

---

## 1. 阶段 A：HTTPS 上线（独立交付，先做）

### 1.1 证书方案

| 项 | 决策 | 说明 |
|----|------|------|
| 签发 CA | `/etc/freeradius/3.0/certs/` 现有 CA | 密钥在机上可签；后续 EAP-TLS 切生产 CA（qcc-radius-ca-2026）时一并统一换发 |
| 服务器证书 SAN | `IP:192.168.110.106`（+ DNS 别名可选） | 浏览器按 IP 访问，**必须 IP SAN**，CN 无效 |
| 有效期 | 825 天 | 内网自签惯例 |
| 客户端信任 | 管理员机器导入 `ca.pem` 到「受信任的根」 | 一次性操作，未导入则点「继续访问」（自签不会直接阻断） |

### 1.2 nginx 变更

```
server {
    listen 443 ssl;
    server_name 192.168.110.106;
    ssl_certificate     /etc/nginx/ssl/admin-spa.pem;   # 含全链
    ssl_certificate_key /etc/nginx/ssl/admin-spa.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    # location /admin-spa 与 /api 与现行 80 完全一致（proxy_pass 127.0.0.1:8000）
}
# 现行 80 server 改为唯一动作：return 301 https://$host$request_uri;
```

要点：
- **80 保留但只做 301**（报告建议自动跳转；跳转后登录/Token 全走 TLS）
- proxy 头补 `X-Forwarded-Proto $scheme`（Cookie Secure 属性依赖）
- **不启用 HSTS**（IP 访问 + 内网，避免浏览器强制锁死排查不便）
- 部署脚本与监控均打 `127.0.0.1:8000` 直连，不受 80 改跳转影响

### 1.3 验收标准

1. `https://192.168.110.106/admin-spa/` 全功能可用（31 页抽查 3 页）
2. `http://` 访问 301 → https
3. 证书链 `openssl s_client` 校验 SAN 含 IP
4. 回滚：恢复 80 原 server 块 + 删 443 块（配置备份先行）

---

## 2. 阶段 B：httpOnly Cookie + 后端鉴权（HTTPS 之上做）

### 2.1 目标架构

| 项 | 现状 | 目标 |
|----|------|------|
| Token 存储 | localStorage（XSS 可窃） | httpOnly + Secure + SameSite=Strict Cookie |
| 后端鉴权 | **无** | 全 router 挂 `require_auth`（Cookie 或 Bearer 二选一） |
| 前端请求 | Authorization header | `credentials:'include'`（Cookie 自动带）；Bearer 保留为兼容 |
| 登出 | 前端删 localStorage | 服务端 `Set-Cookie` 清除 + 前端清残留 |

### 2.2 后端设计（core/auth_dep.py 新增 + main.py 一行挂载）

```python
# require_auth 依赖：双通道（过渡期并存，最终收敛 Cookie）
# ① Cookie "admin_session"（httpOnly）— admin-spa 专用
# ② Authorization: Bearer — NetAgent / 脚本 / 过渡期兼容
async def require_auth(request: Request):
    token = request.cookies.get("admin_session") or _bearer(request)
    if not token:
        raise HTTPException(401, "未登录")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        request.state.username = payload["sub"]
    except jwt.JWTError:
        raise HTTPException(401, "会话已过期，请重新登录")
```

- `login` 成功 → `response.set_cookie("admin_session", token, httponly=True, secure=True, samesite="strict", max_age=8h)`
- main.py：全部 `include_router(..., dependencies=[Depends(require_auth)])`，**豁免**：`/auth/login`（两种）、`/auth/logout`
- **NetAgent 零影响**：Bearer 通道保留，`/api/v1/auth/login` 在豁免清单
- daloRADIUS /manage/ 面板是独立 PHP 体系，不经过 FastAPI，不受影响

### 2.3 前端设计（改动 3 个文件）

| 文件 | 变更 |
|------|------|
| `api.js` | fetch 统一加 `credentials:'include'`；`isLoggedIn()` 改读非敏感 cookie 标记位（`admin_login=1`，非 httpOnly）；401 且非业务接口 → 清残留跳登录 |
| `Login.jsx` | 不再写 `localStorage.token`；仅存展示用用户名（或改 sessionStorage） |
| `App.jsx` | 登录态判断改用标记位 cookie；登出调 `POST /auth/logout` |

### 2.4 迁移与回滚

- **过渡期（1 周）**：Cookie 与 Bearer 并存，老 localStorage token 仍可用（require_auth 兼容 Bearer），无硬切换风险
- 收敛期：前端仅用 Cookie；NetAgent 继续 Bearer（长期保留双通道）
- 回滚：`require_auth` 依赖从 main.py 移除即恢复现状（一行回滚）；Cookie 失效自动落回 Bearer

### 2.5 风险清单

| 风险 | 缓解 |
|------|------|
| zt/vpn 等 router 是否有其他系统在调（非 NetAgent） | 实施第一步 grep access.log 统计 UA/来源；过渡期 Bearer 保留兜底 |
| Cookie SameSite=Strict 与未来跨页场景冲突 | 现全站同源，无影响；如需放宽改 Lax（一项配置） |
| secure=True 在 HTTP 调试时 Cookie 不落地 | 阶段 B 仅在 HTTPS 之后实施，天然满足 |
| 8h 过期中途掉线 | 与现状一致（JWT exp 8h 不变），后续可加滑动续期（不在本期） |

---

## 3. 实施顺序与交付物

| 步骤 | 内容 | 验证 | 回滚 |
|------|------|------|------|
| 0 | 只读核实：nginx 配置文件名/CA 可用性/access.log 调用方 | 事实表 | — |
| A1 | 签证书（SAN=IP）→ nginx 443+301 → 重载 | s_client + 浏览器 + 31 页抽查 | 恢复备份 conf |
| B1 | core/auth_dep.py + login Cookie + main.py 挂依赖 | curl 双通道测试 + NetAgent 登录冒烟 | 移除 dependencies 一行 |
| B2 | 前端 3 文件改造 → build → dist 部署 | playwright 端到端 + localStorage 断言为空 | 重部署旧 dist |

交付物：SSL 证书 2 文件、nginx conf 备份×2、core/auth_dep.py、前端 3 文件、部署脚本 deploy_https.py / deploy_cookie.py、验证脚本 pw_verify_https.js、本文档状态更新。

---

## 4. 待确认决策点（审查时定）

| # | 决策点 | 推荐 |
|---|--------|------|
| D1 | CA 用 certs/ 测试链还是等 qcc-radius-ca-2026 | 先用现有 CA 上线，EAP-TLS 切生产 CA 时统一换 |
| D2 | 80 端口处置：301 跳转 vs 保留并行 | 301（报告建议；部署脚本不受影响） |
| D3 | 过渡期长度 | 1 周双通道，之后前端收敛 Cookie |
| D4 | 本期是否顺带修「API 无鉴权」 | 是——阶段 B 天然覆盖，不额外动 |
