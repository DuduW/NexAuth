import { useState, useEffect, useCallback } from 'react'
import { tr } from '../../i18n'
import { fetchApi } from '../../api'
import { toastSuccess, toastError } from '../Toast'
import { confirmDialog } from '../ConfirmModal'
import ActionMenu from '../ActionMenu'

/**
 * 准入与认证中心（/nac）— S4 服务配置 Panel 集合（RADIUS 配置四表）
 * 提取-搬入策略：原 RadiusConfig.jsx 四个 tab 各自独立成 Panel，
 * 数据加载由各 Panel 自持（原页共享一个 data state，拆分后按需加载）。
 *
 * Panel 列表：
 *   NasPanel        ← RadiusConfig tab 'nas'   （NAS 设备 CRUD + Secret 打码）
 *   DictPanel       ← RadiusConfig tab 'dict'  （属性字典 查询/搜索）
 *   UserReplyPanel  ← RadiusConfig tab 'urepl' （用户私有属性 增删）
 *   GroupCheckPanel ← RadiusConfig tab 'gchk'  （组认证控制 增删）
 */

/* ═══════════ NAS 设备（原 /radius-config tab nas）═══════════ */
export function NasPanel() {
  const [data, setData] = useState([])
  const [edit, setEdit] = useState(null)
  const [shown, setShown] = useState({})  // P2-5：Secret 默认打码，点击展示并记审计

  const reload = useCallback(() => { fetchApi('/nas').then(setData).catch(console.error) }, [])
  useEffect(reload, [reload])

  const add = async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    try {
      await fetchApi(`/nas?nasname=${fd.get('ip')}&secret=${fd.get('sec')}&type=${fd.get('type') || 'other'}&ports=${fd.get('ports') || 2000}&description=${fd.get('desc') || ''}`, { method: 'POST' })
      toastSuccess(`NAS ${fd.get('ip')} 已添加`)
      e.target.reset(); reload()
    } catch (err) { toastError(err.message) }
  }
  const save = async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    try {
      await fetchApi(`/nas/${edit}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nasname: fd.get('ip'), secret: fd.get('sec'), type: fd.get('type'), ports: fd.get('ports'), description: fd.get('desc') }) })
      toastSuccess('NAS 配置已更新')
      setEdit(null); reload()
    } catch (err) { toastError(err.message) }
  }
  const del = async (id) => {
    const row = data.find(n => n.id === id)
    const ok = await confirmDialog({
      title: `删除 NAS ${row?.nasname || ''}？`,
      message: '删除后该设备（AC/交换机）将无法通过 RADIUS 完成认证，其下所有用户立即受影响。',
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try { await fetchApi(`/nas/${id}`, { method: 'DELETE' }); toastSuccess('NAS 已删除'); reload() }
    catch (err) { toastError(err.message) }
  }
  const revealSecret = async (n) => {
    if (shown[n.id]) { setShown(s => ({ ...s, [n.id]: false })); return }
    try {
      // 展示动作记录审计日志（后端 /nas/{id}/reveal-secret）
      await fetchApi(`/nas/${n.id}/reveal-secret`, { method: 'POST' })
    } catch { /* 审计失败不阻断展示 */ }
    setShown(s => ({ ...s, [n.id]: true }))
  }

  return (
    <div className="panel-body">
      {edit ? <form key={edit} onSubmit={save} className="input-wrap" style={{ padding: '10px 14px', background: 'var(--bg-light)', borderRadius: 0, marginBottom: 8, border: '1px solid var(--blue)' }}>
        <input name="ip" placeholder="IP" defaultValue={data.find(n => n.id === edit)?.nasname} required />
        <input name="sec" placeholder="Secret" defaultValue={data.find(n => n.id === edit)?.secret} required />
        <select name="type" defaultValue={data.find(n => n.id === edit)?.type}><option value="other">其他</option><option value="huawei">华为</option><option value="cisco">Cisco</option></select>
        <input name="ports" type="number" placeholder="端口" defaultValue={data.find(n => n.id === edit)?.ports} style={{ width: 70 }} />
        <input name="desc" placeholder="描述" defaultValue={data.find(n => n.id === edit)?.description || ''} />
        <button className="btn btn-primary btn-sm" type="submit">保存</button>
        <button className="btn btn-outline btn-sm" type="button" onClick={() => setEdit(null)}>取消</button>
      </form> : <form onSubmit={add} className="input-wrap">
        <input name="ip" placeholder="IP 地址" required /><input name="sec" placeholder="Secret" required />
        <select name="type"><option value="other">其他</option><option value="huawei">华为</option><option value="cisco">Cisco</option></select>
        <input name="ports" type="number" placeholder="端口" defaultValue={2000} style={{ width: 70 }} />
        <input name="desc" placeholder="描述" />
        <button className="btn btn-primary btn-sm" type="submit">+ 添加</button>
      </form>}
      <table><thead><tr><th>IP</th><th>Secret</th><th>类型</th><th>端口</th><th>描述</th><th>操作</th></tr></thead><tbody>
        {data.map(n => <tr key={n.id}><td><code>{n.nasname}</code></td>
          <td><code style={{ cursor: 'pointer', userSelect: 'none' }} title="点击显示/隐藏 Secret" onClick={() => revealSecret(n)}>
            {shown[n.id] ? n.secret : '••••••••'}
          </code></td>
          <td><span className="badge badge-default">{n.type}</span></td><td>{n.ports}</td><td>{n.description || '-'}</td>
          <td><ActionMenu actions={[
            { label: '编辑', icon: '✎', onClick: () => setEdit(n.id) },
            { label: '删除', icon: '🗑', danger: true, onClick: () => del(n.id) },
          ]} /></td></tr>)}
        {data.length === 0 && <tr><td colSpan={6}><div className="empty">暂无</div></td></tr>}
      </tbody></table>
    </div>
  )
}

/* ═══════════ 属性字典（原 /radius-config tab dict）═══════════ */
export function DictPanel() {
  const [data, setData] = useState([])
  const [search, setSearch] = useState('')

  useEffect(() => { fetchApi('/radius/dict?limit=500').then(setData).catch(console.error) }, [])

  let filtered = data
  if (search) {
    filtered = data.filter(d => (d.Attribute || '').toLowerCase().includes(search.toLowerCase()) || (d.Vendor || '').toLowerCase().includes(search.toLowerCase()))
  }

  return (
    <div className="panel-body">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input placeholder={tr('search')} value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 13, width: 220 }} />
        <span className="badge badge-blue" style={{ marginLeft: 'auto' }}>匹配 {filtered.length} / {data.length} 条 · 展示前 100</span>
      </div>
      <table><thead><tr><th>ID</th><th>Type</th><th>Attribute</th><th>Vendor</th></tr></thead><tbody>
        {filtered.slice(0, 100).map(d => <tr key={d.id}><td>{d.id}</td><td><span className="badge badge-default">{d.Type}</span></td><td><code>{d.Attribute}</code></td><td>{d.Vendor || '-'}</td></tr>)}
        {filtered.length === 0 && <tr><td colSpan={4}><div className="empty">暂无</div></td></tr>}
      </tbody></table>
    </div>
  )
}

/* ═══════════ 用户私有属性（原 /radius-config tab urepl）═══════════ */
export function UserReplyPanel() {
  const [data, setData] = useState([])
  const [search, setSearch] = useState('')

  const reload = useCallback(() => { fetchApi('/radius/user-reply').then(setData).catch(console.error) }, [])
  useEffect(reload, [reload])

  const filtered = search
    ? data.filter(d => (d.username || '').toLowerCase().includes(search.toLowerCase()))
    : data

  const add = async (e) => {
    e.preventDefault(); const fd = new FormData(e.target)
    try {
      await fetchApi(`/radius/user-reply?username=${fd.get('u')}&attribute=${fd.get('a')}&value=${fd.get('v')}&op=:=`, { method: 'POST' })
      toastSuccess(`已为 ${fd.get('u')} 添加私有属性`)
      e.target.reset(); reload()
    } catch (err) { toastError(err.message) }
  }
  const del = async (id) => {
    const row = data.find(r => r.id === id)
    const ok = await confirmDialog({
      title: '删除该用户私有属性？',
      message: row ? `将删除用户 ${row.username} 的 ${row.attribute} 属性，其认证/授权结果将立即改变。` : '删除后该用户的认证/授权结果将立即改变。',
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try { await fetchApi(`/radius/user-reply/${id}`, { method: 'DELETE' }); toastSuccess('属性已删除'); reload() }
    catch (err) { toastError(err.message) }
  }

  return (
    <div className="panel-body">
      <div className="input-wrap" style={{ marginBottom: 12 }}><form onSubmit={add} className="input-wrap">
        <input name="u" placeholder="用户名" required />
        <input name="a" placeholder="属性名" required />
        <input name="v" placeholder="值" required />
        <button className="btn btn-primary btn-sm" type="submit">添加</button>
      </form></div>
      <div style={{ marginBottom: 12 }}>
        <input placeholder="按用户名筛选…" value={search} onChange={e => setSearch(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 13, width: 200 }} />
      </div>
      <table><thead><tr><th>用户名</th><th>属性</th><th>值</th><th>操作</th></tr></thead><tbody>
        {filtered.map(r => <tr key={r.id}><td><strong>{r.username}</strong></td><td><code>{r.attribute}</code></td><td>{r.value}</td><td><ActionMenu actions={[
          { label: '删除', icon: '🗑', danger: true, onClick: () => del(r.id) },
        ]} /></td></tr>)}
        {filtered.length === 0 && <tr><td colSpan={4}><div className="empty">暂无</div></td></tr>}
      </tbody></table>
    </div>
  )
}

/* ═══════════ 组认证控制（原 /radius-config tab gchk）═══════════ */
export function GroupCheckPanel() {
  const [data, setData] = useState([])

  const reload = useCallback(() => { fetchApi('/radius/group-check').then(setData).catch(console.error) }, [])
  useEffect(reload, [reload])

  const add = async (e) => {
    e.preventDefault(); const fd = new FormData(e.target)
    try {
      await fetchApi(`/radius/group-check?groupname=${fd.get('g')}&attribute=${fd.get('a')}&value=${fd.get('v')}&op=:=`, { method: 'POST' })
      toastSuccess(`已为分组 ${fd.get('g')} 添加认证控制`)
      e.target.reset(); reload()
    } catch (err) { toastError(err.message) }
  }
  const del = async (id) => {
    const row = data.find(r => r.id === id)
    const ok = await confirmDialog({
      title: '删除该组认证控制？',
      message: row ? `将删除分组「${row.groupname}」的 ${row.attribute} 检查项，该组的认证策略将立即改变。` : '删除后该组的认证策略将立即改变。',
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try { await fetchApi(`/radius/group-check/${id}`, { method: 'DELETE' }); toastSuccess('认证控制已删除'); reload() }
    catch (err) { toastError(err.message) }
  }

  return (
    <div className="panel-body">
      <div className="input-wrap" style={{ marginBottom: 12 }}><form onSubmit={add} className="input-wrap">
        <input name="g" placeholder="分组名" required />
        <input name="a" placeholder="属性名" required />
        <input name="v" placeholder="值" required />
        <button className="btn btn-primary btn-sm" type="submit">添加</button>
      </form></div>
      <table><thead><tr><th>分组</th><th>属性</th><th>操作符</th><th>值</th><th>操作</th></tr></thead><tbody>
        {data.map(r => <tr key={r.id}><td><span className="badge badge-default">{r.groupname}</span></td><td><code>{r.attribute}</code></td><td>{r.op}</td><td>{r.value}</td><td><ActionMenu actions={[
          { label: '删除', icon: '🗑', danger: true, onClick: () => del(r.id) },
        ]} /></td></tr>)}
        {data.length === 0 && <tr><td colSpan={5}><div className="empty">暂无</div></td></tr>}
      </tbody></table>
    </div>
  )
}
