import { tr } from '../i18n'
import CollapsePanel from '../components/CollapsePanel'
import { QosPanel } from '../components/nac/PolicyPanels'

/** 薄壳：与 /nac 准入与认证中心同源渲染 QosPanel（提取-搬入策略） */
export default function QosPolicy() {
  return <>
    <div className="page-header"><h1>{tr('qos_title')}</h1></div>
    <CollapsePanel title={tr('qos_header')} storageKey="qos_main">
      <QosPanel />
    </CollapsePanel>
  </>
}
