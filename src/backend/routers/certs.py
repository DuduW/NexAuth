"""
证书管理 API 路由
- CA 信息 / 下载
- 可绑定用户列表
- 客户端证书签发 / 作废 / 清单 / 详情 / 下载 PEM|P12
- 告警 / 一键体检
"""
import os
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field
from aiomysql import DictCursor

from core.database import get_pool
from core.cert_authority import (
    load_ca, ca_meta, sign_client, package_p12, revoke, health_check,
    CertError, CAPassphraseInvalid, CANotFound,
    ISSUED_DIR, CERT_DIR,
)

router = APIRouter()
logger = logging.getLogger(__name__)

# 全局 asyncio 防并发锁（在 main.py lifespan 中 attach，或用 threading.Lock 简化）
import threading
_sign_lock = threading.Lock()


# ---------- Schemas ----------

class IssueRequest(BaseModel):
    cn: str = Field(..., max_length=64)
    san: str | None = None
    user_id: int | None = None
    bound_username: str | None = None
    validity_days: int = 730
    key_size: int = 2048
    p12_passphrase: str = Field(..., min_length=8, max_length=128)
    ca_passphrase: str = Field(..., min_length=1)


class RevokeRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=255)


# ---------- Helpers ----------

def _status_indicator(not_after_str: str, status: str, now: datetime) -> tuple[str, int]:
    """返回 (emoji+文字, 剩余天数)。状态：valid/revoked/expired"""
    if status == "revoked":
        return "⚪ 已吊销", -1
    if status == "expired":
        return "⚫ 已过期", 0
    na = datetime.fromisoformat(not_after_str)
    delta = (na - now).days
    if delta < 0:
        return "⚫ 已过期", delta
    if delta <= 7:
        return f"🔴 {delta}d", delta
    if delta <= 30:
        return f"🟡 {delta}d", delta
    return f"🟢 {delta}d", delta


# ---------- CA ----------

@router.get("/certs/ca")
async def get_ca_info():
    try:
        meta = ca_meta()
    except Exception as e:
        raise HTTPException(503, f"CA 不可访问: {e}")
    return meta


@router.get("/certs/ca/download")
async def download_ca(fmt: str = Query("pem", pattern="^(pem|der)$")):
    ca_pem = CERT_DIR / "ca.pem"
    if not ca_pem.exists():
        raise HTTPException(404, "CA 证书不存在")
    if fmt == "pem":
        return PlainTextResponse(
            ca_pem.read_bytes(),
            media_type="application/x-pem-file",
            headers={"Content-Disposition": 'attachment; filename="ca.qcc.radius.pem"'},
        )
    # der
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
    cert = x509.load_pem_x509_certificate(ca_pem.read_bytes())
    return Response(
        cert.public_bytes(serialization.Encoding.DER),
        media_type="application/x-x509-ca-cert",
        headers={"Content-Disposition": 'attachment; filename="ca.qcc.radius.cer"'},
    )


# ---------- Users ----------

@router.get("/certs/users")
async def list_bindable_users(q: str | None = None):
    """从 radcheck 取现有用户名单，过滤掉专门用作 MAC 旁路的（username 是 MAC 的）"""
    sql = "SELECT MIN(id) AS id, username FROM radcheck WHERE attribute='Cleartext-Password'"
    params: tuple = ()
    if q:
        sql += " AND username LIKE %s"
        params = (f"%{q}%",)
    sql += " GROUP BY username ORDER BY username LIMIT 500"
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, params)
            rows = await cur.fetchall()
    # 过滤：MAC 形式（>=10 位 hex）跳过
    import re
    return [
        {"id": r["id"], "username": r["username"]}
        for r in rows
        if not re.fullmatch(r"[0-9a-fA-F]{10,}", r["username"])
    ]


# ---------- Issue ----------

@router.post("/certs")
async def issue(req: IssueRequest, download_p12: bool = True):
    with _sign_lock:
        # 1. 校验 CA 私钥
        try:
            load_ca(passphrase=req.ca_passphrase)
        except CAPassphraseInvalid:
            # 注意：不能用 401——前端把 401 视为会话失效会强制登出。
            # CA 口令错误是业务校验失败，用 422。
            raise HTTPException(422, "CA 私钥密码错误，请核对后重试")
        except CANotFound as e:
            raise HTTPException(503, str(e))

        # 2. 签发
        try:
            result = sign_client(
                cn=req.cn,
                san=req.san,
                validity_days=req.validity_days,
                key_size=req.key_size,
                ca_passphrase=req.ca_passphrase,
                bound_username=req.bound_username,
            )
        except CertError as e:
            raise HTTPException(400, str(e))
        except ValueError as e:
            # 参数级错误（如 SAN 格式非法），必须是 4xx 而非 500
            raise HTTPException(422, str(e))

        # 3. 打包 P12（可选）
        p12_bytes = None
        p12_path_str = None
        if download_p12:
            try:
                p12_bytes = package_p12(result["cert_pem"], result["key_pem"], req.p12_passphrase)
                p12_path = Path(result["key_path"]).with_suffix(".p12")
                p12_path.write_bytes(p12_bytes)
                os.chmod(p12_path, 0o600)
                p12_path_str = str(p12_path)
            except Exception as e:
                logger.exception("[Cert] P12 打包失败")
                raise HTTPException(500, f"P12 打包失败: {e}")

        # 4. 写台账
        async with get_pool().acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("""
                    INSERT INTO radius_certs
                    (serial_hex, cn, san, user_id, bound_username, purpose,
                     issuer, subject, not_before, not_after, fingerprint_sha256,
                     key_size, cert_pem_path, key_pem_path, p12_path, issued_by)
                    VALUES (%s,%s,%s,%s,%s,'client',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """, (
                    result["serial_hex"], req.cn, req.san, req.user_id, req.bound_username,
                    result["issuer"], result["subject"], result["not_before"], result["not_after"],
                    result["fingerprint_sha256"], req.key_size,
                    result["cert_path"], result["key_path"], p12_path_str, "admin",
                ))
                new_id = cur.lastrowid

    # 5. 返回
    resp = {
        "id": new_id,
        "serial_hex": result["serial_hex"],
        "fingerprint_sha256": result["fingerprint_sha256"],
        "cn": req.cn,
        "cert_pem": result["cert_pem"],
        "not_before": result["not_before"],
        "not_after": result["not_after"],
        "p12_path": p12_path_str,
    }
    if p12_bytes:
        import base64
        resp["p12_b64"] = base64.b64encode(p12_bytes).decode()
    return resp


# ---------- List / Detail ----------

@router.get("/certs")
async def list_certs(
    user_id: int | None = None,
    status: str | None = Query(None, pattern="^(valid|revoked|expired|all)$"),
):
    sql = """
      SELECT id, serial_hex, cn, san, user_id, bound_username, purpose,
             issuer, subject, not_before, not_after, fingerprint_sha256, key_size,
             status, revoked_at, cert_pem_path, key_pem_path, p12_path,
             issued_by, issued_at, revoke_reason
      FROM radius_certs
    """
    conds = []
    params: list = []
    if user_id is not None:
        conds.append("user_id=%s")
        params.append(user_id)
    if status and status != "all":
        conds.append("status=%s")
        params.append(status)
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    sql += " ORDER BY issued_at DESC LIMIT 1000"

    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, params)
            rows = await cur.fetchall()

    now = datetime.now()
    for r in rows:
        ind, delta = _status_indicator(r["not_after"].isoformat(timespec="seconds"), r["status"], now)
        r["status_indicator"] = ind
        r["days_left"] = delta
        for k in ("not_before", "not_after", "revoked_at", "issued_at"):
            if r.get(k) is not None:
                r[k] = r[k].isoformat(timespec="seconds")
    return rows


@router.get("/certs/alerts")
async def list_alerts(days: int = 30):
    """返回 N 天内到期 + 已过期"""
    sql = """
      SELECT id, cn, bound_username, not_after, status
      FROM radius_certs
      WHERE status='valid'
        AND not_after <= (NOW() + INTERVAL %s DAY)
      ORDER BY not_after ASC LIMIT 100
    """
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(sql, (days,))
            rows = await cur.fetchall()
    for r in rows:
        if r["not_after"]:
            r["not_after"] = r["not_after"].isoformat(timespec="seconds")
    return rows


@router.get("/certs/health")
async def cert_health():
    return health_check()


@router.get("/certs/{cid}")
async def get_cert(cid: int):
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute("SELECT * FROM radius_certs WHERE id=%s", (cid,))
            row = await cur.fetchone()
    if not row:
        raise HTTPException(404, "证书记录不存在")
    if row.get("not_before"): row["not_before"] = row["not_before"].isoformat(timespec="seconds")
    if row.get("not_after"): row["not_after"] = row["not_after"].isoformat(timespec="seconds")
    if row.get("revoked_at"): row["revoked_at"] = row["revoked_at"].isoformat(timespec="seconds")
    if row.get("issued_at"): row["issued_at"] = row["issued_at"].isoformat(timespec="seconds")
    cert_pem_path = Path(row["cert_pem_path"])
    if cert_pem_path.exists():
        row["cert_pem"] = cert_pem_path.read_text()
    return row


# ---------- Download ----------

@router.get("/certs/{cid}/download")
async def download(cid: int, as_: str = Query("pem", alias="as", pattern="^(pem|p12)$")):
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT cert_pem_path, key_pem_path, p12_path, cn, status FROM radius_certs WHERE id=%s",
                (cid,),
            )
            r = await cur.fetchone()
    if not r:
        raise HTTPException(404, "证书不存在")
    if r["status"] != "valid":
        raise HTTPException(410, f"证书已 {r['status']}，不可下载")

    if as_ == "pem":
        p = Path(r["cert_pem_path"])
        if not p.exists():
            raise HTTPException(404, "磁盘文件丢失")
        return PlainTextResponse(
            p.read_bytes(),
            media_type="application/x-pem-file",
            headers={"Content-Disposition": f'attachment; filename="{p.name}"'},
        )
    # p12
    p = Path(r.get("p12_path") or "")
    if not p.exists():
        raise HTTPException(404, "P12 包不存在（该证书签发时未生成 P12）")
    return Response(
        p.read_bytes(),
        media_type="application/x-pkcs12",
        headers={"Content-Disposition": f'attachment; filename="{p.name}"'},
    )


# ---------- Revoke ----------

@router.post("/certs/{cid}/revoke")
async def revoke_cert(cid: int, req: RevokeRequest):
    async with get_pool().acquire() as conn:
        async with conn.cursor(DictCursor) as cur:
            await cur.execute(
                "SELECT id, status, cert_pem_path, key_pem_path, p12_path FROM radius_certs WHERE id=%s",
                (cid,),
            )
            row = await cur.fetchone()
            if not row:
                raise HTTPException(404, "证书不存在")
            if row["status"] != "valid":
                raise HTTPException(409, f"证书当前状态为 {row['status']}，不可作废")
            try:
                new_paths = revoke(row, req.reason)
            except Exception as e:
                raise HTTPException(500, f"作废失败: {e}")
            await cur.execute("""
                UPDATE radius_certs SET status='revoked', revoked_at=NOW(), revoke_reason=%s,
                                        cert_pem_path=%s, key_pem_path=%s, p12_path=%s
                WHERE id=%s
            """, (req.reason,
                  new_paths.get("cert_pem_path", row["cert_pem_path"]),
                  new_paths.get("key_pem_path", row["key_pem_path"]),
                  new_paths.get("p12_path", row["p12_path"]),
                  cid))
    return {"ok": True, "id": cid, "new_paths": new_paths}
