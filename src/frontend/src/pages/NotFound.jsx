// 404 专属页面 — 未匹配路由展示（P2-4）
import { useNavigate } from 'react-router-dom'

export default function NotFound() {
  const nav = useNavigate()
  return (
    <div className="panel" style={{ maxWidth: 560, margin: '80px auto', textAlign: 'center', padding: '56px 40px' }}>
      <div style={{ fontSize: 64, fontWeight: 900, color: 'var(--blue)', fontFamily: 'serif', lineHeight: 1 }}>404</div>
      <h2 style={{ margin: '18px 0 8px', fontSize: 18, color: 'var(--dark)' }}>页面不存在</h2>
      <p style={{ color: 'var(--muted)', fontSize: 13, margin: 0 }}>
        您访问的地址不存在或已被移除，请检查链接或返回首页。
      </p>
      <button
        className="btn btn-primary"
        style={{ marginTop: 24 }}
        onClick={() => nav('/')}
      >
        返回首页
      </button>
    </div>
  )
}
