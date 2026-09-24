// 批量导入对话框（三步：上传 → 预览 → 结果）— PRD: docs/PRD-IP资产管理.md §3.8/§6.5
// 用法：const r = await openImport({ kind: 'address', title: '批量导入 · 地址台账' })
// kind ∈ subnet|address|nat；resolve(import 结果对象) 或取消 resolve(null)
import { useEffect, useState, useSyncExternalStore } from 'react'
import { fetchApi } from '../api'

let current = null
const listeners = new Set()
const emit = () => listeners.forEach(l => l())

export function openImport(opts) {
  return new Promise(resolve => {
    current = { kind: 'address', title: '批量导入', ...opts, resolve }
    emit()
  })
}

function close(result) {
  const dlg = current
  current = null
  emit()
  dlg && dlg.resolve(result)
}

function subscribe(l) { listeners.add(l); return () => listeners.delete(l) }
const getSnapshot = () => current

export function ImportHost() {
  const dlg = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    if (!dlg) return
    const onKey = e => { if (e.key === 'Escape' && dlg.step !== 'commit') close(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dlg])
  if (!dlg) return null
  return <ImportBox dlg={dlg} />
}

function ImportBox({ dlg }) {
  const [step, setStep] = useState('upload')       // upload / preview / result
  const [file, setFile] = useState(null)
  const [mode, setMode] = useState('skip')
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const KIND_NAME = { subnet: '网段', address: '地址台账', nat: 'NAT 映射' }

  const doPreview = async f => {
    setBusy(true); setErr('')
    try {
      const fd = new FormData()
      fd.append('file', f)
      const r = await fetchApi(`/ip/import/preview?kind=${dlg.kind}`, { method: 'POST', body: fd })
      setPreview(r); setFile(f); setStep('preview')
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  const doCommit = async () => {
    setBusy(true); setErr('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetchApi(`/ip/import/commit?kind=${dlg.kind}&mode=${mode}`,
        { method: 'POST', body: fd })
      setResult(r); setStep('result')
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  const doFinish = () => {
    const r = result
    close(r)
  }

  const reset = () => { setStep('upload'); setFile(null); setPreview(null); setResult(null); setErr('') }

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget && step !== 'commit') close(null) }}>
      <div className="modal-box" style={{ maxWidth: 720 }}>
        <div className="modal-title">{dlg.title} <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>
          {step === 'upload' && '第 ① 步：上传文件'}
          {step === 'preview' && `第 ② 步：校验预览（共 ${preview?.total} 行）`}
          {step === 'result' && '第 ③ 步：导入结果'}
        </span></div>

        {err && <div style={{ background: 'var(--err-bg)', color: 'var(--red)', borderRadius:0, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}>{err}</div>}

        {step === 'upload' && (
          <div>
            <div style={{ border: '1px dashed var(--border-strong)', borderRadius:0, padding: '28px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              <input type="file" accept=".xlsx,.xlsm,.csv" id="ip-import-file" style={{ display: 'none' }}
                onChange={e => e.target.files[0] && doPreview(e.target.files[0])} />
              <div style={{ fontSize: 26, marginBottom: 6 }}>⬆</div>
              拖拽或点击选择 .xlsx / .csv 文件（≤10MB · ≤2 万行）
              <div style={{ marginTop: 12 }}>
                <button className="btn btn-sm btn-outline" disabled={busy}
                  onClick={() => { window.location.href = `/api/ip/import/template?kind=${dlg.kind}` }}>
                  下载{KIND_NAME[dlg.kind]}模板
                </button>
              </div>
            </div>
            {busy && <div className="mut" style={{ marginTop: 8 }}>解析校验中...</div>}
          </div>
        )}

        {step === 'preview' && preview && (
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <span className="badge badge-success">🟢 新增 {preview.counts.insert}</span>
              <span className="badge badge-warning">🟡 更新 {preview.counts.update}</span>
              <span className="badge badge-danger">🔴 错误 {preview.counts.error}</span>
              <span style={{ flex: 1 }} />
              <button className="btn btn-sm btn-outline" onClick={reset}>重新上传</button>
            </div>
            {preview.preview.length > 0 && (
              <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--line)', borderRadius:0 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr>
                    <th style={{ textAlign: 'left', padding: '6px 10px', background: 'var(--bg-light)' }}>行号</th>
                    <th style={{ textAlign: 'left', padding: '6px 10px', background: 'var(--bg-light)' }}>预览</th>
                    <th style={{ textAlign: 'left', padding: '6px 10px', background: 'var(--bg-light)' }}>结果</th>
                  </tr></thead>
                  <tbody>
                    {preview.preview.map(p => (
                      <tr key={p.row}>
                        <td style={{ padding: '5px 10px', borderBottom: '1px solid #f0f2f6' }}>{p.row}</td>
                        <td style={{ padding: '5px 10px', borderBottom: '1px solid #f0f2f6' }}>
                          {Object.entries(p.display).map(([k, v]) => v ? <span key={k} style={{ marginRight: 8 }}>{k}: {String(v)}</span> : null)}
                        </td>
                        <td style={{ padding: '5px 10px', borderBottom: '1px solid #f0f2f6' }}>
                          <span className={`badge ${p.color === 'insert' ? 'badge-success' : 'badge-warning'}`}>
                            {p.color === 'insert' ? '新增' : '更新'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.errors.length > 0 && (
              <div style={{ marginTop: 8, maxHeight: 120, overflow: 'auto', background: 'var(--err-bg)', borderRadius:0, padding: '8px 12px', fontSize: 12, color: 'var(--red)' }}>
                {preview.errors.slice(0, 50).map((e, i) => <div key={i}>第 {e.row} 行：{e.reason}</div>)}
                {preview.errors.length > 50 && <div>... 共 {preview.error_total} 个错误</div>}
              </div>
            )}
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span className="mut">冲突处理：</span>
              {[['skip', '跳过冲突（默认）'], ['overwrite', '覆盖更新'], ['strict', '严格模式（有错误全部不入库）']].map(([v, t]) => (
                <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                  <input type="radio" name="import-mode" checked={mode === v} onChange={() => setMode(v)} />{t}
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={reset} disabled={busy}>← 上一步</button>
              <button className="btn btn-primary" onClick={doCommit} disabled={busy || (mode === 'strict' && preview.counts.error > 0)}>
                {busy ? '导入中...' : `确认导入（${preview.counts.insert} 新增 + ${preview.counts.update} 更新）`}
              </button>
            </div>
          </div>
        )}

        {step === 'result' && result && (
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <span className="badge badge-success">成功 {result.inserted}</span>
              <span className="badge badge-warning">更新 {result.updated}</span>
              <span className="badge badge-danger">失败 {result.failed}</span>
              <span className="mut" style={{ alignSelf: 'center' }}>共 {result.total} 行</span>
            </div>
            {result.errors.length > 0 && (
              <div style={{ maxHeight: 180, overflow: 'auto', background: 'var(--err-bg)', borderRadius:0, padding: '8px 12px', fontSize: 12, color: 'var(--red)' }}>
                {result.errors.slice(0, 50).map((e, i) => <div key={i}>第 {e.row} 行：{e.reason}</div>)}
                {result.errors.length > 50 && <div>... 共 {result.errors.length} 个错误</div>}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={doFinish}>完成</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
