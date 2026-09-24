import { useState, useEffect } from 'react'
import { fetchApi } from '../api'

export default function ZtLog() {
  const [logs, setLogs] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ username: '', action: '', target: '' })

  const load = (p = 1) => {
    setLoading(true)
    const params = new URLSearchParams({ page: String(p), size: '20' })
    if (filters.username) params.set('username', filters.username)
    if (filters.action) params.set('action', filters.action)
    fetchApi(`/zt/log?${params}`).then(r => { setLogs(r.data); setTotal(r.total); setPage(p); setLoading(false) }).catch(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  const applyFilter = (e) => { e.preventDefault(); load(1) }
  const totalPages = Math.ceil(total / 20)

  return <>
    <div className="page-header"><h1>零信任 · 审计日志 <span className="badge badge-blue">{total}</span></h1></div>
    <div className="panel"><div className="panel-body">
      <form onSubmit={applyFilter} className="input-wrap" style={{marginBottom:12}}>
        <input value={filters.username} onChange={e => setFilters({...filters, username: e.target.value})} placeholder="用户名" style={{width:100}} />
        <select value={filters.action} onChange={e => setFilters({...filters, action: e.target.value})}>
          <option value="">全部</option><option value="allow">放行</option><option value="deny">拒绝</option>
        </select>
        <button className="btn btn-primary btn-sm" type="submit">查询</button>
      </form>

      {loading ? <div className="empty">加载中...</div> :
      <table><thead><tr><th>时间</th><th>用户</th><th>分组</th><th>源IP</th><th>访问目标</th><th>动作</th><th>原因</th></tr></thead><tbody>
        {logs.map(l => <tr key={l.id}>
          <td style={{fontSize:12}}>{l.created_at?.replace('T',' ').substring(0,19)}</td>
          <td><strong>{l.username}</strong></td>
          <td>{l.group_name||'-'}</td>
          <td><code>{l.src_ip}</code></td>
          <td><code>{l.domain || l.target || '-'}</code></td>
          <td><span className={`badge ${l.action==='allow'?'badge-success':'badge-danger'}`}>{l.action==='allow'?'放行':'拒绝'}</span></td>
          <td style={{fontSize:12,maxWidth:180}}>{l.reason||'-'}</td>
        </tr>)}
        {logs.length===0 && <tr><td colSpan={7} className="empty">暂无日志</td></tr>}
      </tbody></table>}

      {totalPages > 1 && <div style={{display:'flex',gap:6,justifyContent:'center',marginTop:12}}>
        {Array.from({length: totalPages}, (_, i) => (
          <button key={i+1} onClick={()=>load(i+1)} className={`btn btn-sm ${page===i+1?'btn-primary':'btn-outline'}`}>{i+1}</button>
        ))}
      </div>}
    </div></div>
  </>
}
