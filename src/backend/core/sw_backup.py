"""
交换机备份引擎
- 抓取运行配置 → 落盘 → 版本自增 → 与上一成功版本 diff → 入库
- 结构：异步路由负责 DB（aiomysql 连接绑定主事件循环），SSH 阻塞段用 to_thread 隔离
- PRD: docs/PRD-华为交换机备份.md §3.3
"""
import asyncio
import logging
from pathlib import Path
from datetime import datetime

from aiomysql import DictCursor

from core.sw_ssh import (
    SwSession, SwSSHError, diff_counts,
    parse_version, parse_cpu, parse_memory,
    parse_interfaces, parse_environment, parse_alarms,
    collect_health_blocking,          # v2.0 巡检采集（实现于 sw_ssh，纯 SSH 无 DB）
)

logger = logging.getLogger(__name__)

# 配置文件根目录（与 certs 同风格：后端数据目录下）
SW_BACKUP_DIR = Path("/opt/radius-admin/sw-backups")


def backup_file_path(device_name: str, version_no: int, ts: datetime) -> Path:
    return SW_BACKUP_DIR / device_name / f"v{version_no}_{ts.strftime('%Y%m%d-%H%M%S')}.cfg"


# ---------- 第 1 段：占版本号（异步，事件循环内） ----------

async def alloc_version(pool, device_id: int, trigger_type: str, operator: str):
    """取 max+1 版本号并插入 failed/running 占位行，返回 (version_no, record_id)"""
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT COALESCE(MAX(version_no),0)+1 AS next_v FROM sw_backup_record WHERE device_id=%s",
                (device_id,))
            v = (await cur.fetchone())["next_v"]
            await cur.execute(
                """INSERT INTO sw_backup_record
                   (device_id, version_no, trigger_type, operator, status, fail_reason, file_path, created_at)
                   VALUES (%s,%s,%s,%s,'failed','running','',NOW())""",
                (device_id, v, trigger_type, operator))
            rid = cur.lastrowid
    return v, rid


# ---------- 第 2 段：SSH 抓取（阻塞，to_thread 中执行，不碰 DB） ----------

def fetch_config_blocking(dev: dict) -> dict:
    """SSH 登录抓运行配置与版本信息。dev 需含 name/mgmt_ip/ssh_port/username/password(明文)。"""
    with SwSession(dev["mgmt_ip"], dev["ssh_port"], dev["username"], dev["password"],
                   model=dev.get("model", "")) as s:
        config_text = s.get_running_config()
        ver_info = s.get_version()
        ver_info["hostname"] = s.hostname
    return {"config": config_text, **ver_info}


def test_connection_blocking(dev: dict) -> dict:
    """连接测试（阻塞）。dev 需含 mgmt_ip/ssh_port/username/password(明文)。"""
    with SwSession(dev["mgmt_ip"], dev["ssh_port"], dev["username"], dev["password"],
                   model=dev.get("model", "")) as s:
        ver = s.get_version()
        ver["hostname"] = s.hostname
    return ver


# ---------- 第 3 段：落盘 + 落库（异步，事件循环内） ----------

def _diff_against_prev(prev_path: str | None, new_text: str):
    if not prev_path or not Path(prev_path).exists():
        return None, None
    old_text = Path(prev_path).read_text(encoding="utf-8", errors="replace")
    return diff_counts(old_text, new_text)


async def finalize_success(pool, device_id: int, record_id: int, version_no: int,
                           config_text: str, ver_info: dict, ts: datetime) -> dict:
    path = backup_file_path(ver_info.get("device_name", f"dev{device_id}"), version_no, ts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(config_text, encoding="utf-8")

    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT file_path FROM sw_backup_record
                   WHERE device_id=%s AND status='success' AND version_no<%s
                   ORDER BY version_no DESC LIMIT 1""", (device_id, version_no))
            prev = await cur.fetchone()
            added, removed = _diff_against_prev(prev["file_path"] if prev else None, config_text)
            await cur.execute(
                """UPDATE sw_backup_record
                   SET status='success', fail_reason=NULL, file_path=%s,
                       size_bytes=%s, line_count=%s, diff_added=%s, diff_removed=%s
                   WHERE id=%s""",
                (str(path), path.stat().st_size, config_text.count("\n") + 1,
                 added, removed, record_id))
            await cur.execute(
                "UPDATE sw_device SET last_online_at=NOW(), last_vrp_ver=%s WHERE id=%s",
                (ver_info.get("vrp"), device_id))
    return {"id": record_id, "version_no": version_no, "status": "success",
            "diff_added": added, "diff_removed": removed,
            "size_bytes": path.stat().st_size,
            "line_count": config_text.count("\n") + 1,
            "vrp": ver_info.get("vrp"), "file_path": str(path)}


async def finalize_failed(pool, record_id: int, reason: str):
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE sw_backup_record SET status='failed', fail_reason=%s WHERE id=%s",
                (reason[:250], record_id))


async def run_backup(pool, device_row: dict, trigger_type: str, operator: str) -> dict:
    """
    备份编排（在事件循环内调用）：
    占版本号 → to_thread SSH 抓取 → 落盘落库；SSH 失败则标记 failed 并抛出。
    device_row: 含 id/name/mgmt_ip/ssh_port/model/username/password_enc
    """
    from core.sw_crypto import decrypt_password

    dev = dict(device_row)
    dev["password"] = decrypt_password(bytes(dev["password_enc"]))
    ts = datetime.now()
    version_no, record_id = await alloc_version(pool, dev["id"], trigger_type, operator)
    dev_info = {"device_name": dev["name"]}

    try:
        result = await asyncio.to_thread(fetch_config_blocking, dev)
    except SwSSHError as e:
        reason = f"{e.args[0] if e.args else 'session'}: {e.args[1] if len(e.args) > 1 else e}"
        await finalize_failed(pool, record_id, reason)
        raise
    result.update(dev_info)
    return await finalize_success(pool, dev["id"], record_id, version_no,
                                  result["config"], result, ts)
