"""
Radius Admin FastAPI - 数据库连接池
"""
import aiomysql
from core.config import DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME

_pool = None


def get_pool():
    """返回连接池, 确保运行时已初始化"""
    global _pool
    if _pool is None:
        raise RuntimeError("Database pool not initialized")
    return _pool


async def init_db():
    global _pool
    _pool = await aiomysql.create_pool(
        host=DB_HOST, port=DB_PORT,
        user=DB_USER, password=DB_PASS,
        db=DB_NAME, autocommit=True,
        minsize=2, maxsize=10,
        charset='utf8mb4'
    )
    return _pool


async def close_db():
    global _pool
    if _pool:
        _pool.close()
        await _pool.wait_closed()
        _pool = None
