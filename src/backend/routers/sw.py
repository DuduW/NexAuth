"""
交换机备份管理 API（v1.0）— PRD: docs/PRD-华为交换机备份.md
- 设备台账 CRUD / 连接测试 / 批量状态
- 凭据（共享组 + 设备独立，AES-256-GCM）
- 手动备份 / 版本历史 / 全文查看 / 下载 / 双版本 diff
- 定时任务与还原属 v1.1 / v1.2，不在本路由
"""
import asyncio
import logging

from pathlib import Path
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from aiomysql import DictCursor

from core.database import get_pool
from core.sw_crypto import encrypt_password, MasterKeyMissing
from core.sw_ssh import SwSSHError, unified_diff_text
from core.sw_backup import (
    run_backup, test_connection_blocking, collect_health_blocking, SW_BACKUP_DIR,
)

router = APIRouter()
logger = logging.getLogger(__name__)


# ---------- Schemas ----------

class DeviceCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    mgmt_ip: str = Field(..., min_length=7, max_length=46)
    model: str = Field(default="S5735", max_length=64)
    ssh_port: int = Field(default=22, ge=1, le=65535)
    group_tag: str | None = Field(default=None, max_length=64)
    remark: str | None = Field(default=None, max_length=255)
    # 凭据：二选一 —— credential_id=共享组；或 username+password 新建独立凭据
    credential_id: int | None = None
    username: str | None = Field(default=None, max_length=64)
    password: str | None = Field(default=None, max_length=128)


class DeviceUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=64)
    mgmt_ip: str | None = Field(default=None, max_length=46)
    model: str | None = Field(default=None, max_length=64)
    ssh_port: int | None = Field(default=None, ge=1, le=65535)
    group_tag: str | None = None
    remark: str | None = None
    enabled: bool | None = None
    credential_id: int | None = None
    username: str | None = Field(default=None, max_length=64)
    password: str | None = Field(default=None, max_length=128)  # 空/None = 不修改


class CredentialCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    username: str = Field(..., min_length=1, max_length=64)
    password: str = Field(..., min_length=1, max_length=128)


def _ssh_err(e: SwSSHError) -> HTTPException:
    kind = e.args[0] if e.args else "session"
    msg = e.args[1] if len(e.args) > 1 else str(e)
    return HTTPException(502, f"SSH {kind}: {msg}")


# ---------- 凭据 ----------

@router.get("/sw/credentials")
async def list_credentials():
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT c.id, c.name, c.username, c.is_shared, c.created_at,
                          (SELECT COUNT(*) FROM sw_device d WHERE d.credential_id=c.id) AS device_count
                   FROM sw_credential c ORDER BY c.is_shared DESC, c.name""")
            return await cur.fetchall()


@router.post("/sw/credentials")
async def create_credential(body: CredentialCreate):
    pool = get_pool()
    enc = encrypt_password(body.password)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            try:
                await cur.execute(
                    "INSERT INTO sw_credential (name, username, password_enc, is_shared) VALUES (%s,%s,%s,1)",
                    (body.name, body.username, enc))
            except Exception:
                raise HTTPException(409, f"凭据组名已存在: {body.name}")
            return {"id": cur.lastrowid}


# ---------- 设备 ----------

@router.get("/sw/devices")
async def list_devices():
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT d.id, d.name, d.mgmt_ip, d.model, d.ssh_port, d.group_tag,
                          d.remark, d.enabled, d.last_online_at, d.last_vrp_ver,
                          c.id AS credential_id, c.name AS credential_name,
                          (SELECT CONCAT(r.version_no, '|', r.created_at)
                             FROM sw_backup_record r
                            WHERE r.device_id = d.id AND r.status='success'
                            ORDER BY r.version_no DESC LIMIT 1) AS last_backup
                   FROM sw_device d JOIN sw_credential c ON c.id = d.credential_id
                   ORDER BY d.group_tag, d.name""")
            rows = await cur.fetchall()
    for r in rows:
        if r.get("last_backup"):
            v, ts = str(r["last_backup"]).split("|", 1)
            r["last_backup_version"], r["last_backup_at"] = int(v), ts
        else:
            r["last_backup_version"], r["last_backup_at"] = None, None
        r.pop("last_backup", None)
    return rows


@router.post("/sw/devices")
async def create_device(body: DeviceCreate):
    pool = get_pool()
    # 前置查重（2026-09-22 修复：此前凭据插入未捕获 1062，重复添加直接裸 500「内部错误」）
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT id FROM sw_device WHERE name=%s OR (mgmt_ip=%s AND ssh_port=%s)",
                (body.name, body.mgmt_ip, body.ssh_port))
            dup = await cur.fetchone()
            if dup:
                raise HTTPException(
                    409, f"设备已存在（id={dup[0]}）：同一管理 IP:端口 或同名设备不能重复添加。"
                         f"如需更新请使用编辑功能，如需重新添加请先删除原记录")
    cred_id = body.credential_id
    if not cred_id:
        if not (body.username and body.password):
            raise HTTPException(422, "需提供共享凭据组 credential_id，或独立凭据 username+password")
        try:
            enc = encrypt_password(body.password)
        except MasterKeyMissing as e:
            raise HTTPException(503, str(e))
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                try:
                    await cur.execute(
                        "INSERT INTO sw_credential (name, username, password_enc, is_shared) VALUES (%s,%s,%s,0)",
                        (f"dev-{body.name}", body.username, enc))
                except Exception as e:
                    if "uk_name" in str(e):
                        raise HTTPException(
                            409, f"凭据名 dev-{body.name} 已被占用"
                                 f"（可能存在历史残留凭据，请改用共享凭据组或先清理）")
                    raise HTTPException(500, str(e))
                cred_id = cur.lastrowid

    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            try:
                await cur.execute(
                    """INSERT INTO sw_device
                       (name, mgmt_ip, model, ssh_port, credential_id, group_tag, remark)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (body.name, body.mgmt_ip, body.model, body.ssh_port,
                     cred_id, body.group_tag, body.remark))
            except Exception as e:
                msg = str(e)
                if "uk_name" in msg:
                    raise HTTPException(409, f"设备名已存在: {body.name}")
                if "uk_ip_port" in msg:
                    raise HTTPException(409, f"管理 IP+端口已存在: {body.mgmt_ip}:{body.ssh_port}")
                raise HTTPException(500, msg)
            return {"id": cur.lastrowid}


@router.put("/sw/devices/{device_id}")
async def update_device(device_id: int, body: DeviceUpdate):
    pool = get_pool()
    fields, params = [], []

    if body.credential_id is not None:
        fields.append("credential_id=%s"); params.append(body.credential_id)
    elif body.username and body.password:
        # 设备独立凭据：更新/重建 dev-{name} 凭据行
        async with pool.acquire() as conn:
            async with conn.cursor(DictCursor) as cur:
                await cur.execute("SELECT name FROM sw_device WHERE id=%s", (device_id,))
                dev = await cur.fetchone()
                if not dev:
                    raise HTTPException(404, "设备不存在")
                enc = encrypt_password(body.password)
                await cur.execute(
                    """UPDATE sw_credential SET username=%s, password_enc=%s
                       WHERE name=%s AND is_shared=0""",
                    (body.username, enc, f"dev-{dev['name']}"))
                if cur.rowcount == 0:
                    await cur.execute(
                        """INSERT INTO sw_credential (name, username, password_enc, is_shared)
                           VALUES (%s,%s,%s,0)""", (f"dev-{dev['name']}", body.username, enc))

    for col, val in [("name", body.name), ("mgmt_ip", body.mgmt_ip), ("model", body.model),
                     ("ssh_port", body.ssh_port), ("group_tag", body.group_tag),
                     ("remark", body.remark), ("enabled", body.enabled)]:
        if val is not None:
            fields.append(f"{col}=%s"); params.append(val)

    if fields:
        params.append(device_id)
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                try:
                    await cur.execute(f"UPDATE sw_device SET {', '.join(fields)} WHERE id=%s", params)
                except Exception as e:
                    msg = str(e)
                    if "uk_name" in msg:
                        raise HTTPException(409, "设备名已存在")
                    if "uk_ip_port" in msg:
                        raise HTTPException(409, "管理 IP+端口已存在")
                    raise HTTPException(500, msg)
    return {"ok": True}


@router.delete("/sw/devices/{device_id}")
async def delete_device(device_id: int):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT COUNT(*) AS n FROM sw_backup_record WHERE device_id=%s", (device_id,))
            n = (await cur.fetchone())["n"]
            if n > 0:
                raise HTTPException(
                    409, f"该设备有 {n} 份备份记录，禁止删除；可改为「停用」以保留历史")
            await cur.execute(
                """SELECT c.id FROM sw_device d JOIN sw_credential c ON c.id=d.credential_id
                   WHERE d.id=%s AND c.is_shared=0""", (device_id,))
            cred = await cur.fetchone()
            await cur.execute("DELETE FROM sw_device WHERE id=%s", (device_id,))
            if cred:
                await cur.execute("DELETE FROM sw_credential WHERE id=%s AND is_shared=0", (cred["id"],))
    return {"ok": True}


# ---------- 连接测试 / 手动备份 ----------

async def _dev_with_plain_password(device_id: int) -> dict:
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT d.id, d.name, d.mgmt_ip, d.ssh_port, d.model, d.enabled,
                          c.username, c.password_enc
                   FROM sw_device d JOIN sw_credential c ON c.id=d.credential_id
                   WHERE d.id=%s""", (device_id,))
            dev = await cur.fetchone()
    if not dev:
        raise HTTPException(404, "设备不存在")
    from core.sw_crypto import decrypt_password
    dev["password"] = decrypt_password(bytes(dev["password_enc"]))
    return dev


@router.post("/sw/devices/{device_id}/test")
async def test_device(device_id: int):
    try:
        dev = await _dev_with_plain_password(device_id)
    except MasterKeyMissing as e:
        raise HTTPException(503, str(e))
    try:
        info = await asyncio.to_thread(test_connection_blocking, dev)
    except SwSSHError as e:
        raise _ssh_err(e)
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """UPDATE sw_device SET last_online_at=NOW(), last_vrp_ver=%s WHERE id=%s""",
                (info.get("vrp"), device_id))
    return info


@router.post("/sw/devices/{device_id}/backup")
async def backup_device(device_id: int, operator: str = Query(default="admin")):
    try:
        dev = await _dev_with_plain_password(device_id)
    except MasterKeyMissing as e:
        raise HTTPException(503, str(e))
    if not dev.get("enabled", True):
        raise HTTPException(409, f"设备「{dev['name']}」已停用，请先启用")
    try:
        return await run_backup(get_pool(), dev, "manual", operator)
    except SwSSHError as e:
        raise _ssh_err(e)


# ---------- 备份版本 ----------

@router.get("/sw/devices/{device_id}/backups")
async def list_backups(device_id: int, limit: int = Query(default=100, le=500)):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT id, version_no, trigger_type, operator, size_bytes, line_count,
                          diff_added, diff_removed, status, fail_reason, created_at
                   FROM sw_backup_record WHERE device_id=%s
                   ORDER BY version_no DESC LIMIT %s""", (device_id, limit))
            return await cur.fetchall()


@router.delete("/sw/backups/{record_id}")
async def delete_backup(record_id: int):
    """删除备份版本：物理文件 + 数据库记录（失败记录可删，成功记录亦可清理）"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT id, device_id, version_no, file_path, status FROM sw_backup_record WHERE id=%s",
                (record_id,))
            row = await cur.fetchone()
            if not row:
                raise HTTPException(404, "备份版本不存在")
            await cur.execute(
                """SELECT id, version_no FROM sw_backup_record
                   WHERE device_id=%s AND status='success' AND id<>%s
                   ORDER BY version_no DESC LIMIT 1""", (row["device_id"], record_id))
            latest = await cur.fetchone()
            # 删除物理文件（缺失不阻塞）
            p = Path(row["file_path"])
            try:
                if p.exists():
                    p.unlink()
            except OSError as e:
                logger.warning("备份文件删除失败 id=%s: %s", record_id, e)
            await cur.execute("DELETE FROM sw_backup_record WHERE id=%s", (record_id,))
    return {"deleted": record_id, "version_no": row["version_no"],
            "latest_remaining": (latest or {}).get("version_no")}

@router.get("/sw/devices/{device_id}/backups/diff")
async def diff_latest(device_id: int):
    """最新成功版本 vs 上一成功版本（页面默认 diff）"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT id, version_no, file_path FROM sw_backup_record
                   WHERE device_id=%s AND status='success'
                   ORDER BY version_no DESC LIMIT 2""", (device_id,))
            rows = await cur.fetchall()
    if not rows:
        raise HTTPException(404, "尚无成功备份")
    new = rows[0]
    if len(rows) < 2:
        return {"from": None, "to": new["version_no"], "diff": "", "added": 0, "removed": 0}
    old = rows[1]
    return _diff_payload(old, new)


def _diff_payload(old: dict, new: dict) -> dict:
    old_p, new_p = Path(old["file_path"]), Path(new["file_path"])
    if not old_p.exists() or not new_p.exists():
        raise HTTPException(410, "备份文件缺失（服务端存储被清理）")
    from core.sw_ssh import diff_counts
    old_t = old_p.read_text(encoding="utf-8", errors="replace")
    new_t = new_p.read_text(encoding="utf-8", errors="replace")
    added, removed = diff_counts(old_t, new_t)
    return {"from": old["version_no"], "to": new["version_no"],
            "diff": unified_diff_text(old_t, new_t, f"v{old['version_no']}", f"v{new['version_no']}"),
            "added": added, "removed": removed}


@router.get("/sw/backups/{record_id}/diff")
async def diff_record(record_id: int, target: int | None = Query(default=None)):
    """指定两个版本的 diff；target 缺省 = 与上一成功版本"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT id, device_id, version_no, file_path, status FROM sw_backup_record WHERE id=%s",
                (record_id,))
            base = await cur.fetchone()
            if not base:
                raise HTTPException(404, "备份版本不存在")
            if target:
                await cur.execute(
                    "SELECT id, version_no, file_path, status FROM sw_backup_record WHERE id=%s", (target,))
                other = await cur.fetchone()
                if not other or other["device_id"] != base["device_id"]:
                    raise HTTPException(422, "target 必须是同一设备的备份版本")
                old, new = other, base
            else:
                await cur.execute(
                    """SELECT id, version_no, file_path, status FROM sw_backup_record
                       WHERE device_id=%s AND status='success' AND version_no<%s
                       ORDER BY version_no DESC LIMIT 1""", (base["device_id"], base["version_no"]))
                other = await cur.fetchone()
                old, new = other, base
    if not old:
        return {"from": None, "to": base["version_no"], "diff": "", "added": 0, "removed": 0}
    return _diff_payload(old, new)


@router.get("/sw/backups/{record_id}/content")
async def backup_content(record_id: int):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT version_no, file_path, status, fail_reason FROM sw_backup_record WHERE id=%s",
                (record_id,))
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "备份版本不存在")
    if row["status"] != "success":
        raise HTTPException(410, f"该版本备份失败: {row['fail_reason']}")
    p = Path(row["file_path"])
    if not p.exists():
        raise HTTPException(410, "备份文件缺失（服务端存储被清理）")
    return PlainTextResponse(p.read_text(encoding="utf-8", errors="replace"),
                             media_type="text/plain; charset=utf-8")


@router.get("/sw/backups/{record_id}/download")
async def backup_download(record_id: int):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT r.file_path, r.status, d.name AS device_name, r.version_no
                   FROM sw_backup_record r JOIN sw_device d ON d.id=r.device_id
                   WHERE r.id=%s""", (record_id,))
            row = await cur.fetchone()
    if not row or row["status"] != "success":
        raise HTTPException(404, "备份版本不存在或未成功")
    p = Path(row["file_path"])
    if not p.exists():
        raise HTTPException(410, "备份文件缺失")
    fname = f"{row['device_name']}_v{row['version_no']}.cfg"
    return PlainTextResponse(
        p.read_text(encoding="utf-8", errors="replace"),
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'})


# ---------- 在线分析（v2.0，PRD §3.5） ----------

import json as _json

OFFLINE_DEBOUNCE = 3          # 连续 3 次巡检失败才标记离线（防抖）
SNAPSHOT_RETENTION_DAYS = 30  # 快照保留天数（按天聚合降采样由前端/后续任务处理）


async def _save_snapshot(pool, device_id: int, snap: dict):
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """INSERT INTO sw_health_snapshot
                   (device_id, online, cpu_pct, mem_pct, uptime, temp_max,
                    alarm_json, interfaces_json, collected_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,NOW())""",
                (device_id, snap["online"], snap.get("cpu_pct"), snap.get("mem_pct"),
                 (snap.get("uptime") or "")[:64], snap.get("temp_max"),
                 _json.dumps(snap.get("alarms") or [], ensure_ascii=False),
                 _json.dumps(snap.get("interfaces") or [], ensure_ascii=False)))
            if snap["online"]:
                await cur.execute(
                    "UPDATE sw_device SET last_online_at=NOW(), last_vrp_ver=%s WHERE id=%s",
                    (snap.get("vrp") or None, device_id))
            # 保留策略：30 天滚动清理
            await cur.execute(
                "DELETE FROM sw_health_snapshot WHERE collected_at < NOW() - INTERVAL %s DAY",
                (SNAPSHOT_RETENTION_DAYS,))


@router.post("/sw/analysis/devices/{device_id}/run")
async def analysis_run_one(device_id: int):
    """单台巡检：对指定设备立即采集一次健康快照（复用全量巡检的采集与落库逻辑）"""
    from core.sw_crypto import decrypt_password, MasterKeyMissing
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT d.id, d.name, d.mgmt_ip, d.ssh_port, d.model,
                          c.username, c.password_enc
                   FROM sw_device d JOIN sw_credential c ON c.id=d.credential_id
                   WHERE d.id=%s AND d.enabled=1""", (device_id,))
            dev = await cur.fetchone()
    if not dev:
        raise HTTPException(404, "设备不存在或已停用")
    dev = dict(dev)
    try:
        dev["password"] = decrypt_password(bytes(dev["password_enc"]))
    except MasterKeyMissing as e:
        raise HTTPException(503, str(e))
    try:
        snap = await asyncio.to_thread(collect_health_blocking, dev)
    except SwSSHError as e:
        kind = e.args[0] if e.args else "session"
        snap = {"online": 0}
        await _save_snapshot(pool, dev["id"], snap)
        raise HTTPException(502, f"巡检失败（{kind}）：{e.args[1] if len(e.args) > 1 else e}")
    await _save_snapshot(pool, dev["id"], snap)
    return {"device_id": dev["id"], "name": dev["name"], "online": True,
            "cpu_pct": snap.get("cpu_pct"), "mem_pct": snap.get("mem_pct"),
            "temp_max": snap.get("temp_max"),
            "alarm_count": len(snap.get("alarms") or [])}


@router.post("/sw/analysis/run")
async def analysis_run():
    """立即巡检：串行逐台采集（设备间隔 1s，防 SSH 并发风暴，PRD §7）"""
    from core.sw_crypto import decrypt_password, MasterKeyMissing
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT d.id, d.name, d.mgmt_ip, d.ssh_port, d.model,
                          c.username, c.password_enc
                   FROM sw_device d JOIN sw_credential c ON c.id=d.credential_id
                   WHERE d.enabled=1 ORDER BY d.id""")
            devs = await cur.fetchall()
    results = []
    for i, row in enumerate(devs):
        dev = dict(row)
        if i:
            await asyncio.sleep(1)        # 设备间隔 1s
        try:
            dev["password"] = decrypt_password(bytes(dev["password_enc"]))
        except MasterKeyMissing as e:
            raise HTTPException(503, str(e))
        try:
            snap = await asyncio.to_thread(collect_health_blocking, dev)
        except SwSSHError as e:
            kind = e.args[0] if e.args else "session"
            snap = {"online": 0}
            await _save_snapshot(pool, dev["id"], snap)
            results.append({"device_id": dev["id"], "name": dev["name"],
                            "online": False, "error": kind})
            logger.warning("巡检失败 %s: %s", dev["name"], kind)
            continue
        await _save_snapshot(pool, dev["id"], snap)
        results.append({"device_id": dev["id"], "name": dev["name"], "online": True,
                        "cpu_pct": snap.get("cpu_pct"), "mem_pct": snap.get("mem_pct")})
    online = sum(1 for r in results if r["online"])
    return {"total": len(results), "online": online, "offline": len(results) - online,
            "results": results}


@router.get("/sw/analysis/overview")
async def analysis_overview():
    """总览：每台设备最新快照 + 连续离线防抖计数"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT d.id, d.name, d.mgmt_ip, d.model, d.group_tag, d.enabled,
                          d.last_online_at,
                          (SELECT CONCAT(r.version_no, '|', r.created_at)
                             FROM sw_backup_record r
                            WHERE r.device_id=d.id AND r.status='success'
                            ORDER BY r.version_no DESC LIMIT 1) AS last_backup
                   FROM sw_device d JOIN sw_credential c ON c.id=d.credential_id
                   ORDER BY d.group_tag, d.name""")
            devs = await cur.fetchall()
            await cur.execute(
                """SELECT device_id, online, cpu_pct, mem_pct, temp_max, uptime,
                          alarm_json, collected_at
                   FROM sw_health_snapshot
                   WHERE collected_at >= NOW() - INTERVAL 24 HOUR
                   ORDER BY device_id, collected_at""")
            snaps = await cur.fetchall()

    latest, streak = {}, {}
    for s in snaps:
        did = s["device_id"]
        latest[did] = s
        streak[did] = 0 if s["online"] else streak.get(did, 0) + 1

    out = []
    for d in devs:
        s = latest.get(d["id"])
        if s is None:
            status = "unknown"
        elif s["online"]:
            status = "online"
        elif streak.get(d["id"], 0) >= OFFLINE_DEBOUNCE:
            status = "offline"
        else:
            status = "checking"
        alarms = _json.loads(s["alarm_json"] or "[]") if s else []
        row = {**d, "status": status, "cpu_pct": float(s["cpu_pct"]) if s and s["cpu_pct"] is not None else None,
               "mem_pct": float(s["mem_pct"]) if s and s["mem_pct"] is not None else None,
               "temp_max": float(s["temp_max"]) if s and s["temp_max"] is not None else None,
               "uptime": s["uptime"] if s else "", "alarm_count": len(alarms),
               "collected_at": s["collected_at"] if s else None}
        if d.get("last_backup"):
            v, ts = str(d["last_backup"]).split("|", 1)
            row["last_backup_version"], row["last_backup_at"] = int(v), ts
        else:
            row["last_backup_version"], row["last_backup_at"] = None, None
        row.pop("last_backup", None)
        out.append(row)
    return out


@router.get("/sw/analysis/devices/{device_id}")
async def analysis_detail(device_id: int, hours: int = Query(default=24, le=24 * 7)):
    """单设备详情：最新快照 + 24h 趋势历史"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT d.id, d.name, d.mgmt_ip, d.model, d.group_tag, d.enabled,
                          d.last_online_at, d.last_vrp_ver
                   FROM sw_device d WHERE d.id=%s""", (device_id,))
            dev = await cur.fetchone()
            if not dev:
                raise HTTPException(404, "设备不存在")
            await cur.execute(
                """SELECT online, cpu_pct, mem_pct, temp_max, uptime, alarm_json,
                          interfaces_json, collected_at
                   FROM sw_health_snapshot WHERE device_id=%s
                   ORDER BY collected_at DESC LIMIT 1""", (device_id,))
            snap = await cur.fetchone()
            await cur.execute(
                """SELECT cpu_pct, mem_pct, temp_max, online, collected_at
                   FROM sw_health_snapshot
                   WHERE device_id=%s AND collected_at >= NOW() - INTERVAL %s HOUR
                   ORDER BY collected_at""", (device_id, hours))
            history = await cur.fetchall()
    if snap:
        snap = {**snap,
                "alarms": _json.loads(snap["alarm_json"] or "[]"),
                "interfaces": _json.loads(snap["interfaces_json"] or "[]")}
        snap.pop("alarm_json"), snap.pop("interfaces_json")
    else:
        snap = {"alarms": [], "interfaces": []}
    return {"device": dev, "latest": snap, "history": history}


# ---------- 定时备份任务（v1.1，PRD §3.6） ----------

from core.sw_scheduler import (
    validate_cron, next_fire_time, run_task_once, reload_jobs, _running as _tasks_running,
)


class TaskCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    device_ids: list[int] = Field(..., min_length=1)
    cron_expr: str = Field(..., min_length=9, max_length=64,
                           description="5 段 cron：分 时 日 月 周，如 0 2 * * *")
    retention_count: int = Field(default=30, ge=1, le=1000)
    retention_daily: bool = Field(default=False, description="每日末份永久保留")
    enabled: bool = Field(default=True)
    remark: str | None = Field(default=None, max_length=255)


class TaskUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    device_ids: list[int] | None = Field(default=None, min_length=1)
    cron_expr: str | None = Field(default=None, min_length=9, max_length=64)
    retention_count: int | None = Field(default=None, ge=1, le=1000)
    retention_daily: bool | None = None
    enabled: bool | None = None
    remark: str | None = Field(default=None, max_length=255)


async def _assert_devices(pool, device_ids: list[int]):
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                f"SELECT id FROM sw_device WHERE id IN ({','.join(['%s'] * len(device_ids))})",
                device_ids)
            found = {r[0] for r in await cur.fetchall()}
    missing = [d for d in device_ids if d not in found]
    if missing:
        raise HTTPException(422, f"设备不存在: {missing}")


async def _reload_and(n: int):
    try:
        await reload_jobs()
    except Exception as e:
        logger.warning("任务调度热更新失败: %s", e)


@router.get("/sw/tasks")
async def list_tasks():
    """任务列表（含下次执行时间与设备名）。"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT id, name FROM sw_device ORDER BY name")
            dev_names = {r["id"]: r["name"] for r in await cur.fetchall()}
            await cur.execute("SELECT * FROM sw_backup_task ORDER BY id")
            tasks = await cur.fetchall()
    out = []
    for t in tasks:
        try:
            ids = _json.loads(t["device_scope"])
        except (ValueError, TypeError):
            ids = []
        out.append({
            **t,
            "device_scope": None,
            "device_ids": ids,
            "device_names": [dev_names.get(i, f"#{i}") for i in ids],
            "next_run_at": next_fire_time(t["cron_expr"]).isoformat()
                           if next_fire_time(t["cron_expr"]) else None,
        })
    return out


@router.post("/sw/tasks")
async def create_task(body: TaskCreate):
    validate_cron(body.cron_expr)
    pool = get_pool()
    await _assert_devices(pool, body.device_ids)
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            try:
                await cur.execute(
                    """INSERT INTO sw_backup_task
                       (name, device_scope, cron_expr, retention_count, retention_daily,
                        enabled, remark)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (body.name, _json.dumps(body.device_ids), body.cron_expr,
                     body.retention_count, 1 if body.retention_daily else 0,
                     1 if body.enabled else 0, body.remark))
                tid = cur.lastrowid
            except Exception as e:
                if "uk_name" in str(e):
                    raise HTTPException(409, f"任务名已存在: {body.name}")
                raise HTTPException(500, str(e))
    await _reload_and(tid)
    return {"id": tid}


@router.put("/sw/tasks/{task_id}")
async def update_task(task_id: int, body: TaskUpdate):
    validate_cron(body.cron_expr) if body.cron_expr else None
    pool = get_pool()
    if body.device_ids:
        await _assert_devices(pool, body.device_ids)
    fields, params = [], []
    if body.name is not None:
        fields.append("name=%s"); params.append(body.name)
    if body.device_ids is not None:
        fields.append("device_scope=%s"); params.append(_json.dumps(body.device_ids))
    if body.cron_expr is not None:
        fields.append("cron_expr=%s"); params.append(body.cron_expr)
    if body.retention_count is not None:
        fields.append("retention_count=%s"); params.append(body.retention_count)
    if body.retention_daily is not None:
        fields.append("retention_daily=%s"); params.append(1 if body.retention_daily else 0)
    if body.enabled is not None:
        fields.append("enabled=%s"); params.append(1 if body.enabled else 0)
    if body.remark is not None:
        fields.append("remark=%s"); params.append(body.remark)
    if fields:
        params.append(task_id)
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                try:
                    await cur.execute(
                        f"UPDATE sw_backup_task SET {', '.join(fields)} WHERE id=%s", params)
                except Exception as e:
                    if "uk_name" in str(e):
                        raise HTTPException(409, "任务名已存在")
                    raise HTTPException(500, str(e))
                if cur.rowcount == 0:
                    raise HTTPException(404, "任务不存在")
    await _reload_and(task_id)
    return {"ok": True}


@router.delete("/sw/tasks/{task_id}")
async def delete_task(task_id: int):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT name FROM sw_backup_task WHERE id=%s", (task_id,))
            row = await cur.fetchone()
            if not row:
                raise HTTPException(404, "任务不存在")
            if task_id in _tasks_running:
                raise HTTPException(409, "任务正在执行中，请稍后删除")
            await cur.execute("DELETE FROM sw_backup_task WHERE id=%s", (task_id,))
            # 执行记录保留（审计），任务删除后通过 runs 历史仍可追溯
    await _reload_and(task_id)
    return {"deleted": task_id, "name": row["name"]}


@router.post("/sw/tasks/{task_id}/run")
async def run_task(task_id: int):
    """立即执行一次（等同定时触发，落执行记录；与定时互斥）。"""
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT id, name FROM sw_backup_task WHERE id=%s", (task_id,))
            task = await cur.fetchone()
    if not task:
        raise HTTPException(404, "任务不存在")
    result = await run_task_once(task_id, "manual")
    if result.get("skipped"):
        raise HTTPException(409, result.get("reason", "任务正在执行中"))
    return result


@router.get("/sw/tasks/{task_id}/runs")
async def task_runs(task_id: int, limit: int = Query(default=50, le=200)):
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT id, status, total, ok_count, fail_count, skip_count,
                          detail_json, trigger_type, started_at, finished_at
                   FROM sw_task_run WHERE task_id=%s
                   ORDER BY started_at DESC LIMIT %s""", (task_id, limit))
            rows = await cur.fetchall()
    for r in rows:
        try:
            r["details"] = _json.loads(r["detail_json"] or "[]")
        except (ValueError, TypeError):
            r["details"] = []
        r.pop("detail_json", None)
    return rows
