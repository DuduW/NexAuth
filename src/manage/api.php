<?php
/**
 * 企业网络管理平台 API
 */
header('Content-Type: application/json; charset=utf-8');

$db = new mysqli('127.0.0.1', 'radius', 'CHANGE_ME_DB_PASS', 'radius');
if ($db->connect_errno) { echo json_encode(['error' => 'DB failed']); exit; }

$action = $_GET['action'] ?? 'dashboard';
$method = $_SERVER['REQUEST_METHOD'];

// ── 首页统计
if ($action === 'dashboard') {
    $online = $db->query("SELECT COUNT(*) FROM radacct WHERE acctstoptime IS NULL")->fetch_row()[0];
    $todayAuth = $db->query("SELECT COUNT(*) FROM radpostauth WHERE authdate >= CURDATE()")->fetch_row()[0];
    $macCount = $db->query("SELECT COUNT(*) FROM radmacbypass WHERE expires_at > NOW()")->fetch_row()[0];
    $traffic = $db->query("SELECT ROUND(SUM(acctinputoctets+acctoutputoctets)/1073741824,1) FROM radacct WHERE acctstoptime IS NULL")->fetch_row()[0];
    echo json_encode(['online'=>(int)$online, 'today_auth'=>(int)$todayAuth, 'mac_bypass'=>(int)$macCount, 'traffic'=>(float)($traffic??0)]);
    exit;
}

// ── 在线用户
if ($action === 'online') {
    $res = $db->query("SELECT radacctid, username, callingstationid AS mac, framedipaddress AS ip, acctstarttime, ROUND(acctinputoctets/1048576,2) AS up_mb, ROUND(acctoutputoctets/1048576,2) AS down_mb, acctsessiontime FROM radacct WHERE acctstoptime IS NULL ORDER BY acctstarttime DESC");
    $rows = []; while ($r = $res->fetch_assoc()) $rows[] = $r;
    echo json_encode($rows); exit;
}

// ── 认证日志
if ($action === 'authlog') {
    $res = $db->query("SELECT id, username, reply, authdate FROM radpostauth ORDER BY id DESC LIMIT 50");
    $rows = []; while ($r = $res->fetch_assoc()) $rows[] = $r;
    echo json_encode($rows); exit;
}

// ── 用户列表（从 radcheck 找真人用户）
if ($action === 'users') {
    $res = $db->query("SELECT rc.id, rc.username, rc.value AS password, rug.groupname, rmb.expires_at AS mac_expiry FROM radcheck rc LEFT JOIN radusergroup rug ON rc.username=rug.username LEFT JOIN radmacbypass rmb ON rc.username=rmb.username WHERE rc.attribute='Cleartext-Password' AND rc.username NOT LIKE '%:%' AND rc.username NOT LIKE '%-%' AND LENGTH(rc.username)!=12 ORDER BY rc.id");
    $rows = []; while ($r = $res->fetch_assoc()) $rows[] = $r;
    echo json_encode($rows); exit;
}

// ── 创建用户（三张表一起写）
if ($action === 'create_user' && $method === 'POST') {
    $u = trim($_POST['username'] ?? '');
    $p = $_POST['password'] ?? '';
    $g = trim($_POST['group'] ?? 'group-guest');
    if (!$u || !$p) { echo json_encode(['ok'=>false,'msg'=>'用户名密码不能为空']); exit; }
    $err = null;
    $db->begin_transaction();
    if (!$db->query("INSERT INTO radcheck (username,attribute,op,value) VALUES ('$u','Cleartext-Password',':=','$p')")) $err = $db->error;
    if (!$err && !$db->query("INSERT IGNORE INTO radusergroup (username,groupname,priority) VALUES ('$u','$g',1)")) $err = $db->error;
    if (!$err && !$db->query("INSERT IGNORE INTO userinfo (username,firstname,creationdate,creationby) VALUES ('$u','$u',NOW(),'manage')")) $err = $db->error;
    if ($err) { $db->rollback(); echo json_encode(['ok'=>false,'msg'=>'创建失败：'.$err]); }
    else { $db->commit(); echo json_encode(['ok'=>true,'msg'=>"用户 $u 创建成功"]); }
    exit;
}

// ── 删除用户
if ($action === 'delete_user' && $method === 'POST') {
    $u = $_POST['username'] ?? '';
    $db->query("DELETE FROM radcheck WHERE username='$u'");
    $db->query("DELETE FROM radusergroup WHERE username='$u'");
    $db->query("DELETE FROM radreply WHERE username='$u'");
    $db->query("DELETE FROM userinfo WHERE username='$u'");
    echo json_encode(['ok'=>true]); exit;
}

// ── QoS 策略
if ($action === 'qos') {
    $res = $db->query("SELECT id, groupname, attribute, op, value FROM radgroupreply ORDER BY groupname, id");
    $rows = []; while ($r = $res->fetch_assoc()) $rows[] = $r;
    echo json_encode($rows); exit;
}

if ($action === 'update_qos' && $method === 'POST') {
    $id = (int)($_POST['id'] ?? 0); $val = $_POST['value'] ?? '';
    $db->query("UPDATE radgroupreply SET value='$val' WHERE id=$id");
    echo json_encode(['ok'=>true]); exit;
}

// ── MAC 免认证
if ($action === 'macs') {
    $res = $db->query("SELECT id, mac, username, created_at, expires_at, CASE WHEN expires_at>NOW() THEN 'valid' ELSE 'expired' END AS status FROM radmacbypass ORDER BY created_at DESC LIMIT 50");
    $rows = []; while ($r = $res->fetch_assoc()) $rows[] = $r;
    echo json_encode($rows); exit;
}

// ── TOTP 双因素 ──
if ($action === 'totp_enable' && $method === 'POST') {
    $u = $_POST['username'] ?? '';
    // Generate random Base32 secret (20 bytes → 32 chars)
    $secret = '';
    $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    for ($i = 0; $i < 32; $i++) $secret .= $chars[random_int(0, 31)];
    $db->query("INSERT INTO radtotp (username, secret, enabled) VALUES ('$u', '$secret', 1) ON DUPLICATE KEY UPDATE secret='$secret', enabled=1");
    if ($db->error) { echo json_encode(['ok'=>false,'msg'=>$db->error]); exit; }
    echo json_encode(['ok'=>true, 'secret'=>$secret, 'username'=>$u, 'issuer'=>'QCC-Network'], JSON_UNESCAPED_UNICODE);
    exit;
}
if ($action === 'totp_reset' && $method === 'POST') {
    $u = $_POST['username'] ?? '';
    $db->query("DELETE FROM radtotp WHERE username='$u'");
    echo json_encode(['ok'=>true]); exit;
}
if ($action === 'totp_status') {
    $res = $db->query("SELECT username, enabled, created FROM radtotp");
    $rows = []; while ($r = $res->fetch_assoc()) $rows[$r['username']] = ['enabled'=>(int)$r['enabled'], 'created'=>$r['created']];
    echo json_encode($rows); exit;
}

if ($action === 'mac_delete' && $method === 'POST') {
    $mac = $_POST['mac'] ?? '';
    $no_sep = str_replace(['-',':','.'], '', strtolower($mac));
    $db->query("DELETE FROM radcheck WHERE username IN ('$mac', '$no_sep')");
    $db->query("DELETE FROM radmacbypass WHERE mac='$mac'");
    echo json_encode(['ok' => true]); exit;
}



// ── 用户组 ──
if ($action === 'create_group' && $method === 'POST') {
    $name = trim($_POST['name'] ?? '');
    if (!$name) { echo json_encode(['ok'=>false,'msg'=>'组名不能为空']); exit; }
    // Ensure a radgroupreply baseline entry
    $db->query("INSERT IGNORE INTO radgroupreply (groupname, attribute, op, value) VALUES ('$name', 'Huawei-Input-Average-Rate', ':=', '4096000')");
    $db->query("INSERT IGNORE INTO radgroupreply (groupname, attribute, op, value) VALUES ('$name', 'Huawei-Output-Average-Rate', ':=', '8192000')");
    echo json_encode(['ok' => true]); exit;
}
if ($action === 'delete_group' && $method === 'POST') {
    $name = trim($_POST['name'] ?? '');
    $db->query("DELETE FROM radgroupreply WHERE groupname='$name'");
    $db->query("DELETE FROM radgroupcheck WHERE groupname='$name'");
    echo json_encode(['ok' => true]); exit;
}

// ── Clear auth log ──
if ($action === 'clear_authlog') {
    $db->query("TRUNCATE TABLE radpostauth");
    echo json_encode(['ok' => true]); exit;
}

echo json_encode(['error'=>'unknown action']);
