import { useState, useEffect, useCallback } from 'react'
import { tr } from '../i18n'
import { api, fetchApi } from '../api'
import { toastSuccess, toastError } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import { formDialog } from '../components/FormModal'
import ActionMenu from '../components/ActionMenu'
import QrCanvas from '../components/QrCanvas'

export default function Users() {
  const [users, setUsers] = useState([])
  const [groups, setGroups] = useState([])
  const [totpMap, setTotpMap] = useState({})
  const [editUser, setEditUser] = useState(null)
  const [totpQr, setTotpQr] = useState(null)
  const [search, setSearch] = useState('')
  const [pg, setPg] = useState(1)
  const [size, setSize] = useState(20)
  // 用户 Profile 授权
  const [profList, setProfList] = useState([])
  const [profMap, setProfMap] = useState({})
  const [editSel, setEditSel] = useState(null)  // 编辑暂存 {group, origGroup, prof, origProf}

  const load = useCallback(() => { api.users().then(setUsers).catch(console.error) }, [])
  useEffect(() => {
    load()
    api.groups().then(setGroups).catch(console.error)
    fetchApi('/totp/status').then(arr => {
      const m = {}; arr.forEach(r => { m[r.username] = r.enabled ? 1 : 0 })
      setTotpMap(m)
    }).catch(console.error)
    fetchApi('/profiles').then(setProfList).catch(console.error)
    fetchApi('/profiles/assignments').then(arr => {
      const m = {}; arr.forEach(r => { m[r.username] = r.profile })
      setProfMap(m)
    }).catch(console.error)
  }, [load])

  const filtered = users.filter(u => !search || u.username.toLowerCase().includes(search.toLowerCase()))
  const total = Math.ceil(filtered.length / size) || 1
  const page = filtered.slice((pg-1)*size, pg*size)

  const create = async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    try {
      await api.createUser(fd.get('username'), fd.get('password') || '', fd.get('group'))
      toastSuccess(`用户 ${fd.get('username')} 已创建`)
      load()
    } catch (err) { toastError(err.message) }
  }
  const del = async (u) => {
    const ok = await confirmDialog({
      title: `删除用户 ${u}？`,
      message: '该用户的账号、分组关系及 TOTP 绑定将被移除，无法恢复。',
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try { await api.deleteUser(u); toastSuccess(`用户 ${u} 已删除`); load() }
    catch (err) { toastError(err.message) }
  }
  const chpw = async (u) => {
    const vals = await formDialog({
      title: `修改 ${u} 的密码`,
      fields: [
        { name: 'password', label: '新密码', type: 'password', required: true, placeholder: '至少 6 位',
          validate: v => v.length < 6 ? '密码至少 6 位' : null },
        { name: 'confirm', label: '确认密码', type: 'password', required: true,
          validate: (v, all) => v !== all.password ? '两次输入不一致' : null },
      ],
      submitText: '确认修改',
    })
    if (!vals) return
    try {
      await fetchApi(`/users/${u}/password?password=${encodeURIComponent(vals.password)}`, { method: 'PUT' })
      toastSuccess(`${u} 的密码已修改`)
    } catch (err) { toastError(err.message) }
  }
  const chgrp = async (u, g) => {
    await fetchApi(`/users/${u}/group?group=${encodeURIComponent(g)}`, { method: 'PUT' })
    setEditUser(null); load()
  }
  const assignProf = async (u, name) => {
    try {
      await fetchApi(`/users/${u}/assign-profile`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
      })
      fetchApi('/profiles/assignments').then(arr => {
        const m = {}; arr.forEach(r => { m[r.username] = r.profile })
        setProfMap(m)
      }).catch(console.error)
    } catch (err) { toastError(err.message) }
  }
  const profSummary = p => `${p.vlan ? 'VLAN' + p.vlan : ''}${p.qos_up_mbps || p.qos_down_mbps ? ` ${p.qos_up_mbps || '-'}/${p.qos_down_mbps || '-'}M` : ''}${p.acl_id ? ` ACL${p.acl_id}` : ''}`.trim() || '空策略'
  const startEdit = (u) => {
    // u 为当前行用户对象 {username, groupname}（来自 users 列表），非 username 字符串
    setEditUser(u.username); setEditSel({
      group: u.groupname && u.groupname !== '-' ? u.groupname : '',
      origGroup: u.groupname && u.groupname !== '-' ? u.groupname : '',
      prof: profMap[u.username] || '', origProf: profMap[u.username] || '',
    })
  }
  const cancelEdit = () => { setEditUser(null); setEditSel(null) }
  const saveEdit = async (u) => {
    const s = editSel
    if (!s) return
    try {
      // 组变化才调接口；空选 = 移出业务分组（后端 group='-' 分支）
      if ((s.group || '') !== (s.origGroup || '')) {
        await fetchApi(`/users/${u}/group?group=${encodeURIComponent(s.group || '-')}`, { method: 'PUT' })
      }
      if ((s.prof || '') !== (s.origProf || '')) {
        await fetchApi(`/users/${u}/assign-profile`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: s.prof || 'none' }),
        })
        fetchApi('/profiles/assignments').then(arr => {
          const m = {}; arr.forEach(r => { m[r.username] = r.profile }); setProfMap(m)
        }).catch(console.error)
      }
      cancelEdit(); load()
    } catch (err) { toastError(err.message) }
  }
  const totpEnable = async (u) => {
    try {
      const r = await fetchApi(`/totp/enable/${u}`, { method: 'POST' })
      setTotpQr({ u, uri: r.uri, secret: r.secret })
      setTotpMap({ ...totpMap, [u]: 1 })
    } catch (err) { toastError(err.message) }
  }
  const totpDisable = async (u) => {
    const ok = await confirmDialog({
      title: `禁用 ${u} 的 TOTP？`,
      message: '禁用后该用户下次登录将不再需要动态码验证，账号安全性降低。',
      confirmText: '禁用', danger: true,
    })
    if (!ok) return
    try {
      await fetchApi(`/totp/disable/${u}`, { method: 'POST' })
      setTotpMap({ ...totpMap, [u]: 0 })
      toastSuccess(`已禁用 ${u} 的 TOTP`)
    } catch (err) { toastError(err.message) }
  }

  return <>
    <div className="page-header"><h1>{tr('user_title')}</h1></div>

    {/* TOTP QR */}
    {totpQr && <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:999}} onClick={()=>setTotpQr(null)}>
      <div style={{background:'#fff',borderRadius:0,padding:'28px',textAlign:'center',boxShadow:'0 20px 60px rgba(0,0,0,0.3)',maxWidth:'90vw'}} onClick={e=>e.stopPropagation()}>
        <h4 style={{marginBottom:16}}>{totpQr.u} · TOTP 绑定</h4>
        <QrCanvas value={totpQr.uri} size={200} />
        <div style={{marginTop:8,fontSize:11,color:'var(--muted)',wordBreak:'break-all',width:200,margin:'8px auto 0'}}><code>{totpQr.secret}</code></div>
        <div style={{marginTop:10,fontSize:12,padding:'6px 10px',background:'var(--warn-bg)',color:'var(--warn)',borderRadius:0}}>
          ⚠ 密钥仅本次显示，请让用户立即扫码绑定，关闭后不可再查看
        </div>
        <button className="btn btn-outline btn-sm" style={{marginTop:12}} onClick={()=>setTotpQr(null)}>我已完成绑定，关闭</button>
      </div>
    </div>}

    <div className="panel"><div className="panel-header"><h4>{tr('create_user')}</h4></div>
    <div className="panel-body">
      <form onSubmit={create} className="input-wrap">
        <input name="username" placeholder={tr('username')} required />
        <input name="password" placeholder={tr('password')} />
        <select name="group">{groups.map(g=><option key={g.groupname} value={g.groupname}>{g.groupname} ({g.members})</option>)}</select>
        <button className="btn btn-primary" type="submit">{tr('create')}</button>
      </form></div></div>

    <div className="panel"><div className="panel-header"><h4>{tr('user_title')}</h4>
      <span className="badge badge-blue">{filtered.length} {tr('member_unit')}</span>
      <input placeholder={tr('search')} value={search} onChange={e=>{setPg(1);setSearch(e.target.value)}} />
    </div>
    <div className="panel-body">
      {users.length ? <>
        <table><thead><tr><th>{tr('username')}</th><th>{tr('group')}</th><th>TOTP</th><th>Profile</th><th>{tr('operation')}</th></tr></thead><tbody>
          {page.map((u,i)=><>
            <tr key={i}><td><strong>{u.username}</strong></td><td><span className="badge badge-default">{u.groupname||'-'}</span></td>
            <td>
              {totpMap[u.username] ? <span className="badge badge-success">已启用</span> : <span className="badge badge-default">未启用</span>}
            </td>
            <td>
              {profMap[u.username]
                ? <span className="badge badge-purple" title="已授权网络策略">{profMap[u.username]}</span>
                : <span style={{color:'var(--muted)'}}>-</span>}
            </td>
            <td>
              <ActionMenu actions={[
                ...(totpMap[u.username] ? [
                  { label: '重置 TOTP', icon: '⟳', onClick: () => totpEnable(u.username) },
                  { label: '禁用 TOTP', icon: '⊘', onClick: () => totpDisable(u.username) },
                ] : [{ label: '启用 TOTP', icon: '▶', onClick: () => totpEnable(u.username) }]),
                { label: editUser === u.username ? '取消编辑' : '编辑', icon: '✎', onClick: () => { editUser === u.username ? cancelEdit() : startEdit(u) } },
                { label: '修改密码', icon: '🔑', onClick: () => chpw(u.username) },
                { label: tr('delete'), icon: '🗑', danger: true, onClick: () => del(u.username) },
              ]} />
            </td></tr>
            {editUser === u.username && editSel && <tr key={'edit-'+i}><td colSpan={5} style={{background:'var(--bg-light)'}}>
              <div style={{display:'flex',alignItems:'center',gap:16,flexWrap:'wrap'}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:12,color:'var(--muted)'}}>修改分组:</span>
                  <select value={editSel.group} onChange={e=>setEditSel({...editSel, group:e.target.value})} style={{padding:'4px 8px',borderRadius:0,border:'1px solid var(--border)',fontSize:12}}>
                  {groups.map(g=><option key={g.groupname} value={g.groupname}>{g.groupname}</option>)}
                </select>
                </div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:12,color:'var(--muted)'}}>授权 Profile:</span>
                  <select value={editSel.prof} onChange={e=>setEditSel({...editSel, prof:e.target.value})} style={{padding:'4px 8px',borderRadius:0,border:'1px solid var(--border)',fontSize:12,maxWidth:260}}>
                    <option value="">未授权</option>
                    {profList.map(p=><option key={p.id} value={p.name}>{p.name} · {profSummary(p)}</option>)}
                  </select>
                </div>
                {editSel.prof && <span style={{fontSize:11,color:'var(--muted)'}}>换绑后重新认证生效</span>}
                <div style={{display:'flex',gap:8,marginLeft:'auto'}}>
                  {(editSel.group!==editSel.origGroup || (editSel.prof||'')!==(editSel.origProf||'')) &&
                    <span style={{fontSize:11,color:'var(--orange)',alignSelf:'center'}}>有未保存的修改</span>}
                  <button className="btn btn-primary btn-sm" onClick={()=>saveEdit(u.username)}>{tr('save')}</button>
                  <button className="btn btn-outline btn-sm" onClick={cancelEdit}>{tr('cancel')}</button>
                </div>
              </div>
            </td></tr>}
          </>)}
        </tbody></table>
        <Pagination pg={pg} total={total} setPg={setPg} size={size} setSize={s=>{setSize(s);setPg(1)}} />
      </> : <div className="empty">{tr('no_users')}</div>}
    </div></div></>
}

function Pagination({pg,total,setPg,size,setSize}) {
  return <div style={{display:'flex',justifyContent:'flex-end',gap:10,marginTop:12,fontSize:12,color:'var(--gray)',alignItems:'center'}}>
    <span>每页</span>
    <select value={size} onChange={e=>setSize(Number(e.target.value))} style={{padding:'3px 6px',border:'1px solid var(--border)',borderRadius:0,fontSize:12}}>
      <option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option>
    </select>
    <span>条</span>
    <button className="btn btn-outline btn-sm" disabled={pg<=1} onClick={()=>setPg(pg-1)}>◀</button>
    <span>{pg}/{total}</span>
    <button className="btn btn-outline btn-sm" disabled={pg>=total} onClick={()=>setPg(pg+1)}>▶</button>
  </div>
}
