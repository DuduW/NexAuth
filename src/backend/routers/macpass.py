from fastapi import APIRouter, Query
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

@router.get("/macs")
async def list_macs(mac: str = Query(default=None, description="按MAC地址模糊查询"),
                    username: str = Query(default=None, description="按用户名模糊查询")):
    sql = """SELECT mac, username, created_at, expires_at,
        CASE WHEN expires_at > NOW() THEN 'valid' ELSE 'expired' END as status
        FROM radmacbypass"""
    conditions = []
    params = []
    if mac:
        conditions.append("mac LIKE %s")
        params.append(f"%{mac.lower()}%")
    if username:
        conditions.append("username LIKE %s")
        params.append(f"%{username}%")
    if conditions:
        sql += " WHERE " + " AND ".join(conditions)
    sql += " ORDER BY created_at DESC"
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()

@router.delete("/macs/{mac}")
async def delete_mac(mac: str):
    """删除 MAC 免认证：级联清理 radmacbypass + radcheck + radusergroup
    注意：Portal 注册免认证时同时写入了 radmacbypass 和 radcheck（username=MAC, password=MAC），
    只删 radmacbypass 会导致 radcheck 中残留的 MAC 账号继续生效（免认证删除无效）。"""
    mac = mac.lower()
    # 去掉分隔符，匹配无分隔符形式（radcheck 中的 username 是无分隔符的 MAC）
    mac_plain = mac.replace("-", "").replace(":", "").replace(".", "")
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            # 1. 删除 radmacbypass 记录
            await cur.execute("DELETE FROM radmacbypass WHERE mac=%s OR mac=%s", (mac, mac_plain))
            # 2. 删除 radcheck 中的 MAC 用户账号（真正生效的免认证账号）
            await cur.execute("DELETE FROM radcheck WHERE username=%s", (mac_plain,))
            # 3. 删除 radusergroup 中的 MAC 用户分组
            await cur.execute("DELETE FROM radusergroup WHERE username=%s", (mac_plain,))
            return {"ok": True}
