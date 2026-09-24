"""WireGuard VPN Server API"""
import subprocess, re, os, io
from fastapi import APIRouter, HTTPException, Query, Header
from core.database import get_pool
from aiomysql import DictCursor
from pydantic import BaseModel

router = APIRouter()

def read_db_config():
    """从 DB 读取服务器配置"""
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    cur.execute("SELECT * FROM vpn_server_config WHERE id=1")
    row = cur.fetchone()
    cur.close(); db.close()
    return row or {'subnet':'10.99.0.0/24','server_address':'10.99.0.1','port':8001,'dns':'223.5.5.5','mtu':1420,'public_key':'','private_key':''}

def ensure_tunnel_subnet(cfg, allowed_ips):
    """确保下发给客户端的 AllowedIPs 覆盖隧道网段（网关可达性保障）。

    WireGuard 客户端只向 AllowedIPs 内的目标发包；若授权资源（如 172.18.0.0/16）
    不含隧道自身网段，发往 server_address 的包会被静默丢弃 → ping 网关"一般故障"。
    0.0.0.0/0 全局模式已天然覆盖，直接返回。
    """
    if '0.0.0.0/0' in allowed_ips:
        return allowed_ips
    subnet = (cfg.get('subnet') or '10.99.0.0/24').strip()
    entries = [e.strip() for e in allowed_ips.split(',') if e.strip()]
    if subnet not in entries:
        entries.append(subnet)
    return ', '.join(entries)


def wg_show():
    """检查 wg0 是否运行（用 dump 格式，tab 分隔，latest_handshake 为 unix 时间戳）"""
    r = subprocess.run(['wg','show','wg0','dump'], capture_output=True, text=True)
    if r.returncode != 0:
        return {'peers': [], 'running': False}
    lines = r.stdout.strip().split('\n')
    peers = []
    for line in lines[1:]:
        parts = line.split('\t')
        if len(parts) >= 7:
            peers.append({
                'public_key': parts[0],
                'endpoint': parts[2],
                'transfer_rx': int(parts[5] or 0),
                'transfer_tx': int(parts[6] or 0),
                'latest_handshake': parts[4],
            })
    return {'peers': peers, 'running': True}

def wg_sync_conf():
    """将 DB peers 同步到 WG（不使用 wg-quick，不碰 iptables/路由）"""
    cfg = read_db_config()
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    cur.execute("SELECT * FROM vpn_peers WHERE enabled=1")
    peers = cur.fetchall()
    cur.close(); db.close()

    # 生成纯 WG 配置（无 PostUp/PostDown，不碰 iptables）
    lines = [
        '[Interface]',
        f'PrivateKey = {cfg["private_key"]}',
        f'Address = {cfg["server_address"]}/{cfg["subnet"].split("/")[1]}',
        f'ListenPort = {cfg["port"]}',
        f'MTU = {cfg["mtu"]}',
        '',
    ]
    for p in peers:
        if not p["public_key"]:
            continue
        # 服务端视角：peer AllowedIPs = 该客户端的隧道 IP /32（加密侧源地址校验+回程路由）。
        # 注意不是 vpn_peers.allowed_ips（那是下发给客户端的授权资源网段，两者语义相反）。
        lines.append('[Peer]')
        lines.append(f'PublicKey = {p["public_key"]}')
        lines.append(f'AllowedIPs = {p["address"]}/32')
        lines.append('PersistentKeepalive = 25')
        lines.append('')

    with open('/etc/wireguard/wg0.conf', 'w') as f:
        f.write('\n'.join(lines) + '\n')

    # 用 wg syncconf 热加载，不重启接口
    subprocess.run(['wg', 'syncconf', 'wg0', '/etc/wireguard/wg0.conf'], capture_output=True)

    # syncconf 不应用 PersistentKeepalive，需用 wg set 单独设置
    for p in peers:
        subprocess.run(['wg', 'set', 'wg0', 'peer', p['public_key'],
                        'persistent-keepalive', '25'], capture_output=True)


def wg_up():
    """安全启动 wg0：只用 ip link + wg，不用 wg-quick（避免 iptables）"""
    cfg = read_db_config()
    # 如果接口不存在则创建
    r = subprocess.run(['ip', 'link', 'show', 'wg0'], capture_output=True)
    if r.returncode != 0:
        subprocess.run(['ip', 'link', 'add', 'wg0', 'type', 'wireguard'], capture_output=True)
    subprocess.run(['ip', 'addr', 'flush', 'dev', 'wg0'], capture_output=True)
    cidr = cfg['subnet'].split('/')[1]
    subprocess.run(['ip', 'addr', 'add', f'{cfg["server_address"]}/{cidr}', 'dev', 'wg0'], capture_output=True)
    subprocess.run(['ip', 'link', 'set', 'mtu', str(cfg['mtu']), 'up', 'dev', 'wg0'], capture_output=True)
    wg_sync_conf()

def wg_down():
    """安全停用 wg0"""
    subprocess.run(['ip', 'link', 'del', 'wg0'], capture_output=True)

# ── Server ──
@router.get("/vpn/server/status")
async def vpn_server_status():
    cfg = read_db_config()
    wg = wg_show()
    return {'running': wg['running'], 'port': cfg['port'], 'subnet': cfg['subnet'], 'server_address': cfg['server_address'], 'dns': cfg['dns'], 'mtu': cfg['mtu'], 'peer_count': len(wg['peers']), 'online_peers': sum(1 for p in wg['peers'] if p['latest_handshake'] and int(p['latest_handshake'] or 0) > 0)}

@router.post("/vpn/server/start")
async def vpn_start():
    """安全启动 WG（不用 wg-quick，不碰 iptables）"""
    wg_up()
    return {'ok': True, 'running': True}

@router.post("/vpn/server/stop")
async def vpn_stop():
    wg_down()
    return {'ok': True, 'running': False}

@router.get("/vpn/server/config")
async def vpn_server_config():
    cfg = read_db_config()
    return {'subnet': cfg['subnet'], 'port': cfg['port'], 'dns': cfg['dns'], 'mtu': cfg['mtu'], 'server_address': cfg['server_address']}

class ServerConfig(BaseModel):
    subnet: str = None
    port: int = None
    dns: str = None
    mtu: int = None

@router.put("/vpn/server/config")
async def vpn_server_config_update(cfg: ServerConfig):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    fields = {k:v for k,v in cfg.dict().items() if v is not None}
    if fields:
        set_clause = ', '.join(f'{k}=%s' for k in fields)
        cur.execute(f"UPDATE vpn_server_config SET {set_clause}, updated_at=NOW() WHERE id=1", list(fields.values()))
    # If subnet changed, update server_address to <base>.1
    if cfg.subnet:
        new_base = '.'.join(cfg.subnet.split('/')[0].split('.')[:3])
        new_addr = f'{new_base}.1'
        cur.execute("UPDATE vpn_server_config SET server_address=%s WHERE id=1", (new_addr,))
    db.commit(); cur.close(); db.close()
    wg_sync_conf()
    return {'ok': True}

# ── Pool ──
@router.get("/vpn/pool")
async def vpn_pool():
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    cur.execute("SELECT address FROM vpn_peers ORDER BY address")
    used_ips = {r[0] for r in cur.fetchall()}
    cur.close(); db.close()
    # Calculate available from subnet config
    cfg = read_db_config()
    subnet_parts = cfg['subnet'].split('/')
    netmask = int(subnet_parts[1])
    base_ip = '.'.join(cfg['server_address'].split('.')[:3])
    total = (1 << (32 - netmask)) - 3  # exclude .0 (network), .1 (gateway), .255 (broadcast)
    return {'used': len(used_ips), 'available': total - len(used_ips), 'total': total, 'subnet': cfg['subnet']}

# ── Peers ──
@router.get("/vpn/peers")
async def list_peers():
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    cur.execute("SELECT * FROM vpn_peers ORDER BY address")
    peers = list(cur.fetchall())
    cur.close(); db.close()
    wg = wg_show()
    # Enrich with WG live data
    wg_map = {p['public_key']: p for p in wg['peers']}
    for p in peers:
        if p['public_key'] in wg_map:
            p['transfer_rx'] = wg_map[p['public_key']]['transfer_rx']
            p['transfer_tx'] = wg_map[p['public_key']]['transfer_tx']
            p['endpoint'] = wg_map[p['public_key']]['endpoint']
            p['online'] = bool(wg_map[p['public_key']].get('latest_handshake'))
        else:
            p['transfer_rx'] = 0; p['transfer_tx'] = 0; p['endpoint'] = ''; p['online'] = False
    return peers

@router.post("/vpn/peers")
async def create_peer(username: str):
    """创建对端: 分配IP → 生成密钥 → 写入DB + wg"""
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)

    # Check not exists
    cur.execute("SELECT id FROM vpn_peers WHERE username=%s", (username,))
    if cur.fetchone():
        cur.close(); db.close()
        raise HTTPException(400, "该用户已有 VPN 对端")

    # Check user exists in radcheck
    cur.execute("SELECT id FROM radcheck WHERE username=%s", (username,))
    if not cur.fetchone():
        cur.close(); db.close()
        raise HTTPException(404, "用户不存在")

    # Allocate IP based on subnet config
    cfg = read_db_config()
    subnet_base = '.'.join(cfg['server_address'].split('.')[:3])
    # Calculate end of usable range
    parts = cfg['subnet'].split('/')
    netmask = int(parts[1])
    max_addr = (1 << (32 - netmask)) - 2  # exclude .0 (network) and last (.255 for /24)
    cur.execute("SELECT address FROM vpn_peers ORDER BY INET_ATON(address)")
    used = {r['address'] for r in cur.fetchall()}
    ip = None
    for i in range(2, max_addr):
        candidate = f'{subnet_base}.{i}'
        if candidate not in used:
            ip = candidate
            break
    if not ip:
        cur.close(); db.close()
        raise HTTPException(400, "IP 池已满")

    # Generate WG keys
    priv = subprocess.run(['wg','genkey'], capture_output=True, text=True).stdout.strip()
    pub = subprocess.run(['wg','pubkey'], input=priv, capture_output=True, text=True).stdout.strip()

    cur.execute("INSERT INTO vpn_peers (username, public_key, private_key, address, dns) VALUES (%s,%s,%s,%s,%s)",
        (username, pub, priv, ip, cfg['dns']))
    # Compute allowed_ips from user access grants
    cur.execute("SELECT GROUP_CONCAT(r.value SEPARATOR ', ') as ips FROM vpn_user_access ua JOIN vpn_ip_resources r ON ua.resource_id=r.id WHERE ua.username=%s", (username,))
    row = cur.fetchone()
    allowed_ips = row['ips'] if row and row['ips'] else ''
    cur.execute("UPDATE vpn_peers SET allowed_ips=%s WHERE username=%s", (allowed_ips, username))
    db.commit()
    cur.close(); db.close()

    # Sync to wg
    wg_sync_conf()
    return {'ok': True, 'username': username, 'address': ip, 'public_key': pub}

@router.delete("/vpn/peers/{username}")
async def delete_peer(username: str):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    cur.execute("DELETE FROM vpn_peers WHERE username=%s", (username,))
    db.commit(); cur.close(); db.close()
    wg_sync_conf()
    return {'ok': True}

@router.put("/vpn/peers/{username}")
async def toggle_peer(username: str, enabled: bool = True):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    cur.execute("UPDATE vpn_peers SET enabled=%s WHERE username=%s", (int(enabled), username))
    db.commit(); cur.close(); db.close()
    wg_sync_conf()
    return {'ok': True, 'enabled': enabled}

@router.put("/vpn/peers/{username}/allowed-ips")
async def update_allowed_ips(username: str, allowed_ips: str = "0.0.0.0/0"):
    """更新对端访问权限（AllowedIPs）"""
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    cur.execute("UPDATE vpn_peers SET allowed_ips=%s WHERE username=%s", (allowed_ips, username))
    db.commit(); cur.close(); db.close()
    wg_sync_conf()
    return {'ok': True, 'allowed_ips': allowed_ips}

@router.get("/vpn/peers/{username}/conf")
async def download_peer_config(username: str):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    # 获取对端基础信息
    cur.execute("SELECT p.*, c.public_key as svr_pub, c.server_address, c.port, c.dns, c.subnet FROM vpn_peers p JOIN vpn_server_config c WHERE p.username=%s AND c.id=1", (username,))
    p = cur.fetchone()
    if not p:
        cur.close(); db.close()
        raise HTTPException(404, "对端不存在")

    # 从授权系统动态计算 AllowedIPs
    cur.execute("SELECT GROUP_CONCAT(r.value ORDER BY r.id SEPARATOR ', ') as ips FROM vpn_user_access ua JOIN vpn_ip_resources r ON ua.resource_id=r.id WHERE ua.username=%s", (username,))
    row = cur.fetchone()
    allowed_ips = (row['ips'] if row and row['ips'] else '').strip()
    if not allowed_ips:
        allowed_ips = '0.0.0.0/0'

    cidr = p['subnet'].split('/')[1]
    conf = f"""[Interface]
PrivateKey = {p['private_key']}
Address = {p['address']}/{cidr}
DNS = {p['dns']}

[Peer]
PublicKey = {p['svr_pub']}
Endpoint = 192.168.110.106:{p['port']}
AllowedIPs = {allowed_ips}
PersistentKeepalive = 25
"""
    cur.close(); db.close()
    from fastapi.responses import Response
    # WireGuard 官方客户端导入时以「文件名」作隧道名，仅允许 [A-Za-z0-9_.+-] 且 ≤32 字符，
    # 中文/空格/括号（浏览器重复下载的 "xxx (1).conf"）会报「隧道名称无效」。
    # 双重防御：① 用户名清洗；② 追加随机短后缀保证每次下载文件名唯一——
    # 本地已有 double.conf 时浏览器不会再生成 "double (1).conf"（其空格括号必炸）。
    import secrets
    safe_base = re.sub(r'[^A-Za-z0-9_.+-]', '_', username)[:24].strip('_.+-') or 'tunnel'
    safe_name = f"{safe_base}-{secrets.token_hex(3)}"
    return Response(content=conf, media_type='text/plain', headers={'Content-Disposition': f'attachment; filename="{safe_name}.conf"'})

# ── Client VPN Connect ──
class VpnConnectRequest(BaseModel):
    username: str
    public_key: str = ""
    otp_code: str = ""


class VpnConnectNodeRequest(BaseModel):
    """多节点拨入请求（NetAgent ConnectToNode）：Bearer token 已携带用户身份"""
    public_key: str = ""
    otp_code: str = ""


@router.post("/vpn/connect/{node_id}")
async def vpn_connect_node(node_id: str, req: VpnConnectNodeRequest, authorization: str = Header(default="")):
    """多节点客户端拨入（2026-09-21 新增）：匹配 NetAgent ConnectToNode 协议。

    与旧版 /vpn/connect 的两点差异：
    1. username 从 Bearer JWT 解出（客户端只发 public_key，不重发用户名）；
    2. 客户端每次连接本地生成新密钥对，服务端必须注册其新公钥
       （UPDATE vpn_peers + wg set 热加载），否则握手必败。
    """
    import pymysql, subprocess
    from jose import jwt as jose_jwt, JWTError
    from core.config import SECRET_KEY, ALGORITHM

    token = authorization.removeprefix("Bearer ").strip()
    username = None
    try:
        payload = jose_jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
    except JWTError:
        pass
    if not username:
        raise HTTPException(401, "未登录或凭证已过期")

    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    try:
        cur.execute("SELECT * FROM vpn_server_config WHERE id=1")
        cfg = cur.fetchone()
        if not cfg:
            raise HTTPException(500, "服务器 VPN 配置缺失")

        cur.execute("SELECT * FROM vpn_peers WHERE username=%s", (username,))
        peer = cur.fetchone()
        if not peer:
            raise HTTPException(404, f"用户 {username} 未获 VPN 授权")

        # 注册客户端本次连接使用的新公钥（关键：客户端每次本地重新生成）
        client_pub = (req.public_key or "").strip()
        if client_pub and client_pub != peer.get("public_key"):
            cur.execute(
                "UPDATE vpn_peers SET public_key=%s WHERE username=%s",
                (client_pub, username),
            )
            db.commit()
        pub_for_wg = client_pub or peer.get("public_key")

        # AllowedIPs：用户被授权的 IP 资源
        cur.execute(
            "SELECT GROUP_CONCAT(r.value ORDER BY r.id SEPARATOR ', ') as ips "
            "FROM vpn_user_access ua JOIN vpn_ip_resources r ON ua.resource_id=r.id "
            "WHERE ua.username=%s", (username,),
        )
        row = cur.fetchone()
        allowed_ips = (row['ips'] if row and row['ips'] else '').strip() or '0.0.0.0/0'

        # 2026-09-21 网关不通修复：客户端 peer 的 AllowedIPs 必须包含隧道网段，
        # 否则发往 server_address（10.99.0.1）的包被 wg 静默丢弃（ping 报"一般故障"）。
        # 授权资源（如 172.18.0.0/16）与隧道网段合并后下发。
        allowed_ips = ensure_tunnel_subnet(cfg, allowed_ips)

        # 热加载到 wg0（先删旧 peer 再加新公钥，保证密钥轮换生效）
        subprocess.run(['wg', 'set', 'wg0', 'peer', peer["public_key"], 'remove'],
                       capture_output=True, timeout=5)
        subprocess.run(
            ['wg', 'set', 'wg0', 'peer', pub_for_wg,
             'allowed-ips', f'{peer["address"]}/32'],
            capture_output=True, timeout=5)

        data = {
            "virtual_ip": peer["address"],
            "client_private_key": "",   # 密钥由客户端本地生成，服务端不再下发私钥
            "server_public_key": cfg["public_key"],
            "server_port": cfg["port"],
            "dns": [cfg["dns"]],
            "allowed_ips": allowed_ips,
            "split_tunnel_strategy": "split",
            "exclude_domain_info": [],
        }
    finally:
        cur.close()
        db.close()

    try:
        db2 = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
        cur2 = db2.cursor()
        cur2.execute(
            "INSERT INTO vpn_access_log (username, action, ip, detail) VALUES (%s,%s,%s,%s)",
            (username, f'connect:{node_id}', peer["address"], f'port={cfg["port"]} allowed_ips={allowed_ips}'),
        )
        db2.commit()
        cur2.close()
        db2.close()
    except:
        pass

    return {"code": 0, "data": data}


@router.post("/vpn/connect")
async def vpn_connect(req: VpnConnectRequest):
    """客户端 VPN 拨入：服务端统一生成密钥对（存 DB），返回配置+私钥"""
    import pymysql, re, subprocess
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)

    try:
        cur.execute("SELECT * FROM vpn_server_config WHERE id=1")
        cfg = cur.fetchone()
        if not cfg:
            raise HTTPException(500, "服务器 VPN 配置缺失")

        cur.execute("SELECT * FROM vpn_peers WHERE username=%s", (req.username,))
        peer = cur.fetchone()
        if not peer:
            raise HTTPException(404, "VPN 对端不存在")

        # 复用已有密钥，不存在时才生成
        private_key = peer.get("private_key")
        public_key = peer.get("public_key")
        if not private_key or not public_key:
            r = subprocess.run(['wg', 'genkey'], capture_output=True, text=True)
            private_key = r.stdout.strip()
            r = subprocess.run(['wg', 'pubkey'], input=private_key, capture_output=True, text=True)
            public_key = r.stdout.strip()
            cur.execute(
                "UPDATE vpn_peers SET public_key=%s, private_key=%s WHERE username=%s",
                (public_key, private_key, req.username),
            )
            db.commit()

        # AllowedIPs
        cur.execute(
            "SELECT GROUP_CONCAT(r.value ORDER BY r.id SEPARATOR ', ') as ips "
            "FROM vpn_user_access ua JOIN vpn_ip_resources r ON ua.resource_id=r.id "
            "WHERE ua.username=%s", (req.username,),
        )
        row = cur.fetchone()
        allowed_ips = (row['ips'] if row and row['ips'] else '').strip() or '0.0.0.0/0'
        # 2026-09-21 网关不通修复：同 vpn_connect_node，合并隧道网段后下发
        allowed_ips = ensure_tunnel_subnet(cfg, allowed_ips)

        # 热加载到 wg0：用 wg set 更新 peer（不断网，比 syncconf 更可靠）
        subprocess.run(
            ['wg', 'set', 'wg0', 'peer', public_key,
             'allowed-ips', f'{peer["address"]}/32'],
            capture_output=True, timeout=5)

        data = {
            "virtual_ip": peer["address"],
            "client_private_key": private_key,
            "server_public_key": cfg["public_key"],
            "server_port": cfg["port"],
            "dns": [cfg["dns"]],
            "allowed_ips": allowed_ips,
            "split_tunnel_strategy": "split",
            "exclude_domain_info": [],
        }
    finally:
        cur.close()
        db.close()

    # 记录连接日志
    try:
        db2 = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
        cur2 = db2.cursor()
        cur2.execute(
            "INSERT INTO vpn_access_log (username, action, ip, detail) VALUES (%s,%s,%s,%s)",
            (req.username, 'connect', peer["address"], f'port={cfg["port"]} allowed_ips={allowed_ips}'),
        )
        db2.commit()
        cur2.close()
        db2.close()
    except:
        pass

    return {"code": 0, "data": data}

# ── Permissions ──
@router.get("/vpn/permissions")
async def list_permissions():
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    cur.execute("""SELECT u.username, COALESCE(p.address,'-') as address, COALESCE(p.enabled,0) as vpn_enabled, COALESCE(p.public_key,'') as public_key, COALESCE(p.allowed_ips,'0.0.0.0/0') as allowed_ips
        FROM radcheck u LEFT JOIN vpn_peers p ON u.username=p.username
        WHERE u.attribute='Cleartext-Password' ORDER BY p.enabled DESC, u.username""")
    rows = list(cur.fetchall())
    cur.close(); db.close()
    return rows

@router.post("/vpn/permissions/{username}")
async def grant_permission(username: str):
    """授权 = 创建 peer（复用已有 peer 或新建）"""
    return await create_peer(username)

@router.delete("/vpn/permissions/{username}")
async def revoke_permission(username: str):
    """撤销 = 删除 peer 和用户访问记录，IP 释放"""
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    cur.execute("DELETE FROM vpn_peers WHERE username=%s", (username,))
    cur.execute("DELETE FROM vpn_user_access WHERE username=%s", (username,))
    db.commit(); cur.close(); db.close()
    wg_sync_conf()
    return {'ok': True}

# ── IP 资源管理 ──
@router.get("/vpn/resources")
async def list_resources():
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    cur.execute("SELECT * FROM vpn_ip_resources ORDER BY type, name")
    rows = list(cur.fetchall())
    cur.close(); db.close()
    return rows

@router.post("/vpn/resources")
async def create_resource(name: str, type: str = "segment", value: str = "", description: str = ""):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    cur.execute("INSERT INTO vpn_ip_resources (name, type, value, description) VALUES (%s,%s,%s,%s)",
        (name, type, value, description))
    db.commit(); cur.close(); db.close()
    return {'ok': True}

@router.put("/vpn/resources/{rid}")
async def update_resource(rid: int, name: str = None, value: str = None, description: str = None):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    sets = []; vals = []
    if name: sets.append("name=%s"); vals.append(name)
    if value is not None: sets.append("value=%s"); vals.append(value)
    if description is not None: sets.append("description=%s"); vals.append(description)
    if sets:
        vals.append(rid)
        cur.execute(f"UPDATE vpn_ip_resources SET {','.join(sets)} WHERE id=%s", vals)
    db.commit(); cur.close(); db.close()
    # Re-sync affected peers
    wg_sync_conf()
    return {'ok': True}

@router.delete("/vpn/resources/{rid}")
async def delete_resource(rid: int):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    cur.execute("DELETE FROM vpn_ip_resources WHERE id=%s", (rid,))
    cur.execute("DELETE FROM vpn_user_access WHERE resource_id=%s", (rid,))
    db.commit(); cur.close(); db.close()
    wg_sync_conf()
    return {'ok': True}

# ── 用户权限分配 ──
@router.get("/vpn/user-access/{username}")
async def get_user_access(username: str):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    cur.execute("""SELECT r.id, r.name, r.type, r.value, r.description
        FROM vpn_user_access ua JOIN vpn_ip_resources r ON ua.resource_id=r.id
        WHERE ua.username=%s ORDER BY r.type, r.name""", (username,))
    rows = list(cur.fetchall())
    cur.close(); db.close()
    return rows

@router.post("/vpn/user-access/{username}/{resource_id}")
async def grant_user_access(username: str, resource_id: int):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    cur.execute("INSERT IGNORE INTO vpn_user_access (username, resource_id) VALUES (%s,%s)", (username, resource_id))
    db.commit()
    # Sync allowed_ips to peer
    cur.execute("SELECT GROUP_CONCAT(r.value SEPARATOR ', ') as ips FROM vpn_user_access ua JOIN vpn_ip_resources r ON ua.resource_id=r.id WHERE ua.username=%s", (username,))
    row = cur.fetchone()
    if row and row[0]:
        cur.execute("UPDATE vpn_peers SET allowed_ips=%s WHERE username=%s", (row[0], username))
    cur.close(); db.close()
    wg_sync_conf()
    return {'ok': True}

@router.delete("/vpn/user-access/{username}/{resource_id}")
async def revoke_user_access(username: str, resource_id: int):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    cur.execute("DELETE FROM vpn_user_access WHERE username=%s AND resource_id=%s", (username, resource_id))
    # Re-sync allowed_ips
    cur.execute("SELECT GROUP_CONCAT(r.value SEPARATOR ', ') as ips FROM vpn_user_access ua JOIN vpn_ip_resources r ON ua.resource_id=r.id WHERE ua.username=%s", (username,))
    row = cur.fetchone()
    if row and row[0]:
        cur.execute("UPDATE vpn_peers SET allowed_ips=%s WHERE username=%s", (row[0], username))
    else:
        cur.execute("UPDATE vpn_peers SET allowed_ips='0.0.0.0/0' WHERE username=%s", (username,))
    db.commit(); cur.close(); db.close()
    wg_sync_conf()
    return {'ok': True}

# ── Stats ──
@router.get("/vpn/stats")
async def vpn_stats():
    import pymysql
    import time as _time
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    # Online peers：最近 3 分钟内有握手的（WireGuard 默认 2 分钟 rekey）
    wg = wg_show()
    now = int(_time.time())
    online = 0
    for p in wg['peers']:
        hs = int(p.get('latest_handshake') or 0)
        if hs > 0 and (now - hs) < 180:
            online += 1
    # Total peers
    cur.execute("SELECT COUNT(*) as c FROM vpn_peers")
    total_peers = cur.fetchone()['c']
    # Today connections
    cur.execute("SELECT COUNT(*) as c FROM vpn_access_log WHERE DATE(created_at)=CURDATE()")
    today_conn = cur.fetchone()['c']
    # Today traffic + total traffic
    cur.execute("SELECT COALESCE(SUM(up_bytes+down_bytes),0) as t FROM vpn_traffic_log WHERE DATE(session_start)=CURDATE()")
    today_bytes = cur.fetchone()['t']
    cur.execute("SELECT COALESCE(SUM(up_bytes+down_bytes),0) as t FROM vpn_traffic_log")
    total_bytes = cur.fetchone()['t']
    # Active users today
    cur.execute("SELECT COUNT(DISTINCT username) as c FROM vpn_access_log WHERE DATE(created_at)=CURDATE()")
    active_users = cur.fetchone()['c']
    cur.close(); db.close()
    return {'online': online, 'total_peers': total_peers, 'today_connections': today_conn,
            'today_bytes': today_bytes, 'total_bytes': total_bytes, 'active_users': active_users}

# ── Logs ──
@router.get("/vpn/access-log")
async def access_log(username: str = None, from_date: str = None, to_date: str = None, limit: int = 500):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    sql = "SELECT * FROM vpn_access_log WHERE 1=1"
    params = []
    if username:
        sql += " AND username LIKE %s"
        params.append(f"%{username}%")
    if from_date:
        sql += " AND DATE(created_at) >= %s"
        params.append(from_date)
    if to_date:
        sql += " AND DATE(created_at) <= %s"
        params.append(to_date)
    sql += " ORDER BY created_at DESC LIMIT %s"
    params.append(limit)
    cur.execute(sql, params)
    rows = list(cur.fetchall())
    cur.close(); db.close()
    return rows

@router.get("/vpn/traffic-log")
async def traffic_log(username: str = None, from_date: str = None, to_date: str = None, limit: int = 500):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    sql = "SELECT * FROM vpn_traffic_log WHERE 1=1"
    params = []
    if username:
        sql += " AND username LIKE %s"
        params.append(f"%{username}%")
    if from_date:
        sql += " AND DATE(session_start) >= %s"
        params.append(from_date)
    if to_date:
        sql += " AND DATE(session_start) <= %s"
        params.append(to_date)
    sql += " ORDER BY session_start DESC LIMIT %s"
    params.append(limit)
    cur.execute(sql, params)
    rows = list(cur.fetchall())
    cur.close(); db.close()
    return rows

class TrafficReport(BaseModel):
    username: str
    up_bytes: int = 0
    down_bytes: int = 0
    duration_sec: int = 0
    final: bool = False

@router.post("/vpn/traffic-report")
async def traffic_report(req: TrafficReport):
    """客户端周期上报流量增量。final=true 时结束会话。"""
    import pymysql
    from datetime import datetime
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    cur.execute(
        "SELECT id FROM vpn_traffic_log "
        "WHERE username=%s AND session_end IS NULL ORDER BY id DESC LIMIT 1",
        (req.username,),
    )
    row = cur.fetchone()

    if row:
        if req.final:
            cur.execute(
                "UPDATE vpn_traffic_log SET up_bytes=up_bytes+%s, down_bytes=down_bytes+%s, "
                "duration_sec=duration_sec+%s, session_end=%s WHERE id=%s",
                (req.up_bytes, req.down_bytes, req.duration_sec, now, row['id']),
            )
        else:
            cur.execute(
                "UPDATE vpn_traffic_log SET up_bytes=up_bytes+%s, down_bytes=down_bytes+%s, "
                "duration_sec=duration_sec+%s WHERE id=%s",
                (req.up_bytes, req.down_bytes, req.duration_sec, row['id']),
            )
    else:
        cur.execute(
            "INSERT INTO vpn_traffic_log (username, up_bytes, down_bytes, duration_sec, session_start, session_end) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            (req.username, req.up_bytes, req.down_bytes, req.duration_sec, now, now if req.final else None),
        )
    db.commit()
    cur.close(); db.close()
    return {"ok": True}

class VisitReport(BaseModel):
    username: str
    visits: list = []

@router.post("/vpn/visit-report")
async def visit_report(req: VisitReport):
    """客户端上报 DNS 访问域名日志。"""
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor()
    for v in req.visits:
        cur.execute(
            "INSERT INTO vpn_visit_log (username, domain, dst_ip, first_seen, last_seen) "
            "VALUES (%s, %s, %s, %s, %s)",
            (req.username, v.get('domain'), v.get('ip'), v.get('ts'), v.get('ts')),
        )
    db.commit()
    cur.close(); db.close()
    return {"ok": True, "count": len(req.visits)}

@router.get("/vpn/visit-log")
async def visit_log(username: str = None, from_date: str = None, to_date: str = None, limit: int = 500):
    import pymysql
    db = pymysql.connect(host='127.0.0.1', user='radius', password='CHANGE_ME_DB_PASS', database='radius')
    cur = db.cursor(pymysql.cursors.DictCursor)
    sql = "SELECT * FROM vpn_visit_log WHERE 1=1"
    params = []
    if username:
        sql += " AND username LIKE %s"
        params.append(f"%{username}%")
    if from_date:
        sql += " AND DATE(first_seen) >= %s"
        params.append(from_date)
    if to_date:
        sql += " AND DATE(first_seen) <= %s"
        params.append(to_date)
    sql += " ORDER BY last_seen DESC LIMIT %s"
    params.append(limit)
    cur.execute(sql, params)
    rows = list(cur.fetchall())
    cur.close(); db.close()
    return rows
