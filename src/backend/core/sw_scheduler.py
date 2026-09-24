"""
定时备份调度器（v1.1）— PRD: docs/PRD-华为交换机备份.md §3.6
- APScheduler AsyncIOScheduler 与 radius-admin 同进程：任务 CRUD 后 reload_jobs() 热更新，无需重启
- 任务内设备串行 + 1s 间隔，防 SSH 并发风暴（对齐 analysis/run 惯例）
- 保留策略：每设备保留最近 N 份成功版本 + 可选每日末份永久保留（清理时文件与记录同删）
- 防冲突：同一任务同时在跑（手动撞定时）自动跳过；单台失败不中断任务
"""
import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from aiomysql import DictCursor

from core.database import get_pool
from core.sw_backup import run_backup
from core.sw_ssh import SwSSHError

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()
JOB_PREFIX = "sw-task-"
_running: set[int] = set()          # 正在执行中的 task_id（手动/定时互斥）


# ---------- cron 工具 ----------

def validate_cron(expr: str) -> None:
    """5 段标准 cron（分 时 日 月 周）。非法抛 ValueError。"""
    CronTrigger.from_crontab(expr)


def next_fire_time(expr: str):
    """下次执行时间（本地时区 datetime）；非法表达式返回 None。"""
    try:
        trigger = CronTrigger.from_crontab(expr)
        return trigger.get_next_fire_time(None, datetime.now(trigger.timezone))
    except (ValueError, TypeError):
        return None


# ---------- 设备加载 ----------

async def _load_device(pool, device_id: int) -> dict | None:
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT d.id, d.name, d.mgmt_ip, d.ssh_port, d.model, d.enabled,
                          c.username, c.password_enc
                   FROM sw_device d JOIN sw_credential c ON c.id=d.credential_id
                   WHERE d.id=%s""", (device_id,))
            return await cur.fetchone()


# ---------- 保留策略 ----------

def protected_ids(rows: list[dict], keep_count: int, keep_daily: int) -> set[int]:
    """
    计算应保留的备份记录 id 集合（纯函数，便于单测）。
    rows: 按 version_no 降序的成功记录（含 id/day 字段）。
    protected = 最近 keep_count 份 ∪（keep_daily 启用时每天 version_no 最大的那份）
    """
    protected: set[int] = set()
    for r in rows[:max(0, keep_count)]:
        protected.add(r["id"])
    if keep_daily:
        seen: set = set()
        for r in rows:                       # version_no 降序 → 每天第一条即当天最大
            if r["day"] not in seen:
                seen.add(r["day"])
                protected.add(r["id"])
    return protected


async def apply_retention(pool, device_id: int, keep_count: int, keep_daily: int) -> int:
    """
    清理超出保留策略的成功备份（文件 + 记录同删）。
    protected = 最近 keep_count 份 ∪（keep_daily 启用时每天 version_no 最大的那份）
    返回清理数量。
    """
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                """SELECT id, version_no, file_path, DATE(created_at) AS day
                   FROM sw_backup_record
                   WHERE device_id=%s AND status='success'
                   ORDER BY version_no DESC""", (device_id,))
            rows = await cur.fetchall()

    protected = protected_ids(rows, keep_count, keep_daily)
    victims = [r for r in rows if r["id"] not in protected]
    if not victims:
        return 0
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            for r in victims:
                try:
                    p = Path(r["file_path"])
                    if p.exists():
                        p.unlink()
                except OSError as e:
                    logger.warning("保留清理：文件删除失败 id=%s: %s", r["id"], e)
                await cur.execute("DELETE FROM sw_backup_record WHERE id=%s", (r["id"],))
    return len(victims)


# ---------- 任务执行 ----------

async def run_task_once(task_id: int, trigger_type: str = "scheduled") -> dict:
    """执行一次任务：串行逐台备份 → 保留清理 → 落执行记录。"""
    if task_id in _running:
        return {"skipped": True, "reason": "任务正在执行中（防手动/定时撞车）"}
    _running.add(task_id)
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            async with conn.cursor(DictCursor) as cur:
                await cur.execute("SELECT * FROM sw_backup_task WHERE id=%s", (task_id,))
                task = await cur.fetchone()
        if not task:
            return {"skipped": True, "reason": "任务不存在"}
        if trigger_type == "scheduled" and not task["enabled"]:
            return {"skipped": True, "reason": "任务已停用"}

        try:
            device_ids = json.loads(task["device_scope"])
        except (ValueError, TypeError):
            device_ids = []
        if not device_ids:
            return {"skipped": True, "reason": "任务未配置设备"}

        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    "INSERT INTO sw_task_run (task_id, status, total, trigger_type, started_at)"
                    " VALUES (%s,'running',%s,%s,NOW())",
                    (task_id, len(device_ids), trigger_type))
                run_id = cur.lastrowid

        from core.sw_crypto import MasterKeyMissing
        ok = fail = skip = 0
        details = []
        for i, did in enumerate(device_ids):
            if i:
                await asyncio.sleep(1)        # 设备间隔 1s
            dev = await _load_device(pool, did)
            if dev is None:
                skip += 1
                details.append({"device_id": did, "name": f"#{did}", "status": "skipped",
                                "error": "设备不存在"})
                continue
            if not dev["enabled"]:
                skip += 1
                details.append({"device_id": did, "name": dev["name"], "status": "skipped",
                                "error": "设备已停用"})
                continue
            try:
                res = await run_backup(pool, dev, "scheduled", f"task:{task['name']}")
                ok += 1
                details.append({"device_id": did, "name": dev["name"], "status": "success",
                                "version_no": res["version_no"]})
                try:
                    n = await apply_retention(pool, did, task["retention_count"],
                                              task["retention_daily"])
                    if n:
                        logger.info("任务[%s] 设备 %s 保留清理 %s 份", task["name"], dev["name"], n)
                except Exception as e:        # 保留清理失败不影响任务结果
                    logger.warning("保留清理异常 device=%s: %s", did, e)
            except SwSSHError as e:
                fail += 1
                msg = e.args[1] if len(e.args) > 1 else str(e)
                details.append({"device_id": did, "name": dev["name"], "status": "failed",
                                "error": str(msg)[:200]})
            except MasterKeyMissing as e:
                raise                          # 主密钥缺失属全局故障，直接中断
            except Exception as e:
                fail += 1
                details.append({"device_id": did, "name": dev["name"], "status": "failed",
                                "error": str(e)[:200]})

        status = "success" if fail == 0 else ("failed" if ok == 0 else "partial")
        summary = f"ok={ok} fail={fail} skip={skip}"
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """UPDATE sw_task_run
                       SET status=%s, ok_count=%s, fail_count=%s, skip_count=%s,
                           detail_json=%s, finished_at=NOW()
                       WHERE id=%s""",
                    (status, ok, fail, skip,
                     json.dumps(details, ensure_ascii=False), run_id))
                await cur.execute(
                    """UPDATE sw_backup_task
                       SET last_run_at=NOW(), last_run_status=%s, last_run_detail=%s
                       WHERE id=%s""",
                    (status, summary[:250], task_id))
        logger.info("任务[%s] %s：%s", task["name"], trigger_type, summary)
        return {"skipped": False, "run_id": run_id, "status": status,
                "total": len(device_ids), "ok": ok, "fail": fail, "skip": skip,
                "details": details}
    finally:
        _running.discard(task_id)


# ---------- 任务装载 / 热更新 ----------

async def reload_jobs() -> int:
    """按 DB 当前任务全量重建调度（CRUD 后调用）。返回装载的任务数。"""
    for job in list(scheduler.get_jobs()):
        if job.id.startswith(JOB_PREFIX):
            job.remove()
    pool = get_pool()
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT id, name, cron_expr FROM sw_backup_task WHERE enabled=1")
            tasks = await cur.fetchall()
    n = 0
    for t in tasks:
        try:
            trigger = CronTrigger.from_crontab(t["cron_expr"])
        except (ValueError, TypeError) as e:
            logger.warning("任务[%s] cron 非法(%s)，跳过装载: %s", t["name"], t["cron_expr"], e)
            continue
        scheduler.add_job(
            run_task_once, trigger, args=[t["id"], "scheduled"],
            id=f"{JOB_PREFIX}{t['id']}", name=t["name"],
            coalesce=True, max_instances=1, misfire_grace_time=60,
            replace_existing=True)
        n += 1
    logger.info("定时备份调度装载 %s 个任务", n)
    return n


def start_scheduler() -> None:
    """lifespan 启动时调用；任务装载异步进行（DB pool 已就绪）。"""
    if not scheduler.running:
        scheduler.start()
        asyncio.ensure_future(reload_jobs())


def shutdown_scheduler() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)
