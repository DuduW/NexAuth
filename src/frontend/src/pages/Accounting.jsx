import { tr } from '../i18n'
import CollapsePanel from '../components/CollapsePanel'
import { AcctPanel } from '../components/nac/MonitorPanels'

/** 薄壳：与 /nac 准入与认证中心同源渲染 AcctPanel（提取-搬入策略） */
export default function Accounting() {
  return <>
    <div className="page-header"><h1>{tr('accounting_title')}</h1></div>
    <CollapsePanel title={tr('query_condition')} storageKey="acct_cond">
      <AcctPanel />
    </CollapsePanel>
  </>
}
