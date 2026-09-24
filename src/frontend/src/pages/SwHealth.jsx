import { useState, useEffect, useCallback } from 'react'
import ActionMenu from '../components/ActionMenu'
import { fetchApi } from '../api'
import { toastError, toastInfo, toastSuccess } from '../components/Toast'

// 阈值（PRD §3.5）：CPU/内存 ≥80 🟡 / ≥95 🔴；温度 ≥65 🟡（对齐 R750 基线口径）
const level = (v, warn = 80, crit = 95) =>
  v == null ? 'default' : v >= crit ? 'danger' : v >= warn ? 'warning' : 'success'

const STATUS = {
  online:   { label: '在线',   cls: 'badge-success', dot: '#22c55e' },
  checking: { label: '确认中', cls: 'badge-warning', dot: 'var(--warn-dot)' },
  offline:  { label: '离线',   cls: 'badge-danger',  dot: 'var(--red)' },
  unknown:  { label: '未巡检', cls: 'badge-default', dot: '#9ca3af' },
}

function MiniBar({ value, warn, crit }) {
  if (value == null) return <span style={{ color: 'var(--muted)', fontSize: 12 }}>-</span>
  const l = level(value, warn, crit)
  const color = l === 'danger' ? 'var(--red)' : l === 'warning' ? 'var(--warn-dot)' : '#3b82f6'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 64, height: 6, borderRadius:0, background: 'var(--bg-light)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, value)}%`, height: '100%', background: color, borderRadius:0 }} />
      </div>
      <span style={{ fontSize: 12, color, fontWeight: 600, minWidth: 38 }}>{value}%</span>
    </div>
  )
}

// 24h 趋势 SVG（cpu/mem 0-100%，温度按 0-100°C 同轴展示）
function Trend({ history }) {
  const W = 560, H = 150, PAD = 26
  if (!history || history.length < 2)
    return <div className="empty">历史数据不足（至少两次巡检后可看趋势）</div>
  const xs = history.map((h, i) => PAD + (i / (history.length - 1)) * (W - PAD * 2))
  const y = v => H - PAD - (Math.max(0, Math.min(100, v)) / 100) * (H - PAD * 2)
  const line = (key) => history.map((h, i) => {
    const v = h[key == 'temp' ? 'temp_max' : key + '_pct']
    return v == null ? null : `${xs[i]},${y(v)}`
  }).filter(Boolean).join(' ')
  const tempLine = history.map((h, i) =>
    h.temp_max == null ? null : `${xs[i]},${y(h.temp_max)}`).filter(Boolean).join(' ')
  const fmtT = ts => (ts || '').substring(11, 16)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: 'var(--bg-light)', borderRadius:0, border: '1px solid var(--border)' }}>
      {[0, 50, 100].map(v => (
        <g key={v}>
          <line x1={PAD} x2={W - PAD} y1={y(v)} y2={y(v)} stroke="#e5e9f2" strokeDasharray={v ? '3 3' : ''} />
          <text x={4} y={y(v) + 4} fontSize="9" fill="#8a93a5">{v}</text>
        </g>
      ))}
      {tempLine && <polyline points={tempLine} fill="none" stroke="var(--warn-dot)" strokeWidth="1.5" strokeDasharray="4 3" />}
      <polyline points={line('mem')} fill="none" stroke="#7F77DD" strokeWidth="2" />
      <polyline points={line('cpu')} fill="none" stroke="var(--blue)" strokeWidth="2" />
      {[0, Math.floor(history.length / 2), history.length - 1].map((i, k) => (
        <text key={k} x={xs[i]} y={H - 6} fontSize="9" fill="#8a93a5" textAnchor="middle">{fmtT(history[i].collected_at)}</text>
      ))}
      <g fontSize="10" transform={`translate(${W - PAD - 150}, 12)`}>
        <rect width="10" height="3" y="-3" fill="var(--blue)" rx="1.5" /><text x="14" y="0" fill="var(--gray)">CPU%</text>
        <rect width="10" height="3" y="-3" x="52" fill="#7F77DD" rx="1.5" /><text x="66" y="0" fill="var(--gray)">内存%</text>
        <rect width="10" height="3" y="-3" x="108" fill="var(--warn-dot)" rx="1.5" /><text x="122" y="0" fill="var(--gray)">温度°C</text>
      </g>
    </svg>
  )
}

function Detail({ deviceId, onClose }) {
  const [d, setD] = useState(null)
  useEffect(() => {
    fetchApi(`/sw/analysis/devices/${deviceId}`).then(setD).catch(e => { toastError(e.message); onClose() })
  }, [deviceId])
  if (!d) return null
  const { device, latest, history } = d
  const ifaces = latest?.interfaces || []
  const upCount = ifaces.filter(p => p.phy === 'up').length
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 60 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--card, #fff)', borderRadius:0,
        width: 'min(680px, 94vw)', maxHeight: '88vh', overflow: 'auto', padding: '22px 24px',
        boxShadow: '0 24px 60px rgba(0,0,0,0.25)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>{device.name}
            <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 10 }}>
              {device.mgmt_ip} · {device.model}{device.group_tag ? ` · ${device.group_tag}` : ''}
            </span>
          </h3>
          <button className="btn btn-outline btn-sm" onClick={onClose}>关闭</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
          {[['CPU', latest?.cpu_pct, level(latest?.cpu_pct)],
            ['内存', latest?.mem_pct, level(latest?.mem_pct)],
            ['温度°C', latest?.temp_max, level(latest?.temp_max, 65, 80)],
            ['端口 up', ifaces.length ? `${upCount}/${ifaces.length}` : '-']].map(([k, v, l]) => {
            const color = l === 'danger' ? 'var(--red)' : l === 'warning' ? 'var(--warn-dot)' : 'var(--blue)'
            return (
              <div key={k} style={{ background: 'var(--bg-light)', border: '1px solid var(--border)', borderRadius:0, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{k}</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: k === '端口 up' ? 'var(--blue)' : color }}>
                  {v == null ? '-' : Array.isArray(l) ? v : (v + (k === '温度°C' ? '' : k === '端口 up' ? '' : '%'))}
                </div>
              </div>
            )
          })}
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>24 小时趋势</div>
        <Trend history={history} />

        <div style={{ fontSize: 13, fontWeight: 600, margin: '14px 0 6px' }}>
          端口状态（display interface brief，共 {ifaces.length} 个）
        </div>
        {ifaces.length ? (
          <div style={{ maxHeight: 180, overflow: 'auto' }}>
            <table>
              <thead><tr><th>端口</th><th>物理</th><th>协议</th><th>入速率</th><th>出速率</th><th>错包入/出</th></tr></thead>
              <tbody>
                {ifaces.map(p => (
                  <tr key={p.interface}>
                    <td><code>{p.interface}</code></td>
                    <td><span className={`badge ${p.phy === 'up' ? 'badge-success' : 'badge-default'}`}>{p.phy}</span></td>
                    <td><span className={`badge ${p.protocol === 'up' ? 'badge-blue' : 'badge-default'}`}>{p.protocol}</span></td>
                    <td>{p.in_uti}</td>
                    <td>{p.out_uti}</td>
                    <td>{p.in_errors ?? '-'} / {p.out_errors ?? '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className="empty">无端口数据（该型号可能不支持或尚未巡检成功）</div>}

        <div style={{ fontSize: 13, fontWeight: 600, margin: '14px 0 6px' }}>
          当前告警（display alarm urgent，{latest?.alarms?.length || 0} 条）
        </div>
        {latest?.alarms?.length ? (
          <div style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-dot)', borderRadius:0, padding: '10px 14px', fontSize: 13 }}>
            {latest.alarms.map((a, i) => <div key={i} style={{ padding: '2px 0', color: '#9a3412' }}>⚠ {a}</div>)}
          </div>
        ) : <div className="empty">🟢 无活动告警</div>}
      </div>
    </div>
  )
}

export default function SwHealth() {
  const [data, setData] = useState(null)
  const [patrolling, setPatrolling] = useState(false)
  const [detailId, setDetailId] = useState(null)
  const [oneRunning, setOneRunning] = useState({})   // {deviceId: true} 单台巡检进行中

  const load = useCallback(() => {
    fetchApi('/sw/analysis/overview').then(setData).catch(e => toastError('加载失败: ' + e.message))
  }, [])
  useEffect(load, [load])

  const patrol = async () => {
    setPatrolling(true)
    toastInfo('巡检进行中：逐台串行采集，每台约 3~8 秒…')
    try {
      const r = await fetchApi('/sw/analysis/run', { method: 'POST' })
      if (r.offline === 0) toastSuccess(`巡检完成：${r.online}/${r.total} 台在线`)
      else toastError(`巡检完成：${r.online}/${r.total} 台在线，离线/异常 ${r.offline} 台`)
    } catch (e) {
      toastError('巡检失败: ' + e.message)
    }
    setPatrolling(false)
    load()
  }

  const patrolOne = async (d) => {
    setOneRunning(s => ({ ...s, [d.id]: true }))
    toastInfo(`正在巡检 ${d.name}（${d.mgmt_ip}），约 3~8 秒…`)
    try {
      const r = await fetchApi(`/sw/analysis/devices/${d.id}/run`, { method: 'POST' })
      toastSuccess(`${d.name} 巡检完成：CPU ${r.cpu_pct ?? '-'}% · 内存 ${r.mem_pct ?? '-'}%` +
        (r.temp_max != null ? ` · ${r.temp_max}°C` : '') +
        (r.alarm_count ? ` · 告警 ${r.alarm_count} 条` : ' · 无告警'))
    } catch (e) {
      toastError(`${d.name} 巡检失败: ` + e.message)
    }
    setOneRunning(s => { const n = { ...s }; delete n[d.id]; return n })
    load()
  }

  const online = (data || []).filter(d => d.status === 'online').length
  const offline = (data || []).filter(d => d.status === 'offline').length
  const checking = (data || []).filter(d => d.status === 'checking').length
  const cpuAlarm = (data || []).filter(d => (d.cpu_pct ?? 0) >= 80).length
  const alarms = (data || []).reduce((s, d) => s + (d.alarm_count || 0), 0)

  return <>
    <div className="page-header">
      <h1>交换机在线分析</h1>
      <div style={{ display: 'flex', gap: 10 }}>
        <button className="btn btn-outline" onClick={load}>↻ 刷新</button>
        <button className="btn btn-primary" onClick={patrol} disabled={patrolling || !data}>
          {patrolling ? '⏳ 巡检中…' : '▶ 立即巡检'}
        </button>
      </div>
    </div>

    <div className="stat-cards">
      {[
        ['🟢 在线', online, 'var(--green)'],
        ['🔴 离线', offline, 'var(--red)'],
        ['🟡 确认中', checking, 'var(--warn)'],
        ['CPU ≥80%', cpuAlarm, cpuAlarm ? 'var(--red)' : 'var(--green)'],
        ['活动告警', alarms, alarms ? 'var(--warn)' : 'var(--green)'],
      ].map(([label, v, color]) => (
        <div className="stat-card" key={label}>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</div>
          <div style={{ fontSize: 26, fontWeight: 700, color, lineHeight: 1.3 }}>{v ?? '-'}</div>
        </div>
      ))}
    </div>

    <div className="panel">
      <div className="panel-header">
        <strong style={{ fontSize: 13 }}>设备巡检总览</strong>
        <span className="badge badge-default">阈值：CPU/内存 ≥80% 🟡 ≥95% 🔴 · 温度 ≥65°C 🟡</span>
      </div>
      <div className="panel-body">
        {data == null ? <div className="empty">加载中…</div>
          : !data.length ? <div className="empty">暂无设备，请先在「设备管理」添加交换机</div>
          : <table>
              <thead><tr>
                <th>状态</th><th>设备</th><th>管理 IP</th><th>CPU</th><th>内存</th>
                <th>温度</th><th>告警</th><th>运行时长</th><th>最近巡检</th><th>操作</th>
              </tr></thead>
              <tbody>
                {data.map(d => {
                  const st = STATUS[d.status] || STATUS.unknown
                  return (
                    <tr key={d.id}>
                      <td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: st.dot, display: 'inline-block' }} />
                          <span className={`badge ${st.cls}`}>{st.label}</span>
                        </span>
                      </td>
                      <td>
                        <strong>{d.name}</strong>
                        {d.group_tag && <span className="badge badge-default" style={{ marginLeft: 6 }}>{d.group_tag}</span>}
                        {!d.enabled && <span className="badge badge-warning" style={{ marginLeft: 6 }}>停用</span>}
                      </td>
                      <td><code>{d.mgmt_ip}</code></td>
                      <td><MiniBar value={d.cpu_pct} /></td>
                      <td><MiniBar value={d.mem_pct} /></td>
                      <td style={{ color: level(d.temp_max, 65, 80) === 'danger' ? 'var(--red)'
                                    : level(d.temp_max, 65, 80) === 'warning' ? 'var(--warn)' : 'inherit' }}>
                        {d.temp_max != null ? `${d.temp_max}°C` : '-'}
                      </td>
                      <td>{d.alarm_count
                        ? <span className="badge badge-danger">{d.alarm_count} 条</span>
                        : <span style={{ color: 'var(--muted)', fontSize: 12 }}>-</span>}</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 160, overflow: 'hidden',
                                   textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.uptime || '-'}</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {(d.collected_at || '').substring(5, 16) || '未巡检'}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <ActionMenu actions={[
                          { label: '巡检', icon: '⟳', disabled: !!oneRunning[d.id] || patrolling, onClick: () => patrolOne(d) },
                          { label: '详情', icon: '▤', onClick: () => setDetailId(d.id) },
                        ]} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>}
      </div>
    </div>

    {detailId && <Detail deviceId={detailId} onClose={() => setDetailId(null)} />}
  </>
}
