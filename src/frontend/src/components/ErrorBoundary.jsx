import { Component } from 'react'

const LANG = () => {
  try { return localStorage.getItem('lang') || 'zh' }
  catch { return 'zh' }
}

const DICT = {
  zh: { error_title: '页面出错了', refresh: '刷新页面' },
  en: { error_title: 'Page Error', refresh: 'Refresh' }
}

function tr(key) {
  const lang = LANG()
  return (DICT[lang] || DICT.zh)[key] || key
}

class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="panel" style={{marginTop:40}}>
          <div className="panel-header"><h4>{tr('error_title')}</h4></div>
          <div className="panel-body">
            <pre style={{fontSize:12,color:'var(--red)',whiteSpace:'pre-wrap'}}>{this.state.error.message}</pre>
            <button className="btn btn-primary" style={{marginTop:12}} onClick={()=>{this.setState({error:null});window.location.reload()}}>{tr('refresh')}</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default ErrorBoundary
