// IP · 公网资产（公网地址 + NAT 映射 + 域名备案）— PRD: docs/PRD-IP资产管理.md §6.4
import { useState, useEffect, useCallback, Fragment } from 'react'
import { fetchApi } from '../api'
import { toastSuccess, toastError } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import { formDialog } from '../components/FormModal'
import { openImport } from '../components/ImportModal'
import ActionMenu from '../components/ActionMenu'

const ISP_CN = { telecom: '电信', unicom: '联通', mobile: '移动', cloud: '云厂商' }
const STATUS_BADGE = { allocated: 'badge-success', reserved: 'badge-warning', free: 'badge-default', conflict: 'badge-danger', disabled: 'badge-default' }
const STATUS_CN = { allocated: '在用', reserved: '未启用', free: '空闲', conflict: '冲突', disabled: '已退回' }
const ACTOR = () => localStorage.getItem('admin_user') || 'admin'

function daysTo(dstr) {
  if (!dstr) return null
  return Math.ceil((new Date(dstr) - new Date()) / 86400000)
}

export default function IpPublic() {
  const [items, setItems] = useState([])
  const [privates, setPrivates] = useState([])   // 私网地址（新建映射选择）
  const [expanded, setExpanded] = useState(null) // 展开映射的地址 id
  const [onlyExpiring, setOnlyExpiring] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems(await fetchApi('/ip/public'))
    } catch (e) { toastError(e.message) }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const openNat = async (pub) => {
    if (!privates.length) {
      try { setPrivates(await fetchApi('/ip/addresses?status=allocated&size=200').then(r => r.items.filter(x => x.subnet_scope === 'private'))) } catch { /* 忽略 */ }
    }
    const v = await formDialog({
      title: pub ? `新增 NAT 映射（${pub.ip_text}）` : '新增 NAT 映射',
      fields: [
        { name: 'public_ip_id', label: '公网地址', type: 'select', required: true, initial: pub ? String(pub.id) : '',
          options: items.map(x => ({ value: String(x.id), label: x.ip_text })) },
        { name: 'public_port', label: '公网端口（0 = 1:1 全端口）', initial: '443',
          validate: x => (!/^\d+$/.test(x) || +x < 0 || +x > 65535) ? '0-65535' : null },
        { name: 'proto', label: '协议', type: 'select', initial: 'tcp',
          options: [{ value: 'tcp', label: 'tcp' }, { value: 'udp', label: 'udp' }, { value: 'any', label: 'any（仅 1:1）' }] },
        { name: 'private_ip_id', label: '私网地址', type: 'select', required: true,
          options: privates.map(x => ({ value: String(x.id), label: `${x.ip_text}${x.hostname ? '（' + x.hostname + '）' : ''}` })) },
        { name: 'private_port', label: '私网端口', initial: '4433',
          validate: x => (!/^\d+$/.test(x) || +x < 0 || +x > 65535) ? '0-65535' : null },
        { name: 'note', label: '备注' },
      ],
      submitText: '创建映射',
    })
    if (!v) return
    try {
      await fetchApi('/ip/nat', { method: 'POST', body: JSON.stringify({
        public_ip_id: +v.public_ip_id, public_port: +v.public_port,
        private_ip_id: +v.private_ip_id, private_port: +v.private_port,
        proto: v.proto, note: v.note, actor: ACTOR() }) })
      toastSuccess('✅ 映射已创建'); load()
    } catch (e) { toastError(e.message) }
  }

  const delNat = async (n) => {
    const ok = await confirmDialog({
      title: '删除 NAT 映射？', danger: true, keyword: `${n.public_ip}:${n.public_port}`,
      message: `删除后 ${n.public_ip}:${n.public_port} → ${n.private_ip}:${n.private_port} 不再生效`,
      confirmText: '删除',
    })
    if (!ok) return
    try {
      await fetchApi(`/ip/nat/${n.id}?actor=${encodeURIComponent(ACTOR())}`, { method: 'DELETE' })
      toastSuccess('✅ 映射已删除'); load()
    } catch (e) { toastError(e.message) }
  }

  const doImport = async () => {
    const r = await openImport({ kind: 'nat', title: '批量导入 · NAT 映射' })
    if (r) { toastSuccess(`✅ 导入完成：新增 ${r.inserted} / 更新 ${r.updated} / 失败 ${r.failed}`); load() }
  }

  const visible = onlyExpiring
    ? items.filter(x => { const d = daysTo(x.contract_end); return d !== null && d <= 90 })
    : items
  const expiring = items.filter(x => { const d = daysTo(x.contract_end); return d !== null && d <= 90 }).length
  const noIcp = items.filter(x => x.status === 'allocated' && !(x.icp_no) && !(x.domains_parsed || []).some(d => d.icp_no)).length
  const natTotal = items.reduce((s, x) => s + x.nat_count, 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>IP · 公网资产</h1>
          <div className="mut">公网 IPv4/IPv6 地址、NAT 映射与域名备案统一台账（释放有活跃映射的私网地址将被拒绝）</div>
        </div>
        <div>
          <button className="btn btn-outline" style={{ marginRight: 8 }} onClick={doImport}>⬆ 导入</button>
          <button className="btn btn-primary" onClick={() => openNat(null)}>+ 新增映射</button>
        </div>
      </div>

      <div className="stat-cards">
        <div className="stat-card"><div className="label">公网地址数</div>
          <div className="value">{items.filter(x => x.version === 4).length} <small>IPv4</small>
            &nbsp;·&nbsp; {items.filter(x => x.version === 6).length} <small>IPv6</small></div></div>
        <div className="stat-card"><div className="label">活跃 NAT 映射</div>
          <div className="value">{natTotal} <small>条</small></div></div>
        <div className="stat-card"><div className="label">合约 90 天内到期</div>
          <div className="value" style={{ color: expiring ? 'var(--red)' : 'inherit' }}>{expiring} <small>{expiring ? '🔴 需续约' : '正常'}</small></div></div>
        <div className="stat-card"><div className="label">备案缺失</div>
          <div className="value" style={{ color: noIcp ? 'var(--red)' : 'inherit' }}>{noIcp} <small>{noIcp ? '🔴 对外服务无备案' : '正常'}</small></div></div>
      </div>

      <div className="panel">
        <div className="panel-header"><h4>公网地址</h4>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className={`fchip ${onlyExpiring ? 'on' : ''}`} onClick={() => setOnlyExpiring(!onlyExpiring)}>合约临期</span>
            <span className="mut">共 {visible.length} 条 {loading && '· 加载中...'}</span>
          </div></div>
        <table>
          <thead><tr>
            <th>公网 IP</th><th>运营商</th><th>线路 / 带宽</th><th>状态</th>
            <th>关联域名（备案）</th><th>NAT 映射</th><th>合约到期</th><th>操作</th>
          </tr></thead>
          <tbody>
            {visible.map(x => {
              const d = daysTo(x.contract_end)
              return (
                <Fragment key={x.id}>
                  <tr>
                    <td><code>{x.ip_text}</code>
                      {x.version === 6 && <span className="badge badge-violet" style={{ marginLeft: 4 }}>v6</span>}</td>
                    <td>{x.isp ? <span className="badge badge-blue">{ISP_CN[x.isp] || x.isp}</span> : <span className="mut">—</span>}</td>
                    <td>{x.line_name || '—'}{x.bandwidth_mbps ? <span className="mut"> · {x.bandwidth_mbps}M</span> : null}</td>
                    <td><span className={`badge ${STATUS_BADGE[x.status] || 'badge-default'}`}>{STATUS_CN[x.status] || x.status}</span></td>
                    <td style={{ maxWidth: 200 }}>
                      {(x.domains_parsed || []).length
                        ? x.domains_parsed.map((dm, i) => (
                          <span key={i} className="badge badge-default" style={{ marginRight: 4 }}
                            title={dm.icp_no || '无备案号'}>{dm.name}</span>))
                        : (x.icp_no ? <span className="mut">{x.icp_no}</span>
                          : (x.status === 'allocated' ? <span style={{ color: 'var(--red)' }}>🔴 无备案</span> : <span className="mut">—</span>))}
                    </td>
                    <td><b style={{ cursor: x.nat_count ? 'pointer' : 'default' }}
                      onClick={() => x.nat_count && setExpanded(expanded === x.id ? null : x.id)}>
                      {x.nat_count}</b> <span className="mut">{x.nat_count ? '条 ▾' : '条'}</span></td>
                    <td style={d !== null && d <= 90 ? { color: 'var(--red)', fontWeight: 600 } : {}}>
                      {x.contract_end || '按量/无'}{d !== null && d <= 90 ? ` 🔴 ${d} 天` : ''}
                    </td>
                    <td className="ops">
                      <ActionMenu actions={[
                        { label: 'NAT 映射', icon: '⇄', onClick: () => openNat(x) },
                      ]} />
                    </td>
                  </tr>
                  {expanded === x.id && x.nat && x.nat.length > 0 && (
                    <tr>
                      <td colSpan={8} style={{ background: 'var(--bg-light)', padding: '8px 24px' }}>
                        <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#4b5563', lineHeight: 2 }}>
                          {x.nat.map(n => (
                            <div key={n.id}>
                              ↳ <code>{n.public_ip}:{n.public_port || '*'}</code> ({n.proto}) → <code>{n.private_ip}:{n.private_port || '*'}</code>
                              {' '}{n.private_hostname || ''} {n.private_purpose || ''} {n.note || ''}
                              {' '}<button className="link-btn" onClick={() => delNat(n)}
                                style={{ background: 'none', border: 'none', color: 'var(--red)', fontSize: 12, cursor: 'pointer' }}>删除</button>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {!visible.length && !loading && (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)', padding: 32 }}>
                暂无公网地址——在「网段管理」新建 scope=公网 的网段，或在地址台账登记公网 IP 后显示
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
