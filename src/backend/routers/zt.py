"""零信任网关 — 管理 API (Headscale Edition)"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

class UserGroupReq(BaseModel):
    username: str
    group_name: str

class AclRuleReq(BaseModel):
    group_name: str
    rule_name: str
    allow_domains: str = ""
    allow_cidrs: str = ""
    allow_ports: str = ""
    priority: int = 100
    status: int = 1

class AclRuleUpdate(BaseModel):
    group_name: Optional[str] = None
    rule_name: Optional[str] = None
    allow_domains: Optional[str] = None
    allow_cidrs: Optional[str] = None
    allow_ports: Optional[str] = None
    priority: Optional[int] = None
    status: Optional[int] = None

# ── Dashboard ─────────────────────────────────────────
@router.get("/zt/dashboard")
async def dashboard():
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT COUNT(DISTINCT username) as cnt FROM radusergroup WHERE groupname NOT LIKE 'disabled%' AND groupname != 'daloRADIUS-Dynamic-Fallback'")
            users = (await cur.fetchone())["cnt"]
            await cur.execute("SELECT COUNT(*) as cnt FROM zt_acl_rule WHERE status=1")
            rules = (await cur.fetchone())["cnt"]
    return {"users": users, "rules": rules, "mesh": "100.64.0.0/10"}

# ── Devices（接入零信任的设备）────────────────────────
@router.get("/zt/devices")
async def list_devices():
    """零信任接入设备列表，数据来自 Headscale nodes，主动离线状态来自 zt_device_status。"""
    import subprocess, json
    from datetime import datetime
    try:
        out = subprocess.run(
            ["headscale", "nodes", "list", "-o", "json"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        nodes = json.loads(out)
    except Exception:
        return []

    # 主动离线的设备（客户端 tailscale down 时上报，立即生效，不等 Headscale 心跳超时）
    offline_set = set()
    try:
        async with get_pool().acquire() as conn:
            async with conn.cursor(DictCursor) as cur:
                await cur.execute("SELECT username FROM zt_device_status WHERE status='offline'")
                offline_set = {row["username"] for row in await cur.fetchall()}
    except Exception:
        pass

    import time
    now = time.time()
    online_window = 90  # last_seen 在 90 秒内才算在线（兜底，不依赖客户端主动上报）

    devices = []
    for n in nodes:
        ls = n.get("last_seen") or {}
        ls_ts = ls.get("seconds", 0)
        ls_str = datetime.fromtimestamp(ls_ts).strftime("%Y-%m-%d %H:%M:%S") if ls_ts else ""
        email = (n.get("user") or {}).get("name", "")
        username = email.split("@")[0] if "@" in email else email
        name = n.get("given_name") or n.get("name", "")

        # 服务器节点（headscale-srv / admin）的 last_seen 不持续更新，不受窗口限制
        is_server = (name == "headscale-srv") or (username == "admin")
        if is_server:
            online = bool(n.get("online", False))
        else:
            recent = (now - ls_ts) < online_window if ls_ts else False
            online = bool(n.get("online", False)) and (username not in offline_set) and recent

        devices.append({
            "id": n.get("id"),
            "name": name,
            "ip": ",".join(n.get("ip_addresses", [])),
            "user": email,
            "online": online,
            "last_seen": ls_str,
        })
    return devices

# ── Devices 主动上下线上报（客户端调用）────────────────
@router.post("/zt/devices/offline")
async def device_offline(username: str = Query(...)):
    """客户端断开零信任（tailscale down）时上报，立即标记离线。"""
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO zt_device_status (username, status, updated_at) VALUES (%s,'offline',NOW()) "
                "ON DUPLICATE KEY UPDATE status='offline', updated_at=NOW()",
                (username,),
            )
    return {"ok": True}

@router.post("/zt/devices/online")
async def device_online(username: str = Query(...)):
    """客户端接入零信任（tailscale up）时上报，清除离线标记。"""
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO zt_device_status (username, status, updated_at) VALUES (%s,'online',NOW()) "
                "ON DUPLICATE KEY UPDATE status='online', updated_at=NOW()",
                (username,),
            )
    return {"ok": True}

# ── Access（客户端接入，发预授权 key）────────────────────
@router.post("/zt/access")
async def create_access(username: str = Query(...)):
    """为指定用户创建零信任接入的预授权 key。

    客户端拿到 key 后执行 tailscale up --authkey=<key> 注册进 Mesh。
    Headscale user 名 = <用户名>@qcc.com（email 格式，v2 policy 要求）。
    """
    import subprocess, json, re
    email = re.sub(r"[^a-zA-Z0-9]", "", username) + "@qcc.com"

    # 1. 找/建 Headscale user
    try:
        out = subprocess.run(
            ["headscale", "users", "list", "-o", "json"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        users = json.loads(out)
    except Exception:
        raise HTTPException(500, "无法读取 Headscale 用户列表")

    user_id = next((u["id"] for u in users if u.get("name") == email), None)
    if user_id is None:
        r = subprocess.run(
            ["headscale", "users", "create", email],
            capture_output=True, text=True, timeout=10,
        )
        if r.returncode != 0 and "already exists" not in r.stderr:
            raise HTTPException(500, f"创建 Headscale 用户失败: {r.stderr[:200]}")
        out = subprocess.run(
            ["headscale", "users", "list", "-o", "json"],
            capture_output=True, text=True, timeout=10,
        ).stdout
        user_id = next((u["id"] for u in json.loads(out) if u.get("name") == email), None)

    if user_id is None:
        raise HTTPException(500, "创建 Headscale 用户后仍无法定位")

    # 2. 创建预授权 key（24h，可复用）
    r = subprocess.run(
        ["headscale", "preauthkeys", "create", "--user", str(user_id),
         "--reusable", "-e", "24h", "-o", "json"],
        capture_output=True, text=True, timeout=10,
    )
    if r.returncode != 0:
        raise HTTPException(500, f"创建预授权 key 失败: {r.stderr[:200]}")

    key = json.loads(r.stdout).get("key", "")
    if not key:
        raise HTTPException(500, "预授权 key 为空")

    return {
        "key": key,
        "login_server": "https://192.168.110.106:8443",
        "username": username,
        "headscale_user": email,
    }

# ── User Groups（复用 RADIUS 用户组 radusergroup）────────
@router.get("/zt/groups")
async def list_groups():
    """零信任分组 = 用户组管理（radusergroup），共享同一套分组数据"""
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("""
                SELECT username, groupname as group_name, 1 as status, NULL as created_at
                FROM radusergroup
                WHERE groupname NOT LIKE 'disabled%'
                  AND groupname != 'daloRADIUS-Dynamic-Fallback'
                  AND groupname NOT IN (SELECT name FROM radius_profiles)
                ORDER BY groupname, username
            """)
            return await cur.fetchall()

@router.post("/zt/groups")
async def add_group(req: UserGroupReq):
    """给用户分配分组（写 radusergroup，已存在则跳过）"""
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT id FROM radusergroup WHERE username=%s AND groupname=%s",
                (req.username, req.group_name),
            )
            if not await cur.fetchone():
                await cur.execute(
                    "INSERT INTO radusergroup (username, groupname, priority) VALUES (%s,%s,10)",
                    (req.username, req.group_name),
                )
            return {"ok": True}

@router.delete("/zt/groups/{username}")
async def delete_group(username: str, group_name: str = ""):
    """移除用户分组（删 radusergroup）。传 group_name 时只删该组，否则删该用户全部组。"""
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            if group_name:
                await cur.execute(
                    "DELETE FROM radusergroup WHERE username=%s AND groupname=%s",
                    (username, group_name),
                )
            else:
                await cur.execute("DELETE FROM radusergroup WHERE username=%s", (username,))
            return {"ok": True}

# ── ACL Rules ─────────────────────────────────────────
@router.get("/zt/acl")
async def list_acl():
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT * FROM zt_acl_rule ORDER BY priority, id")
            return await cur.fetchall()

@router.post("/zt/acl")
async def create_acl(req: AclRuleReq):
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("INSERT INTO zt_acl_rule (group_name,rule_name,allow_domains,allow_cidrs,allow_ports,priority,status) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                              (req.group_name, req.rule_name, req.allow_domains, req.allow_cidrs, req.allow_ports, req.priority, req.status))
            return {"ok": True, "id": cur.lastrowid}

@router.put("/zt/acl/{rid}")
async def update_acl(rid: int, req: AclRuleUpdate):
    sets = []
    vals = []
    for k in ["group_name", "rule_name", "allow_domains", "allow_cidrs", "allow_ports", "priority", "status"]:
        v = getattr(req, k, None)
        if v is not None:
            sets.append(f"{k}=%s")
            vals.append(v)
    if not sets:
        raise HTTPException(400, "无更新字段")
    vals.append(rid)
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(f"UPDATE zt_acl_rule SET {','.join(sets)} WHERE id=%s", vals)
            return {"ok": True}

@router.delete("/zt/acl/{rid}")
async def delete_acl(rid: int):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM zt_acl_rule WHERE id=%s", (rid,))
            return {"ok": True}

# ── Audit Log ─────────────────────────────────────────
@router.get("/zt/log")
async def list_log(username: str = "", action: str = "", page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=500)):
    where = []
    params = []
    if username:
        where.append("username=%s")
        params.append(username)
    if action:
        where.append("action=%s")
        params.append(action)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    offset = (page - 1) * size
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(f"SELECT COUNT(*) as total FROM zt_access_log {clause}", params)
            total = (await cur.fetchone())["total"]
            await cur.execute(f"SELECT * FROM zt_access_log {clause} ORDER BY id DESC LIMIT %s OFFSET %s", params + [size, offset])
            rows = await cur.fetchall()
    return {"total": total, "page": page, "data": rows}
