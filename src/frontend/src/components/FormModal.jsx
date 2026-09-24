// 表单对话框（替代原生 prompt）
// 用法：const vals = await formDialog({
//   title: '修改密码',
//   fields: [
//     { name:'password', label:'新密码', type:'password', required:true,
//       validate: v => v.length < 6 ? '密码至少 6 位' : null },
//   ],
//   submitText: '确认修改',
// })
// 返回 { field: value }，取消返回 null
import { useEffect, useState, useSyncExternalStore } from 'react'

let current = null
const listeners = new Set()
const emit = () => listeners.forEach(l => l())

export function formDialog(opts) {
  return new Promise(resolve => {
    current = {
      title: '',
      fields: [],
      submitText: '提交',
      cancelText: '取消',
      danger: false,
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

export function FormHost() {
  const dlg = useSyncExternalStore(subscribe, getSnapshot)
  useEffect(() => {
    if (!dlg) return
    const onKey = e => { if (e.key === 'Escape') close(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dlg])
  if (!dlg) return null
  return <FormBox dlg={dlg} />
}

function FormBox({ dlg }) {
  const [values, setValues] = useState(() => {
    const v = {}
    dlg.fields.forEach(f => { v[f.name] = f.initial ?? '' })
    return v
  })
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(false)

  const set = (name, val) => {
    setValues(s => ({ ...s, [name]: val }))
    setErrors(e => ({ ...e, [name]: null }))
  }

  const submit = async (e) => {
    e.preventDefault()
    const errs = {}
    for (const f of dlg.fields) {
      const val = (values[f.name] ?? '').toString().trim()
      if (f.required && !val) { errs[f.name] = '必填项'; continue }
      if (f.validate && val) {
        const err = f.validate(val, values)
        if (err) errs[f.name] = err
      }
    }
    if (Object.keys(errs).length) { setErrors(errs); return }
    setBusy(true)
    close({ ...values })
  }

  const autofocusName = (dlg.fields.find(f => f.autoFocus) || dlg.fields[0] || {}).name

  return (
    <div className="modal-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(null) }}>
      <form className="modal-box" style={{ maxWidth: 440 }} onSubmit={submit}>
        <div className="modal-title">{dlg.title}</div>
        {dlg.message && <div className="modal-msg">{dlg.message}</div>}
        <div className="modal-fields">
          {dlg.fields.map(f => (
            <label key={f.name} className="modal-field">
              <span className="modal-field-label">
                {f.label}{f.required && <em style={{ color: 'var(--red)', marginLeft: 3, fontStyle: 'normal' }}>*</em>}
              </span>
              {f.type === 'select' ? (
                <select className="modal-input" value={values[f.name]} onChange={e => set(f.name, e.target.value)} autoFocus={f.name === autofocusName}>
                  {(f.options || []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.type === 'checks' ? (
                <div>
                  {f.quickSelects && f.quickSelects.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                      {f.quickSelects.map(q => (
                        <button key={q.label} type="button" style={{ border: '1px solid var(--border)',
                          background: 'var(--bg-light)', borderRadius:0, padding: '2px 8px', fontSize: 12,
                          cursor: 'pointer', color: 'var(--blue)' }}
                          onClick={() => set(f.name, q.values)}>{q.label}</button>
                      ))}
                      <button type="button" style={{ border: '1px solid var(--border)', background: 'var(--bg-light)',
                        borderRadius:0, padding: '2px 8px', fontSize: 12, cursor: 'pointer', color: 'var(--gray)' }}
                        onClick={() => set(f.name, [])}>清空</button>
                    </div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {(f.options || []).map(o => {
                      const arr = values[f.name] || []
                      const on = arr.includes(o.value)
                      return (
                        <label key={o.value} style={{ display: 'flex', alignItems: 'center', gap: 4,
                          fontSize: 12, cursor: 'pointer', border: `1px solid ${on ? 'var(--blue)' : 'var(--border)'}`,
                          borderRadius:0, padding: '4px 8px', background: on ? 'var(--info-bg)' : '#fff', color: 'var(--dark)' }}>
                          <input type="checkbox" checked={on}
                            onChange={e => set(f.name, e.target.checked ? [...arr, o.value] : arr.filter(x => x !== o.value))} />
                          {o.label}
                        </label>
                      )
                    })}
                  </div>
                </div>
              ) : f.type === 'textarea' ? (
                <textarea className="modal-input" rows={f.rows || 3} value={values[f.name]}
                  onChange={e => set(f.name, e.target.value)} placeholder={f.placeholder || ''} autoFocus={f.name === autofocusName} />
              ) : (
                <input className="modal-input" type={f.type || 'text'} value={values[f.name]}
                  onChange={e => set(f.name, e.target.value)} placeholder={f.placeholder || ''}
                  autoFocus={f.name === autofocusName} maxLength={f.maxLength} />
              )}
              {(f.liveHint || f.hint) && !errors[f.name] && (
                <span className="modal-field-hint" style={f.liveHintColor ? { color: f.liveHintColor } : undefined}>
                  {f.liveHint ? f.liveHint(values) : f.hint}
                </span>
              )}
              {errors[f.name] && <span className="modal-field-error">{errors[f.name]}</span>}
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={() => close(null)} disabled={busy}>
            {dlg.cancelText}
          </button>
          <button type="submit" className={`btn ${dlg.danger ? 'btn-danger-solid' : 'btn-primary'}`} disabled={busy}>
            {busy ? '提交中...' : dlg.submitText}
          </button>
        </div>
      </form>
    </div>
  )
}
