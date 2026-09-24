import { useState, useEffect } from 'react'
import { tr } from '../i18n'
import { fetchApi } from '../api'
import { toastSuccess, toastError } from '../components/Toast'
import { confirmDialog } from '../components/ConfirmModal'
import ActionMenu from '../components/ActionMenu'

export default function NasManagement() {
  const [nasList, setNasList] = useState([])
  const [edit, setEdit] = useState(null)

  const load = () => { fetchApi('/nas').then(setNasList).catch(console.error) }
  useEffect(load, [])

  const save = async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    const data = { nasname: fd.get('nasname'), secret: fd.get('secret'), shortname: fd.get('shortname')||'', type: fd.get('type')||'other', ports: fd.get('ports')||2000, description: fd.get('description')||'' }
    try {
      if (edit) {
        await fetchApi(`/nas/${edit}`, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) })
        setEdit(null)
      } else {
        await fetchApi(`/nas?nasname=${data.nasname}&secret=${data.secret}&type=${data.type}&ports=${data.ports}&description=${data.description}`, { method: 'POST' })
      }
      toastSuccess(`NAS ${data.nasname} 已保存`)
      load()
    } catch (err) { toastError(err.message) }
  }

  const del = async (id) => {
    const row = nasList.find(n => n.id === id)
    const ok = await confirmDialog({
      title: `删除 NAS ${row?.nasname || ''}？`,
      message: '删除后该设备（AC/交换机）将无法通过 RADIUS 完成认证，其下所有用户立即受影响。',
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try { await fetchApi(`/nas/${id}`, { method: 'DELETE' }); toastSuccess('NAS 已删除'); load() }
    catch (err) { toastError(err.message) }
  }

  return <>
    <div className="page-header"><h1>{tr('nas_title')}</h1></div>
    <div className="panel"><div className="panel-header"><h4>{edit ? tr('edit_nas') : tr('add_nas')}</h4></div>
    <div className="panel-body">
      <form key={edit || 'new'} onSubmit={save} className="input-wrap">
        <input name="nasname" placeholder={tr('nas_ip')} defaultValue={edit ? nasList.find(n=>n.id===edit)?.nasname : ''} required />
        <input name="secret" placeholder={tr('nas_secret')} defaultValue={edit ? nasList.find(n=>n.id===edit)?.secret : ''} required />
        <select name="type" defaultValue={edit ? nasList.find(n=>n.id===edit)?.type : 'other'}>
          <option value="other">{tr('nas_type')}</option><option value="huawei">华为</option><option value="cisco">Cisco</option>
        </select>
        <input name="ports" type="number" placeholder={tr('nas_ports')} defaultValue={edit ? nasList.find(n=>n.id===edit)?.ports : 2000} style={{width:80}} />
        <input name="description" placeholder={tr('nas_desc')} defaultValue={edit ? nasList.find(n=>n.id===edit)?.description||'' : ''} />
        <button className="btn btn-primary" type="submit">{edit ? tr('save') : tr('create')}</button>
        {edit && <button className="btn btn-outline" type="button" onClick={() => setEdit(null)}>{tr('cancel')}</button>}
      </form></div></div>

    <div className="panel"><div className="panel-header"><h4>{tr('nas_list')}</h4><span className="badge badge-blue">{nasList.length} {tr('nas_count')}</span></div>
    <div className="panel-body">
      {nasList.length ? <table><thead><tr><th>{tr('nas_ip')}</th><th>{tr('nas_secret')}</th><th>{tr('nas_type')}</th><th>{tr('nas_ports')}</th><th>{tr('nas_desc')}</th><th>{tr('operation')}</th></tr></thead><tbody>
        {nasList.map(n => <tr key={n.id}><td><code>{n.nasname}</code></td><td><code>{'*'.repeat(8)}</code></td><td><span className="badge badge-default">{n.type}</span></td><td>{n.ports}</td><td>{n.description||'-'}</td>
        <td><ActionMenu actions={[
          { label: tr('edit'), icon: '✎', onClick: () => setEdit(n.id) },
          { label: tr('delete'), icon: '🗑', danger: true, onClick: () => del(n.id) },
        ]} /></td></tr>)}
      </tbody></table> : <div className="empty">{tr('no_data')}</div>}
    </div></div></>
}
