import { useState, useEffect, useReducer, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Outlet, useLocation } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import ErrorBoundary from './components/ErrorBoundary'
import { ToastHost } from './components/Toast'
import { ConfirmHost } from './components/ConfirmModal'
import { FormHost } from './components/FormModal'
import { ImportHost } from './components/ImportModal'
import { isLoggedIn, fetchApi } from './api'
import { tr, subscribeLang } from './i18n'
import Login from './pages/Login'

// ── 路由级代码分割（P3-8）：31 页全部 lazy，首屏只加载当前页 chunk ──
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Users = lazy(() => import('./pages/Users'))
const Groups = lazy(() => import('./pages/Groups'))
const UserProfiles = lazy(() => import('./pages/UserProfiles'))
const Online = lazy(() => import('./pages/Online'))
const MacBypass = lazy(() => import('./pages/MacBypass'))
const QosPolicy = lazy(() => import('./pages/QosPolicy'))
const AuthLog = lazy(() => import('./pages/AuthLog'))
const Accounting = lazy(() => import('./pages/Accounting'))
const ServerStats = lazy(() => import('./pages/ServerStats'))
const RadiusConfig = lazy(() => import('./pages/RadiusConfig'))
const TotpManager = lazy(() => import('./pages/TotpManager'))
const PortalManager = lazy(() => import('./pages/PortalManager'))
const Settings = lazy(() => import('./pages/Settings'))
const VpnNode = lazy(() => import('./pages/VpnNode'))
const VpnPerm = lazy(() => import('./pages/VpnPerm'))
const VpnAccessLog = lazy(() => import('./pages/VpnAccessLog'))
const VpnTrafficLog = lazy(() => import('./pages/VpnTrafficLog'))
const VpnConnLog = lazy(() => import('./pages/VpnConnLog'))
const VpnVisitLog = lazy(() => import('./pages/VpnVisitLog'))
const CertManager = lazy(() => import('./pages/CertManager'))
const SwDevices = lazy(() => import('./pages/SwDevices'))
const SwBackups = lazy(() => import('./pages/SwBackups'))
const SwHealth = lazy(() => import('./pages/SwHealth'))
const SwTasks = lazy(() => import('./pages/SwTasks'))
const IpSubnets = lazy(() => import('./pages/IpSubnets'))
const IpAddresses = lazy(() => import('./pages/IpAddresses'))
const IpPublic = lazy(() => import('./pages/IpPublic'))
const NacCenter = lazy(() => import('./pages/NacCenter'))
const NacMonitor = lazy(() => import('./pages/NacMonitor'))
const NacPolicy = lazy(() => import('./pages/NacPolicy'))
const NacConfig = lazy(() => import('./pages/NacConfig'))
const NacTopo = lazy(() => import('./pages/NacTopo'))
const NotFound = lazy(() => import('./pages/NotFound'))

// ── 每路由 document.title 映射（P2-3）──
const TITLES = {
  '/': '首页概览',
  '/users': '用户列表',
  '/groups': '用户组管理',
  '/user-profiles': 'Profile 管理',
  '/online': '在线设备',
  '/macpass': 'MAC 免认证',
  '/qos': 'RADIUS 参数',
  '/authlog': '认证日志',
  '/accounting': '记账查询',
  '/server': '服务器状态',
  '/radius-config': 'RADIUS 配置',
  '/totp': 'TOTP 动态码',
  '/portal': 'Portal 服务',
  '/settings': '系统设置',
  '/vpn': '节点管理',
  '/vpnaccess': 'VPN 接入日志',
  '/vpntraffic': 'VPN 流量日志',
  '/vpnconn': 'VPN 连接日志',
  '/vpnvisit': 'VPN 访问日志',
  '/vpnperm': 'VPN 权限管理',
  '/certs': '证书管理',
  '/sw': '设备清单',
  '/sw-backups': '备份管理',
  '/sw-analysis': '在线分析',
  '/sw-tasks': '定时任务',
  '/ip-subnets': '网段管理',
  '/ip-addresses': '地址台账',
  '/ip-public': '公网资产',
  '/nac': '准入与认证中心',
  '/nac/monitor': '运行监控',
  '/nac/policy': '准入策略',
  '/nac/config': '服务配置',
  '/nac/topo': '链路拓扑',
  '/404': '页面不存在',
}
const SITE_SUFFIX = ' · 企业网络管理平台'

function TitleManager() {
  const loc = useLocation()
  useEffect(() => {
    document.title = (TITLES[loc.pathname] || '页面不存在') + SITE_SUFFIX
  }, [loc.pathname])
  return null
}

function PageLoading() {
  return <div className="panel"><div className="panel-body"><div className="empty">加载中…</div></div></div>
}

function PageLayout() {
  return (
    <div className="container">
      <TopBar />
      <Sidebar />
      <main className="main">
        <TitleManager />
        <ErrorBoundary>
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  )
}

// ── Carbon Shell 顶栏：品牌 + 面包屑 + 环境标 + 用户 ──
function TopBar() {
  const loc = useLocation()
  // 路由 → 面包屑分组（组名 / 页名）
  const GROUPS = [
    { prefix: '/', group: '总览' },
    { prefix: '/users', group: '用户与组' },
    { prefix: '/groups', group: '用户与组' },
    { prefix: '/totp', group: '用户与组' },
    { prefix: '/online', group: '网络准入' },
    { prefix: '/accounting', group: '网络准入' },
    { prefix: '/macpass', group: '网络准入' },
    { prefix: '/authlog', group: '网络准入' },
    { prefix: '/nac', group: '准入与认证中心' },
    { prefix: '/user-profiles', group: 'RADIUS 中心' },
    { prefix: '/qos', group: 'RADIUS 中心' },
    { prefix: '/radius-config', group: 'RADIUS 中心' },
    { prefix: '/portal', group: 'RADIUS 中心' },
    { prefix: '/certs', group: 'RADIUS 中心' },
    { prefix: '/vpn', group: 'VPN 管理' },
    { prefix: '/vpnperm', group: 'VPN 管理' },
    { prefix: '/vpnconn', group: 'VPN 管理' },
    { prefix: '/vpnvisit', group: 'VPN 管理' },
    { prefix: '/vpntraffic', group: 'VPN 管理' },
    { prefix: '/vpnaccess', group: 'VPN 管理' },
    { prefix: '/ip-subnets', group: '数字资产管理' },
    { prefix: '/ip-addresses', group: '数字资产管理' },
    { prefix: '/ip-public', group: '数字资产管理' },
    { prefix: '/sw', group: '设备资产管理' },
    { prefix: '/sw-backups', group: '设备资产管理' },
    { prefix: '/sw-analysis', group: '设备资产管理' },
    { prefix: '/sw-tasks', group: '设备资产管理' },
    { prefix: '/server', group: '系统' },
    { prefix: '/settings', group: '系统' },
  ]
  const cur = loc.pathname
  const hit = GROUPS.filter(g => g.prefix !== '/' && cur.startsWith(g.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0]
  const group = hit ? hit.group : '总览'
  const page = TITLES[cur] || '页面'
  return (
    <header className="topbar">
      <div className="brand"><span className="logo">R</span>RADIUS Ops</div>
      <nav className="topbar-bc">
        <span>企业网络管理平台</span>
        <span className="sep">/</span>
        <span>{group}</span>
        <span className="sep">/</span>
        <span className="cur">{page}</span>
      </nav>
      <div className="spacer" />
      <span className="env-tag">PRODUCTION</span>
      <div className="topbar-user">
        <span className="avatar">{(localStorage.getItem('admin_user') || '管')[0].toUpperCase()}</span>
        {localStorage.getItem('admin_user') || 'admin'}
      </div>
    </header>
  )
}

function EmptyMsg({ msg }) {
  return <div className='panel'><div className='panel-body'><div className='empty'>{tr(msg)}</div></div></div>
}

export default function App() {
  const [token, setToken] = useState(isLoggedIn() ? localStorage.getItem('token') : null)
  const [user, setUser] = useState(localStorage.getItem('admin_user') || '')
  // 语言切换后强制整树重渲染（tr 为模块级函数，需外部驱动）
  const [, forceUpdate] = useReducer(c => c + 1, 0)
  useEffect(() => subscribeLang(forceUpdate), [])

  const handleLogin = (t) => {
    setToken(t)
    setUser(localStorage.getItem('admin_user') || '')
  }

  const app = token
    ? (
      <BrowserRouter basename="/admin-spa">
        <Routes>
          <Route element={<PageLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/users" element={<Users />} />
            <Route path="/groups" element={<Groups />} />
            <Route path="/user-profiles" element={<UserProfiles />} />
            <Route path="/online" element={<Online />} />
            <Route path="/macpass" element={<MacBypass />} />
            <Route path="/qos" element={<QosPolicy />} />
            <Route path="/authlog" element={<AuthLog />} />
            <Route path="/accounting" element={<Accounting />} />
            <Route path="/server" element={<ServerStats />} />
            <Route path="/radius-config" element={<RadiusConfig />} />
            <Route path="/totp" element={<TotpManager />} />
            <Route path="/portal" element={<PortalManager />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/vpn" element={<VpnNode />} />
            <Route path="/vpnaccess" element={<VpnAccessLog />} />
            <Route path="/vpntraffic" element={<VpnTrafficLog />} />
            <Route path="/vpnconn" element={<VpnConnLog />} />
            <Route path="/vpnvisit" element={<VpnVisitLog />} />
            <Route path="/vpnperm" element={<VpnPerm />} />
            <Route path="/certs" element={<CertManager />} />
            <Route path="/sw" element={<SwDevices />} />
            <Route path="/sw-backups" element={<SwBackups />} />
            <Route path="/sw-analysis" element={<SwHealth />} />
            <Route path="/sw-tasks" element={<SwTasks />} />
            <Route path="/ip-subnets" element={<IpSubnets />} />
            <Route path="/ip-addresses" element={<IpAddresses />} />
            <Route path="/ip-public" element={<IpPublic />} />
            <Route path="/nac" element={<NacCenter />} />
            <Route path="/nac/monitor" element={<NacMonitor />} />
            <Route path="/nac/policy" element={<NacPolicy />} />
            <Route path="/nac/config" element={<NacConfig />} />
            <Route path="/nac/topo" element={<NacTopo />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    )
    : <Login onLogin={handleLogin} />

  return <>
    {app}
    <ToastHost />
    <ConfirmHost />
    <FormHost />
    <ImportHost />
  </>
}
