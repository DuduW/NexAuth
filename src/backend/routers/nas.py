"""NAS Management API"""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()


def _client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    return (xff.split(",")[0].strip() if xff else None) or \
        (request.client.host if request.client else "unknown")


async def _audit_reveal(cur, nas_id: int, ip: str, action: str):
    """Secret 展示审计 → radpostauth（复用认证审计表，auth_method 区分）"""
    await cur.execute(
        "INSERT INTO radpostauth (username, pass, reply, auth_method, authdate) "
        "VALUES (%s, '', %s, %s, NOW())",
        ("admin", f"NAS secret revealed: id={nas_id}", f"audit-ip:{ip}"),
    )


@router.get("/nas")
async def list_nas():
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT id, nasname, shortname, type, ports, secret, server, community, description FROM nas ORDER BY id")
            return await cur.fetchall()

@router.post("/nas")
async def create_nas(nasname: str, secret: str, shortname: str = "", type: str = "other", ports: int = 2000, description: str = ""):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("INSERT INTO nas (nasname, shortname, type, ports, secret, description) VALUES (%s,%s,%s,%s,%s,%s)",
                (nasname, shortname, type, ports, secret, description))
            return {"ok": True}

class NasUpdate(BaseModel):
    nasname: Optional[str] = None
    secret: Optional[str] = None
    shortname: Optional[str] = None
    type: Optional[str] = None
    ports: Optional[int] = None
    description: Optional[str] = None

@router.put("/nas/{nas_id}")
async def update_nas(nas_id: int, payload: NasUpdate):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            sets = []
            vals = []
            for k, v in [('nasname',payload.nasname), ('secret',payload.secret), ('shortname',payload.shortname), ('type',payload.type), ('ports',payload.ports), ('description',payload.description)]:
                if v is not None:
                    sets.append(f"{k}=%s"); vals.append(v)
            if not sets:
                raise HTTPException(400, "未提供任何要更新的字段")
            vals.append(nas_id)
            await cur.execute(f"UPDATE nas SET {','.join(sets)} WHERE id=%s", vals)
            if cur.rowcount == 0:
                raise HTTPException(404, "NAS 不存在")
            await conn.commit()
            return {"ok": True}

@router.delete("/nas/{nas_id}")
async def delete_nas(nas_id: int):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM nas WHERE id=%s", (nas_id,))
            return {"ok": True}


@router.post("/nas/{nas_id}/reveal-secret")
async def reveal_nas_secret(nas_id: int, request: Request):
    """P2-5：Secret 展示审计 — 前端点击眼睛时调用，动作落 radpostauth 留痕"""
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT id FROM nas WHERE id=%s", (nas_id,))
            if not await cur.fetchone():
                raise HTTPException(404, "NAS 不存在")
            await _audit_reveal(cur, nas_id, _client_ip(request), "nas-secret-reveal")
            await conn.commit()
            return {"ok": True, "audited": True}