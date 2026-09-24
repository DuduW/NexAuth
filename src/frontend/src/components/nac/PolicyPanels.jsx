import { useState, useEffect, useCallback } from 'react'
import { tr } from '../../i18n'
import { api, fetchApi } from '../../api'
import { toastSuccess, toastError } from '../Toast'
import { confirmDialog } from '../ConfirmModal'
import ActionMenu from '../ActionMenu'

/**
 * 准入与认证中心（/nac）— S3 准入策略 Panel 集合
 * 提取-搬入策略：原页面主体原样搬入（去掉 page-header 外壳），
 * 业务逻辑/搜索/分页/CRUD 全部保留。旧路由页薄壳渲染同一 Panel。
 *
 * Panel 列表：
 *   MacPassPanel   ← pages/MacBypass.jsx    （MAC 免认证列表/搜索/移除）
 *   ProfilesPanel  ← pages/UserProfiles.jsx （Profile 新建/属性下发/删除）
 *   QosPanel       ← pages/QosPolicy.jsx    （RADIUS 组参数 增删改/筛选）
 */

/* ═══════════ MAC 免认证（原 /macbypass）═══════════ */
export function MacPassPanel() {
  const [data, setData] = useState([])
  const [pg, setPg] = useState(1); const sz = 20
  const [macQ, setMacQ] = useState('')
  const [userQ, setUserQ] = useState('')

  const load = useCallback(() => {
    api.macs(macQ.trim(), userQ.trim()).then(setData).catch(console.error)
  }, [macQ, userQ])
  useEffect(load, [load])

  const del = async (m) => {
    const ok = await confirmDialog({
      title: `移除 MAC 免认证 ${m}？`,
      message: '移除后该设备将无法免认证上网，需重新走 Portal 认证流程。',
      confirmText: '移除', danger: true,
    })
    if (!ok) return
    try { await api.deleteMac(m); toastSuccess('已移除'); load() }
    catch (err) { toastError(err.message) }
  }
  const tp = Math.ceil(data.length / sz) || 1; const page = data.slice((pg - 1) * sz, pg * sz)

  const handleSearch = () => { setPg(1); load() }
  const handleReset = () => { setMacQ(''); setUserQ(''); setPg(1) }
  // 当输入清空时自动重新加载
  useEffect(() => {
    if (!macQ && !userQ) { setPg(1); api.macs().then(setData).catch(console.error) }
  }, [macQ, userQ])

  return (
    <div className="panel-body">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input type="text" placeholder={tr('search_mac')} value={macQ}
          onChange={e => setMacQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
          style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 13, width: 200 }} />
        <input type="text" placeholder={tr('search_username')} value={userQ}
          onChange={e => setUserQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
          style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 13, width: 200 }} />
        <button className="btn btn-primary btn-sm" onClick={handleSearch}>{tr('query')}</button>
        <button className="btn btn-outline btn-sm" onClick={handleReset}>{tr('all')}</button>
        <span className="badge badge-success" style={{ marginLeft: 'auto' }}>{data.length} {tr('macpass_count')}</span>
      </div>
      {data.length ? <>
        <table><thead><tr><th>{tr('mac')}</th><th>{tr('username')}</th><th>{tr('regist_time')}</th><th>{tr('expire_time')}</th><th>{tr('operation')}</th></tr></thead><tbody>
          {page.map((m, i) => <tr key={i}><td><code>{m.mac}</code></td><td>{m.username}</td><td>{(m.created_at || '').substring(0, 16)}</td><td>{(m.expires_at || '').substring(0, 10)}</td>
            <td><ActionMenu actions={[
              { label: tr('remove'), icon: '✕', danger: true, onClick: () => del(m.mac) },
            ]} /></td></tr>)}
        </tbody></table>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12, fontSize: 12, color: 'var(--gray)' }}>
          <button className="btn btn-outline btn-sm" disabled={pg <= 1} onClick={() => setPg(pg - 1)}>◀</button>
          <span>{pg}/{tp}</span>
          <button className="btn btn-outline btn-sm" disabled={pg >= tp} onClick={() => setPg(pg + 1)}>▶</button>
        </div>
      </> : <div className="empty">{tr('no_data')}</div>}
    </div>
  )
}

/* ═══════════ 用户 Profile（原 /profiles）═══════════ */
export function ProfilesPanel() {
  const [data, setData] = useState([])
  const [form, setForm] = useState({ name: '', description: '' })
  const [editing, setEditing] = useState(null)   // {pid, name, vlan, qos_up_mbps, qos_down_mbps, acl_id}
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => { fetchApi('/profiles').then(setData).catch(console.error) }, [])
  useEffect(load, [load])

  const create = async () => {
    if (!form.name.trim()) { toastError('请填写 Profile 名称'); return }
    try {
      await fetchApi('/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      toastSuccess(`Profile ${form.name} 已创建`)
      setForm({ name: '', description: '' }); load()
    } catch (err) { toastError(err.message) }
  }

  const openAttrs = async (p) => {
    try {
      const attrs = await fetchApi(`/profiles/${p.id}/attrs`)
      setEditing({ pid: p.id, name: p.name, ...attrs })
    } catch (err) { toastError(err.message) }
  }

  const saveAttrs = async () => {
    setSaving(true)
    try {
      await fetchApi(`/profiles/${editing.pid}/attrs`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vlan: (editing.vlan || '').trim(),
          qos_up_mbps: (editing.qos_up_mbps || '').trim(),
          qos_down_mbps: (editing.qos_down_mbps || '').trim(),
          acl_id: (editing.acl_id || '').trim(),
        }),
      })
      toastSuccess(`Profile ${editing.name} 属性已保存`)
      setEditing(null); load()
    } catch (err) { toastError(err.message) }
    finally { setSaving(false) }
  }

  const del = async (p) => {
    const ok = await confirmDialog({
      title: `删除 Profile「${p.name}」？`,
      message: `该 Profile 绑定了 ${p.members} 个用户，删除后这些用户将回退到默认策略。`,
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try { await fetchApi(`/profiles/${p.id}`, { method: 'DELETE' }); toastSuccess(`Profile ${p.name} 已删除`); load() }
    catch (e) { toastError(e.message) }
  }

  const field = (label, key, placeholder, hint) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
      <input value={editing[key] ?? ''} onChange={e => setEditing({ ...editing, [key]: e.target.value })} placeholder={placeholder} />
      {hint && <span style={{ fontSize: 11, color: 'var(--muted)' }}>{hint}</span>}
    </div>
  )

  return (
    <div className="panel-body">
      {/* 新建 */}
      <div className="panel" style={{ marginBottom: 14, borderColor: 'var(--blue)' }}>
        <div className="panel-header"><h4>新建 Profile</h4>
          <span className="badge badge-purple">策略模板 · 认证成功随 Access-Accept 下发</span>
        </div>
        <div className="panel-body">
          <form onSubmit={e => { e.preventDefault(); create() }} className="input-wrap">
            <input placeholder="Profile 名称（如 guest-std）" required style={{ width: 220 }} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            <input placeholder="描述（可选）" style={{ width: 260 }} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
            <button className="btn btn-primary btn-sm" type="submit">+ 创建</button>
          </form>
        </div>
      </div>

      {/* 列表 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h4 style={{ margin: 0 }}>Profile 清单</h4>
        <span className="badge badge-blue">{data.length} 个</span>
      </div>
      {data.length ? <table><thead><tr>
        <th>名称</th><th>描述</th><th>VLAN</th><th>上行</th><th>下行</th><th>ACL</th><th>绑定用户</th><th>操作</th>
      </tr></thead><tbody>
        {data.map(p => <>
          <tr key={p.id}>
            <td><strong>{p.name}</strong></td>
            <td style={{ maxWidth: 180 }}>{p.description || '-'}</td>
            <td>{p.vlan ? <code>{p.vlan}</code> : '-'}</td>
            <td>{p.qos_up_mbps ? `${p.qos_up_mbps}M` : '-'}</td>
            <td>{p.qos_down_mbps ? `${p.qos_down_mbps}M` : '-'}</td>
            <td>{p.acl_id ? <code>{p.acl_id}</code> : '-'}</td>
            <td>{p.members > 0 ? <span className="badge badge-blue">{p.members} 人</span> : '-'}</td>
            <td>
              <ActionMenu actions={[
                { label: '配置属性', icon: '⚙', onClick: () => openAttrs(p) },
                { label: '删除', icon: '🗑', danger: true, disabled: p.members > 0, onClick: () => del(p) },
              ]} />
            </td>
          </tr>
          {editing && editing.pid === p.id && <tr key={'edit-' + p.id}><td colSpan={8}>
            <div className="input-wrap" style={{ padding: '14px', borderRadius: 0, border: '1px solid var(--blue)', flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>下发属性 — {p.name}</span>
                <button className="btn btn-outline btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setEditing(null)}>✕ 取消</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
                {field('VLAN ID', 'vlan', '如 30', 'Tunnel 三件套')}
                {field('上行限速 (Mbps)', 'qos_up_mbps', '如 4', '用户发出流量')}
                {field('下行限速 (Mbps)', 'qos_down_mbps', '如 8', '用户收到流量')}
                {field('ACL 编号/名称', 'acl_id', '如 3000', '需交换机预建 ACL')}
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                QoS 同时下发无线 AC 与有线交换机两套属性；留空表示该能力不限制。改绑/修改后用户需重新认证生效。
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={saving} onClick={saveAttrs}>{saving ? '保存中...' : '保存'}</button>
                <button className="btn btn-outline btn-sm" onClick={() => setEditing(null)}>取消</button>
              </div>
            </div>
          </td></tr>}
        </>)}
      </tbody></table> : <div className="empty">暂无 Profile，先在上方创建一个</div>}
    </div>
  )
}

/* ═══════════ RADIUS 组参数（原 /qos）═══════════ */
export function QosPanel() {
  const [data, setData] = useState([])
  const [groups, setGroups] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState(null)
  const [groupFilter, setGroupFilter] = useState('')

  const load = useCallback(() => {
    fetchApi('/qos').then(setData).catch(console.error)
    fetchApi('/groups').then(setGroups).catch(console.error)
  }, [])
  useEffect(load, [load])

  const save = async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    const g = fd.get('group'), a = fd.get('attr'), v = fd.get('value')
    try {
      if (editId) {
        await fetchApi(`/groups/reply/${editId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: v }) })
        toastSuccess('参数已更新')
      } else {
        await fetchApi(`/groups/${g}/reply?attribute=${a}&value=${v}&op=:=`, { method: 'POST' })
        toastSuccess(`已为分组 ${g} 添加参数`)
      }
      setShowForm(false); setEditId(null); load()
    } catch (err) { toastError(err.message) }
  }

  const del = async (id) => {
    const row = data.find(q => q.id === id)
    const ok = await confirmDialog({
      title: '删除该 RADIUS 参数？',
      message: row ? `将删除分组「${row.groupname}」的 ${row.attribute} 参数，该组用户的对应策略（限速/VLAN/ACL 等）立即失效。` : '删除后该组用户的对应策略立即失效。',
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try {
      await fetchApi(`/groups/reply/${id}`, { method: 'DELETE' })
      toastSuccess('参数已删除')
      load()
    } catch (err) { toastError(err.message) }
  }

  return (
    <div className="panel-body">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input placeholder="按组名筛选…" value={groupFilter} onChange={e => setGroupFilter(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 13, width: 200 }} />
        <button className="btn btn-primary btn-sm" onClick={() => { setEditId(null); setShowForm(!showForm) }}>+ 添加参数</button>
        <span className="badge badge-blue" style={{ marginLeft: 'auto' }}>{data.length} 条</span>
      </div>

      {showForm && <div className="panel" style={{ marginBottom: 14, borderColor: 'var(--blue)' }}>
        <div className="panel-header"><h4>{editId ? '修改参数值' : '新增 RADIUS 参数'}</h4></div>
        <div className="panel-body">
          <form onSubmit={save} className="input-wrap">
            {!editId && <select name="group" required style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 13 }}>
              {groups.map(g => <option key={g.groupname} value={g.groupname}>{g.groupname} ({g.members}{tr('member_unit')})</option>)}
            </select>}
            {!editId && <>
              <input name="attr" list="radius-param-presets" placeholder="属性名（可从预设选择）" required style={{ flex: 1 }} />
              <datalist id="radius-param-presets">
                <option value="Huawei-Input-Average-Rate">上行限速 · Huawei（AC/S57 通用）</option>
                <option value="Huawei-Output-Average-Rate">下行限速 · Huawei（AC/S57 通用）</option>
                <option value="Huawei-Input-Peak-Rate">上行峰值 · Huawei</option>
                <option value="Huawei-Output-Peak-Rate">下行峰值 · Huawei</option>
                <option value="Filter-Id">ACL 引用（VLAN/ACL 请用 Profile 页）</option>
              </datalist>
            </>}
            <input name="value" placeholder="值（速率填 bps，如 8192000 = 8M）" required />
            <button className="btn btn-primary" type="submit">{tr('save')}</button>
            <button className="btn btn-outline" type="button" onClick={() => { setShowForm(false); setEditId(null) }}>{tr('cancel')}</button>
          </form></div>
      </div>}

      {data.length ? <table><thead><tr><th>{tr('group')}</th><th>{tr('attribute')}</th><th>{tr('value_label')}</th><th>{tr('operation')}</th></tr></thead><tbody>
        {data.filter(q => !groupFilter || q.groupname.toLowerCase().includes(groupFilter.toLowerCase())).map(q => {
          const isRate = RATE_ATTRS.has(q.attribute)
          return <tr key={q.id}>
            <td><span className="badge badge-default">{q.groupname}</span></td>
            <td><code>{q.attribute}</code></td>
            <td><strong>{fmtVal(q)}</strong></td>
            <td>
              <ActionMenu actions={[
                ...(isRate
                  ? [{ label: tr('edit'), icon: '✎', onClick: () => { setEditId(q.id); setShowForm(true) } }]
                  : [{ label: 'Profile 管理', icon: '⚙', disabled: true, onClick: () => {} }]),
                { label: tr('delete'), icon: '🗑', danger: true, onClick: () => del(q.id) },
              ]} />
            </td>
          </tr>})}
      </tbody></table> : <div className="empty">{tr('no_qos')}</div>}
    </div>
  )
}

function fmtBps(v) { const n = parseInt(v) || 0; if (n >= 1e9) return (n / 1e9).toFixed(1) + ' Gbps'; if (n >= 1e6) return (n / 1e6).toFixed(1) + ' Mbps'; return (n / 1e3).toFixed(0) + ' Kbps' }

// 限速类属性：按速率格式渲染，允许行内编辑
const RATE_ATTRS = new Set([
  'Huawei-Input-Average-Rate', 'Huawei-Output-Average-Rate',
  'HW-Input-Committed-Information-Rate', 'HW-Output-Committed-Information-Rate',
  'HW-Input-Peak-Information-Rate', 'HW-Output-Peak-Information-Rate',
])

// 非限速属性（VLAN / ACL 等）：显示原始语义值，编辑引导到 Profile 页面
function fmtVal(q) {
  if (RATE_ATTRS.has(q.attribute)) return fmtBps(q.value)
  if (q.attribute === 'Tunnel-Private-Group-Id') return `VLAN ${q.value}`
  if (q.attribute === 'Filter-Id' || q.attribute === 'HW-Data-Filter') return `ACL ${q.value}`
  // Tunnel-Type / Tunnel-Medium-Type 直接显示原始值（如 "VLAN"、"IEEE-802"），不加前缀防冗余
  return String(q.value ?? '')
}
