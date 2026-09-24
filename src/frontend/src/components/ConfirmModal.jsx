// 危险操作确认对话框（替代原生 confirm）
// 用法：const ok = await confirmDialog({ title:'停止 VPN 服务？', message:'将断开 N 个在线用户', danger:true })
// keyword 模式（极高危）：用户必须输入关键字才能点确认
import { useEffect, useState, useSyncExternalStore } from 'react'

let current = null
const listeners = new Set()
const emit = () => listeners.forEach(l => l())

export function confirmDialog(opts) {
  return new Promise(resolve => {
    current = {
      title: '请确认',
      message: '',
      confirmText: '确认',
      cancelText: '取消',
      danger: false,
      keyword: '',   // 非空时启用"输入关键字确认"
      ...opts,
      resolve,
    }
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

export function ConfirmHost() {
  const dlg = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    if (!dlg) return
    const onKey = e => { if (e.key === 'Escape') close(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dlg])
  if (!dlg) return null
  return <ConfirmBox dlg={dlg} />
}

function ConfirmBox({ dlg }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const keywordOk = !dlg.keyword || typed.trim() === dlg.keyword

  const doConfirm = async () => {
    setBusy(true)
    try { close(true) } finally { setBusy(false) }
  }

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(false) }}>
      <div className="modal-box" style={{ maxWidth: 420 }}>
        <div className="modal-title">{dlg.title}</div>
        {dlg.message && <div className="modal-msg">{dlg.message}</div>}
        {dlg.keyword && (
          <div className="modal-keyword">
            <div className="modal-msg" style={{ marginBottom: 6 }}>
              请输入 <code>{dlg.keyword}</code> 以确认操作：
            </div>
            <input autoFocus value={typed} onChange={e => setTyped(e.target.value)}
              placeholder={dlg.keyword} className="modal-input" />
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={() => close(false)} disabled={busy}>
            {dlg.cancelText}
          </button>
          <button className={`btn ${dlg.danger ? 'btn-danger-solid' : 'btn-primary'}`}
            onClick={doConfirm} disabled={!keywordOk || busy}>
            {dlg.confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
