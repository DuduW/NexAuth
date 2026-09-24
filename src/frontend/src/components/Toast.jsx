// 全局 Toast 反馈组件（替代原生 alert）
// 用法：import { toastSuccess, toastError } from '../components/Toast'
//   toastSuccess('已保存')     —— 绿色，2.6s 自动消失
//   toastError('网络错误')     —— 红色，常驻，点击关闭
import { useSyncExternalStore } from 'react'

let items = []
let nextId = 1
const listeners = new Set()
const emit = () => listeners.forEach(l => l())

export function toast(message, type = 'success', duration = 2600) {
  const id = nextId++
  items = [...items, { id, message, type }]
  emit()
  if (type !== 'error') setTimeout(() => dismissToast(id), duration)
  return id
}

export const toastSuccess = (m) => toast(m, 'success')
export const toastError = (m) => toast(m, 'error')
export const toastInfo = (m) => toast(m, 'info', 3400)

export function dismissToast(id) {
  items = items.filter(t => t.id !== id)
  emit()
}

function subscribe(l) { listeners.add(l); return () => listeners.delete(l) }
const getSnapshot = () => items

export function ToastHost() {
  const list = useSyncExternalStore(subscribe, getSnapshot)
  if (!list.length) return null
  return (
    <div className="toast-host">
      {list.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`} onClick={() => dismissToast(t.id)}>
          <span className="toast-icon">
            {t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : 'ℹ'}
          </span>
          <span className="toast-msg">{t.message}</span>
        </div>
      ))}
    </div>
  )
}
