"""TOTP 动态码管理 API"""
import pyotp
from fastapi import APIRouter, HTTPException
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

@router.get("/totp/status")
async def totp_status():
    """列出所有 TOTP 用户"""
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT username, enabled, created FROM radtotp ORDER BY username")
            return await cur.fetchall()

@router.get("/totp/status/{username}")
async def user_totp_status(username: str):
    """单个用户 TOTP 状态"""
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT username, secret, enabled, created FROM radtotp WHERE username=%s", (username,))
            row = await cur.fetchone()
            return row or {"username": username, "enabled": False}

@router.post("/totp/enable/{username}")
async def totp_enable(username: str):
    """启用/重置 TOTP（生成新 secret）"""
    secret = pyotp.random_base32()
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO radtotp (username, secret, enabled) VALUES (%s,%s,1) ON DUPLICATE KEY UPDATE secret=%s, enabled=1",
                (username, secret, secret)
            )
    # Generate QR code URL
    uri = pyotp.totp.TOTP(secret).provisioning_uri(name=username, issuer_name="Radius-NAC")
    return {"ok": True, "username": username, "secret": secret, "uri": uri}

@router.post("/totp/disable/{username}")
async def totp_disable(username: str):
    """禁用 TOTP"""
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("UPDATE radtotp SET enabled=0 WHERE username=%s", (username,))
            return {"ok": True}

@router.post("/totp/verify")
async def totp_verify(username: str, code: str):
    """验证 TOTP 码"""
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT secret FROM radtotp WHERE username=%s AND enabled=1", (username,))
            row = await cur.fetchone()
            if not row:
                raise HTTPException(404, "未启用 TOTP")
            totp = pyotp.TOTP(row["secret"])
            if totp.verify(code):
                return {"ok": True}
            raise HTTPException(400, "验证码错误")
