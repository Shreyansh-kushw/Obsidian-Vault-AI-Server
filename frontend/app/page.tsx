'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertCircle,
  Archive,
  ArrowUp,
  Check,
  Circle,
  CircleAlert,
  CloudUpload,
  Code2,
  Copy,
  FileText,
  FolderOpen,
  FolderUp,
  History,
  KeyRound,
  Loader2,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  checkJobStatus,
  getHeaders,
  sendQnAQuery,
  testConnection,
  uploadVaultFiles,
  type SettingsState,
  type SourceItem,
  type VaultStatus,
} from '@/lib/api'

type Vault = {
  id: string
  name: string
  totalFiles: number
  status: VaultStatus
  createdAt: string
}

type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: SourceItem[]
  isError?: boolean
}

const defaultSettings: SettingsState = {
  backendUrl: process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000',
  apiKey: process.env.API_KEY || '',
  ownerToken: '',
}

const initialMessages: Message[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content:
      "Hello! I'm ready to search your Obsidian notes. Ask me anything about your documents, ideas, or projects.",
  },
]

function makeToken() {
  return `client_${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`
}

function readStore<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const item = localStorage.getItem(key)
    return item ? JSON.parse(item) : fallback
  } catch {
    return fallback
  }
}

function statusTone(status: VaultStatus) {
  return status === 'Success'
    ? 'success'
    : status === 'Failed'
      ? 'failed'
      : 'processing'
}

export default function Page() {
  const [settings, setSettings] = useState<SettingsState>(defaultSettings)
  const [vaults, setVaults] = useState<Vault[]>([])
  const [activeId, setActiveId] = useState('')
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState(false)
  const [connectionMessage, setConnectionMessage] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success' | 'error'>('idle')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const activeVault = useMemo(
    () => vaults.find((vault) => vault.id === activeId),
    [vaults, activeId]
  )

  // Load from local storage
  useEffect(() => {
    const loaded = readStore<SettingsState>('vault-rag-settings', defaultSettings)
    if (!loaded.ownerToken) {
      loaded.ownerToken = makeToken()
    }
    if (!loaded.backendUrl && process.env.NEXT_PUBLIC_BACKEND_URL) {
      loaded.backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL
    }
    if (!loaded.apiKey && process.env.API_KEY) {
      loaded.apiKey = process.env.API_KEY
    }
    setSettings(loaded)

    const savedVaults = readStore<Vault[]>('vault-rag-vaults', [])
    setVaults(savedVaults)

    const savedActive = readStore<string>('vault-rag-active', '')
    if (savedActive && savedVaults.some((v) => v.id === savedActive)) {
      setActiveId(savedActive)
    } else if (savedVaults.length > 0) {
      setActiveId(savedVaults[0].id)
    }

    setMessages(readStore<Message[]>('vault-rag-chat', initialMessages))
  }, [])

  // Persist state
  useEffect(() => {
    if (settings.ownerToken) {
      localStorage.setItem('vault-rag-settings', JSON.stringify(settings))
    }
  }, [settings])

  useEffect(() => {
    localStorage.setItem('vault-rag-vaults', JSON.stringify(vaults))
  }, [vaults])

  useEffect(() => {
    localStorage.setItem('vault-rag-active', activeId)
  }, [activeId])

  useEffect(() => {
    if (messages.length) {
      localStorage.setItem('vault-rag-chat', JSON.stringify(messages))
    }
  }, [messages])

  // Initial connection test
  useEffect(() => {
    if (!settings.backendUrl) return
    let isMounted = true

    testConnection(settings).then((res) => {
      if (!isMounted) return
      setConnected(res.ok)
      setConnectionMessage(res.message)
      setTestState(res.ok ? 'success' : 'error')
    })

    return () => {
      isMounted = false
    }
  }, [settings.backendUrl, settings.apiKey])

  // Status Polling for processing vaults
  useEffect(() => {
    const processing = vaults.filter((vault) => vault.status === 'Processing')
    if (!processing.length || !settings.backendUrl || !settings.apiKey) return

    let isMounted = true

    const poll = async () => {
      for (const vault of processing) {
        const res = await checkJobStatus(settings, vault.id)
        if (!isMounted) return

        if (res.success && ['Success', 'Failed'].includes(res.data)) {
          setVaults((current) =>
            current.map((item) =>
              item.id === vault.id ? { ...item, status: res.data } : item
            )
          )
        }
      }
    }

    poll()
    const timer = window.setInterval(poll, 4000)

    return () => {
      isMounted = false
      window.clearInterval(timer)
    }
  }, [vaults, settings])

  const suggestions = [
    'Summarize my weekly notes',
    'What tasks or action items are pending?',
    'Find key takeaways from my latest project notes',
  ]

  async function handleTestConnection() {
    setTestState('testing')
    const result = await testConnection(settings)
    setConnected(result.ok)
    setConnectionMessage(result.message)
    setTestState(result.ok ? 'success' : 'error')
  }

  async function sendQuery(value = query) {
    const text = value.trim()
    if (!text || loading) return

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
    }

    setMessages((current) => [...current, userMessage])
    setQuery('')
    setLoading(true)

    // Check configuration
    if (!settings.backendUrl || !settings.apiKey) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            '⚠️ **Backend Configuration Required**:\nPlease open **Settings** (gear icon) and set your **Backend URL** and **API Key** (`X-API-KEY`) to connect.',
          isError: true,
        },
      ])
      setLoading(false)
      return
    }

    if (!activeVault) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            '⚠️ **No Vault Selected**:\nPlease index or select a vault from the sidebar to ask questions.',
          isError: true,
        },
      ])
      setLoading(false)
      return
    }

    if (activeVault.status === 'Processing') {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            '⏳ **Vault is still indexing**:\nThis vault is currently processing your Markdown files. Please wait a moment until the status turns green (**Success**).',
          isError: true,
        },
      ])
      setLoading(false)
      return
    }

    if (activeVault.status === 'Failed') {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            '❌ **Indexing Failed**:\nThis vault failed during ingestion on the backend. Please re-upload your files as a new vault or check the backend server logs.',
          isError: true,
        },
      ])
      setLoading(false)
      return
    }

    // Call /qna
    const result = await sendQnAQuery(settings, activeVault.id, text)

    if (result.success) {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.data.answer || 'No response generated.',
          sources: result.data.sources,
        },
      ])
      setConnected(true)
    } else {
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `❌ **Query Failed**: ${result.error}`,
          isError: true,
        },
      ])
    }

    setLoading(false)
  }

  function handleFiles(incoming: FileList | File[]) {
    const list = Array.from(incoming).filter((file) =>
      file.name.toLowerCase().endsWith('.md')
    )
    setFiles((prev) => {
      const existingNames = new Set(prev.map((f) => f.name + f.size))
      const unique = list.filter((f) => !existingNames.has(f.name + f.size))
      return [...prev, ...unique]
    })
    setUploadError(null)
  }

  async function handleUpload() {
    if (!files.length) return
    setUploading(true)
    setUploadError(null)
    setUploadProgress(20)

    const timer = setInterval(() => {
      setUploadProgress((prev) => (prev < 85 ? prev + 15 : prev))
    }, 400)

    const result = await uploadVaultFiles(settings, files)
    clearInterval(timer)

    if (result.success) {
      setUploadProgress(100)
      const folderName =
        files[0].webkitRelativePath?.split('/')[0] ||
        files[0].name.replace(/\.md$/i, '') ||
        'Notes Vault'

      const vault: Vault = {
        id: result.data.job_id,
        name: folderName,
        totalFiles: files.length,
        status: 'Processing',
        createdAt: new Date().toISOString(),
      }

      setVaults((current) => [vault, ...current])
      setActiveId(vault.id)
      setConnected(true)

      window.setTimeout(() => {
        setUploadOpen(false)
        setFiles([])
        setUploadProgress(0)
        setUploadError(null)
      }, 600)
    } else {
      setUploadProgress(0)
      setUploadError(result.error)
    }

    setUploading(false)
  }

  function deleteVault(id: string, e?: React.MouseEvent) {
    e?.stopPropagation()
    const updated = vaults.filter((v) => v.id !== id)
    setVaults(updated)
    if (activeId === id) {
      setActiveId(updated.length > 0 ? updated[0].id : '')
      setMessages(initialMessages)
    }
  }

  function clearChat() {
    setMessages(initialMessages)
  }

  function selectVault(id: string) {
    setActiveId(id)
    setLibraryOpen(false)
    setMessages(initialMessages)
  }

  function resizeInput() {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen">
        {/* Desktop Sidebar */}
        <aside className="hidden w-[280px] shrink-0 border-r border-border/70 bg-sidebar/70 lg:flex lg:flex-col">
          <SidebarContent
            vaults={vaults}
            activeId={activeId}
            onSelect={selectVault}
            onDelete={deleteVault}
            onUpload={() => {
              setUploadError(null)
              setUploadOpen(true)
            }}
            onSettings={() => setSettingsOpen(true)}
            onNewChat={clearChat}
          />
        </aside>

        {/* Main Workspace */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <header className="flex h-[72px] items-center justify-between border-b border-border/70 px-4 sm:px-7">
            <div className="flex min-w-0 items-center gap-3">
              <button
                onClick={() => setLibraryOpen(true)}
                className="rounded-lg p-2 text-muted-foreground hover:bg-accent lg:hidden"
                aria-label="Open vault library"
              >
                <Menu />
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-sm font-semibold">
                    {activeVault?.name || 'Vault Workspace'}
                  </h1>
                  {activeVault && (
                    <span
                      className={`status-dot ${statusTone(activeVault.status)}`}
                      title={`Status: ${activeVault.status}`}
                    />
                  )}
                </div>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {activeVault
                    ? `job_${activeVault.id.slice(0, 16)} • ${activeVault.totalFiles} note${activeVault.totalFiles === 1 ? '' : 's'}`
                    : 'No vault selected'}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1 sm:gap-2">
              <div
                onClick={() => setSettingsOpen(true)}
                className={`mr-1 hidden cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition hover:opacity-80 sm:flex ${
                  connected
                    ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300'
                    : 'border-border bg-muted/20 text-muted-foreground'
                }`}
                title={connectionMessage || (connected ? 'Backend reachable' : 'Disconnected')}
              >
                <span
                  className={`size-1.5 rounded-full ${
                    connected ? 'bg-emerald-400' : 'bg-muted-foreground/50'
                  }`}
                />
                {connected ? 'Connected' : 'Disconnected'}
              </div>

              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSettingsOpen(true)}
                aria-label="Open settings"
                title="Settings"
              >
                <Settings />
              </Button>

              <Button
                variant="ghost"
                size="icon"
                onClick={clearChat}
                aria-label="Clear chat"
                title="Clear chat"
              >
                <Trash2 />
              </Button>

              <Button
                size="sm"
                className="hidden gap-2 bg-primary text-primary-foreground shadow-[0_0_18px_rgba(124,58,237,0.2)] sm:flex"
                onClick={() => {
                  setUploadError(null)
                  setUploadOpen(true)
                }}
              >
                <Plus data-icon="inline-start" />
                Index new vault
              </Button>
            </div>
          </header>

          {/* Chat Messages Section */}
          <section className="relative flex min-h-0 flex-1 flex-col">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(124,58,237,0.09),transparent_35%)]" />

            <div className="relative mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-y-auto px-4 py-8 sm:px-8">
              {messages.length === 1 && (
                <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center pb-8">
                  <div className="mb-8 flex items-center gap-4">
                    <div className="flex size-12 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10 text-primary shadow-[0_0_24px_rgba(124,58,237,0.16)]">
                      <Sparkles />
                    </div>
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-[0.18em] text-primary/80">
                        Vault Intelligence
                      </p>
                      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                        Ask your notes anything.
                      </h2>
                    </div>
                  </div>
                  <p className="mb-7 max-w-lg text-sm leading-6 text-muted-foreground">
                    A private hybrid retrieval layer for your Obsidian vault. Contextualize ideas,
                    cross-reference notes, and turn scattered markdown into synthesized answers.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {suggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        onClick={() => sendQuery(suggestion)}
                        className="group rounded-xl border border-border/80 bg-card/40 p-3 text-left text-xs text-muted-foreground transition hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
                      >
                        <span className="mb-4 block text-primary/70 transition group-hover:translate-x-0.5">
                          →
                        </span>
                        {suggestion}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-7">
                {messages.map((message) => (
                  <MessageRow key={message.id} message={message} />
                ))}

                {loading && (
                  <div className="flex gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Sparkles />
                    </div>
                    <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-border/70 bg-card/70 px-4 py-3 text-sm text-muted-foreground">
                      <Loader2 className="animate-spin" />
                      Searching context & reranking chunks
                      <span className="loading-dots">...</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Input Box */}
            <div className="relative mx-auto w-full max-w-3xl px-4 pb-5 sm:px-8">
              <div className="mb-2 flex items-center justify-between px-1 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Archive className="size-3.5" />
                  Target:{' '}
                  {activeVault
                    ? `${activeVault.name} (${activeVault.status})`
                    : 'No vault selected'}
                </span>
                <span className="hidden sm:inline">Enter to send · Shift + Enter for newline</span>
              </div>

              <div className="rounded-2xl border border-border bg-card/90 p-2 shadow-2xl shadow-black/20 transition focus-within:border-primary/50 focus-within:shadow-[0_0_30px_rgba(124,58,237,0.1)]">
                <textarea
                  ref={inputRef}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    resizeInput()
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === 'Enter' &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault()
                      sendQuery()
                    }
                  }}
                  rows={1}
                  placeholder={
                    activeVault
                      ? `Ask a question about "${activeVault.name}"...`
                      : 'Index or select a vault to start querying...'
                  }
                  className="max-h-40 min-h-10 w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground/60"
                />

                <div className="flex items-center justify-between px-1">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <button
                      className="rounded-md p-1.5 transition hover:bg-accent"
                      onClick={() => {
                        setUploadError(null)
                        setUploadOpen(true)
                      }}
                      title="Upload more notes"
                      aria-label="Upload notes"
                    >
                      <CloudUpload className="size-4" />
                    </button>
                    <span className="hidden sm:inline">Hybrid vector & keyword search</span>
                  </div>

                  <Button
                    size="icon"
                    onClick={() => sendQuery()}
                    disabled={!query.trim() || loading}
                    className="size-8 rounded-lg bg-primary text-primary-foreground"
                    aria-label="Send message"
                  >
                    {loading ? <Loader2 className="animate-spin" /> : <ArrowUp />}
                  </Button>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Mobile Library Modal */}
      {libraryOpen && (
        <MobileLibrary
          vaults={vaults}
          activeId={activeId}
          onSelect={selectVault}
          onDelete={deleteVault}
          onUpload={() => {
            setLibraryOpen(false)
            setUploadError(null)
            setUploadOpen(true)
          }}
          onClose={() => setLibraryOpen(false)}
        />
      )}

      {/* Settings Modal */}
      {settingsOpen && (
        <SettingsModal
          settings={settings}
          setSettings={setSettings}
          connected={connected}
          connectionMessage={connectionMessage}
          testState={testState}
          onTest={handleTestConnection}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {/* Upload Modal */}
      {uploadOpen && (
        <UploadModal
          files={files}
          uploading={uploading}
          progress={uploadProgress}
          error={uploadError}
          hasApiKey={Boolean(settings.apiKey)}
          onFiles={handleFiles}
          onClearFiles={() => setFiles([])}
          onUpload={handleUpload}
          onOpenSettings={() => {
            setUploadOpen(false)
            setSettingsOpen(true)
          }}
          onClose={() => {
            if (!uploading) {
              setUploadOpen(false)
              setFiles([])
              setUploadError(null)
            }
          }}
        />
      )}
    </main>
  )
}

function SidebarContent({
  vaults,
  activeId,
  onSelect,
  onDelete,
  onUpload,
  onSettings,
  onNewChat,
}: {
  vaults: Vault[]
  activeId: string
  onSelect: (id: string) => void
  onDelete: (id: string, e?: React.MouseEvent) => void
  onUpload: () => void
  onSettings: () => void
  onNewChat: () => void
}) {
  return (
    <>
      <div className="flex h-[72px] items-center gap-3 border-b border-border/70 px-5">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_0_20px_rgba(124,58,237,0.3)]">
          <Zap />
        </div>
        <div>
          <p className="text-sm font-semibold tracking-tight">Obsidian RAG</p>
          <p className="font-mono text-[10px] text-muted-foreground">vault intelligence</p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-6 p-4">
        <Button onClick={onUpload} className="justify-start gap-2 bg-primary text-primary-foreground">
          <Upload data-icon="inline-start" />
          Index new vault
        </Button>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center justify-between px-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Your Vaults
            </span>
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={onUpload}
              aria-label="Add vault"
              title="Add vault"
            >
              <Plus className="size-4" />
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-1 overflow-y-auto pr-1">
            {vaults.length ? (
              vaults.map((vault) => (
                <div
                  key={vault.id}
                  onClick={() => onSelect(vault.id)}
                  role="button"
                  tabIndex={0}
                  className={`group flex items-center justify-between rounded-lg px-2.5 py-2 text-left transition ${
                    vault.id === activeId
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <FileText
                      className={`size-4 shrink-0 ${vault.id === activeId ? 'text-primary' : ''}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{vault.name}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {vault.totalFiles} file{vault.totalFiles === 1 ? '' : 's'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span
                      className={`status-dot ${statusTone(vault.status)}`}
                      title={`Status: ${vault.status}`}
                    />
                    <button
                      onClick={(e) => onDelete(vault.id, e)}
                      className="opacity-0 transition hover:text-destructive group-hover:opacity-100"
                      title="Delete vault"
                      aria-label="Delete vault"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-border/80 px-3 py-6 text-center text-xs leading-5 text-muted-foreground">
                No indexed vaults yet.
                <br />
                Upload Markdown notes to begin.
              </div>
            )}
          </div>
        </div>

        <div className="mt-auto flex flex-col gap-1 border-t border-border/70 pt-4">
          <button className="sidebar-action" onClick={onNewChat}>
            <MessageSquare />
            New chat
          </button>
          <button className="sidebar-action" onClick={onSettings}>
            <Settings />
            Settings
          </button>
        </div>
      </div>
    </>
  )
}

function MessageRow({ message }: { message: Message }) {
  const [copied, setCopied] = useState('')
  const isUser = message.role === 'user'

  // Deduplicate sources by filename
  const uniqueSources = useMemo(() => {
    if (!message.sources) return []
    const seen = new Set<string>()
    return message.sources.filter((s) => {
      if (seen.has(s.filename)) return false
      seen.add(s.filename)
      return true
    })
  }, [message.sources])

  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : ''}`}>
      <div
        className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${
          isUser ? 'order-2 bg-accent text-muted-foreground' : 'bg-primary/10 text-primary'
        }`}
      >
        {isUser ? <Circle className="size-4" /> : <Sparkles className="size-4" />}
      </div>

      <div className={`max-w-[min(720px,calc(100%-3rem))] ${isUser ? 'items-end' : ''}`}>
        <div
          className={`prose-vault rounded-2xl px-4 py-3 text-sm leading-6 ${
            isUser
              ? 'rounded-tr-sm bg-primary text-primary-foreground'
              : message.isError
                ? 'rounded-tl-sm border border-destructive/40 bg-destructive/10 text-foreground'
                : 'rounded-tl-sm border border-border/70 bg-card/70'
          }`}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
                const code = String(children).replace(/\n$/, '')
                return (
                  <div className="relative my-3 overflow-hidden rounded-lg border border-border bg-background/70">
                    <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Code2 className="size-3" />
                        code
                      </span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(code)
                          setCopied(code)
                          setTimeout(() => setCopied(''), 2000)
                        }}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        {copied === code ? (
                          <>
                            <Check className="size-3 text-emerald-400" /> Copied
                          </>
                        ) : (
                          <>
                            <Copy className="size-3" /> Copy
                          </>
                        )}
                      </button>
                    </div>
                    <pre className="overflow-x-auto p-3 text-xs">
                      <code className={className} {...props}>
                        {children}
                      </code>
                    </pre>
                  </div>
                )
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
        </div>

        {uniqueSources.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
              Sources:
            </span>
            {uniqueSources.map((source, index) => (
              <span key={`${source.filename}-${index}`} className="source-badge">
                <FileText />
                {source.filename}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MobileLibrary({
  vaults,
  activeId,
  onSelect,
  onDelete,
  onUpload,
  onClose,
}: {
  vaults: Vault[]
  activeId: string
  onSelect: (id: string) => void
  onDelete: (id: string, e?: React.MouseEvent) => void
  onUpload: () => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm lg:hidden">
      <div className="h-full w-[min(320px,88vw)] border-r border-border bg-sidebar p-4 shadow-2xl">
        <div className="mb-6 flex items-center justify-between">
          <span className="font-semibold">Vault Library</span>
          <button onClick={onClose} aria-label="Close library">
            <X className="size-5" />
          </button>
        </div>
        <SidebarContent
          vaults={vaults}
          activeId={activeId}
          onSelect={onSelect}
          onDelete={onDelete}
          onUpload={onUpload}
          onSettings={onClose}
          onNewChat={onClose}
        />
      </div>
    </div>
  )
}

function SettingsModal({
  settings,
  setSettings,
  connected,
  connectionMessage,
  testState,
  onTest,
  onClose,
}: {
  settings: SettingsState
  setSettings: React.Dispatch<React.SetStateAction<SettingsState>>
  connected: boolean
  connectionMessage: string
  testState: string
  onTest: () => void
  onClose: () => void
}) {
  return (
    <Modal title="Connection Settings" icon={<Settings />} onClose={onClose}>
      <p className="mb-5 text-xs leading-5 text-muted-foreground">
        Configure the FastAPI RAG backend that processes your vault embeddings and queries.
      </p>

      <label className="field-label">
        Backend Server URL
        <input
          value={settings.backendUrl}
          onChange={(event) =>
            setSettings((current) => ({ ...current, backendUrl: event.target.value }))
          }
          placeholder="http://localhost:8000"
        />
      </label>

      <label className="field-label">
        Backend API Key (`X-API-KEY`)
        <div className="relative">
          <input
            type="password"
            value={settings.apiKey}
            onChange={(event) =>
              setSettings((current) => ({ ...current, apiKey: event.target.value }))
            }
            placeholder="Paste your backend API key"
          />
          <KeyRound className="input-icon" />
        </div>
      </label>

      <label className="field-label">
        Client Owner Token (`X-OWNER-TOKEN`)
        <div className="relative">
          <input readOnly value={settings.ownerToken} className="font-mono text-xs" />
          <button
            type="button"
            className="regenerate"
            onClick={() =>
              setSettings((current) => ({ ...current, ownerToken: makeToken() }))
            }
          >
            Regenerate
          </button>
        </div>
        <span className="mt-1 block text-[10px] text-muted-foreground">
          Isolates your ingested vaults and prevents unauthorized cross-tenant retrieval.
        </span>
      </label>

      <div className="mt-5 flex items-center justify-between rounded-xl border border-border bg-muted/20 px-3 py-2.5">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 text-xs font-medium">
            <span className={`status-dot ${connected ? 'success' : 'failed'}`} />
            {connected ? 'Connected' : 'Not Connected'}
          </span>
          {connectionMessage && (
            <span className="text-[10px] text-muted-foreground">{connectionMessage}</span>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={onTest}
          disabled={testState === 'testing'}
        >
          {testState === 'testing' ? (
            <Loader2 className="animate-spin" />
          ) : (
            <RefreshCw />
          )}
          Test Connection
        </Button>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="default" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  )
}

function UploadModal({
  files,
  uploading,
  progress,
  error,
  hasApiKey,
  onFiles,
  onClearFiles,
  onUpload,
  onOpenSettings,
  onClose,
}: {
  files: File[]
  uploading: boolean
  progress: number
  error: string | null
  hasApiKey: boolean
  onFiles: (files: FileList | File[]) => void
  onClearFiles: () => void
  onUpload: () => void
  onOpenSettings: () => void
  onClose: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  return (
    <Modal title="Index a New Vault" icon={<CloudUpload />} onClose={onClose}>
      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        Select Markdown notes or an entire exported Obsidian folder to index into the vector
        database.
      </p>

      {!hasApiKey && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 shrink-0 text-amber-400" />
            <span>API Key missing in Settings</span>
          </div>
          <button
            onClick={onOpenSettings}
            className="font-medium text-amber-300 underline hover:text-amber-100"
          >
            Configure
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          if (event.dataTransfer.files) {
            onFiles(event.dataTransfer.files)
          }
        }}
        className="flex min-h-40 w-full flex-col items-center justify-center rounded-2xl border border-dashed border-primary/40 bg-primary/5 px-5 text-center transition hover:bg-primary/10"
      >
        <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <FolderOpen className="size-6" />
        </div>
        <span className="text-sm font-medium">Drag & drop Markdown notes here</span>
        <span className="mt-1 text-xs text-muted-foreground">
          Supports .md notes and folder trees (Max 25MB per upload)
        </span>

        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            size="xs"
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            <FileText className="size-3" /> Select Files
          </Button>

          <Button
            variant="outline"
            size="xs"
            type="button"
            onClick={() => folderInputRef.current?.click()}
          >
            <FolderUp className="size-3" /> Select Folder
          </Button>
        </div>

        {/* Hidden inputs */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".md,text/markdown"
          className="hidden"
          onChange={(event) => {
            if (event.target.files) onFiles(event.target.files)
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory is standard in all modern browsers
          webkitdirectory=""
          className="hidden"
          onChange={(event) => {
            if (event.target.files) onFiles(event.target.files)
          }}
        />
      </div>

      {files.length > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-muted/20 p-3">
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="font-medium">
              {files.length} Markdown file{files.length === 1 ? '' : 's'} selected
            </span>
            <button
              onClick={onClearFiles}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
          <div className="flex max-h-24 flex-col gap-1 overflow-y-auto pr-1 text-xs text-muted-foreground">
            {files.slice(0, 8).map((file, i) => (
              <span key={`${file.name}-${i}`} className="flex items-center gap-2 truncate">
                <FileText className="size-3.5 shrink-0 text-primary/70" />
                <span className="truncate">{file.name}</span>
              </span>
            ))}
            {files.length > 8 && (
              <span className="text-[10px] italic text-muted-foreground">
                + {files.length - 8} more files...
              </span>
            )}
          </div>
        </div>
      )}

      {progress > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
            <span>Uploading & Indexing</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={uploading}>
          Cancel
        </Button>
        <Button onClick={onUpload} disabled={!files.length || uploading}>
          {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
          {uploading ? 'Ingesting Vault...' : 'Start Ingestion'}
        </Button>
      </div>
    </Modal>
  )
}

function Modal({
  title,
  icon,
  children,
  onClose,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl shadow-black/40">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {icon}
            </div>
            <h2 className="font-semibold">{title}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
