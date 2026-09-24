"""
IP 资产管理 — 纯函数工具（v1.0）
PRD: docs/PRD-IP资产管理.md
- IPv4/IPv6 解析与规范化（ipaddress 模块，不依赖 MariaDB INET6_ATON）
- 网段匹配、容量计算（>2^32 科学计数防溢出）
- NAT 映射校验（端口 0 = 1:1 全端口，proto 必须 any）
- 导入行校验（三色分类：新增/更新/错误）
"""
import ipaddress
import json
import re
from datetime import date, datetime

STATUSES = ("allocated", "reserved", "free", "conflict", "disabled")
ZONES = ("office", "idc", "zt", "storage", "test", "dmz")
ISPS = ("telecom", "unicom", "mobile", "cloud")
ASSET_TYPES = ("physical", "vm", "network", "printer", "other")
NAT_PROTOS = ("tcp", "udp", "any")

_MAC_RE = re.compile(r"^[0-9A-Fa-f]{2}([:-]?[0-9A-Fa-f]{2}){5}$")
_ICP_RE = re.compile(r"^[\u4e00-\u9fa5]ICP备\d{6,12}号(-\d+)?$")
STATUS_CN = {"allocated": "已分配", "reserved": "预留", "free": "空闲",
             "conflict": "冲突", "disabled": "禁用"}


# ---------- IP 解析 ----------

class IpValue:
    """规范化后的 IP 值：version / packed(bytes) / text(压缩形式) / ipaddress 对象"""
    __slots__ = ("version", "packed", "text", "obj")

    def __init__(self, version, packed, text, obj):
        self.version = version
        self.packed = packed
        self.text = text
        self.obj = obj

    @property
    def expanded(self) -> str:
        return self.obj.exploded


def parse_ip(text: str) -> IpValue | None:
    """解析 IPv4/IPv6 字符串（容忍前缀携带，取地址部分）；非法返回 None"""
    if not text or not isinstance(text, str):
        return None
    s = text.strip().split("/")[0]
    try:
        obj = ipaddress.ip_address(s)
    except ValueError:
        return None
    return IpValue(obj.version, obj.packed, str(obj), obj)


def parse_cidr(text: str) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, IpValue, IpValue] | None:
    """解析 CIDR；返回 (network, 网络地址值, 规范化 cidr 文本)；非法返回 None。
    容忍主机位非零（strict=False 自动归零，PRD 要求录入网络地址，此处宽容处理但记录归零）。"""
    if not text or "/" not in str(text):
        return None
    try:
        net = ipaddress.ip_network(str(text).strip(), strict=False)
    except ValueError:
        return None
    if net.prefixlen == 0 and str(text).strip() not in ("0.0.0.0/0", "::/0"):
        pass  # 允许默认路由粒度，由调用方按需限制
    host_zero = str(net)
    nv = IpValue(net.version, net.network_address.packed, str(net.network_address), net.network_address)
    return net, nv, host_zero


def ip_in_subnet(ip_text: str, cidr: str) -> bool:
    """判断 ip 是否属于 cidr 网段"""
    v = parse_ip(ip_text)
    try:
        net = ipaddress.ip_network(cidr, strict=False)
    except ValueError:
        return False
    return v is not None and v.obj in net


# ---------- 容量展示 ----------

def subnet_capacity(net: ipaddress._BaseNetwork, prefix_len: int) -> int | None:
    """可用地址数（扣除网络/广播，仅 v4）；v6 大网段超 2^32 返回 None（用 humanize 展示）"""
    total = net.num_addresses
    if net.version == 4:
        usable = max(0, total - 2)
        return usable
    # v6：2^(128-prefix)，> 2^32 无法安全展示 → None
    if 128 - prefix_len > 32:
        return None
    return net.num_addresses


def humanize_capacity(net: ipaddress._BaseNetwork) -> str:
    """v6 大网段容量的科学计数展示，如 ≈ 1.2×10²⁴"""
    bits = 128 - net.prefixlen
    approx = float(2) ** bits
    exp = bits * 0.30103
    e = int(exp)
    mant = 10 ** (exp - e)
    return f"≈ {mant:.1f}×10^{e}"


# ---------- NAT 校验 ----------

def validate_nat(public_port: int, private_port: int, proto: str) -> str | None:
    """校验 NAT 映射参数；返回错误信息或 None
    规则（PRD §3.7.2 / §7）：端口 1-65535；public_port=0 表示 1:1 全端口，此时 proto 必须 any；
    1:1 时 private_port 也应为 0。"""
    if proto not in NAT_PROTOS:
        return f"协议必须为 {'/'.join(NAT_PROTOS)}"
    for p in (public_port, private_port):
        if not (0 <= p <= 65535):
            return "端口范围 0-65535"
    if public_port == 0:
        if proto != "any":
            return "公网端口为 0（1:1 全端口）时协议必须为 any"
        if private_port != 0:
            return "1:1 映射私网端口也应为 0"
    else:
        if proto == "any":
            return "指定端口映射协议不能为 any（请用 tcp/udp）"
    return None


# ---------- 导入校验 ----------

def check_mac(mac: str | None) -> str | None:
    """MAC 校验 + 统一为冒号分隔大写（裸串自动补冒号）；空值返回 None"""
    if mac is None or str(mac).strip() in ("", "-"):
        return None
    s = str(mac).strip()
    if not _MAC_RE.match(s):
        raise ValueError(f"MAC 格式非法: {mac}")
    clean = s.replace("-", "").replace(":", "").upper()
    return ":".join(clean[i:i + 2] for i in range(0, 12, 2))


def check_icp(icp: str | None) -> str | None:
    if icp is None or str(icp).strip() in ("", "-"):
        return None
    s = str(icp).strip()
    if not _ICP_RE.match(s):
        raise ValueError(f"备案号格式非法: {icp}")
    return s


def check_date(v) -> date | None:
    """解析 YYYY-MM-DD / YYYY/M/D；空返回 None"""
    if v is None or str(v).strip() in ("", "-"):
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    s = str(v).strip().replace("/", "-").replace(".", "-")
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"日期格式非法（应为 YYYY-MM-DD）: {v}")


def parse_domains(v) -> list | None:
    """域名列表解析：JSON 数组 或 分号/逗号分隔字符串 → [{name,rr,icp_no}]"""
    if v is None or str(v).strip() in ("", "-"):
        return None
    s = str(v).strip()
    try:
        arr = json.loads(s)
        if isinstance(arr, list):
            out = []
            for d in arr:
                if isinstance(d, dict) and d.get("name"):
                    out.append({"name": str(d["name"]).strip(), "rr": str(d.get("rr", "A")),
                                "icp_no": d.get("icp_no") or None})
            return out or None
    except (ValueError, TypeError):
        pass
    names = [x.strip() for x in re.split(r"[;；,，]", s) if x.strip()]
    return [{"name": n, "rr": "A", "icp_no": None} for n in names] or None


def classify_import_row(kind: str, row: dict, existing_keys: dict,
                        subnet_index: list) -> tuple[str, dict | None, str | None]:
    """导入单行分类（纯函数，供预览与提交共用）
    kind: subnet/address/nat
    existing_keys: 已存在的唯一键 → 行数据（判定 🟢新增 vs 🟡更新）
    subnet_index: [(cidr_str, net_obj)] 用于地址网段匹配
    返回 (color, parsed_value, error)；color ∈ {insert, update, error}
    """
    try:
        if kind == "subnet":
            r = parse_cidr(str(row.get("cidr", "")))
            if r is None:
                return "error", None, "CIDR 格式非法"
            net, nv, cidr_text = r
            version = net.version
            zone = str(row.get("zone", "office")).strip() or "office"
            if zone not in ZONES:
                return "error", None, f"区域枚举非法: {zone}（可选 {'/'.join(ZONES)}）"
            scope = str(row.get("scope", "private")).strip() or "private"
            if scope not in ("private", "public"):
                return "error", None, f"scope 非法: {scope}"
            isp = row.get("isp")
            if isp and str(isp).strip() not in ("", "-") and str(isp).strip() not in ISPS:
                return "error", None, f"运营商枚举非法: {isp}（可选 {'/'.join(ISPS)}）"
            gw = row.get("gateway")
            if gw and parse_ip(str(gw)) is None:
                return "error", None, f"网关 IP 非法: {gw}"
            val = {
                "version": version, "cidr": cidr_text, "net_packed": nv.packed,
                "prefix_len": net.prefixlen, "name": str(row.get("name") or cidr_text).strip()[:64],
                "zone": zone, "vlan_id": int(row["vlan_id"]) if str(row.get("vlan_id", "")).strip().isdigit() else None,
                "gateway": parse_ip(str(gw)).text if gw and parse_ip(str(gw)) else None,
                "scope": scope, "isp": str(isp).strip() if isp and str(isp).strip() not in ("", "-") else None,
                "bandwidth_mbps": int(row["bandwidth_mbps"]) if str(row.get("bandwidth_mbps", "")).strip().isdigit() else None,
                "contract_end": str(check_date(row.get("contract_end")) or "") or None,
                "icp_no": check_icp(row.get("icp_no")),
                "note": str(row.get("note") or "").strip()[:255] or None,
            }
            key = (version, cidr_text)
            return ("update" if key in existing_keys else "insert"), val, None

        if kind == "address":
            v = parse_ip(str(row.get("ip", "")))
            if v is None:
                return "error", None, f"IP 格式非法: {row.get('ip')}"
            subnet_id = None
            for cidr, sid, netobj in subnet_index:
                if v.obj in netobj:
                    subnet_id = sid
                    break
            if subnet_id is None:
                return "error", None, f"IP {v.text} 未命中任何已录入网段（请先导入网段）"
            status = str(row.get("status", "free")).strip() or "free"
            status = {"在用": "allocated", "已分配": "allocated", "预留": "reserved",
                      "空闲": "free", "冲突": "conflict", "禁用": "disabled"}.get(status, status)
            if status not in STATUSES:
                return "error", None, f"状态枚举非法: {row.get('status')}"
            try:
                mac = check_mac(row.get("mac"))
            except ValueError as e:
                return "error", None, str(e)
            atype = row.get("asset_type")
            atype = {"物理机": "physical", "VM": "vm", "虚拟机": "vm", "网络设备": "network",
                     "打印机": "printer", "其他": "other"}.get(str(atype).strip(), str(atype).strip()) if atype else None
            if atype and atype not in ASSET_TYPES:
                return "error", None, f"资产类型枚举非法: {atype}（可选 {'/'.join(ASSET_TYPES)}）"
            val = {
                "subnet_id": subnet_id, "version": v.version, "addr_packed": v.packed,
                "ip_text": v.text, "status": status,
                "hostname": str(row.get("hostname") or "").strip()[:64] or None,
                "mac": mac, "asset_type": atype or None,
                "asset_ref": str(row.get("asset_ref") or "").strip()[:64] or None,
                "owner": str(row.get("owner") or "").strip()[:32] or None,
                "dept": str(row.get("dept") or "").strip()[:32] or None,
                "purpose": str(row.get("purpose") or "").strip()[:128] or None,
                "domains": json.dumps(parse_domains(row.get("domains")), ensure_ascii=False) if parse_domains(row.get("domains")) else None,
                "note": str(row.get("note") or "").strip()[:255] or None,
            }
            key = (v.version, v.packed)
            return ("update" if key in existing_keys else "insert"), val, None

        if kind == "nat":
            pub = parse_ip(str(row.get("public_ip", "")))
            priv = parse_ip(str(row.get("private_ip", "")))
            if pub is None:
                return "error", None, f"公网 IP 非法: {row.get('public_ip')}"
            if priv is None:
                return "error", None, f"私网 IP 非法: {row.get('private_ip')}"
            def _port(x):
                s = str(x or "0").strip() or "0"
                return int(s) if s.isdigit() else -1
            pp, vp = _port(row.get("public_port")), _port(row.get("private_port"))
            proto = str(row.get("proto", "tcp")).strip().lower() or "tcp"
            err = validate_nat(pp, vp, proto)
            if err:
                return "error", None, err
            if str(row.get("public_ip")) not in existing_keys:
                return "error", None, f"公网 IP {pub.text} 不在地址台账（请先导入地址）"
            if str(row.get("private_ip")) not in existing_keys:
                return "error", None, f"私网 IP {priv.text} 不在地址台账（请先导入地址）"
            val = {
                "public_ip_id": existing_keys[str(row.get("public_ip"))]["id"],
                "public_port": pp, "proto": proto,
                "private_ip_id": existing_keys[str(row.get("private_ip"))]["id"],
                "private_port": vp,
                "note": str(row.get("note") or "").strip()[:128] or None,
            }
            key = (pub.packed, pp, proto, priv.packed, vp)
            return ("update" if key in existing_keys else "insert"), val, None

        return "error", None, f"未知导入类型: {kind}"
    except (ValueError, TypeError) as e:
        return "error", None, str(e)
    except Exception as e:  # 防脏数据炸整个预览
        return "error", None, f"解析异常: {e}"
