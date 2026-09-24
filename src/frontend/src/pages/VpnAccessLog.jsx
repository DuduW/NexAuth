import { useState, useEffect } from 'react'
import { fetchApi } from '../api'

export default function VpnAccessLog() {
  const [data, setData] = useState([])
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const load = () => {
    let url = '/vpn/access-log?limit=500'
    if (search) url += `&username=${search}`
    if (from) url += `&from_date=${from}`
    if (to) url += `&to_date=${to}`
    fetchApi(url).then(setData).catch(console.error)
  }
  useEffect(load, [])

  return <>
    <div className="page-header"><h1>VPN 接入日志</h1></div>
    <div className="panel"><div className="panel-header">
      <input placeholder="用户名" value={search} onChange={e=>setSearch(e.target.value)} style={{padding:'4px 10px',border:'1px solid var(--border)',borderRadius:0,fontSize:12,width:140}} />
      <input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={{padding:'4px 10px',border:'1px solid var(--border)',borderRadius:0,fontSize:12}} />
      <span style={{fontSize:12}}>至</span>
      <input type="date" value={to} onChange={e=>setTo(e.target.value)} style={{padding:'4px 10px',border:'1px solid var(--border)',borderRadius:0,fontSize:12}} />
      <button className="btn btn-primary btn-sm" onClick={load}>查询</button>
      <span className="badge badge-blue">{data.length} 条</span>
    </div>
    <div className="panel-body">
      {data.length ? <table><thead><tr><th>时间</th><th>用户</th><th>动作</th><th>来源IP</th><th>详情</th></tr></thead><tbody>
        {data.map(l => <tr key={l.id}><td>{(l.created_at||'').substring(0,19)}</td><td><strong>{l.username}</strong></td><td><span className={`badge badge-${l.action==='connect'?'success':'default'}`}>{l.action}</span></td><td><code>{l.ip||'-'}</code></td><td style={{fontSize:11,color:'var(--muted)'}}>{l.detail||'-'}</td></tr>)}
      </tbody></table> : <div className="empty">暂无记录</div>}
    </div></div></>
}
