import { useState, useEffect } from 'react'
import { fetchApi } from '../api'
import Pagination from '../components/Pagination'
import CollapsePanel from '../components/CollapsePanel'

export default function VpnConnLog() {
  const [data, setData] = useState([])
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [pg, setPg] = useState(1)
  const [size, setSize] = useState(20)

  const load = () => {
    let url = '/vpn/access-log?limit=500'
    if (search) url += `&username=${search}`
    if (from) url += `&from_date=${from}`
    if (to) url += `&to_date=${to}`
    fetchApi(url).then(d => { setData(d); setPg(1) }).catch(console.error)
  }
  useEffect(load, [])

  const total = Math.ceil(data.length / size) || 1
  const display = data.slice((pg - 1) * size, pg * size)

  return <>
    <div className="page-header"><h1>VPN 连接日志</h1></div>
    <CollapsePanel title="连接记录" storageKey="vpnconn_main" extra={<>
      <input placeholder="用户名" value={search} onChange={e => setSearch(e.target.value)}
        style={{ padding: '4px 10px', border: '1px solid var(--border)', borderRadius:0, fontSize: 12, width: 140 }} />
      <input type="date" value={from} onChange={e => setFrom(e.target.value)}
        style={{ padding: '4px 10px', border: '1px solid var(--border)', borderRadius:0, fontSize: 12 }} />
      <span style={{ fontSize: 12 }}>至</span>
      <input type="date" value={to} onChange={e => setTo(e.target.value)}
        style={{ padding: '4px 10px', border: '1px solid var(--border)', borderRadius:0, fontSize: 12 }} />
      <button className="btn btn-primary btn-sm" onClick={load}>查询</button>
      <span className="badge badge-blue">共 {data.length} 条</span>
    </>}>
    <div className="panel-body">
      {display.length ? <><table><thead><tr>
        <th>时间</th><th>用户</th><th>事件</th><th>IP</th><th>详情</th>
      </tr></thead><tbody>
        {display.map(l => <tr key={l.id}>
          <td style={{ fontSize: 11 }}>{(l.created_at || '').substring(0, 19)}</td>
          <td><strong>{l.username}</strong></td>
          <td>          <span className={`badge badge-${l.action === 'connect' ? 'success' : l.action === 'disconnect' ? 'danger' : 'default'}`}>
            {l.action === 'connect' ? '连接' : l.action === 'disconnect' ? '断开' : l.action}
          </span></td>
          <td><code>{l.ip || '-'}</code></td>
          <td style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {l.detail || '-'}
          </td>
        </tr>)}
      </tbody></table>
      <Pagination pg={pg} setPg={setPg} total={total} size={size} setSize={setSize} />
      </> : <div className="empty">暂无连接记录</div>}
    </div>
    </CollapsePanel></>
}
