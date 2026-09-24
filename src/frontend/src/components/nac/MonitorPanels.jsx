import { useState, useEffect, useCallback } from 'react'
import { tr } from '../../i18n'
import { api, fetchApi } from '../../api'
import CollapsePanel from '../CollapsePanel'
import { toastSuccess, toastError } from '../Toast'
import { confirmDialog } from '../ConfirmModal'

/**
 * 准入与认证中心（/nac）— 子模块 Panel 集合
 * 提取-搬入策略：原页面主体原样搬入（去掉 page-header 外壳），
 * 业务逻辑/搜索/分页/CRUD 全部保留。旧路由页薄壳渲染同一 Panel。
 *
 * Panel 列表：
 *   OnlinePanel   ← pages/Online.jsx
 *   AuthLogPanel  ← pages/AuthLog.jsx
 *   AcctPanel     ← pages/Accounting.jsx
 */

/* ═══════════ 在线会话（原 /online）═══════════ */
export function OnlinePanel({ preset }) {
  // 快捷排障带参：挂载时读取 sessionStorage 的搜索词（NacCenter 快捷排障条写入）
  let quick = null
  try { quick = sessionStorage.getItem('nac_quick') } catch {}
  const [data, setData] = useState([])
  const [pg, setPg] = useState(1); const sz = 20
  const [userQ, setUserQ] = useState(preset?.user || quick || '')
  const [macQ, setMacQ] = useState(preset?.mac || '')

  useEffect(() => { try { sessionStorage.removeItem('nac_quick') } catch {} }, [])

  const load = useCallback(() => {
    api.online(userQ.trim(), macQ.trim()).then(setData).catch(console.error)
  }, [userQ, macQ])
  useEffect(load, [load])
  useEffect(() => {
    if (!userQ && !macQ) { setPg(1); api.online().then(setData).catch(console.error) }
  }, [userQ, macQ])

  const tp = Math.ceil(data.length / sz) || 1; const page = data.slice((pg - 1) * sz, pg * sz)
  const handleSearch = () => { setPg(1); load() }
  const handleReset = () => { setUserQ(''); setMacQ(''); setPg(1) }

  return (
    <div className="panel-body">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input type="text" placeholder={tr('search_username')} value={userQ}
          onChange={e => setUserQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
          style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 13, width: 200 }} />
        <input type="text" placeholder={tr('search_mac')} value={macQ}
          onChange={e => setMacQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
          style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 13, width: 200 }} />
        <button className="btn btn-primary btn-sm" onClick={handleSearch}>{tr('query')}</button>
        <button className="btn btn-outline btn-sm" onClick={handleReset}>{tr('all')}</button>
        <span className="badge badge-blue" style={{ marginLeft: 'auto' }}>{data.length} {tr('online_count')}</span>
      </div>
      {data.length ? <>
        <table><thead><tr><th>{tr('username')}</th><th>{tr('ip')}</th><th>{tr('mac')}</th><th>{tr('start_time')}</th><th className="num">{tr('duration')}</th><th className="num">{tr('upload')}</th><th className="num">{tr('download')}</th></tr></thead><tbody>
          {page.map((o, i) => <tr key={i}><td><strong>{o.username}</strong></td><td>{o.ip || '-'}</td><td><code>{(o.mac || '').substring(0, 17)}</code></td><td>{(o.acctstarttime || '').substring(5, 16)}</td><td className="num">{fmtDur(o.acctsessiontime)}</td><td className="num">{fmtNum(o.up_mb)} {tr('MB_unit')}</td><td className="num">{fmtNum(o.down_mb)} {tr('MB_unit')}</td></tr>)}
        </tbody></table>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12, fontSize: 12, color: 'var(--gray)' }}>
          <button className="btn btn-outline btn-sm" disabled={pg <= 1} onClick={() => setPg(pg - 1)}>◀</button>
          <span>{pg}/{tp}</span>
          <button className="btn btn-outline btn-sm" disabled={pg >= tp} onClick={() => setPg(pg + 1)}>▶</button>
        </div>
      </> : <div className="empty">{tr('no_device')}</div>}
    </div>
  )
}

/* ═══════════ 认证日志（原 /authlog）═══════════ */
export function AuthLogPanel({ preset }) {
  // 快捷排障带参：挂载时读取 sessionStorage 的搜索词
  let quick = null
  try { quick = sessionStorage.getItem('nac_quick') } catch {}
  const [data, setData] = useState([])
  const [pg, setPg] = useState(1); const [sz, setSz] = useState(20)
  const [from, setFrom] = useState(''); const [to, setTo] = useState('')
  const [userQ, setUserQ] = useState(preset?.user || quick || '')

  useEffect(() => { try { sessionStorage.removeItem('nac_quick') } catch {} }, [])

  const load = useCallback(() => {
    api.authlog(userQ.trim()).then(setData).catch(console.error)
  }, [userQ])
  useEffect(load, [load])
  useEffect(() => {
    if (!userQ) { setPg(1); api.authlog().then(setData).catch(console.error) }
  }, [userQ])

  const setRange = (h) => {
    if (!h) { setFrom(''); setTo(''); setPg(1); return }
    const n = new Date(); setTo(n.toISOString().split('T')[0])
    n.setHours(n.getHours() - h); setFrom(n.toISOString().split('T')[0]); setPg(1)
  }
  const filtered = data.filter(l => {
    const d = (l.authdate || '').substring(0, 10)
    if (from && d < from) return false
    if (to && d > to) return false
    return true
  })
  const tp = Math.ceil(filtered.length / sz) || 1
  const page = filtered.slice((pg - 1) * sz, pg * sz)
  const clear = async () => {
    const ok = await confirmDialog({
      title: '清空全部认证日志？',
      message: `当前共 ${data.length} 条记录，清空后不可恢复，审计追溯将失效。`,
      confirmText: '清空', danger: true, keyword: '清空',
    })
    if (!ok) return
    try { await api.clearAuthlog(); setData([]); toastSuccess('认证日志已清空') }
    catch (err) { toastError(err.message) }
  }
  const handleSearch = () => { setPg(1); load() }
  const handleReset = () => { setUserQ(''); setPg(1) }

  return (
    <div className="panel-body">
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        {[1, 6, 24, 168, 720].map(h => <button key={h} className="btn btn-outline btn-sm" onClick={() => setRange(h)}>{h < 24 ? h + 'h' : h / 24 + 'd'}</button>)}
        <button className="btn btn-outline btn-sm" onClick={() => setRange(0)}>All</button>
        <button className="btn btn-outline btn-sm" onClick={clear}>{tr('clear')}</button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <input type="text" placeholder={tr('search_username')} value={userQ}
          onChange={e => setUserQ(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch() }}
          style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 13, width: 200 }} />
        <button className="btn btn-primary btn-sm" onClick={handleSearch}>{tr('query')}</button>
        <button className="btn btn-outline btn-sm" onClick={handleReset}>{tr('all')}</button>
      </div>
      {data.length ? <><table><thead><tr><th>ID</th><th>{tr('username')}</th><th>认证方式</th><th>{tr('result')}</th><th>拒绝原因</th><th>{tr('time')}</th></tr></thead><tbody>
        {page.map((l, i) => {
          const accept = (l.reply || '').startsWith('Access-Accept')
          const raw = l.reply || ''
          const reason = raw.startsWith('Access-Reject ') ? raw.slice('Access-Reject '.length).replace(/=3D/g, '=').replace(/=2C/g, ',') : ''
          const method = l.auth_method || 'PAP/CHAP'
          const methodBadge = method.startsWith('EAP-') ? 'badge-blue' : method === 'PAP/CHAP' ? 'badge-default' : 'badge-purple'
          return <tr key={i}><td>{l.id}</td><td><code>{l.username}</code></td>
            <td><span className={`badge ${methodBadge}`}>{method}</span></td>
            <td><span className={`badge ${accept ? 'badge-success' : 'badge-danger'}`}>{accept ? 'Access-Accept' : 'Access-Reject'}</span></td>
            <td style={{ fontSize: 12, maxWidth: 260, color: accept ? 'var(--muted)' : '#e24b4a' }}>{reason || '-'}</td>
            <td>{(l.authdate || '').substring(0, 19)}</td></tr>
        })}
      </tbody></table>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12, fontSize: 12, color: 'var(--gray)', alignItems: 'center' }}>
          <span>{tr('per_page')}</span><select value={sz} onChange={e => { setSz(Number(e.target.value)); setPg(1) }} style={{ padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 12 }}>
            <option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select><span>条</span>
          <button className="btn btn-outline btn-sm" disabled={pg <= 1} onClick={() => setPg(pg - 1)}>◀</button><span>{pg}/{tp}</span>
          <button className="btn btn-outline btn-sm" disabled={pg >= tp} onClick={() => setPg(pg + 1)}>▶</button>
        </div></> : <div className="empty">{tr('no_data')}</div>}
    </div>
  )
}

/* ═══════════ 记账查询（原 /accounting）═══════════ */
export function AcctPanel({ preset }) {
  // 快捷排障带参：挂载时读取 sessionStorage 的搜索词
  let quick = null
  try { quick = sessionStorage.getItem('nac_quick') } catch {}
  const [data, setData] = useState(null)
  const [search, setSearch] = useState({ username: preset?.user || quick || '', ip: '', from: '', to: '' })
  const [pg, setPg] = useState(1)
  const [sz, setSz] = useState(20)

  useEffect(() => { try { sessionStorage.removeItem('nac_quick') } catch {} }, [])

  const doSearch = async (e, customFrom, customTo) => {
    e?.preventDefault()
    const params = new URLSearchParams()
    const f = customFrom ?? search.from
    const t = customTo ?? search.to
    if (search.username) params.set('username', search.username)
    if (search.ip) params.set('ip', search.ip)
    if (f) params.set('from_date', f)
    if (t) params.set('to_date', t)
    params.set('limit', '500')
    const r = await fetchApi('/accounting?' + params.toString())
    setData(r); setPg(1)
  }

  const setRange = (h) => {
    const n = new Date()
    const to = n.toISOString().split('T')[0]
    n.setHours(n.getHours() - h)
    const from = n.toISOString().split('T')[0]
    setSearch({ ...search, from, to })
    doSearch(null, from, to)
  }

  const tp = data ? Math.ceil(data.length / sz) || 1 : 1
  const page = data ? data.slice((pg - 1) * sz, pg * sz) : []

  return (
    <div className="panel-body">
      <form onSubmit={doSearch} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input placeholder={tr('username')} value={search.username} onChange={e => setSearch({ ...search, username: e.target.value })} />
        <input placeholder={tr('ip')} value={search.ip} onChange={e => setSearch({ ...search, ip: e.target.value })} />
        <input type="date" value={search.from} onChange={e => setSearch({ ...search, from: e.target.value })} />
        <span style={{ fontSize: 12, color: 'var(--muted)', alignSelf: 'center' }}>~</span>
        <input type="date" value={search.to} onChange={e => setSearch({ ...search, to: e.target.value })} />
        <button className="btn btn-primary" type="submit">{tr('query')}</button>
      </form>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {[{ h: 1, l: '1h' }, { h: 6, l: '6h' }, { h: 24, l: '24h' }, { h: 168, l: '7d' }, { h: 720, l: '30d' }].map(x =>
          <button key={x.h} className="btn btn-outline btn-sm" onClick={() => setRange(x.h)}>{x.l}</button>)}
      </div>
      <div style={{ marginTop: 12 }}>
        {data === null ? <div className="empty">{tr('start_end_date')}</div> :
          data.length ? <><table><thead><tr><th>{tr('username')}</th><th>{tr('ip')}</th><th>{tr('mac')}</th><th>{tr('start_time')}</th><th className="num">{tr('duration')}</th><th className="num">{tr('upload')}</th><th className="num">{tr('download')}</th></tr></thead><tbody>
            {page.map((r, i) => <tr key={i}><td><strong>{r.username}</strong></td><td>{r.ip || '-'}</td><td><code>{(r.mac || '').substring(0, 17)}</code></td><td>{(r.acctstarttime || '').substring(0, 19)}</td><td className="num">{r.hours}h</td><td className="num">{fmtNum(r.up_mb)} MB</td><td className="num">{fmtNum(r.down_mb)} MB</td></tr>)}
          </tbody></table>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12, fontSize: 12, color: 'var(--gray)', alignItems: 'center' }}>
              <span>每页</span><select value={sz} onChange={e => { setSz(Number(e.target.value)); setPg(1) }} style={{ padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 12 }}><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option></select><span>条</span>
              <button className="btn btn-outline btn-sm" disabled={pg <= 1} onClick={() => setPg(pg - 1)}>◀</button><span>{pg}/{tp}</span>
              <button className="btn btn-outline btn-sm" disabled={pg >= tp} onClick={() => setPg(pg + 1)}>▶</button>
            </div></> : <div className="empty" style={{ padding: '36px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 10, opacity: .5 }}>📭</div>
            暂无记账记录，请调整查询条件（如扩大时间范围或清空用户名/IP）
          </div>}
      </div>
    </div>
  )
}

function fmtDur(sec) { const s = parseInt(sec) || 0; if (s >= 3600) return Math.floor(s / 3600) + 'h' + Math.floor(s % 3600 / 60) + 'm'; if (s >= 60) return Math.floor(s / 60) + 'm' + s % 60 + 's'; return s + 's' }
function fmtNum(n) { const v = parseFloat(n); if (isNaN(v)) return n ?? '-'; return v >= 1000 ? v.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : String(n) }
