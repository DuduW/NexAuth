// IP · 地址台账（分配/释放/预留/冲突/审计）— PRD: docs/PRD-IP资产管理.md §6.3
import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchApi } from '../api'
import { toastSuccess, toastError, toastInfo } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import { formDialog } from '../components/FormModal'
import { openImport } from '../components/ImportModal'
import ActionMenu from '../components/ActionMenu'

const STATUS_BADGE = {
  allocated: 'badge-success', reserved: 'badge-warning', free: 'badge-default',
  conflict: 'badge-danger', disabled: 'badge-default',
}
const STATUS_CN = { allocated: '已分配', reserved: '预留', free: '空闲', conflict: '冲突', disabled: '禁用' }
const ASSET_CN = { physical: '物理机', vm: 'VM', network: '网络设备', printer: '打印机', other: '其他' }
const ACTOR = () => localStorage.getItem('admin_user') || 'admin'

export default function IpAddresses() {
  const [sp, setSp] = useSearchParams()
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [subnets, setSubnets] = useState([])
  const [page, setPage] = useState(1)
  const [filters, setFilters] = useState({ subnet_id: sp.get('subnet') || '', status: 'allocated,reserved,conflict', q: '' })
  const [loading, setLoading] = useState(false)
  const size = 50

  const load = useCallback(async (p = page) => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (filters.subnet_id) qs.set('subnet_id', filters.subnet_id)
      if (filters.status) qs.set('status', filters.status)
      if (filters.q) qs.set('q', filters.q)
      qs.set('page', p); qs.set('size', size)
      const r = await fetchApi(`/ip/addresses?${qs}`)
      setItems(r.items); setTotal(r.total)
    } catch (e) { toastError(e.message) }
    setLoading(false)
  }, [filters, page])

  useEffect(() => { load(1) }, [filters])   // 筛选变化回到第 1 页
  useEffect(() => { if (page > 1) load(page) }, [page])

  useEffect(() => {
    fetchApi('/ip/subnets').then(setSubnets).catch(() => {})
  }, [])

  const toggleStatus = (s) => {
    const arr = filters.status ? filters.status.split(',') : []
    setFilters({ ...filters, status: arr.includes(s) ? arr.filter(x => x !== s).join(',') : [...arr, s].join(',') })
  }

  const doAllocate = async (a) => {
    const v = await formDialog({
      title: `分配 ${a.ip_text}`,
      fields: [
        { name: 'hostname', label: '主机名', maxLength: 64 },
        { name: 'mac', label: 'MAC', placeholder: '08:6E:5C:AA:12:F4' },
        { name: 'asset_type', label: '资产类型', type: 'select',
          options: [{ value: '', label: '—' }, ...Object.entries(ASSET_CN).map(([value, label]) => ({ value, label }))] },
        { name: 'asset_ref', label: '资产引用', placeholder: '设备名 / VM 名' },
        { name: 'owner', label: '使用人' },
        { name: 'dept', label: '部门' },
        { name: 'purpose', label: '用途' },
        { name: 'expires_at', label: '到期时间', type: 'date' },
      ],
      submitText: '确认分配',
    })
    if (!v) return
    try {
      const r = await fetchApi(`/ip/addresses/${a.id}/allocate`, {
        method: 'POST', body: JSON.stringify({ ...v, actor: ACTOR() }) })
      toastSuccess(`✅ ${r.ip} 已分配`); load()
    } catch (e) { toastError(e.message) }
  }

  const doRelease = async (a) => {
    const ok = await confirmDialog({
      title: `释放 ${a.ip_text}？`, danger: true, keyword: a.ip_text,
      message: '将清空主机名/使用人/用途等归属信息，操作留审计',
      confirmText: '释放',
    })
    if (!ok) return
    try {
      await fetchApi(`/ip/addresses/${a.id}/release`, {
        method: 'POST', body: JSON.stringify({ actor: ACTOR() }) })
      toastSuccess(`✅ ${a.ip_text} 已释放`); load()
    } catch (e) { toastError(e.message) }
  }

  const doStatus = async (a, target) => {
    let note = null
    if (target === 'conflict') {
      const v = await formDialog({
        title: `标记冲突 ${a.ip_text}`,
        fields: [{ name: 'note', label: '冲突说明（对端 MAC / 现象）', type: 'textarea', required: true }],
        submitText: '标记',
      })
      if (!v) return
      note = v.note
    }
    try {
      await fetchApi(`/ip/addresses/${a.id}/status`, {
        method: 'POST', body: JSON.stringify({ status: target, note, actor: ACTOR() }) })
      toastSuccess(`✅ 已标记为${STATUS_CN[target]}`); load()
    } catch (e) { toastError(e.message) }
  }

  const [auditOf, setAuditOf] = useState(null)   // 展开审计历史的 address id
  const [auditLogs, setAuditLogs] = useState([])

  const showAudit = async (a) => {
    if (auditOf === a.id) { setAuditOf(null); return }
    try {
      const logs = await fetchApi(`/ip/audit?ip_id=${a.id}`)
      setAuditLogs(logs); setAuditOf(a.id)
    } catch (e) { toastError(e.message) }
  }

  const doImport = async () => {
    const r = await openImport({ kind: 'address', title: '批量导入 · 地址台账' })
    if (r) { toastSuccess(`✅ 导入完成：新增 ${r.inserted} / 更新 ${r.updated} / 失败 ${r.failed}`); load() }
  }

  const doExport = () => {
    const qs = new URLSearchParams()
    if (filters.subnet_id) qs.set('subnet_id', filters.subnet_id)
    if (filters.status) qs.set('status', filters.status)
    if (filters.q) qs.set('q', filters.q)
    window.location.href = `/api/ip/addresses/export?${qs}`
  }

  const pages = Math.max(1, Math.ceil(total / size))

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>IP · 地址台账</h1>
          <div className="mut">地址分配与回收（分配/释放/预留/冲突标记全留审计 · 释放有活跃公网映射的地址将被拒绝）</div>
        </div>
        <div>
          <button className="btn btn-outline" style={{ marginRight: 8 }} onClick={doImport}>⬆ 导入</button>
          <button className="btn btn-outline" onClick={doExport}>导出 CSV</button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header"><h4>地址明细</h4><span className="mut">共 {total} 个地址 {loading && '· 加载中...'}</span></div>
        <div className="filters">
          <select value={filters.subnet_id}
            onChange={e => { setFilters({ ...filters, subnet_id: e.target.value }); setSp(e.target.value ? { subnet: e.target.value } : {}) }}>
            <option value="">网段：全部</option>
            {subnets.map(s => <option key={s.id} value={s.id}>{s.cidr}（{s.name}）</option>)}
          </select>
          {Object.entries(STATUS_CN).map(([v, l]) => (
            <span key={v} className={`fchip ${filters.status.split(',').includes(v) ? 'on' : ''}`}
              onClick={() => toggleStatus(v)}>{l}</span>
          ))}
          <input placeholder="搜索 IP / 主机名 / MAC / 使用人" value={filters.q}
            onChange={e => setFilters({ ...filters, q: e.target.value })} />
        </div>
        <table>
          <thead><tr>
            <th>IP 地址</th><th>状态</th><th>主机名</th><th>MAC</th><th>资产</th>
            <th>使用人 / 部门</th><th>用途</th><th>分配时间</th><th>操作</th>
          </tr></thead>
          <tbody>
            {items.map(a => {
              const freeLike = a.status === 'free'
              return (
                <tr key={a.id} style={{ opacity: freeLike ? 0.62 : 1 }}>
                  <td><code className={freeLike ? 'mut' : ''}>{a.ip_text}</code>
                    {a.version === 6 && <span className="badge badge-violet" style={{ marginLeft: 4 }}>v6</span>}</td>
                  <td><span className={`badge ${STATUS_BADGE[a.status]}`}
                    title={a.note || ''}>{STATUS_CN[a.status]}</span></td>
                  <td>{a.hostname || <span className="mut">—</span>}</td>
                  <td>{a.mac ? <code>{a.mac}</code> : <span className="mut">—</span>}</td>
                  <td>{a.asset_type ? `${ASSET_CN[a.asset_type] || a.asset_type}${a.asset_ref ? ' · ' + a.asset_ref : ''}` : <span className="mut">—</span>}</td>
                  <td>{a.owner ? `${a.owner} / ${a.dept || '—'}` : <span className="mut">—</span>}</td>
                  <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={a.purpose || ''}>{a.purpose || <span className="mut">—</span>}</td>
                  <td className="mut">{a.assigned_at ? String(a.assigned_at).slice(0, 10) : '—'}</td>
                  <td className="ops">
                    <ActionMenu actions={[
                      freeLike
                        ? { label: '分配', icon: '✚', onClick: () => doAllocate(a) }
                        : { label: '释放', icon: '↩', danger: true, onClick: () => doRelease(a) },
                      ...(!freeLike && a.status !== 'allocated'
                        ? [{ label: '分配', icon: '✚', onClick: () => doAllocate(a) }] : []),
                      { label: '标记冲突', icon: '⚠', onClick: () => doStatus(a, 'conflict') },
                      { label: '变更历史', icon: '▤', onClick: () => showAudit(a) },
                    ]} />
                  </td>
                </tr>
              )
            })}
            {!items.length && !loading && (
              <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>
                无匹配地址（可尝试勾选「空闲」状态或清空筛选）
              </td></tr>
            )}
            {auditOf && (
              <tr>
                <td colSpan={9} style={{ background: 'var(--bg-light)', padding: '10px 24px' }}>
                  <div style={{ fontSize: 12, fontFamily: 'monospace', color: '#4b5563', lineHeight: 2 }}>
                    <b style={{ fontFamily: 'inherit' }}>变更历史</b>
                    <span className="mut" style={{ marginLeft: 8, cursor: 'pointer' }}
                      onClick={() => setAuditOf(null)}>（收起）</span>
                    {auditLogs.length === 0 && <div className="mut">暂无记录</div>}
                    {auditLogs.map(l => (
                      <div key={l.id}>
                        ↳ <b>{l.action}</b> · {l.actor} · {String(l.created_at)}
                        {l.after && <span className="mut"> · {JSON.stringify(l.after).slice(0, 100)}</span>}
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {pages > 1 && (
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', padding: '12px 18px' }}>
            {Array.from({ length: Math.min(pages, 10) }, (_, i) => i + 1).map(p => (
              <span key={p} onClick={() => setPage(p)} className={p === page ? 'on' : ''}
                style={{ border: '1px solid var(--line)', borderRadius:0, padding: '3px 9px', fontSize: 12,
                  cursor: 'pointer', background: p === page ? 'var(--blue)' : '#fff',
                  color: p === page ? '#fff' : 'var(--dark)' }}>{p}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function lbStyle(color = 'var(--blue)') {
  return { background: 'none', border: 'none', color, fontSize: 12, cursor: 'pointer', padding: '2px 4px' }
}
