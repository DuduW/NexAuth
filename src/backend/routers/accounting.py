"""Accounting history API"""
from fastapi import APIRouter, Query
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

@router.get("/accounting")
async def search_accounting(
    username: str = Query(None, description="用户名"),
    ip: str = Query(None, description="IP地址"),
    from_date: str = Query(None, description="开始日期 YYYY-MM-DD"),
    to_date: str = Query(None, description="结束日期 YYYY-MM-DD"),
    limit: int = Query(500, description="最大返回条数")
):
    sql = """SELECT radacctid as id, username, framedipaddress as ip, callingstationid as mac,
                acctstarttime, acctstoptime,
                ROUND(acctsessiontime/3600.0, 1) as hours,
                ROUND(acctinputoctets/1048576.0, 1) as up_mb,
                ROUND(acctoutputoctets/1048576.0, 1) as down_mb,
                nasipaddress
             FROM radacct WHERE 1=1 """
    params = []

    if username:
        sql += " AND username LIKE %s"
        params.append(f"%{username}%")
    if ip:
        sql += " AND framedipaddress LIKE %s"
        params.append(f"%{ip}%")
    if from_date:
        sql += " AND DATE(acctstarttime) >= %s"
        params.append(from_date)
    if to_date:
        sql += " AND DATE(acctstarttime) <= %s"
        params.append(to_date)

    sql += " ORDER BY acctstarttime DESC LIMIT %s"
    params.append(limit)

    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, params)
            return await cur.fetchall()
