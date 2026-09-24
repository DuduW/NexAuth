from fastapi import APIRouter, Query
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

@router.get("/authlog")
async def list_authlog(username: str = Query(default=None, description="按用户名模糊查询")):
    sql = """SELECT id, username, reply, auth_method, authdate
        FROM radpostauth"""
    conditions = []
    params = []
    if username:
        conditions.append("username LIKE %s")
        params.append(f"%{username}%")
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += " ORDER BY authdate DESC LIMIT 500"
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()

@router.post("/authlog/clear")
async def clear_authlog():
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("TRUNCATE TABLE radpostauth")
            return {"ok": True}
