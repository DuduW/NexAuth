import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import NacSubTabs from '../components/nac/NacSubTabs'
import { OnlinePanel, AuthLogPanel, AcctPanel } from '../components/nac/MonitorPanels'

/**
 * 准入与认证中心 · 运行监控（/nac/monitor）
 * 子页签：在线会话 / 认证日志 / 记账查询；?tab= 深链定位
 */
const TABS = [
  { key: 'online',  label: '在线会话' },
  { key: 'authlog', label: '认证日志' },
  { key: 'acct',    label: '记账查询' },
]

export default function NacMonitor() {
  const [sp, setSp] = useSearchParams()
  const tab = TABS.some(t => t.key === sp.get('tab')) ? sp.get('tab') : 'online'
  const [quick, setQuick] = useState('')

  const setTab = (k) => setSp(prev => { const n = new URLSearchParams(prev); n.set('tab', k); return n })

  const quickJump = (target) => {
    if (!quick.trim()) return
    try { sessionStorage.setItem('nac_quick', quick.trim()) } catch {}
    setTab(target)
  }

  return <>
    <div className="page-header"><h1>运行监控</h1>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        准入与认证中心 · 在线会话 / 认证日志 / 记账查询
      </div>
    </div>

    {/* 快捷排障（仅监控页提供，跨页签搜索入口） */}
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-body" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: 13 }}>快捷排障</b>
        <input placeholder="输入用户名 / MAC / IP，回车跳认证日志"
               value={quick} onChange={e => setQuick(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') quickJump('authlog') }}
               style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 0, fontSize: 13, width: 300, fontFamily: 'var(--font-mono, monospace)' }} />
        <button className="btn btn-primary btn-sm" onClick={() => quickJump('authlog')}>→ 认证日志</button>
        <button className="btn btn-outline btn-sm" onClick={() => quickJump('online')}>→ 在线会话</button>
        <button className="btn btn-outline btn-sm" onClick={() => quickJump('acct')}>→ 记账查询</button>
      </div>
    </div>

    <NacSubTabs tabs={TABS} tab={tab} onChange={setTab} />
    <div style={{ border: '1px solid var(--border-strong)', borderTop: 'none', background: 'var(--card, #fff)', minHeight: 300, padding: 0 }}>
      {tab === 'online' && <OnlinePanel />}
      {tab === 'authlog' && <AuthLogPanel />}
      {tab === 'acct' && <AcctPanel />}
    </div>
  </>
}
