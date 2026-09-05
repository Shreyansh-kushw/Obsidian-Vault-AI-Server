export type VaultStatus = 'Processing' | 'Success' | 'Failed'

export type SettingsState = {
  backendUrl: string
  apiKey: string
  ownerToken: string
}

export type SourceItem = {
  filename: string
}

export type QnAResponse = {
  answer: string
  sources?: SourceItem[]
}

export type UploadResponse = {
  job_id: string
  message: string
}

export type ApiResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; statusCode?: number }

export function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function getHeaders(settings: SettingsState): Record<string, string> {
  const headers: Record<string, string> = {}
  if (settings.apiKey) {
    headers['X-API-KEY'] = settings.apiKey
  }
  if (settings.ownerToken) {
    headers['X-OWNER-TOKEN'] = settings.ownerToken
  }
  return headers
}

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return `${fallback} (HTTP ${response.status})`
    try {
      const json = JSON.parse(text)
      if (json.detail) {
        if (typeof json.detail === 'string') return json.detail
        if (Array.isArray(json.detail)) {
          return json.detail.map((d: { msg?: string }) => d.msg || JSON.stringify(d)).join(', ')
        }
        return JSON.stringify(json.detail)
      }
      if (json.message) return json.message
    } catch {
      return text.length < 150 ? text : `${fallback} (HTTP ${response.status})`
    }
  } catch {
    // fallback
  }
  return `${fallback} (HTTP ${response.status})`
}

/**
 * Test connectivity to the backend server.
 * Handles FastAPI /health, /, or /docs checks gracefully.
 */
export async function testConnection(
  settings: SettingsState
): Promise<{ ok: boolean; message: string; statusCode?: number }> {
  if (!settings.backendUrl) {
    return { ok: false, message: 'Backend URL is required.' }
  }

  const base = normalizeUrl(settings.backendUrl)

  // Try /health first, then / or /docs
  const endpointsToTry = ['/health', '/', '/docs']
  
  for (const endpoint of endpointsToTry) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 4000)

      const response = await fetch(`${base}${endpoint}`, {
        method: 'GET',
        headers: getHeaders(settings),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      // 200, 204, or 404/405 from FastAPI indicates the server is active and reachable
      if (response.ok) {
        return { ok: true, message: 'Server reachable & connected', statusCode: response.status }
      }
      
      if (response.status === 401) {
        return {
          ok: false,
          message: 'Server reachable, but API Key is invalid (HTTP 401).',
          statusCode: 401,
        }
      }

      if (response.status === 404 || response.status === 405) {
        // Server is running and responding with HTTP status codes
        return {
          ok: true,
          message: 'Server reachable (Obsidian Vault AI Server)',
          statusCode: response.status,
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        continue
      }
      // If endpoint failed with network error, continue loop
    }
  }

  return {
    ok: false,
    message: 'Could not connect to backend server. Make sure the server is running.',
  }
}

/**
 * Upload Markdown files to the backend /upload-files endpoint.
 */
export async function uploadVaultFiles(
  settings: SettingsState,
  files: File[],
  jobName?: string
): Promise<ApiResult<UploadResponse>> {
  if (!settings.backendUrl) {
    return { success: false, error: 'Please set your Backend URL in Settings.' }
  }
  if (!settings.apiKey) {
    return { success: false, error: 'Please set your X-API-KEY in Settings before uploading.' }
  }
  if (!files.length) {
    return { success: false, error: 'No Markdown files selected to upload.' }
  }

  const base = normalizeUrl(settings.backendUrl)
  const formData = new FormData()
  if (jobName) {
    formData.append('job_name', jobName)
  }
  files.forEach((file) => {
    formData.append('files', file)
  })

  try {
    const response = await fetch(`${base}/upload-files`, {
      method: 'POST',
      headers: getHeaders(settings),
      body: formData,
    })

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: 'Unauthorized: Invalid X-API-KEY.', statusCode: 401 }
      }
      if (response.status === 413) {
        return { success: false, error: 'Payload too large: Files exceed 25MB limit.', statusCode: 413 }
      }
      if (response.status === 429) {
        return { success: false, error: 'Upload rate limit reached (5 requests/minute). Please wait.', statusCode: 429 }
      }
      const errorMsg = await parseErrorMessage(response, 'Upload failed')
      return { success: false, error: errorMsg, statusCode: response.status }
    }

    const data: UploadResponse = await response.json()
    return { success: true, data }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Network error during upload'
    return { success: false, error: `Upload failed: ${message}` }
  }
}

/**
 * Query the job status from /status/{job_id}.
 */
export async function checkJobStatus(
  settings: SettingsState,
  jobId: string
): Promise<ApiResult<VaultStatus>> {
  if (!settings.backendUrl || !settings.apiKey || !jobId) {
    return { success: false, error: 'Missing required configuration for status check.' }
  }

  const base = normalizeUrl(settings.backendUrl)

  try {
    const response = await fetch(`${base}/status/${jobId}`, {
      method: 'GET',
      headers: getHeaders(settings),
    })

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: 'Unauthorized API key.', statusCode: 401 }
      }
      if (response.status === 403) {
        return { success: false, error: 'Vault owner token mismatch.', statusCode: 403 }
      }
      if (response.status === 404) {
        return { success: false, error: 'Job ID not found.', statusCode: 404 }
      }
      const errorMsg = await parseErrorMessage(response, 'Status check failed')
      return { success: false, error: errorMsg, statusCode: response.status }
    }

    const raw = await response.text()
    const cleanStatus = raw.replaceAll('"', '').trim() as VaultStatus
    if (['Processing', 'Success', 'Failed'].includes(cleanStatus)) {
      return { success: true, data: cleanStatus }
    }

    return { success: true, data: 'Processing' }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Network error'
    return { success: false, error: message }
  }
}

/**
 * Send a question to /qna.
 */
export async function sendQnAQuery(
  settings: SettingsState,
  jobId: string,
  query: string
): Promise<ApiResult<QnAResponse>> {
  if (!settings.backendUrl) {
    return { success: false, error: 'Backend URL is not configured. Please open Settings.' }
  }
  if (!settings.apiKey) {
    return { success: false, error: 'API Key is missing. Please set your X-API-KEY in Settings.' }
  }
  if (!jobId) {
    return { success: false, error: 'No vault is currently selected.' }
  }

  const base = normalizeUrl(settings.backendUrl)

  try {
    const response = await fetch(`${base}/qna`, {
      method: 'POST',
      headers: {
        ...getHeaders(settings),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query.trim(),
        job_id: jobId,
      }),
    })

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, error: 'Unauthorized: Invalid X-API-KEY.', statusCode: 401 }
      }
      if (response.status === 403) {
        return { success: false, error: 'Access Forbidden: Owner token does not match this vault.', statusCode: 403 }
      }
      if (response.status === 404) {
        return { success: false, error: 'Vault Job not found in database.', statusCode: 404 }
      }
      if (response.status === 429) {
        return { success: false, error: 'Rate limit reached: 10 queries per minute. Please wait a moment.', statusCode: 429 }
      }
      const errorMsg = await parseErrorMessage(response, 'Query failed')
      return { success: false, error: errorMsg, statusCode: response.status }
    }

    const data: QnAResponse = await response.json()
    return { success: true, data }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Network error'
    return { success: false, error: `Could not reach RAG server: ${message}` }
  }
}

export type BackendJobItem = {
  id?: string
  job_id?: string
  job_name?: string
  name?: string
  total_files?: number
  totalFiles?: number
  status: VaultStatus
  succeeded?: number
  created_at?: string
  createdAt?: string
}

/**
 * Fetch past jobs / vaults from backend if GET /jobs endpoint is implemented.
 */
export async function fetchBackendJobs(
  settings: SettingsState
): Promise<ApiResult<BackendJobItem[]>> {
  if (!settings.backendUrl || !settings.apiKey || !settings.ownerToken) {
    return { success: false, error: 'Missing settings for fetching jobs' }
  }

  const base = normalizeUrl(settings.backendUrl)

  try {
    const response = await fetch(`${base}/jobs`, {
      method: 'GET',
      headers: getHeaders(settings),
    })

    if (!response.ok) {
      return { success: false, error: 'Endpoint not available', statusCode: response.status }
    }

    const data = await response.json()
    if (Array.isArray(data)) {
      return { success: true, data }
    }
    return { success: false, error: 'Unexpected response format' }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Network error'
    return { success: false, error: message }
  }
}

