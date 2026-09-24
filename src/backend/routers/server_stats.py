"""Server Statistics API - 服务器状态"""
from fastapi import APIRouter
from core.database import get_pool
from aiomysql import DictCursor
from datetime import datetime

router = APIRouter()

async def _query_one(sql, params=None):
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, params)
            return await cur.fetchone()

async def _query_all(sql, params=None):
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()

@router.get("/server/stats")
async def server_stats():
    result = {
        "time": datetime.now().isoformat(),
        "all_time": {},
        "today": {},
        "last_30d": {},
        "database": {},
        "auth_today": {},
    }

    # All-time stats
    r = await _query_one("SELECT COUNT(*) as sessions, COUNT(DISTINCT username) as users, ROUND(SUM(acctinputoctets+acctoutputoctets)/1073741824,2) as tb FROM radacct WHERE acctstoptime IS NOT NULL")
    if r: result["all_time"] = dict(r)

    # Online now（活动窗口口径：近 5 分钟有记账活动，同 /online）
    r = await _query_one("SELECT COUNT(*) as online, MAX(acctstarttime) as since FROM radacct WHERE acctstoptime IS NULL AND acctupdatetime >= NOW() - INTERVAL 5 MINUTE")
    if r: result["online"] = dict(r)

    # Today
    r = await _query_one("SELECT COUNT(*) as sessions, COUNT(DISTINCT username) as users, COALESCE(ROUND(SUM(acctinputoctets+acctoutputoctets)/1073741824,3),0) as gb FROM radacct WHERE DATE(acctstarttime)=CURDATE()")
    if r: result["today"] = dict(r)

    # Last 30 days
    r = await _query_one("SELECT COUNT(*) as sessions, COUNT(DISTINCT username) as users, ROUND(SUM(acctinputoctets+acctoutputoctets)/1073741824,2) as gb FROM radacct WHERE acctstarttime >= DATE_SUB(NOW(), INTERVAL 30 DAY)")
    if r: result["last_30d"] = dict(r)

    # Total users
    r = await _query_one("SELECT COUNT(DISTINCT username) as total FROM radcheck WHERE attribute='Cleartext-Password'")
    if r: result["total_users"] = r["total"]

    # DB sizes
    result["database"] = await _query_all("SELECT table_name, ROUND((data_length+index_length)/1024/1024,1) as mb, table_rows FROM information_schema.tables WHERE table_schema='radius' ORDER BY (data_length+index_length) DESC LIMIT 6")

    # Today's auth
    result["auth_today"] = await _query_all("SELECT reply, COUNT(*) as cnt FROM radpostauth WHERE DATE(authdate)=CURDATE() GROUP BY reply ORDER BY cnt DESC")

    # Last 7 days daily sessions（前端补零对齐用：返回区间起止日期）
    rows = await _query_all("SELECT DATE(acctstarttime) as dt, COUNT(*) as sessions, COUNT(DISTINCT username) as users, ROUND(SUM(acctinputoctets+acctoutputoctets)/1073741824,3) as gb FROM radacct WHERE acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) GROUP BY DATE(acctstarttime) ORDER BY dt")
    r = await _query_one("SELECT DATE_SUB(CURDATE(), INTERVAL 6 DAY) as start_dt, CURDATE() as end_dt")
    result["daily"] = {"rows": rows, "start_dt": str(r["start_dt"]) if r and r["start_dt"] else None, "end_dt": str(r["end_dt"]) if r and r["end_dt"] else None}

    return result
