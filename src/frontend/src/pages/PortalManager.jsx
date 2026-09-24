import CollapsePanel from '../components/CollapsePanel'
import { PortalPanel } from '../components/nac/ServicePanels'

/** 薄壳：与 /nac 准入与认证中心同源渲染 PortalPanel（提取-搬入策略） */
export default function PortalManager() {
  return <>
    <div className="page-header"><h1>Portal 认证服务</h1></div>
    <CollapsePanel title="Portal 服务状态与控制" storageKey="portal_main">
      <PortalPanel />
    </CollapsePanel>
  </>
}
