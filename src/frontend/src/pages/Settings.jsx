import { useState, useEffect } from 'react'
import { tr, setLang } from '../i18n'

/**
 * 设置页 v3 — 主题(浅/深) × 界面风格(Carbon/Ant Design) 两维度选择
 * body classList 组合：dark（暗色）+ style-ant（Ant 风格），均可独立开关。
 * 卡片式选择（OptionCard）解决 .btn 固定高度问题（09:52 报障，v2 起）。
 */

function OptionCard({ icon, label, desc, selected, onClick, preview }) {
  return (
    <div
      onClick={onClick}
      style={{
        width: 112, height: 96, cursor: 'pointer',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5,
        background: 'var(--layer)', borderRadius: 'var(--radius)',
        border: selected ? '1px solid var(--blue)' : '1px solid var(--border-strong)',
        boxShadow: selected ? 'inset 0 0 0 1px var(--blue)' : 'none',
        position: 'relative', flex: '0 0 auto',
      }}
    >
      {selected && (
        <span style={{
          position: 'absolute', top: 6, right: 6, width: 16, height: 16, borderRadius: '50%',
          background: 'var(--blue)', color: '#fff', fontSize: 10, lineHeight: '16px', textAlign: 'center', fontWeight: 700,
        }}>✓</span>
      )}
      {preview && <span style={{ width: 64, height: 6, borderRadius: 3, background: preview }} />}
      <span style={{ fontSize: 22, lineHeight: 1 }}>{icon}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{label}</span>
      {desc && <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{desc}</span>}
    </div>
  )
}

export default function Settings() {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light')
  const [style, setStyleState] = useState(() => localStorage.getItem('uistyle') || 'carbon')
  const [lang, setLangState] = useState(() => localStorage.getItem('lang') || 'zh')

  // 统一应用 body class：[dark] + [style-ant|style-apple]
  const applyBody = (th, st) => {
    if (!document.body) return
    document.body.classList.remove('dark', 'style-ant', 'style-apple')
    if (th === 'dark') document.body.classList.add('dark')
    if (st === 'ant') document.body.classList.add('style-ant')
    if (st === 'apple') document.body.classList.add('style-apple')
  }

  const applyTheme = (th) => { setTheme(th); localStorage.setItem('theme', th); applyBody(th, style) }
  const applyStyle = (st) => { setStyleState(st); localStorage.setItem('uistyle', st); applyBody(theme, st) }
  const applyLang = (l) => { setLangState(l); setLang(l) }

  useEffect(() => { applyBody(theme, style) }, [theme, style])

  return <>
    <div className="page-header"><h1>{tr('settings_title')}</h1></div>

    <div className="panel"><div className="panel-header"><h4>界面风格</h4></div>
    <div className="panel-body">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <OptionCard icon="▤" label="Carbon" desc="IBM 直角 · 冷灰 · 深黑侧栏"
          preview="linear-gradient(90deg,#0f62fe,#525252)"
          selected={style === 'carbon'} onClick={() => applyStyle('carbon')} />
        <OptionCard icon="▢" label="Ant Design" desc="圆角 6 · 亮蓝 · 深蓝侧栏"
          preview="linear-gradient(90deg,#1677ff,#4096ff)"
          selected={style === 'ant'} onClick={() => applyStyle('ant')} />
        <OptionCard icon="◯" label="Apple" desc="大圆角 · 海军蓝 · 浅色侧栏"
          preview="linear-gradient(90deg,#0b3d62,#3a7ca5)"
          selected={style === 'apple'} onClick={() => applyStyle('apple')} />
      </div>
      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>
        三种风格差异：Carbon——直角 + IBM 冷灰 + 深黑侧栏，最克制正式；Ant Design——小圆角 + 亮天蓝 + 暖灰底 + 深蓝黑侧栏，中后台主流；Apple——14px 大圆角 + 深海军蓝 + 冷蓝灰底 + <b>唯一浅色毛玻璃侧栏</b>，衬线标题最轻盈。均支持明/暗主题组合（共 6 种形态）。
      </div>
    </div></div>

    <div className="panel"><div className="panel-header"><h4>{tr('theme')}</h4></div>
    <div className="panel-body">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <OptionCard icon="☀" label={tr('light')} selected={theme === 'light'} onClick={() => applyTheme('light')} />
        <OptionCard icon="🌙" label={tr('dark')} selected={theme === 'dark'} onClick={() => applyTheme('dark')} />
      </div>
    </div></div>

    <div className="panel"><div className="panel-header"><h4>{tr('language')}</h4></div>
    <div className="panel-body">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <OptionCard icon="中" label="中文" selected={lang === 'zh'} onClick={() => applyLang('zh')} />
        <OptionCard icon="EN" label="English" selected={lang === 'en'} onClick={() => applyLang('en')} />
      </div>
    </div></div>

    <div className="panel"><div className="panel-header"><h4>{tr('about')}</h4></div><div className="panel-body" style={{ fontSize: 13, color: 'var(--gray)', lineHeight: 1.7 }}>{tr('about_text')}<br/>FastAPI + React + Vite<br/>{tr('e2e_platform')}</div></div>
  </>
}
