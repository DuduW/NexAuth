import { useState, useEffect } from 'react'
import { fetchApi } from '../api'
import { toastSuccess, toastError } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import ActionMenu from '../components/ActionMenu'

export default function VpnPerm() {
  const [res, setRes] = useState([])
  const [users, setUsers] = useState([])
  const [peers, setPeers] = useState([])
  const [selUser, setSelUser] = useState('')
  const [userAccess, setUserAccess] = useState([])
  const [editRes, setEditRes] = useState(null)

  const load = () => {
    fetchApi('/vpn/resources').then(setRes).catch(console.error)
    fetchApi('/users').then(setUsers).catch(console.error)
    fetchApi('/vpn/peers').then(setPeers).catch(console.error)
  }
  useEffect(load, [])

  const loadUserAccess = async (u) => {
    setSelUser(u)
    try {
      const d = await fetchApi(`/vpn/user-access/${u}`)
      setUserAccess(d)
    } catch (err) { toastError(err.message) }
  }

  const delRes = async (id) => {
    const row = res.find(r => r.id === id)
    const ok = await confirmDialog({
      title: `删除资源「${row?.name || ''}」？`,
      message: '所有已授权该资源的用户将立即失去对应访问权限。',
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try { await fetchApi(`/vpn/resources/${id}`, {method:'DELETE'}); toastSuccess('资源已删除'); load() }
    catch (err) { toastError(err.message) }
  }

  const grant = async (uid) => {
    try {
      await fetchApi(`/vpn/user-access/${selUser}/${uid}`, {method:'POST'})
      toastSuccess('已授权')
      loadUserAccess(selUser)
    } catch (err) { toastError(err.message) }
  }

  const revoke = async (uid) => {
    const row = userAccess.find(a => a.id === uid)
    const ok = await confirmDialog({
      title: `移除授权「${row?.name || ''}」？`,
      message: `${selUser} 将立即失去该资源的 VPN 访问权限。`,
      confirmText: '移除授权', danger: true,
    })
    if (!ok) return
    try {
      await fetchApi(`/vpn/user-access/${selUser}/${uid}`, {method:'DELETE'})
      toastSuccess('已移除授权')
      loadUserAccess(selUser)
    } catch (err) { toastError(err.message) }
  }

  const createPeer = async (u) => {
    try {
      await fetchApi(`/vpn/permissions/${u}`, {method:'POST'})
      toastSuccess(`${u} 已创建对端`)
      load()
    } catch (err) { toastError(err.message) }
  }

  const addRes = async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    try {
      await fetchApi(`/vpn/resources?name=${fd.get('name')}&type=${fd.get('type')}&value=${fd.get('value')}&description=${fd.get('desc')}`, {method:'POST'})
      toastSuccess(`资源 ${fd.get('name')} 已创建`)
      setEditRes(null); load()
    } catch (err) { toastError(err.message) }
  }

  const updateRes = async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    try {
      await fetchApi(`/vpn/resources/${editRes}`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:fd.get('name'),value:fd.get('value'),description:fd.get('desc')})})
      toastSuccess('资源已更新')
      setEditRes(null); load()
    } catch (err) { toastError(err.message) }
  }

  const revokePeer = async (u) => {
    const ok = await confirmDialog({
      title: `撤销 ${u} 的 VPN 对端？`,
      message: '该用户的对端配置与全部资源授权将被删除，VPN 立即断开且需重新创建对端。',
      confirmText: '撤销并删除', danger: true,
    })
    if (!ok) return
    try {
      await fetchApi(`/vpn/permissions/${u}`, {method:'DELETE'})
      toastSuccess(`已撤销 ${u} 的对端`)
      load()
    } catch (err) { toastError(err.message) }
  }

  const TYPE_NAMES = { ip: 'IP地址', segment: '地址段', group: 'IP组' }

  return <>
    <div className="page-header"><h1>VPN 权限管理</h1></div>

    {/* ── IP 资源管理 ── */}
    <div className="panel">
      <div className="panel-header"><h4>IP 资源</h4><span className="badge badge-blue">{res.length} 个</span></div>
      <div className="panel-body">
        {/* Add/Edit form */}
        {editRes !== null && <form onSubmit={editRes ? updateRes : addRes} className="input-wrap" style={{padding:'10px 14px',background:'var(--bg-light)',borderRadius:0,marginBottom:8,border:'1px solid var(--blue)'}}>
          <input name="name" placeholder="名称" required defaultValue={editRes?res.find(r=>r.id===editRes)?.name:''} style={{width:120}} />
          <select name="type" defaultValue={editRes?res.find(r=>r.id===editRes)?.type:'segment'}>
            <option value="ip">IP地址</option><option value="segment">地址段</option><option value="group">IP组</option>
          </select>
          <input name="value" placeholder="CIDR (如 192.168.0.0/16)" required defaultValue={editRes?res.find(r=>r.id===editRes)?.value:''} style={{width:200}} />
          <input name="desc" placeholder="描述" defaultValue={editRes?res.find(r=>r.id===editRes)?.description:''} />
          <button className="btn btn-primary btn-sm" type="submit">保存</button>
          <button className="btn btn-outline btn-sm" type="button" onClick={()=>setEditRes(null)}>取消</button>
        </form>}
        <button className="btn btn-outline btn-sm" onClick={()=>setEditRes(0)} style={{marginBottom:8}}>+ 添加资源</button>

        <table><thead><tr><th>名称</th><th>类型</th><th>值</th><th>描述</th><th>操作</th></tr></thead><tbody>
          {res.map(r => <tr key={r.id}><td><strong>{r.name}</strong></td><td><span className="badge badge-default">{TYPE_NAMES[r.type]}</span></td><td><code>{r.value}</code></td><td>{r.description||'-'}</td>
          <td><ActionMenu actions={[
            { label: '编辑', icon: '✎', onClick: () => setEditRes(r.id) },
            { label: '删除', icon: '🗑', danger: true, onClick: () => delRes(r.id) },
          ]} /></td></tr>)}
        </tbody></table>
      </div></div>

    {/* ── 用户授权 ── */}
    <div className="panel">
      <div className="panel-header"><h4>用户授权</h4>
        <select value={selUser} onChange={e=>loadUserAccess(e.target.value)} style={{padding:'5px 12px',borderRadius:0,border:'1px solid var(--border)',fontSize:13}}>
          <option value="">选择用户...</option>
          {users.map(u=><option key={u.username} value={u.username}>{u.username}</option>)}
        </select>
      </div>
      <div className="panel-body">
        {selUser ? <>
          <div style={{marginBottom:12,display:'flex',alignItems:'center',gap:8}}>
            <span style={{fontSize:12}}>已授权资源:</span>
            {userAccess.length===0 && <span style={{color:'var(--muted)',fontSize:12}}>无</span>}
            {userAccess.map(a => <span key={a.id} className="badge badge-success" style={{cursor:'pointer'}} onClick={()=>revoke(a.id)} title="点击移除">{a.name} ✕</span>)}
            {!peers.find(p=>p.username===selUser) && <button className="btn btn-primary btn-sm" onClick={()=>createPeer(selUser)}>生成对端</button>}
          </div>
          <div style={{fontSize:11,color:'var(--muted)',marginBottom:8}}>点击已有资源授权给 {selUser}：</div>
          <table><thead><tr><th>资源</th><th>类型</th><th>值</th><th>操作</th></tr></thead><tbody>
            {res.filter(r=>!userAccess.find(a=>a.id===r.id)).map(r => <tr key={r.id}><td>{r.name}</td><td><span className="badge badge-default">{TYPE_NAMES[r.type]}</span></td><td><code>{r.value}</code></td>
            <td><ActionMenu actions={[
              { label: '授权', icon: '✓', onClick: () => grant(r.id) },
            ]} /></td></tr>)}
          </tbody></table>
        </> : <div className="empty">选择用户后查看/编辑授权</div>}
      </div></div>

    {/* ── 已授权用户列表 ── */}
    <div className="panel">
      <div className="panel-header"><h4>已创建对端的用户</h4><span className="badge badge-blue">{peers.length} 人</span></div>
      <div className="panel-body">
        {peers.length ? <table><thead><tr><th>用户</th><th>IP</th><th>公钥</th><th>操作</th></tr></thead><tbody>
          {peers.map(p => <tr key={p.id}><td><strong>{p.username}</strong></td><td><code>{p.address}</code></td>
          <td><code style={{fontSize:11,color:'var(--muted)'}} title={p.public_key}>{(p.public_key || '').slice(0,16)}...</code></td>
          <td>
            <ActionMenu actions={[
              { label: '下载配置', icon: '⤓', onClick: () => window.open(`/api/vpn/peers/${p.username}/conf?_token=${localStorage.getItem('token')}`, '_blank') },
              { label: '编辑权限', icon: '✎', onClick: () => loadUserAccess(p.username) },
              { label: '撤销对端', icon: '🗑', danger: true, onClick: () => revokePeer(p.username) },
            ]} />
          </td></tr>)}
        </tbody></table> : <div className="empty">暂无</div>}
      </div></div>
  </>
}
