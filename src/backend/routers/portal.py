"""Portal Server 管理 API"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import subprocess, re

router = APIRouter()
SERVICE = "portal-server"
CONFIG_PATH = "/opt/portal_server.py"

def read_config():
    """读取 portal_server.py 中的变量"""
    try:
        with open(CONFIG_PATH) as f:
            code = f.read()
        return {
            "ac_ip": re.search(r'AC_IP\s*=\s*"([^"]+)"', code).group(1),
            "shared_secret": re.search(r'SHARED_SECRET\s*=\s*b"([^"]+)"', code).group(1),
            "web_port": re.search(r'WEB_PORT\s*=\s*(\d+)', code).group(1),
            "portal_port": re.search(r'PORTAL_PORT\s*=\s*(\d+)', code).group(1),
            "radius_secret": re.search(r'RADIUS_SECRET\s*=\s*b"([^"]+)"', code).group(1),
            "token_days": re.search(r'TOKEN_DAYS\s*=\s*(\d+)', code).group(1),
            "code": code,
        }
    except Exception as e:
        raise HTTPException(500, str(e))

def write_config(key, value):
    """更新 portal_server.py 中的变量"""
    cfg = read_config()
    code = cfg["code"]
    if key == "ac_ip":
        code = re.sub(r'(AC_IP\s*=\s*)"[^"]*"', rf'\1"{value}"', code)
    elif key == "shared_secret":
        code = re.sub(r'(SHARED_SECRET\s*=\s*b)"[^"]*"', f'\\1b"{value}"', code)
    elif key == "web_port":
        code = re.sub(r'(WEB_PORT\s*=\s*)\d+', rf'\1{value}', code)
    elif key == "portal_port":
        code = re.sub(r'(PORTAL_PORT\s*=\s*)\d+', rf'\1{value}', code)
    elif key == "radius_secret":
        code = re.sub(r'(RADIUS_SECRET\s*=\s*b)"[^"]*"', f'\\1b"{value}"', code)
    elif key == "token_days":
        code = re.sub(r'(TOKEN_DAYS\s*=\s*)\d+', rf'\1{value}', code)
    else:
        raise HTTPException(400, f"未知配置项: {key}")
    # Back up before overwriting
    import shutil, time
    shutil.copy2(CONFIG_PATH, CONFIG_PATH + f'.bak.{int(time.time())}')
    with open(CONFIG_PATH, "w") as f:
        f.write(code)

@router.get("/portal/status")
async def portal_status():
    """Portal 服务状态 + 完整配置"""
    result = {"running": False}
    try:
        r = subprocess.run(["systemctl", "is-active", SERVICE], capture_output=True, text=True)
        result["running"] = r.stdout.strip() == "active"
    except:
        pass
    try:
        cfg = read_config()
        result.update({
            "ac_ip": cfg["ac_ip"],
            "shared_secret": "*" * len(cfg["shared_secret"]),
            "web_port": int(cfg["web_port"]),
            "portal_port": int(cfg["portal_port"]),
            "radius_secret": "*" * len(cfg["radius_secret"]),
            "token_days": int(cfg["token_days"]),
        })
    except:
        pass
    return result

@router.post("/portal/{action}")
async def portal_control(action: str):
    """start | stop | restart"""
    if action not in ("start", "stop", "restart"):
        return {"error": "invalid action"}
    r = subprocess.run(["systemctl", action, SERVICE], capture_output=True, text=True)
    return {"ok": r.returncode == 0, "action": action, "msg": r.stderr or r.stdout}

class ConfigUpdate(BaseModel):
    key: str
    value: str

@router.put("/portal/config")
async def portal_config_update(cfg: ConfigUpdate):
    """更新 Portal 配置并重启"""
    write_config(cfg.key, cfg.value)
    subprocess.run(["systemctl", "restart", SERVICE], capture_output=True)
    return {"ok": True, "key": cfg.key, "value": cfg.value}
