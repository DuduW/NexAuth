import { useSearchParams } from 'react-router-dom'
import NacSubTabs from '../components/nac/NacSubTabs'
import { NasPanel, DictPanel, UserReplyPanel, GroupCheckPanel } from '../components/nac/ConfigPanels'
import { PortalPanel, CertsPanel } from '../components/nac/ServicePanels'

/**
 * 准入与认证中心 · 服务配置（/nac/config）
 * 子页签：NAS / 属性字典 / 私有属性 / 组控制 / Portal / 证书
 */
const TABS = [
  { key: 'nas',    label: 'NAS 设备' },
  { key: 'dict',   label: '属性字典' },
  { key: 'urepl',  label: '私有属性' },
  { key: 'gchk',   label: '组控制' },
  { key: 'portal', label: 'Portal' },
  { key: 'certs',  label: '证书' },
]

export default function NacConfig() {
  const [sp, setSp] = useSearchParams()
  const tab = TABS.some(t => t.key === sp.get('tab')) ? sp.get('tab') : 'nas'
  const setTab = (k) => setSp(prev => { const n = new URLSearchParams(prev); n.set('tab', k); return n })

  return <>
    <div className="page-header"><h1>服务配置</h1>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        准入与认证中心 · NAS / 字典 / 属性下发 / Portal / 证书
      </div>
    </div>
    <NacSubTabs tabs={TABS} tab={tab} onChange={setTab} />
    <div style={{ border: '1px solid var(--border-strong)', borderTop: 'none', background: 'var(--card, #fff)', minHeight: 300, padding: 0 }}>
      {tab === 'nas' && <NasPanel />}
      {tab === 'dict' && <DictPanel />}
      {tab === 'urepl' && <UserReplyPanel />}
      {tab === 'gchk' && <GroupCheckPanel />}
      {tab === 'portal' && <PortalPanel />}
      {tab === 'certs' && <CertsPanel />}
    </div>
  </>
}
