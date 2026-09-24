import CollapsePanel from '../components/CollapsePanel'
import { CertsPanel } from '../components/nac/ServicePanels'

/** 薄壳：与 /nac 准入与认证中心同源渲染 CertsPanel（提取-搬入策略） */
export default function CertManager() {
  return <>
    <div className="page-header">
      <h1>证书管理</h1>
      <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--muted)' }}>
        为员工签发 EAP-TLS / VPN 客户端证书。CA 私钥仅在签名瞬间加载，不持久化。
      </span>
    </div>
    <CollapsePanel title="证书签发与台账" storageKey="certs_main">
      <CertsPanel />
    </CollapsePanel>
  </>
}
