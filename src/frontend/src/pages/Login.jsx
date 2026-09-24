import { useState } from 'react'

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        let msg = '登录失败'
        try { const d = await res.json(); msg = d.detail || msg } catch { /* 非 JSON 响应 */ }
        setError(msg)
        return
      }
      const data = await res.json()
      localStorage.setItem('token', data.token)
      localStorage.setItem('admin_user', data.username)
      onLogin(data.token)
    } catch {
      setError('网络错误')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',
      background:'#f4f4f4'
    }}>
      <div style={{
        background:'#fff',borderRadius:0,padding:'40px 36px',minWidth:360,
        boxShadow:'none',border:'1px solid #e0e0e0'
      }}>
        <div style={{textAlign:'center',marginBottom:32}}>
          <div style={{width:48,height:48,background:'#0f62fe',color:'#fff',margin:'0 auto 12px',
            display:'flex',alignItems:'center',justifyContent:'center',fontSize:20,fontWeight:700,
            fontFamily:'IBM Plex Mono, monospace'}}>R</div>
          <h1 style={{fontSize:20,fontWeight:600,color:'#161616',fontFamily:'inherit'}}>企业网络管理平台</h1>
          <div style={{fontSize:12,color:'#6f6f6f',marginTop:4}}>RADIUS Ops Console · PRODUCTION</div>
        </div>
        {error && <div style={{
          background:'#fff1f1',color:'#da1e28',padding:'10px 14px',borderLeft:'3px solid #da1e28',
          borderRadius:0,marginBottom:16,fontSize:13,textAlign:'center'
        }}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <div style={{marginBottom:12}}>
            <input
              type="text" placeholder="用户名" value={username}
              onChange={e=>setUsername(e.target.value)}
              style={{width:'100%',padding:'11px 12px',border:'none',boxShadow:'inset 0 0 0 1px #8d8d8d',borderRadius:0,fontSize:14,background:'#fff',color:'#161616'}}
              autoFocus required
            />
          </div>
          <div style={{marginBottom:20}}>
            <input
              type="password" placeholder="密码" value={password}
              onChange={e=>setPassword(e.target.value)}
              style={{width:'100%',padding:'11px 12px',border:'none',boxShadow:'inset 0 0 0 1px #8d8d8d',borderRadius:0,fontSize:14,background:'#fff',color:'#161616'}}
              required
            />
          </div>
          <button
            type="submit" disabled={loading}
            style={{
              width:'100%',padding:'12px',background:loading?'#8d8d8d':'#0f62fe',
              color:'#fff',border:'none',borderRadius:0,fontSize:14,fontWeight:400,
              cursor:loading?'not-allowed':'pointer'
            }}
          >
            {loading ? '登录中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  )
}
