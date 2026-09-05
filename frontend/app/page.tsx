'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Archive,
  ArrowUp,
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  Clipboard,
  CloudUpload,
  Code2,
  Copy,
  FileText,
  FolderOpen,
  HelpCircle,
  History,
  KeyRound,
  Loader2,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'

type VaultStatus = 'Processing' | 'Success' | 'Failed'
type Vault = { id: string; name: string; totalFiles: number; status: VaultStatus; createdAt: string }
type Message = { id: string; role: 'user' | 'assistant'; content: string; sources?: { filename: string }[] }

type SettingsState = { backendUrl: string; apiKey: string; ownerToken: string }

const defaultSettings: SettingsState = { backendUrl: 'http://localhost:8000', apiKey: '', ownerToken: '' }
const initialMessages: Message[] = [{ id: 'welcome', role: 'assistant', content: 'Hello. I\'m ready to search your vault. Ask me anything about your notes, projects, or ideas.' }]

function makeToken() { return `client_${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}` }
function readStore<T>(key: string, fallback: T): T { try { const item = localStorage.getItem(key); return item ? JSON.parse(item) : fallback } catch { return fallback } }
function statusTone(status: VaultStatus) { return status === 'Success' ? 'success' : status === 'Failed' ? 'failed' : 'processing' }

export default function Page() {
  const [settings, setSettings] = useState<SettingsState>(defaultSettings)
  const [vaults, setVaults] = useState<Vault[]>([])
  const [activeId, setActiveId] = useState('')
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const activeVault = vaults.find((vault) => vault.id === activeId)

  useEffect(() => {
    const loaded = readStore<SettingsState>('vault-rag-settings', defaultSettings)
    if (!loaded.ownerToken) loaded.ownerToken = makeToken()
    setSettings(loaded)
    setVaults(readStore<Vault[]>('vault-rag-vaults', []))
    setActiveId(readStore<string>('vault-rag-active', ''))
    setMessages(readStore<Message[]>('vault-rag-chat', initialMessages))
  }, [])
  useEffect(() => { if (settings.ownerToken) localStorage.setItem('vault-rag-settings', JSON.stringify(settings)) }, [settings])
  useEffect(() => { localStorage.setItem('vault-rag-vaults', JSON.stringify(vaults)) }, [vaults])
  useEffect(() => { if (activeId) localStorage.setItem('vault-rag-active', activeId) }, [activeId])
  useEffect(() => { if (messages.length) localStorage.setItem('vault-rag-chat', JSON.stringify(messages)) }, [messages])

  useEffect(() => {
    const processing = vaults.filter((vault) => vault.status === 'Processing')
    if (!processing.length || !settings.backendUrl) return
    const poll = async () => {
      for (const vault of processing) {
        try {
          const response = await fetch(`${settings.backendUrl.replace(/\/$/, '')}/status/${vault.id}`, { headers: headers(settings) })
          if (!response.ok) continue
          const status = await response.text()
          const cleanStatus = status.replaceAll('"', '') as VaultStatus
          if (['Success', 'Failed'].includes(cleanStatus)) setVaults((current) => current.map((item) => item.id === vault.id ? { ...item, status: cleanStatus } : item))
        } catch { /* backend may be offline while the client is configured */ }
      }
    }
    poll()
    const timer = window.setInterval(poll, 5000)
    return () => window.clearInterval(timer)
  }, [vaults, settings])

  const hasConfig = Boolean(settings.backendUrl && settings.apiKey && activeVault)
  const suggestions = ['Summarize my weekly notes', 'What tasks are pending?', 'Find my latest project roadmap']

  async function testConnection() {
    setTestState('testing')
    try {
      const response = await fetch(settings.backendUrl.replace(/\/$/, ''), { headers: headers(settings) })
      setConnected(response.ok)
      setTestState(response.ok ? 'success' : 'error')
    } catch { setConnected(false); setTestState('error') }
  }

  async function sendQuery(value = query) {
    const text = value.trim()
    if (!text || loading) return
    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: text }
    setMessages((current) => [...current, userMessage]); setQuery(''); setLoading(true)
    if (!activeVault || !settings.backendUrl || !settings.apiKey) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: 'Connect your backend and select a successfully indexed vault to start querying.' }])
      setLoading(false); return
    }
    try {
      const response = await fetch(`${settings.backendUrl.replace(/\/$/, '')}/qna`, { method: 'POST', headers: { ...headers(settings), 'Content-Type': 'application/json' }, body: JSON.stringify({ query: text, job_id: activeVault.id }) })
      if (!response.ok) throw new Error('Request failed')
      const data = await response.json()
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: data.answer || 'No answer returned.', sources: data.sources }])
      setConnected(true)
    } catch { setConnected(false); setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', content: 'I couldn\'t reach the RAG server. Check your backend URL and API key in Settings, then try again.' }]) }
    finally { setLoading(false) }
  }

  function handleFiles(incoming: FileList | File[]) { setFiles(Array.from(incoming).filter((file) => file.name.toLowerCase().endsWith('.md'))) }
  async function uploadFiles() {
    if (!files.length) return
    setUploading(true); setUploadProgress(18)
    try {
      const form = new FormData(); files.forEach((file) => form.append('files', file))
      const response = await fetch(`${settings.backendUrl.replace(/\/$/, '')}/upload-files`, { method: 'POST', headers: headers(settings), body: form })
      if (!response.ok) throw new Error('Upload failed')
      setUploadProgress(72); const data = await response.json()
      const vault: Vault = { id: data.job_id, name: files[0].webkitRelativePath?.split('/')[0] || files[0].name.replace(/\.md$/i, '') || 'New Vault', totalFiles: files.length, status: 'Processing', createdAt: new Date().toISOString() }
      setVaults((current) => [vault, ...current]); setActiveId(vault.id); setConnected(true); setUploadProgress(100)
      window.setTimeout(() => { setUploadOpen(false); setFiles([]); setUploadProgress(0) }, 700)
    } catch { setUploadProgress(0) } finally { setUploading(false) }
  }

  function clearChat() { setMessages(initialMessages) }
  function selectVault(id: string) { setActiveId(id); setLibraryOpen(false); setMessages(initialMessages) }
  function resizeInput() { if (inputRef.current) { inputRef.current.style.height = 'auto'; inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px` } }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen">
        <aside className="hidden w-[276px] shrink-0 border-r border-border/70 bg-sidebar/70 lg:flex lg:flex-col">
          <SidebarContent vaults={vaults} activeId={activeId} onSelect={selectVault} onUpload={() => setUploadOpen(true)} onSettings={() => setSettingsOpen(true)} onNewChat={clearChat} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-[72px] items-center justify-between border-b border-border/70 px-4 sm:px-7">
            <div className="flex min-w-0 items-center gap-3"><button onClick={() => setLibraryOpen(true)} className="rounded-lg p-2 text-muted-foreground hover:bg-accent lg:hidden" aria-label="Open vault library"><Menu /></button><div className="min-w-0"><div className="flex items-center gap-2"><h1 className="truncate text-sm font-semibold">{activeVault?.name || 'Vault workspace'}</h1>{activeVault && <span className={`status-dot ${statusTone(activeVault.status)}`} />}</div><p className="truncate font-mono text-[10px] text-muted-foreground">{activeVault ? `job_${activeVault.id.slice(0, 16)}` : 'No vault selected'}</p></div></div>
            <div className="flex items-center gap-1 sm:gap-2"><div className={`mr-1 hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs sm:flex ${connected ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300' : 'border-border bg-muted/20 text-muted-foreground'}`}><span className={`size-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-muted-foreground/50'}`} />{connected ? 'Connected' : 'Disconnected'}</div><Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} aria-label="Open settings"><Settings /></Button><Button variant="ghost" size="icon" onClick={clearChat} aria-label="Clear chat"><Trash2 /></Button><Button size="sm" className="hidden gap-2 bg-primary text-primary-foreground shadow-[0_0_18px_rgba(124,58,237,0.2)] sm:flex" onClick={() => setUploadOpen(true)}><Plus data-icon="inline-start" />New vault</Button></div>
          </header>
          <section className="relative flex min-h-0 flex-1 flex-col">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(124,58,237,0.09),transparent_35%)]" />
            <div className="relative mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-y-auto px-4 py-8 sm:px-8">
              {messages.length === 1 && <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center pb-8"><div className="mb-8 flex items-center gap-4"><div className="flex size-12 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary shadow-[0_0_24px_rgba(124,58,237,0.16)]"><Sparkles /></div><div><p className="mb-1 text-xs font-medium uppercase tracking-[0.18em] text-primary/80">Vault intelligence</p><h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Ask your notes anything.</h2></div></div><p className="mb-7 max-w-lg text-sm leading-6 text-muted-foreground">A private retrieval layer for your Obsidian vault. Search context, connect ideas, and turn scattered notes into clear answers.</p><div className="grid gap-2 sm:grid-cols-3">{suggestions.map((suggestion) => <button key={suggestion} onClick={() => sendQuery(suggestion)} className="group rounded-xl border border-border/80 bg-card/40 p-3 text-left text-xs text-muted-foreground transition hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"><span className="mb-5 block text-primary/70 transition group-hover:translate-x-0.5">→</span>{suggestion}</button>)}</div></div>}
              <div className="flex flex-col gap-7">{messages.map((message) => <MessageRow key={message.id} message={message} />)}{loading && <div className="flex gap-3"><div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles /></div><div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-border/70 bg-card/70 px-4 py-3 text-sm text-muted-foreground"><Loader2 className="animate-spin" />Searching your vault<span className="loading-dots">...</span></div></div>}</div>
            </div>
            <div className="relative mx-auto w-full max-w-3xl px-4 pb-5 sm:px-8"><div className="mb-2 flex items-center justify-between px-1 text-[11px] text-muted-foreground"><span className="flex items-center gap-1.5"><Archive />Querying {activeVault ? activeVault.name : 'no vault'}</span><span className="hidden sm:inline">Enter to send · Shift + Enter for newline</span></div><div className="rounded-2xl border border-border bg-card/90 p-2 shadow-2xl shadow-black/20 transition focus-within:border-primary/50 focus-within:shadow-[0_0_30px_rgba(124,58,237,0.1)]"><textarea ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); resizeInput() }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); sendQuery() } }} rows={1} placeholder="Ask a question about your vault..." className="max-h-40 min-h-10 w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground/60" /><div className="flex items-center justify-between px-1"><div className="flex items-center gap-1 text-xs text-muted-foreground"><button className="rounded-md p-1.5 hover:bg-accent" aria-label="Attach files"><CloudUpload /></button><span className="hidden sm:inline">RAG context is scoped to the active vault</span></div><Button size="icon" onClick={() => sendQuery()} disabled={!query.trim() || loading} className="size-8 rounded-lg bg-primary text-primary-foreground" aria-label="Send message">{loading ? <Loader2 className="animate-spin" /> : <ArrowUp />}</Button></div></div></div>
          </section>
        </div>
      </div>
      {libraryOpen && <MobileLibrary vaults={vaults} activeId={activeId} onSelect={selectVault} onUpload={() => { setLibraryOpen(false); setUploadOpen(true) }} onClose={() => setLibraryOpen(false)} />}
      {settingsOpen && <SettingsModal settings={settings} setSettings={setSettings} connected={connected} testState={testState} onTest={testConnection} onClose={() => setSettingsOpen(false)} />}
      {uploadOpen && <UploadModal files={files} uploading={uploading} progress={uploadProgress} onFiles={handleFiles} onUpload={uploadFiles} onClose={() => { if (!uploading) { setUploadOpen(false); setFiles([]) } }} />}
    </main>
  )
}

function headers(settings: SettingsState) { return { 'X-API-KEY': settings.apiKey, 'X-OWNER-TOKEN': settings.ownerToken } }

function SidebarContent({ vaults, activeId, onSelect, onUpload, onSettings, onNewChat }: { vaults: Vault[]; activeId: string; onSelect: (id: string) => void; onUpload: () => void; onSettings: () => void; onNewChat: () => void }) {
  return <><div className="flex h-[72px] items-center gap-3 border-b border-border/70 px-5"><div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_0_20px_rgba(124,58,237,0.3)]"><Zap /></div><div><p className="text-sm font-semibold tracking-tight">Obsidian RAG</p><p className="font-mono text-[10px] text-muted-foreground">vault intelligence</p></div></div><div className="flex flex-1 flex-col gap-7 p-4"><Button onClick={onUpload} className="justify-start gap-2 bg-primary text-primary-foreground"><Upload data-icon="inline-start" />Index new vault</Button><div><div className="mb-2 flex items-center justify-between px-2"><span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Vaults</span><button className="text-muted-foreground hover:text-foreground" onClick={onUpload} aria-label="Add vault"><Plus /></button></div><div className="flex flex-col gap-1">{vaults.length ? vaults.map((vault) => <button key={vault.id} onClick={() => onSelect(vault.id)} className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition ${vault.id === activeId ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}><FileText className={vault.id === activeId ? 'text-primary' : ''} /><span className="min-w-0 flex-1 truncate text-xs font-medium">{vault.name}</span><span className={`status-dot ${statusTone(vault.status)}`} /></button>) : <div className="rounded-xl border border-dashed border-border/80 px-3 py-4 text-center text-xs leading-5 text-muted-foreground">No indexed vaults yet.<br />Upload Markdown notes to begin.</div>}</div></div><div className="mt-auto flex flex-col gap-1 border-t border-border/70 pt-4"><button className="sidebar-action" onClick={onNewChat}><MessageSquare />New chat</button><button className="sidebar-action"><History />Chat history</button><button className="sidebar-action" onClick={onSettings}><Settings />Settings</button></div></div></>
}

function MessageRow({ message }: { message: Message }) { const [copied, setCopied] = useState(''); const isUser = message.role === 'user'; return <div className={`flex gap-3 ${isUser ? 'justify-end' : ''}`}><div className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${isUser ? 'order-2 bg-accent text-muted-foreground' : 'bg-primary/10 text-primary'}`}>{isUser ? <Circle /> : <Sparkles />}</div><div className={`max-w-[min(700px,calc(100%-3rem))] ${isUser ? 'items-end' : ''}`}><div className={`prose-vault rounded-2xl px-4 py-3 text-sm leading-6 ${isUser ? 'rounded-tr-sm bg-primary text-primary-foreground' : 'rounded-tl-sm border border-border/70 bg-card/70'}`}><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code({ className, children, ...props }) { const code = String(children).replace(/\n$/, ''); return <div className="relative my-3 overflow-hidden rounded-lg border border-border bg-background/70"><div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground"><span className="flex items-center gap-1"><Code2 />code</span><button onClick={() => { navigator.clipboard.writeText(code); setCopied(code) }} className="flex items-center gap-1 hover:text-foreground">{copied === code ? <Check /> : <Copy />} {copied === code ? 'Copied' : 'Copy'}</button></div><pre className="overflow-x-auto p-3 text-xs"><code className={className} {...props}>{children}</code></pre></div> } }}>{message.content}</ReactMarkdown></div>{message.sources?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{message.sources.map((source) => <button key={source.filename} className="source-badge"><FileText />{source.filename}</button>)}</div> : null}</div></div> }

function MobileLibrary({ vaults, activeId, onSelect, onUpload, onClose }: { vaults: Vault[]; activeId: string; onSelect: (id: string) => void; onUpload: () => void; onClose: () => void }) { return <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm lg:hidden"><div className="h-full w-[min(320px,88vw)] border-r border-border bg-sidebar p-4 shadow-2xl"><div className="mb-8 flex items-center justify-between"><span className="font-semibold">Vault library</span><button onClick={onClose} aria-label="Close library"><X /></button></div><SidebarContent vaults={vaults} activeId={activeId} onSelect={onSelect} onUpload={onUpload} onSettings={onClose} onNewChat={onClose} /></div></div> }

function SettingsModal({ settings, setSettings, connected, testState, onTest, onClose }: { settings: SettingsState; setSettings: React.Dispatch<React.SetStateAction<SettingsState>>; connected: boolean; testState: string; onTest: () => void; onClose: () => void }) { return <Modal title="Connection settings" icon={<Settings />} onClose={onClose}><p className="mb-6 text-sm leading-6 text-muted-foreground">Configure the local RAG server that powers your vault queries.</p><label className="field-label">Backend URL<input value={settings.backendUrl} onChange={(event) => setSettings((current) => ({ ...current, backendUrl: event.target.value }))} placeholder="http://localhost:8000" /></label><label className="field-label">API key<div className="relative"><input type="password" value={settings.apiKey} onChange={(event) => setSettings((current) => ({ ...current, apiKey: event.target.value }))} placeholder="Paste your X-API-KEY" /><KeyRound className="input-icon" /></div></label><label className="field-label">Owner token<div className="relative"><input readOnly value={settings.ownerToken} /><button className="regenerate" onClick={() => setSettings((current) => ({ ...current, ownerToken: makeToken() }))}>Regenerate</button></div></label><div className="mt-5 flex items-center justify-between rounded-xl border border-border bg-muted/20 px-3 py-2.5"><span className="flex items-center gap-2 text-xs text-muted-foreground"><span className={`status-dot ${connected ? 'success' : 'failed'}`} />{connected ? 'Server reachable' : 'Connection not tested'}</span><Button variant="outline" size="sm" onClick={onTest} disabled={testState === 'testing'}>{testState === 'testing' ? <Loader2 className="animate-spin" /> : <RefreshCw />} Test connection</Button></div><div className="mt-6 flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Done</Button></div></Modal> }

function UploadModal({ files, uploading, progress, onFiles, onUpload, onClose }: { files: File[]; uploading: boolean; progress: number; onFiles: (files: FileList | File[]) => void; onUpload: () => void; onClose: () => void }) { const input = useRef<HTMLInputElement>(null); return <Modal title="Index a new vault" icon={<CloudUpload />} onClose={onClose}><p className="mb-5 text-sm leading-6 text-muted-foreground">Drop Markdown notes here or choose a folder exported from Obsidian.</p><button onClick={() => input.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); onFiles(event.dataTransfer.files) }} className="flex min-h-44 w-full flex-col items-center justify-center rounded-2xl border border-dashed border-primary/40 bg-primary/5 px-5 text-center transition hover:bg-primary/10"><div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary"><FolderOpen /></div><span className="text-sm font-medium">Drop .md files or a folder</span><span className="mt-1 text-xs text-muted-foreground">Markdown only · Multiple files supported</span><input ref={input} type="file" multiple accept=".md,text/markdown" className="hidden" onChange={(event) => event.target.files && onFiles(event.target.files)} /></button>{files.length > 0 && <div className="mt-4 rounded-xl border border-border bg-muted/20 p-3"><div className="mb-2 flex items-center justify-between text-xs"><span className="font-medium">{files.length} Markdown file{files.length === 1 ? '' : 's'} ready</span><button onClick={() => onFiles([])} className="text-muted-foreground hover:text-foreground">Clear</button></div><div className="flex max-h-20 flex-col gap-1 overflow-y-auto text-xs text-muted-foreground">{files.slice(0, 5).map((file) => <span key={file.name} className="flex items-center gap-2"><FileText />{file.name}</span>)}</div></div>}{progress > 0 && <div className="mt-4"><div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Uploading and indexing</span><span>{progress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} /></div></div>}<div className="mt-6 flex justify-end gap-2"><Button variant="ghost" onClick={onClose} disabled={uploading}>Cancel</Button><Button onClick={onUpload} disabled={!files.length || uploading}>{uploading ? <Loader2 className="animate-spin" /> : <Upload />} {uploading ? 'Indexing...' : 'Start indexing'}</Button></div></Modal> }

function Modal({ title, icon, children, onClose }: { title: string; icon: React.ReactNode; children: React.ReactNode; onClose: () => void }) { return <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"><div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl shadow-black/40"><div className="mb-1 flex items-center justify-between"><div className="flex items-center gap-3"><div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</div><h2 className="font-semibold">{title}</h2></div><button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close"><X /></button></div>{children}</div></div> }
