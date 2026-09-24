"""
IP 资产管理 API（v1.0）— PRD: docs/PRD-IP资产管理.md v0.3
- 网段 CRUD（v4 /24 及更细自动生成空闲地址；v6 /120 及更细展开，其余前缀登记模式）
- 地址台账：筛选/分配/释放/状态变更/批量/CSV 导出/审计
- 公网资产：scope=public 列表 + NAT 映射 CRUD（释放反向校验）
- 批量导入：模板下载 / preview 校验 / commit 提交 / 批次日志（xlsx+csv）
"""
import csv
import io
import ipaddress
import json
import logging

from fastapi import APIRouter, HTTPException, Query, UploadFile, File
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from aiomysql import DictCursor

from core.database import get_pool
from core.ip_net import (
    parse_ip, parse_cidr, subnet_capacity, humanize_capacity,
    validate_nat, classify_import_row, check_mac, check_icp, check_date,
    parse_domains, STATUSES, ZONES, ISPS, ASSET_TYPES,
)

router = APIRouter()
logger = logging.getLogger(__name__)

AUTO_EXPAND_V4_MIN_PREFIX = 24   # /24 及更细自动生成空闲地址
AUTO_EXPAND_V6_MIN_PREFIX = 120  # /120 及更细展开，其余前缀登记模式


# ---------- Schemas ----------

class SubnetCreate(BaseModel):
    cidr: str = Field(..., min_length=3, max_length=50)
    name: str = Field(..., min_length=1, max_length=64)
    zone: str = Field(default="office", max_length=20)
    vlan_id: int | None = None
    gateway: str | None = Field(default=None, max_length=45)
    dns1: str | None = Field(default=None, max_length=45)
    dns2: str | None = Field(default=None, max_length=45)
    scope: str = Field(default="private", max_length=10)
    isp: str | None = Field(default=None, max_length=20)
    line_name: str | None = Field(default=None, max_length=64)
    bandwidth_mbps: int | None = None
    contract_end: str | None = Field(default=None, max_length=10)
    icp_no: str | None = Field(default=None, max_length=64)
    note: str | None = Field(default=None, max_length=255)


class SubnetUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=64)
    zone: str | None = Field(default=None, max_length=20)
    vlan_id: int | None = None
    gateway: str | None = Field(default=None, max_length=45)
    dns1: str | None = None
    dns2: str | None = None
    isp: str | None = None
    line_name: str | None = None
    bandwidth_mbps: int | None = None
    contract_end: str | None = None
    icp_no: str | None = None
    note: str | None = None
    enabled: bool | None = None


class AllocateBody(BaseModel):
    hostname: str | None = Field(default=None, max_length=64)
    mac: str | None = Field(default=None, max_length=17)
    asset_type: str | None = Field(default=None, max_length=20)
    asset_ref: str | None = Field(default=None, max_length=64)
    owner: str | None = Field(default=None, max_length=32)
    dept: str | None = Field(default=None, max_length=32)
    purpose: str | None = Field(default=None, max_length=128)
    expires_at: str | None = Field(default=None, max_length=10)
    actor: str = Field(default="admin", max_length=32)


class StatusBody(BaseModel):
    status: str = Field(..., min_length=3, max_length=12)
    note: str | None = Field(default=None, max_length=255)
    actor: str = Field(default="admin", max_length=32)


class BatchBody(BaseModel):
    ids: list[int]
    action: str = Field(..., pattern="^(allocate|release)$")
    allocate: AllocateBody | None = None
    actor: str = Field(default="admin", max_length=32)


class NatCreate(BaseModel):
    public_ip_id: int
    public_port: int = Field(default=0, ge=0, le=65535)
    private_ip_id: int
    private_port: int = Field(default=0, ge=0, le=65535)
    proto: str = Field(default="tcp", max_length=8)
    note: str | None = Field(default=None, max_length=128)
    actor: str = Field(default="admin", max_length=32)


class ImportCommitBody(BaseModel):
    kind: str = Field(..., pattern="^(subnet|address|nat)$")
    mode: str = Field(default="skip", pattern="^(skip|overwrite|strict)$")
    actor: str = Field(default="admin", max_length=32)


# ---------- 工具 ----------

async def _audit(cur, ip_id: int, subnet_id: int, action: str, actor: str,
                 before=None, after=None):
    await cur.execute(
        """INSERT INTO ip_audit (ip_id, subnet_id, action, actor, before_json, after_json)
           VALUES (%s,%s,%s,%s,%s,%s)""",
        (ip_id, subnet_id, action, actor,
         json.dumps(before, ensure_ascii=False, default=str) if before else None,
         json.dumps(after, ensure_ascii=False, default=str) if after else None))


def _require_actor(body) -> str:
    a = (getattr(body, "actor", "") or "admin").strip() or "admin"
    return a


# ---------- 网段 ----------

@router.get("/ip/subnets")
async def subnet_list(version: int | None = None, zone: str | None = None,
                      scope: str | None = None, q: str | None = None):
    pool = get_pool()
    where, args = ["1=1"], []
    if version in (4, 6):
        where.append("version=%s"); args.append(version)
    if zone:
        where.append("zone=%s"); args.append(zone)
    if scope:
        where.append("scope=%s"); args.append(scope)
    if q:
        where.append("(cidr LIKE %s OR name LIKE %s)")
        args.extend([f"%{q}%", f"%{q}%"])
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                f"""SELECT s.id, s.version, s.cidr, s.prefix_len, s.name, s.zone, s.vlan_id,
                           s.gateway, s.dns1, s.dns2, s.scope, s.isp, s.line_name,
                           s.bandwidth_mbps, s.contract_end, s.icp_no, s.note, s.enabled,
                           (SELECT COUNT(*) FROM ip_address a WHERE a.subnet_id=s.id AND a.status='allocated') AS used,
                           (SELECT COUNT(*) FROM ip_address a WHERE a.subnet_id=s.id AND a.status='reserved') AS reserved,
                           (SELECT COUNT(*) FROM ip_address a WHERE a.subnet_id=s.id AND a.status='conflict') AS conflict,
                           (SELECT COUNT(*) FROM ip_address a WHERE a.subnet_id=s.id AND a.status='free') AS free_cnt
                    FROM ip_subnet s WHERE {' AND '.join(where)}
                    ORDER BY s.version, s.prefix_len DESC, s.cidr""", args)
            rows = await cur.fetchall()
    out = []
    for r in rows:
        cap = None
        try:
            net = ipaddress.ip_network(r["cidr"], strict=False)
            cap = subnet_capacity(net, net.prefixlen)
            if cap is None:
                cap_text = humanize_capacity(net)
            else:
                cap_text = str(cap)
        except ValueError:
            cap_text = "-"
        registered = cap is None  # 前缀登记模式
        out.append({**r, "capacity": cap_text, "registered_mode": registered,
                    "contract_end": str(r["contract_end"]) if r["contract_end"] else None})
    return out


@router.post("/ip/subnets")
async def subnet_create(body: SubnetCreate):
    r = parse_cidr(body.cidr)
    if r is None:
        raise HTTPException(422, "CIDR 格式非法（如 192.168.30.0/24 或 2408:8756::/48）")
    net, nv, cidr_text = r
    if body.zone not in ZONES:
        raise HTTPException(422, f"区域枚举非法（可选 {'/'.join(ZONES)}）")
    if body.scope not in ("private", "public"):
        raise HTTPException(422, "scope 必须为 private/public")
    gw = None
    if body.gateway:
        gp = parse_ip(body.gateway)
        if gp is None:
            raise HTTPException(422, f"网关 IP 非法: {body.gateway}")
        gw = gp.text
    contract = None
    if body.contract_end:
        try:
            contract = check_date(body.contract_end)
        except ValueError as e:
            raise HTTPException(422, str(e))

    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT id FROM ip_subnet WHERE version=%s AND cidr=%s",
                              (net.version, cidr_text))
            if await cur.fetchone():
                raise HTTPException(409, f"网段 {cidr_text} 已存在")
            await cur.execute(
                """INSERT INTO ip_subnet
                   (version,cidr,net_addr,prefix_len,name,zone,vlan_id,gateway,dns1,dns2,
                    scope,isp,line_name,bandwidth_mbps,contract_end,icp_no,note)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (net.version, cidr_text, nv.packed, net.prefixlen, body.name, body.zone,
                 body.vlan_id, gw, body.dns1, body.dns2, body.scope, body.isp,
                 body.line_name, body.bandwidth_mbps, contract, body.icp_no, body.note))
            await cur.execute("SELECT LAST_INSERT_ID() AS id")
            new_id = (await cur.fetchone())["id"]

            # v4 /24 及更细（或 v6 /120 及更细）自动生成空闲地址
            generated = 0
            expand = (net.version == 4 and net.prefixlen >= AUTO_EXPAND_V4_MIN_PREFIX) or \
                     (net.version == 6 and net.prefixlen >= AUTO_EXPAND_V6_MIN_PREFIX)
            if expand:
                hosts = net.hosts() if net.version == 4 else net
                batch = []
                if net.version == 4:
                    for h in hosts:
                        batch.append((new_id, 4, h.packed, str(h), "free"))
                else:
                    for h in list(hosts)[:4096]:  # v6 细前缀保护上限
                        batch.append((new_id, 6, h.packed, str(h), "free"))
                if batch:
                    await cur.executemany(
                        """INSERT IGNORE INTO ip_address
                           (subnet_id,version,addr,ip_text,status) VALUES (%s,%s,%s,%s,%s)""",
                        batch)
                    generated = len(batch)
    return {"id": new_id, "cidr": cidr_text, "generated_free": generated,
            "registered_mode": not expand}


async def _subnet_delete_check(cur, subnet_id: int) -> int:
    await cur.execute(
        """SELECT COUNT(*) AS n FROM ip_address
           WHERE subnet_id=%s AND status NOT IN ('free','disabled')""", (subnet_id,))
    row = await cur.fetchone()
    return row["n"] if row else 0


@router.put("/ip/subnets/{subnet_id}")
async def subnet_update(subnet_id: int, body: SubnetUpdate):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT * FROM ip_subnet WHERE id=%s", (subnet_id,))
            old = await cur.fetchone()
            if not old:
                raise HTTPException(404, "网段不存在")
            contract = old["contract_end"]
            if body.contract_end is not None:
                try:
                    contract = check_date(body.contract_end) if body.contract_end else None
                except ValueError as e:
                    raise HTTPException(422, str(e))
            if body.gateway is not None and body.gateway != "":
                gp = parse_ip(body.gateway)
                if gp is None:
                    raise HTTPException(422, f"网关 IP 非法: {body.gateway}")
            fields, args = [], []
            for col in ("name", "zone", "vlan_id", "gateway", "dns1", "dns2", "isp",
                        "line_name", "bandwidth_mbps", "icp_no", "note"):
                v = getattr(body, col)
                if v is not None:
                    fields.append(f"{col}=%s"); args.append(v)
            if body.contract_end is not None:
                fields.append("contract_end=%s"); args.append(contract)
            if body.enabled is not None:
                fields.append("enabled=%s"); args.append(1 if body.enabled else 0)
            if body.zone is not None and body.zone not in ZONES:
                raise HTTPException(422, f"区域枚举非法（可选 {'/'.join(ZONES)}）")
            if not fields:
                raise HTTPException(422, "无可更新字段")
            args.append(subnet_id)
            await cur.execute(f"UPDATE ip_subnet SET {', '.join(fields)} WHERE id=%s", args)
    return {"ok": True}


@router.delete("/ip/subnets/{subnet_id}")
async def subnet_delete(subnet_id: int):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            n = await _subnet_delete_check(cur, subnet_id)
            if n:
                raise HTTPException(409, f"网段内存在 {n} 条非空闲地址，请先清理后再删除")
            await cur.execute("DELETE FROM ip_address WHERE subnet_id=%s", (subnet_id,))
            await cur.execute("DELETE FROM ip_subnet WHERE id=%s", (subnet_id,))
    return {"ok": True}


# ---------- 地址台账 ----------

@router.get("/ip/addresses")
async def address_list(subnet_id: int | None = None, status: str | None = None,
                       q: str | None = None, zone: str | None = None,
                       page: int = Query(default=1, ge=1), size: int = Query(default=50, le=200)):
    pool = get_pool()
    where, args = ["1=1"], []
    if subnet_id:
        where.append("a.subnet_id=%s"); args.append(subnet_id)
    if zone:
        where.append("s.zone=%s"); args.append(zone)
    if status:
        sts = [x for x in status.split(",") if x in STATUSES]
        if sts:
            where.append("a.status IN (%s)" % ",".join(["%s"] * len(sts)))
            args.extend(sts)
    if q:
        like = f"%{q}%"
        where.append("(a.ip_text LIKE %s OR a.hostname LIKE %s OR a.mac LIKE %s OR a.owner LIKE %s OR a.asset_ref LIKE %s)")
        args.extend([like] * 5)
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                f"""SELECT COUNT(*) AS n FROM ip_address a
                    JOIN ip_subnet s ON s.id=a.subnet_id WHERE {' AND '.join(where)}""", args)
            total = (await cur.fetchone())["n"]
            await cur.execute(
                f"""SELECT a.*, s.cidr AS subnet_cidr, s.zone AS subnet_zone, s.scope AS subnet_scope
                    FROM ip_address a JOIN ip_subnet s ON s.id=a.subnet_id
                    WHERE {' AND '.join(where)}
                    ORDER BY a.version, a.addr
                    LIMIT %s OFFSET %s""", [*args, size, (page - 1) * size])
            rows = await cur.fetchall()
    for r in rows:
        r["domains_parsed"] = json.loads(r["domains"]) if r["domains"] else []
        r.pop("domains", None)
        r["addr_hex"] = r["addr"].hex(); r.pop("addr", None)
    return {"total": total, "page": page, "size": size, "items": rows}


@router.post("/ip/addresses/{addr_id}/allocate")
async def address_allocate(addr_id: int, body: AllocateBody):
    actor = _require_actor(body)
    mac = None
    if body.mac:
        try:
            mac = check_mac(body.mac)
        except ValueError as e:
            raise HTTPException(422, str(e))
    expires = None
    if body.expires_at:
        try:
            expires = check_date(body.expires_at)
        except ValueError as e:
            raise HTTPException(422, str(e))
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            # 原子扣减：仅 free 可分配（并发安全）
            await cur.execute(
                """UPDATE ip_address SET status='allocated', hostname=%s, mac=%s,
                       asset_type=%s, asset_ref=%s, owner=%s, dept=%s, purpose=%s,
                       assigned_at=NOW(), expires_at=%s
                   WHERE id=%s AND status='free'""",
                (body.hostname, mac, body.asset_type, body.asset_ref, body.owner,
                 body.dept, body.purpose, expires, addr_id))
            if cur.rowcount == 0:
                await cur.execute("SELECT status FROM ip_address WHERE id=%s", (addr_id,))
                row = await cur.fetchone()
                raise HTTPException(409, "该地址刚被分配" if row and row["status"] == "allocated"
                                    else "该地址当前不可分配")
            await cur.execute("SELECT * FROM ip_address WHERE id=%s", (addr_id,))
            after = await cur.fetchone()
            await _audit(cur, addr_id, after["subnet_id"], "allocate", actor, after=after)
    return {"ok": True, "ip": after["ip_text"]}


@router.post("/ip/addresses/{addr_id}/release")
async def address_release(addr_id: int, body: StatusBody):
    actor = _require_actor(body)
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT * FROM ip_address WHERE id=%s", (addr_id,))
            old = await cur.fetchone()
            if not old:
                raise HTTPException(404, "地址不存在")
            # 反向校验：活跃 NAT 映射（公网侧或私网侧）→ 拒绝
            await cur.execute(
                """SELECT n.id, a.ip_text FROM ip_nat_map n
                   JOIN ip_address a ON a.id = CASE WHEN n.private_ip_id=%s THEN n.public_ip_id ELSE n.private_ip_id END
                   WHERE n.private_ip_id=%s OR n.public_ip_id=%s""",
                (addr_id, addr_id, addr_id))
            nat = await cur.fetchall()
            if nat:
                peer = "、".join(f"{r['ip_text']}(映射#{r['id']})" for r in nat)
                raise HTTPException(409, f"存在活跃公网映射，请先删除：{peer}")
            await cur.execute(
                """UPDATE ip_address SET status='free', hostname=NULL, mac=NULL,
                       asset_type=NULL, asset_ref=NULL, owner=NULL, dept=NULL,
                       purpose=NULL, assigned_at=NULL, expires_at=NULL, note=NULL
                   WHERE id=%s""", (addr_id,))
            await _audit(cur, addr_id, old["subnet_id"], "release", actor, before=old)
    return {"ok": True}


@router.post("/ip/addresses/{addr_id}/status")
async def address_status(addr_id: int, body: StatusBody):
    actor = _require_actor(body)
    if body.status not in STATUSES:
        raise HTTPException(422, f"状态枚举非法（可选 {'/'.join(STATUSES)}）")
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT * FROM ip_address WHERE id=%s", (addr_id,))
            old = await cur.fetchone()
            if not old:
                raise HTTPException(404, "地址不存在")
            await cur.execute("UPDATE ip_address SET status=%s, note=%s WHERE id=%s",
                              (body.status, body.note, addr_id))
            await _audit(cur, addr_id, old["subnet_id"], body.status if body.status in
                         ("reserved", "disabled", "conflict") else "edit", actor,
                         before=old, after={"status": body.status, "note": body.note})
    return {"ok": True}


@router.post("/ip/addresses/batch")
async def address_batch(body: BatchBody):
    actor = _require_actor(body)
    if not body.ids:
        raise HTTPException(422, "ids 不能为空")
    if body.action == "allocate" and not body.allocate:
        raise HTTPException(422, "allocate 需要提供分配信息")
    pool = get_pool()
    ok, failed = 0, []
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            for aid in body.ids:
                try:
                    if body.action == "allocate":
                        ab = body.allocate.model_copy(update={"actor": actor})
                        # 直接内联调用（避免函数包装）
                        mac = None
                        if ab.mac:
                            mac = check_mac(ab.mac)
                        await cur.execute(
                            """UPDATE ip_address SET status='allocated', hostname=%s, mac=%s,
                                   asset_type=%s, asset_ref=%s, owner=%s, dept=%s, purpose=%s,
                                   assigned_at=NOW(), expires_at=NULL
                               WHERE id=%s AND status='free'""",
                            (ab.hostname, mac, ab.asset_type, ab.asset_ref, ab.owner,
                             ab.dept, ab.purpose, aid))
                        if cur.rowcount:
                            await cur.execute("SELECT subnet_id FROM ip_address WHERE id=%s", (aid,))
                            r = await cur.fetchone()
                            await _audit(cur, aid, r["subnet_id"], "allocate", actor)
                            ok += 1
                        else:
                            failed.append(aid)
                    else:
                        await cur.execute(
                            """UPDATE ip_address SET status='free', hostname=NULL, mac=NULL,
                                   asset_type=NULL, asset_ref=NULL, owner=NULL, dept=NULL,
                                   purpose=NULL, assigned_at=NULL, expires_at=NULL
                               WHERE id=%s AND status='allocated'""", (aid,))
                        if cur.rowcount:
                            await cur.execute("SELECT subnet_id FROM ip_address WHERE id=%s", (aid,))
                            r = await cur.fetchone()
                            await _audit(cur, aid, r["subnet_id"], "release", actor)
                            ok += 1
                        else:
                            failed.append(aid)
                except Exception:
                    failed.append(aid)
    return {"ok": ok, "failed": failed}


@router.get("/ip/addresses/export")
async def address_export(subnet_id: int | None = None, status: str | None = None, q: str | None = None):
    pool = get_pool()
    where, args = ["1=1"], []
    if subnet_id:
        where.append("a.subnet_id=%s"); args.append(subnet_id)
    if status:
        sts = [x for x in status.split(",") if x in STATUSES]
        if sts:
            where.append("a.status IN (%s)" % ",".join(["%s"] * len(sts)))
            args.extend(sts)
    if q:
        like = f"%{q}%"
        where.append("(a.ip_text LIKE %s OR a.hostname LIKE %s OR a.owner LIKE %s)")
        args.extend([like] * 3)
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                f"""SELECT a.id, a.ip_text, a.status, a.hostname, a.mac, a.asset_type,
                           a.asset_ref, a.owner, a.dept, a.purpose, a.assigned_at,
                           s.cidr AS subnet, s.zone
                    FROM ip_address a JOIN ip_subnet s ON s.id=a.subnet_id
                    WHERE {' AND '.join(where)} ORDER BY a.version, a.addr""", args)
            rows = await cur.fetchall()
    buf = io.StringIO()
    buf.write("﻿")  # UTF-8 BOM，Excel 兼容
    w = csv.writer(buf)
    w.writerow(["IP", "状态", "主机名", "MAC", "资产类型", "资产引用", "使用人",
                "部门", "用途", "分配时间", "网段", "区域"])
    for r in rows:
        w.writerow([r["ip_text"], r["status"], r["hostname"] or "", r["mac"] or "",
                    r["asset_type"] or "", r["asset_ref"] or "", r["owner"] or "",
                    r["dept"] or "", r["purpose"] or "",
                    str(r["assigned_at"] or ""), r["subnet"], r["zone"]])
    return PlainTextResponse(buf.getvalue(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition":
                                      "attachment; filename=ip_addresses.csv"})


@router.get("/ip/audit")
async def audit_list(ip_id: int | None = None, limit: int = Query(default=100, le=500)):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            if ip_id:
                await cur.execute(
                    """SELECT * FROM ip_audit WHERE ip_id=%s
                       ORDER BY id DESC LIMIT %s""", (ip_id, limit))
            else:
                await cur.execute(
                    """SELECT * FROM ip_audit ORDER BY id DESC LIMIT %s""", (limit,))
            rows = await cur.fetchall()
    for r in rows:
        for k in ("before_json", "after_json"):
            if r.get(k):
                try:
                    r[k.replace("_json", "")] = json.loads(r[k])
                except ValueError:
                    pass
            r.pop(k, None)
    return rows


# ---------- 统计 ----------

@router.get("/ip/stats")
async def stats():
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT scope,
                          SUM(version=4) AS v4_nets, SUM(version=6) AS v6_nets
                   FROM ip_subnet GROUP BY scope""")
            net_rows = await cur.fetchall()
            await cur.execute(
                """SELECT version, status, COUNT(*) AS n FROM ip_address GROUP BY version, status""")
            addr_rows = await cur.fetchall()
            await cur.execute(
                """SELECT COUNT(*) AS n FROM ip_audit
                   WHERE action IN ('allocate','import') AND created_at >= CURDATE() - INTERVAL 7 DAY""")
            week_new = (await cur.fetchone())["n"]
            await cur.execute("SELECT COUNT(*) AS n FROM ip_nat_map")
            nat_total = (await cur.fetchone())["n"]
    nets = {"private": {"v4": 0, "v6": 0}, "public": {"v4": 0, "v6": 0}}
    for r in net_rows:
        nets[r["scope"]] = {"v4": int(r["v4_nets"] or 0), "v6": int(r["v6_nets"] or 0)}
    addr = {"4": {}, "6": {}}
    for r in addr_rows:
        addr[str(r["version"])][r["status"]] = int(r["n"])
    v4_used = addr["4"].get("allocated", 0) + addr["4"].get("reserved", 0) + addr["4"].get("conflict", 0)
    return {"nets": nets, "addr": addr, "v4_used_total": v4_used,
            "week_new": week_new, "nat_total": nat_total}


# ---------- 公网资产 ----------

@router.get("/ip/public")
async def public_list():
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT a.*, s.cidr AS subnet_cidr, s.isp, s.line_name, s.bandwidth_mbps,
                          s.contract_end, s.icp_no
                   FROM ip_address a JOIN ip_subnet s ON s.id=a.subnet_id
                   WHERE s.scope='public'
                   ORDER BY a.version, a.addr""")
            rows = await cur.fetchall()
            ids = [r["id"] for r in rows]
            nat_counts, nat_rows = {}, []
            if ids:
                ph = ",".join(["%s"] * len(ids))
                await cur.execute(
                    f"""SELECT n.*, pub.ip_text AS public_ip, priv.ip_text AS private_ip,
                               priv.hostname AS private_hostname, priv.purpose AS private_purpose
                        FROM ip_nat_map n
                        JOIN ip_address pub ON pub.id=n.public_ip_id
                        JOIN ip_address priv ON priv.id=n.private_ip_id
                        WHERE n.public_ip_id IN ({ph}) ORDER BY n.id""", ids)
                nat_rows = await cur.fetchall()
            for r in nat_rows:
                nat_counts[r["public_ip_id"]] = nat_counts.get(r["public_ip_id"], 0) + 1
    items = []
    for r in rows:
        items.append({**r, "domains_parsed": json.loads(r["domains"]) if r["domains"] else [],
                      "nat_count": nat_counts.get(r["id"], 0),
                      "nat": [n for n in nat_rows if n["public_ip_id"] == r["id"]],
                      "addr_hex": r["addr"].hex()})
        items[-1].pop("domains", None); items[-1].pop("addr", None)
        items[-1]["contract_end"] = str(r["contract_end"]) if r["contract_end"] else None
    return items


@router.post("/ip/nat")
async def nat_create(body: NatCreate):
    actor = _require_actor(body)
    err = validate_nat(body.public_port, body.private_port, body.proto)
    if err:
        raise HTTPException(422, err)
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT a.id, a.ip_text, s.scope FROM ip_address a
                   JOIN ip_subnet s ON s.id=a.subnet_id WHERE a.id IN (%s,%s)""",
                (body.public_ip_id, body.private_ip_id))
            rows = {r["id"]: r for r in await cur.fetchall()}
            if body.public_ip_id not in rows or rows[body.public_ip_id]["scope"] != "public":
                raise HTTPException(422, "public_ip_id 必须是公网（scope=public）地址")
            if body.private_ip_id not in rows or rows[body.private_ip_id]["scope"] != "private":
                raise HTTPException(422, "private_ip_id 必须是私网（scope=private）地址")
            await cur.execute(
                """SELECT id FROM ip_nat_map WHERE public_ip_id=%s AND public_port=%s
                   AND proto=%s AND private_ip_id=%s AND private_port=%s""",
                (body.public_ip_id, body.public_port, body.proto,
                 body.private_ip_id, body.private_port))
            if await cur.fetchone():
                raise HTTPException(409, "相同的映射规则已存在")
            await cur.execute(
                """INSERT INTO ip_nat_map
                   (public_ip_id,public_port,private_ip_id,private_port,proto,note,created_by)
                   VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                (body.public_ip_id, body.public_port, body.private_ip_id,
                 body.private_port, body.proto, body.note, actor))
            await cur.execute("SELECT LAST_INSERT_ID() AS id")
            nid = (await cur.fetchone())["id"]
            await _audit(cur, body.private_ip_id, 0, "nat_add", actor,
                         after={"nat_id": nid, "public_ip_id": body.public_ip_id,
                                "public_port": body.public_port, "proto": body.proto,
                                "private_port": body.private_port})
    return {"id": nid, "ok": True}


@router.put("/ip/nat/{nat_id}")
async def nat_update(nat_id: int, body: NatCreate):
    actor = _require_actor(body)
    err = validate_nat(body.public_port, body.private_port, body.proto)
    if err:
        raise HTTPException(422, err)
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT * FROM ip_nat_map WHERE id=%s", (nat_id,))
            old = await cur.fetchone()
            if not old:
                raise HTTPException(404, "映射不存在")
            await cur.execute(
                """UPDATE ip_nat_map SET public_ip_id=%s, public_port=%s, private_ip_id=%s,
                       private_port=%s, proto=%s, note=%s WHERE id=%s""",
                (body.public_ip_id, body.public_port, body.private_ip_id,
                 body.private_port, body.proto, body.note, nat_id))
            await _audit(cur, body.private_ip_id, 0, "nat_edit", actor,
                         before=old, after=body.model_dump())
    return {"ok": True}


@router.delete("/ip/nat/{nat_id}")
async def nat_delete(nat_id: int, actor: str = Query(default="admin", max_length=32)):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT * FROM ip_nat_map WHERE id=%s", (nat_id,))
            old = await cur.fetchone()
            if not old:
                raise HTTPException(404, "映射不存在")
            await cur.execute("DELETE FROM ip_nat_map WHERE id=%s", (nat_id,))
            await _audit(cur, old["private_ip_id"], 0, "nat_del", actor, before=old)
    return {"ok": True}


@router.get("/ip/nat")
async def nat_list(private_ip_id: int | None = None, public_ip_id: int | None = None):
    pool = get_pool()
    where, args = ["1=1"], []
    if private_ip_id:
        where.append("n.private_ip_id=%s"); args.append(private_ip_id)
    if public_ip_id:
        where.append("n.public_ip_id=%s"); args.append(public_ip_id)
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                f"""SELECT n.*, pub.ip_text AS public_ip, priv.ip_text AS private_ip,
                           priv.hostname AS private_hostname, priv.purpose AS private_purpose
                    FROM ip_nat_map n
                    JOIN ip_address pub ON pub.id=n.public_ip_id
                    JOIN ip_address priv ON priv.id=n.private_ip_id
                    WHERE {' AND '.join(where)} ORDER BY n.id""", args)
            return await cur.fetchall()


# ---------- 批量导入 ----------

_IMPORT_HEADERS = {
    "subnet": ["cidr", "name", "zone", "vlan_id", "gateway", "dns1", "dns2",
               "scope", "isp", "line_name", "bandwidth_mbps", "contract_end", "icp_no", "note"],
    "address": ["ip", "status", "hostname", "mac", "asset_type", "asset_ref",
                "owner", "dept", "purpose", "domains", "note"],
    "nat": ["public_ip", "public_port", "proto", "private_ip", "private_port", "note"],
}


def _read_rows(file_bytes: bytes, filename: str, kind: str) -> list[dict]:
    """xlsx / csv → [dict]；表头列名匹配 _IMPORT_HEADERS"""
    headers = _IMPORT_HEADERS[kind]
    name = filename.lower()
    rows: list[dict] = []
    if name.endswith((".xlsx", ".xlsm")):
        try:
            from openpyxl import load_workbook
        except ImportError:
            raise HTTPException(500, "服务器缺少 openpyxl，请先安装：pip3 install openpyxl")
        wb = load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
        ws = wb.active
        it = ws.iter_rows(values_only=True)
        head = None
        for r in it:
            cells = [str(c).strip().lower() if c is not None else "" for c in r]
            if any(c in headers for c in cells):
                head = cells
                break
        if not head:
            raise HTTPException(422, "未找到表头行（列名需与模板一致）")
        for r in it:
            d = {h: (r[i] if i < len(r) else None) for i, h in enumerate(head) if h in headers}
            if any(str(v).strip() for v in d.values() if v is not None):
                rows.append(d)
            if len(rows) > 20000:
                raise HTTPException(422, "超过 2 万行上限，请拆分文件")
    else:  # csv
        text = file_bytes.decode("utf-8-sig", errors="replace")
        reader = csv.reader(io.StringIO(text))
        head = None
        for r in reader:
            cells = [c.strip().lower() for c in r]
            if any(c in headers for c in cells):
                head = cells
                break
        if not head:
            raise HTTPException(422, "未找到表头行（列名需与模板一致）")
        for r in reader:
            d = {h: (r[i] if i < len(r) else "") for i, h in enumerate(head) if h in headers}
            if any(str(v).strip() for v in d.values()):
                rows.append(d)
            if len(rows) > 20000:
                raise HTTPException(422, "超过 2 万行上限，请拆分文件")
    return rows


async def _existing_keys(cur, kind: str) -> dict:
    """唯一键 → 已存在记录（含 id），用于 🟢/🟡 判定与 nat 引用解析"""
    keys = {}
    if kind == "subnet":
        await cur.execute("SELECT id, version, cidr FROM ip_subnet")
        for r in await cur.fetchall():
            keys[(r["version"], r["cidr"])] = {"id": r["id"]}
    elif kind == "address":
        await cur.execute("SELECT id, version, addr, ip_text FROM ip_address")
        for r in await cur.fetchall():
            keys[(r["version"], bytes(r["addr"]))] = {"id": r["id"]}
            keys[r["ip_text"]] = {"id": r["id"]}
    elif kind == "nat":
        await cur.execute(
            """SELECT n.*, pub.ip_text AS pub_ip, priv.ip_text AS priv_ip FROM ip_nat_map n
               JOIN ip_address pub ON pub.id=n.public_ip_id
               JOIN ip_address priv ON priv.id=n.private_ip_id""")
        for r in await cur.fetchall():
            keys[(r["pub_ip"], r["public_port"], r["proto"], r["priv_ip"], r["private_port"])] = {"id": r["id"]}
    return keys


@router.post("/ip/import/preview")
async def import_preview(kind: str = Query(..., pattern="^(subnet|address|nat)$"),
                         file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(422, "文件超过 10MB 上限")
    rows = _read_rows(data, file.filename or "", kind)
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            existing = await _existing_keys(cur, kind)
            subnet_index = []
            if kind == "address":
                await cur.execute("SELECT id, cidr FROM ip_subnet")
                for r in await cur.fetchall():
                    try:
                        subnet_index.append((r["cidr"], r["id"],
                                             ipaddress.ip_network(r["cidr"], strict=False)))
                    except ValueError:
                        continue
    counts = {"insert": 0, "update": 0, "error": 0}
    errors = []
    preview = []
    for i, row in enumerate(rows, start=2):  # Excel 数据从第 2 行起
        color, val, err = classify_import_row(kind, row, existing, subnet_index)
        counts[color] += 1
        if color == "error":
            errors.append({"row": i, "input": {k: str(v) for k, v in row.items() if v}, "reason": err})
        else:
            preview.append({"row": i, "color": color,
                            "display": _display_row(kind, val)})
    return {"kind": kind, "total": len(rows), "counts": counts,
            "preview": preview[:200], "errors": errors[:500], "error_total": len(errors),
            "rows": rows[:20000]}


def _display_row(kind: str, val: dict) -> dict:
    if kind == "subnet":
        return {"cidr": val["cidr"], "name": val["name"], "zone": val["zone"], "scope": val["scope"]}
    if kind == "address":
        return {"ip": val["ip_text"], "status": val["status"], "hostname": val["hostname"],
                "owner": val["owner"]}
    return {"public_port": val["public_port"], "proto": val["proto"],
            "private_port": val["private_port"], "note": val["note"]}


@router.post("/ip/import/commit")
async def import_commit(kind: str = Query(..., pattern="^(subnet|address|nat)$"),
                        mode: str = Query(default="skip", pattern="^(skip|overwrite|strict)$"),
                        file: UploadFile = File(...), actor: str = Query(default="admin")):
    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(422, "文件超过 10MB 上限")
    rows = _read_rows(data, file.filename or "", kind)
    pool = get_pool()
    inserted = updated = failed = 0
    errors = []
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            existing = await _existing_keys(cur, kind)
            subnet_index = []
            if kind == "address":
                await cur.execute("SELECT id, cidr FROM ip_subnet")
                for r in await cur.fetchall():
                    try:
                        subnet_index.append((r["cidr"], r["id"],
                                             ipaddress.ip_network(r["cidr"], strict=False)))
                    except ValueError:
                        continue
            # 严格模式：先全量校验
            parsed = []
            for i, row in enumerate(rows, start=2):
                color, val, err = classify_import_row(kind, row, existing, subnet_index)
                if err:
                    errors.append({"row": i, "reason": err})
                    failed += 1
                else:
                    # update 判定：existing 键结构在 classify 内已处理，这里再取目标 id
                    target_id = None
                    if kind == "subnet":
                        target_id = existing.get((val["version"], val["cidr"]), {}).get("id")
                    elif kind == "address":
                        target_id = existing.get((val["version"], val["addr_packed"]), {}).get("id")
                    elif kind == "nat":
                        pub = parse_ip(str(row.get("public_ip", "")))
                        priv = parse_ip(str(row.get("private_ip", "")))
                        key = (pub.text, val["public_port"], val["proto"],
                               priv.text, val["private_port"])
                        target_id = existing.get(key, {}).get("id")
                    parsed.append((color, val, target_id))
            if mode == "strict" and errors:
                await cur.execute(
                    """INSERT INTO ip_import_log (kind,file_name,total_rows,inserted,updated,failed,mode,error_json,created_by)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (kind, file.filename, len(rows), 0, 0, failed, mode,
                     json.dumps(errors[:1000], ensure_ascii=False), actor))
                raise HTTPException(422, f"严格模式：存在 {failed} 个错误行，全部未入库")

            batch = []
            for color, val, target_id in parsed:
                if color == "update" and mode == "skip":
                    continue  # 跳过冲突
                batch.append((color, val, target_id))

            # 分批事务执行（500/批）
            for i in range(0, len(batch), 500):
                chunk = batch[i:i + 500]
                try:
                    for color, val, target_id in chunk:
                        if kind == "subnet":
                            if color == "insert":
                                await cur.execute(
                                    """INSERT INTO ip_subnet
                                       (version,cidr,net_addr,prefix_len,name,zone,vlan_id,gateway,scope,isp,line_name,bandwidth_mbps,contract_end,icp_no,note)
                                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                                    (val["version"], val["cidr"], val["net_packed"], val["prefix_len"],
                                     val["name"], val["zone"], val["vlan_id"], val["gateway"],
                                     val["scope"], val["isp"], val["line_name"],
                                     val["bandwidth_mbps"], val["contract_end"], val["icp_no"], val["note"]))
                                inserted += 1
                            elif target_id:
                                await cur.execute(
                                    """UPDATE ip_subnet SET name=%s, zone=%s, vlan_id=%s, gateway=%s,
                                           isp=%s, line_name=%s, bandwidth_mbps=%s, icp_no=%s, note=%s
                                       WHERE id=%s""",
                                    (val["name"], val["zone"], val["vlan_id"], val["gateway"],
                                     val["isp"], val["line_name"], val["bandwidth_mbps"],
                                     val["icp_no"], val["note"], target_id))
                                updated += 1
                        elif kind == "address":
                            if color == "insert":
                                await cur.execute(
                                    """INSERT INTO ip_address
                                       (subnet_id,version,addr,ip_text,status,hostname,mac,asset_type,asset_ref,owner,dept,purpose,domains,note)
                                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                                    (val["subnet_id"], val["version"], val["addr_packed"], val["ip_text"],
                                     val["status"], val["hostname"], val["mac"], val["asset_type"],
                                     val["asset_ref"], val["owner"], val["dept"], val["purpose"],
                                     val["domains"], val["note"]))
                                await cur.execute("SELECT LAST_INSERT_ID() AS id")
                                nid = (await cur.fetchone())["id"]
                                await _audit(cur, nid, val["subnet_id"], "import", actor,
                                             after={"ip": val["ip_text"], "status": val["status"]})
                                inserted += 1
                            elif target_id:
                                await cur.execute(
                                    """UPDATE ip_address SET status=%s, hostname=%s, mac=%s,
                                           asset_type=%s, asset_ref=%s, owner=%s, dept=%s,
                                           purpose=%s, domains=%s, note=%s WHERE id=%s""",
                                    (val["status"], val["hostname"], val["mac"], val["asset_type"],
                                     val["asset_ref"], val["owner"], val["dept"], val["purpose"],
                                     val["domains"], val["note"], target_id))
                                await _audit(cur, target_id, val["subnet_id"], "import", actor,
                                             after={"ip": val["ip_text"], "status": val["status"]})
                                updated += 1
                        else:  # nat
                            if color == "insert":
                                await cur.execute(
                                    """INSERT IGNORE INTO ip_nat_map
                                       (public_ip_id,public_port,private_ip_id,private_port,proto,note,created_by)
                                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                                    (val["public_ip_id"], val["public_port"], val["private_ip_id"],
                                     val["private_port"], val["proto"], val["note"], actor))
                                inserted += 1
                            elif target_id:
                                await cur.execute(
                                    """UPDATE ip_nat_map SET private_ip_id=%s, private_port=%s,
                                           proto=%s, note=%s WHERE id=%s""",
                                    (val["private_ip_id"], val["private_port"], val["proto"],
                                     val["note"], target_id))
                                updated += 1
                except Exception as e:
                    logger.exception("import batch error")
                    errors.append({"row": f"batch-{i}", "reason": str(e)})
                    failed += len(chunk)

            await cur.execute(
                """INSERT INTO ip_import_log (kind,file_name,total_rows,inserted,updated,failed,mode,error_json,created_by)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (kind, file.filename, len(rows), inserted, updated, failed, mode,
                 json.dumps(errors[:1000], ensure_ascii=False), actor))
    return {"total": len(rows), "inserted": inserted, "updated": updated, "failed": failed,
            "errors": errors[:200]}


@router.get("/ip/import/logs")
async def import_logs(limit: int = Query(default=50, le=200)):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT id, kind, file_name, total_rows, inserted, updated, failed,
                          mode, error_json, created_by, created_at
                   FROM ip_import_log ORDER BY id DESC LIMIT %s""", (limit,))
            rows = await cur.fetchall()
    for r in rows:
        if r.get("error_json"):
            try:
                r["errors"] = json.loads(r["error_json"])
            except ValueError:
                r["errors"] = []
        r.pop("error_json", None)
    return rows


@router.get("/ip/import/template")
async def import_template(kind: str = Query(..., pattern="^(subnet|address|nat)$")):
    headers = _IMPORT_HEADERS[kind]
    sample = {
        "subnet": ["192.168.30.0/24", "办公接入-A", "office", "30", "192.168.30.1", "", "",
                   "private", "", "", "", "", "", "示例行"],
        "address": ["192.168.110.140", "空闲", "app-server-01", "08:6E:5C:AA:12:F4",
                    "physical", "sw-110-106", "double", "IT 基础设施", "应用服务器", "", "示例行"],
        "nat": ["58.210.101.66", "443", "tcp", "192.168.110.106", "4433", "零信任入口 示例行"],
    }[kind]
    buf = io.StringIO()
    buf.write("﻿")
    w = csv.writer(buf)
    w.writerow(headers)
    w.writerow(sample)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition":
                                      f"attachment; filename=ip_import_{kind}_template.csv"})
