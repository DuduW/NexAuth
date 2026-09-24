import { tr } from '../i18n'
import CollapsePanel from '../components/CollapsePanel'
import { MacPassPanel } from '../components/nac/PolicyPanels'

/** 薄壳：与 /nac 准入与认证中心同源渲染 MacPassPanel（提取-搬入策略） */
export default function MacBypass() {
  return <>
    <div className="page-header"><h1>{tr('macpass_title')}</h1></div>
    <CollapsePanel title={tr('macpass_title')} storageKey="macbypass_main">
      <MacPassPanel />
    </CollapsePanel>
  </>
}
