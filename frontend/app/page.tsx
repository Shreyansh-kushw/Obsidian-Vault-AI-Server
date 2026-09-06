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
  ExternalLink,
  FileText,
  FolderOpen,
  FolderUp,
  Info,
  KeyRound,
  Loader2,
  Menu,
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
  fetchBackendJobs,
  fetchDiscoveredVaults,
  getHeaders,
  sendQnAQuery,
  testConnection,
  uploadVaultFiles,
  type DiscoveredVault,
  type SettingsState,
  type SourceItem,
  type VaultStatus,
} from '@/lib/api'
import {
  createNewSession,
  defaultWelcomeMessage,
  deleteSession,
  getOrCreateActiveSession,
  getSavedSessions,
  getVaultMessages,
  resetSession,
  saveVaultMessages,
  updateSessionMessages,
  type ChatSession,
  type Message,
} from '@/lib/chat-storage'

type Vault = {
  id: string
  name: string
  localVaultPath?: string
  totalFiles: number
  status: VaultStatus
  createdAt: string
}

const defaultSettings: SettingsState = {
  backendUrl: process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000',
  apiKey: process.env.API_KEY || '',
  ownerToken: '',
}

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
  const [vaultsLoading, setVaultsLoading] = useState(true)
  const [activeId, setActiveId] = useState('')
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string>('')
  const [messages, setMessages] = useState<Message[]>([defaultWelcomeMessage])
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
  const isHydrated = useRef(false)

  const activeVault = useMemo(
    () => vaults.find((vault) => vault.id === activeId),
    [vaults, activeId]
  )

  // Load from local storage and backend
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
    let chosenActive = ''
    if (savedActive && savedVaults.some((v) => v.id === savedActive)) {
      chosenActive = savedActive
      setActiveId(savedActive)
    } else if (savedVaults.length > 0) {
      chosenActive = savedVaults[0].id
      setActiveId(savedVaults[0].id)
    } else {
      chosenActive = ''
      setActiveId('')
    }

    // Load messages from direct vault store or sessions
    if (chosenActive) {
      const vMsgs = getVaultMessages(chosenActive)
      const { session, allSessions } = getOrCreateActiveSession(chosenActive)
      setChatSessions(allSessions)
      setCurrentSessionId(session.id)
      setMessages(vMsgs && vMsgs.length > 0 ? vMsgs : session.messages)
    } else {
      setChatSessions([])
      setCurrentSessionId('')
      setMessages([defaultWelcomeMessage])
    }

    isHydrated.current = true

    // Try syncing any jobs from backend if GET /jobs is available
    if (loaded.backendUrl && loaded.apiKey && loaded.ownerToken) {
      fetchBackendJobs(loaded)
        .then((res) => {
          if (res.success && res.data.length > 0) {
            setVaults((current) => {
              const currentMap = new Map(current.map((v) => [v.id, v]))
              for (const item of res.data) {
                const id = item.id || item.job_id || ''
                if (!id) continue
                if (!currentMap.has(id)) {
                  currentMap.set(id, {
                    id,
                    name: item.name || item.job_name || `Vault ${id.slice(0, 8)}`,
                    localVaultPath: item.local_vault_path || item.localVaultPath,
                    totalFiles: item.totalFiles || item.total_files || 1,
                    status: item.status || 'Success',
                    createdAt: item.createdAt || item.created_at || new Date().toISOString(),
                  })
                }
              }
              const merged = Array.from(currentMap.values())
              if (!chosenActive && merged.length > 0) {
                const firstId = merged[0].id
                setActiveId(firstId)
                const firstMsgs = getVaultMessages(firstId)
                const { session: firstSession, allSessions } = getOrCreateActiveSession(firstId)
                setChatSessions(allSessions)
                setCurrentSessionId(firstSession.id)
                setMessages(firstMsgs && firstMsgs.length > 0 ? firstMsgs : firstSession.messages)
              }
              return merged
            })
          }
        })
        .finally(() => {
          setVaultsLoading(false)
        })
    } else {
      setVaultsLoading(false)
    }
  }, [])

  // Persist settings, vaults, activeId
  useEffect(() => {
    if (!isHydrated.current) return
    if (settings.ownerToken) {
      localStorage.setItem('vault-rag-settings', JSON.stringify(settings))
    }
  }, [settings])

  useEffect(() => {
    if (!isHydrated.current) return
    localStorage.setItem('vault-rag-vaults', JSON.stringify(vaults))
  }, [vaults])

  useEffect(() => {
    if (!isHydrated.current) return
    localStorage.setItem('vault-rag-active', activeId)
  }, [activeId])

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

    const updatedWithUser = [...messages, userMessage]
    setMessages(updatedWithUser)
    if (activeId) {
      saveVaultMessages(activeId, updatedWithUser)
    }
    if (currentSessionId) {
      setChatSessions(updateSessionMessages(currentSessionId, updatedWithUser, activeId))
    }
    setQuery('')
    setLoading(true)

    // Check configuration
    if (!settings.backendUrl || !settings.apiKey) {
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          '⚠️ **Backend Configuration Required**:\nPlease open **Settings** (gear icon) and set your **Backend URL** and **API Key** (`X-API-KEY`) to connect.',
        isError: true,
      }
      const nextMsgs = [...updatedWithUser, errorMsg]
      setMessages(nextMsgs)
      if (activeId) {
        saveVaultMessages(activeId, nextMsgs)
      }
      if (currentSessionId) {
        setChatSessions(updateSessionMessages(currentSessionId, nextMsgs, activeId))
      }
      setLoading(false)
      return
    }

    if (!activeVault) {
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          '⚠️ **No Vault Selected**:\nPlease index or select a vault from the sidebar to ask questions.',
        isError: true,
      }
      const nextMsgs = [...updatedWithUser, errorMsg]
      setMessages(nextMsgs)
      if (activeId) {
        saveVaultMessages(activeId, nextMsgs)
      }
      if (currentSessionId) {
        setChatSessions(updateSessionMessages(currentSessionId, nextMsgs, activeId))
      }
      setLoading(false)
      return
    }

    if (activeVault.status === 'Processing') {
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          '⏳ **Vault is still indexing**:\nThis vault is currently processing your Markdown files. Please wait a moment until the status turns green (**Success**).',
        isError: true,
      }
      const nextMsgs = [...updatedWithUser, errorMsg]
      setMessages(nextMsgs)
      if (activeId) {
        saveVaultMessages(activeId, nextMsgs)
      }
      if (currentSessionId) {
        setChatSessions(updateSessionMessages(currentSessionId, nextMsgs, activeId))
      }
      setLoading(false)
      return
    }

    if (activeVault.status === 'Failed') {
      const errorMsg: Message = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          '❌ **Indexing Failed**:\nThis vault failed during ingestion on the backend. Please re-upload your files as a new vault or check the backend server logs.',
        isError: true,
      }
      const nextMsgs = [...updatedWithUser, errorMsg]
      setMessages(nextMsgs)
      if (activeId) {
        saveVaultMessages(activeId, nextMsgs)
      }
      if (currentSessionId) {
        setChatSessions(updateSessionMessages(currentSessionId, nextMsgs, activeId))
      }
      setLoading(false)
      return
    }

    // Call /qna
    const result = await sendQnAQuery(settings, activeVault.id, text)

    let nextMessages: Message[]
    if (result.success) {
      nextMessages = [
        ...updatedWithUser,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: result.data.answer || 'No response generated.',
          sources: result.data.sources,
        },
      ]
      setConnected(true)
    } else {
      nextMessages = [
        ...updatedWithUser,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `❌ **Query Failed**: ${result.error}`,
          isError: true,
        },
      ]
    }

    setMessages(nextMessages)
    if (activeId) {
      saveVaultMessages(activeId, nextMessages)
    }
    if (currentSessionId) {
      setChatSessions(updateSessionMessages(currentSessionId, nextMessages, activeId))
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

  async function handleUpload(customName?: string, customLocalPath?: string) {
    if (!files.length) return
    setUploading(true)
    setUploadError(null)
    setUploadProgress(20)

    const timer = setInterval(() => {
      setUploadProgress((prev) => (prev < 85 ? prev + 15 : prev))
    }, 400)

    const detectedName =
      files[0].webkitRelativePath?.split('/')[0] ||
      files[0].name.replace(/\.md$/i, '') ||
      'Notes Vault'
    const finalName = customName?.trim() || detectedName
    const finalLocalPath = customLocalPath?.trim() || undefined

    const result = await uploadVaultFiles(settings, files, finalName, finalLocalPath)
    clearInterval(timer)

    if (result.success) {
      setUploadProgress(100)

      const vault: Vault = {
        id: result.data.job_id,
        name: finalName,
        localVaultPath: finalLocalPath,
        totalFiles: files.length,
        status: 'Processing',
        createdAt: new Date().toISOString(),
      }

      setVaults((current) => [vault, ...current])
      setActiveId(vault.id)
      setConnected(true)

      const { session, allSessions } = createNewSession(vault.id)
      setChatSessions(allSessions)
      setCurrentSessionId(session.id)
      setMessages(session.messages)
      saveVaultMessages(vault.id, session.messages)

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
    try {
      localStorage.removeItem(`vault-rag-chat-history-${id}`)
    } catch {}
    if (activeId === id) {
      const nextActive = updated.length > 0 ? updated[0].id : ''
      setActiveId(nextActive)
      if (nextActive) {
        const nextMsgs = getVaultMessages(nextActive)
        const { session, allSessions } = getOrCreateActiveSession(nextActive)
        setChatSessions(allSessions)
        setCurrentSessionId(session.id)
        setMessages(nextMsgs && nextMsgs.length > 0 ? nextMsgs : session.messages)
      } else {
        setCurrentSessionId('')
        setMessages([defaultWelcomeMessage])
      }
    }
  }

  function clearChat() {
    setMessages([defaultWelcomeMessage])
    if (activeId) {
      saveVaultMessages(activeId, [defaultWelcomeMessage])
    }
    if (currentSessionId) {
      const updated = resetSession(currentSessionId, activeId)
      setChatSessions(updated)
    }
  }

  function selectVault(id: string) {
    if (id === activeId) return

    // Save previous active vault chat
    if (activeId && messages.length > 0) {
      saveVaultMessages(activeId, messages)
      if (currentSessionId) {
        updateSessionMessages(currentSessionId, messages, activeId)
      }
    }

    setActiveId(id)
    setLibraryOpen(false)

    // Load messages for selected vault
    if (id) {
      const savedForVault = getVaultMessages(id)
      const { session, allSessions } = getOrCreateActiveSession(id)
      setChatSessions(allSessions)
      setCurrentSessionId(session.id)

      if (savedForVault && savedForVault.length > 0) {
        setMessages(savedForVault)
      } else {
        setMessages(session.messages)
      }
    } else {
      setChatSessions([])
      setCurrentSessionId('')
      setMessages([defaultWelcomeMessage])
    }
  }

  function resizeInput() {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 160)}px`
    }
  }

  return (
    <main className="h-screen w-screen overflow-hidden bg-background text-foreground flex flex-col">
      <div className="flex flex-1 h-full w-full overflow-hidden">
        {/* Desktop Sidebar */}
        <aside className="hidden w-[280px] shrink-0 border-r border-border/70 bg-sidebar/70 lg:flex lg:flex-col h-full overflow-hidden">
          <SidebarContent
            vaults={vaults}
            loadingVaults={vaultsLoading}
            activeId={activeId}
            onSelect={selectVault}
            onDelete={deleteVault}
            onUpload={() => {
              setUploadError(null)
              setUploadOpen(true)
            }}
          />
        </aside>

        {/* Main Workspace */}
        <div className="flex min-w-0 flex-1 flex-col h-full overflow-hidden">
          {/* Header */}
          <header className="shrink-0 flex h-[72px] items-center justify-between border-b border-border/70 px-4 sm:px-7">
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
            </div>
          </header>

          {/* Chat Messages Section */}
          <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(124,58,237,0.09),transparent_35%)]" />

            {/* Scrollable Chat Area touching right edge of viewport */}
            <div className="flex-1 w-full overflow-y-auto min-h-0">
              <div className="relative mx-auto flex w-full max-w-4xl flex-col px-4 py-8 sm:px-8">
                {messages.length === 1 && (
                  <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center pb-8">
                    <div className="mb-6 flex items-center gap-4">
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
                    <p className="max-w-lg text-sm leading-6 text-muted-foreground">
                      A private hybrid retrieval layer for your Obsidian vault. Contextualize ideas,
                      cross-reference notes, and turn scattered markdown into synthesized answers.
                    </p>
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
            </div>

            {/* Fixed Search Bar at Bottom */}
            <div className="shrink-0 relative mx-auto w-full max-w-3xl px-4 pb-5 sm:px-8">
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
                    className="size-8 rounded-lg bg-primary text-primary-foreground shadow-sm transition hover:opacity-90 disabled:opacity-30"
                    aria-label="Send message"
                  >
                    <ArrowUp className="size-4" />
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
          loadingVaults={vaultsLoading}
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
          settings={settings}
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
  loadingVaults,
  activeId,
  onSelect,
  onDelete,
  onUpload,
}: {
  vaults: Vault[]
  loadingVaults?: boolean
  activeId: string
  onSelect: (id: string) => void
  onDelete: (id: string, e?: React.MouseEvent) => void
  onUpload: () => void
}) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 flex h-[72px] items-center gap-3 border-b border-border/70 px-5">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-[0_0_20px_rgba(124,58,237,0.3)]">
          <Zap />
        </div>
        <div>
          <p className="text-sm font-semibold tracking-tight">Obsidian RAG</p>
          <p className="font-mono text-[10px] text-muted-foreground">vault intelligence</p>
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden min-h-0 gap-5 p-4">
        <div className="shrink-0">
          <Button onClick={onUpload} className="w-full justify-start gap-2 bg-primary text-primary-foreground">
            <Upload data-icon="inline-start" />
            Index new vault
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 mb-2 flex items-center justify-between px-2">
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

          <div className="flex flex-1 flex-col gap-1 overflow-y-auto min-h-0 pr-1">
            {loadingVaults ? (
              <div className="flex flex-col gap-2 p-1">
                <div className="flex items-center gap-2.5 rounded-lg border border-border/40 bg-card/40 p-2 animate-pulse">
                  <div className="size-4 shrink-0 rounded bg-muted/80" />
                  <div className="flex-1 space-y-1.5 min-w-0">
                    <div className="h-3 w-3/4 rounded bg-muted/80" />
                    <div className="h-2 w-1/2 rounded bg-muted/60" />
                  </div>
                  <div className="size-2 rounded-full bg-amber-400/40" />
                </div>
                <div className="flex items-center gap-2.5 rounded-lg border border-border/40 bg-card/40 p-2 animate-pulse opacity-70">
                  <div className="size-4 shrink-0 rounded bg-muted/80" />
                  <div className="flex-1 space-y-1.5 min-w-0">
                    <div className="h-3 w-2/3 rounded bg-muted/80" />
                    <div className="h-2 w-1/3 rounded bg-muted/60" />
                  </div>
                  <div className="size-2 rounded-full bg-muted/60" />
                </div>
                <div className="flex items-center gap-2.5 rounded-lg border border-border/40 bg-card/40 p-2 animate-pulse opacity-40">
                  <div className="size-4 shrink-0 rounded bg-muted/80" />
                  <div className="flex-1 space-y-1.5 min-w-0">
                    <div className="h-3 w-1/2 rounded bg-muted/80" />
                    <div className="h-2 w-1/4 rounded bg-muted/60" />
                  </div>
                  <div className="size-2 rounded-full bg-muted/60" />
                </div>
              </div>
            ) : vaults.length ? (
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
      </div>
    </div>
  )
}

function CodeBlock({ children, ...props }: React.ComponentPropsWithoutRef<'pre'>) {
  const [copied, setCopied] = useState(false)

  const extractText = (node: React.ReactNode): string => {
    if (typeof node === 'string') return node
    if (typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(extractText).join('')
    if (node && typeof node === 'object' && 'props' in node) {
      // @ts-expect-error accessing child props
      return extractText(node.props?.children)
    }
    return ''
  }

  const rawCode = extractText(children).replace(/\n$/, '')

  return (
    <div className="relative my-3 overflow-hidden rounded-lg border border-border bg-background/70">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Code2 className="size-3" />
          code
        </span>
        <button
          type="button"
          onClick={() => {
            if (rawCode) {
              navigator.clipboard.writeText(rawCode)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }
          }}
          className="flex items-center gap-1 hover:text-foreground"
        >
          {copied ? (
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
      <pre className="overflow-x-auto p-3 text-xs" {...props}>
        {children}
      </pre>
    </div>
  )
}

function MessageRow({ message }: { message: Message }) {
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
              pre: CodeBlock,
              code({ className, children, ...props }) {
                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
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
  loadingVaults,
  activeId,
  onSelect,
  onDelete,
  onUpload,
  onClose,
}: {
  vaults: Vault[]
  loadingVaults?: boolean
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
          loadingVaults={loadingVaults}
          activeId={activeId}
          onSelect={onSelect}
          onDelete={onDelete}
          onUpload={onUpload}
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
  const initialSettingsRef = useRef<string>(JSON.stringify(settings))

  function handleCloseOrDone() {
    const currentSettingsStr = JSON.stringify(settings)
    if (currentSettingsStr !== initialSettingsRef.current) {
      localStorage.setItem('vault-rag-settings', currentSettingsStr)
      window.location.reload()
    } else {
      onClose()
    }
  }

  return (
    <Modal title="Connection Settings" icon={<Settings />} onClose={handleCloseOrDone}>
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
        <Button variant="default" onClick={handleCloseOrDone}>
          Done
        </Button>
      </div>
    </Modal>
  )
}

function UploadModal({
  settings,
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
  settings: SettingsState
  files: File[]
  uploading: boolean
  progress: number
  error: string | null
  hasApiKey: boolean
  onFiles: (files: FileList | File[]) => void
  onClearFiles: () => void
  onUpload: (customName?: string, customLocalPath?: string) => void
  onOpenSettings: () => void
  onClose: () => void
}) {
  const folderInputRef = useRef<HTMLInputElement>(null)
  const [vaultName, setVaultName] = useState('')
  const [localVaultPath, setLocalVaultPath] = useState('')
  const [discoveredVaults, setDiscoveredVaults] = useState<DiscoveredVault[]>([])

  // Fetch discovered vaults from server on mount
  useEffect(() => {
    fetchDiscoveredVaults(settings)
      .then((res) => {
        if (res.success && res.data.length > 0) {
          setDiscoveredVaults(res.data)
        }
      })
      .catch(() => {})
  }, [settings])

  useEffect(() => {
    if (files.length > 0) {
      const defaultName =
        files[0].webkitRelativePath?.split('/')[0] ||
        files[0].name.replace(/\.md$/i, '') ||
        'Notes Vault'
      setVaultName(defaultName)

      // Try matching detected folder name with discovered vaults
      const matched = discoveredVaults.find(
        (dv) =>
          dv.name.toLowerCase() === defaultName.toLowerCase() ||
          defaultName.toLowerCase().includes(dv.name.toLowerCase()) ||
          dv.name.toLowerCase().includes(defaultName.toLowerCase())
      )

      if (matched) {
        setLocalVaultPath(matched.path)
      } else if (discoveredVaults.length === 1) {
        setLocalVaultPath(discoveredVaults[0].path)
      }
    } else {
      setVaultName('')
      setLocalVaultPath('')
    }
  }, [files, discoveredVaults])

  return (
    <Modal title="Index Obsidian Vault" icon={<CloudUpload />} onClose={onClose}>
      <p className="mb-4 text-xs leading-5 text-muted-foreground">
        Select your Obsidian vault directory to ingest notes, graph relationships, and chunks into the server.
      </p>

      {/* Detected Obsidian Vaults Fast-Selector */}
      {discoveredVaults.length > 0 && (
        <div className="mb-4 rounded-xl border border-violet-500/30 bg-violet-500/10 p-3 text-xs">
          <div className="mb-2 flex items-center justify-between text-violet-300 font-semibold">
            <span className="flex items-center gap-1.5">
              <Sparkles className="size-3.5 text-violet-400" />
              Detected Obsidian Vaults:
            </span>
            <span className="text-[10px] text-muted-foreground font-normal">1-click select</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {discoveredVaults.map((dv) => {
              const isSelected = localVaultPath === dv.path
              return (
                <button
                  key={dv.path}
                  type="button"
                  onClick={() => {
                    setLocalVaultPath(dv.path)
                    if (!vaultName || vaultName === 'Notes Vault') {
                      setVaultName(dv.name)
                    }
                  }}
                  className={`flex items-center justify-between rounded-lg p-2 text-left transition border ${
                    isSelected
                      ? 'bg-violet-600/30 border-violet-400/50 text-white'
                      : 'bg-card/60 border-border/40 text-muted-foreground hover:bg-card hover:text-foreground'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-xs text-foreground">{dv.name}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{dv.path}</p>
                  </div>
                  {isSelected && <Check className="size-3.5 text-emerald-400 shrink-0 ml-2" />}
                </button>
              )
            })}
          </div>
        </div>
      )}

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
        <span className="text-sm font-medium">Drag & drop your Obsidian vault folder here</span>
        <span className="mt-1 text-xs text-muted-foreground">
          Select root Obsidian vault directory (Max 25MB per upload)
        </span>

        <div className="mt-4 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => folderInputRef.current?.click()}
          >
            <FolderUp className="size-4" /> Select Vault Folder
          </Button>
        </div>

        {/* Hidden folder input */}
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
        <div className="mt-4 flex flex-col gap-3">
          <label className="field-label">
            Vault Name
            <input
              value={vaultName}
              onChange={(e) => setVaultName(e.target.value)}
              placeholder="e.g. My Obsidian Notes"
            />
          </label>

          <label className="field-label">
            <span className="flex items-center justify-between">
              <span>Local Vault Path</span>
              <span className="text-[10px] font-normal text-emerald-400/90">✨ Auto-detected & editable</span>
            </span>
            <input
              value={localVaultPath}
              onChange={(e) => setLocalVaultPath(e.target.value)}
              placeholder="e.g. /home/username/Documents/Obsidian/MyVault"
            />
          </label>

          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between text-xs">
              <span className="font-medium">
                {files.length} Markdown file{files.length === 1 ? '' : 's'} found in folder
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
                  <span className="truncate">{file.webkitRelativePath || file.name}</span>
                </span>
              ))}
              {files.length > 8 && (
                <span className="text-[10px] italic text-muted-foreground">
                  + {files.length - 8} more files...
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {progress > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between text-xs text-muted-foreground">
            <span>Uploading & Ingesting Vault</span>
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
        <Button onClick={() => onUpload(vaultName, localVaultPath)} disabled={!files.length || uploading}>
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
