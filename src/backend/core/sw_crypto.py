"""
交换机凭据加密模块 — AES-256-GCM
- 主密钥来自环境变量 SW_MASTER_KEY（任意长度字符串，内部 SHA-256 派生 32 字节密钥）
- 密文格式: nonce(12B) + ciphertext + tag(16B)，整段 VARBINARY 存储
- PRD: docs/PRD-华为交换机备份.md §3.2
"""
import os
import hashlib

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_NONCE_LEN = 12


class MasterKeyMissing(RuntimeError):
    """服务端未配置 SW_MASTER_KEY"""


def _master_key() -> bytes:
    raw = os.environ.get("SW_MASTER_KEY", "")
    if not raw:
        raise MasterKeyMissing("环境变量 SW_MASTER_KEY 未配置")
    # 任意字符串 -> 稳定 32 字节密钥
    return hashlib.sha256(raw.encode("utf-8")).digest()


def encrypt_password(plain: str) -> bytes:
    """AES-256-GCM 加密，返回 nonce+ct+tag 二进制"""
    key = _master_key()
    nonce = os.urandom(_NONCE_LEN)
    ct = AESGCM(key).encrypt(nonce, plain.encode("utf-8"), None)
    return nonce + ct


def decrypt_password(blob: bytes) -> str:
    """解密 nonce+ct+tag 二进制，返回明文"""
    key = _master_key()
    nonce, ct = blob[:_NONCE_LEN], blob[_NONCE_LEN:]
    return AESGCM(key).decrypt(nonce, ct, None).decode("utf-8")
