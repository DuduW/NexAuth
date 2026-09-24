#!/usr/bin/env bash
###############################################################################
# 企业网络管理平台 · 一键部署脚本 v1.1（Ubuntu 22.04 LTS）
#
# 用法：
#   sudo bash install.sh              # 交互式（提示确认数据重置等）
#   sudo bash install.sh --auto       # 全自动（测试环境；已有数据时跳过重新导库）
#
# 组件：MariaDB + FreeRADIUS3 + radius-admin(FastAPI/venv) + portal-server
#       + nginx + admin-spa + detail_sync 等 cron
# 前置：Ubuntu 22.04 · 可出网（apt/pip）· root · 磁盘剩余 ≥ 2GB
#
# v1.1 健壮性修正：
#   - 修复 mods-config-sql 安装路径错误（v1.0 从未生效）
#   - 修复重复执行时 /etc/freeradius/3.0 嵌套拷贝问题
#   - 库内已有数据时交互确认，防 DROP TABLE 清库（--auto 跳过导库）
#   - 随机密钥改用 openssl；ExecStart 改写后强校验；trap ERR 带行号
###############################################################################
set -euo pipefail

# ---------- 配置区（可按需修改；密码请避免 & 和 | 字符） ----------
DB_NAME="radius"
DB_USER="radius"
DB_PASS="CHANGE_ME_DB_PASS"                 # ← 生产务必修改
RADIUS_SECRET="Huawei@Radius123"      # NAS 共享密钥（与 AC/交换机侧一致）
SW_MASTER_KEY=""                      # 留空自动生成
ADMIN_UI_USER="admin"
PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
PAYLOAD="$PKG_DIR/payload"
LOGF="/var/log/deploy-install.log"
AUTO=0
[[ "${1:-}" == "--auto" ]] && AUTO=1

log() { echo -e "[$(date '+%H:%M:%S')] $*" | tee -a "$LOGF"; }
die() { log "❌ $*"; exit 1; }
trap 'log "❌ 异常退出：$0:$LINENO（最后命令：${BASH_COMMAND}）"' ERR

# ---------- 预检 ----------
[[ $EUID -eq 0 ]]          || die "请用 root 运行：sudo bash $0"
[[ -d "$PAYLOAD/freeradius" && -d "$PAYLOAD/db" && -d "$PAYLOAD/opt" ]] \
                           || die "payload 不完整，请在部署包根目录执行（需含 freeradius/db/opt/frontend）"
[[ -f "$PAYLOAD/db/schema.sql" && -f "$PAYLOAD/db/seed.sql" ]] || die "db/schema.sql 或 seed.sql 缺失"
[[ -f /etc/lsb-release ]]  || die "仅支持 Ubuntu"
. /etc/lsb-release
[[ "$DISTRIB_RELEASE" == "22.04" ]] || log "⚠ 系统 $DISTRIB_RELEASE 非 22.04，继续执行（未验证）…"
AVAIL_GB=$(df -BG / | awk 'NR==2{gsub("G","");print $4}')
[[ "${AVAIL_GB:-0}" -ge 2 ]] || die "磁盘剩余 ${AVAIL_GB:-?}GB < 2GB，中止"
command -v openssl >/dev/null || die "openssl 缺失（异常的系统）"

log "================ 开始部署（v1.1） ================"

# ---------- 1. 系统依赖 ----------
log "[1/9] 安装系统依赖（apt）…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >>"$LOGF" 2>&1
apt-get install -y -qq freeradius freeradius-mysql mariadb-server nginx \
  python3 python3-pip python3-venv cron rsync curl openssl >>"$LOGF" 2>&1 \
  || die "apt 安装失败，查看 $LOGF"

# ---------- 2. Python 环境 ----------
log "[2/9] Python venv + 依赖…"
if [[ ! -x /opt/radius-admin-venv/bin/python ]]; then
  python3 -m venv /opt/radius-admin-venv
fi
/opt/radius-admin-venv/bin/pip install -q --upgrade pip >>"$LOGF" 2>&1
/opt/radius-admin-venv/bin/pip install -q fastapi uvicorn aiomysql paramiko \
  cryptography pyotp apscheduler pymysql python-jose pydantic python-multipart >>"$LOGF" 2>&1 \
  || die "pip 依赖安装失败"
/opt/radius-admin-venv/bin/python -c "import fastapi, aiomysql, paramiko, jose, pyotp, multipart" \
  || die "venv 依赖自检失败"
# cron 脚本走系统 python3（Ubuntu22 PEP668）
if ! python3 -c "import pymysql" 2>/dev/null; then
  python3 -m pip install -q --break-system-packages pymysql >>"$LOGF" 2>&1 \
    || python3 -m pip install -q pymysql >>"$LOGF" 2>&1 \
    || log "⚠ 系统 pymysql 失败，detail_sync 将不可用（自检会再报）"
fi

# ---------- 3. MariaDB ----------
log "[3/9] MariaDB 初始化…"
systemctl enable --now mariadb >>"$LOGF" 2>&1 || systemctl enable --now mysql >>"$LOGF" 2>&1
if [[ $AUTO -eq 1 ]]; then
  MYSQL_ROOT_PW=""
elif [[ ! -t 0 ]]; then
  MYSQL_ROOT_PW=""   # 非交互 stdin（管道/脚本调用）：尝试 socket 免密
else
  read -rp "MariaDB root 密码（新装机默认为空，直接回车）: " MYSQL_ROOT_PW
fi
MY() {
  if [[ -z "$MYSQL_ROOT_PW" ]]; then mysql -uroot "$@"; else mysql -uroot -p"$MYSQL_ROOT_PW" "$@"; fi
}
MY -e "SELECT 1" >/dev/null 2>&1 || die "MariaDB root 连接失败（密码错误？）"
MY -e "CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
MY -e "CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS'; ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';"
MY -e "GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;"

# 数据保护：schema 含 DROP TABLE，已有数据时必须人工确认
HAS_DATA=$(MY -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME' AND table_name='radcheck'" 2>/dev/null || echo 0)
if [[ "$HAS_DATA" == "1" ]]; then
  ROWS=$(MY -N "$DB_NAME" -e "SELECT COUNT(*) FROM radcheck" 2>/dev/null || echo 0)
  if [[ "$ROWS" -gt 0 ]]; then
    if [[ $AUTO -eq 1 ]]; then
      log "  ⚠ radcheck 已有 ${ROWS} 行数据，--auto 模式跳过重新导库（结构保持现状）"
      SKIP_DB_IMPORT=1
    elif [[ ! -t 0 ]]; then
      log "  ⚠ radcheck 已有 ${ROWS} 行数据，且 stdin 非交互——为安全起见跳过导库（如需重置请交互运行）"
      SKIP_DB_IMPORT=1
    else
      read -rp "radcheck 已有 ${ROWS} 行数据。重新导库将【清空全部数据】，确认？输入 yes 继续: " ANS
      [[ "$ANS" == "yes" ]] || { log "  跳过导库，保留现有数据"; SKIP_DB_IMPORT=1; }
    fi
  fi
fi
if [[ "${SKIP_DB_IMPORT:-0}" != "1" ]]; then
  MY "$DB_NAME" < "$PAYLOAD/db/schema.sql" || die "schema.sql 导入失败"
  MY "$DB_NAME" < "$PAYLOAD/db/seed.sql"   || die "seed.sql 导入失败"
  log "  DB 就绪：$DB_NAME（${DB_USER}/${DB_PASS}）"
fi

# ---------- 4. FreeRADIUS ----------
log "[4/9] FreeRADIUS 配置…"
systemctl stop freeradius 2>/dev/null || true
# 原厂配置首次备份；本目录每次全新铺放（防嵌套拷贝）
if [[ ! -d /etc/freeradius/3.0.orig ]]; then
  [[ -d /etc/freeradius/3.0 ]] && mv /etc/freeradius/3.0 /etc/freeradius/3.0.orig
fi
rm -rf /etc/freeradius/3.0
cp -a "$PAYLOAD/freeradius" /etc/freeradius/3.0
# 原装骨架补齐（no-clobber，payload 优先；v1.3: payload 已含 radiusd.conf + 全量 mods-config，此处仅兜底）
for d in mods-config mods-available sites-available; do
  [[ -d "/etc/freeradius/3.0.orig/$d" ]] && cp -an "/etc/freeradius/3.0.orig/$d" /etc/freeradius/3.0/ 2>/dev/null || true
done
# 主配置文件强校验（v1.3: v1.2 曾因缺 radiusd.conf 失败）
[[ -s /etc/freeradius/3.0/radiusd.conf ]] || die "radiusd.conf 缺失（payload 不完整）"

# 证书全新生成（v1.6）：绝不复用 payload/源环境的旧证书
# payload/certs 仅含自签骨架（Makefile/bootstrap/*.cnf/dh），make 全新生成 CA+服务端证书
log "  重新生成 EAP 证书（全新 CA，不复用源环境证书）…"
CERT_DIR=/etc/freeradius/3.0/certs
[[ -f "$CERT_DIR/Makefile" ]] || die "certs 自签骨架缺失（payload 不完整）"
# 骨架 cnf 国家字段统一（源机 client.cnf 历史遗留 FR 与 CA 的 CN 不一致会导致 openssl ca 拒签）
sed -i 's|^countryName[[:space:]]*=[[:space:]]*FR|countryName\t\t= CN|' "$CERT_DIR"/*.cnf
make -C "$CERT_DIR" clean >>"$LOGF" 2>&1 || true
# 只签 CA + 服务端（EAP 服务端场景 client.crt 非必需，客户端证书由管理后台按人签发）
make -C "$CERT_DIR" ca.pem >>"$LOGF" 2>&1 \
  || { make -C "$CERT_DIR" ca.pem 2>&1 | tail -20; die "CA 自签失败（查看 $LOGF）"; }
make -C "$CERT_DIR" server >>"$LOGF" 2>&1 \
  || { make -C "$CERT_DIR" server 2>&1 | tail -20; die "服务端证书自签失败（查看 $LOGF）"; }
# 自签结果校验：ca.pem / server.pem 存在且起始年份为今年
for cf in ca.pem server.pem; do
  [[ -s "$CERT_DIR/$cf" ]] || die "自签后 $cf 缺失"
done
openssl x509 -in "$CERT_DIR/server.pem" -noout -startdate 2>/dev/null | grep -q "$(date +%Y)" \
  || log "  ⚠ 服务端证书起始年份非今年，请人工复核（$CERT_DIR/server.pem）"
chown -R freerad:freerad "$CERT_DIR"
log "  证书已全新生成（CA: 部署机自签，需在 AC/终端侧重新信任）"

# DB 密码回填 sql 模块（仅 sql{} 段的 password 行，避免误伤）
sed -i "s|^[[:space:]]*password[[:space:]]*=.*|    password = \"$DB_PASS\"|" /etc/freeradius/3.0/mods-enabled/sql
grep -q "\"$DB_PASS\"" /etc/freeradius/3.0/mods-enabled/sql || die "sql 模块密码回填失败"
chown -R freerad:freerad /etc/freeradius/3.0
# 语法校验（freerad 身份，贴近运行时权限）
su -s /bin/sh freerad -c "freeradius -XC" >>"$LOGF" 2>&1 \
  || { su -s /bin/sh freerad -c "freeradius -XC" 2>&1 | tail -20; die "freeradius -XC 校验失败"; }
systemctl enable --now freeradius >>"$LOGF" 2>&1
sleep 1
systemctl is-active freeradius >/dev/null || { journalctl -u freeradius -n 20 --no-pager; die "freeradius 启动失败"; }
log "  FreeRADIUS 运行（1812/1813/3799）"

# ---------- 5. /opt 应用 ----------
log "[5/9] 部署 /opt 应用…"
mkdir -p /opt /opt/radius-admin/sw-backups
rsync -a --delete --exclude='sw-backups/' --exclude='__pycache__' "$PAYLOAD/opt/radius-admin/" /opt/radius-admin/
for f in portal_server.py detail_sync.py vpn_visit_collector.py zt_acl_sync.py zt_access_collector.py health_check.sh; do
  [[ -f "$PAYLOAD/opt/$f" ]] && cp -a "$PAYLOAD/opt/$f" /opt/
done
# DB 密码回填后端（仅默认值行）
sed -i "s|DB_PASS = .*|DB_PASS = \"$DB_PASS\"|" /opt/radius-admin/core/config.py
grep -q "\"$DB_PASS\"" /opt/radius-admin/core/config.py || die "config.py 密码回填失败"
# portal/采集脚本的 DB 密码（源文件内联硬编码，同样回填）
for f in /opt/portal_server.py /opt/detail_sync.py /opt/vpn_visit_collector.py; do
  [[ -f "$f" ]] && sed -i "s|\"CHANGE_ME_DB_PASS\"|\"$DB_PASS\"|g" "$f"
done
# SW_MASTER_KEY（openssl，避免 xxd 依赖）
[[ -z "$SW_MASTER_KEY" ]] && SW_MASTER_KEY=$(openssl rand -hex 32)

# ---------- 6. systemd ----------
log "[6/9] systemd 服务…"
sed -e "s|ExecStart=/usr/bin/python3 -m uvicorn|ExecStart=/opt/radius-admin-venv/bin/python -m uvicorn|" \
    -e "s|After=network.target mysql.service|After=network.target mariadb.service mysql.service|" \
    "$PAYLOAD/systemd/radius-admin.service" > /etc/systemd/system/radius-admin.service
grep -q "/opt/radius-admin-venv/bin/python" /etc/systemd/system/radius-admin.service \
  || die "radius-admin.service ExecStart 改写失败（payload 单元格式变化？）"
if [[ -f "$PAYLOAD/systemd/portal-server.service" ]]; then
  install -m 644 "$PAYLOAD/systemd/portal-server.service" /etc/systemd/system/portal-server.service
else
  cat > /etc/systemd/system/portal-server.service <<'EOF'
[Unit]
Description=Huawei Portal Protocol Server
After=network.target
[Service]
ExecStart=/usr/bin/python3 -u /opt/portal_server.py
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
fi
# SW_MASTER_KEY 注入
if grep -q "SW_MASTER_KEY=" /etc/systemd/system/radius-admin.service; then
  sed -i "s|Environment=SW_MASTER_KEY=.*|Environment=SW_MASTER_KEY=$SW_MASTER_KEY|" /etc/systemd/system/radius-admin.service
else
  sed -i "/^\[Service\]/a Environment=SW_MASTER_KEY=$SW_MASTER_KEY" /etc/systemd/system/radius-admin.service
fi
systemctl daemon-reload
systemctl enable --now radius-admin portal-server >>"$LOGF" 2>&1
sleep 2
for svc in radius-admin portal-server; do
  systemctl is-active $svc >/dev/null || { journalctl -u $svc -n 20 --no-pager; die "$svc 启动失败"; }
done

# ---------- 7. nginx ----------
log "[7/9] nginx…"
rm -f /etc/nginx/sites-enabled/default
install -m 644 "$PAYLOAD/nginx/default" /etc/nginx/sites-available/platform
ln -sf /etc/nginx/sites-available/platform /etc/nginx/sites-enabled/platform
mkdir -p /var/www/html
nginx -t >>"$LOGF" 2>&1 || { nginx -t 2>&1; die "nginx -t 失败"; }
systemctl enable --now nginx >>"$LOGF" 2>&1
systemctl reload nginx

# ---------- 8. 前端 ----------
log "[8/9] admin-spa 前端…"
rm -rf /var/www/html/admin-spa
cp -a "$PAYLOAD/frontend/admin-spa" /var/www/html/admin-spa
[[ -f /var/www/html/admin-spa/index.html ]] || die "前端 index.html 缺失"

# ---------- 9. crontab ----------
log "[9/9] cron 任务…"
CRON_TMP=$(mktemp)
crontab -l 2>/dev/null | grep -vE '/opt/(detail_sync|health_check|vpn_visit_collector|zt_acl_sync|zt_access_collector)' > "$CRON_TMP" || true
cat >> "$CRON_TMP" <<'EOF'
* * * * * python3 /opt/detail_sync.py >> /var/log/detail_sync.log 2>&1
*/2 * * * * /opt/health_check.sh >> /var/log/health_check.log 2>&1
* * * * * /usr/bin/python3 /opt/vpn_visit_collector.py >> /var/log/vpn_visit.log 2>&1; sleep 30; /usr/bin/python3 /opt/vpn_visit_collector.py >> /var/log/vpn_visit.log 2>&1
EOF
crontab "$CRON_TMP"; rm -f "$CRON_TMP"
systemctl enable --now cron >>"$LOGF" 2>&1 || true

# ---------- 卸载辅助 ----------
cat > /opt/deploy-uninstall.sh <<'EOF'
#!/usr/bin/env bash
# 卸载本平台（v2：修 nginx 软链删除与 reload 保护、FreeRADIUS 停服选择、尾注信息补全）
set -e
echo "== 卸载企业网络管理平台 =="
# 1. 停自研服务
systemctl disable --now radius-admin portal-server 2>/dev/null || true
rm -f /etc/systemd/system/radius-admin.service /etc/systemd/system/portal-server.service
systemctl daemon-reload
# 2. 清 cron（幂等）
crontab -l 2>/dev/null | grep -vE '/opt/(detail_sync|health_check|vpn_visit_collector|zt_acl_sync|zt_access_collector)' | crontab - || true
# 3. 删应用
rm -rf /opt/radius-admin /opt/radius-admin-venv /opt/portal_server.py /opt/detail_sync.py \
       /opt/vpn_visit_collector.py /opt/zt_acl_sync.py /opt/zt_access_collector.py /opt/health_check.sh \
       /opt/deploy-uninstall.sh
# 4. nginx 站点（sites-enabled 下是软链，-f 直接删；reload 失败不中断）
rm -f /etc/nginx/sites-enabled/platform /etc/nginx/sites-available/platform
systemctl reload nginx 2>/dev/null || true
# 5. 前端
rm -rf /var/www/html/admin-spa
# 6. FreeRADIUS：默认停止并禁用（保留配置与 3.0.orig 备份，重装可复用）
#    如需彻底移除配置：rm -rf /etc/freeradius && apt purge freeradius freeradius-mysql
systemctl disable --now freeradius 2>/dev/null || true
echo "== 卸载完成 =="
echo "已停用/移除：radius-admin、portal-server、cron 任务、/opt 应用、nginx 站点、admin-spa、freeradius 服务(已停用,配置保留)"
echo "保留未动：MariaDB radius 库（手工删除: mysql -e 'DROP DATABASE radius'）、/etc/freeradius 配置"
EOF
chmod +x /opt/deploy-uninstall.sh

# ---------- 自检 ----------
log "================ 自检 ================"
PASS=0; FAIL=0
check() {
  if eval "$2" >>"$LOGF" 2>&1; then log "  ✅ $1"; PASS=$((PASS+1)); else log "  ❌ $1（详见 $LOGF）"; FAIL=$((FAIL+1)); fi
}
check "MariaDB 运行"        "systemctl is-active mariadb || systemctl is-active mysql"
check "FreeRADIUS 运行"     "systemctl is-active freeradius"
check "radiusd.conf 存在"     "test -s /etc/freeradius/3.0/radiusd.conf"
check "sql 模块非空"        "test -s /etc/freeradius/3.0/mods-enabled/sql"
check "eap 模块非空"        "test -s /etc/freeradius/3.0/mods-enabled/eap"
check "RADIUS 1812 监听"    "ss -ulnp | grep -q ':1812 '"
check "RADIUS 1813 监听"    "ss -ulnp | grep -q ':1813 '"
check "radius-admin 运行"   "systemctl is-active radius-admin"
check "SW_MASTER_KEY 已注入" "systemctl show radius-admin -p Environment --value | grep -q SW_MASTER_KEY"
check "API :8000 探活"      "curl -sf -o /dev/null http://127.0.0.1:8000/api/services/status"
check "后台登录可用"         "curl -sf -X POST http://127.0.0.1:8000/api/auth/login -H 'Content-Type: application/json' -d '{\"username\":\"admin\",\"password\":\"admin123\"}' | grep -q token"
check "EAP 证书为全新自签"   "openssl x509 -in /etc/freeradius/3.0/certs/server.pem -noout -startdate 2>/dev/null | grep -q '$(date +%Y)'"
check "portal-server 运行"  "systemctl is-active portal-server"
check "Portal :8080"        "curl -sf -o /dev/null http://127.0.0.1:8080/"
check "nginx 运行"          "systemctl is-active nginx"
check "admin-spa 首页"      "curl -sf -o /dev/null http://127.0.0.1/admin-spa/"
check "radacct 表可查"      "mysql -u$DB_USER -p$DB_PASS $DB_NAME -e 'SELECT 1 FROM radacct LIMIT 1'"
check "radcheck 初始账号"   "mysql -u$DB_USER -p$DB_PASS $DB_NAME -N -e \"SELECT username FROM radcheck WHERE username='$ADMIN_UI_USER' LIMIT 1\" | grep -q ."
check "detail_sync 手跑"    "python3 /opt/detail_sync.py"

IP=$(hostname -I | awk '{print $1}')
cat <<EOF

============================================================
 🎉 部署完成（v1.1）：自检通过 $PASS / $((PASS+FAIL)) 项
------------------------------------------------------------
 后台地址    : http://$IP/admin-spa/   （初始账号: $ADMIN_UI_USER / admin123 —— 首次登录后立即修改！）
 API         : http://$IP:8000/api/
 Portal 认证 : http://$IP:8080/  · UDP 50100
 RADIUS      : $IP  UDP 1812 认证 / 1813 记账 / 3799 CoA
 数据库      : $DB_NAME（$DB_USER / $DB_PASS）
 卸载辅助    : /opt/deploy-uninstall.sh（逐条确认后执行）
 安装日志    : $LOGF
------------------------------------------------------------
 ⚠️ 生产上线前必做：
   1. 修改后台 admin 密码（初始 admin123 已明示，务必立即改）
   2. RADIUS_SECRET（clients.conf 需与 AC/交换机一致）
   3. EAP 证书为本机全新自签——AC/终端需重新信任新 CA（/etc/freeradius/3.0/certs/ca.pem）
   4. AC/交换机侧 NAS 指向本机 IP
   （本包不含任何源环境数据：用户/设备/证书/日志均为全新）
============================================================
EOF
[[ $FAIL -eq 0 ]] && log "全部通过 ✅" || log "存在失败项 ❌ —— 逐项排查后再交付"
exit $FAIL
