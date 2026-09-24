"""
交换机 SSH 会话模块 — 华为 VRP
- paramiko invoke_shell 交互式抓取（VRP 大量 display 命令无法用 exec_command 获得完整输出）
- 屏蔽分页: screen-length 0 temporary
- 提示符匹配: <hostname> / [hostname-xxx] 两种形态
- 全部为阻塞实现，调用方用 asyncio.to_thread 包装
- PRD: docs/PRD-华为交换机备份.md §3.3 / §6
"""
import re
import time
import socket

import paramiko


class SwSSHError(Exception):
    """kind: auth_failed | unreachable | timeout | session"""


# 模块级正则（SwSession 与纯函数共用，可单测）
PROMPT_RE = re.compile(r"^[<\[][\w\-.:/]+[\-\w.\s]*[>\]]\s*$")
MORE_RE = re.compile(r"^\s*---- More ----\s*$")
# 提示符 + 命令回显（如 "<S5720>display version"）
ECHO_RE_CACHE: dict[str, re.Pattern] = {}


def _echo_re(command: str) -> re.Pattern:
    pat = ECHO_RE_CACHE.get(command)
    if pat is None:
        pat = re.compile(r"^[<\[][\w\-.:/]+[>\]]\s*" + re.escape(command) + r"\s*$")
        ECHO_RE_CACHE[command] = pat
    return pat


class SwSession:
    """一次 SSH 交互会话（连接 → 关分页 → 执行 N 条命令 → 关闭）"""

    PROMPT_RE = PROMPT_RE
    _MORE_RE = MORE_RE

    def __init__(self, host: str, port: int, username: str, password: str,
                 timeout: float = 10.0, model: str = ""):
        self.host, self.port = host, port
        self.username, self.password = username, password
        self.timeout = timeout
        self.model = model
        self.client: paramiko.SSHClient | None = None
        self.shell = None
        self.hostname = ""

    # ---------- 连接管理 ----------

    # 老 VRP（V200R019 等）计算 4096-bit group16/18 KEX 极慢（实测 ~14s），
    # 禁用后回落到 group14-sha256 / group-exchange-sha256（2048-bit，秒级完成）
    _SLOW_KEX = ("diffie-hellman-group16-sha512", "diffie-hellman-group18-sha512")

    def connect(self):
        self.client = paramiko.SSHClient()
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            self.client.connect(
                self.host, port=self.port,
                username=self.username, password=self.password,
                timeout=self.timeout, allow_agent=False, look_for_keys=False,
                banner_timeout=30, auth_timeout=30,
                disabled_algorithms={"kex": list(self._SLOW_KEX)},
            )
        except paramiko.AuthenticationException as e:
            raise SwSSHError("auth_failed", f"SSH 认证失败: {e}") from e
        except (socket.timeout, TimeoutError) as e:
            raise SwSSHError("timeout", f"SSH 连接超时（{self.timeout}s）") from e
        except paramiko.SSHException as e:
            raise SwSSHError("session", f"SSH 协商失败: {e}") from e
        except OSError as e:
            raise SwSSHError("unreachable", f"网络不可达: {e}") from e

        self.shell = self.client.invoke_shell(width=511, height=1000)
        self._wait_prompt()                      # 等登录横幅结束出现提示符
        self.hostname = self._current_prompt_host()
        self.send("screen-length 0 temporary")   # 关闭分页

    def close(self):
        try:
            if self.shell:
                self.shell.close()
            if self.client:
                self.client.close()
        except Exception:
            pass

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *exc):
        self.close()

    # ---------- 交互原语 ----------

    def _wait_prompt(self, extra_timeout: float = 3.0):
        """阻塞直到缓冲区出现 VRP 提示符"""
        deadline = time.time() + self.timeout + extra_timeout
        buf = ""
        while time.time() < deadline:
            if self.shell.recv_ready():
                buf += self.shell.recv(65535).decode("utf-8", errors="replace")
                if self.PROMPT_RE.search(buf.splitlines()[-1] if buf.splitlines() else ""):
                    return
            else:
                time.sleep(0.05)
        raise SwSSHError("session", "等待 VRP 提示符超时")

    def _current_prompt_host(self) -> str:
        last = (self.shell.in_buffer or b"").decode("utf-8", errors="replace").strip().splitlines()
        if last:
            m = re.match(r"^[<\[]([\w\-.:/]+)", last[-1])
            if m:
                return m.group(1)
        return ""

    def send(self, command: str, output_timeout: float = 20.0) -> str:
        """发送一条命令并收集到提示符为止的输出（不含命令回显与结尾提示符）

        2026-09-22 备份失败修复（192.168.91.62 慢速设备）：
        - 输出等待超时不再「到点即死」：只要数据仍在持续到达（静默 idle < idle_timeout），
          就继续收；只有连续 idle_timeout 无新数据且未出现提示符才判超时。
          实测 .62 display current-configuration 完整输出需 ~40s / 417B/s，且输出为
          突发式（约 2.3KB 一批，批间停顿 >2s，实测 8s 阈值可完整收完），
          固定 30s 必超时；滑动窗口按数据活性判断后可完整收完。
        - 超时报错附带已收字节数，便于区分「设备慢」与「命令无响应」。
        """
        self.shell.send(command + "\n")
        hard_deadline = time.time() + max(output_timeout, 60.0) * 3   # 绝对上限 3x
        idle_timeout = 15.0                                           # 静默判定窗口（批间停顿实测 >2s，放宽到 15s）
        buf = ""
        last_data_at = time.time()
        while time.time() < hard_deadline:
            if self.shell.recv_ready():
                chunk = self.shell.recv(65535).decode("utf-8", errors="replace")
                buf += chunk
                last_data_at = time.time()
                # More 分页兜底（理论上 screen-length 0 已关，防御性处理）
                if self._MORE_RE.match(buf.splitlines()[-1] if buf.splitlines() else ""):
                    self.shell.send(" ")
                    continue
                if self.PROMPT_RE.search(buf.splitlines()[-1] if buf.splitlines() else ""):
                    return self._clean(command, buf)
            else:
                time.sleep(0.05)
                if time.time() - last_data_at >= idle_timeout:
                    break          # 数据流已静默且未见提示符：再等无意义
        raise SwSSHError(
            "timeout",
            f"命令输出等待超时: {command}（已接收 {len(buf)} 字节，"
            f"{'输出缓慢未完成' if buf else '无任何输出'}）")

    def _clean(self, command: str, raw: str) -> str:
        """去掉命令回显行（含"提示符+命令"形态）与提示符/More 行"""
        echo = _echo_re(command)
        out = [ln for ln in raw.splitlines()
               if ln.strip() != command
               and not echo.match(ln.strip())
               and not self._MORE_RE.match(ln)
               and not self.PROMPT_RE.match(ln.strip())]
        return "\n".join(out).replace("\x1b[K", "").rstrip("\r\n ")

    # ---------- 业务命令 ----------

    def get_running_config(self) -> str:
        """抓取当前运行配置（从第一个 # 行开始，去掉回显头部）

        output_timeout=60：慢速设备（如 .62 实测 40s+）的完整输出保底；
        实际由 send() 的静默窗口决定何时结束，快设备不受影响。
        """
        raw = self.send("display current-configuration", output_timeout=60.0)
        return clean_config_output(raw)

    def get_version(self) -> dict:
        """display version → {vrp, uptime}"""
        raw = self.send("display version")
        return parse_version(raw)

    def get_health(self) -> dict:
        """巡检采集: cpu / memory（完整采集用 sw_backup.collect_health_blocking）"""
        cpu = parse_cpu(self.send("display cpu-usage"))
        mem = parse_memory(self.send("display memory-usage"))
        return {"cpu_pct": cpu, "mem_pct": mem}


# ---------- 纯解析函数（可单测） ----------

def collect_health_blocking(dev: dict) -> dict:
    """
    在线巡检采集（阻塞，PRD §3.5）。SSH 登录成功即 online=1。
    单会话顺序采集 version/cpu/mem/interfaces/alarms/environment；
    可选命令（部分型号不支持）失败不致命，对应字段置 None/空。
    dev 需含 mgmt_ip/ssh_port/username/password(明文)。
    """
    out: dict = {"online": 1, "cpu_pct": None, "mem_pct": None, "uptime": "",
                 "vrp": "", "temp_max": None, "alarms": [], "interfaces": []}
    with SwSession(dev["mgmt_ip"], dev["ssh_port"], dev["username"], dev["password"],
                   timeout=10.0, model=dev.get("model", "")) as s:
        out["hostname"] = s.hostname
        for cmd, key, fn in (
            ("display version", "_ver", parse_version),
            ("display cpu-usage", "cpu_pct", parse_cpu),
            ("display memory-usage", "mem_pct", parse_memory),
            ("display interface brief", "interfaces", parse_interfaces),
            ("display environment", "temp_max", parse_environment),
            ("display temperature all", "temp_max", parse_environment),
            ("display alarm urgent", "alarms", parse_alarms),
        ):
            if key == "temp_max" and out["temp_max"] is not None:
                continue                  # 前一命令已取得温度，跳过备用命令
            try:
                res = fn(s.send(cmd, output_timeout=15.0))
            except SwSSHError:
                continue                      # 命令不支持/超时：字段保持 None/空
            if key == "_ver":
                out["vrp"] = res.get("vrp", "")
                out["uptime"] = res.get("uptime", "")
            elif key in ("interfaces", "alarms"):
                out[key] = res
            else:
                out[key] = res
    return out


def clean_config_output(raw: str) -> str:
    """配置正文从第一个以 # 开头的行开始，丢弃前导回显/横幅与结尾提示符/More 行"""
    lines = raw.splitlines()
    start = None
    for i, ln in enumerate(lines):
        if ln.strip().startswith("#"):
            start = i
            break
    if start is None:
        return raw.strip("\r\n") + "\n"
    body = [ln for ln in lines[start:]
            if not PROMPT_RE.match(ln.strip()) and not MORE_RE.match(ln)]
    return "\n".join(body).strip("\r\n") + "\n"


def parse_version(raw: str) -> dict:
    """解析 display version → {vrp, uptime}"""
    vrp, uptime = "", ""
    m = re.search(r"Version\s+(\S+)\s*,", raw) or re.search(r"(V\d+R\d+[\w.]*)", raw)
    if m:
        vrp = m.group(1)
    m = re.search(r"System\s+uptime\s+is\s+(.+)", raw) or re.search(r"uptime\s+is\s+(.+)", raw, re.I)
    if m:
        uptime = m.group(1).strip().rstrip(",")
    return {"vrp": vrp, "uptime": uptime}


def parse_cpu(raw: str) -> float | None:
    """解析 display cpu-usage 的系统 CPU 占用百分比"""
    m = re.search(r"CPU\s+Usage\s*[::]?\s*(\d+(?:\.\d+)?)\s*%", raw, re.I)
    if not m:
        m = re.search(r"(\d+(?:\.\d+)?)\s*%\s*(?:CPU|system)", raw, re.I)
    return float(m.group(1)) if m else None


def parse_memory(raw: str) -> float | None:
    """解析 display memory-usage 的内存占用百分比
    兼容两种 VRP 形态：
      Memory Using Percentage Is: 54%
      Memory Using Percentage : 54%
    """
    m = re.search(r"Memory\s+Using\s+Percentage\s+(?:Is\s*)?[::]?\s*(\d+(?:\.\d+)?)\s*%", raw, re.I)
    if not m:
        m = re.search(r"Using\s+Percentage\s+(?:Is\s*)?[::]?\s*(\d+(?:\.\d+)?)\s*%", raw, re.I)
    if not m:
        # 兜底：含 Percentage 的行里找第一个百分比
        for ln in raw.splitlines():
            if "percentage" in ln.lower():
                m = re.search(r"(\d+(?:\.\d+)?)\s*%", ln)
                if m:
                    return float(m.group(1))
        return None
    return float(m.group(1))


def parse_interfaces(raw: str) -> list[dict]:
    """解析 display interface brief → [{interface, phy, protocol, in_uti, out_uti, in_errors, out_errors}]
    兼容有无 inErrors/outErrors 列两种 VRP 表头；PHY 取值 up / down / *down / ^down。
    """
    rows = []
    started = False
    for ln in raw.splitlines():
        s = ln.strip()
        if not started:
            if s.startswith("Interface") and ("PHY" in s or "Phy" in s):
                started = True
            continue
        if not s or s.startswith("-"):
            continue
        parts = s.split()
        if len(parts) < 4:
            break                       # 正文结束（后面是注释/空行）
        iface, phy, proto = parts[0], parts[1].lstrip("*^"), parts[2]
        if phy not in ("up", "down"):
            break
        # 过滤逻辑口：只保留物理/聚合口（PRD §3.5 端口状态）
        if iface.startswith(("Vlanif", "LoopBack", "NULL", "Tunnel", "MEth")):
            continue
        row = {"interface": iface, "phy": phy, "protocol": proto,
               "in_uti": parts[3], "out_uti": parts[4] if len(parts) > 4 else "",
               "in_errors": parts[5] if len(parts) > 5 else None,
               "out_errors": parts[6] if len(parts) > 6 else None}
        rows.append(row)
    return rows


def parse_environment(raw: str) -> float | None:
    """解析 display environment / display temperature all 的最高温度 °C
    兼容三种形态：
      A. display environment 表格:  0  Hotspot1  Normal  46 ...
      B. display temperature all:   0  NA  NA  Normal  25  -3  1  65  61
         （列序 Slot Card Sensor Status Current(C) ...，温度在状态字之后）
      C. 简式: Temperature : 46 (C)
    """
    status_words = ("normal", "abnormal", "alarm", "fall", "rise", "ok")
    temps = []
    for ln in raw.splitlines():
        s = ln.strip()
        if not s or s.startswith("-"):
            continue
        low = s.lower()
        if low.startswith(("slot", "sensor", "error:", "info:")):
            continue
        # A/B: 状态列后的第一个数字即当前温度
        parts = s.split()
        matched = False
        for i, tok in enumerate(parts[:-1]):
            if tok.lower() in status_words:
                m = re.match(r"^(-?\d+(?:\.\d+)?)", parts[i + 1])
                if m:
                    temps.append(float(m.group(1)))
                matched = True
                break
        if matched:
            continue
        # C: Temperature : 46 (C)
        m = re.search(r"Temperature[^0-9]{0,10}(\d+(?:\.\d+)?)", s, re.I)
        if m:
            temps.append(float(m.group(1)))
    return max(temps) if temps else None


def parse_alarms(raw: str) -> list[str]:
    """解析 display alarm urgent → 活动告警行列表（最多 20 行；无告警/命令不支持返回空）"""
    out = []
    for ln in raw.splitlines():
        s = ln.strip()
        if not s or s.startswith("-"):
            continue
        low = s.lower()
        if low.startswith(("info:", "slot", "alarm  class", "alarm class")) or "no alarm" in low \
                or "无告警" in s or "not support" in low or "unrecognized" in low:
            continue
        out.append(s)
        if len(out) >= 20:
            break
    return out


# ---------- diff（可单测） ----------

def diff_counts(old_text: str, new_text: str) -> tuple[int, int]:
    """unified diff 统计 (+N 行, -N 行)"""
    import difflib
    added = removed = 0
    for ln in difflib.unified_diff(
            old_text.splitlines(), new_text.splitlines(), lineterm="", n=0):
        if ln.startswith("+") and not ln.startswith("+++"):
            added += 1
        elif ln.startswith("-") and not ln.startswith("---"):
            removed += 1
    return added, removed


def unified_diff_text(old_text: str, new_text: str,
                      old_label: str = "old", new_label: str = "new") -> str:
    import difflib
    return "\n".join(difflib.unified_diff(
        old_text.splitlines(), new_text.splitlines(),
        fromfile=old_label, tofile=new_label, lineterm=""))
