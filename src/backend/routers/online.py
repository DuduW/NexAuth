from fastapi import APIRouter, Query
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

# 在线判定：未结束 + 最近 ACTIVE_WINDOW_MIN 分钟内有记账活动（Interim-Update / 计费刷新 acctupdatetime）
# 超过该窗口无活动的会话视为僵尸/离线，不再出现在在线列表
ACTIVE_WINDOW_MIN = 5

@router.get("/online")
async def list_online(username: str = Query(default=None, description="按用户名模糊查询"),
                      mac: str = Query(default=None, description="按MAC地址模糊查询")):
    sql = f"""SELECT username, framedipaddress as ip, callingstationid as mac,
        acctstarttime, acctsessiontime,
        ROUND(acctinputoctets/1048576,1) as up_mb,
        ROUND(acctoutputoctets/1048576,1) as down_mb
        FROM radacct
        WHERE acctstoptime IS NULL
          AND acctupdatetime >= NOW() - INTERVAL {ACTIVE_WINDOW_MIN} MINUTE"""
    conditions = []
    params = []
    if username:
        conditions.append("username LIKE %s")
        params.append(f"%{username}%")
    if mac:
        conditions.append("callingstationid LIKE %s")
        params.append(f"%{mac}%")
    if conditions:
        sql += " AND " + " AND ".join(conditions)
    sql += " ORDER BY acctstarttime DESC"
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()
