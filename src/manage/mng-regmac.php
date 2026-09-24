<?php
/**
 * Register MAC for bypass (6 months)
 * Triggered from home-main.php online users table
 */
include_once implode(DIRECTORY_SEPARATOR, [ __DIR__, '..', 'common', 'includes', 'config_read.php' ]);
include implode(DIRECTORY_SEPARATOR, [ $configValues['OPERATORS_LIBRARY'], 'checklogin.php' ]);

$mac = $_GET['mac'] ?? '';
$user = $_GET['user'] ?? '';

if (!$mac) {
    header("Location: home-main.php?regmac=fail");
    exit;
}

$mysqli = new mysqli('127.0.0.1', 'radius', 'CHANGE_ME_DB_PASS', 'radius');
if ($mysqli->connect_error) { die("DB error"); }

// Normalize MAC formats
$no_sep = str_replace(['-',':','.'], '', strtolower($mac));
$colon = implode(':', str_split($no_sep, 2));
$hyphen = implode('-', str_split($no_sep, 2));

// Register in radmacbypass (6 months)
foreach ([$mac, $hyphen, $no_sep, $colon] as $m) {
    if ($m) {
        $mysqli->query("INSERT INTO radmacbypass (mac, username, expires_at)
            VALUES ('$m', '$user', DATE_ADD(NOW(), INTERVAL 6 MONTH))
            ON DUPLICATE KEY UPDATE username='$user', expires_at=DATE_ADD(NOW(), INTERVAL 6 MONTH)");
    }
}

// Register in radcheck (password = MAC no-separator lowercase)
foreach ([$mac, $hyphen, $no_sep, $colon] as $m) {
    if ($m) {
        $mysqli->query("INSERT INTO radcheck (username, attribute, op, value)
            VALUES ('$m', 'Cleartext-Password', ':=', '$no_sep')
            ON DUPLICATE KEY UPDATE value='$no_sep'");
    }
}

$mysqli->close();
header("Location: home-main.php?regmac=ok&user=" . urlencode($user) . "&mac=" . urlencode($mac));
