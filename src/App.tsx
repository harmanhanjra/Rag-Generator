import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import {
  ArrowDown, ArrowRight, ArrowUp, BookOpen, Check, ChevronDown, CircleHelp,
  Command, File, FileText, FileUp, FolderOpen, Layers2, LoaderCircle, MoreHorizontal,
  Plus, Settings2, ShieldCheck, Sparkles, Upload, X,
} from 'lucide-react'

type Document = { id: string; filename: string; size: number; characters: number; chunk_count: number; uploaded_at: string }
type Workspace = { id: string; name: string; created_at: string; updated_at: string; documents: Document[]; document_count: number; chunk_count: number }
type Source = { id: string; filename: string; snippet: string; citation: string }
type Message = { role: 'user' | 'assistant'; content: string; sources?: Source[]; mode?: string }

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, options)
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    const detail = Array.isArray(data.detail) ? data.detail.map((item: { msg?: string }) => item.msg || 'Invalid input').join('; ') : data.detail
    throw new Error(detail || `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

function IconBadge({ children, tone = 'sand' }: { children: React.ReactNode; tone?: 'sand' | 'green' | 'blue' }) {
  return <span className={`icon-badge ${tone}`}>{children}</span>
}

function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [activeId, setActiveId] = useState('')
  const [histories, setHistories] = useState<Record<string, Message[]>>({})
  const [question, setQuestion] = useState('')
  const [pendingWorkspaces, setPendingWorkspaces] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [health, setHealth] = useState<'loading' | 'ready' | 'offline'>('loading')
  const [provider, setProvider] = useState('extractive')
  const fileRef = useRef<HTMLInputElement>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const active = workspaces.find(w => w.id === activeId) || null
  const messages = histories[activeId] || []
  const loading = pendingWorkspaces.includes(activeId)
  const pendingRef = useRef(new Set<string>())

  function setMessages(workspaceId: string, update: Message[] | ((current: Message[]) => Message[])) {
    setHistories(current => ({ ...current, [workspaceId]: typeof update === 'function' ? update(current[workspaceId] || []) : update }))
  }

  function selectWorkspace(workspaceId: string) {
    setActiveId(workspaceId); setQuestion(''); setError('')
  }

  const refresh = useCallback(async (selectFirst = false) => {
    const data = await api<Workspace[]>('/api/workspaces')
    // Keep sidebar targets stable while answers update workspace timestamps.
    setWorkspaces(data.sort((a, b) => b.created_at.localeCompare(a.created_at)))
    if (selectFirst && data.length) setActiveId(current => current || data[0].id)
  }, [])

  useEffect(() => {
    Promise.all([refresh(true), api<{ status: string; provider: string }>('/api/health')])
      .then(([, status]) => { setProvider(status.provider); setHealth('ready') })
      .catch(() => setHealth('offline'))
  }, [refresh])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])

  async function createWorkspace(event: FormEvent) {
    event.preventDefault()
    if (!newName.trim()) return
    setError('')
    try {
      const created = await api<Workspace>('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim() }) })
      await refresh()
      selectWorkspace(created.id)
      setCreating(false)
      setNewName('')
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create workspace') }
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files)
    if (!list.length || uploading) return
    setUploading(true); setError('')
    try {
      let workspaceId = active?.id
      if (!workspaceId) {
        const workspace = await api<Workspace>('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'My documents' }) })
        workspaceId = workspace.id
        setActiveId(workspace.id)
        setMessages(workspace.id, [])
      }
      const body = new FormData()
      list.forEach(file => body.append('files', file))
      await api(`/api/workspaces/${workspaceId}/documents`, { method: 'POST', body })
      await refresh()
    } catch (err) { setError(err instanceof Error ? err.message : 'Upload failed') }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }

  async function removeDocument(doc: Document) {
    if (!active || loading || uploading) return
    try {
      await api(`/api/workspaces/${active.id}/documents/${doc.id}`, { method: 'DELETE' })
      await refresh()
      setMessages(active.id, [])
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not remove document') }
  }

  async function removeWorkspace(workspace: Workspace) {
    try {
      await api(`/api/workspaces/${workspace.id}`, { method: 'DELETE' })
      const remaining = workspaces.filter(w => w.id !== workspace.id)
      setWorkspaces(remaining)
      setMessages(workspace.id, [])
      if (activeId === workspace.id) selectWorkspace(remaining[0]?.id || '')
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete workspace') }
  }

  async function ask(text: string) {
    const prompt = text.trim()
    if (!active || !active.document_count || uploading || pendingRef.current.has(active.id)) return
    if (prompt.length < 2 || prompt.length > 2000) { setError('Enter a question between 2 and 2000 characters.'); return }
    const workspaceId = active.id
    pendingRef.current.add(workspaceId)
    setPendingWorkspaces(current => [...current, workspaceId])
    setMessages(workspaceId, current => [...current, { role: 'user', content: prompt }])
    setQuestion(''); setError('')
    try {
      const response = await api<{ answer: string; sources: Source[]; mode: string }>(`/api/workspaces/${workspaceId}/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: prompt }),
      })
      setMessages(workspaceId, current => [...current, { role: 'assistant', content: response.answer, sources: response.sources, mode: response.mode }])
      await refresh()
    } catch (err) { setMessages(workspaceId, current => [...current, { role: 'assistant', content: err instanceof Error ? err.message : 'Could not get an answer. Please try again.' }]) }
    finally { pendingRef.current.delete(workspaceId); setPendingWorkspaces(current => current.filter(id => id !== workspaceId)) }
  }

  function submitQuestion(event: FormEvent) { event.preventDefault(); void ask(question) }
  function handleFileChange(event: ChangeEvent<HTMLInputElement>) { if (event.target.files) void uploadFiles(event.target.files) }

  return <div className="app-shell">
    <input ref={fileRef} className="hidden-input" type="file" accept=".pdf,.docx,.txt,.md,.markdown" multiple onChange={handleFileChange} />
    <aside className="sidebar">
      <div className="brand-row">
        <span className="brand-mark"><Layers2 size={18} strokeWidth={2.4} /></span>
        <span className="brand-name">atlas<span className="brand-dot">.</span></span>
        <span className="brand-pill">WORKSPACE</span>
      </div>

      <div className="sidebar-context"><span className="context-label">YOUR SPACE</span><button className="icon-button subtle" aria-label="Workspace settings"><Settings2 size={16} /></button></div>
      <button className="nav-link active"><BookOpen size={17} /><span>Knowledge base</span><span className="nav-count">{workspaces.length}</span></button>
      <button className="nav-link" onClick={() => fileRef.current?.click()}><Upload size={17} /><span>Upload documents</span></button>
      <button className="nav-link" onClick={() => { setCreating(true); setTimeout(() => document.getElementById('workspace-name')?.focus(), 0) }}><Plus size={17} /><span>New workspace</span><span className="nav-shortcut">⌘ K</span></button>

      <div className="collection-heading"><span>WORKSPACES</span><button className="icon-button tiny" aria-label="Create workspace" onClick={() => setCreating(true)}><Plus size={15} /></button></div>
      <div className="workspace-list">
        {workspaces.map((workspace, index) => <button key={workspace.id} className={`workspace-nav ${workspace.id === activeId ? 'selected' : ''}`} onClick={() => selectWorkspace(workspace.id)}>
          <span className={`workspace-symbol symbol-${index % 4}`}><FolderOpen size={15} /></span><span className="workspace-nav-text">{workspace.name}</span><span className="workspace-nav-count">{workspace.document_count}</span>
        </button>)}
        {!workspaces.length && <p className="sidebar-empty">Your workspaces will show up here.</p>}
      </div>

      <div className="sidebar-spacer" />
      <div className="privacy-note"><ShieldCheck size={16} /><div><strong>Your documents stay yours.</strong><span>Private to this local workspace.</span></div></div>
      <div className="profile-row"><div className="avatar">A</div><div className="profile-copy"><strong>Atlas workspace</strong><span>Local environment</span></div><button className="icon-button subtle" aria-label="More workspace options"><MoreHorizontal size={18} /></button></div>
    </aside>

    <main className="main-panel">
      <header className="topbar">
        <div className="breadcrumb"><span>Knowledge base</span><ChevronDown size={14} /><span className="breadcrumb-current">{active?.name || 'Overview'}</span></div>
        <div className="topbar-right"><span className={`connection ${health}`}><span className="connection-dot" />{health === 'ready' ? 'System operational' : health === 'offline' ? 'Backend offline' : 'Connecting'}</span><button className="help-button"><CircleHelp size={16} /><span>Help center</span></button><div className="top-avatar">A</div></div>
      </header>

      <div className="content-wrap">
        {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button subtle" aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
        {creating && <form className="create-banner" onSubmit={createWorkspace}><div><strong>Start a new workspace</strong><span>Keep each set of documents organized separately.</span></div><input id="workspace-name" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Product research" maxLength={80} aria-label="Workspace name" autoFocus /><button type="submit" className="primary-small" disabled={!newName.trim()}>Create workspace <ArrowRight size={15} /></button><button type="button" className="icon-button subtle" aria-label="Close" onClick={() => setCreating(false)}><X size={16} /></button></form>}

        {!active ? <section className="welcome-state"><IconBadge tone="green"><Sparkles size={18} /></IconBadge><p className="eyebrow">YOUR AI RESEARCH SPACE</p><h1>Make sense of<br />what you know.</h1><p className="welcome-description">Bring your documents together and ask the questions that move your work forward.</p><button className="primary-button" onClick={() => fileRef.current?.click()}><Upload size={17} /> Upload documents <ArrowRight size={16} /></button><button className="welcome-create-button" onClick={() => setCreating(true)}><Plus size={15} /> Create a workspace first</button><div className="welcome-footnote"><ShieldCheck size={15} /> Your documents stay private in this local workspace.</div></section> : <>
          <section className="page-intro"><div className="page-intro-main"><div className="eyebrow"><span className="eyebrow-icon"><BookOpen size={13} /></span> DOCUMENT INTELLIGENCE</div><div className="title-line"><h1>{active.name}</h1><button className="title-menu" title="Delete workspace" aria-label="Delete workspace" disabled={loading || uploading} onClick={() => void removeWorkspace(active)}><MoreHorizontal size={19} /></button></div><p>Your documents, connected. What would you like to know?</p></div><div className="index-status"><span className={`status-check ${health === 'ready' ? 'online' : ''}`}>{health === 'ready' ? <Check size={14} /> : <LoaderCircle size={13} />}</span><div><strong>{health === 'ready' ? 'Knowledge base ready' : health === 'offline' ? 'Reconnect backend' : 'Connecting'}</strong><span>{provider === 'nvidia-nim' ? 'NVIDIA NIM answers' : 'Grounded answers'}</span></div></div></section>

          <section className="overview-strip" aria-label="Workspace overview"><div className="overview-cell"><span className="overview-icon"><FileText size={17} /></span><div><span className="metric-value">{active.document_count}</span><span className="metric-label">{active.document_count === 1 ? 'document' : 'documents'}</span></div></div><span className="overview-divider" /><div className="overview-cell"><span className="overview-icon chunk-icon"><Layers2 size={17} /></span><div><span className="metric-value">{active.chunk_count.toLocaleString()}</span><span className="metric-label">searchable passages</span></div></div><span className="overview-divider" /><div className="overview-cell"><span className="overview-icon secure-icon"><ShieldCheck size={17} /></span><div><span className="metric-value">Private</span><span className="metric-label">your workspace</span></div></div></section>

          <section className="documents-section"><div className="section-heading"><div><span className="eyebrow">YOUR KNOWLEDGE BASE</span><h2>Sources <span className="heading-count">{active.document_count}</span></h2></div><button className="outline-button" onClick={() => fileRef.current?.click()} disabled={uploading}><Upload size={15} /> Add documents</button></div>
            <div className={`upload-zone ${dragging ? 'drag-active' : ''} ${uploading ? 'is-uploading' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={e => { e.preventDefault(); setDragging(false); void uploadFiles(e.dataTransfer.files) }}>
              <span className="upload-icon">{uploading ? <LoaderCircle size={20} className="spin" /> : <FileUp size={20} />}</span><div className="upload-copy"><strong>{uploading ? 'Reading and indexing your files…' : 'Drop documents here to add them'}</strong><span>{uploading ? 'Your sources will be ready in a moment.' : 'PDF, DOCX, TXT or Markdown · Up to 25 MB each'}</span></div>{!uploading && <button className="browse-button" onClick={() => fileRef.current?.click()}>Browse files</button>}
            </div>
            {active.documents.length ? <div className="file-list">{active.documents.map((doc, index) => <article className="file-row" key={doc.id}><IconBadge tone={index % 3 === 1 ? 'green' : index % 3 === 2 ? 'blue' : 'sand'}><FileText size={17} /></IconBadge><div className="file-main"><span className="file-name">{doc.filename}</span><span className="file-meta">{formatSize(doc.size)} <span className="meta-dot">·</span> {doc.chunk_count} {doc.chunk_count === 1 ? 'passage' : 'passages'} <span className="meta-dot">·</span> Added {new Date(doc.uploaded_at).toLocaleDateString()}</span></div><span className="indexed-tag"><span /> Indexed</span><button className="icon-button subtle remove-button" aria-label={`Remove ${doc.filename}`} disabled={loading || uploading} onClick={() => void removeDocument(doc)}><X size={16} /></button></article>)}</div> : <div className="empty-documents"><div className="empty-icon"><File size={20} /></div><span><strong>No sources yet</strong><span>Add documents to bring this knowledge base to life.</span></span></div>}
          </section>

          <section className="ask-section"><div className="section-heading ask-heading"><div><span className="eyebrow"><span className="ask-spark"><Sparkles size={12} /></span> ASK YOUR KNOWLEDGE BASE</span><h2>Find your answer</h2></div><span className="source-mode"><span /> Sources cited in every answer</span></div>
            <div className={`chat-panel ${messages.length ? 'has-messages' : ''}`}>
              {!messages.length ? <div className="chat-welcome"><div className="chat-welcome-icon"><Sparkles size={18} /></div><div><strong>A little context goes a long way.</strong><p>Your answers are pulled directly from your documents, with sources you can follow up on.</p></div></div> : <div className="message-list">{messages.map((message, i) => <div key={`${i}-${message.role}`} className={`message ${message.role}`}><div className="message-avatar">{message.role === 'assistant' ? <Layers2 size={15} /> : 'A'}</div><div className="message-body"><span className="message-author">{message.role === 'assistant' ? `Atlas${message.mode === 'llm-fallback' ? ' · NVIDIA backup model' : message.mode === 'llm' ? ' · NVIDIA' : message.mode?.startsWith('extractive') ? ' · Source passages' : ''}` : 'You'}</span><div className="message-text">{message.content.split(/(\[\d+\])/g).map((part, j) => /^\[\d+\]$/.test(part) ? <span key={j} className="citation-chip">{part}</span> : <span key={j}>{part}</span>)}</div>{message.sources?.length ? <div className="source-list"><span className="source-list-label">SOURCES</span>{message.sources.map(source => <details className="source-item" key={source.id}><summary><span className="source-number">{source.citation}</span><FileText size={14} /><span>{source.filename}</span><ChevronDown size={13} className="source-chevron" /></summary><p>{source.snippet}</p></details>)}</div> : null}</div></div>)}{loading && <div className="message assistant"><div className="message-avatar"><Layers2 size={15} /></div><div className="message-body"><span className="message-author">Atlas</span><div className="thinking"><span /><span /><span /></div></div></div>}<div ref={chatEndRef} /></div>}
              {active.document_count === 0 && !messages.length ? <div className="suggestions"><span className="suggestions-label">TRY ASKING</span><div className="suggestion-chips"><button disabled>What are the main themes? <ArrowRight size={13} /></button><button disabled>Summarize the key findings <ArrowRight size={13} /></button></div></div> : null}
              <form className="question-form" onSubmit={submitQuestion}><textarea value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(question) } }} placeholder={active.document_count ? 'Ask anything about your documents…' : 'Add documents above to start asking questions…'} rows={1} maxLength={2000} disabled={!active.document_count || loading || uploading} aria-label="Ask your documents" /><div className="composer-bottom"><span className="composer-hint"><Command size={12} /> Enter to ask <span className="hint-divider">·</span> Shift + Enter for a new line</span><button className="send-button" aria-label="Send question" type="submit" disabled={question.trim().length < 2 || !active.document_count || loading || uploading}>{loading ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={17} />}</button></div></form>
              <div className="chat-disclaimer"><ShieldCheck size={13} /> Responses are grounded in your sources. Always verify important details.</div>
            </div>
          </section>
          <footer className="page-footer"><span>Made for clearer thinking.</span><span><Sparkles size={12} /> Answers powered by your sources <ArrowDown size={12} /></span></footer>
        </>}
      </div>
    </main>
  </div>
}

export default App
