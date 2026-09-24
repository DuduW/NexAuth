"""Groups API"""
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional
from core.database import get_pool
from aiomysql import DictCursor

router = APIRouter()

# ── Profile 下发属性定义（VLAN / QoS / ACL）──────────────
# VLAN 三件套（RFC 3580）
PROFILE_VLAN_ATTRS = ("Tunnel-Type", "Tunnel-Medium-Type", "Tunnel-Private-Group-Id")
# QoS：只下发 FreeRADIUS 字典认识的 Huawei-*-Average-Rate（AC/S57 通用）。
# ⚠️ 严禁下发 HW-*-Committed/Peak-Information-Rate——服务端字典无此属性，
#    "Failed to create the pair: Unknown name" 会导致整条认证被 Reject！
PROFILE_QOS_UP = ("Huawei-Input-Average-Rate",)
PROFILE_QOS_DOWN = ("Huawei-Output-Average-Rate",)
# ACL：标准 Filter-Id + 华为私有 HW-Data-Filter（只下发一个：Filter-Id）
PROFILE_ACL_ATTRS = ("Filter-Id", "HW-Data-Filter")
PROFILE_ALL = set(PROFILE_VLAN_ATTRS) | set(PROFILE_QOS_UP) | set(PROFILE_QOS_DOWN) | set(PROFILE_ACL_ATTRS)


class ProfileReq(BaseModel):
    vlan: Optional[str] = ""          # 空 = 不下发 VLAN
    qos_up_mbps: Optional[str] = ""   # 上行限速 Mbps（Input，NAS 收到 = 用户上行）
    qos_down_mbps: Optional[str] = "" # 下行限速 Mbps（Output，NAS 发出 = 用户下行）
    acl_id: Optional[str] = ""        # 空 = 不下发 ACL


@router.get("/groups")
async def list_groups():
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("""
                SELECT g.groupname, COUNT(DISTINCT ug.username) as members,
                       COALESCE(MAX(gr.profile_attrs), 0) as profile_attrs
                FROM (
                    SELECT groupname FROM radusergroup
                    UNION SELECT groupname FROM radgroupreply
                    UNION SELECT groupname FROM radgroupcheck
                ) g
                LEFT JOIN radusergroup ug ON g.groupname = ug.groupname
                LEFT JOIN (
                    SELECT groupname, COUNT(*) as profile_attrs FROM radgroupreply
                    WHERE attribute IN ('Tunnel-Type','Tunnel-Medium-Type','Tunnel-Private-Group-Id',
                                        'Huawei-Input-Average-Rate','Huawei-Output-Average-Rate',
                                        'HW-Input-Committed-Information-Rate','HW-Output-Committed-Information-Rate',
                                        'Filter-Id','HW-Data-Filter')
                    GROUP BY groupname
                ) gr ON g.groupname = gr.groupname
                WHERE g.groupname != 'daloRADIUS-Dynamic-Fallback'
                  AND g.groupname NOT IN (SELECT name FROM radius_profiles)
                GROUP BY g.groupname
                ORDER BY g.groupname
            """)
            return await cur.fetchall()


@router.get("/groups/{groupname}/profile")
async def get_group_profile(groupname: str):
    """解析组的下发属性为结构化 Profile。

    兼容历史数据：QoS 从两套属性（Huawei-*Average-Rate / HW-*-Information-Rate）任取非空值，
    bps → Mbps 换算；未识别的属性原样放进 raw 列表（保存时保留不动）。
    """
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT id, attribute, op, value FROM radgroupreply WHERE groupname=%s ORDER BY id", (groupname,))
            rows = await cur.fetchall()

    p = {"vlan": "", "qos_up_mbps": "", "qos_down_mbps": "", "acl_id": "", "raw": []}
    up_ac = up_hw = down_ac = down_hw = None

    def to_mbps(bps_val):
        if bps_val in (None, ""):
            return ""
        try:
            m = float(bps_val) / 1000000
            if m == int(m):
                return str(int(m))
            # 无损小数：4096000 → '4.096'，保证重新保存可还原为 4096000
            return ("%.6f" % m).rstrip("0").rstrip(".")
        except (ValueError, TypeError):
            return ""

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
        elif attr in ("Filter-Id", "HW-Data-Filter"):
            if val and not p["acl_id"]:
                p["acl_id"] = val
        elif attr not in PROFILE_ALL:
            p["raw"].append({"id": r["id"], "attribute": attr, "op": r["op"], "value": val})

    p["qos_up_mbps"] = to_mbps(up_ac or up_hw)
    p["qos_down_mbps"] = to_mbps(down_ac or down_hw)
    return p


@router.put("/groups/{groupname}/profile")
async def save_group_profile(groupname: str, req: ProfileReq):
    """结构化保存 Profile（幂等）：清理旧模板属性后按表单重写，raw 自定义属性保留。"""
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
            await conn.begin()  # 事务：先删后插，失败回滚，避免丢历史属性
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
        return {"ok": True, "written": len(inserts)}

@router.get("/groups/{groupname}/reply")
async def get_group_reply(groupname: str):
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT id, attribute, op, value FROM radgroupreply WHERE groupname=%s ORDER BY id", (groupname,))
            return await cur.fetchall()

@router.post("/groups/{groupname}/reply")
async def add_group_reply(groupname: str, attribute: str, value: str, op: str = ":="):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("INSERT INTO radgroupreply (groupname, attribute, op, value) VALUES (%s,%s,%s,%s)", (groupname, attribute, op, value))
            return {"ok": True}

@router.put("/groups/reply/{reply_id}")
async def update_group_reply(reply_id: int, value: str = None, op: str = None):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            sets = []; vals = []
            if value is not None: sets.append("value=%s"); vals.append(value)
            if op is not None: sets.append("op=%s"); vals.append(op)
            if sets:
                vals.append(reply_id)
                await cur.execute(f"UPDATE radgroupreply SET {','.join(sets)} WHERE id=%s", vals)
            return {"ok": True}

@router.delete("/groups/reply/{reply_id}")
async def delete_group_reply(reply_id: int):
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("DELETE FROM radgroupreply WHERE id=%s", (reply_id,))
            return {"ok": True}

# ── Group CRUD ──
@router.post("/groups")
async def create_group(groupname: str):
    """创建分组（添加占位 check 条目）"""
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) as cnt FROM radgroupcheck WHERE groupname=%s", (groupname,))
            if (await cur.fetchone())[0] > 0:
                from fastapi import HTTPException
                raise HTTPException(400, "分组已存在")
            await cur.execute("INSERT INTO radgroupcheck (groupname, attribute, op, value) VALUES (%s,'Auth-Type',':=','Accept')", (groupname,))
            return {"ok": True, "groupname": groupname}

@router.put("/groups/{groupname}")
async def rename_group(groupname: str, new_name: str):
    """重命名分组（更新所有关联表）"""
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            for table in ['radusergroup','radgroupreply','radgroupcheck']:
                await cur.execute(f"UPDATE {table} SET groupname=%s WHERE groupname=%s", (new_name, groupname))
            return {"ok": True, "new_name": new_name}

@router.delete("/groups/{groupname}")
async def delete_group(groupname: str):
    """删除分组（移除所有关联条目）"""
    async with get_pool().acquire() as conn:
        async with conn.cursor() as cur:
            # Check if has users
            await cur.execute("SELECT COUNT(*) as cnt FROM radusergroup WHERE groupname=%s", (groupname,))
            users = (await cur.fetchone())[0]
            if users > 0:
                from fastapi import HTTPException
                raise HTTPException(400, f"分组有 {users} 个用户，请先移除用户")
            for table in ['radgroupreply','radgroupcheck']:
                await cur.execute(f"DELETE FROM {table} WHERE groupname=%s", (groupname,))
            return {"ok": True}
