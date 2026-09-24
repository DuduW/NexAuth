// 交换机之外的网络资产 — IP · 网段管理（IPv4/IPv6 双栈）— PRD: docs/PRD-IP资产管理.md §6.2
import { useState, useEffect, useCallback } from 'react'
import { fetchApi } from '../api'
import { toastSuccess, toastError, toastInfo } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import { formDialog } from '../components/FormModal'
import { openImport } from '../components/ImportModal'
import ActionMenu from '../components/ActionMenu'

const ZONE_CN = { office: '办公', idc: 'IDC', zt: '零信任', storage: '存储', test: '测试', dmz: 'DMZ' }
const ISP_CN = { telecom: '电信', unicom: '联通', mobile: '移动', cloud: '云厂商' }

export default function IpSubnets() {
  const [rows, setRows] = useState([])
  const [stats, setStats] = useState(null)
  const [filters, setFilters] = useState({ version: '', zone: '', scope: '', q: '' })
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (filters.version) qs.set('version', filters.version)
      if (filters.zone) qs.set('zone', filters.zone)
      if (filters.scope) qs.set('scope', filters.scope)
      if (filters.q) qs.set('q', filters.q)
      setRows(await fetchApi(`/ip/subnets?${qs}`))
      setStats(await fetchApi('/ip/stats'))
    } catch (e) { toastError(e.message) }
    setLoading(false)
  }, [filters])

  useEffect(() => { load() }, [load])

  const openAdd = async () => {
    const v = await formDialog({
      title: '新建网段',
      fields: [
        { name: 'cidr', label: 'CIDR', required: true, placeholder: '192.168.30.0/24 或 2408:8756::/48', maxLength: 50,
          validate: x => (x.includes('/') ? null : '必须带前缀长度，如 192.168.30.0/24') },
        { name: 'name', label: '名称', required: true, placeholder: '办公接入-A', maxLength: 64 },
        { name: 'zone', label: '区域', type: 'select', initial: 'office',
          options: Object.entries(ZONE_CN).map(([value, label]) => ({ value, label })) },
        { name: 'scope', label: '公私网', type: 'select', initial: 'private',
          options: [{ value: 'private', label: '私网' }, { value: 'public', label: '公网' }] },
        { name: 'vlan_id', label: 'VLAN ID', validate: x => x && !/^\d+$/.test(x) ? '数字或留空' : null },
        { name: 'gateway', label: '网关', placeholder: '192.168.30.1' },
        { name: 'note', label: '备注' },
      ],
      submitText: '创建',
    })
    if (!v) return
    try {
      const r = await fetchApi('/ip/subnets', { method: 'POST', body: JSON.stringify(v) })
      if (r.registered_mode) toastSuccess(`✅ 网段 ${r.cidr} 已创建（前缀登记模式）`)
      else toastSuccess(`✅ 网段 ${r.cidr} 已创建，自动生成 ${r.generated_free} 条空闲地址`)
      load()
    } catch (e) { toastError(e.message) }
  }

  const openEdit = async (s) => {
    const v = await formDialog({
      title: `编辑网段 ${s.cidr}`,
      fields: [
        { name: 'name', label: '名称', initial: s.name, required: true, maxLength: 64 },
        { name: 'zone', label: '区域', type: 'select', initial: s.zone,
          options: Object.entries(ZONE_CN).map(([value, label]) => ({ value, label })) },
        { name: 'vlan_id', label: 'VLAN ID', initial: s.vlan_id ? String(s.vlan_id) : '' },
        { name: 'gateway', label: '网关', initial: s.gateway || '' },
        { name: 'isp', label: '运营商（公网）', type: 'select', initial: s.isp || '',
          options: [{ value: '', label: '—' }, ...Object.entries(ISP_CN).map(([value, label]) => ({ value, label }))] },
        { name: 'line_name', label: '线路名称', initial: s.line_name || '' },
        { name: 'bandwidth_mbps', label: '带宽 Mbps', initial: s.bandwidth_mbps ? String(s.bandwidth_mbps) : '' },
        { name: 'contract_end', label: '合约到期', type: 'date', initial: s.contract_end || '' },
        { name: 'icp_no', label: 'ICP 备案号', initial: s.icp_no || '' },
        { name: 'note', label: '备注', initial: s.note || '' },
      ],
      submitText: '保存',
    })
    if (!v) return
    try {
      await fetchApi(`/ip/subnets/${s.id}`, { method: 'PUT', body: JSON.stringify(v) })
      toastSuccess('✅ 已保存'); load()
    } catch (e) { toastError(e.message) }
  }

  const toggleEnabled = async (s) => {
    const ok = await confirmDialog({
      title: s.enabled ? `停用网段 ${s.cidr}？` : `启用网段 ${s.cidr}？`,
      message: s.enabled ? '停用后不允许新分配，已有地址不受影响' : '启用后恢复分配',
      danger: s.enabled, confirmText: s.enabled ? '停用' : '启用',
    })
    if (!ok) return
    try {
      await fetchApi(`/ip/subnets/${s.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !s.enabled }) })
      toastSuccess('✅ 已更新'); load()
    } catch (e) { toastError(e.message) }
  }

  const doDelete = async (s) => {
    const ok = await confirmDialog({
      title: `删除网段 ${s.cidr}？`, danger: true, keyword: s.cidr,
      message: '将删除该网段及其全部空闲地址记录，不可恢复',
      confirmText: '删除',
    })
    if (!ok) return
    try {
      await fetchApi(`/ip/subnets/${s.id}`, { method: 'DELETE' })
      toastSuccess('✅ 已删除'); load()
    } catch (e) { toastError(e.message) }
  }

  const doImport = async () => {
    const r = await openImport({ kind: 'subnet', title: '批量导入 · 网段' })
    if (r) { toastSuccess(`✅ 导入完成：新增 ${r.inserted} / 更新 ${r.updated} / 失败 ${r.failed}`); load() }
  }

  const utilColor = (used, total) => {
    if (!total) return 'var(--muted)'
    const pct = used / total
    return pct > 0.85 ? 'var(--red)' : pct > 0.6 ? 'var(--warn)' : 'var(--green)'
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>IP · 网段管理</h1>
          <div className="mut">IPv4 / IPv6 双栈网段台账（CIDR 唯一 · v4 /24 及更细自动生成空闲地址 · 全部变更留审计）</div>
        </div>
        <div>
          <button className="btn btn-outline" style={{ marginRight: 8 }} onClick={doImport}>⬆ 导入</button>
          <button className="btn btn-primary" onClick={openAdd}>+ 新建网段</button>
        </div>
      </div>

      {stats && (
        <div className="stat-cards">
          <div className="stat-card"><div className="label">网段数</div>
            <div className="value">{stats.nets.private.v4 + stats.nets.public.v4} <small>IPv4</small>
              &nbsp;·&nbsp; {stats.nets.private.v6 + stats.nets.public.v6} <small>IPv6</small></div></div>
          <div className="stat-card"><div className="label">已分配地址</div>
            <div className="value">{stats.v4_used_total} <small>IPv4</small></div></div>
          <div className="stat-card"><div className="label">活跃 NAT 映射</div>
            <div className="value">{stats.nat_total} <small>条</small></div></div>
          <div className="stat-card"><div className="label">本周分配/导入</div>
            <div className="value">{stats.week_new} <small>次</small></div></div>
        </div>
      )}

      <div className="panel">
        <div className="panel-header"><h4>网段列表 {loading && <span className="mut">加载中...</span>}</h4>
          <span className="mut">共 {rows.length} 个网段</span></div>
        <div className="filters">
          <select value={filters.version} onChange={e => setFilters({ ...filters, version: e.target.value })}>
            <option value="">全部版本</option><option value="4">IPv4</option><option value="6">IPv6</option>
          </select>
          <select value={filters.zone} onChange={e => setFilters({ ...filters, zone: e.target.value })}>
            <option value="">全部区域</option>
            {Object.entries(ZONE_CN).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select value={filters.scope} onChange={e => setFilters({ ...filters, scope: e.target.value })}>
            <option value="">公私网全部</option><option value="private">私网</option><option value="public">公网</option>
          </select>
          <input placeholder="搜索 CIDR / 名称，如 192.168.30." value={filters.q}
            onChange={e => setFilters({ ...filters, q: e.target.value })} />
        </div>
        <table>
          <thead><tr>
            <th>CIDR</th><th>版本</th><th>VLAN</th><th>名称</th><th>区域</th><th>网关</th>
            <th>利用率（已用 / 预留 / 空闲）</th><th>操作</th>
          </tr></thead>
          <tbody>
            {rows.map(s => {
              const used = s.used + s.conflict
              const total = used + s.reserved + s.free_cnt
              const pct = total ? Math.round((used / total) * 100) : 0
              const rsvPct = total ? Math.round((s.reserved / total) * 100) : 0
              return (
                <tr key={s.id} style={{ opacity: s.enabled ? 1 : 0.55 }}>
                  <td><code>{s.cidr}</code></td>
                  <td><span className={`badge ${s.version === 6 ? 'badge-violet' : 'badge-blue'}`}>v{s.version}</span></td>
                  <td>{s.vlan_id ?? '-'}</td>
                  <td>{s.name}{!s.enabled && <span className="badge badge-default" style={{ marginLeft: 6 }}>停用</span>}</td>
                  <td><span className="badge badge-default">{ZONE_CN[s.zone] || s.zone}</span>
                    {s.scope === 'public' && <span className="badge badge-danger" style={{ marginLeft: 4 }}>公网</span>}</td>
                  <td>{s.gateway ? <code>{s.gateway}</code> : '-'}</td>
                  <td>
                    {s.registered_mode ? <span className="mut">{s.used} / {s.reserved} / 前缀登记模式</span> : (
                      <div style={{ minWidth: 140 }}>
                        <div style={{ display: 'flex', height: 8, borderRadius:0, overflow: 'hidden', background: 'var(--bg-light)' }}>
                          <span style={{ width: `${pct}%`, background: 'var(--blue)' }} />
                          <span style={{ width: `${rsvPct}%`, background: '#f0a232' }} />
                        </div>
                        <div className="mut" style={{ marginTop: 4 }}>
                          {s.used} / {s.reserved} / {s.free_cnt} · <b style={{ color: utilColor(used, total) }}>{pct}%</b>
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="ops">
                    <ActionMenu actions={[
                      { label: '查看地址', icon: '▤', onClick: () => { window.location.hash = `#/ip-addresses?subnet=${s.id}` } },
                      { label: '编辑', icon: '✎', onClick: () => openEdit(s) },
                      { label: s.enabled ? '停用' : '启用', icon: s.enabled ? '⊘' : '∅', onClick: () => toggleEnabled(s) },
                      { label: '删除', icon: '🗑', danger: true, onClick: () => doDelete(s) },
                    ]} />
                  </td>
                </tr>
              )
            })}
            {!rows.length && !loading && (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>
                暂无网段，点击右上角「+ 新建网段」或「⬆ 导入」开始
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
