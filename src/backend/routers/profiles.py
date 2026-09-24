"""User Profiles API — 策略模板定义（VLAN/QoS/ACL）+ 用户排他授权

Profile 底层复用 radgroupreply（下发属性）与 radusergroup（授权关系），
radius_profiles 仅存元数据。FreeRADIUS 零配置改动。
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

# ── 下发属性定义（与 groups.py 口径一致）──
PROFILE_VLAN_ATTRS = ("Tunnel-Type", "Tunnel-Medium-Type", "Tunnel-Private-Group-Id")
# QoS：只下发 FreeRADIUS 字典认识的 Huawei-*-Average-Rate（AC/S57 通用）。
# ⚠️ 严禁下发 HW-*-Committed/Peak-Information-Rate——服务端字典无此属性，
#    "Failed to create the pair: Unknown name" 会导致整条认证被 Reject！
PROFILE_QOS_UP = ("Huawei-Input-Average-Rate",)
PROFILE_QOS_DOWN = ("Huawei-Output-Average-Rate",)
PROFILE_ACL = ("Filter-Id",)
PROFILE_ALL = tuple(set(PROFILE_VLAN_ATTRS) | set(PROFILE_QOS_UP) | set(PROFILE_QOS_DOWN) | set(PROFILE_ACL))


class ProfileCreate(BaseModel):
    name: str
    description: Optional[str] = ""


class ProfileDesc(BaseModel):
    description: Optional[str] = ""


class ProfileAttrs(BaseModel):
    vlan: Optional[str] = ""
    qos_up_mbps: Optional[str] = ""
    qos_down_mbps: Optional[str] = ""
    acl_id: Optional[str] = ""


class AssignReq(BaseModel):
    name: Optional[str] = ""   # 空 / "none" = 取消授权


def _to_mbps(bps_val):
    """bps → Mbps 无损换算（整数省小数，非整保留全部小数位）。"""
    if bps_val in (None, ""):
        return ""
    try:
        m = float(bps_val) / 1000000
        if m == int(m):
            return str(int(m))
        return ("%.6f" % m).rstrip("0").rstrip(".")
    except (ValueError, TypeError):
        return ""


def _parse_rows(rows):
    """radgroupreply 行 → 结构化 profile。"""
    p = {"vlan": "", "qos_up_mbps": "", "qos_down_mbps": "", "acl_id": ""}
    up_ac = up_hw = down_ac = down_hw = None
    for r in rows:
        attr = r["attribute"]
        val = (r["value"] or "").strip()
        if attr == "Tunnel-Private-Group-Id":
            p["vlan"] = val
        elif attr == "Huawei-Input-Average-Rate":
            up_ac = val
        elif attr == "Huawei-Output-Average-Rate":
            down_ac = val
        elif attr == "HW-Input-Committed-Information-Rate":
            up_hw = val
        elif attr == "HW-Output-Committed-Information-Rate":
            down_hw = val
        elif attr == "Filter-Id" and val and not p["acl_id"]:
            p["acl_id"] = val
    p["qos_up_mbps"] = _to_mbps(up_ac or up_hw)
    p["qos_down_mbps"] = _to_mbps(down_ac or down_hw)
    return p


async def _profile_name_by_pid(pid: int) -> str:
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT name FROM radius_profiles WHERE id=%s", (pid,))
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, f"Profile {pid} 不存在")
    return row[0]


async def _save_attrs(groupname: str, req: ProfileAttrs) -> int:
    """幂等保存下发属性（事务化：失败回滚，保护数据）。"""
    placeholders = ",".join(["%s"] * len(PROFILE_ALL))
    inserts = []
    if req.vlan and req.vlan.strip():
        inserts += [
            ("Tunnel-Type", "VLAN"),
            ("Tunnel-Medium-Type", "IEEE-802"),
            ("Tunnel-Private-Group-Id", req.vlan.strip()),
        ]
    if req.qos_up_mbps and req.qos_up_mbps.strip():
        bps = str(int(round(float(req.qos_up_mbps) * 1000000)))
        for attr in PROFILE_QOS_UP:
            inserts.append((attr, bps))
    if req.qos_down_mbps and req.qos_down_mbps.strip():
        bps = str(int(round(float(req.qos_down_mbps) * 1000000)))
        for attr in PROFILE_QOS_DOWN:
            inserts.append((attr, bps))
    if req.acl_id and req.acl_id.strip():
        inserts.append(("Filter-Id", req.acl_id.strip()))

    async with get_pool().acquire() as conn:
        try:
            await conn.begin()
            async with conn.cursor() as cur:
                await cur.execute(
                    f"DELETE FROM radgroupreply WHERE groupname=%s AND attribute IN ({placeholders})",
                    [groupname, *PROFILE_ALL],
                )
                for attr, value in inserts:
                    await cur.execute(
                        "INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (%s,%s,':=',%s)",
                        (groupname, attr, value),
                    )
            await conn.commit()
        except Exception:
            await conn.rollback()
            raise
    return len(inserts)


# ── 授权关系全量映射（供用户管理页回显）──
# ⚠️ 静态路由必须在 /{pid} 动态路由之前注册，否则会被 pid 吞掉
@router.get("/profiles/assignments")
async def list_assignments():
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("""
                SELECT ug.username, ug.groupname AS profile
                FROM radusergroup ug JOIN radius_profiles p ON ug.groupname = p.name
                ORDER BY ug.username
            """)
            return await cur.fetchall()


@router.get("/profiles")
async def list_profiles():
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("""
                SELECT p.id, p.name, p.description,
                       DATE_FORMAT(p.created_at, '%Y-%m-%d %H:%i') AS created_at,
                       COALESCE(u.members, 0) AS members,
                       MAX(CASE WHEN gr.attribute='Tunnel-Private-Group-Id' THEN gr.value END) AS vlan,
                       MAX(CASE WHEN gr.attribute IN ('Huawei-Input-Average-Rate','HW-Input-Committed-Information-Rate')
                                THEN gr.value END) AS up_bps,
                       MAX(CASE WHEN gr.attribute IN ('Huawei-Output-Average-Rate','HW-Output-Committed-Information-Rate')
                                THEN gr.value END) AS down_bps,
                       MAX(CASE WHEN gr.attribute='Filter-Id' THEN gr.value END) AS acl_id
                FROM radius_profiles p
                LEFT JOIN (SELECT groupname, COUNT(*) AS members FROM radusergroup GROUP BY groupname) u
                       ON u.groupname = p.name
                LEFT JOIN radgroupreply gr ON gr.groupname = p.name
                GROUP BY p.id, p.name, p.description, p.created_at, u.members
                ORDER BY p.name
            """)
            rows = await cur.fetchall()

    out = []
    for r in rows:
        out.append({
            "id": r["id"], "name": r["name"], "description": r["description"],
            "created_at": r["created_at"], "members": int(r["members"]),
            "vlan": r["vlan"] or "",
            "qos_up_mbps": _to_mbps(r["up_bps"]),
            "qos_down_mbps": _to_mbps(r["down_bps"]),
            "acl_id": r["acl_id"] or "",
        })
    return out


@router.post("/profiles")
async def create_profile(req: ProfileCreate):
    name = req.name.strip()
    if not name:
        raise HTTPException(400, "名称不能为空")
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) FROM radius_profiles WHERE name=%s", (name,))
            if (await cur.fetchone())[0] > 0:
                raise HTTPException(400, "同名 Profile 已存在")
            await cur.execute(
                "SELECT COUNT(*) FROM (SELECT groupname FROM radusergroup UNION SELECT groupname FROM radgroupcheck) t WHERE groupname=%s",
                (name,),
            )
            if (await cur.fetchone())[0] > 0:
                raise HTTPException(400, f"组名 {name} 已被用户组占用，请换一个名称")
            await cur.execute(
                "INSERT INTO radius_profiles (name, description, created_at) VALUES (%s,%s,NOW())",
                (name, req.description or ""),
            )
            await cur.execute(
                "INSERT INTO radgroupcheck (groupname, attribute, op, value) VALUES (%s,'Auth-Type',':=','Accept')",
                (name,),
            )
    return {"ok": True, "name": name}


@router.put("/profiles/{pid}")
async def update_profile(pid: int, req: ProfileDesc):
    name = await _profile_name_by_pid(pid)
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("UPDATE radius_profiles SET description=%s WHERE id=%s", (req.description or "", pid))
    return {"ok": True, "name": name}


@router.delete("/profiles/{pid}")
async def delete_profile(pid: int):
    name = await _profile_name_by_pid(pid)
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) FROM radusergroup WHERE groupname=%s", (name,))
            users = (await cur.fetchone())[0]
            if users > 0:
                raise HTTPException(400, f"还有 {users} 个用户绑定此 Profile，请先在用户管理中解绑")
            await cur.execute("DELETE FROM radgroupreply WHERE groupname=%s", (name,))
            await cur.execute("DELETE FROM radgroupcheck WHERE groupname=%s", (name,))
            await cur.execute("DELETE FROM radusergroup WHERE groupname=%s", (name,))
            await cur.execute("DELETE FROM radius_profiles WHERE id=%s", (pid,))
    return {"ok": True}


@router.get("/profiles/{pid}/attrs")
async def get_profile_attrs(pid: int):
    name = await _profile_name_by_pid(pid)
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT attribute, op, value FROM radgroupreply WHERE groupname=%s ORDER BY id", (name,))
            rows = await cur.fetchall()
    return _parse_rows(rows)


@router.put("/profiles/{pid}/attrs")
async def save_profile_attrs(pid: int, req: ProfileAttrs):
    name = await _profile_name_by_pid(pid)
    written = await _save_attrs(name, req)
    return {"ok": True, "written": written}


# ── 用户排他授权（一用户一 Profile，换绑自动替换旧绑定）──
@router.put("/users/{username}/assign-profile")
async def assign_profile(username: str, req: AssignReq):
    target = (req.name or "").strip()
    if target.lower() in ("none", ""):
        target = None

    async with get_pool().acquire() as conn:
        try:
            await conn.begin()
            async with conn.cursor() as cur:
                # 用户必须存在
                await cur.execute("SELECT COUNT(*) FROM radcheck WHERE username=%s", (username,))
                if (await cur.fetchone())[0] == 0:
                    raise HTTPException(404, f"用户 {username} 不存在")
                if target is not None:
                    await cur.execute("SELECT name FROM radius_profiles WHERE name=%s", (target,))
                    if not (await cur.fetchone()):
                        raise HTTPException(404, f"Profile {target} 不存在")
                # 排他：删除该用户所有指向 profile 组的绑定
                placeholders = "(SELECT name FROM radius_profiles)"
                await cur.execute(
                    f"DELETE FROM radusergroup WHERE username=%s AND groupname IN {placeholders}",
                    (username,),
                )
                # 绑新
                if target is not None:
                    await cur.execute(
                        "INSERT INTO radusergroup (username, groupname, priority) VALUES (%s,%s,10)",
                        (username, target),
                    )
            await conn.commit()
        except Exception:
            await conn.rollback()
            raise
    return {"ok": True, "profile": target or ""}
