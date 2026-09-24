"""NAC 准入认证 API - 客户端通过账号密码+MAC 注册 RADIUS 免认证

v2 (2026-09-23): 追加 GET /nac/overview 只读聚合接口，
供 admin-spa「准入与认证中心」(/nac) 页面顶部指标卡使用。
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from core.database import get_pool
from aiomysql import DictCursor
import logging

logger = logging.getLogger("nac")
router = APIRouter()


class NacAuthRequest(BaseModel):
    username: str
    password: str
    mac: str = ""        # 客户端本机 MAC（通过 default route 接口获取）
    client_ip: str = ""  # 客户端本机 IP（不再依赖 radacct 旧会话）


def _register_mac_bypass(username: str, mac: str):
    """注册 MAC 免认证: radmacbypass + radcheck，复用 portal_server 的 auto_register_mac 逻辑。
    
    将 MAC（去分隔符）作为 radcheck 账号，密码 = MAC 本身，
    Huawei 交换机通过 MAC 认证旁路时查询 radcheck 放行。
    """
    if not mac or len(mac) < 10:
        return

    import pymysql
    no_sep = mac.replace("-", "").replace(":", "").replace(".", "").lower()

    db = pymysql.connect(
        host="127.0.0.1", user="radius", password="CHANGE_ME_DB_PASS", database="radius"
    )
    try:
        cur = db.cursor()
        # 1. radmacbypass: 6 个月有效期，username 存登录用户名（台账）
        cur.execute(
            "INSERT INTO radmacbypass (mac, username, expires_at) "
            "VALUES (%s, %s, DATE_ADD(NOW(), INTERVAL 6 MONTH)) "
            "ON DUPLICATE KEY UPDATE username=VALUES(username), expires_at=DATE_ADD(NOW(), INTERVAL 6 MONTH)",
            (no_sep, username),
        )
        # 2. radcheck: MAC 作为用户名 = 密码（交换机 MAC 认证旁路查询此表）
        cur.execute(
            "INSERT INTO radcheck (username, attribute, op, value) "
            "VALUES (%s, 'Cleartext-Password', ':=', %s) "
            "ON DUPLICATE KEY UPDATE value=VALUES(value)",
            (no_sep, no_sep),
        )
        # 3. radusergroup: MAC 分配到用户同组（获取 VLAN/QoS/带宽属性）
        cur.execute(
            "INSERT INTO radusergroup (username, groupname, priority) "
            "SELECT %s, groupname, priority FROM radusergroup "
            "WHERE username=%s AND groupname NOT LIKE 'disabled%%' LIMIT 1 "
            "ON DUPLICATE KEY UPDATE groupname=VALUES(groupname)",
            (no_sep, username),
        )
        if cur.rowcount == 0:
            # 用户没有分组，分配到默认组
            cur.execute(
                "INSERT IGNORE INTO radusergroup (username, groupname, priority) "
                "VALUES (%s, 'default', 0)",
                (no_sep,),
            )
        db.commit()
        logger.info(f"NAC: MAC bypass registered {mac} -> {no_sep} for {username}")
    except Exception as e:
        logger.error(f"NAC: MAC bypass registration failed: {e}")
    finally:
        db.close()


@router.post("/nac/auth")
async def nac_auth(req: NacAuthRequest):
    """准入认证: 验证账号密码 → 注册 MAC 免认证 → 返回客户端真实 IP/MAC"""
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT username FROM radcheck "
                "WHERE username=%s AND attribute='Cleartext-Password' AND value=%s",
                (req.username, req.password),
            )
            if not await cur.fetchone():
                raise HTTPException(401, "用户名或密码错误")

            await cur.execute(
                "SELECT groupname FROM radusergroup WHERE username=%s",
                (req.username,),
            )
            group_row = await cur.fetchone()
            group_name = group_row["groupname"] if group_row else "default"

    if req.mac:
        _register_mac_bypass(req.username, req.mac)

    return {
        "status": "authenticated",
        "username": req.username,
        "group": group_name,
        "ip": req.client_ip or None,
        "mac": req.mac or None,
        "message": f"准入认证成功，MAC {req.mac} 已注册免认证",
    }


@router.get("/nac/overview")
async def nac_overview():
    """准入与认证中心 · 顶部指标卡聚合（只读 COUNT，无写操作）。

    指标口径与独立页面一致：
    - online_count   = radacct 未结束 + 近 5 分钟有记账活动的会话数（同 /online 活动窗口口径）
    - auth_24h       = radpostauth 近 24h（同 /authlog 范围）
    - mac_bypass_active = radmacbypass 未过期（同 /macpass）
    - nas            = nas 表总数 + 近 24h 无请求的静默数
    - profiles_active = radgroupreply 中 profile 属性去重数
    """
    out = {
        "online_count": 0,
        "auth_24h": {"total": 0, "ok": 0, "fail": 0, "rate": 0.0},
        "mac_bypass_active": 0,
        "mac_bypass_expiring_7d": 0,
        "nas": {"total": 0, "stale": 0},
        "profiles_active": 0,
    }
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT COUNT(*) AS c FROM radacct "
                "WHERE acctstoptime IS NULL AND acctupdatetime >= NOW() - INTERVAL 5 MINUTE")
            r = await cur.fetchone(); out["online_count"] = r["c"]

            await cur.execute(
                "SELECT COUNT(*) AS c, "
                "SUM(reply LIKE 'Access-Accept%') AS ok "
                "FROM radpostauth WHERE authdate >= NOW() - INTERVAL 24 HOUR")
            r = await cur.fetchone()
            t = r["c"] or 0; ok = int(r["ok"] or 0)
            out["auth_24h"] = {"total": t, "ok": ok, "fail": t - ok,
                               "rate": round(ok * 100.0 / t, 1) if t else 0.0}

            await cur.execute("SELECT COUNT(*) AS c FROM radmacbypass WHERE expires_at > NOW()")
            out["mac_bypass_active"] = (await cur.fetchone())["c"]
            await cur.execute(
                "SELECT COUNT(*) AS c FROM radmacbypass "
                "WHERE expires_at > NOW() AND expires_at < NOW() + INTERVAL 7 DAY")
            out["mac_bypass_expiring_7d"] = (await cur.fetchone())["c"]

            await cur.execute("SELECT COUNT(*) AS c FROM nas")
            total = (await cur.fetchone())["c"]
            # 近 24h 有认证请求的 NAS 数（radpostauth.class 存 NAS 名/IP）
            await cur.execute(
                "SELECT COUNT(DISTINCT class) AS c FROM radpostauth "
                "WHERE authdate >= NOW() - INTERVAL 24 HOUR AND class IS NOT NULL AND class <> ''")
            active = (await cur.fetchone())["c"]
            out["nas"] = {"total": total, "stale": max(0, total - int(active or 0))}

            await cur.execute(
                "SELECT COUNT(DISTINCT SUBSTRING_INDEX(groupname, '_profile', 1)) AS c "
                "FROM radgroupreply WHERE groupname LIKE '%_profile%' OR groupname LIKE 'profile%'")
            out["profiles_active"] = (await cur.fetchone())["c"]

    return out


@router.get("/nac/status")
async def nac_status(mac: str = "", username: str = ""):
    """查询 MAC 是否已在免认证白名单中。
    客户端登录后调用此接口判断是否显示"已接入"。"""
    no_sep = mac.replace("-", "").replace(":", "").replace(".", "").lower() if mac else ""
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            # 1. 查 radmacbypass
            if no_sep:
                await cur.execute(
                    "SELECT mac, username, expires_at FROM radmacbypass WHERE mac=%s AND expires_at > NOW()",
                    (no_sep,),
                )
                row = await cur.fetchone()
                if row:
                    return {
                        "whitelisted": True,
                        "mac": mac,
                        "username": row["username"],
                        "expires_at": str(row["expires_at"]),
                    }
            # 2. 按用户名查
            if username:
                await cur.execute(
                    "SELECT mac, expires_at FROM radmacbypass WHERE username=%s AND expires_at > NOW()",
                    (username,),
                )
                rows = await cur.fetchall()
                if rows:
                    return {
                        "whitelisted": True,
                        "mac": rows[0]["mac"],
                        "username": username,
                        "expires_at": str(rows[0]["expires_at"]),
                    }
    return {"whitelisted": False}
