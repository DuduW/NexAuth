"""RADIUS configuration APIs: dictionary, radreply, radgroupcheck"""
from fastapi import APIRouter, HTTPException
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

# ── Dictionary ──
@router.get("/radius/dict")
async def list_dictionary(search: str = "", limit: int = 200):
    """搜索 RADIUS 属性字典"""
    sql = "SELECT id, Type, Attribute, Vendor FROM dictionary WHERE 1=1"
    params = []
    if search:
        sql += " AND (Attribute LIKE %s OR Vendor LIKE %s)"
        params.extend([f"%{search}%", f"%{search}%"])
    sql += " ORDER BY Vendor, Attribute LIMIT %s"
    params.append(limit)
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()

@router.post("/radius/dict")
async def add_dictionary(Type: str, Attribute: str, Vendor: str = "", Value: str = ""):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("INSERT INTO dictionary (Type, Attribute, Value, Vendor) VALUES (%s,%s,%s,%s)",
                (Type, Attribute, Value, Vendor))
            return {"ok": True}

@router.delete("/radius/dict/{dict_id}")
async def delete_dictionary(dict_id: int):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM dictionary WHERE id=%s", (dict_id,))
            return {"ok": True}

# ── radreply (用户私有属性) ──
@router.get("/radius/user-reply")
async def list_user_reply(username: str = ""):
    sql = "SELECT id, username, attribute, op, value FROM radreply WHERE 1=1"
    params = []
    if username:
        sql += " AND username LIKE %s"
        params.append(f"%{username}%")
    sql += " ORDER BY username, attribute LIMIT 200"
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()

@router.post("/radius/user-reply")
async def add_user_reply(username: str, attribute: str, value: str, op: str = ":="):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("INSERT INTO radreply (username, attribute, op, value, priority) VALUES (%s,%s,%s,%s,10)",
                (username, attribute, op, value))
            return {"ok": True}

@router.put("/radius/user-reply/{reply_id}")
async def update_user_reply(reply_id: int, value: str = None):
    if value is not None:
        async with get_pool().acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("UPDATE radreply SET value=%s WHERE id=%s", (value, reply_id))
    return {"ok": True}

@router.delete("/radius/user-reply/{reply_id}")
async def delete_user_reply(reply_id: int):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM radreply WHERE id=%s", (reply_id,))
            return {"ok": True}

# ── radgroupcheck (组认证控制) ──
@router.get("/radius/group-check")
async def list_group_check():
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT id, groupname, attribute, op, value FROM radgroupcheck ORDER BY groupname, attribute")
            return await cur.fetchall()

@router.post("/radius/group-check")
async def add_group_check(groupname: str, attribute: str, value: str, op: str = ":="):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("INSERT INTO radgroupcheck (groupname, attribute, op, value, priority) VALUES (%s,%s,%s,%s,10)",
                (groupname, attribute, op, value))
            return {"ok": True}

@router.put("/radius/group-check/{check_id}")
async def update_group_check(check_id: int, value: str = None, op: str = None):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            if value is not None:
                await cur.execute("UPDATE radgroupcheck SET value=%s WHERE id=%s", (value, check_id))
            if op is not None:
                await cur.execute("UPDATE radgroupcheck SET op=%s WHERE id=%s", (op, check_id))
            return {"ok": True}

@router.delete("/radius/group-check/{check_id}")
async def delete_group_check(check_id: int):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM radgroupcheck WHERE id=%s", (check_id,))
            return {"ok": True}
