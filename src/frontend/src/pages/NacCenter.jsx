import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/**
 * /nac 重定向 → /nac/monitor
 * 兼容旧单页版 hash 收藏：/nac#/policy/profiles → /nac/policy?tab=profiles
 */
export default function NacCenter() {
  const navigate = useNavigate()
  useEffect(() => {
    const h = (location.hash || '').replace(/^#\/?/, '')
    const [a, b] = h.split('/')
    const map = { monitor: 'monitor', policy: 'policy', config: 'config', topo: 'topo' }
    const l1 = map[a]
    if (l1) {
      navigate(`/nac/${l1}${b ? `?tab=${b}` : ''}`, { replace: true })
    } else {
      navigate('/nac/monitor', { replace: true })
    }
  }, [navigate])
  return <div className="panel"><div className="panel-body"><div className="empty">跳转中…</div></div></div>
}
