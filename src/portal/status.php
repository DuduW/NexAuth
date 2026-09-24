<?php
/**
 * Service status API
 */
header('Content-Type: application/json');

$services = ['freeradius', 'mariadb', 'ssh', 'portal-server'];
$result = [];

// pgrep fallback names
$pgrepMap = ['freeradius' => 'freeradius', 'mariadb' => 'mariadbd', 'ssh' => 'sshd', 'portal-server' => 'portal_server'];

foreach ($services as $svc) {
    $status = 'unknown';
    $cmd = 'systemctl is-active ' . escapeshellarg($svc) . ' 2>/dev/null';
    exec($cmd, $output, $rc);
    $out = trim(implode('', $output));
    if ($out === 'active') { $status = 'running'; }
    else {
        // Fallback: use pgrep
        $pgrep = $pgrepMap[$svc] ?? $svc;
        exec('pgrep -c ' . escapeshellarg($pgrep) . ' 2>/dev/null', $pout, $prc);
        $count = intval(trim(implode('', $pout)));
        if ($count > 0) $status = 'running';
        else $status = 'stopped';
    }
    $result[$svc] = $status;
}

echo json_encode($result);
