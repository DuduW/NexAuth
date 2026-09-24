import { useState, useEffect, useCallback } from 'react'
import { fetchApi } from '../api'

export default function ZtDevices() {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    fetchApi('/zt/devices').then(d => { setDevices(d); setLoading(false) }).catch(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  const online = devices.filter(d => d.online).length

  if (loading) return <div className="empty">加载中...</div>

  return <>
    <div className="page-header"><h1>零信任 · 接入设备 <span className="badge badge-blue">{devices.length} 台</span></h1></div>

    <div className="panel">
      <div className="panel-header">
        <h4>设备列表</h4>
        <span className="badge badge-success">{online} 在线</span>
        <button className="btn btn-outline btn-sm" onClick={load}>刷新</button>
      </div>
      <div className="panel-body">
        {devices.length ? <table><thead><tr>
          <th>设备名</th><th>Mesh IP</th><th>使用人</th><th>状态</th><th>最后在线</th>
        </tr></thead><tbody>
          {devices.map(d => <tr key={d.id}>
            <td><strong>{d.name || '-'}</strong></td>
            <td><code>{d.ip || '-'}</code></td>
            <td>{d.user || '-'}</td>
            <td><span className={`badge badge-${d.online ? 'success' : 'default'}`}>{d.online ? '在线' : '离线'}</span></td>
            <td style={{ fontSize: 11 }}>{d.last_seen || '-'}</td>
          </tr>)}
        </tbody></table> : <div className="empty">暂无接入设备</div>}
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10 }}>
          设备数据来自 Headscale 控制面，「使用人」对应 Headscale 用户（接入时写入的用户名）
        </div>
      </div>
    </div>
  </>
}
