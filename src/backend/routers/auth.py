"""认证 API — 登录/登出/JWT"""
import time
from collections import defaultdict
from fastapi import APIRouter, HTTPException, Request
from core.database import get_pool
from core.config import SECRET_KEY, ALGORITHM
from aiomysql import DictCursor
from datetime import datetime, timedelta
from jose import jwt
from pydantic import BaseModel

router = APIRouter()

# ── 登录失败锁定（P1 安全加固）────────────────────────────
# 策略：同一 IP+账号 连续 5 次失败 → 锁 15 分钟；成功登录清零。
# 进程内字典实现（单实例部署足够；重启即清零，可接受）。
MAX_FAIL = 5
LOCK_SECONDS = 15 * 60
_fail_map: dict[str, dict] = {}   # key -> {"fails": int, "locked_until": ts}


def _client_ip(request: Request) -> str:
    # nginx 反代场景取 X-Forwarded-For 首个（最原始客户端）
    xff = request.headers.get("x-forwarded-for", "")
    return (xff.split(",")[0].strip() if xff else None) or \
        (request.client.host if request.client else "unknown")


def _check_lock(key: str):
    rec = _fail_map.get(key)
    if not rec:
        return
    if rec.get("locked_until", 0) > time.time():
        remain = int(rec["locked_until"] - time.time())
        raise HTTPException(
            429,
            f"失败次数过多，账号已临时锁定，请 {max(remain // 60, 1)} 分钟后重试",
        )
    # 仅当"锁定过且已过期"才重置（不能在每次请求都清零，否则计数永远无法累积）
    if rec.get("locked_until", 0):
        rec["fails"] = 0
        rec["locked_until"] = 0


def _record_fail(key: str):
    rec = _fail_map.setdefault(key, {"fails": 0, "locked_until": 0})
    rec["fails"] += 1
    if rec["fails"] >= MAX_FAIL:
        rec["locked_until"] = time.time() + LOCK_SECONDS
        # 注意：不清零 fails —— 解锁时由 _check_lock 重置；
        # 锁定期间 _check_lock 直接 429，不会走到这里


def _record_ok(key: str):
    _fail_map.pop(key, None)

class LoginRequest(BaseModel):
    username: str
    password: str
    totp: str = ""

class VpnLoginRequest(BaseModel):
    """VPN 客户端登陆请求 (ClientAuth.Login)"""
    username: str
    password: str
    otp_code: str = ""


@router.post("/v1/auth/login")
async def vpn_login(req: VpnLoginRequest, request: Request):
    """VPN 客户端登陆：验证账号密码+TOTP，返回 access_token + nodes"""
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            # 验证密码
            await cur.execute(
                "SELECT username FROM radcheck WHERE username=%s AND attribute='Cleartext-Password' AND value=%s",
                (req.username, req.password),
            )
            if not await cur.fetchone():
                raise HTTPException(401, "用户名或密码错误")

            # 验证 TOTP（如果用户已启用）
            if req.otp_code:
                await cur.execute("SELECT secret FROM radtotp WHERE username=%s AND enabled=1", (req.username,))
                row = await cur.fetchone()
                if row:
                    import pyotp
                    t = pyotp.TOTP(row["secret"])
                    if not t.verify(req.otp_code):
                        raise HTTPException(401, "动态码错误")

            # 查询节点：以 vpn_peers（授权表）为准，JOIN vpn_server_config 构造节点信息
            # 修复（2026-09-21）：原实现查 vpn_permissions 的 id/name/type/... 列，
            # 该表实际只有 username/enabled/granted_at 三列，SQL 报 Unknown column
            # 后被 except:pass 吞掉 → 登录永远返回空节点列表，客户端无法拨入。
            nodes = []
            try:
                await cur.execute("SELECT server_address, port, public_key, subnet FROM vpn_server_config WHERE id=1")
                srv = await cur.fetchone()
                await cur.execute(
                    "SELECT username, address, allowed_ips, enabled FROM vpn_peers WHERE username=%s AND enabled=1",
                    (req.username,),
                )
                peer = await cur.fetchone()
                if srv and peer:
                    # endpoint 取客户端实际访问的 Host 头（192.168.110.106 之类），
                    # 比 server_address（10.99.0.1 隧道内地址）对客户端更有意义
                    host = (request.headers.get("host") or "").split(":")[0]
                    endpoint = host or srv["server_address"]
                    nodes.append({
                        "id": "main",
                        "name": "主网关",
                        "type": "wireguard",
                        "endpoint": endpoint,
                        "wireguard_port": srv["port"],
                        "public_key": srv["public_key"],
                        "cidr": srv["subnet"],
                        "status": "online",
                    })
            except Exception as e:
                import logging
                logging.getLogger(__name__).error("vpn_login node query failed: %s", e)

    payload = {"sub": req.username, "exp": datetime.utcnow() + timedelta(hours=8), "iat": datetime.utcnow()}
    token = jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
    return {"code": 0, "data": {"access_token": token, "allowed_nodes": "", "nodes": nodes}}


@router.post("/auth/login")
async def login(req: LoginRequest, request: Request):
    """用户登录，仅 admin 组成员可登录；含失败锁定（IP+账号 5 次锁 15 分钟）"""
    lock_key = f"{_client_ip(request)}|{req.username}"
    _check_lock(lock_key)  # 锁定中直接 429

    err = None  # 未抛出的失败原因（先记账再统一抛，便于附加剩余次数）
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            # 验证密码
            await cur.execute(
                "SELECT * FROM radcheck WHERE username=%s AND attribute='Cleartext-Password' AND value=%s",
                (req.username, req.password)
            )
            if not await cur.fetchone():
                err = HTTPException(401, "用户名或密码错误")
            else:
                # 验证 TOTP 动态码（如果用户已启用）
                if req.totp:
                    await cur.execute("SELECT secret FROM radtotp WHERE username=%s AND enabled=1", (req.username,))
                    row = await cur.fetchone()
                    if row:
                        import pyotp
                        totp = pyotp.TOTP(row['secret'])
                        if not totp.verify(req.totp):
                            err = HTTPException(401, "动态码错误")
                if err is None:
                    # 检查是否为 admin 组
                    await cur.execute(
                        "SELECT * FROM radusergroup WHERE username=%s AND groupname='admin'",
                        (req.username,)
                    )
                    if not await cur.fetchone():
                        err = HTTPException(403, "无管理员权限")

    if err is not None:
        _record_fail(lock_key)
        rec = _fail_map.get(lock_key, {})
        if rec.get("locked_until", 0) > time.time():
            # 本次失败即触发锁定（第 MAX_FAIL 次）
            raise HTTPException(429, "失败次数过多，账号已临时锁定 15 分钟")
        remain = MAX_FAIL - rec.get("fails", 0)
        print(f"[AUTH-LOCK] fail key={lock_key} remain={remain}")
        if remain <= 2:  # 仅在接近锁定时提示，避免向攻击者泄露完整阈值
            err.detail = f"{err.detail}（再错 {remain} 次将锁定 15 分钟）"
        raise err

    _record_ok(lock_key)

    # 生成 JWT
    payload = {
        "sub": req.username,
        "exp": datetime.utcnow() + timedelta(hours=8),
        "iat": datetime.utcnow(),
    }
    token = jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)
    return {"token": token, "username": req.username}

@router.get("/auth/me")
async def get_me(payload: dict = None):
    """获取当前登录用户信息"""
    return {"username": payload.get("sub", "unknown") if payload else "unknown"}
