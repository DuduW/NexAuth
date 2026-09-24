#!/usr/bin/env python3
"""Parse FreeRADIUS detail files → MySQL radacct + auto MAC bypass (6 month)"""

import re, os, hashlib, pymysql

MONTHS = {"Jan":1,"Feb":2,"Mar":3,"Apr":4,"May":5,"Jun":6,
          "Jul":7,"Aug":8,"Sep":9,"Oct":10,"Nov":11,"Dec":12}

DETAIL_DIR = "/var/log/freeradius/radacct"
STATE_FILE = "/tmp/detail_sync_state.txt"
DB = {"host": "127.0.0.1", "user": "radius", "password": "CHANGE_ME_DB_PASS",
      "database": "radius", "charset": "utf8"}

# ── 工具函数 ──

def parse_time(raw):
    if not raw: return None
    m = re.search(r"(\w{3})\s+(\d+)\s+(\d{4})\s+(\d+):(\d+):(\d+)", raw)
    if m:
        return "{:04d}-{:02d}-{:02d} {:02d}:{:02d}:{:02d}".format(
            int(m.group(3)), MONTHS.get(m.group(1),1), int(m.group(2)),
            int(m.group(4)), int(m.group(5)), int(m.group(6)))
    m = re.search(r"\w{3}\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d{4})", raw)
    if m:
        return "{:04d}-{:02d}-{:02d} {:02d}:{:02d}:{:02d}".format(
            int(m.group(6)), MONTHS.get(m.group(1),1), int(m.group(2)),
            int(m.group(3)), int(m.group(4)), int(m.group(5)))
    return None

def parse_file(filepath, start_line=0):
    entries = []
    if not os.path.exists(filepath): return entries, 0
    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    cur, last = None, 0
    for i, line in enumerate(lines):
        if i < start_line: continue
        last = i + 1
        line = line.rstrip()
        if not line:
            if cur and cur.get("Acct-Status-Type"): entries.append((last, cur))
            cur = None; continue
        if not line.startswith("\t") and cur is None: cur = {"_ts": line}; continue
        if not cur: continue
        m = re.match(r"\t([\w-]+)\s*=\s*(.+)", line)
        if m: cur[m.group(1)] = m.group(2).strip().strip('"')
    if cur and cur.get("Acct-Status-Type"): entries.append((last, cur))
    return entries, last

# ── MAC 免认证 ──

def register_mac_bypass(cur, entry):
    """每次新 Acct-Start → 注册设备 MAC，6 个月内免 Portal"""
    mac = entry.get("Calling-Station-Id", "").strip()
    username = entry.get("User-Name", "").strip()
    if not mac or not username or len(mac) < 10: return

    no_sep = mac.replace("-","").replace(":","").replace(".","").lower()
    colon = ":".join(no_sep[i:i+2] for i in range(0,12,2)) if len(no_sep)==12 else ""

    for m in set([mac, no_sep, colon]) - {""}:
        cur.execute("INSERT INTO radcheck (username,attribute,op,value) VALUES (%s,'Cleartext-Password',':=',%s) ON DUPLICATE KEY UPDATE value=VALUES(value)", (m, no_sep))

    cur.execute(
        "INSERT INTO radmacbypass (mac,username,expires_at) VALUES (%s,%s,DATE_ADD(NOW(),INTERVAL 6 MONTH)) "
        "ON DUPLICATE KEY UPDATE username=VALUES(username),expires_at=DATE_ADD(NOW(),INTERVAL 6 MONTH)",
        (mac, username))

# ── Accounting 同步 ──

def sync_entries(entries, cur):
    for ln, entry in entries:
        sid = entry.get("Acct-Session-Id",""); uid = hashlib.md5(sid.encode()).hexdigest()
        stype = entry.get("Acct-Status-Type",""); ts = parse_time(entry.get("Event-Timestamp",entry.get("_ts","")))
        username = entry.get("User-Name",""); nasip = entry.get("NAS-IP-Address","")
        ip = entry.get("Framed-IP-Address",""); mac = entry.get("Calling-Station-Id","")
        ap = entry.get("Called-Station-Id",""); proto = entry.get("Framed-Protocol","")
        svc = entry.get("Service-Type",""); auth = entry.get("Acct-Authentic","")
        ptype = entry.get("NAS-Port-Type",""); cause = entry.get("Acct-Terminate-Cause","")
        in_bytes = int(entry.get("Acct-Input-Octets","0") or "0")
        out_bytes = int(entry.get("Acct-Output-Octets","0") or "0")
        sess_time = int(entry.get("Acct-Session-Time","0") or "0")

        if stype == "Start":
            register_mac_bypass(cur, entry)
            sql = """INSERT IGNORE INTO radacct
(acctsessionid,acctuniqueid,username,realm,nasipaddress,nasportid,nasporttype,
 acctstarttime,acctupdatetime,acctstoptime,acctsessiontime,acctauthentic,
 connectinfo_start,connectinfo_stop,acctinputoctets,acctoutputoctets,
 calledstationid,callingstationid,acctterminatecause,servicetype,framedprotocol,framedipaddress)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)"""
            cur.execute(sql, (sid,uid,username,"",nasip,"0",ptype,ts,ts,None,0,auth,"","",0,0,ap,mac,"",svc,proto,ip))

        elif stype == "Interim-Update":
            cur.execute("UPDATE radacct SET acctupdatetime=%s,acctsessiontime=%s,acctinputoctets=%s,acctoutputoctets=%s,framedipaddress=%s,callingstationid=%s WHERE acctuniqueid=%s",
                        (ts, sess_time, in_bytes, out_bytes, ip, mac, uid))

        elif stype == "Stop":
            cur.execute("SELECT radacctid FROM radacct WHERE acctuniqueid=%s", (uid,))
            if cur.fetchone():
                cur.execute("UPDATE radacct SET acctstoptime=%s,acctupdatetime=%s,acctsessiontime=%s,acctinputoctets=%s,acctoutputoctets=%s,acctterminatecause=%s WHERE acctuniqueid=%s",
                            (ts, ts, sess_time, in_bytes, out_bytes, cause, uid))
            else:
                cur.execute("""INSERT IGNORE INTO radacct
(acctsessionid,acctuniqueid,username,realm,nasipaddress,nasportid,nasporttype,
 acctstarttime,acctupdatetime,acctstoptime,acctsessiontime,acctauthentic,
 connectinfo_start,connectinfo_stop,acctinputoctets,acctoutputoctets,
 calledstationid,callingstationid,acctterminatecause,servicetype,framedprotocol,framedipaddress)
VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                            (sid,uid,username,"",nasip,"0",ptype,None,ts,ts,sess_time,auth,"","",in_bytes,out_bytes,ap,mac,cause,svc,proto,ip))

# ── 主程序 ──

def main():
    state = {}
    if os.path.exists(STATE_FILE):
        for line in open(STATE_FILE):
            if "=" in line: k,v=line.strip().split("=",1); state[k]=int(v)

    for root, dirs, files in os.walk(DETAIL_DIR):
        for fname in sorted(files):
            fp = os.path.join(root, fname)
            start = state.get(fp, 0)
            entries, last_line = parse_file(fp, start)
            if not entries: continue
            conn = pymysql.connect(**DB)
            cur = conn.cursor()
            try:
                sync_entries(entries, cur)
                conn.commit()
                state[fp] = entries[-1][0]
                print("OK %s: %s entries" % (fp, len(entries)))
            except Exception as e:
                print("FAIL %s: %s" % (fp, e))
                import traceback; traceback.print_exc()
            finally: conn.close()

    with open(STATE_FILE, "w") as f:
        for k,v in sorted(state.items()): f.write("%s=%s\n" % (k,v))

if __name__ == "__main__": main()
