import { useState } from 'react'

/**
 * 可折叠面板：包裹现有 .panel/.panel-header/.panel-body 结构。
 * - 点击标题栏整行切换折叠（输入框/按钮等表单元素内点击不触发，避免误伤筛选栏）
 * - 默认展开（defaultOpen=true）；受控可用 open/onToggle
 * - 折叠时隐藏 panel-body，标题右侧显示 ▸/▾ 指示
 * - 记忆：可传 storageKey 持久化到 localStorage（按页全局共享，不含设备级维度）
 *
 * 用法：
 *   <CollapsePanel title="查询条件" badge={<span className="badge badge-blue">N 条</span>}>
 *     <div className="panel-body">…</div>
 *   </CollapsePanel>
 *   或保留原 panel-header 右侧自定义内容：
 *   <CollapsePanel title="…" extra={<>…筛选控件…</>} storageKey="pg_vpn_visit">…</CollapsePanel>
 */
export default function CollapsePanel({ title, badge = null, extra = null, defaultOpen = true, storageKey = '', open: controlled, onToggle, children, panelStyle }) {
  const [uncontrolled, setUncontrolled] = useState(() => {
    if (storageKey) {
      try { const v = localStorage.getItem('cp_' + storageKey); if (v !== null) return v === '1' } catch {}
    }
    return defaultOpen
  })
  const open = controlled !== undefined ? controlled : uncontrolled
  const toggle = (e) => {
    // 点击交互元素（筛选表单/按钮/链接）时不折叠，避免误触
    if (e && e.target.closest('input,select,button,a,textarea,[data-nocollapse]')) return
    const next = !open
    if (onToggle) onToggle(next)
    if (controlled === undefined) {
      setUncontrolled(next)
      if (storageKey) { try { localStorage.setItem('cp_' + storageKey, next ? '1' : '0') } catch {} }
    }
  }

  return (
    <div className="panel" style={panelStyle}>
      <div className="panel-header" onClick={toggle} style={{cursor:'pointer',userSelect:'none'}} title={open ? '点击折叠' : '点击展开'}>
        <h4 style={{display:'flex',alignItems:'center',gap:6}}>
          <span style={{display:'inline-block',transition:'transform .18s',transform: open ? 'rotate(90deg)' : 'rotate(0deg)',fontSize:10,color:'var(--muted)'}}>▶</span>
          {title}
          {badge}
        </h4>
        <div onClick={e => e.stopPropagation()} style={{display:'flex',alignItems:'center',gap:8}}>
          {extra}
        </div>
      </div>
      {open && children}
    </div>
  )
}
