import { useState, useEffect } from 'react'
import { tr } from '../i18n'
import { fetchApi } from '../api'
import { toastSuccess, toastError } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import QrCanvas from '../components/QrCanvas'
import ActionMenu from '../components/ActionMenu'

export default function TotpManager() {
  const [totpUsers, setTotpUsers] = useState([])
  const [allUsers, setAllUsers] = useState([])
  const [qrCode, setQrCode] = useState(null)
  const [verifyUser, setVerifyUser] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const [verifyResult, setVerifyResult] = useState(null)

  const load = () => {
    fetchApi('/totp/status').then(setTotpUsers).catch(console.error)
    fetchApi('/users').then(setAllUsers).catch(console.error)
  }
  useEffect(load, [])

  const enable = async (username) => {
    try {
      const r = await fetchApi(`/totp/enable/${username}`, { method: 'POST' })
      setQrCode({ username, uri: r.uri, secret: r.secret })
      load()
    } catch (err) { toastError(err.message) }
  }

  const disable = async (username) => {
    const ok = await confirmDialog({
      title: `禁用 ${username} 的 TOTP？`,
      message: '禁用后该用户下次登录将不再需要动态码验证，账号安全性降低。',
      confirmText: '禁用', danger: true,
    })
    if (!ok) return
    try {
      await fetchApi(`/totp/disable/${username}`, { method: 'POST' })
      setQrCode(null)
      load()
      toastSuccess(`已禁用 ${username} 的 TOTP`)
    } catch (err) { toastError(err.message) }
  }

  const verify = async () => {
    try {
      await fetchApi(`/totp/verify?username=${verifyUser}&code=${verifyCode}`, { method: 'POST' })
      setVerifyResult({ ok: true, msg: '验证通过' })
    } catch (e) {
      setVerifyResult({ ok: false, msg: e.message })
    }
  }

  const hasTotp = (u) => totpUsers.find(t => t.username === u && t.enabled)
  const enabledList = totpUsers.filter(t => t.enabled)
  // Users without TOTP
  const withoutTotp = allUsers.filter(u => !totpUsers.find(t => t.username === u.username && t.enabled))

  return <>
    <div className="page-header"><h1>TOTP 动态码管理</h1></div>

    {/* QR Modal */}
    {qrCode && <div className="modal-overlay" onClick={()=>setQrCode(null)}>
      <div className="modal-box" style={{textAlign:'center'}} onClick={e=>e.stopPropagation()}>
        <h5>{qrCode.username} - TOTP 密钥</h5>
        <div style={{display:'flex',justifyContent:'center',marginTop:12}}>
          <QrCanvas value={qrCode.uri} size={200} />
        </div>
        <div style={{marginTop:12,fontSize:11,color:'var(--muted)',wordBreak:'break-all'}}><code>{qrCode.secret}</code></div>
        <div style={{marginTop:10,fontSize:12,padding:'6px 10px',background:'var(--warn-bg)',color:'var(--warn)',borderRadius:0}}>
          ⚠ 密钥仅本次显示，请立即绑定 Google Authenticator，关闭后不可再查看
        </div>
        <button className="btn btn-outline btn-sm" style={{marginTop:12}} onClick={()=>setQrCode(null)}>我已完成绑定，关闭</button>
      </div>
    </div>}

    {/* Verify */}
    <div className="panel"><div className="panel-header"><h4>验证 TOTP</h4></div>
    <div className="panel-body">
      <div className="input-wrap">
        <input placeholder="用户名" value={verifyUser} onChange={e=>setVerifyUser(e.target.value)} />
        <input placeholder="6位验证码" value={verifyCode} onChange={e=>setVerifyCode(e.target.value)} maxLength={6} style={{width:120}} />
        <button className="btn btn-primary btn-sm" onClick={verify}>验证</button>
      </div>
      {verifyResult && <span className={`badge badge-${verifyResult.ok?'success':'danger'}`}>{verifyResult.msg}</span>}
    </div></div>

    {/* Enabled TOTP */}
    <div className="panel"><div className="panel-header"><h4>已启用 TOTP</h4><span className="badge badge-success">{enabledList.length} 人</span></div>
    <div className="panel-body">
      {enabledList.length ? <table><thead><tr><th>用户名</th><th>启用时间</th><th>操作</th></tr></thead><tbody>
        {enabledList.map(u=><tr key={u.username}>
          <td><strong>{u.username}</strong></td><td>{(u.created||'').substring(0,19)}</td>
          <td><ActionMenu actions={[
            { label: '重置密钥', icon: '⟳', onClick: () => enable(u.username) },
            { label: '禁用 TOTP', icon: '⊘', danger: true, onClick: () => disable(u.username) },
          ]} /></td>
        </tr>)}
      </tbody></table> : <div className="empty">暂无</div>}
    </div></div>

    {/* Enable new */}
    <div className="panel"><div className="panel-header"><h4>未启用 TOTP 的用户</h4><span className="badge badge-default">{withoutTotp.length} 人</span></div>
    <div className="panel-body">
      {withoutTotp.length ? <table><thead><tr><th>用户名</th><th>分组</th><th>操作</th></tr></thead><tbody>
        {withoutTotp.map(u=><tr key={u.username}>
          <td>{u.username}</td><td><span className="badge badge-default">{u.groupname||'-'}</span></td>
          <td><ActionMenu actions={[
            { label: '启用 TOTP', icon: '▶', onClick: () => enable(u.username) },
          ]} /></td>
        </tr>)}
      </tbody>  </table> : <div className="empty">所有用户已启用</div>}
    </div></div></>
}
