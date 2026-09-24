"""
证书颁发核心模块
- CA 加载（一次性，密码从调用方传）
- 客户端证书签发（含 PKCS12 打包）
- 作废（移到 revoked 目录）
- 健康体检

CA 私钥路径固定：/etc/freeradius/3.0/certs/ca.{pem,key}
签发产物路径：/etc/freeradius/3.0/certs/issued/client-<user>-<serial>.{pem,key,p12}
作废归档路径：/etc/freeradius/3.0/certs/revoked/
"""
import os
import re
import hashlib
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, Tuple

from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12, NoEncryption

logger = logging.getLogger(__name__)

CERT_DIR = Path(os.environ.get("RADIUS_CERT_DIR", "/etc/freeradius/3.0/certs"))
ISSUED_DIR = CERT_DIR / "issued"
REVOKED_DIR = CERT_DIR / "revoked"

# 全局 CA 缓存（重启时自动重载；切换 CA 时可手动 reload）
_CA_CACHE = {"cert": None, "key": None, "loaded_at": None, "fingerprint": None}


class CertError(Exception):
    """证书操作错误基类"""


class CANotFound(CertError):
    """CA 不存在或私钥无法读取"""


class CAPassphraseInvalid(CertError):
    """CA 私钥密码错误"""


def _ensure_dirs():
    """确保 issued/ revoked/ 子目录存在"""
    ISSUED_DIR.mkdir(parents=True, exist_ok=True)
    REVOKED_DIR.mkdir(parents=True, exist_ok=True)


def _hex_serial(cert: x509.Certificate) -> str:
    """openssl x509 -serial hex (no :)"""
    return format(cert.serial_number, 'X')


def _cert_dt(cert: x509.Certificate, attr: str) -> datetime:
    """兼容新旧 cryptography：优先 *_utc（新版），否则旧属性（本身 naive）"""
    v = getattr(cert, attr + "_utc", None)
    if v is not None:
        return v.replace(tzinfo=None)
    return getattr(cert, attr)


def _sha256_fingerprint(cert: x509.Certificate) -> str:
    """证书 DER 字节的 SHA-256 指纹（uppercase hex, no :）"""
    return hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest().upper()


def load_ca(passphrase: Optional[str] = None, force: bool = False) -> Tuple[x509.Certificate, Optional[object]]:
    """
    加载 CA 公钥 + 私钥（用密码解锁）。
    返回 (cert, key) — key 可能是 None 当不传 passphrase 时（用于脱敏预览）。
    """
    if not force and _CA_CACHE["cert"] and _CA_CACHE["loaded_at"] and \
       (datetime.now() - _CA_CACHE["loaded_at"]).total_seconds() < 60 \
       and (passphrase is None):
        return _CA_CACHE["cert"], _CA_CACHE["key"]

    ca_pem_path = CERT_DIR / "ca.pem"
    ca_key_path = CERT_DIR / "ca.key"
    if not ca_pem_path.exists():
        raise CANotFound(f"CA 公钥不存在: {ca_pem_path}")
    if not ca_key_path.exists():
        raise CANotFound(f"CA 私钥不存在: {ca_key_path}")

    ca_cert = x509.load_pem_x509_certificate(ca_pem_path.read_bytes())
    ca_key = None
    if passphrase is not None:
        try:
            ca_key = serialization.load_pem_private_key(
                ca_key_path.read_bytes(),
                password=passphrase.encode() if isinstance(passphrase, str) else passphrase,
            )
        except (ValueError, TypeError) as e:
            raise CAPassphraseInvalid("CA 私钥密码错误") from e

    # 缓存公钥到内存（60s 内不重读盘），私钥按需重新加载避免长寿命持密码
    _CA_CACHE["cert"] = ca_cert
    _CA_CACHE["loaded_at"] = datetime.now()
    return ca_cert, ca_key


def ca_meta() -> dict:
    """返回 CA 公开元信息（不含私钥）"""
    cert, _ = load_ca(passphrase=None)
    return {
        "subject": cert.subject.rfc4514_string(),
        "issuer": cert.issuer.rfc4514_string(),
        "not_before": _cert_dt(cert, "not_valid_before").isoformat(timespec="seconds"),
        "not_after": _cert_dt(cert, "not_valid_after").isoformat(timespec="seconds"),
        "fingerprint_sha256": _sha256_fingerprint(cert),
        "key_size": cert.public_key().key_size,
        "serial_hex": _hex_serial(cert),
        "is_self_signed": cert.issuer == cert.subject,
    }


def sign_client(
    cn: str,
    san: Optional[str],
    validity_days: int,
    key_size: int,
    ca_passphrase: str,
    bound_username: Optional[str] = None,
) -> dict:
    """
    签发一张客户端证书。返回：
      - cert_pem, key_pem (str)
      - serial_hex, fingerprint_sha256
      - not_before, not_after (iso str)
      - cert_path, key_path (磁盘路径)
    """
    if validity_days < 1 or validity_days > 3650:
        raise CertError(f"validity_days 必须在 1~3650 之间，收到 {validity_days}")
    if key_size not in (2048, 3072, 4096):
        raise CertError(f"key_size 必须是 2048/3072/4096，收到 {key_size}")
    if not cn or len(cn) > 64:
        raise CertError("CN 必须 1~64 字符")

    _ensure_dirs()
    ca_cert, ca_key = load_ca(passphrase=ca_passphrase)
    if ca_key is None:
        raise CAPassphraseInvalid("必须提供 CA 私钥密码")

    # 1. 生成客户端私钥
    subject_key = rsa.generate_private_key(public_exponent=65537, key_size=key_size)

    # 2. 构造 Subject
    subject_name = [
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "QCC"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "VPN Client"),
        x509.NameAttribute(NameOID.COMMON_NAME, cn),
    ]
    if bound_username:
        subject_name.insert(2, x509.NameAttribute(NameOID.USER_ID, bound_username))

    # 3. SAN 扩展
    san_list = []
    if san:
        import ipaddress as _ip
        for item in re.split(r"[,\s]+", san.strip()):
            if not item:
                continue
            if item.startswith("email:"):
                v = item[6:].strip()
                if not v or "@" not in v:
                    raise ValueError(f"SAN email 格式错误: '{item}'（示例: email:double@qcc.com，留空请删除该项）")
                san_list.append(x509.RFC822Name(v))
            elif item.startswith("ip:"):
                v = item[3:].strip()
                try:
                    san_list.append(x509.IPAddress(_ip.ip_address(v)))
                except ValueError:
                    raise ValueError(f"SAN IP 格式错误: '{item}'（示例: ip:192.168.1.10）")
            elif item.startswith("dns:"):
                v = item[4:].strip()
                if not v:
                    continue
                san_list.append(x509.DNSName(v))
            elif "@" in item:
                san_list.append(x509.RFC822Name(item))
            else:
                # 默认按 DNS
                san_list.append(x509.DNSName(item))

    builder = (
        x509.CertificateBuilder()
        .subject_name(x509.Name(subject_name))
        .issuer_name(ca_cert.subject)
        .public_key(subject_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(minutes=5))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=validity_days))
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None), critical=True
        )
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_encipherment=True,
                content_commitment=False, key_agreement=False,
                key_cert_sign=False, crl_sign=False,
                data_encipherment=False, encipher_only=False, decipher_only=False,
            ), critical=True
        )
        .add_extension(
            x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False
        )
    )
    if san_list:
        builder = builder.add_extension(x509.SubjectAlternativeName(san_list), critical=False)

    # 4. CA 签名
    cert = builder.sign(ca_key, hashes.SHA256())

    # 5. 序列化为 PEM
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    key_pem = subject_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=NoEncryption(),
    ).decode()

    # 6. 写盘
    serial_hex = _hex_serial(cert)
    safe_cn = re.sub(r"[^a-zA-Z0-9._-]", "_", cn)[:40]
    base_name = f"client-{bound_username or 'anon'}-{safe_cn}-{serial_hex[:8]}" if bound_username \
        else f"client-{safe_cn}-{serial_hex[:8]}"
    cert_path = ISSUED_DIR / f"{base_name}.pem"
    key_path = ISSUED_DIR / f"{base_name}.key"
    cert_path.write_text(cert_pem)
    key_path.write_text(key_pem)
    os.chmod(key_path, 0o600)

    fingerprint = _sha256_fingerprint(cert)

    logger.info(f"[Cert Sign] issued CN={cn} serial={serial_hex} fp={fingerprint[:16]}...")

    return {
        "serial_hex": serial_hex,
        "fingerprint_sha256": fingerprint,
        "not_before": _cert_dt(cert, "not_valid_before").isoformat(timespec="seconds"),
        "not_after": _cert_dt(cert, "not_valid_after").isoformat(timespec="seconds"),
        "cert_pem": cert_pem,
        "key_pem": key_pem,
        "cert_path": str(cert_path),
        "key_path": str(key_path),
        "subject": cert.subject.rfc4514_string(),
        "issuer": cert.issuer.rfc4514_string(),
    }


def package_p12(cert_pem: str, key_pem: str, p12_passphrase: str) -> bytes:
    """把 cert + key 打成 PKCS12（同时含 CA 链）。"""
    ca_cert, _ = load_ca(passphrase=None)
    cert = x509.load_pem_x509_certificate(cert_pem.encode())
    key = serialization.load_pem_private_key(key_pem.encode(), password=None)
    return pkcs12.serialize_key_and_certificates(
        name=None,
        key=key,
        cert=cert,
        cas=[ca_cert],
        encryption_algorithm=serialization.BestAvailableEncryption(p12_passphrase.encode()),
    )


def revoke(cert_record: dict, reason: str) -> dict:
    """把磁盘文件移到 revoked/，返回新路径"""
    src_pem = Path(cert_record["cert_pem_path"])
    revoked_pem = REVOKED_DIR / src_pem.name
    src_pem.rename(revoked_pem)
    new_path = {
        "cert_pem_path": str(revoked_pem),
    }
    src_key = Path(cert_record.get("key_pem_path") or "")
    if src_key.exists():
        revoked_key = REVOKED_DIR / src_key.name
        src_key.rename(revoked_key)
        new_path["key_pem_path"] = str(revoked_key)
    src_p12 = Path(cert_record.get("p12_path") or "")
    if src_p12.exists():
        revoked_p12 = REVOKED_DIR / src_p12.name
        src_p12.rename(revoked_p12)
        new_path["p12_path"] = str(revoked_p12)
    return new_path


def health_check() -> dict:
    """体检：CA 公钥 + CA 私钥 + issued/ + 监听端口"""
    import subprocess as sp
    ca_pem = CERT_DIR / "ca.pem"
    ca_key = CERT_DIR / "ca.key"
    status = {
        "ca_cert_exists": ca_pem.exists(),
        "ca_key_exists": ca_key.exists(),
        "issued_dir_exists": ISSUED_DIR.exists(),
        "revoked_dir_exists": REVOKED_DIR.exists(),
        "radius_auth_listening": False,
        "ca_meta": None,
    }
    # 监听端口 1812 探活
    try:
        out = sp.run(["ss", "-uln"], capture_output=True, text=True, timeout=3).stdout
        status["radius_auth_listening"] = ":1812 " in out
    except Exception:
        pass
    if status["ca_cert_exists"]:
        try:
            status["ca_meta"] = ca_meta()
        except Exception as e:
            status["ca_meta_error"] = str(e)
    return status
