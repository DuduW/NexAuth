"""
Radius Admin FastAPI - 核心配置
"""
import os

# MySQL
DB_HOST = os.getenv("RADIUS_DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("RADIUS_DB_PORT", "3306"))
DB_USER = os.getenv("RADIUS_DB_USER", "radius")
DB_PASS = os.getenv("RADIUS_DB_PASS", "CHANGE_ME_DB_PASS")
DB_NAME = os.getenv("RADIUS_DB_NAME", "radius")

# JWT
SECRET_KEY = os.getenv("JWT_SECRET", "radius-admin-secret-change-me")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 480

# CORS
CORS_ORIGINS = ["*"]
