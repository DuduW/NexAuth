// 共享分页组件：页码超 7 页时自动省略
// 用法：<Pagination pg={pg} setPg={setPg} total={totalPages} size={size} setSize={setSize} />
export default function Pagination({ pg, setPg, total, size, setSize, sizes = [10, 20, 50, 100], unit = '条' }) {
  if (total <= 1 && !setSize) return null

  // 页码省略：最多渲染 7 个按钮
  const pages = []
  if (total <= 7) {
    for (let i = 1; i <= total; i++) pages.push(i)
  } else {
    pages.push(1)
    const s = Math.max(2, pg - 1)
    const e = Math.min(total - 1, pg + 1)
    if (s > 2) pages.push('…')
    for (let i = s; i <= e; i++) pages.push(i)
    if (e < total - 1) pages.push('…')
    pages.push(total)
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12, fontSize: 12, color: 'var(--gray)', alignItems: 'center' }}>
      {setSize && <>
        <span>每页</span>
        <select value={size} onChange={e => { setSize(Number(e.target.value)); setPg(1) }}
          style={{ padding: '3px 6px', border: '1px solid var(--border)', borderRadius:0, fontSize: 12 }}>
          {sizes.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span>{unit}</span>
      </>}
      <button className="btn btn-outline btn-sm" disabled={pg <= 1} onClick={() => setPg(pg - 1)}>◀</button>
      {pages.map((p, i) =>
        p === '…'
          ? <span key={'e' + i} style={{ color: 'var(--muted)' }}>…</span>
          : <button key={p} className={`btn btn-sm ${p === pg ? 'btn-primary' : 'btn-outline'}`}
              style={{ minWidth: 26, justifyContent: 'center' }} onClick={() => setPg(p)}>{p}</button>
      )}
      <button className="btn btn-outline btn-sm" disabled={pg >= total} onClick={() => setPg(pg + 1)}>▶</button>
    </div>
  )
}
