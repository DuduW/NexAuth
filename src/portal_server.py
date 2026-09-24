#!/usr/bin/env python3
"""
华为 Portal 协议 v2 完整实现
部署在 FreeRADIUS 服务器上，配合华为 AC 实现 Portal 认证

标准华为 Portal 流程（HTTP 重定向模式）：
  1. 终端设备连接 WiFi
  2. AC 检查终端状态（MAC 预认证可在此发生）
  3. 未认证 -> AC HTTP 重定向到 Portal 登录页
  4. 用户浏览器 GET Portal 登录页 -> 自动创建认证会话
  5. 用户输入账号密码，POST 提交到 Portal Server
  6. Portal Server -> AC(192.168.30.15:2000): REQ_AUTH(UDP)
     把凭证通过 Portal 协议转发给 AC
  7. AC -> FreeRADIUS: RADIUS Access-Request    AC 自己做 RADIUS
  8. AC ← FreeRADIUS: Access-Accept/Reject
  9. AC -> Portal(50100): ACK_AUTH(UDP)          通知认证结果
 10. Portal -> AC: AFF_ACK_AUTH(UDP)             确认收到
 11. Portal 页面显示认证成功/失败
 12. 设备获取网络权限

关键设计：
  - Portal Server 纯做"中介"--不碰 RADIUS，只转发凭证给 AC
  - AC 自己做 RADIUS 认证，自己下发 VLAN/ACL/限速策略
  - Portal Server 同时监听 50100/UDP (Portal 协议) + 8080/TCP (Web 页)
  - 兼容两种模式：AC 发 REQ_CHALLENGE 时走完整握手；AC 仅 HTTP 重定向时自动建会话
"""

import hashlib
import hmac
import json
import os
import socket
import struct
import threading
import time
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

# ═══════════════════════════════════════════════════════════
#  配置
# ═══════════════════════════════════════════════════════════
PORTAL_LISTEN_IP = "0.0.0.0"
PORTAL_PORT = 50100          # UDP: Portal 协议端口
WEB_PORT = 8080              # HTTP: Web 登录页端口
SHARED_SECRET = b"Huawei@Radius123"

# FreeRADIUS 对接
RADIUS_SERVER = "127.0.0.1"
RADIUS_PORT = 1812
RADIUS_SECRET = b"testing123"

# 华为 AC 地址
AC_IP = "192.168.30.15"

# ── 免认证 Token（记住设备 6 个月） ──
TOKEN_SECRET = b"R@diusPortalToken2026!"
TOKEN_DAYS = 180

def generate_token(username: str) -> str:
    """生成免认证 token: base64(hmac | username | expiry)"""
    expiry = str(int(time.time()) + TOKEN_DAYS * 86400)
    payload = username.encode() + b"|" + expiry.encode()
    sig = hmac.new(TOKEN_SECRET, payload, "sha256").hexdigest()
    return base64.b64encode((sig + "|" + username + "|" + expiry).encode()).decode()

def verify_token(token: str):
    """验证 token，成功返回 username，失败返回 None"""
    try:
        decoded = base64.b64decode(token).decode()
        parts = decoded.split("|", 2)
        if len(parts) != 3:
            return None
        sig, username, expiry = parts
        if int(expiry) < int(time.time()):
            return None
        expected = hmac.new(TOKEN_SECRET, username.encode() + b"|" + expiry.encode(), "sha256").hexdigest()
        if not hmac.compare_digest(sig, expected):
            return None
        return username
    except Exception:
        return None

# ═══════════════════════════════════════════════════════════
#  华为 Portal 协议常量
# ═══════════════════════════════════════════════════════════
PORTAL_VERSION = 2

# 消息类型
REQ_CHALLENGE  = 0x01
ACK_CHALLENGE  = 0x02
REQ_AUTH       = 0x03
ACK_AUTH       = 0x04
REQ_LOGOUT     = 0x05
ACK_LOGOUT     = 0x06
AFF_ACK_AUTH   = 0x07
NTY_LOGOUT     = 0x08
REQ_INFO       = 0x09
ACK_INFO       = 0x0a
NTY_USERDISCOVER = 0x0b
ACK_NTF_LOGOUT = 0x0c

# 认证类型
AUTH_PAP  = 0x01
AUTH_CHAP = 0x02

# 属性类型
ATTR_USERNAME   = 0x01
ATTR_PASSWORD   = 0x02
ATTR_CHALLENGE  = 0x03
ATTR_CHAPPASS   = 0x04
ATTR_PORTALURL  = 0x0a

# 错误码
ERR_SUCCESS       = 0
ERR_REJECT        = 1
ERR_ALREADY_ONLINE = 2
ERR_BUSY          = 3
ERR_DISCONNECT    = 4

# ACK_AUTH 结果码
AUTH_ACCEPT = 0x01
AUTH_REJECT = 0x00

# Portal 协议服务端 IP
PORTAL_SERVER_IP = "192.168.110.106"
PORTAL_SERVER_URL = f"http://{PORTAL_SERVER_IP}:{WEB_PORT}/"

# 自动创建会话用的序列号计数器
_next_serial = 1000
_next_req_id = 100
def next_serial():
    global _next_serial
    _next_serial += 1
    return _next_serial
def next_req_id():
    global _next_req_id
    _next_req_id += 1
    return _next_req_id


class PortalSession:
    """存储一次 Portal 认证会话"""
    def __init__(self, user_ip, serial_no, req_id, challenge, nas_ip):
        self.user_ip = user_ip
        self.serial_no = serial_no
        self.req_id = req_id
        self.challenge = challenge
        self.nas_ip = nas_ip
        self.timestamp = time.time()

# 全局会话存储 (key: user_ip string)
sessions: dict[str, PortalSession] = {}
# 待认证队列 (key: user_ip, value: {"username", "password"})
pending_auth: dict[str, dict] = {}

def cleanup_sessions():
    """清理超过 5 分钟的会话"""
    now = time.time()
    expired = [k for k, v in sessions.items() if now - v.timestamp > 300]
    for k in expired:
        del sessions[k]
    expired_p = [k for k, v in pending_auth.items() if now - v.get('timestamp', 0) > 300]
    for k in expired_p:
        del pending_auth[k]


# ═══════════════════════════════════════════════════════════
#  Portal 协议封装
# ═══════════════════════════════════════════════════════════

def ip_to_int(ip_str: str) -> int:
    return struct.unpack("!I", socket.inet_aton(ip_str))[0]

def int_to_ip(n: int) -> str:
    return socket.inet_ntoa(struct.pack("!I", n))

def md5(data: bytes) -> bytes:
    return hashlib.md5(data).digest()

def count_attrs(attrs: bytes) -> int:
    """计算属性块中的实际属性个数"""
    count = 0
    offset = 0
    while offset + 2 <= len(attrs):
        atype, alen = struct.unpack("!BB", attrs[offset:offset+2])
        if alen < 2:
            break
        count += 1
        offset += alen
    return count

def calc_authenticator(msg_type: int, serial_no: int, req_id: int,
                       user_ip: int, user_port: int, err_code: int,
                       attrs: bytes, shared_secret: bytes):
    """计算 Portal 协议 Authenticator = MD5(header + 16_zero_bytes + attrs + secret)
    注意：按华为 Portal 协议规范，计算 MD5 时必须包含 16 字节全零的 Authenticator 占位符"""
    attr_count = count_attrs(attrs)
    header = struct.pack("!BBBBHHIHBB",
        PORTAL_VERSION, msg_type, AUTH_PAP, 0,
        serial_no, req_id,
        user_ip, user_port,
        err_code, attr_count
    )
    # 16 字节全零占位符代表 Authenticator 字段本身
    return md5(header + bytes(16) + attrs + shared_secret)

def build_packet(msg_type: int, serial_no: int, req_id: int,
                 user_ip: int, user_port: int, err_code: int,
                 attrs: bytes, shared_secret: bytes) -> bytes:
    """构造完整的 Portal 协议报文"""
    attr_count = count_attrs(attrs)

    authenticator = calc_authenticator(
        msg_type, serial_no, req_id,
        user_ip, user_port, err_code,
        attrs, shared_secret
    )

    header = struct.pack("!BBBBHHIHBB",
        PORTAL_VERSION, msg_type, AUTH_PAP, 0,
        serial_no, req_id,
        user_ip, user_port,
        err_code, attr_count
    )
    return header + authenticator + attrs

def build_attr(attr_type: int, value: bytes) -> bytes:
    """构造 TLV 属性: Type(1) + Len(1) + Value"""
    length = 2 + len(value)
    return struct.pack("!BB", attr_type, length) + value


# ═══════════════════════════　　　　　　════════════════════

def hmac_md5(key: bytes, msg: bytes) -> bytes:
    """HMAC-MD5 - used for Message-Authenticator calculation"""
    return hmac.new(key, msg, hashlib.md5).digest()

#  RADIUS PAP 直接认证（降级模式：AC 不支持 Portal UDP 时用）
# ═══════════════════════════════════════════════════════════

def radius_auth_pap(username: str, password: str) -> tuple[bool, str]:
    """直接向 FreeRADIUS 发 PAP Access-Request。
    包含 Message-Authenticator (HMAC-MD5) 以满足 FreeRADIUS 3.2.x BlastRADIUS 安全要求。
    返回 (success, message)"""
    try:
        import secrets as pysecrets
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(5)
        req_id = pysecrets.randbelow(256)

        auth = os.urandom(16)

        # Message-Authenticator (type=80, length=18, value=16 zero bytes placeholder)
        msg_auth_attr = struct.pack("!BB", 80, 18) + bytes(16)

        # User-Name (type=1)
        user_name_attr = struct.pack("!BB", 1, 2 + len(username)) + username.encode()

        # User-Password (type=2): XOR with MD5(secret + authenticator)
        pwd_bytes = password.encode()
        if len(pwd_bytes) % 16 != 0:
            pwd_bytes += bytes(16 - len(pwd_bytes) % 16)
        encrypted = b''
        prev = auth
        for i in range(0, len(pwd_bytes), 16):
            block = pwd_bytes[i:i+16]
            h = md5(RADIUS_SECRET + prev)
            enc_block = bytes(a ^ b for a, b in zip(block, h))
            encrypted += enc_block
            prev = enc_block
        user_pwd_attr = struct.pack("!BB", 2, 2 + len(encrypted)) + encrypted

        # Build packet: Message-Authenticator + User-Name + User-Password
        attrs = msg_auth_attr + user_name_attr + user_pwd_attr
        length = 20 + len(attrs)
        packet = struct.pack("!BBH", 1, req_id, length) + auth + attrs

        # Calculate Message-Authenticator = HMAC-MD5(secret, packet_with_zeroed_value)
        msg_auth_hmac = hmac_md5(RADIUS_SECRET, packet)
        # Replace placeholder at offset 22 (code+id+len+auth+type+len = 1+1+2+16+1+1)
        packet = packet[:22] + msg_auth_hmac + packet[38:]

        sock.sendto(packet, (RADIUS_SERVER, RADIUS_PORT))
        data, _ = sock.recvfrom(4096)
        sock.close()

        code = data[0]
        if code == 2:  # Access-Accept
            return (True, "认证成功")
        elif code == 3:  # Access-Reject
            return (False, "用户名或密码错误")
        else:
            return (False, f"RADIUS 返回未知响应 code={code}")
    except socket.timeout:
        return (False, "RADIUS 服务器超时")
    except Exception as ex:
        return (False, f"认证异常: {ex}")

def parse_packet(data: bytes) -> dict | None:
    if len(data) < 32:
        return None
    ver, msg_type, auth_type, rsv = struct.unpack("!BBBB", data[0:4])
    serial_no, req_id = struct.unpack("!HH", data[4:8])
    user_ip, user_port = struct.unpack("!IH", data[8:14])
    err_code, attr_count = struct.unpack("!BB", data[14:16])
    authenticator = data[16:32]
    attrs_raw = data[32:]
    attrs = {}
    offset = 0
    while offset < len(attrs_raw):
        if offset + 2 > len(attrs_raw):
            break
        atype, alen = struct.unpack("!BB", attrs_raw[offset:offset+2])
        if alen < 2 or offset + alen > len(attrs_raw):
            break
        avalue = attrs_raw[offset+2:offset+alen]
        attrs[atype] = avalue
        offset += alen
    return {
        "version": ver, "type": msg_type, "auth_type": auth_type,
        "serial_no": serial_no, "req_id": req_id,
        "user_ip": user_ip, "user_port": user_port,
        "err_code": err_code, "attr_count": attr_count,
        "authenticator": authenticator, "attrs": attrs
    }


# ═══════════════════════════════════════════════════════════
#  Portal UDP 协议处理
# ═══════════════════════════════════════════════════════════

def handle_portal_udp():
    """处理华为 Portal UDP 协议"""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((PORTAL_LISTEN_IP, PORTAL_PORT))
    print(f"[Portal UDP] 监听 {PORTAL_LISTEN_IP}:{PORTAL_PORT}")

    while True:
        try:
            data, addr = sock.recvfrom(4096)
            pkt = parse_packet(data)
            if not pkt:
                continue

            msg_type = pkt["type"]
            user_ip = int_to_ip(pkt["user_ip"])
            nas_ip = addr[0]
            print(f"[Portal] 收到 type={msg_type:#x} from {nas_ip} user_ip={user_ip}")

            if msg_type == REQ_CHALLENGE:
                # ── 1. AC 发起挑战 ──
                challenge = os.urandom(16)
                cleanup_sessions()
                sessions[user_ip] = PortalSession(
                    user_ip, pkt["serial_no"], pkt["req_id"],
                    challenge, nas_ip
                )

                # ACK_CHALLENGE: 返回挑战字 + Portal URL
                attrs = build_attr(ATTR_CHALLENGE, challenge)
                attrs += build_attr(ATTR_PORTALURL, PORTAL_SERVER_URL.encode())

                reply = build_packet(
                    ACK_CHALLENGE, pkt["serial_no"], pkt["req_id"],
                    pkt["user_ip"], 0, ERR_SUCCESS,
                    attrs, SHARED_SECRET
                )
                sock.sendto(reply, addr)
                print(f"[Portal] ACK_CHALLENGE 发送，挑战字 {challenge.hex()[:16]}...")

            elif msg_type == ACK_AUTH:
                # ── 8. AC 通知认证结果 ──
                session = sessions.get(user_ip)
                if session:
                    # 取出待认证信息
                    pending = pending_auth.pop(user_ip, None)
                    if pending:
                        result = "ACCEPT" if pkt["err_code"] == AUTH_ACCEPT else "REJECT"
                        print(f"[Portal] ACK_AUTH for {pending.get('username')}: {result}")
                        # 存储认证结果供 HTTP 查询
                        pending['result'] = result
                        pending['result_time'] = time.time()

                    # 发送 AFF_ACK_AUTH 确认
                    reply = build_packet(
                        AFF_ACK_AUTH, pkt["serial_no"], pkt["req_id"],
                        pkt["user_ip"], 0, ERR_SUCCESS,
                        b"", SHARED_SECRET
                    )
                    sock.sendto(reply, addr)

            elif msg_type in (REQ_LOGOUT, AFF_ACK_AUTH, REQ_INFO, NTY_LOGOUT):
                if msg_type == REQ_INFO:
                    reply = build_packet(
                        ACK_INFO, pkt["serial_no"], pkt["req_id"],
                        pkt["user_ip"], 0, ERR_SUCCESS,
                        b"", SHARED_SECRET
                    )
                    sock.sendto(reply, addr)
                # 其他消息记录日志即可

        except Exception as e:
            print(f"[Portal UDP Error] {e}")


# ═══════════════════════════════════════════════════════════
#  HTTP Web 登录页
# ═══════════════════════════════════════════════════════════

LOGIN_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>企业网络准入认证</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1f2430; background: #eef1f6; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .container { width: 100%; max-width: 420px; }
  .brand { text-align: center; margin-bottom: 32px; }
  .brand .label { font-size: 13px; letter-spacing: 0.14em; color: #8b94a6; font-weight: 600; }
  .brand h1 { font-size: 24px; font-weight: 700; margin-top: 6px; }
  .card { background: #fff; border-radius: 16px; padding: 36px 32px; box-shadow: 0 2px 16px rgba(0,0,0,0.06); }
  .card-header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .card-header .icon-circle { width: 44px; height: 44px; border-radius: 50%; background: linear-gradient(135deg, #1450C8 0%, #3b7eeb 100%); display: flex; align-items: center; justify-content: center; }
  .card-header .icon-circle svg { width: 22px; height: 22px; }
  .card-header h2 { font-size: 18px; font-weight: 700; }
  .card-header p { font-size: 13px; color: #8b94a6; margin-top: 2px; }
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-size: 13px; font-weight: 600; color: #4a5568; margin-bottom: 6px; }
  .form-group .input-wrap { position: relative; }
  .form-group .input-wrap .icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: #8b94a6; }
  .form-group input { width: 100%; padding: 12px 14px 12px 42px; border: 1.5px solid #e2e7f0; border-radius: 10px; font-size: 15px; background: #fafbfc; outline: none; }
  .form-group input:focus { border-color: #1450C8; background: #fff; box-shadow: 0 0 0 3px rgba(20,80,200,0.08); }
  .btn { width: 100%; padding: 13px; border: none; border-radius: 10px; font-size: 16px; font-weight: 700; cursor: pointer; background: linear-gradient(135deg, #1450C8 0%, #3b7eeb 100%); color: #fff; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .msg { padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
  .msg.error { display: block; background: #fff2f0; border: 1px solid #ffccc7; color: #cf1322; }
  .msg.success { display: block; background: #f6ffed; border: 1px solid #b7eb8f; color: #389e0d; }
  .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #8b94a6; }
</style>
</head>
<body>
<div class="container">
  <div class="brand">
    <div class="label">Enterprise Network Access</div>
    <h1>企业网络准入认证</h1>
  </div>
  <div class="card">
    <div class="card-header">
      <div class="icon-circle">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      </div>
      <div><h2>访客 / 员工认证</h2><p>请输入账号密码以接入网络</p></div>
    </div>
    <div id="msg" class="msg"></div>
    <form id="loginForm" autocomplete="off">
      <div class="form-group">
        <label for="username">用户名</label>
        <div class="input-wrap">
          <span class="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>
          <input type="text" id="username" placeholder="用户名" required autofocus>
        </div>
      </div>
      <div class="form-group">
        <label for="password">密码</label>
        <div class="input-wrap">
          <span class="icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>
          <input type="password" id="password" placeholder="请输入密码" required>
        </div>
      </div>
      <button type="submit" id="submitBtn" class="btn">连接网络</button>
    </form>
  </div>
  <div class="footer">安全接入 · Portal 认证</div>
</div>
<script>
(function() {
  var msg=document.getElementById("msg"),btn=document.getElementById("submitBtn");
  function show(t,c){msg.textContent=t;msg.className="msg "+c}
  document.getElementById("loginForm").addEventListener("submit",function(e){
    e.preventDefault();msg.className="msg";btn.disabled=true;btn.textContent="认证中...";
    var u=document.getElementById("username").value.trim(),p=document.getElementById("password").value;
    if(!u||!p){show("请填写用户名和密码","error");btn.disabled=false;btn.textContent="连接网络";return}
    fetch("/__portal_auth",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:"username="+encodeURIComponent(u)+"&password="+encodeURIComponent(p)})
    .then(function(r){return r.json()})
    .then(function(d){btn.disabled=false;btn.textContent="连接网络";show(d.message||(d.success?"认证成功":"认证失败"),d.success?"success":"error")})
    .catch(function(){btn.disabled=false;btn.textContent="连接网络";show("网络异常","error")})
  })
})();
</script>
</body>
</html>

"""


class PortalHTTPHandler(BaseHTTPRequestHandler):
    """HTTP 请求处理"""

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            # 从 URL 参数中提取用户 IP（AC 重定向时可能携带）
            params = parse_qs(urlparse(self.path).query)
            userip_from_url = params.get("userip", [""])[0] or params.get("wlanuserip", [""])[0]
            client_ip_str = userip_from_url if userip_from_url else self.client_address[0]

            # 自动创建会话（兼容 HTTP 重定向模式，无需 AC 发 REQ_CHALLENGE）
            cleanup_sessions()
            if client_ip_str not in sessions:
                challenge = os.urandom(16)
                sessions[client_ip_str] = PortalSession(
                    client_ip_str, next_serial(), next_req_id(),
                    challenge, AC_IP
                )
                print(f"[Portal HTTP] 自动创建会话 client={client_ip_str} serial={sessions[client_ip_str].serial_no}")
            print(f"[Portal HTTP] Full path: {self.path}")
            print(f"[Portal HTTP] Headers: {dict(self.headers)}")

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(LOGIN_HTML.encode())
        elif self.path.startswith("/__portal_token"):
            # 免认证 token 验证
            params = parse_qs(urlparse(self.path).query)
            token = params.get("token", [""])[0]
            username = verify_token(token) if token else None
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if username:
                self.wfile.write(json.dumps({"success": True, "username": username}, ensure_ascii=False).encode())
            else:
                self.wfile.write(json.dumps({"success": False}, ensure_ascii=False).encode())
        elif self.path.startswith("/__portal_status"):
            # 查询认证结果
            params = parse_qs(urlparse(self.path).query)
            userip = params.get("userip", [""])[0]
            pending = pending_auth.get(userip, {})
            result = pending.get("result", "PENDING")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"result": result}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/__portal_auth":
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length).decode()
            params = parse_qs(body)

            # ── 免认证自动登录（token 模式） ──
            auto_token = params.get("token", [""])[0]
            if auto_token:
                auto_user = verify_token(auto_token)
                if auto_user:
                    print(f"[Portal HTTP] AUTO-LOGIN user={auto_user} client={self.client_address[0]}")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"success": True, "message": "设备已信任，自动登录成功", "auto": True}, ensure_ascii=False).encode())
                    return
                else:
                    print(f"[Portal HTTP] AUTO-LOGIN FAIL invalid token from {self.client_address[0]}")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"success": False, "message": "自动登录已过期，请重新输入密码"}, ensure_ascii=False).encode())
                    return

            username = params.get("username", [""])[0]
            password = params.get("password", [""])[0]
            user_ip = params.get("userip", [""])[0]
            client_ip = self.client_address[0]

            print(f"[Portal HTTP] AUTH user={username} client={client_ip} userip={user_ip} path={self.path}")
            print(f"[Portal HTTP] POST Headers: X-Forwarded-For={self.headers.get('X-Forwarded-For', 'N/A')} User-Agent={self.headers.get('User-Agent', 'N/A')}")

            if not username or not password:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": False, "message": "请填写用户名和密码"}, ensure_ascii=False).encode())
                return

            # 发送 REQ_AUTH 给 AC，AC 自己做 RADIUS 认证
            # AC 收到 REQ_AUTH 后向 FreeRADIUS 发 RADIUS Access-Request
            # AC 认证成功后回 ACK_AUTH
            target_ip = user_ip if user_ip else client_ip
            session = sessions.get(target_ip)

            if not session:
                challenge = os.urandom(16)
                session = PortalSession(target_ip, next_serial(), next_req_id(), challenge, AC_IP)
                sessions[target_ip] = session
                print(f"[Portal HTTP] 自动创建会话 client={target_ip} serial={session.serial_no}")

            success = False
            msg = "认证失败"

            try:
                attrs = build_attr(ATTR_USERNAME, username.encode())
                attrs += build_attr(ATTR_PASSWORD, password.encode())
                req_auth = build_packet(
                    REQ_AUTH, session.serial_no, session.req_id,
                    ip_to_int(target_ip), 0, ERR_SUCCESS,
                    attrs, SHARED_SECRET
                )
                req_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                req_sock.settimeout(5)
                req_sock.sendto(req_auth, (session.nas_ip, 2000))
                print(f"[Portal] REQ_AUTH -> AC {session.nas_ip}:2000 user_ip={target_ip} attr_count={count_attrs(attrs)}")

                try:
                    data, _ = req_sock.recvfrom(4096)
                    if len(data) >= 16:
                        ver, msg_type, auth_type, rsv = struct.unpack("!BBBB", data[0:4])
                        serial_no, req_id = struct.unpack("!HH", data[4:8])
                        err_code = data[14]
                        if msg_type == 4:  # ACK_AUTH
                            if err_code == 0:
                                success = True
                                msg = "认证成功"
                                print(f"[Portal] ACK_AUTH success from AC")
                            else:
                                # 华为 AC ACK_AUTH err_code 含义：
                                #   0 = success, 1 = auth rejected,
                                #   4 = AC 内部错误（如 RADIUS 超时/IP池不可用/属性冲突）
                                error_codes = {
                                    0: "成功",
                                    1: "认证被拒绝（用户名或密码错误）",
                                    2: "用户已在线",
                                    3: "设备忙",
                                    4: "AC 认证处理失败（请检查 AC RADIUS/IP池配置）",
                                }
                                base_msg = error_codes.get(err_code, f"未知错误(err_code={err_code})")
                                # 尝试解析 AC 返回的 Error-Description 属性（type=5）
                                error_detail = ""
                                if len(data) > 32:
                                    attrs_data = data[32:]
                                    offset = 0
                                    while offset + 2 <= len(attrs_data):
                                        atype, alen = struct.unpack("!BB", attrs_data[offset:offset+2])
                                        if offset + alen <= len(attrs_data):
                                            aval = attrs_data[offset+2:offset+alen]
                                            try:
                                                text = aval.decode("utf-8", errors="replace")
                                            except:
                                                text = aval.hex()
                                            if atype == 5:  # Error-Description
                                                error_detail = text
                                                break
                                            elif atype in (3, 0x0b):
                                                pass  # skip challenge/mac attributes
                                        offset += alen
                                if error_detail:
                                    msg = f"{base_msg} - {error_detail}"
                                else:
                                    msg = base_msg
                                print(f"[Portal] ACK_AUTH fail err_code={err_code} detail={error_detail}")
                        else:
                            msg = f"AC 返回未知消息类型: {msg_type}"
                            print(f"[Portal] Unexpected msg_type={msg_type}")
                except socket.timeout:
                    msg = "AC 认证超时，请确保用户已关联到 AC"
                    print(f"[Portal] AC ACK_AUTH timeout (user_ip={target_ip} may not be online at AC)")
                req_sock.close()
            except Exception as ex:
                msg = f"发送 REQ_AUTH 失败: {ex}"
                print(f"[Portal] REQ_AUTH error: {ex}")

            final_msg = "认证成功，网络已放行。您可以关闭此页面开始上网。" if success else msg

            resp = {"success": success, "message": final_msg}
            # 如果勾选了"记住设备"，生成免认证 token 返回给前端
            if success and params.get("remember", [""])[0] == "1":
                resp["token"] = generate_token(username)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp, ensure_ascii=False).encode())
        else:
            self.send_response(404)
            self.end_headers()


# ═══════════════════════════════════════════════════════════
#  主程序
# ═══════════════════════════════════════════════════════════

if __name__ == "__main__":
    print("=" * 55)
    print("  华为 Portal 协议服务端")
    print(f"  Portal UDP: {PORTAL_LISTEN_IP}:{PORTAL_PORT}")
    print(f"  Web HTTP:   http://0.0.0.0:{WEB_PORT}")
    print("=" * 55)

    udp_thread = threading.Thread(target=handle_portal_udp, daemon=True)
    udp_thread.start()

    httpd = HTTPServer(("0.0.0.0", WEB_PORT), PortalHTTPHandler)
    print(f"\n[HTTP] 监听 0.0.0.0:{WEB_PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()
