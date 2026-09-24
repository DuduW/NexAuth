import { useState, useEffect } from 'react'
import { tr } from '../i18n'
import { api, fetchApi } from '../api'
import CollapsePanel from '../components/CollapsePanel'

export default function Dashboard() {
  const [stats, setStats] = useState(null)
  const [vpnStats, setVpnStats] = useState(null)
  const [vpnRecent, setVpnRecent] = useState([])
  const [online, setOnline] = useState([])
  const [macs, setMacs] = useState([])
  const [authlog, setAuthlog] = useState([])

  useEffect(() => {
    api.dashboard().then(setStats).catch(console.error)
    api.online().then(setOnline).catch(console.error)
    api.macs().then(setMacs).catch(console.error)
    api.authlog().then(setAuthlog).catch(console.error)
    fetchApi('/vpn/stats').then(setVpnStats).catch(console.error)
    fetchApi('/vpn/access-log?limit=5').then(setVpnRecent).catch(console.error)
  }, [])

  return <>
    <div className="page-header"><h1>{tr('dashboard_title')}</h1></div>

    {/* ── 准入数据 ── */}
    <div className="section-header" style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
      <span style={{width:4,height:18,background:'var(--blue)',borderRadius:0}} />
      <h3 style={{fontSize:15,fontWeight:700,color:'var(--dark)'}}>准入数据</h3>
      <span style={{fontSize:11,color:'var(--muted)',marginLeft:4}}>RADIUS / 802.1X / Portal</span>
    </div>

    <div className="stat-cards">
      <div className="stat-card"><div className="label">{tr('online_users')}</div><div className="value" style={{color:'var(--blue)'}}>{stats?.online ?? '-'}</div></div>
      <div className="stat-card"><div className="label">{tr('today_auth')}</div><div className="value" style={{color:'var(--green)'}}>{stats?.today_auth?.toLocaleString?.() ?? '-'}</div></div>
      <div className="stat-card"><div className="label">{tr('mac_bypass')}</div><div className="value" style={{color:'var(--orange)'}}>{stats?.mac_bypass ?? '-'}</div></div>
      <div className="stat-card"><div className="label">{tr('current_traffic')}</div><div className="value" style={{color:'var(--red)'}}>{(stats?.traffic ?? 0).toLocaleString?.() ?? 0} GB</div></div>
    </div>

    <CollapsePanel title={tr('realtime_online')} badge={<span className="badge badge-blue">{online.length} {tr('nav_online')}</span>} storageKey="dash_online">
      <div className="panel-body">
        {online.length ? <table><thead><tr><th>{tr('username')}</th><th>{tr('ip')}</th><th>{tr('mac')}</th><th className="num">{tr('duration')}</th><th className="num">{tr('current_traffic')}</th></tr></thead><tbody>
          {online.slice(0,8).map((o,i)=><tr key={i}><td><strong>{o.username}</strong></td><td>{o.ip||'-'}</td><td><code>{(o.mac||'').substring(0,17)}</code></td><td className="num">{fmtDur(o.acctsessiontime)}</td><td className="num">↑{fmtNum(o.up_mb)}{tr('mb')} ↓{fmtNum(o.down_mb)}{tr('mb')}</td></tr>)}
        </tbody></table> : <div className="empty">{tr('no_device')}</div>}
      </div>
    </CollapsePanel>

    <CollapsePanel title={tr('mac_bypass')} storageKey="dash_mac">
      <div className="panel-body">
        {macs.length ? <table><thead><tr><th>{tr('mac')}</th><th>{tr('username')}</th><th>{tr('operation')}</th></tr></thead><tbody>
          {macs.slice(0,8).map((m,i)=><tr key={i}><td><code>{m.mac}</code></td><td>{m.username}</td><td><span className={`badge badge-${m.status==='valid'?'success':'default'}`}>{m.status==='valid'?tr('running'):tr('expire_time')}</span></td></tr>)}
        </tbody></table> : <div className="empty">{tr('no_data')}</div>}
      </div>
    </CollapsePanel>

    <CollapsePanel title={tr('recent_auth')} storageKey="dash_auth">
      <div className="panel-body">
        {authlog.length ? <table><thead><tr><th>{tr('username')}</th><th>{tr('result')}</th><th>{tr('time')}</th></tr></thead><tbody>
          {authlog.slice(0,10).map((l,i)=><tr key={i}><td><code>{l.username}</code></td><td><span className={`badge badge-${l.reply==='Access-Accept'?'success':'danger'}`} title={l.reply}>{l.reply==='Access-Accept'?'接受':'拒绝'}</span></td><td style={{fontSize:11}}>{(l.authdate||'').substring(5,19)}</td></tr>)}
        </tbody></table> : <div className="empty">{tr('no_data')}</div>}
      </div>
    </CollapsePanel>

    {/* ── VPN 数据 ── */}
    <div className="section-header" style={{display:'flex',alignItems:'center',gap:8,marginTop:6,marginBottom:14}}>
      <span style={{width:4,height:18,background:'var(--green)',borderRadius:0}} />
      <h3 style={{fontSize:15,fontWeight:700,color:'var(--dark)'}}>VPN 数据</h3>
      <span style={{fontSize:11,color:'var(--muted)',marginLeft:4}}>拨入连接统计</span>
    </div>

    {vpnStats && (vpnStats.online > 0 || vpnStats.today_connections > 0) ? <>

    <div className="stat-cards">
      <div className="stat-card"><div className="label">VPN 在线</div><div className="value" style={{color:'var(--green)'}}>{vpnStats?.online ?? '-'}</div></div>
      <div className="stat-card"><div className="label">今日连接</div><div className="value">{vpnStats?.today_connections?.toLocaleString?.() ?? '-'}</div></div>
      <div className="stat-card"><div className="label">今日流量</div><div className="value">{fmtBytes(vpnStats?.today_bytes)}</div></div>
      <div className="stat-card"><div className="label">活跃用户</div><div className="value">{vpnStats?.active_users ?? '-'}</div></div>
    </div>

    <CollapsePanel title="VPN 近期连接" storageKey="dash_vpn_recent">
      <div className="panel-body">
        {vpnRecent.length ? <table><thead><tr><th>时间</th><th>用户</th><th>事件</th><th>IP</th></tr></thead><tbody>
          {vpnRecent.map((l,i)=><tr key={i}><td style={{fontSize:11}}>{(l.created_at||'').substring(5,16)}</td><td><strong>{l.username}</strong></td><td><span className={`badge badge-${l.action==='connect'?'success':'danger'}`}>{l.action==='connect'?'连接':'断开'}</span></td><td><code>{l.ip||'-'}</code></td></tr>)}
        </tbody></table> : <div className="empty">暂无连接记录，可前往 <a href="#/vpn" style={{color:'var(--blue)',fontWeight:600}}>VPN 管理 · 节点管理</a> 配置节点</div>}
      </div>
    </CollapsePanel>
    </> : (
    <div className="panel">
      <div className="panel-body" style={{padding:'20px',textAlign:'center'}}>
        <div style={{fontSize:12,color:'var(--muted)'}}>今日暂无 VPN 拨入，VPN 指标卡已折叠 · 前往 <a href="#/vpn" style={{color:'var(--blue)',fontWeight:600}}>VPN 管理 · 节点管理</a> 查看/配置</div>
      </div>
    </div>
    )}
  </>
}

function fmtNum(n){const v=parseFloat(n);if(isNaN(v))return n??'-';return v>=1000?v.toLocaleString('zh-CN',{maximumFractionDigits:1}):String(n)}

function fmtDur(sec) {
  const s = parseInt(sec) || 0
  if (s >= 3600) return Math.floor(s/3600)+'h'+Math.floor(s%3600/60)+'m'
  if (s >= 60) return Math.floor(s/60)+'m'+s%60+'s'
  return s+'s'
}

function fmtBytes(b) {
  const n = parseInt(b) || 0
  if (n <= 0) return '0 MB'
  if (n >= 1024**3) return (n/1024**3).toFixed(2)+' GB'
  if (n >= 1024**2) return (n/1024**2).toFixed(1)+' MB'
  if (n >= 1024) return (n/1024).toFixed(1)+' KB'
  return n+' B'
}
