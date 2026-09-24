const API = '/api'

function getToken() {
  return localStorage.getItem('token') || ''
}

function extractErrMsg(t) {
  try {
    const j = JSON.parse(t)
    const d = j.detail ?? j
    if (typeof d === 'string') return d
    if (Array.isArray(d))  // pydantic 422 校验错误数组
      return d.map(e => `${(e.loc || []).slice(-1)[0] || ''}: ${e.msg || ''}`).join('；')
    if (d && d.msg) return d.msg
    return JSON.stringify(d)
  } catch { return t }
}

export async function fetchApi(path, options = {}) {
  const headers = { ...options.headers }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  // FormData（文件上传）不能手动设 Content-Type，浏览器需自动生成 multipart boundary
  if (!headers['Content-Type'] && options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(API + path, { ...options, headers })
  // 注意：后端没有 token 校验中间件，401 只可能是业务错误（如 CA 口令错误），
  // 绝不能当"会话失效"清 token 登出——否则业务报错会把管理员踢出后台。
  if (!res.ok) throw new Error(await res.text().then(extractErrMsg))
  // 按内容类型解析：JSON 接口返回对象；纯文本接口（如备份配置正文）返回字符串
  const ct = res.headers.get('content-type') || ''
  return ct.includes('application/json') ? res.json() : res.text()
}

export const api = {
  dashboard: () => fetchApi('/dashboard/stats'),
  users: () => fetchApi('/users'),
  createUser: (username, password, group) =>
    fetchApi(`/users?username=${username}&password=${password}&group=${group}`, { method: 'POST' }),
  deleteUser: (username) => fetchApi(`/users/${username}`, { method: 'DELETE' }),
  groups: () => fetchApi('/groups'),
  online: (username, mac) => fetchApi(`/online?${username||mac?new URLSearchParams({username:username||'',mac:mac||''}).toString():''}`),
  macs: (mac, username) => fetchApi(`/macs?${mac||username?new URLSearchParams({mac:mac||'',username:username||''}).toString():''}`),
  deleteMac: (mac) => fetchApi(`/macs/${mac}`, { method: 'DELETE' }),
  qos: () => fetchApi('/qos'),
  authlog: (username) => fetchApi(`/authlog?${username?'username='+encodeURIComponent(username):''}`),
  clearAuthlog: () => fetchApi('/authlog/clear', { method: 'POST' }),
  services: () => fetchApi('/services/status'),
}

export function isLoggedIn() {
  return !!getToken()
}

export function logout() {
  localStorage.removeItem('token')
  localStorage.removeItem('admin_user')
  window.location.reload()
}
