import { NavLink, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { tr } from '../i18n'
import { logout } from '../api'

/**
 * 可折叠分组侧边栏（v2）：
 * - 一级标题可点击展开/收起二级菜单（▸/▾ 指示）
 * - 当前路由所在分组自动展开（即使被手动收起，导航跳转后仍保证可见）
 * - 折叠状态存 localStorage（key: sidebar_collapsed），刷新后保持
 */
const COLLAPSE_KEY = 'sidebar_collapsed'

function readCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {} }
  catch { return {} }
}

export default function Sidebar() {

  const ITEMS = [
    { h: tr('nav_home'), items: [{path:'/',label:tr('nav_dashboard')}] },
    { h: tr('nav_users'), items: [{path:'/users',label:tr('nav_userlist')},{path:'/groups',label:tr('nav_groups')},{path:'/totp',label:'TOTP 动态码'}] },
    { h: tr('nav_access'), items: [
      {path:'/nac/monitor',label:'运行监控'},
      {path:'/nac/policy',label:'准入策略'},
      {path:'/nac/config',label:'服务配置'},
      {path:'/nac/topo',label:'链路拓扑'},
    ]},
    { h: 'VPN 管理', items: [
      {path:'/vpn',label:'节点管理'},
      {path:'/vpnperm',label:'权限管理'},
      {path:'/vpnconn',label:'连接日志'},
      {path:'/vpnvisit',label:'访问日志'},
      {path:'/vpntraffic',label:'流量日志'},
    ]},
    { h: '数字资产管理', items: [
      {path:'/ip-subnets',label:'网段管理'},
      {path:'/ip-addresses',label:'地址台账'},
      {path:'/ip-public',label:'公网资产'},
    ]},
    { h: '设备资产管理', items: [
      {path:'/sw',label:'设备清单'},
      {path:'/sw-backups',label:'备份管理'},
      {path:'/sw-analysis',label:'在线分析'},
      {path:'/sw-tasks',label:'定时任务'},
    ]},
    { h: tr('nav_system'), items: [
      {path:'/server',label:tr('nav_server')},
      {path:'/settings',label:tr('nav_settings')},
    ]},
  ]

  const [collapsed, setCollapsed] = useState(readCollapsed)
  const loc = useLocation()

  const toggle = (h) => {
    setCollapsed(prev => {
      const next = { ...prev, [h]: !prev[h] }
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next))
      return next
    })
  }

  return (
    <aside className="sidebar">
      {ITEMS.map((sec, i) => {
        // 当前路由命中的分组始终展开（防止用户收起后导航进入"看不见菜单项"的分组）
        const isCollapsed = collapsed[sec.h] && !sec.items.some(it => loc.pathname.startsWith(it.path))
        return (
        <div key={i}>
          <h3 onClick={() => toggle(sec.h)} style={{ cursor: 'pointer', display: 'flex',
            alignItems: 'center', justifyContent: 'space-between', userSelect: 'none' }}
            title={isCollapsed ? '展开' : '收起'}>
            <span>{sec.h}</span>
            <span style={{ fontSize: 14, color: '#a8a8a8', transition: 'transform .15s',
              transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0)', display: 'inline-block' }}>▾</span>
          </h3>
          {!isCollapsed && sec.items.map((item, j) => (
            <SideItem key={j} {...item} />
          ))}
        </div>
        )
      })}
      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="avatar">{(localStorage.getItem('admin_user')||tr('nav_admin'))[0]}</div>
          <div><div className="name" style={{fontSize:12,fontWeight:600,color:'#fff'}}>{localStorage.getItem('admin_user')||tr('nav_admin')}</div></div>
        </div>
        <button onClick={logout} style={{
          marginTop:8,width:'100%',padding:'7px 0',background:'#161616',border:'1px solid #6f6f6f',
          borderRadius:0,fontSize:12,color:'#c6c6c6',cursor:'pointer',
          display:'flex',alignItems:'center',justifyContent:'center',gap:4
        }}>↪ 登出</button>
      </div>
    </aside>
  )
}

function SideItem({ path, label }) {
  const loc = useLocation()
  const active = path !== '#' && (path === '/' ? loc.pathname === '/' : loc.pathname.startsWith(path))
  return (
    <NavLink to={path} className={`sidebar-item${active ? ' active' : ''}`}>
      {label}
    </NavLink>
  )
}
