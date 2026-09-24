import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchApi } from '../api'
import { toastError } from '../components/Toast'
import TopoPanel from '../components/nac/TopoPanel'

/**
 * 准入与认证中心 · 链路拓扑（/nac/topo）
 * 节点数字实时取 /api/nac/overview；点击节点跳对应子模块。
 */
export default function NacTopo() {
  const [ov, setOv] = useState(null)
  const navigate = useNavigate()

  const loadOverview = useCallback(() => {
    fetchApi('/nac/overview').then(setOv).catch(e => toastError(e.message))
  }, [])
  useEffect(loadOverview, [loadOverview])

  // TopoPanel 的 go(l1, l2) 签名保持兼容 → 映射到四页 + ?tab=
  const go = (l1, l2) => navigate(`/nac/${l1}?tab=${l2}`)

  return <>
    <div className="page-header"><h1>链路拓扑</h1>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        准入与认证中心 · 认证链路总览 · 数字实时 · 点击节点跳转管理模块
      </div>
    </div>
    <div style={{ border: '1px solid var(--border)', background: 'var(--card, #fff)', minHeight: 300 }}>
      <TopoPanel overview={ov} go={go} />
    </div>
  </>
}
