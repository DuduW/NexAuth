import CollapsePanel from '../components/CollapsePanel'
import { ProfilesPanel } from '../components/nac/PolicyPanels'

/** 薄壳：与 /nac 准入与认证中心同源渲染 ProfilesPanel（提取-搬入策略） */
export default function UserProfiles() {
  return <>
    <div className="page-header"><h1>用户 Profile</h1></div>
    <CollapsePanel title="用户 Profile · 策略模板" storageKey="profiles_main" defaultOpen={false}>
      <ProfilesPanel />
    </CollapsePanel>
  </>
}
