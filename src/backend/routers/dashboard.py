"""Dashboard API"""
from fastapi import APIRouter
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

async def _query(sql):
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql)
            return await cur.fetchone()

@router.get("/dashboard/stats")
async def dashboard_stats():
    stats = {"online": 0, "today_auth": 0, "mac_bypass": 0, "traffic": 0}

    r = await _query("SELECT COUNT(*) as cnt FROM radacct WHERE acctstoptime IS NULL AND acctupdatetime >= NOW() - INTERVAL 5 MINUTE")
    if r: stats["online"] = r["cnt"]

    r = await _query("SELECT COUNT(*) as cnt FROM radpostauth WHERE DATE(authdate) = CURDATE()")
    if r: stats["today_auth"] = r["cnt"]

    r = await _query("SELECT COUNT(*) as cnt FROM radmacbypass WHERE expires_at > NOW()")
    if r: stats["mac_bypass"] = r["cnt"]

    # 在线流量同样只统计活动窗口内的会话（与在线人数口径一致）
    r = await _query("SELECT COALESCE(SUM(acctinputoctets+acctoutputoctets),0) as total FROM radacct WHERE acctstoptime IS NULL AND acctupdatetime >= NOW() - INTERVAL 5 MINUTE")
    if r: stats["traffic"] = round(r["total"] / 1024 / 1024 / 1024, 2)

    return stats
