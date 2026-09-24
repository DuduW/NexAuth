import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// 启动时恢复持久化的外观：主题(light/dark) × 风格(carbon/ant/apple)
// body class：dark（暗色）+ style-ant/style-apple（风格层），可组合
if (document.body) {
  if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark')
  const st = localStorage.getItem('uistyle')
  if (st === 'ant') document.body.classList.add('style-ant')
  if (st === 'apple') document.body.classList.add('style-apple')
}

createRoot(document.getElementById('root')).render(<App />)
