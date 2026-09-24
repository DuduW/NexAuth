"""Users API"""
from fastapi import APIRouter, HTTPException
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

@router.get("/users")
async def list_users():
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            # 分组列只展示业务分组，Profile 策略归属由 assign-profile 单独呈现
            await cur.execute("""SELECT DISTINCT u.username, COALESCE(ug.groupname, '-') as groupname
                FROM radcheck u LEFT JOIN radusergroup ug
                  ON u.username = ug.username
                 AND ug.groupname NOT IN (SELECT name FROM radius_profiles)
                WHERE u.attribute IN ('Cleartext-Password','Auth-Type') ORDER BY u.username""")
            return await cur.fetchall()

@router.post("/users")
async def create_user(username: str, password: str = "", group: str = "group-guest"):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT id FROM radcheck WHERE username=%s", (username,))
            if await cur.fetchone():
                raise HTTPException(400, f"用户 {username} 已存在")
            await cur.execute("INSERT INTO radcheck (username, attribute, op, value) VALUES (%s, 'Cleartext-Password', ':=', %s)", (username, password))
            if group and group != '-':
                await cur.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (%s, %s, 10)", (username, group))
            return {"ok": True, "username": username}

@router.delete("/users/{username}")
async def delete_user(username: str):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM radcheck WHERE username=%s", (username,))
            await cur.execute("DELETE FROM radusergroup WHERE username=%s", (username,))
            return {"ok": True}

@router.put("/users/{username}/group")
async def change_group(username: str, group: str):
    """修改用户所属分组（只动业务分组，保留 Profile 授权绑定）"""
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("""DELETE FROM radusergroup WHERE username=%s
                AND groupname NOT IN (SELECT name FROM radius_profiles)""", (username,))
            if group and group != '-':
                await cur.execute("INSERT INTO radusergroup (username, groupname, priority) VALUES (%s, %s, 10)", (username, group))
            return {"ok": True}

@router.put("/users/{username}/password")
async def change_password(username: str, password: str):
    """修改用户密码"""
    if not password or len(password) < 6:
        raise HTTPException(400, "密码至少6位")
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            r = await cur.execute(
                "UPDATE radcheck SET value=%s WHERE username=%s AND attribute='Cleartext-Password'",
                (password, username),
            )
            if r == 0:
                raise HTTPException(404, "用户不存在")
        await conn.commit()
    return {"ok": True}
