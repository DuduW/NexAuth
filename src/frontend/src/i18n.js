// 中英文翻译表
const zh = {
  // 侧边栏
  sidebar_title: '企业网络管理',
  nav_home: '首页',
  nav_dashboard: '首页概览',
  nav_users: '用户管理',
  nav_userlist: '用户列表',
  nav_groups: '用户组管理',
  nav_access: '准入管理',
  nav_online: '在线设备',
  nav_accounting: '记账查询',
  nav_macpass: 'MAC 免认证',
  nav_authlog: '认证日志',
  nav_radius: 'RADIUS 管理',
  nav_qos: 'RADIUS 参数',
  nav_nas: 'NAS 设备',
  nav_system: '系统',
  nav_server: '服务器状态',
  nav_vpn: 'VPN 节点',
  nav_vpnlog: '连接日志',
  nav_vpn_mgmt: 'VPN 管理',
  nav_settings: '系统设置',
  nav_admin: '管理员',

  // 通用
  search: '搜索...',
  search_mac: '搜索MAC地址...',
  search_username: '搜索用户名...',
  per_page: '每页',
  items: '条',
  loading: '加载中...',
  no_data: '暂无记录',
  no_users: '暂无用户',
  no_device: '暂无在线设备',
  no_qos: '未配置',
  save: '保存',
  cancel: '取消',
  delete: '删除',
  edit: '编辑',
  remove: '移除',
  create: '创建',
  query: '查询',
  clear: '清空',
  confirm: '确认',
  refresh: '刷新页面',
  all: '全部',
  running: '运行中',

  // 首页
  dashboard_title: '首页概览',
  online_users: '在线用户',
  today_auth: '今日认证',
  mac_bypass: 'MAC 免认证',
  current_traffic: '当前流量',
  realtime_online: '实时在线设备',
  recent_auth: '最近认证',
  mb: 'MB',

  // 用户
  user_title: '用户列表',
  create_user: '创建用户',
  username: '用户名',
  password: '密码',
  group: '分组',
  operation: '操作',
  confirm_delete_user: '确认删除？',

  // 用户组
  group_title: '用户组管理',
  existing_groups: '现有分组',
  groups_count: '个组',
  search_group: '搜索组名...',
  members: '成员',
  member_unit: '人',

  // 在线
  online_title: '在线设备',
  online_count: '在线',
  ip: 'IP',
  mac: 'MAC',
  start_time: '上线',
  duration: '时长',
  upload: '上行',
  download: '下行',
  MB_unit: 'MB',

  // 记账
  accounting_title: '记账历史查询',
  query_condition: '查询条件',
  query_result: '查询结果',
  start_end_date: '输入条件后点击查询',
  no_match: '无匹配记录',

  // MAC
  macpass_title: 'MAC 免认证',
  macpass_count: '条',
  regist_time: '注册',
  expire_time: '过期',
  confirm_remove: '确认移除？',

  // QoS
  qos_title: 'RADIUS 参数',
  qos_header: '组回复属性（radgroupreply）',
  attribute: '属性',
  value_label: '值',

  // 认证日志
  authlog_title: '认证日志',
  recent_records: '最近认证记录',
  result: '结果',
  time: '时间',
  confirm_clear: '确认清空？',

  // NAS
  nas_title: 'NAS 设备管理',
  add_nas: '添加 NAS',
  edit_nas: '编辑 NAS',
  nas_list: 'NAS 设备列表',
  nas_count: '台',
  nas_ip: 'IP 地址',
  nas_secret: 'RADIUS Secret',
  nas_type: '类型',
  nas_ports: '端口',
  nas_desc: '描述',
  confirm_delete_nas: '删除 NAS 设备？',

  // 服务器
  server_title: '服务器状态',
  update_time: '更新时间',
  reg_users: '注册用户',
  total_sessions: '累计会话',
  total_traffic: '累计流量',
  today_stats: '今日统计',
  last_30d: '最近30天',
  week_trend: '7日会话趋势',
  sessions_label: '会话数',

  // 设置
  settings_title: '系统设置',
  service_status: '服务状态',
  theme: '页面风格',
  language: '语言',
  about: '关于',
  about_text: '企业网络管理平台 v2.0',
  about_desc: 'RADIUS 准入 + VPN 管理',
  e2e_platform: 'FreeRADIUS + FastAPI + React + Vite',
  light: '纯白 Light',
  dark: '暗黑 Dark',
  error_title: '页面出错',

  // VPN
  vpn_dev: 'VPN 功能开发中',
  vpnlog_dev: 'VPN 日志开发中',
  vpn_access_dev: 'VPN 访问日志开发中',
  vpn_traffic_dev: 'VPN 流量日志开发中',
  vpn_perm_dev: 'VPN 权限管理开发中',
}

const en = {
  sidebar_title: 'Network Management',
  nav_home: 'Home',
  nav_dashboard: 'Dashboard',
  nav_users: 'Users',
  nav_userlist: 'User List',
  nav_groups: 'Groups',
  nav_access: 'Access Control',
  nav_online: 'Online',
  nav_accounting: 'Accounting',
  nav_macpass: 'MAC Bypass',
  nav_authlog: 'Auth Log',
  nav_radius: 'RADIUS Mgmt',
  nav_qos: 'RADIUS Params',
  nav_nas: 'NAS Devices',
  nav_system: 'System',
  nav_server: 'Server Status',
  nav_vpn: 'VPN Nodes',
  nav_vpnlog: 'VPN Log',
  nav_vpn_mgmt: 'VPN Mgmt',
  nav_settings: 'Settings',
  nav_admin: 'Admin',

  search: 'Search...',
  search_mac: 'Search MAC address...',
  search_username: 'Search username...',
  per_page: 'Per page',
  items: 'items',
  loading: 'Loading...',
  no_data: 'No data',
  no_users: 'No users',
  no_device: 'No online devices',
  no_qos: 'Not configured',
  save: 'Save',
  cancel: 'Cancel',
  delete: 'Delete',
  edit: 'Edit',
  remove: 'Remove',
  create: 'Create',
  query: 'Query',
  clear: 'Clear',
  confirm: 'Confirm',
  refresh: 'Refresh',
  all: 'All',
  running: 'Running',

  dashboard_title: 'Dashboard',
  online_users: 'Online Users',
  today_auth: 'Auth Today',
  mac_bypass: 'MAC Bypass',
  current_traffic: 'Traffic',
  realtime_online: 'Active Sessions',
  recent_auth: 'Recent Auth',
  mb: 'MB',

  user_title: 'User List',
  create_user: 'Create User',
  username: 'Username',
  password: 'Password',
  group: 'Group',
  operation: 'Action',
  confirm_delete_user: 'Confirm delete?',

  group_title: 'Group Management',
  existing_groups: 'Groups',
  groups_count: 'groups',
  search_group: 'Search group...',
  members: 'Members',
  member_unit: 'users',

  online_title: 'Online Devices',
  online_count: 'Online',
  ip: 'IP',
  mac: 'MAC',
  start_time: 'Login',
  duration: 'Duration',
  upload: 'Upload',
  download: 'Download',
  MB_unit: 'MB',

  accounting_title: 'Accounting History',
  query_condition: 'Search Criteria',
  query_result: 'Results',
  start_end_date: 'Enter criteria and search',
  no_match: 'No matching records',

  macpass_title: 'MAC Bypass',
  macpass_count: 'entries',
  regist_time: 'Registered',
  expire_time: 'Expires',
  confirm_remove: 'Confirm remove?',

  qos_title: 'RADIUS Params',
  qos_header: 'Group Reply Attributes (radgroupreply)',
  attribute: 'Attribute',
  value_label: 'Value',

  authlog_title: 'Auth Log',
  recent_records: 'Recent Records',
  result: 'Result',
  time: 'Time',
  confirm_clear: 'Confirm clear?',

  nas_title: 'NAS Management',
  add_nas: 'Add NAS',
  edit_nas: 'Edit NAS',
  nas_list: 'NAS Devices',
  nas_count: 'devices',
  nas_ip: 'IP Address',
  nas_secret: 'RADIUS Secret',
  nas_type: 'Type',
  nas_ports: 'Ports',
  nas_desc: 'Description',
  confirm_delete_nas: 'Delete NAS device?',

  server_title: 'Server Status',
  update_time: 'Updated',
  reg_users: 'Users',
  total_sessions: 'Sessions',
  total_traffic: 'Traffic',
  today_stats: 'Today',
  last_30d: 'Last 30 Days',
  week_trend: '7-Day Trends',
  sessions_label: 'Sessions',

  settings_title: 'Settings',
  service_status: 'Service Status',
  theme: 'Theme',
  language: 'Language',
  about: 'About',
  about_text: 'Enterprise Network Platform v2.0',
  about_desc: 'RADIUS NAC + VPN Management',
  e2e_platform: 'FreeRADIUS + FastAPI + React + Vite',
  light: 'Light',
  dark: 'Dark',
  error_title: 'Page Error',

  vpn_dev: 'VPN under development',
  vpnlog_dev: 'VPN Log under development',
  vpn_access_dev: 'VPN Access Log under development',
  vpn_traffic_dev: 'VPN Traffic Log under development',
  vpn_perm_dev: 'VPN Permission Mgmt under development',
}

const translations = { zh, en }

/** 当前语言（模块级缓存，setLang 时更新并广播） */
let currentLang = (() => {
  try { return (typeof window !== 'undefined' && localStorage.getItem('lang')) || 'zh' }
  catch { return 'zh' }
})()

const langListeners = new Set()

/** 翻译函数（模块级，非 hook；setLang 后经 App 订阅触发整树重渲染） */
export function tr(key) {
  if (!key) return key
  const dict = translations[currentLang] || translations.zh
  return dict[key] ?? translations.zh[key] ?? key
}

/** 切换语言：立即生效（触发所有使用 tr() 的组件重渲染） */
export function setLang(lang) {
  if (!translations[lang] || lang === currentLang) return
  currentLang = lang
  try { localStorage.setItem('lang', lang) } catch { /* ignore */ }
  langListeners.forEach(fn => fn())
}

/** 订阅语言变化（App 顶层使用，用于强制重渲染） */
export function subscribeLang(fn) {
  langListeners.add(fn)
  return () => langListeners.delete(fn)
}

export default translations
