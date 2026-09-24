<?php
/**
 * Clear radpostauth table
 */
include("library/checklogin.php");
$operator = $_SESSION['operator_user'];
include_once('../common/includes/config_read.php');

$mysqli = new mysqli('127.0.0.1', 'radius', 'CHANGE_ME_DB_PASS', 'radius');
if (!$mysqli->connect_error) {
    $mysqli->query("TRUNCATE TABLE radpostauth");
    $mysqli->close();
}
header("Location: home-main.php?cleared=ok");
