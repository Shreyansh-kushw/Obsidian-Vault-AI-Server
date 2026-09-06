import type { SourceItem } from './api'

export type Message = {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: SourceItem[]
  isError?: boolean
}

export type ChatSession = {
  id: string
  vaultId: string
  title: string
  createdAt: string
  updatedAt: string
  messages: Message[]
}

const STORAGE_KEY = 'vault-rag-chat-sessions'
const VAULT_CHATS_KEY_PREFIX = 'vault-rag-chat-history-'

export const defaultWelcomeMessage: Message = {
  id: 'welcome',
  role: 'assistant',
  content:
    "Hello! I'm ready to search your Obsidian notes. Ask me anything about your documents, ideas, or projects.",
}

/**
 * Read all chat sessions from localStorage
 */
export function getSavedSessions(): ChatSession[] {
  if (typeof window === 'undefined') return []
  try {
    const data = localStorage.getItem(STORAGE_KEY)
    if (!data) return []
    const parsed = JSON.parse(data)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Save all sessions to localStorage
 */
export function saveSessions(sessions: ChatSession[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
  } catch (err) {
    console.warn('Failed to save chat sessions to localStorage:', err)
  }
}

/**
 * Read chat messages directly for a specific vault
 */
export function getVaultMessages(vaultId: string): Message[] | null {
  if (typeof window === 'undefined' || !vaultId || !vaultId.trim()) return null

  const cleanVaultId = vaultId.trim()

  // 1. Check direct vault key for conversation
  try {
    const data = localStorage.getItem(`${VAULT_CHATS_KEY_PREFIX}${cleanVaultId}`)
    if (data) {
      const parsed = JSON.parse(data)
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed
      }
    }
  } catch (err) {
    console.warn('Failed to read vault messages from localStorage:', err)
  }

  // 2. Search in sessions list strictly for this specific vault
  const sessions = getSavedSessions()
  const matching = sessions.filter((s) => s.vaultId === cleanVaultId)
  for (const s of matching) {
    if (s.messages && s.messages.length > 0) {
      return s.messages
    }
  }

  return null
}

/**
 * Save chat messages directly for a specific vault
 */
export function saveVaultMessages(vaultId: string, messages: Message[]): void {
  if (typeof window === 'undefined' || !vaultId || !vaultId.trim()) return
  try {
    localStorage.setItem(
      `${VAULT_CHATS_KEY_PREFIX}${vaultId.trim()}`,
      JSON.stringify(messages)
    )
  } catch (err) {
    console.warn('Failed to save vault messages to localStorage:', err)
  }
}

/**
 * Get or create an active chat session for a given vault
 */
export function getOrCreateActiveSession(
  vaultId: string,
  preferredSessionId?: string
): { session: ChatSession; allSessions: ChatSession[] } {
  const allSessions = getSavedSessions()
  const cleanVaultId = vaultId?.trim() || ''

  // If no vault is specified, return a transient fresh session without mixing vaults
  if (!cleanVaultId) {
    const noVaultSession: ChatSession = {
      id: 'no-vault',
      vaultId: '',
      title: 'No Vault Selected',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [defaultWelcomeMessage],
    }
    return { session: noVaultSession, allSessions }
  }

  if (preferredSessionId) {
    const existing = allSessions.find(
      (s) => s.id === preferredSessionId && s.vaultId === cleanVaultId
    )
    if (existing) {
      return { session: existing, allSessions }
    }
  }

  // Find most recent session strictly for this vault
  const vaultSessions = allSessions.filter((s) => s.vaultId === cleanVaultId)
  if (vaultSessions.length > 0) {
    vaultSessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    const session = vaultSessions[0]
    const directMsgs = getVaultMessages(cleanVaultId)
    if (directMsgs && directMsgs.length > 0) {
      session.messages = directMsgs
    }
    return { session, allSessions }
  }

  // Check if direct vault messages exist
  const directMsgs = getVaultMessages(cleanVaultId)
  const initialMessages =
    directMsgs && directMsgs.length > 0 ? directMsgs : [defaultWelcomeMessage]

  // Create brand new session for this vault
  const newSession: ChatSession = {
    id: crypto.randomUUID(),
    vaultId: cleanVaultId,
    title: 'New conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: initialMessages,
  }

  const updatedSessions = [newSession, ...allSessions]
  saveSessions(updatedSessions)
  saveVaultMessages(cleanVaultId, initialMessages)
  return { session: newSession, allSessions: updatedSessions }
}

/**
 * Create a new chat session for a vault
 */
export function createNewSession(vaultId: string): {
  session: ChatSession
  allSessions: ChatSession[]
} {
  const allSessions = getSavedSessions()
  const cleanVaultId = vaultId?.trim() || ''
  const newSession: ChatSession = {
    id: crypto.randomUUID(),
    vaultId: cleanVaultId,
    title: 'New conversation',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [defaultWelcomeMessage],
  }
  const updatedSessions = [newSession, ...allSessions]
  saveSessions(updatedSessions)
  if (cleanVaultId) {
    saveVaultMessages(cleanVaultId, [defaultWelcomeMessage])
  }
  return { session: newSession, allSessions: updatedSessions }
}

/**
 * Update messages for a specific session and vault
 */
export function updateSessionMessages(
  sessionId: string,
  messages: Message[],
  vaultId?: string
): ChatSession[] {
  const allSessions = getSavedSessions()
  const cleanVaultId = vaultId?.trim() || ''
  const index = allSessions.findIndex((s) => s.id === sessionId)

  if (cleanVaultId) {
    saveVaultMessages(cleanVaultId, messages)
  }

  let title = 'New conversation'
  const firstUserMsg = messages.find((m) => m.role === 'user')
  if (firstUserMsg) {
    title =
      firstUserMsg.content.slice(0, 42).trim() +
      (firstUserMsg.content.length > 42 ? '...' : '')
  }

  if (index === -1) {
    if (!sessionId || sessionId === 'no-vault') {
      return allSessions
    }
    const newSession: ChatSession = {
      id: sessionId,
      vaultId: cleanVaultId,
      title,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages,
    }
    const updated = [newSession, ...allSessions]
    saveSessions(updated)
    return updated
  }

  const session = allSessions[index]
  const updatedSession: ChatSession = {
    ...session,
    vaultId: cleanVaultId || session.vaultId,
    title: session.title === 'New conversation' ? title : session.title,
    messages,
    updatedAt: new Date().toISOString(),
  }

  allSessions[index] = updatedSession
  saveSessions(allSessions)
  return allSessions
}

/**
 * Delete a chat session
 */
export function deleteSession(sessionId: string): ChatSession[] {
  const allSessions = getSavedSessions()
  const session = allSessions.find((s) => s.id === sessionId)
  const filtered = allSessions.filter((s) => s.id !== sessionId)
  saveSessions(filtered)
  if (session?.vaultId) {
    try {
      localStorage.removeItem(`${VAULT_CHATS_KEY_PREFIX}${session.vaultId}`)
    } catch {}
  }
  return filtered
}

/**
 * Clear all messages in a session
 */
export function resetSession(sessionId: string, vaultId?: string): ChatSession[] {
  const cleanVaultId = vaultId?.trim() || ''
  if (cleanVaultId) {
    saveVaultMessages(cleanVaultId, [defaultWelcomeMessage])
  }
  return updateSessionMessages(sessionId, [defaultWelcomeMessage], cleanVaultId)
}
