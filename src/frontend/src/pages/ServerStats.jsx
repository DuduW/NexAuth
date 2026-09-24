import { useState, useEffect } from 'react'
import { tr } from '../i18n'
import { fetchApi } from '../api'
import CollapsePanel from '../components/CollapsePanel'

export default function ServerStats() {
  const [stats, setStats] = useState(null)
  const [svc, setSvc] = useState(null)
  useEffect(() => {
    fetchApi('/server/stats').then(setStats).catch(console.error)
    fetchApi('/services/status').then(setSvc).catch(console.error)
  }, [])

  if (!stats) return <div className="panel"><div className="panel-body"><div className="empty">{tr('loading')}</div></div></div>

  const { all_time, today, last_30d, online, total_users, database, auth_today, daily } = stats

  // 7 日趋势：缺失日期补零，保证 X 轴连续（后端已返回 start_dt/end_dt）
  const dailyRows = (() => {
    const rows = Array.isArray(daily) ? daily : (daily?.rows || [])
    if (!rows.length) return []
    const map = new Map(rows.map(r => [String(r.dt).substring(0, 10), r]))
    const out = []
    const start = (daily?.start_dt || String(rows[0].dt).substring(0, 10)) + 'T00:00:00'
    const end = (daily?.end_dt || String(rows[rows.length-1].dt).substring(0, 10)) + 'T00:00:00'
    for (let d = new Date(start), e = new Date(end); d <= e; d.setDate(d.getDate()+1)) {
      const key = d.toISOString().substring(0, 10)
      const r = map.get(key)
      out.push({ dt: key, sessions: r?.sessions || 0, users: r?.users || 0, gb: r?.gb || 0 })
      if (out.length > 14) break  // 防御：异常区间截断
    }
    return out
  })()

  return <>
    <div className="page-header"><h1>{tr('server_title')}</h1><div style={{fontSize:12,color:'var(--muted)',marginTop:4}}>更新时间: {stats.time}</div></div>

    {/* ── 服务状态：状态灯网格（可折叠）── */}
    {svc && (() => {
      const entries = Object.entries(svc)
      const runningCnt = entries.filter(([,v])=>v.status==='running').length
      return <CollapsePanel title={tr('service_status')}
        badge={<span className={`badge ${runningCnt===entries.length?'badge-success':'badge-warning'}`}>{runningCnt}/{entries.length} running</span>}
        storageKey="srv_services" panelStyle={{marginBottom:18}}>
        <div className="panel-body">
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(150px,1fr))',gap:10}}>
            {entries.map(([k,v])=>{
              const ok = v.status==='running'
              return <div key={k} style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',borderRadius:0,background: ok ? 'var(--ok-bg)' : 'var(--err-bg)',border:`1px solid ${ok ? 'var(--border)' : 'var(--border)'}`,minWidth:0}}>
                <span title={v.status} style={{width:9,height:9,borderRadius:'50%',flexShrink:0,background: ok ? 'var(--green)' : 'var(--red)',boxShadow: 'none'}} />
                <span style={{fontSize:12.5,fontWeight:600,color:'var(--dark)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{v.label}</span>
                <span style={{fontSize:10,color:'var(--muted)',marginLeft:'auto',flexShrink:0}}>{v.port}</span>
              </div>
            })}
          </div>
        </div>
      </CollapsePanel>
    })()}

    {/* ── 准入数据：统一 KPI 组合卡（累计 + 今日 + 30天）── */}
    <div className="section-header" style={{display:'flex',alignItems:'center',gap:8,marginBottom:14}}>
      <span style={{width:4,height:18,background:'var(--blue)',borderRadius:0}} />
      <h3 style={{fontSize:15,fontWeight:700,color:'var(--dark)'}}>准入数据</h3>
      <span style={{fontSize:11,color:'var(--muted)',marginLeft:4}}>RADIUS / 802.1X</span>
    </div>

    <div className="panel" style={{marginBottom:18}}>
      <div className="panel-body" style={{padding:18}}>
        {/* 一级 KPI：大数字 */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:14}}>
          <div><div style={{fontSize:11,color:'var(--muted)',marginBottom:2}}>在线设备</div><div style={{fontSize:26,fontWeight:700,color:'var(--green)'}}>{online?.online ?? 0}</div><div style={{fontSize:11,color:'var(--muted)'}}>自 {online?.since?.substring(5,16) || '-'}</div></div>
          <div><div style={{fontSize:11,color:'var(--muted)',marginBottom:2}}>注册用户</div><div style={{fontSize:26,fontWeight:700,color:'var(--blue)'}}>{total_users ?? 0}</div></div>
          <div><div style={{fontSize:11,color:'var(--muted)',marginBottom:2}}>累计会话</div><div style={{fontSize:26,fontWeight:700,color:'var(--dark)'}}>{(all_time?.sessions ?? 0).toLocaleString()}</div></div>
          <div><div style={{fontSize:11,color:'var(--muted)',marginBottom:2}}>累计流量</div><div style={{fontSize:26,fontWeight:700,color:'var(--orange)'}}>{all_time?.tb ?? 0} TB</div></div>
        </div>
        {/* 分隔线 */}
        <div style={{height:1,background:'var(--border)',margin:'16px 0'}} />
        {/* 二级 KPI：今日 / 30 天并排 */}
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))',gap:14}}>
          <div style={{padding:'12px 16px',borderRadius:0,background:'var(--bg-light)',border:'1px solid var(--border)'}}>
            <div style={{fontSize:11,fontWeight:600,color:'var(--muted)',marginBottom:6,letterSpacing:'.04em'}}>今日</div>
            <div style={{display:'flex',gap:24,fontSize:13,flexWrap:'wrap'}}>
              <span>会话 <strong>{(today?.sessions ?? 0).toLocaleString()}</strong></span>
              <span>用户 <strong>{today?.users ?? 0}</strong></span>
              <span>流量 <strong>{today?.gb ?? 0} GB</strong></span>
            </div>
            {auth_today?.length > 0 && <div style={{marginTop:8,fontSize:11,color:'var(--muted)',display:'flex',gap:10,flexWrap:'wrap'}}>
              {auth_today.map(a=><span key={a.reply} title={a.reply} className={`badge badge-${a.reply==='Access-Accept'?'success':'danger'}`}>{a.reply==='Access-Accept'?'接受':'拒绝'} {a.cnt}</span>)}
            </div>}
          </div>
          <div style={{padding:'12px 16px',borderRadius:0,background:'var(--bg-light)',border:'1px solid var(--border)'}}>
            <div style={{fontSize:11,fontWeight:600,color:'var(--muted)',marginBottom:6,letterSpacing:'.04em'}}>最近 30 天</div>
            <div style={{display:'flex',gap:24,fontSize:13,flexWrap:'wrap'}}>
              <span>会话 <strong>{(last_30d?.sessions ?? 0).toLocaleString()}</strong></span>
              <span>用户 <strong>{last_30d?.users ?? 0}</strong></span>
              <span>流量 <strong>{last_30d?.gb ?? 0} GB</strong></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    {/* 7日趋势：补零连续 + 柱宽上限（可折叠） */}
    {dailyRows.length > 0 && <CollapsePanel title="7日会话趋势" badge={<span style={{fontSize:11,color:'var(--muted)',fontWeight:400}}>按会话起始日期</span>} storageKey="srv_trend" panelStyle={{marginBottom:18}}>
      <div className="panel-body">
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-end',height:130,gap:6,paddingTop:10}}>
          {(() => {
            const maxS = Math.max(1, ...dailyRows.map(x=>x.sessions||0))
            return dailyRows.map((d,i) => {
              const h = Math.round((d.sessions||0) / maxS * 92)
              return <div key={d.dt} style={{flex:1,maxWidth:64,textAlign:'center',fontSize:11,minWidth:0}}>
                <div style={{fontWeight:600,fontSize:12,marginBottom:2}}>{d.sessions || ''}</div>
                <div title={`${d.dt} · ${d.sessions} 会话 / ${d.users} 用户`} style={{background:'var(--blue)',borderRadius:0,height:Math.max(h, d.sessions>0?6:2),minHeight:2,opacity: d.sessions>0?0.85:0.25,transition:'height .3s'}} />
                <div style={{color:'var(--muted)',marginTop:4,fontSize:10,whiteSpace:'nowrap'}}>{d.dt.substring(5)}</div>
              </div>
            })
          })()}
        </div>
        <div style={{fontSize:11,color:'var(--muted)',textAlign:'center',marginTop:4}}>会话数（无数据日期已补零）</div>
      </div>
    </CollapsePanel>}

    {/* ── VPN 数据：空态引导 ── */}
    <div className="section-header" style={{display:'flex',alignItems:'center',gap:8,marginTop:6,marginBottom:14}}>
      <span style={{width:4,height:18,background:'var(--green)',borderRadius:0}} />
      <h3 style={{fontSize:15,fontWeight:700,color:'var(--dark)'}}>VPN 数据</h3>
      <span style={{fontSize:11,color:'var(--muted)',marginLeft:4}}>拨入连接统计</span>
    </div>
    <div className="panel" style={{marginBottom:18}}>
      <div className="panel-body" style={{padding:'22px 20px',textAlign:'center'}}>
        <div style={{fontSize:12,color:'var(--muted)',marginBottom:4}}>本页暂不展示 VPN 指标</div>
        <div style={{fontSize:12,color:'var(--muted)'}}>VPN 在线 / 连接 / 流量请前往 <a href="#/vpn" style={{color:'var(--blue)',fontWeight:600}}>VPN 管理 · 节点管理</a> 查看（本服务器状态页仅汇总 RADIUS 准入数据）</div>
      </div>
    </div>

    {/* 数据库表：右对齐 + 千分位（可折叠） */}
    <CollapsePanel title="数据库" badge={<span className="badge badge-blue">{database?.length} 张表</span>} storageKey="srv_db">
      <div className="panel-body">
        {database?.length > 0 && <table><thead><tr><th>表名</th><th className="num">大小</th><th className="num">行数</th></tr></thead><tbody>
          {database.map(d=><tr key={d.table_name}><td><code>{d.table_name}</code></td><td className="num">{d.mb} MB</td><td className="num">{Number(d.table_rows||0).toLocaleString()}</td></tr>)}
        </tbody></table>}
      </div>
    </CollapsePanel>
  </>
}
