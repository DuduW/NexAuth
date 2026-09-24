// 交换机 · 设备管理（v1.0）— PRD: docs/PRD-华为交换机备份.md §3.1/§3.2
import { useState, useEffect, useCallback } from 'react'
import { fetchApi } from '../api'
import { toastSuccess, toastError, toastInfo } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import { formDialog } from '../components/FormModal'
import ActionMenu from '../components/ActionMenu'

export default function SwDevices() {
  const [data, setData] = useState([])
  const [creds, setCreds] = useState([])
  const [search, setSearch] = useState('')
  const [groupF, setGroupF] = useState('')
  const [busy, setBusy] = useState(0)   // 正在操作的 device id

  const load = useCallback(() => {
    fetchApi('/sw/devices').then(setData).catch(e => toastError('加载设备失败: ' + e.message))
    fetchApi('/sw/credentials').then(setCreds).catch(() => {})
  }, [])
  useEffect(load, [load])

  const groups = [...new Set(data.map(d => d.group_tag).filter(Boolean))]
  const filtered = data.filter(d =>
    (!groupF || d.group_tag === groupF) &&
    (!search || d.name.toLowerCase().includes(search.toLowerCase()) || d.mgmt_ip.includes(search)))

  const openAdd = async () => {
    const sharedOpts = [
      { value: '', label: '— 新建独立凭据 —' },
      ...creds.filter(c => c.is_shared).map(c => ({ value: String(c.id), label: `${c.name}（${c.username}）` })),
    ]
    const v = await formDialog({
      title: '添加交换机',
      fields: [
        { name: 'name', label: '设备名称', required: true, placeholder: 'S57-2F-Core-01', maxLength: 64 },
        { name: 'mgmt_ip', label: '管理 IP', required: true, placeholder: '172.18.x.x' },
        { name: 'model', label: '型号', initial: 'S5735', maxLength: 64 },
        { name: 'ssh_port', label: 'SSH 端口', initial: '22', validate: x => (!/^\d+$/.test(x) || +x < 1 || +x > 65535) ? '1-65535 数字' : null },
        { name: 'credential_id', label: '凭据组', type: 'select', options: sharedOpts },
        { name: 'username', label: 'SSH 账号（独立凭据时填）', hint: '选择凭据组时忽略' },
        { name: 'password', label: 'SSH 密码（独立凭据时填）', type: 'password', hint: 'AES-256-GCM 加密存储，永不回显' },
        { name: 'group_tag', label: '分组/标签', placeholder: '2F / IDC / Core' },
      ],
      submitText: '添加',
    })
    if (!v) return
    try {
      await fetchApi('/sw/devices', {
        method: 'POST',
        body: JSON.stringify({
          name: v.name, mgmt_ip: v.mgmt_ip, model: v.model, ssh_port: +v.ssh_port,
          group_tag: v.group_tag || null,
          credential_id: v.credential_id ? +v.credential_id : null,
          username: v.credential_id ? null : v.username || null,
          password: v.credential_id ? null : v.password || null,
        }),
      })
      toastSuccess('设备已添加'); load()
    } catch (e) { toastError(e.message) }
  }

  const openEdit = async (d) => {
    const sharedOpts = [
      { value: '', label: '— 保持现有凭据 —' },
      ...creds.filter(c => c.is_shared).map(c => ({ value: String(c.id), label: `${c.name}（${c.username}）` })),
    ]
    const v = await formDialog({
      title: `编辑 ${d.name}`,
      fields: [
        { name: 'name', label: '设备名称', initial: d.name, required: true, maxLength: 64 },
        { name: 'mgmt_ip', label: '管理 IP', initial: d.mgmt_ip, required: true },
        { name: 'model', label: '型号', initial: d.model },
        { name: 'ssh_port', label: 'SSH 端口', initial: String(d.ssh_port) },
        { name: 'credential_id', label: '凭据组', type: 'select', options: sharedOpts },
        { name: 'password', label: '重设 SSH 密码', type: 'password', hint: '留空 = 不修改密码' },
        { name: 'group_tag', label: '分组/标签', initial: d.group_tag || '' },
        { name: 'remark', label: '备注', initial: d.remark || '' },
      ],
      submitText: '保存',
    })
    if (!v) return
    try {
      await fetchApi(`/sw/devices/${d.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: v.name, mgmt_ip: v.mgmt_ip, model: v.model, ssh_port: +v.ssh_port,
          group_tag: v.group_tag || null, remark: v.remark || null,
          credential_id: v.credential_id ? +v.credential_id : null,
          password: v.password || null,
        }),
      })
      toastSuccess('已保存'); load()
    } catch (e) { toastError(e.message) }
  }

  const test = async (d) => {
    setBusy(d.id)
    try {
      const r = await fetchApi(`/sw/devices/${d.id}/test`, { method: 'POST' })
      toastSuccess(`✅ ${d.name} 连接成功 · VRP ${r.vrp || '?'}${r.uptime ? ' · 运行 ' + r.uptime : ''}`)
      load()
    } catch (e) { toastError(`❌ ${d.name}: ${e.message}`) }
    setBusy(0)
  }

  const doBackup = async (d) => {
    setBusy(d.id)
    try {
      const r = await fetchApi(`/sw/devices/${d.id}/backup`, { method: 'POST' })
      const diffTxt = r.diff_added == null ? '初始版本' : `+${r.diff_added} / -${r.diff_removed} 行`
      toastSuccess(`✅ ${d.name} 备份成功 v${r.version_no}（${diffTxt}）`)
      load()
    } catch (e) { toastError(`备份失败: ${e.message}`) }
    setBusy(0)
  }

  const del = async (d) => {
    const ok = await confirmDialog({
      title: `删除 ${d.name}？`,
      message: '仅可删除无备份记录的设备；有备份历史的设备请改为停用以保留台账与历史。',
      danger: true, confirmText: '删除',
    })
    if (!ok) return
    try {
      await fetchApi(`/sw/devices/${d.id}`, { method: 'DELETE' })
      toastSuccess('已删除'); load()
    } catch (e) {
      if (e.message.includes('禁止删除')) toastInfo(e.message)
      else toastError(e.message)
    }
  }

  const toggle = async (d) => {
    try {
      await fetchApi(`/sw/devices/${d.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !d.enabled }) })
      toastSuccess(d.enabled ? '已停用' : '已启用'); load()
    } catch (e) { toastError(e.message) }
  }

  const fmtTime = (t) => (t || '').substring(0, 16)

  return <>
    <div className="page-header">
      <div>
        <h1>设备清单</h1>
        <div className="mut" style={{ marginTop: 4 }}>设备台账与 SSH 凭据（密码 AES-256-GCM 加密存储，永不回显）</div>
      </div>
      <button className="btn btn-primary" onClick={openAdd}>＋ 添加交换机</button>
    </div>

    <div className="stat-cards">
      <div className="stat-card"><div className="label">设备总数</div><div className="value">{data.length}</div></div>
      <div className="stat-card"><div className="label">启用 / 停用</div>
        <div className="value">{data.filter(d => d.enabled).length} <span style={{ fontSize: 16, color: 'var(--muted)' }}>/ {data.filter(d => !d.enabled).length}</span></div></div>
      <div className="stat-card"><div className="label">凭据组</div><div className="value">{creds.length}</div></div>
      <div className="stat-card"><div className="label">有备份的设备</div>
        <div className="value">{data.filter(d => d.last_backup_version).length}</div></div>
    </div>

    <div className="panel">
      <div className="panel-header">
        <h4>设备列表</h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input className="search-input" placeholder="搜索名称 / IP" value={search} onChange={e => setSearch(e.target.value)} />
          <select value={groupF} onChange={e => setGroupF(e.target.value)}>
            <option value="">全部分组</option>
            {groups.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
      </div>
      <div className="panel-body">
        {filtered.length ? <table>
          <thead><tr>
            <th>状态</th><th>设备名称</th><th>管理 IP</th><th>型号</th><th>分组</th>
            <th>凭据</th><th>VRP 版本</th><th>最近备份</th><th style={{ width: 240 }}>操作</th>
          </tr></thead>
          <tbody>
            {filtered.map(d => <tr key={d.id}>
              <td>{d.enabled
                ? <span className="badge badge-success">启用</span>
                : <span className="badge badge-default">停用</span>}</td>
              <td><strong>{d.name}</strong></td>
              <td><code>{d.mgmt_ip}:{d.ssh_port}</code></td>
              <td>{d.model}</td>
              <td>{d.group_tag ? <span className="badge badge-blue">{d.group_tag}</span> : <span className="mut">—</span>}</td>
              <td><span className="mut">{d.credential_name}</span></td>
              <td>{d.last_vrp_ver || <span className="mut">未测试</span>}</td>
              <td>{d.last_backup_version != null
                ? <span>v{d.last_backup_version} · {fmtTime(d.last_backup_at)}</span>
                : <span className="mut">无</span>}</td>
              <td>
                <ActionMenu actions={[
                  { label: '连接测试', icon: '⚡', disabled: busy === d.id, onClick: () => test(d) },
                  { label: '立即备份', icon: '⭳', disabled: busy === d.id || !d.enabled, onClick: () => doBackup(d) },
                  { label: '编辑', icon: '✎', onClick: () => openEdit(d) },
                  { label: d.enabled ? '停用' : '启用', icon: d.enabled ? '⊘' : '∅', onClick: () => toggle(d) },
                  { label: '删除', icon: '🗑', danger: true, disabled: busy === d.id, onClick: () => del(d) },
                ]} />
              </td>
            </tr>)}
          </tbody>
        </table> : <div className="empty">暂无设备，点击右上角「添加交换机」开始</div>}
      </div>
    </div>
  </>
}
