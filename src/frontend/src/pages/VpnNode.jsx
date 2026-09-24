import { useState, useEffect } from 'react'
import { fetchApi } from '../api'
import { toastSuccess, toastError } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import ActionMenu from '../components/ActionMenu'

export default function VpnNode() {
  const [status, setStatus] = useState(null)
  const [peers, setPeers] = useState([])
  const [config, setConfig] = useState(null)
  const [pool, setPool] = useState(null)
  const [users, setUsers] = useState([])
  const [newUser, setNewUser] = useState('')
  const [acting, setActing] = useState(false)
  const [userFilter, setUserFilter] = useState('')

  const load = () => {
    fetchApi('/vpn/server/status').then(setStatus).catch(console.error)
    fetchApi('/vpn/peers').then(setPeers).catch(console.error)
    fetchApi('/vpn/server/config').then(setConfig).catch(console.error)
    fetchApi('/vpn/pool').then(setPool).catch(console.error)
    fetchApi('/users').then(setUsers).catch(console.error)
  }
  useEffect(load, [])

  const addPeer = async (e) => {
    e.preventDefault()
    if (!newUser) return
    setActing(true)
    try {
      await fetchApi(`/vpn/peers?username=${newUser}`, { method: 'POST' })
      toastSuccess(`已为 ${newUser} 创建对端`)
      setNewUser(''); load()
    } catch (err) { toastError(err.message) }
    setActing(false)
  }

  const togglePeer = async (u, en) => {
    const resName = peers.find(p => p.username === u)
    if (en === false && resName?.online) {
      const ok = await confirmDialog({
        title: `禁用 ${u} 的对端？`,
        message: `该用户当前在线，禁用后将立即断开其 VPN 连接。`,
        confirmText: '禁用并断开', danger: true,
      })
      if (!ok) return
    }
    try {
      await fetchApi(`/vpn/peers/${u}?enabled=${en}`, { method: 'PUT' })
      toastSuccess(en ? `已启用 ${u}` : `已禁用 ${u}`)
      load()
    } catch (err) { toastError(err.message) }
  }

  const deletePeer = async (u) => {
    const ok = await confirmDialog({
      title: `删除 ${u} 的对端？`,
      message: '该用户的 VPN 配置与 IP 分配将被释放，需重新创建对端才能再次接入。',
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try {
      await fetchApi(`/vpn/peers/${u}`, { method: 'DELETE' })
      toastSuccess(`已删除 ${u} 的对端`)
      load()
    } catch (err) { toastError(err.message) }
  }

  const downloadConf = async (u) => {
    const token = localStorage.getItem('token')
    window.open(`/api/vpn/peers/${u}/conf?_token=${token}`, '_blank')
  }

  const saveConfig = async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    const body = {}
    for (let k of ['port','mtu','dns','subnet']) if (fd.get(k)) body[k] = k==='port'||k==='mtu'?Number(fd.get(k)):fd.get(k)
    try {
      await fetchApi('/vpn/server/config', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
      toastSuccess('服务器配置已更新')
      load()
    } catch (err) { toastError(err.message) }
  }

  const ctrlServer = async (action) => {
    if (action === 'stop') {
      const online = status?.online_peers || 0
      const ok = await confirmDialog({
        title: '停止 VPN 服务？',
        message: online > 0
          ? `当前有 ${online} 个用户在线，停止后将立即断开全部连接。`
          : '停止后所有用户将无法建立新的 VPN 连接。',
        confirmText: '停止服务', danger: true,
      })
      if (!ok) return
    }
    setActing(true)
    try {
      await fetchApi(`/vpn/server/${action}`, { method: 'POST' })
      toastSuccess(action === 'stop' ? 'VPN 服务已停止' : 'VPN 服务已启动')
      load()
    } catch (err) { toastError(err.message) }
    setActing(false)
  }

  return <>
    <div className="page-header"><h1>节点管理</h1></div>

    <div className="stat-cards">
      <div className="stat-card"><div className="label">服务状态</div>
        <div style={{display:'flex',alignItems:'center',gap:8}}>
          <div className="value" style={{color:status?.running?'var(--green)':'var(--red)',fontSize:20}}>{status?.running?'🟢 运行中':'🔴 未运行'}</div>
          {status?.running
            ? <button className="btn btn-outline btn-sm" disabled={acting} onClick={()=>ctrlServer('stop')}>{acting?'处理中...':'停止'}</button>
            : <button className="btn btn-primary btn-sm" disabled={acting} onClick={()=>ctrlServer('start')}>{acting?'处理中...':'启动'}</button>}
        </div>
      </div>
      <div className="stat-card"><div className="label">监听端口</div><div className="value" style={{fontSize:20}}>UDP {status?.port||'-'}</div></div>
      <div className="stat-card"><div className="label">子网</div><div className="value" style={{fontSize:16}}>{status?.subnet||'-'}</div></div>
      <div className="stat-card"><div className="label">在线/已分配</div><div className="value" style={{fontSize:20}}>{status?.online_peers||0}/{pool?.used||0}</div></div>
    </div>

    {/* Config */}
    <div className="panel">
      <div className="panel-header"><h4>服务器配置</h4></div>
      <div className="panel-body">
        <form onSubmit={saveConfig} className="input-wrap">
          <span style={{fontSize:12}}>端口</span><input name="port" type="number" defaultValue={config?.port} style={{width:80}} />
          <span style={{fontSize:12}}>MTU</span><input name="mtu" type="number" defaultValue={config?.mtu} style={{width:80}} />
          <span style={{fontSize:12}}>DNS</span><input name="dns" defaultValue={config?.dns} style={{width:130}} />
          <span style={{fontSize:12}}>子网</span><input name="subnet" defaultValue={config?.subnet} style={{width:140}} />
          <button className="btn btn-primary btn-sm" type="submit">保存</button>
        </form>
      </div>
    </div>

    {/* Add peer */}
    <div className="panel">
      <div className="panel-header"><h4>添加对端</h4><span className="badge badge-blue">IP 池 {pool?.used}/{pool?.available}</span></div>
      <div className="panel-body">
        <form onSubmit={addPeer} className="input-wrap">
          <input placeholder="筛选用户..." value={userFilter} onChange={e=>setUserFilter(e.target.value)} style={{padding:'6px 10px',border:'1px solid var(--border)',borderRadius:0,fontSize:13,width:160}} />
          <select value={newUser} onChange={e=>setNewUser(e.target.value)} style={{padding:'6px 10px',borderRadius:0,border:'1px solid var(--border)',fontSize:13}}>
            <option value="">选择用户...</option>
            {users.filter(u=>!peers.find(p=>p.username===u.username) && (!userFilter||u.username.includes(userFilter))).map(u=><option key={u.username} value={u.username}>{u.username} ({u.groupname})</option>)}
          </select>
          <button className="btn btn-primary btn-sm" type="submit" disabled={!newUser||acting}>{acting?'创建中...':'创建对端'}</button>
        </form>
      </div>
    </div>

    {/* Peer list */}
    <div className="panel">
      <div className="panel-header"><h4>对端列表</h4><span className="badge badge-blue">{peers.length} 个</span></div>
      <div className="panel-body">
        {peers.length ? <table><thead><tr><th>用户</th><th>IP</th><th>公钥</th><th>流量 RX/TX</th><th>状态</th><th>操作</th></tr></thead><tbody>
          {peers.map(p => <tr key={p.id}>
            <td><strong>{p.username}</strong></td>
            <td><code>{p.address}</code></td>
            <td><code style={{fontSize:10}}>{p.public_key?.substring(0,12)}...</code></td>
            <td>{fmtBytes(p.transfer_rx)} / {fmtBytes(p.transfer_tx)}</td>
            <td>
              {p.enabled ? (p.online ? <span className="badge badge-success">在线</span> : <span className="badge badge-default">离线</span>) : <span className="badge badge-danger">禁用</span>}
            </td>
            <td>
              <ActionMenu actions={[
                p.enabled
                  ? { label: '禁用', icon: '⊘', onClick: () => togglePeer(p.username, false) }
                  : { label: '启用', icon: '▶', onClick: () => togglePeer(p.username, true) },
                { label: '下载配置', icon: '⤓', onClick: () => downloadConf(p.username) },
                { label: '删除', icon: '🗑', danger: true, onClick: () => deletePeer(p.username) },
              ]} />
            </td>
          </tr>)}
        </tbody></table> : <div className="empty">暂无对端</div>}
      </div>
    </div>
  </>
}

function fmtBytes(b) {
  const n = b || 0
  if (n >= 1e9) return (n/1e9).toFixed(1)+' GB'
  if (n >= 1e6) return (n/1e6).toFixed(1)+' MB'
  if (n >= 1e3) return (n/1e3).toFixed(1)+' KB'
  return n+' B'
}
