"""
Radius Admin FastAPI - 核心入口
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from core.database import init_db, close_db
from core.config import CORS_ORIGINS
from routers import dashboard, users, online, macpass, qos, authlog, groups, services, nas, accounting, server_stats, radius_config, totp, vpn, auth, portal, zt, nac, profiles, certs, sw, ip


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[STARTUP] Initializing database pool...")
    try:
        await init_db()
        print("[STARTUP] Database pool initialized OK")
    except Exception as e:
        print(f"[STARTUP] Database pool FAILED: {e}")
        raise
    print("[STARTUP] Starting backup scheduler...")
    from core.sw_scheduler import start_scheduler
    start_scheduler()
    print("[STARTUP] Starting VPN session probe (wg dump 采集)...")
    from core.vpn_probe import start_probe
    start_probe()
    yield
    print("[SHUTDOWN] Stopping VPN session probe...")
    from core.vpn_probe import shutdown_probe
    shutdown_probe()
    print("[SHUTDOWN] Stopping backup scheduler...")
    from core.sw_scheduler import shutdown_scheduler
    shutdown_scheduler()
    print("[SHUTDOWN] Closing database pool...")
    await close_db()

app = FastAPI(
    title="Radius Admin API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc"
)

@app.on_event("startup")
async def startup():
    print("[EVENT] Startup event fired")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 注册路由
app.include_router(dashboard.router, prefix="/api", tags=["Dashboard"])
app.include_router(users.router, prefix="/api", tags=["Users"])
app.include_router(groups.router, prefix="/api", tags=["Groups"])
app.include_router(online.router, prefix="/api", tags=["Online"])
app.include_router(macpass.router, prefix="/api", tags=["MAC Bypass"])
app.include_router(qos.router, prefix="/api", tags=["QoS"])
app.include_router(authlog.router, prefix="/api", tags=["Auth Log"])
app.include_router(services.router, prefix="/api", tags=["Services"])
app.include_router(nas.router, prefix="/api", tags=["NAS"])
app.include_router(accounting.router, prefix="/api", tags=["Accounting"])
app.include_router(server_stats.router, prefix="/api", tags=["Server Stats"])
app.include_router(radius_config.router, prefix="/api", tags=["RADIUS Config"])
app.include_router(totp.router, prefix="/api", tags=["TOTP"])
app.include_router(vpn.router, prefix="/api", tags=["VPN"])
app.include_router(auth.router, prefix="/api", tags=["Auth"])
app.include_router(portal.router, prefix="/api", tags=["Portal"])
app.include_router(zt.router, prefix="/api", tags=["ZeroTrust"])
app.include_router(nac.router, prefix="/api", tags=["NAC"])
app.include_router(profiles.router, prefix="/api", tags=["User Profiles"])
app.include_router(certs.router, prefix="/api", tags=["Client Certificates"])
app.include_router(sw.router, prefix="/api", tags=["Switch Backup"])
app.include_router(ip.router, prefix="/api", tags=["IP Asset"])
