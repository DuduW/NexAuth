import { tr } from '../i18n'
import CollapsePanel from '../components/CollapsePanel'
import { OnlinePanel } from '../components/nac/MonitorPanels'

/** 薄壳：与 /nac 准入与认证中心同源渲染 OnlinePanel（提取-搬入策略） */
export default function Online() {
  return <>
    <div className="page-header"><h1>{tr('online_title')}</h1></div>
    <CollapsePanel title={tr('realtime_online')} storageKey="online_main">
      <OnlinePanel />
    </CollapsePanel>
  </>
}
