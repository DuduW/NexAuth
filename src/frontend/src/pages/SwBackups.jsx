// 交换机 · 备份（v1.0：版本历史 / 查看 / 下载 / diff）
import { useState, useEffect, useCallback } from 'react'
import ActionMenu from '../components/ActionMenu'
import { fetchApi } from '../api'
import { toastSuccess, toastError } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'

const TRIGGER_BADGE = {
  manual: ['badge-default', '手动'],
  scheduled: ['badge-blue', '定时'],
  restore_snapshot: ['badge-warning', '自动快照'],
}

export default function SwBackups() {
  const [devices, setDevices] = useState([])
  const [devId, setDevId] = useState('')
  const [backups, setBackups] = useState([])
  const [loading, setLoading] = useState(false)
  const [viewer, setViewer] = useState(null)   // {title, kind:'text'|'diff', body, meta}
  const [devName, setDevName] = useState('')

  useEffect(() => {
    fetchApi('/sw/devices').then(ds => {
      setDevices(ds)
      if (ds.length && !devId) setDevId(String(ds[0].id))
    }).catch(e => toastError('加载设备失败: ' + e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadBackups = useCallback(() => {
    if (!devId) { setBackups([]); return }
    setLoading(true)
    fetchApi(`/sw/devices/${devId}/backups`)
      .then(setBackups)
      .catch(e => toastError('加载备份失败: ' + e.message))
      .finally(() => setLoading(false))
  }, [devId])
  useEffect(loadBackups, [loadBackups])

  const selDev = devices.find(d => String(d.id) === String(devId))
  useEffect(() => { setDevName(selDev ? selDev.name : '') }, [selDev])

  const view = async (b) => {
    try {
      const text = await fetchApi(`/sw/backups/${b.id}/content`)
      setViewer({ title: `${devName} · v${b.version_no} 全文`, kind: 'text', body: text })
    } catch (e) { toastError(e.message) }
  }

  const download = (b) => {
    window.open(`/api/sw/backups/${b.id}/download`, '_blank')
    toastSuccess(`已请求下载 ${devName}_v${b.version_no}.cfg`)
  }

  const showDiff = async (b) => {
    try {
      const r = await fetchApi(`/sw/backups/${b.id}/diff`)
      if (!r.from) {
        toastError(`v${b.version_no} 为初始版本，无可比对的上一版本`)
        return
      }
      setViewer({
        title: `${devName} · diff v${r.from} → v${r.to}（+${r.added} / -${r.removed} 行）`,
        kind: 'diff', body: r.diff,
      })
    } catch (e) { toastError(e.message) }
  }

  const delBackup = async (b) => {
    const ok = await confirmDialog({
      title: '删除备份版本',
      message: `确定删除 ${devName} 的备份 v${b.version_no}${b.status === 'success' ? '（含服务器上的配置文件）' : ''}？此操作不可恢复。`,
      confirmText: '删除',
      danger: true,
      keyword: `v${b.version_no}`,
    })
    if (!ok) return
    try {
      await fetchApi(`/sw/backups/${b.id}`, { method: 'DELETE' })
      toastSuccess(`已删除 v${b.version_no}`)
      loadBackups()
    } catch (e) { toastError('删除失败: ' + e.message) }
  }

  const fmt = (t) => (t || '').substring(0, 19)

  return <>
    <div className="page-header">
      <div>
        <h1>交换机 · 备份</h1>
        <div className="mut" style={{ marginTop: 4 }}>
          版本化备份 · diff 对比 · 下载归档
          <span className="badge badge-warning" style={{ marginLeft: 8 }}>定时任务 v1.1</span>
        </div>
      </div>
    </div>

    <div className="panel">
      <div className="panel-header">
        <h4>备份版本历史 {devName && <span className="badge badge-blue">{devName}</span>}</h4>
        <select value={devId} onChange={e => setDevId(e.target.value)} style={{ minWidth: 200 }}>
          {devices.map(d => <option key={d.id} value={d.id}>{d.name}（{d.mgmt_ip}）</option>)}
        </select>
      </div>
      <div className="panel-body">
        {loading ? <div className="empty"><span className="spinner" /></div>
          : backups.length ? <table>
            <thead><tr>
              <th>版本</th><th>备份时间</th><th>触发方式</th><th>操作人</th>
              <th className="num">大小 / 行数</th><th className="num">与上版差异</th><th>状态</th><th style={{ width: 260 }}>操作</th>
            </tr></thead>
            <tbody>
              {backups.map(b => {
                const [cls, label] = TRIGGER_BADGE[b.trigger_type] || ['badge-default', b.trigger_type]
                return <tr key={b.id}>
                  <td><strong>v{b.version_no}</strong></td>
                  <td>{fmt(b.created_at)}</td>
                  <td><span className={`badge ${cls}`}>{label}</span></td>
                  <td className="mut">{b.operator}</td>
                  <td className="num">{b.status === 'success' ? `${(b.size_bytes / 1024).toFixed(1)} KB / ${Number(b.line_count||0).toLocaleString()} 行` : '—'}</td>
                  <td>{b.diff_added == null ? <span className="mut">—</span> :
                    <span><span className="badge badge-success">+{b.diff_added}</span>{' '}
                      <span className="badge badge-danger">−{b.diff_removed}</span></span>}</td>
                  <td>{b.status === 'success'
                    ? <span className="badge badge-success">成功</span>
                    : <span className="badge badge-danger" title={b.fail_reason}>失败</span>}</td>
                  <td>
                    <ActionMenu actions={[
                      { label: '查看', icon: '▤', disabled: b.status !== 'success', onClick: () => view(b) },
                      { label: 'diff 对比', icon: '⇄', disabled: b.status !== 'success', onClick: () => showDiff(b) },
                      { label: '下载', icon: '⤓', disabled: b.status !== 'success', onClick: () => download(b) },
                      { label: '删除', icon: '🗑', danger: true, onClick: () => delBackup(b) },
                    ]} />
                  </td>
                </tr>
              })}
            </tbody>
          </table> : <div className="empty">{devId ? '该设备暂无备份记录，到「设备管理」执行立即备份' : '请先在「设备管理」添加交换机'}</div>}
      </div>
    </div>

    {viewer && <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setViewer(null) }}>
      <div className="modal-box" style={{ maxWidth: 860, width: '92vw' }}>
        <div className="modal-title">{viewer.title}</div>
        <div style={{ marginTop: 12 }}>
          <pre style={{
            margin: 0, maxHeight: '62vh', overflow: 'auto',
            background: '#0c0c0c', color: '#f4f4f4', borderRadius:0, padding: '14px 18px',
            fontSize: 12, lineHeight: 1.8, fontFamily: 'monospace',
          }}>
            {viewer.kind === 'diff'
              ? viewer.body.split('\n').map((ln, i) => (
                <span key={i} style={{
                  display: 'block',
                  color: ln.startsWith('+++') || ln.startsWith('---') ? '#8b949e'
                    : ln.startsWith('+') ? '#3fb950' : ln.startsWith('-') ? '#f85149' : '#8b949e',
                  background: ln.startsWith('+') && !ln.startsWith('+++') ? '#12261e'
                    : ln.startsWith('-') && !ln.startsWith('---') ? '#2d1517' : 'transparent',
                }}>{ln || ' '}</span>))
              : viewer.body}
          </pre>
        </div>
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={() => setViewer(null)}>关闭</button>
        </div>
      </div>
    </div>}
  </>
}
