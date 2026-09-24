<?php
/*
 *********************************************************************************************************
 * daloRADIUS - RADIUS Web Platform
 * Copyright (C) 2007 - Liran Tal <liran@lirantal.com> All Rights Reserved.
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public License
 * as published by the Free Software Foundation; either version 2
 * of the License, or (at your option) any later version.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA.
 *
 *********************************************************************************************************
 *
 * Description:    The script is a dashboard that retrieves and displays statistics related to
 *                 RADIUS users, NAS devices, and hotspots. It generates cards for each statistic,
 *                 fetches recent connection attempts and online users
 *                 and presents the data in formatted tables.
 * 
 * Authors:        Liran Tal <liran@lirantal.com>
 *                 Filippo Lauria <filippo.lauria@iit.cnr.it>
 *
 *********************************************************************************************************
 */

    include_once implode(DIRECTORY_SEPARATOR, [ __DIR__, '..', 'common', 'includes', 'config_read.php' ]);
    include implode(DIRECTORY_SEPARATOR, [ $configValues['OPERATORS_LIBRARY'], 'checklogin.php' ]);
    $operator = $_SESSION['operator_user'];

    include_once implode(DIRECTORY_SEPARATOR, [ $configValues['OPERATORS_LANG'], 'main.php' ]);
    include implode(DIRECTORY_SEPARATOR, [ $configValues['COMMON_INCLUDES'], 'layout.php' ]);
    include implode(DIRECTORY_SEPARATOR, [ $configValues['OPERATORS_INCLUDE_MANAGEMENT'], 'functions.php' ]);
    include implode(DIRECTORY_SEPARATOR, [ $configValues['OPERATORS_INCLUDE_MANAGEMENT'], 'pages_common.php' ]);
    include implode(DIRECTORY_SEPARATOR, [ $configValues['COMMON_INCLUDES'], 'db_open.php' ]);

    // setting table-related parameters first
    $tableSetting = [
        'postauth' => [
            'user' => ($configValues['FREERADIUS_VERSION'] == '1') ? 'user' : 'username',
            'date' => ($configValues['FREERADIUS_VERSION'] == '1') ? 'date' : 'authdate'
        ]
    ];

    // init logging variables
    $log = "visited page: ";
    $logAction = "";
    $logQuery = "performed query for all usernames on page: ";
    $logDebugSQL = "";

    // print HTML prologue
    $title = t('button', 'Dashboard');

    print_html_prologue($title, $langCode);

    // Custom styling
    echo <<<'HTML'
<style>
  .card { border: none; border-radius: 14px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); transition: transform 0.15s; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 3px 12px rgba(0,0,0,0.1); }
  .card-body { padding: 1.25rem; }
  .dashboard-card { border-radius: 12px; }
  .dashboard-table-wrapper { border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
  .dashboard-table { margin-bottom: 0; font-size: 0.875rem; }
  .dashboard-table thead th { background: #f8f9fb !important; border-bottom: 2px solid #e5e7eb !important; font-weight: 600; color: #4b5563; padding: 10px 12px; white-space: nowrap; }
  .dashboard-table tbody td { padding: 9px 12px; vertical-align: middle; border-color: #f3f4f6; }
  .dashboard-table tbody tr:hover { background: #f0f4ff; }
  .dashboard-table .btn { border-radius: 6px; }
  .dashboard-table .btn-outline-danger:hover { background: #fef2f2; }
  .alert { border-radius: 10px; }
  h1.fs-4 { font-weight: 700; color: #1f2937; }
  .card-title-section { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; margin-bottom: 0.5rem; font-weight: 600; }
  .card-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  @media (max-width: 768px) {
    .dashboard-table { font-size: 0.75rem; }
    .dashboard-table thead th, .dashboard-table tbody td { padding: 6px 8px; }
  }
</style>
HTML;

    // Consolidated SQL queries
    $total_users = count_users($dbSocket);
    $total_hotspots = count_hotspots($dbSocket);
    $total_nas = count_nas($dbSocket);


    function print_title($title, $href, $icon) {
        echo <<<HTML
        <span class="d-flex align-items-center justify-content-start mb-2">
            <h1 class="fs-4 m-0">{$title}</h1>
            <a class="ms-2 text-decoration-none" href="{$href}"><i class="bi $icon fs-6"></i></a>
        </span>
    HTML;
    }

    function print_dashboard_table_head($headers) {
        echo '<div class="table-responsive dashboard-table-wrapper mb-3">';
        echo '<table class="table table-hover table-striped dashboard-table"><tr>';
        
        foreach ($headers as $header) {
            printf('<th>%s</th>', $header);
        }

        echo '</tr>';
    }

    function print_dashboard_table_bottom() {
        echo '</table>';
        echo '</div>';
    }

    function print_dashboard_table_row($items) {
        echo '<tr>';
        foreach ($items as $item) {
            printf('<td>%s</td>', $item);
        }
        echo '</tr>';
    }

    function print_dashboard_info_message($message) {
        $message = htmlspecialchars($message, ENT_QUOTES, 'UTF-8');
        echo <<<EOF
        <div class="col-12 m-0">
          <div class="alert alert-info d-flex align-items-center" role="alert">
            <i class="bi bi-exclamation-triangle-fill me-2"></i>
            <div>{$message}</div>
          </div>
        </div>
        EOF;
    }

    function generateCard($title, $total, $linkText, $linkURL, $bgColor, $icon) {
        return <<<HTML
<div class="col-md-4 m-0 p-0">
    <div class="card m-1 rounded-0">
        <div class="row g-0">
            <div class="d-none d-md-flex col-md-2 text-bg-{$bgColor} align-items-center justify-content-center" style="--bs-bg-opacity: .9;">
                <i class="bi bi-{$icon} fs-2"></i>
            </div>
            <div class="col-md-10 p-1 d-flex align-items-center justify-content-center flex-column text-bg-{$bgColor}">
                <h5 class="card-title">{$title}</h5>
                <p class="card-text">{$total}</p>
                <a href="{$linkURL}" class="btn btn-light btn-sm">{$linkText}</a>
            </div>
        </div>
    </div>
</div>
   
HTML;
     
    }
    
    // Define card parameters

    $card_params = [
        [
            "title" => t('submenu', 'Users'),
            "total" => sprintf("%s: <strong>%d</strong>", t('all', 'Total'), $total_users),
            "linkText" => "用户列表",
            "linkURL" => "mng-list-all.php",
            "bgColor" => "success",
            "icon" => "people-fill"
        ],
        [
            "title" => t('submenu', 'Nas'),
            "total" => sprintf("%s: <strong>%d</strong>", t('all', 'Total'), $total_nas),
            "linkText" => "NAS 列表",
            "linkURL" => "mng-rad-nas-list.php",
            "bgColor" => "danger",
            "icon" => "router-fill"
        ],
        [
            "title" => t('submenu', 'Hotspots'),
            "total" => sprintf("%s: <strong>%d</strong>", t('all', 'Total'), $total_hotspots),
            "linkText" => "热点列表",
            "linkURL" => "mng-hs-list.php",
            "bgColor" => "primary",
            "icon" => "wifi"
        ]
    ];

    $version = t('all', 'daloRADIUS');
    $copyright = strip_tags(t('all', 'copyright2'));
    
    echo <<<HTML
<div class="d-flex align-items-center justify-content-between mb-3">
    <h1 class="fs-4 m-0 fw-bold">企业网络管理</h1>
    <a tabindex="0" class="text-decoration-none text-muted small" role="button" data-bs-trigger="focus" data-bs-toggle="popover" data-bs-placement="bottom" data-bs-title="{$version}" data-bs-content="{$copyright}">
        <i class="bi bi-c-circle me-1"></i>{$version}</a>
</div>

HTML;
    
    // Print cards using parameters
    echo '<div class="row mb-4">';
    foreach ($card_params as $params) {
        echo generateCard($params["title"], $params["total"], $params["linkText"], $params["linkURL"], $params["bgColor"], $params["icon"]);
    }
    echo '</div>';

    // Kick feedback
    $kick = $_GET['kick'] ?? '';
    $kickUser = $_GET['user'] ?? '';
    if ($kick === 'ok') {
        echo '<div class="alert alert-warning alert-dismissible fade show py-2"><i class="bi bi-box-arrow-right me-2"></i><strong>' . htmlspecialchars($kickUser) . '</strong> 已踢出，MAC 免认证已清除，设备需重新认证<button class="btn-close" data-bs-dismiss="alert"></button></div>';
    } elseif ($kick === 'fail') {
        echo '<div class="alert alert-danger alert-dismissible fade show py-2"><i class="bi bi-exclamation-triangle me-2"></i>踢出失败，请检查 NAS 是否支持 CoA (UDP 3799)<button class="btn-close" data-bs-dismiss="alert"></button></div>';
    }

    // Register MAC feedback
    $regmac = $_GET['regmac'] ?? '';
    $regmacMac = $_GET['mac'] ?? '';
    if ($regmac === 'ok') {
        echo '<div class="alert alert-success alert-dismissible fade show py-2"><i class="bi bi-shield-check me-2"></i><strong>' . htmlspecialchars($kickUser) . '</strong> 的 MAC <code>' . htmlspecialchars($regmacMac) . '</code> 已注册免认证（6个月）<button class="btn-close" data-bs-dismiss="alert"></button></div>';
    } elseif ($regmac === 'fail') {
        echo '<div class="alert alert-danger alert-dismissible fade show py-2"><i class="bi bi-exclamation-triangle me-2"></i>MAC 注册失败<button class="btn-close" data-bs-dismiss="alert"></button></div>';
    }

    // Clear auth log feedback
    $cleared = $_GET['cleared'] ?? '';
    if ($cleared === 'ok') {
        echo '<div class="alert alert-success alert-dismissible fade show py-2"><i class="bi bi-trash me-2"></i>连接记录已清空<button class="btn-close" data-bs-dismiss="alert"></button></div>';
    }

    ////////////////////////////////////////

    echo '<div class="row mb-4">';

    $sql = sprintf("SELECT %s AS `username`, reply, %s AS `datetime` FROM %s ORDER BY `datetime` DESC LIMIT 10",
                   $tableSetting['postauth']['user'], $tableSetting['postauth']['date'],
                   $configValues['CONFIG_DB_TBL_RADPOSTAUTH']);
    $res = $dbSocket->query($sql);
    $numrows = $res->numRows();

    echo '<div class="col-12 col-xl-6 m-0 px-3">';
    $title = t('button', 'LastConnectionAttempts');
    print_title($title, "rep-lastconnect.php", "bi-box-arrow-up-right");
    echo '<a href="mng-clear-authlog.php" class="btn btn-outline-secondary btn-sm ms-2" onclick="return confirm(\'确认清空所有连接记录？\')" title="清空日志"><i class="bi bi-trash"></i> 清空</a>';


    if ($numrows > 0) {
        $headers = array(t('all', 'Username'), t('all', 'RADIUSReply'), t('all', 'Date'));
        print_dashboard_table_head($headers);
        
        while ($row = $res->fetchRow()) {
            // Apply htmlspecialchars to each element of the row
            list($user, $reply, $datetime) = array_map(function($value) {
                return htmlspecialchars(trim($value), ENT_QUOTES, 'UTF-8');
            }, $row);

            $reply = sprintf('<span class="text-%s">%s</span>',
                            (($reply == "Access-Reject") ? "danger" : "success"), $reply);

            print_dashboard_table_row(array($user, $reply, $datetime));
        }

        print_dashboard_table_bottom();
    
    } else {
        print_dashboard_info_message('no data to show');
    }

    echo '</div>';

    echo '<div class="col-12 m-0 px-3">';
    print_title("MAC 免认证", "rep-online.php", "bi-shield-check");
    $mac_sql = "SELECT mac, username, created_at, expires_at FROM radmacbypass ORDER BY created_at DESC";
    $mac_res = $dbSocket->query($mac_sql);
    if ($mac_res && $mac_res->numRows() > 0) {
        print_dashboard_table_head(array('MAC 地址', '用户', '注册时间', '过期时间'));
        while ($row = $mac_res->fetchRow()) {
            list($m, $u, $c, $e) = array_map(function($v) { return htmlspecialchars(trim($v ?? '')); }, $row);
            $c_short = substr($c, 0, 16); $e_short = substr($e, 0, 10);
            $status = (strtotime($e) > time()) ? '<span class="badge bg-success">有效</span>' : '<span class="badge bg-secondary">过期</span>';
            print_dashboard_table_row(array("<code>$m</code>", $u, $c_short, $e_short . ' ' . $status));
        }
        print_dashboard_table_bottom();
    } else {
        print_dashboard_info_message('暂无 MAC 免认证记录');
    }
    echo '</div>';

    $sql = sprintf("SELECT `radacctid`, `username`, `acctstarttime`, `framedipaddress`, `callingstationid`,
                    `acctinputoctets`, `acctoutputoctets`, `acctsessiontime`,
                    `acctsessionid`, `nasipaddress`
                    FROM %s
                    WHERE `acctstoptime` IS NULL OR `acctstoptime`='0000-00-00 00:00:00'
                    ORDER BY `acctstarttime` DESC LIMIT 20",
                   $configValues['CONFIG_DB_TBL_RADACCT']);
    $res = $dbSocket->query($sql);
    $numrows = $res->numRows();

    $total_online = $numrows;
    $total_up = 0;
    $total_down = 0;

    echo '<div class="col-12 col-xl-6 m-0 px-3">';
    print_title('实时流量', "rep-online.php?orderBy=acctstarttime&orderType=desc", "bi-speedometer2");

    if ($numrows > 0) {
        print_dashboard_table_head(array(t('all', 'Username'), 'IP地址', 'MAC地址', '在线时长', '上行', '下行', '会话', ''));

        while ($row = $res->fetchRow()) {
            list($radacctid, $user, $start, $ip, $mac, $up, $down, $session, $acctsessionid, $nasip) = array_map(function($v) {
                return htmlspecialchars(trim($v ?? ''), ENT_QUOTES, 'UTF-8');
            }, $row);

            $total_up += intval($up);
            $total_down += intval($down);

            // Traffic formatting
            if ($up > 1073741824)      { $up_fmt = round($up/1073741824,2).' GB'; }
            elseif ($up > 1048576)     { $up_fmt = round($up/1048576,2).' MB'; }
            elseif ($up > 1024)        { $up_fmt = round($up/1024,2).' KB'; }
            else                       { $up_fmt = $up.' B'; }

            if ($down > 1073741824)    { $down_fmt = round($down/1073741824,2).' GB'; }
            elseif ($down > 1048576)   { $down_fmt = round($down/1048576,2).' MB'; }
            elseif ($down > 1024)      { $down_fmt = round($down/1024,2).' KB'; }
            else                       { $down_fmt = $down.' B'; }

            // Session time
            $sec = intval($session);
            if ($sec >= 3600)          { $session_fmt = floor($sec/3600).'h'.floor(($sec%3600)/60).'m'; }
            elseif ($sec >= 60)        { $session_fmt = floor($sec/60).'m'.($sec%60).'s'; }
            else                       { $session_fmt = $sec.'s'; }

            $start_short = substr($start, 5, 11);

            $kick_btn = sprintf('<a href="mng-kick.php?radacctid=%s&acctsessionid=%s&nasip=%s&user=%s" class="btn btn-outline-danger btn-sm py-0 px-1" title="%s" onclick="return confirm(\'%s\')"><i class="bi bi-box-arrow-right"></i></a>',
                $radacctid, urlencode($acctsessionid), $nasip, $user, htmlspecialchars("踢出 $user"), addslashes("确认踢出 $user 并强制重新认证？"));

            print_dashboard_table_row(array($user, $ip, $mac, $start_short, $up_fmt, $down_fmt, $session_fmt, $kick_btn));
        }

        print_dashboard_table_bottom();

        // Summary bar
        if ($total_up > 1073741824)      { $total_up_fmt = round($total_up/1073741824,2).' GB'; }
        else                             { $total_up_fmt = round($total_up/1048576,2).' MB'; }

        if ($total_down > 1073741824)    { $total_down_fmt = round($total_down/1073741824,2).' GB'; }
        else                             { $total_down_fmt = round($total_down/1048576,2).' MB'; }

        echo '<div class="alert alert-info d-flex justify-content-between mx-0 mb-3 py-2" role="alert">
            <span><i class="bi bi-people-fill me-1"></i> <strong>'.$total_online.'</strong> 人在线</span>
            <span><i class="bi bi-arrow-up-circle me-1"></i> '.$total_up_fmt.'</span>
            <span><i class="bi bi-arrow-down-circle me-1"></i> '.$total_down_fmt.'</span>
        </div>';

    } else {
        print_dashboard_info_message('暂无在线用户');
    }

    echo '</div>';

    // ---- QoS Bandwidth Policy Panel ----
    echo '<div class="col-12 col-xl-6 m-0 px-3">';
    print_title("QoS 带宽策略", "mng-rad-groupreply-list.php", "bi-gauge");
    $qos_sql = "SELECT attribute, value FROM radgroupreply WHERE groupname='group-guest' AND attribute LIKE 'Huawei%' ORDER BY id";
    $qos_res = $dbSocket->query($qos_sql);
    $qos_rows = $qos_res->numRows();
    if ($qos_rows > 0) {
        echo '<div class="card mb-3"><div class="card-body p-2"><table class="table table-sm table-borderless mb-0"><tbody>';
        while ($qr = $qos_res->fetchRow()) {
            $attr = htmlspecialchars($qr[0]);
            $val = intval($qr[1]);
            $label = str_replace(['Huawei-Input-Average-Rate','Huawei-Output-Average-Rate','Huawei-Input-Peak-Rate','Huawei-Output-Peak-Rate'],
                                 ['上行保证','下行保证','上行峰值','下行峰值'], $attr);
            $icon = (strpos($attr,'Input')!==false) ? 'bi-arrow-up-circle text-primary' : 'bi-arrow-down-circle text-success';
            $mbps = $val >= 1000000 ? round($val/1000000,1).' Mbps' : round($val/1000).' Kbps';
            echo "<tr><td><i class=\"bi $icon me-2\"></i>$label</td><td class=\"text-end fw-bold\">$mbps</td></tr>";
        }
        echo '</tbody></table></div></div>';
    } else {
        print_dashboard_info_message('未配置 QoS 策略');
    }

    echo <<<HTML
        </div>
    </div>
    <div class="row">
HTML;

    $sql = sprintf("SELECT DISTINCT(ra.username) AS `username`, 
                    SUM(ra.AcctSessionTime) AS `session_time`,
                    SUM(ra.AcctInputOctets) AS `uploaded_bytes`, 
                    SUM(ra.AcctOutputOctets) AS `downloaded_bytes`
                    FROM %s AS ra 
                    WHERE ra.acctstarttime >= DATE_SUB(CURDATE(), INTERVAL 1 MONTH) 
                    GROUP BY `username` 
                    ORDER BY `session_time` DESC 
                    LIMIT 10", $configValues['CONFIG_DB_TBL_RADACCT']);
    $res = $dbSocket->query($sql);
    $numrows = $res->numRows();

    
    // Today's date
    $today = date("Y-m-d");
    // Date one month ago
    $one_month_ago = date("Y-m-d", strtotime("-1 month"));
    $href = sprintf('rep-topusers.php?startdate=%s&enddate=%s&orderBy=Time&orderType=desc', $one_month_ago, $today);
    $title = "上月流量排行";

    echo '<div class="col-12 m-0 px-3">';
    print_title($title, $href, 'bi-box-arrow-up-right');

    if ($numrows > 0) {
        print_dashboard_table_head(array(t('all', 'Username'), t('all', 'TotalSessionTime'), t('all', 'Upload'), t('all', 'Download')));

        while ($row = $res->fetchRow()) {
            list($username, $session_time, $uploaded_bytes, $downloaded_bytes) = array_map(function($value) {
                return htmlspecialchars(trim($value), ENT_QUOTES, 'UTF-8');
            }, $row);

            $session_time = time2str($session_time);
            $uploaded_bytes = toxbyte($uploaded_bytes);
            $downloaded_bytes = toxbyte($downloaded_bytes);

            print_dashboard_table_row(array($username, $session_time, $uploaded_bytes, $downloaded_bytes));
        }

        print_dashboard_table_bottom();
    
    } else {
        print_dashboard_info_message('no data to show');
    }

    echo '</div>';

    echo '</div>';

    include implode(DIRECTORY_SEPARATOR, [ $configValues['COMMON_INCLUDES'], 'db_close.php' ]);
    include implode(DIRECTORY_SEPARATOR, [ $configValues['OPERATORS_INCLUDE_CONFIG'], 'logging.php' ]);

    $inline_extra_js = <<<JS
const popoverTriggerList = document.querySelectorAll('[data-bs-toggle="popover"]');
const popoverList = [...popoverTriggerList].map(popoverTriggerEl => new bootstrap.Popover(popoverTriggerEl));
JS;

    print_footer_and_html_epilogue($inline_extra_js);
