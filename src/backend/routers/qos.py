from fastapi import APIRouter
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

@router.get("/qos")
async def list_qos():
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("""SELECT id, groupname, attribute, op, value
                FROM radgroupreply WHERE groupname!='daloRADIUS-Dynamic-Fallback'
                ORDER BY groupname, attribute""")
            return await cur.fetchall()
