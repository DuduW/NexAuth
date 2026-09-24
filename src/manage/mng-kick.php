<?php
/**
 * Kick online user via RADIUS CoA Disconnect
 */
include_once implode(DIRECTORY_SEPARATOR, [ __DIR__, '..', 'common', 'includes', 'config_read.php' ]);
include implode(DIRECTORY_SEPARATOR, [ $configValues['OPERATORS_LIBRARY'], 'checklogin.php' ]);

$radacctid = $_GET['radacctid'] ?? '';
$sessionid = $_GET['acctsessionid'] ?? '';
$nasip = $_GET['nasip'] ?? '';
$user = $_GET['user'] ?? '';

if (!$sessionid || !$nasip) {
    header("Location: home-main.php");
    exit;
}

// Use custom DB connection (not $dbSocket which isn't available here)
$mysqli = new mysqli('127.0.0.1', 'radius', 'CHANGE_ME_DB_PASS', 'radius');
if ($mysqli->connect_error) { die("DB error"); }

// Get user's MAC before kicking (for clearing MAC bypass)
$mac = '';
$res = $mysqli->query("SELECT callingstationid FROM radacct WHERE radacctid='$radacctid'");
if ($row = $res->fetch_assoc()) {
    $mac = $row['callingstationid'];
}

// Get NAS secret
$secret = 'testing123';
$stmt = $mysqli->prepare("SELECT secret FROM nas WHERE nasname = ?");
$stmt->bind_param('s', $nasip);
$stmt->execute();
$res = $stmt->get_result();
if ($row = $res->fetch_row()) {
    $secret = $row[0];
}
$stmt->close();

// Send CoA Disconnect to NAS (UDP 3799)
$attrs = "Acct-Session-Id=$sessionid";
$cmd = sprintf('echo %s | radclient -r 1 -t 3 %s:3799 disconnect %s 2>&1',
    escapeshellarg($attrs), escapeshellarg($nasip), escapeshellarg($secret));
$output = [];
$returnCode = 0;
exec($cmd, $output, $returnCode);
$outputStr = implode("\n", $output);

// Mark session as stopped in DB
$mysqli->query("UPDATE radacct SET acctstoptime=NOW(), acctterminatecause='Admin-Reset' WHERE radacctid='$radacctid'");

// Clear MAC bypass: delete from radmacbypass + radcheck so user must re-authenticate
if ($mac) {
    $no_sep = str_replace(['-',':','.'], '', strtolower($mac));
    $colon = implode(':', str_split($no_sep, 2));
    foreach ([$mac, $no_sep, $colon] as $m) {
        if ($m) {
            $mysqli->query("DELETE FROM radmacbypass WHERE mac='$m'");
            $mysqli->query("DELETE FROM radcheck WHERE username='$m'");
        }
    }
}
$mysqli->close();

// Redirect back with result
$result = ($returnCode === 0 && stripos($outputStr, 'ACK') !== false) ? 'ok' : 'fail';
header("Location: home-main.php?kick=$result&user=" . urlencode($user));
