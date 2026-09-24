// 交换机 · 定时备份任务（v1.1）— PRD: docs/PRD-华为交换机备份.md §3.6 / docs/PRD-交换机定时任务页面.md
import { useState, useEffect, useCallback, useRef } from 'react'
import { fetchApi } from '../api'
import { toastSuccess, toastError, toastInfo } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import { formDialog } from '../components/FormModal'
import { cronNext, cronPreviewText } from '../lib/cron'
import ActionMenu from '../components/ActionMenu'

const CRON_HINT = '5 段 cron：分 时 日 月 周 · 每天02:00=0 2 * * * · 每周日02:00=0 2 * * 0 · 每月1日=0 2 1 * *'
const CRON_VALIDATE = x => cronNext(x) ? null : '格式：5 段 cron（分 时 日 月 周），如 0 2 * * *'
const CRON_LIVE = v => cronPreviewText(v.cron_expr) || CRON_HINT

export default function SwTasks() {
  const [tasks, setTasks] = useState([])
  const [devices, setDevices] = useState([])
  const [busy, setBusy] = useState(0)          // 正在操作的 task id
  const [runsOf, setRunsOf] = useState(null)   // 展开执行记录的 task id
  const [runs, setRuns] = useState([])
  const [runInfo, setRunInfo] = useState(null) // 立即执行进度条幅 {name, startedAt, latest}
  const pollRef = useRef(null)

  const load = useCallback(() => {
    fetchApi('/sw/tasks').then(setTasks).catch(e => toastError('加载任务失败: ' + e.message))
    fetchApi('/sw/devices').then(ds => setDevices(ds)).catch(() => {})
  }, [])
  useEffect(load, [load])
  useEffect(() => () => clearInterval(pollRef.current), [])

  const loadRuns = useCallback((tid) => {
    fetchApi(`/sw/tasks/${tid}/runs`).then(setRuns)
      .catch(e => toastError('加载执行记录失败: ' + e.message))
  }, [])

  const toggleRuns = (t) => {
    if (runsOf === t.id) { setRunsOf(null); setRuns([]); return }
    setRunsOf(t.id); setRuns([]); loadRuns(t.id)
  }

  const _quickSelects = () => {
    const allIds = devices.map(d => d.id)
    const groups = [...new Set(devices.map(d => d.group_tag).filter(Boolean))]
    return [{ label: '全选', values: allIds },
            ...groups.map(g => ({ label: `分组 ${g}`,
              values: devices.filter(d => d.group_tag === g).map(d => d.id) }))]
  }

  const openAdd = async () => {
    if (!devices.length) { toastInfo('请先在「设备管理」中添加设备'); return }
    const v = await formDialog({
      title: '新建定时备份任务',
      fields: [
        { name: 'name', label: '任务名称', required: true, placeholder: '接入层每日备份', maxLength: 64 },
        { name: 'device_ids', label: '备份设备', type: 'checks', required: true,
          options: devices.map(d => ({ value: d.id, label: d.name })),
          quickSelects: _quickSelects() },
        { name: 'cron_expr', label: '执行周期', initial: '0 2 * * *', required: true,
          maxLength: 64, validate: CRON_VALIDATE, liveHint: CRON_LIVE },
        { name: 'retention_count', label: '每设备保留份数', initial: '30',
          validate: x => (!/^\d+$/.test(x) || +x < 1 || +x > 1000) ? '1-1000 数字' : null },
        { name: 'retention_daily', label: '每日末份永久保留', type: 'select',
          options: [{ value: '0', label: '关闭' }, { value: '1', label: '启用' }] },
        { name: 'remark', label: '备注' },
      ],
      submitText: '创建',
    })
    if (!v) return
    try {
      await fetchApi('/sw/tasks', {
        method: 'POST',
        body: JSON.stringify({
          name: v.name, device_ids: v.device_ids.map(Number), cron_expr: v.cron_expr.trim(),
          retention_count: +v.retention_count, retention_daily: v.retention_daily === '1',
          remark: v.remark || null,
        }),
      })
      toastSuccess('任务已创建并启用调度'); load()
    } catch (e) { toastError(e.message) }
  }

  const openEdit = async (t) => {
    const v = await formDialog({
      title: `编辑任务 ${t.name}`,
      fields: [
        { name: 'name', label: '任务名称', initial: t.name, required: true, maxLength: 64 },
        { name: 'device_ids', label: '备份设备', type: 'checks', required: true,
          options: devices.map(d => ({ value: d.id, label: d.name })),
          initial: t.device_ids, quickSelects: _quickSelects() },
        { name: 'cron_expr', label: '执行周期', initial: t.cron_expr, required: true,
          validate: CRON_VALIDATE, liveHint: CRON_LIVE },
        { name: 'retention_count', label: '每设备保留份数', initial: String(t.retention_count),
          validate: x => (!/^\d+$/.test(x) || +x < 1 || +x > 1000) ? '1-1000 数字' : null },
        { name: 'retention_daily', label: '每日末份永久保留', type: 'select',
          initial: t.retention_daily ? '1' : '0',
          options: [{ value: '0', label: '关闭' }, { value: '1', label: '启用' }] },
        { name: 'remark', label: '备注', initial: t.remark || '' },
      ],
      submitText: '保存',
    })
    if (!v) return
    try {
      await fetchApi(`/sw/tasks/${t.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: v.name, device_ids: v.device_ids.map(Number), cron_expr: v.cron_expr.trim(),
          retention_count: +v.retention_count, retention_daily: v.retention_daily === '1',
          remark: v.remark || null,
        }),
      })
      toastSuccess('已保存，调度已热更新'); load()
    } catch (e) { toastError(e.message) }
  }

  const runNow = async (t) => {
    setBusy(t.id)
    setRunInfo({ name: t.name, startedAt: Date.now(), latest: null })
    // 执行期间每 3s 轮询最新执行记录（running 状态），展示进度
    clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const rs = await fetchApi(`/sw/tasks/${t.id}/runs?limit=1`)
        if (rs.length) setRunInfo(s => (s ? { ...s, latest: rs[0] } : s))
      } catch { /* 轮询失败静默 */ }
    }, 3000)
    try {
      const r = await fetchApi(`/sw/tasks/${t.id}/run`, { method: 'POST' })
      if (r.status === 'success') toastSuccess(`✅ 全部成功：${r.ok}/${r.total} 台`)
      else if (r.status === 'partial') toastError(`🟡 部分成功：ok=${r.ok} fail=${r.fail}`)
      else toastError(`🔴 失败：ok=${r.ok} fail=${r.fail}`)
      load(); if (runsOf === t.id) loadRuns(t.id)
    } catch (e) { toastError(e.message) }
    clearInterval(pollRef.current)
    setRunInfo(null)
    setBusy(0)
  }

  const toggle = async (t) => {
    // P3-10：停用属危险操作，二次确认（启用为安全操作，直接执行）
    if (t.enabled) {
      const ok = await confirmDialog({
        title: `停用任务 ${t.name}？`,
        message: '停用后调度立即移除，到点不再执行备份；任务配置保留，可随时重新启用。',
        danger: true, confirmText: '停用',
      })
      if (!ok) return
    }
    try {
      await fetchApi(`/sw/tasks/${t.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !t.enabled }) })
      toastSuccess(t.enabled ? '已停用（调度已移除）' : '已启用（调度已装载）'); load()
    } catch (e) { toastError(e.message) }
  }

  const del = async (t) => {
    const ok = await confirmDialog({
      title: `删除任务 ${t.name}？`,
      message: '仅删除任务与调度；备份版本与历史执行记录保留。',
      danger: true, confirmText: '删除',
    })
    if (!ok) return
    try {
      await fetchApi(`/sw/tasks/${t.id}`, { method: 'DELETE' })
      toastSuccess('已删除'); if (runsOf === t.id) { setRunsOf(null); setRuns([]) }
      load()
    } catch (e) { toastError(e.message) }
  }

  const fmtTime = (t) => (t || '').replace('T', ' ').substring(0, 16)
  const statusBadge = (s) => s === 'success' ? <span className="badge badge-success">成功</span>
    : s === 'partial' ? <span className="badge badge-warning">部分成功</span>
    : s === 'failed' ? <span className="badge badge-danger">失败</span>
    : <span className="badge badge-default">—</span>

  return <>
    <div className="page-header">
      <div>
        <h1>交换机 · 定时任务</h1>
        <div className="mut" style={{ marginTop: 4 }}>定时备份调度（APScheduler，任务创建/修改即时生效，无需重启）</div>
      </div>
      <button className="btn btn-primary" onClick={openAdd}>＋ 新建任务</button>
    </div>

    <div className="stat-cards">
      <div className="stat-card"><div className="label">任务总数</div><div className="value">{tasks.length}</div></div>
      <div className="stat-card"><div className="label">启用中</div>
        <div className="value">{tasks.filter(t => t.enabled).length}</div></div>
      <div className="stat-card"><div className="label">覆盖设备</div>
        <div className="value">{new Set(tasks.flatMap(t => t.device_ids || [])).size}</div></div>
      <div className="stat-card"><div className="label">下次执行</div>
        <div className="value" style={{ fontSize: 18 }}>
          {tasks.filter(t => t.enabled && t.next_run_at).length
            ? fmtTime(tasks.filter(t => t.enabled && t.next_run_at)
                .map(t => t.next_run_at).sort()[0])
            : '—'}</div></div>
    </div>

    {runInfo && <div className="panel" style={{ border: '1px solid #b9cef1' }}>
      <div className="panel-body" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="spinner" style={{ width: 16, height: 16 }} />
        <strong>任务「{runInfo.name}」执行中</strong>
        <span className="mut">逐台串行 · 已等待 {Math.round((Date.now() - runInfo.startedAt) / 1000)}s</span>
        {runInfo.latest && <span className="mut">| 本轮开始 {fmtTime(runInfo.latest.started_at)} ·
          触发：{runInfo.latest.trigger_type === 'manual' ? '手动' : '定时'}</span>}
      </div>
    </div>}

    <div className="panel">
      <div className="panel-header"><h4>任务列表</h4></div>
      <div className="panel-body">
        {tasks.length ? <table>
          <thead><tr>
            <th>状态</th><th>任务名称</th><th>备份设备</th><th>执行周期</th><th>下次执行</th>
            <th>保留策略</th><th>最近执行</th><th style={{ width: 250 }}>操作</th>
          </tr></thead>
          <tbody>
            {tasks.map(t => <tr key={t.id}>
              <td>{t.enabled ? <span className="badge badge-success">启用</span>
                : <span className="badge badge-default">停用</span>}</td>
              <td><strong>{t.name}</strong>{t.remark && <div className="mut">{t.remark}</div>}</td>
              <td>{(t.device_names || []).join('、') || <span className="mut">未配置</span>}</td>
              <td><code>{t.cron_expr}</code></td>
              <td>{t.enabled && t.next_run_at ? fmtTime(t.next_run_at) : <span className="mut">—</span>}</td>
              <td className="mut">留 {t.retention_count} 份{t.retention_daily ? ' + 每日末份' : ''}</td>
              <td>{t.last_run_at ? <span>{statusBadge(t.last_run_status)}{' '}
                <span className="mut">{fmtTime(t.last_run_at)} · {t.last_run_detail || ''}</span></span>
                : <span className="mut">未执行</span>}</td>
              <td>
                <ActionMenu actions={[
                  { label: '立即执行', icon: '▶', disabled: busy === t.id, onClick: () => runNow(t) },
                  { label: '执行记录', icon: '▤', onClick: () => toggleRuns(t) },
                  { label: '编辑', icon: '✎', onClick: () => openEdit(t) },
                  { label: t.enabled ? '停用' : '启用', icon: t.enabled ? '⊘' : '∅', onClick: () => toggle(t) },
                  { label: '删除', icon: '🗑', danger: true, onClick: () => del(t) },
                ]} />
              </td>
            </tr>)}
          </tbody>
        </table> : <div className="empty">暂无定时任务，点击右上角「新建任务」开始</div>}
      </div>
    </div>

    {runsOf != null && <div className="panel">
      <div className="panel-header"><h4>执行记录 · {tasks.find(t => t.id === runsOf)?.name || ''}</h4></div>
      <div className="panel-body">
        {runs.length ? <table>
          <thead><tr>
            <th>开始时间</th><th>触发</th><th>结果</th><th>成功/失败/跳过</th><th>明细</th>
          </tr></thead>
          <tbody>
            {runs.map(r => <tr key={r.id}>
              <td>{fmtTime(r.started_at)}</td>
              <td>{r.trigger_type === 'manual' ? <span className="badge badge-blue">手动</span>
                : <span className="badge badge-default">定时</span>}</td>
              <td>{statusBadge(r.status)}</td>
              <td>{r.ok_count} / {r.fail_count} / {r.skip_count}</td>
              <td style={{ maxWidth: 420 }}>
                {(r.details || []).map((d, i) => <div key={i} className="mut" style={{ whiteSpace: 'nowrap' }}>
                  {d.status === 'success' ? '✅' : d.status === 'skipped' ? '⏭' : '❌'} {d.name}
                  {d.version_no != null && ` · v${d.version_no}`}{d.error && ` · ${d.error}`}
                </div>)}
              </td>
            </tr>)}
          </tbody>
        </table> : <div className="empty">尚无执行记录</div>}
      </div>
    </div>}
  </>
}
