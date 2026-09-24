/**
 * 准入与认证中心 — L2 子页签条（四个独立页面共用）
 * 配合 useSearchParams 实现 ?tab=xxx 深链定位。
 */
export default function NacSubTabs({ tabs, tab, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'var(--card, #fff)', border: '1px solid var(--border)', padding: '8px 12px 0', overflowX: 'auto' }}>
      {tabs.map(s => (
        <button key={s.key} onClick={() => onChange(s.key)}
                style={{
                  padding: '7px 14px', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
                  fontFamily: 'inherit',
                  color: tab === s.key ? 'var(--blue)' : 'var(--muted)',
                  fontWeight: tab === s.key ? 600 : 400,
                  background: tab === s.key ? 'var(--card, #fff)' : 'var(--bg-light, #f4f4f4)',
                  border: `1px solid ${tab === s.key ? 'var(--border-strong)' : 'var(--border)'}`,
                  borderBottom: 'none',
                  boxShadow: tab === s.key ? '0 1px 0 var(--card, #fff)' : 'none',
                }}>
          {s.label}
        </button>
      ))}
    </div>
  )
}
