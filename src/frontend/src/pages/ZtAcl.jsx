import { useState, useEffect, useMemo } from 'react'
import { fetchApi } from '../api'
import { toastSuccess, toastError } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import ActionMenu from '../components/ActionMenu'

export default function ZtAcl() {
  const [rules, setRules] = useState([])
  const [groups, setGroups] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState(null)

  const load = () => {
    fetchApi('/zt/acl').then(setRules).catch(console.error)
    fetchApi('/zt/groups').then(r => setGroups(r.filter(g => !g.username.startsWith('_group_')))).catch(console.error)
  }
  useEffect(load, [])

  const groupNames = useMemo(() => [...new Set([...groups.map(g => g.group_name), ...rules.map(r => r.group_name)])], [groups, rules])
  const cur = editId ? rules.find(r => r.id === editId) : {}

  const save = async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    const data = { group_name: fd.get('group_name'), rule_name: fd.get('rule_name'), allow_domains: fd.get('allow_domains'), allow_cidrs: fd.get('allow_cidrs'), allow_ports: fd.get('allow_ports'), priority: parseInt(fd.get('priority'))||100 }
    if (!data.group_name || !data.group_name.trim()) { toastError('分组不能为空'); return }
    try {
      if (editId) {
        await fetchApi(`/zt/acl/${editId}`, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      } else {
        await fetchApi('/zt/acl', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
      }
      toastSuccess(`规则「${data.rule_name}」已${editId?'更新':'创建'}`)
      setEditId(null); setShowForm(false); load()
    } catch (err) { toastError(err.message) }
  }

  const del = async (id) => {
    const row = rules.find(r => r.id === id)
    const ok = await confirmDialog({
      title: `删除规则「${row?.rule_name || ''}」？`,
      message: `分组「${row?.group_name || ''}」的该放行规则将被移除，相关流量可能被默认策略拦截。`,
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try { await fetchApi(`/zt/acl/${id}`,{method:'DELETE'}); toastSuccess('规则已删除'); load() }
    catch (err) { toastError(err.message) }
  }

  return <>
    <div className="page-header"><h1>零信任 · ACL 规则 <span className="badge badge-blue">{rules.length}</span></h1></div>

    {showForm && <div className="panel"><div className="panel-body">
      <form onSubmit={save} className="input-wrap" style={{flexWrap:'wrap'}}>
        <input name="group_name" list="group-list-acl" placeholder="分组" defaultValue={cur?.group_name} style={{width:100}} />
        <datalist id="group-list-acl">{groupNames.map(n => <option key={n} value={n} />)}</datalist>
        <input name="rule_name" placeholder="规则名" required defaultValue={cur?.rule_name} style={{width:120}} />
        <input name="allow_domains" placeholder="域名 *.qcc.com" defaultValue={cur?.allow_domains} style={{width:180}} />
        <input name="allow_cidrs" placeholder="IP/CIDR" defaultValue={cur?.allow_cidrs} style={{width:150}} />
        <input name="allow_ports" placeholder="端口 80,443" defaultValue={cur?.allow_ports} style={{width:100}} />
        <input name="priority" type="number" placeholder="优先级" defaultValue={cur?.priority||100} style={{width:70}} />
        <button className="btn btn-primary btn-sm" type="submit">{editId?'更新':'创建'}</button>
        <button className="btn btn-outline btn-sm" type="button" onClick={()=>{setEditId(null);setShowForm(false)}}>取消</button>
      </form>
    </div></div>}

    <button className="btn btn-outline btn-sm" onClick={()=>{setEditId(null);setShowForm(true)}} style={{marginBottom:8}}>+ 添加规则</button>

    <div className="panel"><div className="panel-body">
      <table><thead><tr><th>分组</th><th>规则</th><th>域名</th><th>IP</th><th>端口</th><th>优先</th><th>操作</th></tr></thead><tbody>
        {rules.map(r => <tr key={r.id}>
          <td><span className={`badge ${r.group_name==='ops'?'badge-danger':r.group_name==='staff'?'badge-blue':'badge-default'}`}>{r.group_name}</span></td>
          <td><strong>{r.rule_name}</strong></td>
          <td style={{fontSize:12,maxWidth:160,overflow:'hidden',textOverflow:'ellipsis'}}>{r.allow_domains||'-'}</td>
          <td><code>{r.allow_cidrs||'-'}</code></td>
          <td>{r.allow_ports||'-'}</td>
          <td>{r.priority}</td>
          <td><ActionMenu actions={[
            { label: '编辑', icon: '✎', onClick: () => { setEditId(r.id); setShowForm(true) } },
            { label: '删除', icon: '🗑', danger: true, onClick: () => del(r.id) },
          ]} /></td>
        </tr>)}
        {rules.length===0 && <tr><td colSpan={7} className="empty">暂无规则</td></tr>}
      </tbody></table>
    </div></div>
  </>
}
