"""
Services status API
"""
import subprocess
from fastapi import APIRouter

router = APIRouter()

SERVICE_NAMES = {
    "freeradius":    {"label": "FreeRADIUS",   "port": "1812/1813"},
    "mariadb":       {"label": "MariaDB",      "port": "3306"},
    "ssh":           {"label": "SSHd",         "port": "22"},
    "portal-server": {"label": "Portal Server", "port": "8080/50100"},
    "wg-quick@wg0":  {"label": "WireGuard VPN","port": ""},  # port from wg show
    "nginx":         {"label": "Nginx",        "port": "80"},
    "radius-admin":  {"label": "FastAPI",      "port": "8000"},
    "headscale":     {"label": "Headscale",    "port": "8081"},
    "tailscaled":    {"label": "Tailscale",    "port": "41641"},
}

@router.get("/services/status")
async def services_status():
    result = {}
    for svc, info in SERVICE_NAMES.items():
        status = "unknown"
        # WireGuard: check via wg show, not systemctl
        if svc == "wg-quick@wg0":
            try:
                r = subprocess.run(["wg", "show", "wg0"], capture_output=True, timeout=3, text=True)
                if r.returncode == 0:
                    status = "running"
                    # Extract listening port from wg show output
                    import re
                    m = re.search(r'listening port:\s*(\d+)', r.stdout)
                    port = m.group(1) if m else ""
                else:
                    status = "stopped"
                    port = ""
            except:
                status = "stopped"
                port = ""
            result[svc] = {"label": info["label"], "status": status, "port": port or info["port"]}
            continue
        try:
            r = subprocess.run(["systemctl", "is-active", svc], capture_output=True, text=True, timeout=3)
            status = "running" if r.stdout.strip() == "active" else "stopped"
        except:
            try:
                pgrep_name = {"ssh": "sshd", "portal-server": "portal_server", "wg-quick@wg0": "wg"}.get(svc, svc)
                if svc == "wg-quick@wg0":
                    # WireGuard check: wg show wg0
                    r = subprocess.run(["wg", "show", "wg0"], capture_output=True, timeout=3)
                    status = "running" if r.returncode == 0 else "stopped"
                else:
                    r = subprocess.run(["pgrep", "-c", pgrep_name], capture_output=True, timeout=3)
                    status = "running" if int(r.stdout.strip() or 0) > 0 else "stopped"
            except:
                pass
        result[svc] = {"label": info["label"], "status": status, "port": info["port"]}
    return result
