// 轻量 5 段 cron 下次执行时间计算（前端表单预览用）
// 支持：数字 / * / 逗号列表 / 区间 - / 步长 /，与 Vixie cron 的 dom/dow 约束语义一致
// dow: 0 和 7 都表示周日（cron 惯例）

function parseField(expr, lo, hi, isDow) {
  if (expr === undefined || expr === null) return null
  const val = String(expr).trim()
  if (val === '') return null
  if (val === '*') return { any: true, set: null }
  const out = new Set()
  for (const part of val.split(',')) {
    let seg = part
    let step = 1
    if (seg.includes('/')) {
      const [range, s] = seg.split('/')
      seg = range
      step = parseInt(s, 10)
      if (!Number.isInteger(step) || step < 1) return null
    }
    let a, b
    if (seg === '*') {
      a = lo; b = hi
    } else if (seg.includes('-')) {
      const p = seg.split('-')
      a = parseInt(p[0], 10); b = parseInt(p[1], 10)
    } else {
      a = parseInt(seg, 10)
      b = step > 1 ? hi : a          // "5/2" 等价 5-hi/2
    }
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null
    if (isDow) {                      // dow 允许 7=周日
      if (a === 7) a = 0
      if (b === 7) b = 0
    }
    if (a < lo || b > hi || a > b) return null
    for (let i = a; i <= b; i += step) out.add(i)
  }
  return { any: false, set: out }
}

const dowNames = [0, 1, 2, 3, 4, 5, 6]   // JS getDay(): 0=周日

/**
 * 计算 expr（5 段 cron）在 from 之后的下一次执行时间。
 * 返回 Date；表达式非法返回 null。最多向后扫描 366 天。
 */
export function cronNext(expr, from = new Date()) {
  const f = String(expr || '').trim().split(/\s+/)
  if (f.length !== 5) return null
  const min = parseField(f[0], 0, 59)
  const hr = parseField(f[1], 0, 23)
  const dom = parseField(f[2], 1, 31)
  const mon = parseField(f[3], 1, 12)
  const dow = parseField(f[4], 0, 6, true)
  if (!min || !hr || !dom || !mon || !dow) return null

  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)

  const cap = new Date(from.getTime() + 366 * 86400000)
  let guard = 0
  while (d < cap && guard++ < 600000) {
    if (!mon.any && !mon.set.has(d.getMonth() + 1)) {
      // 跳到下月 1 日 00:00
      d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); d.setMinutes(0); continue
    }
    const dayOk = domMatches(d, dom, dow)
    if (!dayOk) {
      d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue
    }
    if (!hr.any && !hr.set.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0); continue
    }
    if (!min.any && !min.set.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0); continue
    }
    return d
  }
  return null
}

function domMatches(d, dom, dow) {
  const domHit = dom.any || dom.set.has(d.getDate())
  const dowHit = dow.any || dow.set.has(d.getDay())
  if (dom.any && dow.any) return true
  if (dom.any) return dowHit
  if (dow.any) return domHit
  return domHit || dowHit          // 双约束：Vixie 语义取 OR
}

/** 预览文案：合法返回「下次执行：MM-DD HH:mm」，非法返回错误提示 */
export function cronPreviewText(expr) {
  const next = cronNext(expr)
  if (!next) return null
  const p = n => String(n).padStart(2, '0')
  return `下次执行：${next.getFullYear()}-${p(next.getMonth() + 1)}-${p(next.getDate())} ${p(next.getHours())}:${p(next.getMinutes())}`
}
