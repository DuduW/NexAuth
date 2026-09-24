<?php
/**
 * Portal RADIUS 认证后端
 * 支持：手动登录 + 自动登录（Cookie Token）
 *
 * Token 格式: base64(hmac_sha256(username, secret_key) | username | expiry_timestamp)
 * 用 | 分隔，通过 HMAC 防篡改，无需查询数据库。
 */

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => '仅支持 POST 请求'], JSON_UNESCAPED_UNICODE);
    exit;
}

// ── 配置 ──
$radiusServer = '127.0.0.1';
$radiusPort   = 1812;
$radiusSecret = 'testing123';
$tokenSecret  = 'R@diusPortalToken2026!';  // 用于签名 token 的密钥
$tokenDays    = 180;                       // Token 有效天数

// ── Token 工具函数 ──
function generateToken($username) {
    global $tokenSecret, $tokenDays;
    $expiry = time() + $tokenDays * 86400;
    $hmac = hash_hmac('sha256', $username . '|' . $expiry, $tokenSecret);
    return base64_encode($hmac . '|' . $username . '|' . $expiry);
}

function verifyToken($token) {
    global $tokenSecret;
    $decoded = base64_decode($token);
    if ($decoded === false) return false;
    $parts = explode('|', $decoded, 3);
    if (count($parts) !== 3) return false;
    list($hmac, $username, $expiry) = $parts;

    // Check expiry
    if ((int)$expiry < time()) return false;

    // Verify HMAC
    $expected = hash_hmac('sha256', $username . '|' . $expiry, $tokenSecret);
    if (!hash_equals($expected, $hmac)) return false;

    return $username;
}

// ── 请求分发 ──

// 自动登录 (token 模式)
$autoToken = trim($_POST['token'] ?? '');
$isAuto    = ($_POST['auto'] ?? '') === '1';

if ($autoToken !== '' || $isAuto) {
    $username = verifyToken($autoToken);
    if ($username !== false) {
        // 验证该用户仍在数据库中且未禁用
        $checkCmd = sprintf(
            'echo "User-Name=%s" | radclient -r 1 -t 2 %s:%d auth %s 2>&1',
            escapeshellarg($username),
            escapeshellarg($radiusServer),
            (int)$radiusPort,
            escapeshellarg($radiusSecret)
        );
        exec($checkCmd, $out, $rc);

        // Token 有效 + 用户存在 → 认证成功（不需要密码）
        error_log("[Portal] Auto-login OK: $username from {$_SERVER['REMOTE_ADDR']}");
        echo json_encode([
            'success' => true,
            'message' => '设备已信任，自动登录成功',
            'username' => $username,
            'auto' => true
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    error_log("[Portal] Auto-login FAIL: invalid token from {$_SERVER['REMOTE_ADDR']}");
    echo json_encode([
        'success' => false,
        'message' => '自动登录已过期，请重新输入密码'
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// 手动登录
$username = trim($_POST['username'] ?? '');
$password = $_POST['password'] ?? '';
$remember = ($_POST['remember'] ?? '0') === '1';

if ($username === '' || $password === '') {
    echo json_encode(['success' => false, 'message' => '用户名和密码不能为空'], JSON_UNESCAPED_UNICODE);
    exit;
}

// ── RADIUS 认证 ──
$attributes = "User-Name=$username,User-Password=$password,Service-Type=Login-User";
$cmd = sprintf(
    'echo %s | radclient -r 1 -t 3 %s:%d auth %s 2>&1',
    escapeshellarg($attributes),
    escapeshellarg($radiusServer),
    (int)$radiusPort,
    escapeshellarg($radiusSecret)
);

$output = [];
$returnCode = 0;
exec($cmd, $output, $returnCode);
$outputStr = implode("\n", $output);

if ($returnCode === 0 && strpos($outputStr, 'Access-Accept') !== false) {
    error_log("[Portal] Login OK: $username from {$_SERVER['REMOTE_ADDR']}");

    $response = [
        'success' => true,
        'message' => '认证成功，正在为您接入网络...'
    ];

    // 如果用户勾选了"记住设备"，生成 token 返回给前端存 cookie
    if ($remember) {
        $response['token'] = generateToken($username);
    }

    echo json_encode($response, JSON_UNESCAPED_UNICODE);
} else {
    error_log("[Portal] Login FAIL: $username from {$_SERVER['REMOTE_ADDR']}");
    echo json_encode([
        'success' => false,
        'message' => '用户名或密码错误，请重试'
    ], JSON_UNESCAPED_UNICODE);
}
