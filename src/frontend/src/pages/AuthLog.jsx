import { tr } from '../i18n'
import CollapsePanel from '../components/CollapsePanel'
import { AuthLogPanel } from '../components/nac/MonitorPanels'

/** 薄壳：与 /nac 准入与认证中心同源渲染 AuthLogPanel（提取-搬入策略） */
export default function AuthLog() {
  return <>
    <div className="page-header"><h1>{tr('authlog_title')}</h1></div>
    <CollapsePanel title={tr('recent_records')} storageKey="authlog_main">
      <AuthLogPanel />
    </CollapsePanel>
  </>
}
