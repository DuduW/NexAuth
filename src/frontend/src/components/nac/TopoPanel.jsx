import { tr } from '../../i18n'

/**
 * 准入与认证中心（/nac）— S5 链路拓扑 Panel
 * SVG 绘制认证链路：终端 → NAS（AC/S57 交换机）→ FreeRADIUS（106）→ MySQL / Portal
 * 节点数字实时取自 /api/nac/overview；点击节点跳转对应子模块。
 */

export default function TopoPanel({ overview, go }) {
  const ov = overview || {}
  const online = ov.online_count ?? '…'
  const nasTotal = ov.nas?.total ?? '…'
  const authOk = ov.auth_24h?.ok ?? '…'
  const authFail = ov.auth_24h?.fail ?? '…'
  const macBypass = ov.mac_bypass_active ?? '…'
  const profiles = ov.profiles_active ?? '…'

  // 节点定义：坐标 + 点击跳转
  const node = (x, y, w, h, title, sub, badge, badgeColor, onClick, dim) => (
    <g onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <rect x={x} y={y} width={w} height={h} rx={2}
        fill="var(--card, #fff)" stroke={dim ? 'var(--border)' : 'var(--blue)'} strokeWidth={dim ? 1 : 1.5} />
      <text x={x + w / 2} y={y + 22} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--text, #161616)">{title}</text>
      {sub && <text x={x + w / 2} y={y + 40} textAnchor="middle" fontSize={10.5} fill="var(--muted, #525252)">{sub}</text>}
      {badge && <text x={x + w - 8} y={y + 18} textAnchor="end" fontSize={15} fontWeight={700}
        fill={badgeColor || 'var(--blue, #0f62fe)'} fontFamily="var(--font-mono, monospace)">{badge}</text>}
    </g>
  )

  const arrow = (x1, y1, x2, y2, label, dashed) => (
    <g>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--border-strong, #8d8d8d)" strokeWidth={1.2}
        strokeDasharray={dashed ? '4 3' : undefined} markerEnd="url(#arrowhead)" />
      {label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" fontSize={10} fill="var(--muted, #525252)">{label}</text>}
    </g>
  )

  return (
    <div className="panel-body" style={{ padding: 20 }}>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
        认证链路总览 · 数字来自 <code>/api/nac/overview</code> 实时聚合 · 点击节点跳转对应管理模块
      </div>

      <svg viewBox="0 0 900 480" style={{ width: '100%', maxWidth: 1000, display: 'block' }}>
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="var(--border-strong, #8d8d8d)" />
          </marker>
        </defs>

        {/* 第一层：终端 */}
        {node(20, 40, 170, 64, '无线终端', `SSID test011 / test022`, `${online} 在线`, 'var(--green)', () => go('monitor', 'online'))}
        {node(20, 150, 170, 64, '有线终端', 'S57 接入 · Portal 推送', '', null, () => go('monitor', 'online'))}
        {node(20, 260, 170, 64, 'MAC 旁路设备', '打印机 / IoT 免认证', `${macBypass} 生效`, 'var(--green)', () => go('policy', 'macpass'))}

        {/* 第二层：NAS 设备 */}
        {node(280, 95, 180, 74, 'AC6003 无线控制器', '192.168.30.15 · EAP-TLS', '', null, () => go('config', 'nas'))}
        {node(280, 225, 180, 74, 'S57 接入交换机', 'Portal + MAC 旁路', `${nasTotal} 台 NAS`, null, () => go('config', 'nas'))}

        {/* 第三层：FreeRADIUS 服务器（单节点 106）+ 服务端口徽章 */}
        {node(550, 110, 200, 74, 'FreeRADIUS .106', '192.168.110.106 · EAP-TLS', '', null, () => go('config', 'nas'))}
        {/* 端口徽章：节点正下方竖排，点击无跳转，悬浮显示说明 */}
        <g>
          <rect x={615} y={196} width={70} height={17} rx={2} fill="var(--blue, #0f62fe)" />
          <text x={650} y={208.5} textAnchor="middle" fontSize={10} fontWeight={600} fill="#fff" fontFamily="var(--font-mono, monospace)">:1812 认证</text>
          <rect x={615} y={217} width={70} height={17} rx={2} fill="var(--blue, #0f62fe)" />
          <text x={650} y={229.5} textAnchor="middle" fontSize={10} fontWeight={600} fill="#fff" fontFamily="var(--font-mono, monospace)">:1813 记账</text>
          <rect x={615} y={238} width={70} height={17} rx={2} fill="var(--border-strong, #8d8d8d)" />
          <text x={650} y={250.5} textAnchor="middle" fontSize={10} fontWeight={600} fill="#fff" fontFamily="var(--font-mono, monospace)">:3799 CoA</text>
          <title>FreeRADIUS 服务端口（UDP）：
:1812 认证 — NAS 发送 Access-Request（EAP-TLS/PAP/MAC）
:1813 记账 — Acct Start/Interim/Stop，写入在线会话与流量
:3799 CoA — 动态授权变更/强制下线（Disconnect）</title>
        </g>

        {/* 第四层：后端服务 */}
        {node(810, 60, 80, 56, 'MySQL', 'radius', '', null, null, true)}
        {node(810, 190, 80, 56, 'Portal', ':8080', '', null, () => go('config', 'portal'))}

        {/* 连线：终端 → NAS */}
        {arrow(190, 72, 280, 120, '802.1X')}
        {arrow(190, 182, 280, 175, '802.1X')}
        {arrow(190, 292, 280, 245, '免认证', true)}

        {/* 连线：NAS → RADIUS（106） */}
        {arrow(460, 132, 550, 135, '认证 UDP 1812')}
        {arrow(460, 240, 550, 160, '认证 UDP 1812')}
        {arrow(460, 262, 550, 168, '记账 UDP 1813', true)}

        {/* 连线：RADIUS → 后端 */}
        {arrow(750, 138, 810, 88, 'SQL')}
        {arrow(750, 160, 810, 212, 'PAP', true)}

        {/* 底部统计条 */}
        <g>
          <rect x={20} y={370} width={860} height={86} rx={2} fill="var(--bg-light, #f4f4f4)" stroke="var(--border)" />
          <text x={40} y={398} fontSize={12} fill="var(--muted)">近 24h 认证</text>
          <text x={40} y={428} fontSize={22} fontWeight={700} fontFamily="var(--font-mono, monospace)" fill="var(--blue, #0f62fe)">{authOk}</text>
          <text x={105} y={428} fontSize={12} fill="var(--green)">成功</text>
          <text x={160} y={428} fontSize={22} fontWeight={700} fontFamily="var(--font-mono, monospace)" fill="#da1e28">{authFail}</text>
          <text x={222} y={428} fontSize={12} fill="var(--muted)">失败</text>

          <line x1={300} y1={385} x2={300} y2={440} stroke="var(--border)" />

          <text x={330} y={398} fontSize={12} fill="var(--muted)">策略下发</text>
          <text x={330} y={428} fontSize={22} fontWeight={700} fontFamily="var(--font-mono, monospace)" fill="var(--blue, #0f62fe)">{profiles}</text>
          <text x={382} y={428} fontSize={12} fill="var(--muted)">个 Profile · VLAN/QoS/ACL 随 Accept 下发</text>

          <line x1={680} y1={385} x2={680} y2={440} stroke="var(--border)" />

          <text x={710} y={398} fontSize={12} fill="var(--muted)">NAS 静默</text>
          <text x={710} y={428} fontSize={22} fontWeight={700} fontFamily="var(--font-mono, monospace)" fill={ov.nas?.stale > 0 ? '#da1e28' : 'var(--green)'}>{ov.nas?.stale ?? '…'}</text>
          <text x={748} y={428} fontSize={12} fill="var(--muted)">台 24h 无认证请求</text>
        </g>
      </svg>

      <div style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 11, color: 'var(--muted)', flexWrap: 'wrap' }}>
        <span>— 实线：主认证链路</span>
        <span>-- 虚线：旁路/辅助链路</span>
        <span><code style={{ color: 'var(--blue, #0f62fe)' }}>1812/udp</code> 认证 · <code style={{ color: 'var(--blue, #0f62fe)' }}>1813/udp</code> 记账 · <code style={{ color: 'var(--blue, #0f62fe)' }}>3799/udp</code> CoA 动态下线</span>
        <span style={{ cursor: 'pointer' }} onClick={() => go('config', 'certs')}>EAP-TLS 证书 → 证书管理</span>
        <span style={{ cursor: 'pointer' }} onClick={() => go('policy', 'qos')}>限速参数 → RADIUS 参数</span>
      </div>
    </div>
  )
}
