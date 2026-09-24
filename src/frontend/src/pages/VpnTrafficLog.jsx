import { useState, useEffect } from 'react'
import { fetchApi } from '../api'
import CollapsePanel from '../components/CollapsePanel'

export default function VpnTrafficLog() {
  const [data, setData] = useState([])
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const load = () => {
    let url = '/vpn/traffic-log?limit=500'
    if (search) url += `&username=${search}`
    if (from) url += `&from_date=${from}`
    if (to) url += `&to_date=${to}`
    fetchApi(url).then(setData).catch(console.error)
  }
  useEffect(load, [])

  return <>
    <div className="page-header"><h1>VPN 流量日志</h1></div>
    <CollapsePanel title="流量记录" storageKey="vpntraffic_main" extra={<>
      <input placeholder="用户名" value={search} onChange={e=>setSearch(e.target.value)} style={{padding:'4px 10px',border:'1px solid var(--border)',borderRadius:0,fontSize:12,width:140}} />
      <input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={{padding:'4px 10px',border:'1px solid var(--border)',borderRadius:0,fontSize:12}} />
      <span style={{fontSize:12}}>至</span>
      <input type="date" value={to} onChange={e=>setTo(e.target.value)} style={{padding:'4px 10px',border:'1px solid var(--border)',borderRadius:0,fontSize:12}} />
      <button className="btn btn-primary btn-sm" onClick={load}>查询</button>
      <span className="badge badge-blue">{data.length} 条</span>
    </>}>
    <div className="panel-body">
      {data.length ? <table><thead><tr><th>用户</th><th className="num">上行</th><th className="num">下行</th><th className="num">总流量</th><th>开始</th><th>结束</th><th className="num">时长</th></tr></thead><tbody>
        {data.map(l => <tr key={l.id}>
          <td><strong>{l.username}</strong></td>
          <td className="num">{fmtBytes(l.up_bytes)}</td>
          <td className="num">{fmtBytes(l.down_bytes)}</td>
          <td className="num"><strong>{fmtBytes((l.up_bytes||0)+(l.down_bytes||0))}</strong></td>
          <td style={{fontSize:11}}>{(l.session_start||'').substring(0,19)}</td>
          <td style={{fontSize:11}}>{(l.session_end||'').substring(0,19)}</td>
          <td className="num">{fmtDur((l.duration_sec||0))}</td>
        </tr>)}
      </tbody></table> : <div className="empty">暂无记录</div>}
    </div>
    </CollapsePanel></>
}

function fmtBytes(b) {
  const n = b || 0
  if (n >= 1e9) return (n/1e9).toFixed(1)+' GB'
  if (n >= 1e6) return (n/1e6).toFixed(1)+' MB'
  if (n >= 1e3) return (n/1e3).toFixed(1)+' KB'
  return n+' B'
}

function fmtDur(s) {
  const m = Math.floor(s/60), h = Math.floor(m/60)
  if (h > 0) return h+'h'+(m%60)+'m'
  return m+'m'
}
