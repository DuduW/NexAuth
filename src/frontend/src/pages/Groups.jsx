import { useState, useEffect } from 'react'
import { tr } from '../i18n'
import { fetchApi } from '../api'
import { toastSuccess, toastError } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import ActionMenu from '../components/ActionMenu'

export default function Groups() {
  const [data, setData] = useState([])
  const [search, setSearch] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [editName, setEditName] = useState('')

  const load = () => { fetchApi('/groups').then(setData).catch(console.error) }
  useEffect(load, [])

  const filtered = data.filter(g => !search || g.groupname.toLowerCase().includes(search.toLowerCase()))

  const add = async (e) => {
    e.preventDefault()
    const name = e.target.groupname.value.trim()
    if (!name) return
    try {
      await fetchApi(`/groups?groupname=${encodeURIComponent(name)}`, { method: 'POST' })
      toastSuccess(`分组 ${name} 已创建`)
      e.target.reset(); load()
    } catch (err) { toastError(err.message) }
  }

  const rename = async (e) => {
    e.preventDefault()
    const newName = e.target.newName.value.trim()
    if (!newName) return
    try {
      await fetchApi(`/groups/${editName}?new_name=${encodeURIComponent(newName)}`, { method: 'PUT' })
      toastSuccess(`已重命名为 ${newName}`)
      setEditMode(false); setEditName(''); load()
    } catch (err) { toastError(err.message) }
  }

  const del = async (name) => {
    const ok = await confirmDialog({
      title: `删除分组「${name}」？`,
      message: '该分组的回复属性与认证控制将一并删除，组内成员的准入策略会改变。（有成员的分组已禁止删除）',
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try { await fetchApi(`/groups/${name}`, { method: 'DELETE' }); toastSuccess(`分组 ${name} 已删除`); load() }
    catch (e) { toastError(e.message) }
  }

  return <>
    <div className="page-header"><h1>{tr('group_title')}</h1></div>
    <div className="panel"><div className="panel-header"><h4>{tr('existing_groups')}</h4>
      <span className="badge badge-blue">{filtered.length} {tr('groups_count')}</span>
      <input placeholder={tr('search_group')} value={search} onChange={e=>setSearch(e.target.value)} />
    </div>
    <div className="panel-body">
      {/* Add form */}
      <form onSubmit={add} className="input-wrap">
        <input name="groupname" placeholder="新分组名" required style={{width:200}} />
        <button className="btn btn-primary btn-sm" type="submit">+ 添加分组</button>
      </form>

      {/* Rename modal */}
      {editMode && <form onSubmit={rename} className="input-wrap" style={{marginTop:8,padding:'12px',background:editMode?'var(--bg-light)':'',borderRadius:0,border:'1px solid var(--blue)'}}>
        <span style={{fontSize:13,fontWeight:600}}>重命名: {editName} →</span>
        <input name="newName" placeholder="新名称" required autoFocus />
        <button className="btn btn-primary btn-sm" type="submit">{tr('save')}</button>
        <button className="btn btn-outline btn-sm" type="button" onClick={()=>{setEditMode(false);setEditName('')}}>{tr('cancel')}</button>
      </form>}

      {/* Table */}
      {data.length ? <table style={{marginTop:editMode?8:0}}><thead><tr><th>{tr('group')}</th><th>{tr('members')}</th><th>下发属性</th><th>{tr('operation')}</th></tr></thead><tbody>
        {filtered.map(g => <tr key={g.groupname}>
          <td><span className="badge badge-default">{g.groupname}</span></td>
          <td>{g.members} {tr('member_unit')}</td>
          <td>{g.profile_attrs > 0
            ? <span className="badge badge-blue" title="VLAN/QoS/ACL 下发属性数（在 RADIUS · Profile 页面管理）">{g.profile_attrs} 项</span>
            : <span style={{color:'var(--muted)'}}>-</span>}</td>
          <td>
            <ActionMenu actions={[
              { label: tr('edit'), icon: '✎', onClick: () => { setEditName(g.groupname); setEditMode(true) } },
              { label: tr('delete'), icon: '🗑', danger: true, disabled: g.members > 0, onClick: () => del(g.groupname) },
            ]} />
          </td>
        </tr>)}
      </tbody></table> : <div className="empty">{tr('no_data')}</div>}
    </div></div></>
}
