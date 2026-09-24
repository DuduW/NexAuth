import { useSearchParams } from 'react-router-dom'
import NacSubTabs from '../components/nac/NacSubTabs'
import { MacPassPanel, ProfilesPanel, QosPanel } from '../components/nac/PolicyPanels'

/**
 * 准入与认证中心 · 准入策略（/nac/policy）
 * 子页签：MAC 免认证 / Profile / RADIUS 参数
 */
const TABS = [
  { key: 'macpass',  label: 'MAC 免认证' },
  { key: 'profiles', label: 'Profile' },
  { key: 'qos',      label: 'RADIUS 参数' },
]

export default function NacPolicy() {
  const [sp, setSp] = useSearchParams()
  const tab = TABS.some(t => t.key === sp.get('tab')) ? sp.get('tab') : 'macpass'
  const setTab = (k) => setSp(prev => { const n = new URLSearchParams(prev); n.set('tab', k); return n })

  return <>
    <div className="page-header"><h1>准入策略</h1>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        准入与认证中心 · MAC 免认证 / Profile 策略模板 / RADIUS 组参数
      </div>
    </div>
    <NacSubTabs tabs={TABS} tab={tab} onChange={setTab} />
    <div style={{ border: '1px solid var(--border-strong)', borderTop: 'none', background: 'var(--card, #fff)', minHeight: 300, padding: 0 }}>
      {tab === 'macpass' && <MacPassPanel />}
      {tab === 'profiles' && <ProfilesPanel />}
      {tab === 'qos' && <QosPanel />}
    </div>
  </>
}
