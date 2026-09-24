import { useState, useEffect, useCallback, useMemo } from 'react'
import { fetchApi } from '../../api'
import { toastSuccess, toastError } from '../Toast'
import { confirmDialog } from '../ConfirmModal'
import { formDialog } from '../FormModal'
import ActionMenu from '../ActionMenu'

/**
 * 准入与认证中心（/nac）— S4 服务配置 Panel 集合（Portal / 证书）
 *
 * Panel 列表：
 *   PortalPanel ← pages/PortalManager.jsx（状态卡 + 启停控制 + 配置编辑）
 *   CertsPanel  ← pages/CertManager.jsx （CA 状态 + 签发 + 清单 + 详情抽屉）
 */

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, '')

/* ═══════════ Portal 认证服务（原 /portal）═══════════ */
export function PortalPanel() {
  const [status, setStatus] = useState(null)
  const [acting, setActing] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(() => { fetchApi('/portal/status').then(setStatus).catch(console.error) }, [])
  useEffect(load, [load])

  const ctrl = async (action) => {
    if (action === 'stop' || action === 'restart') {
      const verb = action === 'stop' ? '停止' : '重启'
      const ok = await confirmDialog({
        title: `${verb} Portal 认证服务？`,
        message: `${verb}期间所有通过 Portal 认证的用户将无法登录，进行中的认证请求会失败。`,
        confirmText: `确认${verb}`, danger: true,
      })
      if (!ok) return
    }
    setActing(true)
    try {
      await fetchApi(`/portal/${action}`, { method: 'POST' })
      toastSuccess(action === 'start' ? 'Portal 服务已启动' : action === 'stop' ? 'Portal 服务已停止' : 'Portal 服务已重启')
    } catch (err) { toastError(err.message) }
    setActing(false)
    setTimeout(load, 800)
  }

  const saveConfig = async (key) => {
    const el = document.getElementById('nac-edit-' + key)
    if (!el) return
    const val = el.value.trim()
    if (!val) { toastError('值不能为空'); return }
    try {
      await fetchApi('/portal/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: val }),
      })
      toastSuccess(`配置「${key}」已保存，服务将自动重启`)
      setEditing(null)
    } catch (err) { toastError(err.message) }
    setTimeout(load, 1000)
  }

  const fields = [
    { key: 'shared_secret', label: 'Portal 共享密钥', hint: 'AC 上配置的 Portal 共享密钥' },
    { key: 'radius_secret', label: 'RADIUS 密钥', hint: 'FreeRADIUS secret' },
    { key: 'web_port', label: 'Web 端口', hint: 'HTTP 登录页端口' },
    { key: 'portal_port', label: 'Portal 协议端口', hint: 'UDP Portal 协议端口' },
  ]

  return (
    <div className="panel-body">
      {/* 状态卡 */}
      <div className="stat-cards" style={{ marginBottom: 14 }}>
        <div className="stat-card">
          <div className="label">服务状态</div>
          <div className="value" style={{ color: status?.running ? 'var(--green)' : 'var(--red)', fontSize: 20 }}>
            {status ? (status.running ? '🟢 运行中' : '🔴 已停止') : '-'}
          </div>
        </div>
        <div className="stat-card">
          <div className="label">Web 端口</div>
          <div className="value" style={{ fontSize: 20 }}>{status?.web_port || '-'}</div>
        </div>
        <div className="stat-card">
          <div className="label">Portal 协议端口</div>
          <div className="value" style={{ fontSize: 18 }}>{status?.portal_port || '-'}</div>
        </div>
      </div>

      {/* 服务控制 */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
        <button className="btn btn-primary" onClick={() => ctrl('start')} disabled={status?.running || acting}>启动</button>
        <button className="btn btn-outline" onClick={() => ctrl('stop')} disabled={!status?.running || acting}>停止</button>
        <button className="btn btn-outline" onClick={() => ctrl('restart')} disabled={!status?.running || acting}>重启</button>
      </div>

      {/* 配置编辑 */}
      <table><thead><tr><th>配置项</th><th>当前值</th><th>操作</th></tr></thead><tbody>
        {fields.map(f => <tr key={f.key}>
          <td><strong>{f.label}</strong><div style={{ fontSize: 10, color: 'var(--muted)' }}>{f.hint}</div></td>
          <td><code>{status?.[f.key] || '-'}</code></td>
          <td>
            {editing === f.key ? <>
              <input id={'nac-edit-' + f.key} type={f.key.includes('port') || f.key === 'token_days' ? 'number' : 'text'} defaultValue={f.key.includes('secret') ? '' : (status?.[f.key] || '')} autoFocus style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 12, width: 180 }} />
              <button className="btn btn-primary btn-sm" onClick={() => saveConfig(f.key)}>保存</button>
              <button className="btn btn-outline btn-sm" onClick={() => setEditing(null)}>取消</button>
            </> : <ActionMenu actions={[
              { label: '编辑', icon: '✎', onClick: () => setEditing(f.key) },
            ]} />}
          </td>
        </tr>)}
      </tbody></table>
    </div>
  )
}

/* ═══════════ 证书管理（原 /certs）═══════════ */
export function CertsPanel() {
  const [ca, setCa] = useState(null)
  const [health, setHealth] = useState(null)
  const [users, setUsers] = useState([])
  const [certs, setCerts] = useState([])
  const [alerts, setAlerts] = useState([])
  const [editingDetail, setEditingDetail] = useState(null)
  const [issuing, setIssuing] = useState(false)
  const [issResp, setIssResp] = useState(null)
  const [issErr, setIssErr] = useState(null)
  const [filter, setFilter] = useState('valid')

  // 签发表单状态
  const [form, setForm] = useState({
    user_id: '',
    bound_username: '',
    cn: `client-`,
    san: 'email:',
    validity_days: 730,
    key_size: 2048,
    p12_passphrase: '',
    ca_passphrase: 'qcc-radius-ca-2026',  // 默认预填本环境 CA 口令（输入框可改）
  })

  const reloadAll = async () => {
    try {
      const [caData, h, u, list, al] = await Promise.all([
        fetchApi('/certs/ca').catch(e => ({ error: e.message })),
        fetchApi('/certs/health').catch(e => ({ error: e.message })),
        fetchApi('/certs/users'),
        fetchApi(`/certs${filter !== 'all' ? '?status=' + filter : ''}`),
        fetchApi('/certs/alerts'),
      ])
      setCa(caData)
      setHealth(h)
      setUsers(u)
      setCerts(list)
      setAlerts(al)
    } catch (e) {
      console.error(e)
    }
  }
  useEffect(() => { reloadAll() }, [filter])

  const onUserChange = (uid) => {
    const u = users.find(x => x.id === Number(uid))
    setForm(f => ({
      ...f,
      user_id: uid,
      bound_username: u ? u.username : '',
      cn: u ? `client-${u.username}-${today()}` : `client-anon-${today()}`,
    }))
  }

  const issue = async () => {
    // 前端预校验（与后端 pydantic 规则对齐，避免 422 盲报）
    const errs = []
    if (!form.cn || !form.cn.trim()) errs.push('CN 不能为空')
    if (form.cn.length > 64) errs.push('CN 不能超过 64 字符')
    if (!form.p12_passphrase || form.p12_passphrase.length < 8) errs.push('P12 口令至少 8 位')
    if (form.p12_passphrase.length > 128) errs.push('P12 口令不能超过 128 位')
    if (!form.ca_passphrase) errs.push('请输入 CA 私钥口令')
    const vd = Number(form.validity_days)
    if (!vd || vd < 1 || vd > 3650) errs.push('有效期需在 1~3650 天之间')
    // SAN 预校验：email:/ip: 必须带有效值；前缀后为空的项直接提示
    const sanItems = (form.san || '').trim().split(/[,\s]+/).filter(Boolean)
    for (const it of sanItems) {
      if (it.startsWith('email:')) {
        const v = it.slice(6).trim()
        if (!v || !v.includes('@')) { errs.push(`SAN 邮箱格式错误: "${it}"（示例 email:double@qcc.com）`); break }
      } else if (it.startsWith('ip:')) {
        const v = it.slice(3).trim()
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) { errs.push(`SAN IP 格式错误: "${it}"（示例 ip:192.168.1.10）`); break }
      } else if (it.startsWith('dns:') && it.slice(4).trim() === '') {
        errs.push(`SAN "dns:" 后面不能为空，留空请删除该项`); break
      }
    }
    if (errs.length) { setIssErr(errs.join('；')); return }

    setIssuing(true)
    setIssErr(null)
    setIssResp(null)
    try {
      const body = {
        ...form,
        san: (form.san || '').trim() || null,
        user_id: form.user_id ? Number(form.user_id) : null,
        validity_days: Number(form.validity_days),
        key_size: Number(form.key_size),
      }
      const resp = await fetchApi('/certs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      setIssResp(resp)
      // 弹出 P12 下载
      if (resp.p12_b64) {
        const bin = atob(resp.p12_b64)
        const arr = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
        const url = URL.createObjectURL(new Blob([arr], { type: 'application/x-pkcs12' }))
        const a = document.createElement('a')
        a.href = url
        a.download = `${resp.cn || 'client'}.p12`
        a.click()
        URL.revokeObjectURL(url)
      }
      reloadAll()
    } catch (e) {
      setIssErr(e.message)
    } finally {
      setIssuing(false)
    }
  }

  const revoke = async (c) => {
    const vals = await formDialog({
      title: `吊销证书「${c.cn}」？`,
      message: c.bound_username
        ? `该证书绑定用户 ${c.bound_username}，吊销后其 EAP-TLS 认证将立即失败，且不可恢复。`
        : '吊销后使用该证书的设备将立即无法通过认证，且不可恢复。',
      danger: true,
      submitText: '确认吊销',
      fields: [
        { name: 'reason', label: '吊销原因', type: 'select', required: true, initial: '员工离职',
          options: [
            { value: '员工离职', label: '员工离职' },
            { value: '设备遗失', label: '设备遗失' },
            { value: '密钥疑似泄露', label: '密钥疑似泄露' },
            { value: '其他', label: '其他' },
          ] },
        { name: 'note', label: '备注（可选）', type: 'text', placeholder: '补充说明，便于审计追溯' },
      ],
    })
    if (!vals) return
    try {
      await fetchApi(`/certs/${c.id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: vals.note ? `${vals.reason}（${vals.note}）` : vals.reason }),
      })
      toastSuccess(`证书 ${c.cn} 已吊销`)
      reloadAll()
    } catch (e) { toastError(e.message) }
  }

  const detail = async (cid) => {
    try {
      const d = await fetchApi(`/certs/${cid}`)
      setEditingDetail(d)
    } catch (e) { toastError(e.message) }
  }

  const downloadFile = async (cid, as) => {
    try {
      const token = localStorage.getItem('token') || ''
      const res = await fetch(`/api/certs/${cid}/download?as=${as}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(await res.text())
      const cd = res.headers.get('Content-Disposition') || ''
      const m = cd.match(/filename="([^"]+)"/)
      const fname = m ? m[1] : `${cid}.${as}`
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = fname; a.click()
      URL.revokeObjectURL(url)
    } catch (e) { toastError('下载失败：' + e.message) }
  }

  const downloadCa = async (fmt) => {
    try {
      const token = localStorage.getItem('token') || ''
      const res = await fetch(`/api/certs/ca/download?fmt=${fmt}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(await res.text())
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fmt === 'pem' ? 'ca.qcc.radius.pem' : 'ca.qcc.radius.cer'
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) { toastError('下载失败：' + e.message) }
  }

  return (
    <div className="panel-body">
      {/* 告警条 */}
      {alerts.length > 0 && (
        <div className="panel" style={{ borderLeft: '4px solid var(--orange)', marginBottom: 14 }}>
          <div className="panel-body" style={{ padding: 12, color: 'var(--orange)', fontWeight: 600 }}>
            ⚠️ {alerts.length} 张证书将于 30 天内到期 / 已过期：
            {alerts.map(a => ` ${a.cn}${a.bound_username ? ' (' + a.bound_username + ')' : ''}`).join('、')}
          </div>
        </div>
      )}

      {/* CA 卡 */}
      {ca && !ca.error && (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-header">
            <h4>🟢 CA 状态</h4>
            <span className="badge badge-green">已签发证书台账可查</span>
          </div>
          <div className="panel-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
              <div><span style={{ fontSize: 11, color: 'var(--muted)' }}>Subject</span><div style={{ fontSize: 13, fontFamily: 'monospace', wordBreak: 'break-all' }}>{ca.subject}</div></div>
              <div><span style={{ fontSize: 11, color: 'var(--muted)' }}>Issuer</span><div style={{ fontSize: 13, fontFamily: 'monospace', wordBreak: 'break-all' }}>{ca.issuer}</div></div>
              <div><span style={{ fontSize: 11, color: 'var(--muted)' }}>有效期</span><div style={{ fontSize: 13 }}>{ca.not_before} → {ca.not_after}</div></div>
              <div><span style={{ fontSize: 11, color: 'var(--muted)' }}>Key Size</span><div style={{ fontSize: 13 }}>{ca.key_size} bits {ca.is_self_signed && <span className="badge badge-blue">自签</span>}</div></div>
              <div style={{ gridColumn: 'span 2' }}><span style={{ fontSize: 11, color: 'var(--muted)' }}>SHA-256 指纹</span>
                <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{ca.fingerprint_sha256}</code>
              </div>
            </div>
            <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
              <button className="btn btn-outline btn-sm" onClick={() => downloadCa('pem')}>下载 CA (PEM)</button>
              <button className="btn btn-outline btn-sm" onClick={() => downloadCa('der')}>下载 CA (DER)</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 14, alignItems: 'start' }}>
        {/* 签发表单 */}
        <div className="panel">
          <div className="panel-header"><h4>签发新证书</h4><span className="badge badge-blue">客户端</span></div>
          <div className="panel-body">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={lbl}>
                <span>绑给员工</span>
                <select value={form.user_id} onChange={e => onUserChange(e.target.value)}>
                  <option value="">（不绑，仅按 CN 签发）</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
                </select>
              </label>
              <label style={lbl}>
                <span>证书 CN</span>
                <input value={form.cn} onChange={e => setForm({ ...form, cn: e.target.value })} placeholder="client-double-20260831" />
              </label>
              <label style={lbl}>
                <span>SAN（可选）</span>
                <input value={form.san} onChange={e => setForm({ ...form, san: e.target.value })} placeholder="email:double@qcc.com 或 dns:vpn.qcc.com" />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={lbl}>
                  <span>有效期(天)</span>
                  <input type="number" min="30" max="3650" value={form.validity_days} onChange={e => setForm({ ...form, validity_days: e.target.value })} />
                </label>
                <label style={lbl}>
                  <span>Key Size</span>
                  <select value={form.key_size} onChange={e => setForm({ ...form, key_size: Number(e.target.value) })}>
                    <option value="2048">2048</option>
                    <option value="3072">3072</option>
                    <option value="4096">4096</option>
                  </select>
                </label>
              </div>
              <label style={lbl}>
                <span>P12 口令（员工导入用）</span>
                <input type="password" value={form.p12_passphrase} onChange={e => setForm({ ...form, p12_passphrase: e.target.value })} placeholder="≥8 位" />
              </label>
              <label style={lbl}>
                <span>CA 私钥口令（一次性）</span>
                <input type="password" value={form.ca_passphrase} onChange={e => setForm({ ...form, ca_passphrase: e.target.value })} placeholder="本次签名用，不存储" title="已预填默认口令，可直接使用或修改" />
              </label>
              <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
                签发后立即下载 <code>.p12</code>，证书与 CA 链已嵌入，员工双击即可导入系统证书库。EKU=clientAuth、SAN 自定义。
              </div>
              <button className="btn btn-primary" disabled={issuing || !form.cn || !form.p12_passphrase || !form.ca_passphrase} onClick={issue}>
                {issuing ? '签发中...' : '签发 + 下载 P12'}
              </button>
              {issErr && <div style={{ color: '#c43', fontSize: 12 }}>✗ {issErr}</div>}
              {issResp && <div style={{ color: 'var(--green)', fontSize: 12, wordBreak: 'break-all' }}>✓ 已签发，serial={issResp.serial_hex}</div>}
            </div>
          </div>
        </div>

        {/* 清单 */}
        <div className="panel">
          <div className="panel-header">
            <h4>客户端证书清单</h4>
            <div style={{ display: 'flex', gap: 6 }}>
              {['valid', 'revoked', 'all'].map(s => (
                <button key={s}
                  className={'btn btn-sm ' + (filter === s ? 'btn-primary' : 'btn-outline')}
                  onClick={() => setFilter(s)}>
                  {s === 'valid' ? '有效' : s === 'revoked' ? '已吊销' : '全部'}
                </button>
              ))}
            </div>
          </div>
          <div className="panel-body" style={{ padding: 0 }}>
            {certs.length === 0 ? (
              <div className="empty">暂无证书</div>
            ) : (
              <table>
                <thead><tr>
                  <th>CN</th><th>绑给</th><th>签发时间</th><th>到期</th><th>状态</th><th>指纹</th><th>操作</th>
                </tr></thead>
                <tbody>
                  {certs.map(c => (
                    <tr key={c.id}>
                      <td><strong>{c.cn}</strong></td>
                      <td>{c.bound_username || '-'}</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>{c.issued_at}</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>{c.not_after}</td>
                      <td><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.status_indicator}</span></td>
                      <td><code style={{ fontSize: 10 }}>{c.fingerprint_sha256.slice(0, 16)}…</code></td>
                      <td>
                        <ActionMenu actions={[
                          { label: '查看详情', icon: '▤', onClick: () => detail(c.id) },
                          ...(c.status === 'valid' ? [
                            { label: '下载 PEM', icon: '⤓', onClick: () => downloadFile(c.id, 'pem') },
                            { label: '下载 P12', icon: '⤓', onClick: () => downloadFile(c.id, 'p12') },
                            { label: '吊销', icon: '⊘', danger: true, onClick: () => revoke(c) },
                          ] : []),
                        ]} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* 详情抽屉 */}
      {editingDetail && (
        <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 480, background: 'var(--layer)', boxShadow: '-4px 0 20px rgba(0,0,0,0.1)', padding: 24, overflowY: 'auto', zIndex: 100 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0 }}>证书详情 #{editingDetail.id}</h3>
            <button style={{ marginLeft: 'auto' }} className="btn btn-outline btn-sm" onClick={() => setEditingDetail(null)}>✕</button>
          </div>
          <Field k="CN" v={editingDetail.cn} />
          <Field k="绑给用户" v={editingDetail.bound_username || '-'} />
          <Field k="Subject" v={editingDetail.subject} mono />
          <Field k="Issuer" v={editingDetail.issuer} mono />
          <Field k="SAN" v={editingDetail.san || '-'} />
          <Field k="Serial" v={editingDetail.serial_hex} mono />
          <Field k="有效期" v={`${editingDetail.not_before} → ${editingDetail.not_after}`} />
          <Field k="SHA-256" v={editingDetail.fingerprint_sha256} mono small />
          <Field k="状态" v={editingDetail.status} />
          {editingDetail.revoked_at && <Field k="吊销时间" v={editingDetail.revoked_at} />}
          {editingDetail.revoke_reason && <Field k="吊销原因" v={editingDetail.revoke_reason} />}
          {editingDetail.cert_pem && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>证书 PEM</div>
              <textarea readOnly value={editingDetail.cert_pem} style={{ width: '100%', height: 220, fontFamily: 'monospace', fontSize: 10 }} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const lbl = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }
const Field = ({ k, v, mono, small }) => (
  <div style={{ marginBottom: 10 }}>
    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{k}</div>
    <div style={{ fontSize: mono ? 12 : 13, fontFamily: mono ? 'monospace' : 'inherit', wordBreak: 'break-all' }}>{v}</div>
  </div>
)
