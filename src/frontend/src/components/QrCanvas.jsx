// 本地二维码组件（qrious.min.js 从 public/ 加载，密钥不出网）
// 替代 api.qrserver.com 第三方二维码服务
import { useEffect, useRef, useState } from 'react'

let loadPromise = null
function loadQRious() {
  if (typeof window !== 'undefined' && window.QRious) return Promise.resolve()
  if (!loadPromise) {
    loadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = (import.meta.env.BASE_URL || '/') + 'qrious.min.js'
      s.onload = () => resolve()
      s.onerror = () => reject(new Error('QR library load failed'))
      document.head.appendChild(s)
    })
  }
  return loadPromise
}

export default function QrCanvas({ value, size = 200, style }) {
  const ref = useRef(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let dead = false
    loadQRious()
      .then(() => {
        if (dead || !ref.current || !window.QRious) return
        // eslint-disable-next-line no-new
        new window.QRious({ element: ref.current, value, size, level: 'M' })
      })
      .catch(() => { if (!dead) setFailed(true) })
    return () => { dead = true }
  }, [value, size])

  if (failed) {
    return (
      <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--border)', borderRadius:0, fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: 12 }}>
        二维码生成失败<br />请手动输入下方密钥
      </div>
    )
  }
  return <canvas ref={ref} width={size} height={size} style={{ background: '#fff', ...style }} />
}
