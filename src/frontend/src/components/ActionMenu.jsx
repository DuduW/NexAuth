import { useState, useRef, useEffect } from 'react'

/**
 * 表格行操作下拉菜单（v1 2026-09-24）
 * 替代操作列的并排按钮：触发器 "⋯"，点击展开菜单，点击外部/Esc 关闭。
 * 用法：<ActionMenu actions={[{label:'编辑', icon:'✎', onClick:fn}, {label:'删除', icon:'🗑', danger:true, disabled:bool}]} />
 */
export default function ActionMenu({ actions, label = '操作' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const valid = (actions || []).filter(a => a && !a.hidden)
  if (!valid.length) return <span className="mut" style={{ fontSize: 12 }}>—</span>

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className="btn btn-outline btn-sm"
        title={label}
        onClick={() => setOpen(o => !o)}
        style={{ minWidth: 30, width: 30, padding: 0, justifyContent: 'center', gap: 0 }}
      >
        {open ? '✕' : '⋯'}
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 300,
          minWidth: 132, background: 'var(--layer)', border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius)', boxShadow: '0 4px 16px rgba(0,0,0,.18)',
          overflow: 'hidden', textAlign: 'left',
        }}>
          {valid.map((a, i) => (
            <button
              key={i}
              disabled={a.disabled}
              onClick={() => { setOpen(false); a.onClick && a.onClick() }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '8px 14px', border: 'none', cursor: a.disabled ? 'not-allowed' : 'pointer',
                background: 'transparent', fontSize: 13, textAlign: 'left', whiteSpace: 'nowrap',
                color: a.disabled ? 'var(--muted)' : a.danger ? 'var(--red)' : 'var(--text)',
                fontFamily: 'var(--font-sans)',
              }}
              onMouseEnter={e => { if (!a.disabled) e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              {a.icon && <span style={{ fontSize: 12, width: 14, display: 'inline-block' }}>{a.icon}</span>}
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
