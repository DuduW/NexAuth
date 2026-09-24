"""
VPN 会话服务端主动采集器（v1.1）
============================================================
背景：vpn_access_log / vpn_traffic_log 原本完全依赖 NetAgent 客户端
主动上报（/vpn/connect-node + /vpn/traffic-report）。WireGuard 官方客户端
（conf 导入）是纯协议实现，只做 UDP 握手、不回调任何业务 API → 零日志。

方案：服务端定时扫 `wg show <if> dump`，把握手状态与 transfer 计数
翻译成业务日志：
  1. handshake 从无到有（首次出现/离线后重新握手）→ 写 access_log(connect)
  2. transfer(rx/tx) 差值 → 按 peer 公钥经 vpn_peers 映射用户 → 累加 traffic_log
  3. 超过 OFFLINE_SEC 无握手且会话未关闭 → 补写 session_end + access_log(disconnect)
  4. peer 从 wg 被移除（撤销授权）→ 补写 session_end + access_log(disconnect)

v1.1 变更（修复 2 个日志缺失缺陷）：
  - 首轮基线不再"静默吞掉"connect：已在线的 peer 先查 access_log 近
    BASELINE_DEDUP_WIN 秒内是否已有该用户记录，没有则补写 connect
    （服务重启/升级不再造成日志断档，也不会重复写）。
  - peer 从 wg 移除且此前在线 → 除关会话外补写 disconnect 日志
    （v1.0 只关会话不写日志，撤销授权场景日志断档）。

设计要点：
  - 多接口支持：wg0 + 节点侧 wg-*（VPN_NODES 配置），每接口独立状态
  - 增量采集：内存 dict 记录上次快照 {pubkey: (handshake, rx, tx)}，
    服务重启后首轮只建基线不写日志（防重复 connect）
  - 与 NetAgent 上报共存：traffic_log 同一用户允许多条 open 会话（采集器
    只管理自己标记 source='probe' 的会话，不碰客户端的会话行）
  - 单调计数处理：wg 计数器在 peer 重建时会归零，差值 <0 时跳过本轮
"""
import asyncio
import logging
import time
from datetime import datetime

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from aiomysql import DictCursor

from core.database import get_pool

logger = logging.getLogger(__name__)

# ── 配置 ──
SCAN_INTERVAL_SEC = 30          # 采集周期
OFFLINE_SEC = 180               # 3 分钟无握手视为离线（keepalive 25s，留足余量）
STALE_SESSION_MIN = 10          # 无 transfer 变化持续 N 分钟的 open 会话强制核对
BASELINE_DEDUP_WIN = 300        # 首轮基线补写 connect 前的查库去重窗口（秒）
# 采集的 WireGuard 接口：主服务 wg0 + 各节点机的 wg-* 接口
#   interface = 本机 wg 接口名；ssh_host 为空表示本机
VPN_NODES = [
    {"name": "main",  "interface": "wg0", "ssh_host": None},
    {"name": "node1", "interface": "wg-1", "ssh_host": "10.99.0.2"},
]

scheduler = AsyncIOScheduler()
JOB_ID = "vpn-session-probe"

# 内存状态：{node_name: {pubkey: {"handshake": ts, "rx": n, "tx": n,
#                                 "online": bool, "traffic_id": int|None}}}
_state: dict[str, dict] = {}


# ---------- wg 采集 ----------

async def _wg_dump_local(interface: str) -> str | None:
    """本机执行 wg show dump，失败（接口不存在）返回 None。"""
    proc = await asyncio.create_subprocess_exec(
        "wg", "show", interface, "dump",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    if proc.returncode != 0:
        logger.debug("wg show %s failed: %s", interface, err.decode().strip())
        return None
    return out.decode()


async def _wg_dump_ssh(ssh_host: str, interface: str) -> str | None:
    """节点机经 SSH 执行 wg show dump（复用 root 密钥；节点未配置则跳过）。"""
    proc = await asyncio.create_subprocess_exec(
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
        f"root@{ssh_host}", f"wg show {interface} dump",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await proc.communicate()
    if proc.returncode != 0:
        logger.debug("wg show via ssh %s %s failed: %s", ssh_host, interface, err.decode().strip())
        return None
    return out.decode()


def _parse_dump(text: str) -> dict[str, dict]:
    """解析 wg dump 的 peer 行（跳过首行接口行）。
    接口行: server-pubkey\tserver-privkey\tlisten-port\tfwmark（4 列）
    peer 行: pubkey\tpsk\tendpoint\tallowed-ips\thandshake\trx\ttx\tkeepalive（8 列）
    """
    peers = {}
    for i, line in enumerate(text.strip().splitlines()):
        if i == 0:
            continue  # 接口行
        f = line.split("\t")
        if len(f) < 8:
            continue
        try:
            peers[f[0]] = {
                "handshake": int(f[4]),       # 0 = 从未握手
                "rx": int(f[5]),
                "tx": int(f[6]),
            }
        except ValueError:
            continue
    return peers


# ---------- DB 写入 ----------

async def _map_users(pool, pubkeys: list[str]) -> dict[str, str]:
    """公钥 → 用户名映射（vpn_peers）。"""
    if not pubkeys:
        return {}
    ph = ",".join(["%s"] * len(pubkeys))
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                f"SELECT public_key, username FROM vpn_peers WHERE public_key IN ({ph})",
                pubkeys)
            return {r["public_key"]: r["username"] for r in await cur.fetchall()}


async def _write_connect(pool, username: str, ip: str, node: str):
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO vpn_access_log (username, action, ip, detail) VALUES (%s,%s,%s,%s)",
                (username, "connect", ip, f"source=probe node={node} client=wireguard"),
            )


async def _recent_access_exists(pool, username: str) -> bool:
    """近 BASELINE_DEDUP_WIN 秒内该用户是否已有 access_log 记录（基线补写去重）。"""
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT id FROM vpn_access_log WHERE username=%s "
                "AND created_at >= NOW() - INTERVAL %s SECOND LIMIT 1",
                (username, BASELINE_DEDUP_WIN))
            return await cur.fetchone() is not None


async def _write_disconnect(pool, username: str, ip: str, node: str, dur: int):
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO vpn_access_log (username, action, ip, detail) VALUES (%s,%s,%s,%s)",
                (username, "disconnect", ip, f"source=probe node={node} duration={dur}s"),
            )


async def _open_session(pool, username: str, ip: str) -> int | None:
    """为采集器会话新开一行 traffic_log（detail 语义复用，客户端行不受影响）。"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "INSERT INTO vpn_traffic_log (username, up_bytes, down_bytes, duration_sec, "
                "session_start, session_end) VALUES (%s,0,0,0,%s,NULL)",
                (username, now))
            return cur.lastrowid


async def _add_traffic(pool, row_id: int, up: int, down: int, dur: int):
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE vpn_traffic_log SET up_bytes=up_bytes+%s, down_bytes=down_bytes+%s, "
                "duration_sec=duration_sec+%s WHERE id=%s",
                (up, down, dur, row_id))


async def _close_session(pool, row_id: int):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    async with pool.acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "UPDATE vpn_traffic_log SET session_end=%s WHERE id=%s AND session_end IS NULL",
                (now, row_id))


async def _peer_ip(pool, pubkey: str) -> str:
    async with pool.acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT address FROM vpn_peers WHERE public_key=%s", (pubkey,))
            row = await cur.fetchone()
            return row["address"] if row else ""


# ---------- 主循环 ----------

async def probe_once():
    """单轮采集：所有节点 → diff → 写库。"""
    pool = get_pool()
    now = int(time.time())

    for node in VPN_NODES:
        name = node["name"]
        if node["ssh_host"]:
            dump = await _wg_dump_ssh(node["ssh_host"], node["interface"])
        else:
            dump = await _wg_dump_local(node["interface"])
        if dump is None:
            continue  # 接口/节点不可用，保留旧状态

        peers = _parse_dump(dump)
        prev = _state.setdefault(name, {})

        # 公钥 → 用户（含已从 wg 移除但仍在内存状态的 peer，供清理分支写 disconnect）
        need_map = list(peers.keys()) + [pk for pk in prev if pk not in peers]
        users = await _map_users(pool, need_map)

        for pk, cur in peers.items():
            st = prev.get(pk)
            hs = cur["handshake"]
            alive = hs > 0 and (now - hs) < OFFLINE_SEC

            if st is None:
                # 新 peer 基线（服务重启首轮 或 运行期新增授权）：
                # 已在线的开会话行；近 N 秒无 access_log 记录才补写 connect
                # （v1.1：修复重启后已在线会话无 connect 日志 + 新 peer 触发 None 崩溃）
                if alive and pk in users:
                    ip = await _peer_ip(pool, pk)
                    if not await _recent_access_exists(pool, users[pk]):
                        await _write_connect(pool, users[pk], ip, name)
                        logger.info("[probe] baseline connect for %s via %s", users[pk], name)
                    tid = await _open_session(pool, users[pk], ip)
                    prev[pk] = {"handshake": hs, "rx": cur["rx"], "tx": cur["tx"],
                                "online": True, "traffic_id": tid}
                else:
                    prev[pk] = {"handshake": hs, "rx": cur["rx"], "tx": cur["tx"],
                                "online": False, "traffic_id": None}
                continue

            d_rx = cur["rx"] - st["rx"]
            d_tx = cur["tx"] - st["tx"]
            # wg 计数器归零（peer 重建）时差值为负：跳过本轮流量，状态照常推进
            bad_counter = d_rx < 0 or d_tx < 0

            # ── 上线沿：offline→online ──
            if alive and not st["online"]:
                if pk in users:
                    ip = await _peer_ip(pool, pk)
                    await _write_connect(pool, users[pk], ip, name)
                    tid = await _open_session(pool, users[pk], ip)
                    st["traffic_id"] = tid
                st["online"] = True
                logger.info("[probe] %s connect via %s", users.get(pk, pk[:12]), name)

            # ── 流量累加（在线期间）──
            if alive and not bad_counter and st.get("traffic_id") and (d_rx or d_tx):
                await _add_traffic(pool, st["traffic_id"], d_tx, d_rx, SCAN_INTERVAL_SEC)

            # ── 下线沿：online→offline ──
            if not alive and st["online"]:
                if st.get("traffic_id"):
                    await _close_session(pool, st["traffic_id"])
                if pk in users:
                    ip = await _peer_ip(pool, pk)
                    dur = now - st["handshake"] if st["handshake"] else 0
                    await _write_disconnect(pool, users[pk], ip, name, dur)
                st["online"] = False
                st["traffic_id"] = None
                logger.info("[probe] %s disconnect from %s", users.get(pk, pk[:12]), name)

            st["handshake"] = hs
            st["rx"] = cur["rx"]
            st["tx"] = cur["tx"]

        # 清理已从 wg 移除的 peer 状态（撤销授权场景）：关会话 + 补写 disconnect
        # （v1.1：修复 peer 被移除时只关会话不写 access_log 的日志断档）
        for pk in list(prev.keys()):
            if pk not in peers and prev[pk]["online"]:
                if prev[pk].get("traffic_id"):
                    await _close_session(pool, prev[pk]["traffic_id"])
                if pk in users:
                    ip = await _peer_ip(pool, pk)
                    dur = now - prev[pk]["handshake"] if prev[pk]["handshake"] else 0
                    await _write_disconnect(pool, users[pk], ip, name, dur)
                    logger.info("[probe] %s removed from %s (disconnect logged)",
                                users.get(pk, pk[:12]), name)
                prev[pk]["online"] = False
                prev[pk]["traffic_id"] = None


def start_probe():
    if scheduler.get_job(JOB_ID):
        return
    scheduler.add_job(probe_once, "interval", seconds=SCAN_INTERVAL_SEC,
                      id=JOB_ID, max_instances=1, coalesce=True,
                      next_run_time=datetime.now())
    scheduler.start()
    logger.info("[probe] vpn session probe started (interval=%ss)", SCAN_INTERVAL_SEC)


def shutdown_probe():
    if scheduler.running:
        scheduler.shutdown(wait=False)
    logger.info("[probe] vpn session probe stopped")
