import { useState, useEffect } from 'react'
import { tr } from '../i18n'
import { fetchApi } from '../api'
import { NasPanel, DictPanel, UserReplyPanel, GroupCheckPanel } from '../components/nac/ConfigPanels'

/**
 * 薄壳：与 /nac 准入与认证中心同源渲染四个 Config Panel（提取-搬入策略）。
 * 保留原四 tab 切换交互；每个 Panel 自持数据加载。
 */
export default function RadiusConfig() {
  const [tab, setTab] = useState('nas')

  const tabs = [
    { k: 'nas',   label: 'NAS 设备' },
    { k: 'dict',  label: '属性字典' },
    { k: 'urepl', label: '用户私有属性' },
    { k: 'gchk',  label: '组认证控制' },
  ]

  return <>
    <div className="page-header"><h1>RADIUS 配置</h1></div>
    <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
      {tabs.map(tb => <button key={tb.k} className={`btn ${tab === tb.k ? 'btn-primary' : 'btn-outline'}`} onClick={() => setTab(tb.k)}>{tb.label}</button>)}
    </div>

    <div className="panel"><div className="panel-header"><h4>{tabs.find(x => x.k === tab).label}</h4></div>
      {tab === 'nas' && <NasPanel />}
      {tab === 'dict' && <DictPanel />}
      {tab === 'urepl' && <UserReplyPanel />}
      {tab === 'gchk' && <GroupCheckPanel />}
    </div>
  </>
}
