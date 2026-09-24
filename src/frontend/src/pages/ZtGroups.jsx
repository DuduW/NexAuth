import { useState, useEffect, useMemo } from 'react'
import { fetchApi } from '../api'
import { toastSuccess, toastError } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import ActionMenu from '../components/ActionMenu'

export default function ZtGroups() {
  const [groups, setGroups] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [userFilter, setUserFilter] = useState('')

  const load = () => {
    Promise.all([fetchApi('/zt/groups'), fetchApi('/users')]).then(([g, u]) => {
      setGroups(g); setUsers(u); setLoading(false)
    }).catch(() => setLoading(false))
  }
  useEffect(load, [])

  const groupList = useMemo(() => {
    const map = new Map()
    groups.forEach(g => {
      if (!map.has(g.group_name)) map.set(g.group_name, [])
      map.get(g.group_name).push(g.username)
    })
    return Array.from(map.entries()).map(([name, members]) => ({ name, count: members.length, users: members }))
  }, [groups])

  const groupNames = useMemo(() => [...new Set(groups.map(g => g.group_name))], [groups])

  const filteredUsers = useMemo(() => {
    if (!userFilter.trim()) return users
    return users.filter(u => u.username.toLowerCase().includes(userFilter.toLowerCase()))
  }, [users, userFilter])

  const addUser = async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    try {
      await fetchApi('/zt/groups', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:fd.get('username'),group_name:fd.get('group_name')})})
      toastSuccess(`已将 ${fd.get('username')} 加入分组 ${fd.get('group_name')}`)
      load(); e.target.reset(); setUserFilter('')
    } catch (err) { toastError(err.message) }
  }

  // 注意：零信任分组与 RADIUS 准入分组共用 radusergroup 数据，
  // 此处删除走 /groups/{name}（用户组管理接口），会同时影响准入分组
  const deleteGroup = async (name) => {
    const count = groupList.find(g => g.name === name)?.count || 0
    const ok = await confirmDialog({
      title: `删除分组「${name}」？`,
      message: `零信任分组与 RADIUS 准入分组共用数据，删除将同时影响两侧${count > 0 ? `（该组现有 ${count} 个成员，需先移除）` : ''}。`,
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try {
      await fetchApi(`/groups/${name}`, {method:'DELETE'})
      toastSuccess(`分组 ${name} 已删除`)
      load()
    } catch (e) { toastError(e.message) }
  }

  const removeUser = async (u, group) => {
    const ok = await confirmDialog({
      title: `移除 ${u} 的分组「${group}」？`,
      message: '移除后该用户的零信任策略与准入分组将同时失效。',
      confirmText: '移除', danger: true,
    })
    if (!ok) return
    try {
      await fetchApi(`/zt/groups/${u}?group_name=${encodeURIComponent(group)}`, {method:'DELETE'})
      toastSuccess(`已移除 ${u}`)
      load()
    } catch (e) { toastError(e.message) }
  }

  if (loading) return <div className="empty">加载中...</div>

  return <>
    <div className="page-header"><h1>零信任 · 分组管理 <span className="badge badge-blue">{groupList.length} 个分组</span></h1></div>

    {/* 分组管理（分组来自用户组管理） */}
    <div className="panel"><div className="panel-header"><h4>分组管理</h4>
      <span style={{fontSize:11,color:'var(--muted)'}}>分组在「用户管理 → 用户组管理」中创建/删除</span>
    </div><div className="panel-body">
      <table><thead><tr><th style={{width:120}}>分组名</th><th style={{width:80}}>用户数</th><th>操作</th></tr></thead><tbody>
        {groupList.map(g => <tr key={g.name}>
          <td><span className={`badge ${g.name==='ops'?'badge-danger':g.name==='staff'?'badge-blue':g.name==='guest'?'badge-purple':'badge-default'}`}>{g.name}</span></td>
          <td>{g.count}</td>
          <td><ActionMenu actions={[
            { label: '删除分组', icon: '🗑', danger: true, onClick: () => deleteGroup(g.name) },
          ]} /></td>
        </tr>)}
        {groupList.length===0 && <tr><td colSpan={3} className="empty">暂无分组</td></tr>}
      </tbody></table>
    </div></div>

    {/* 用户分配 */}
    <div className="panel"><div className="panel-header"><h4>用户分配</h4></div><div className="panel-body">
      <form onSubmit={addUser} className="input-wrap" style={{marginBottom:14}}>
        <input value={userFilter} onChange={e => setUserFilter(e.target.value)} placeholder="筛选用户..." style={{width:140}} />
        <select name="username" required style={{width:160}}>
          <option value="">选择用户</option>
          {filteredUsers.map(u => <option key={u.username} value={u.username}>{u.username}</option>)}
        </select>
        <input name="group_name" list="group-list" placeholder="输入或选择分组" required style={{width:160}} />
        <datalist id="group-list">{groupNames.map(n => <option key={n} value={n} />)}</datalist>
        <button className="btn btn-primary btn-sm" type="submit">添加</button>
      </form>
      <table><thead><tr><th>用户名</th><th>分组</th><th>操作</th></tr></thead><tbody>
        {groups.map(g => <tr key={g.username}>
          <td><strong>{g.username}</strong></td>
          <td><span className={`badge ${g.group_name==='ops'?'badge-danger':g.group_name==='staff'?'badge-blue':g.group_name==='guest'?'badge-purple':'badge-default'}`}>{g.group_name}</span></td>
          <td><ActionMenu actions={[
            { label: '移除', icon: '✕', danger: true, onClick: () => removeUser(g.username, g.group_name) },
          ]} /></td>
        </tr>)}
      </tbody></table>
    </div></div>
  </>
}
