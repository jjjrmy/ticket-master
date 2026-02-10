/**
 * Worker Bridge
 *
 * Connects to a remote Craft Agent Worker via WebSocket and relays
 * incoming action messages as local craftagents:// deeplinks.
 *
 * This enables remote triggering of local actions (create chats,
 * flag/unflag sessions, etc.) from external webhooks or automations.
 *
 * Uses Node.js native WebSocket (available in Node 22+ / Electron 39+).
 */

import { mainLog } from './logger'
import { handleDeepLink } from './deep-link'
import type { WindowManager } from './window-manager'
import type { FileAttachment } from '../shared/types'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs/promises'

export type WorkerBridgeStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface WorkerBridgeConfig {
  workerUrl: string  // Protocol-stripped domain
  apiKey: string
}

/** Attachment metadata from the worker (matches AttachmentMeta in worker types) */
interface WorkerAttachmentMeta {
  name: string
  key: string
  mimeType: string
  size: number
}

/** Queryable workspace resources */
type QueryResource = 'workspaces' | 'workspace' | 'labels' | 'statuses' | 'sources' | 'working-directories'

/** Messages from Worker → Client */
interface WorkerMessage {
  type: 'auth_ok' | 'auth_error' | 'action' | 'query' | 'pong'
  url?: string
  id?: string
  error?: string
  attachments?: WorkerAttachmentMeta[]
  resource?: QueryResource
  workspaceSlug?: string
}

export class WorkerBridge {
  private ws: WebSocket | null = null
  private config: WorkerBridgeConfig | null = null
  private windowManager: WindowManager
  private status: WorkerBridgeStatus = 'disconnected'
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private statusListeners: Set<(status: WorkerBridgeStatus) => void> = new Set()
  private stopped = false

  constructor(windowManager: WindowManager) {
    this.windowManager = windowManager
  }

  /**
   * Start the bridge with the given config.
   * Initiates WebSocket connection to the Worker.
   */
  start(config: WorkerBridgeConfig): void {
    this.stopped = false
    this.config = config
    this.reconnectDelay = 1000
    this.connect()
  }

  /**
   * Stop the bridge and disconnect.
   */
  stop(): void {
    this.stopped = true
    this.cleanup()
    this.setStatus('disconnected')
    mainLog.info('[WorkerBridge] Stopped')
  }

  /**
   * Restart the bridge (e.g., when config changes).
   */
  restart(config: WorkerBridgeConfig): void {
    this.cleanup()
    this.start(config)
  }

  /**
   * Get current connection status.
   */
  getStatus(): WorkerBridgeStatus {
    return this.status
  }

  /**
   * Subscribe to status changes. Returns cleanup function.
   */
  onStatusChange(listener: (status: WorkerBridgeStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private connect(): void {
    if (!this.config || this.stopped) return

    this.cleanup()
    this.setStatus('connecting')

    const wsUrl = `wss://${this.config.workerUrl}/ws`
    mainLog.info('[WorkerBridge] Connecting to', wsUrl)

    try {
      this.ws = new WebSocket(wsUrl)
    } catch (err) {
      mainLog.error('[WorkerBridge] Failed to create WebSocket:', err)
      this.setStatus('error')
      this.scheduleReconnect()
      return
    }

    this.ws.addEventListener('open', () => {
      mainLog.info('[WorkerBridge] WebSocket connected, authenticating...')
      this.send({ type: 'auth', apiKey: this.config!.apiKey })
      this.startPing()
    })

    this.ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as WorkerMessage
        this.handleMessage(message)
      } catch (err) {
        mainLog.error('[WorkerBridge] Failed to parse message:', err)
      }
    })

    this.ws.addEventListener('close', (event) => {
      mainLog.info('[WorkerBridge] WebSocket closed:', event.code, event.reason)
      this.stopPing()
      if (!this.stopped) {
        this.setStatus('disconnected')
        this.scheduleReconnect()
      }
    })

    this.ws.addEventListener('error', () => {
      mainLog.error('[WorkerBridge] WebSocket error')
      this.setStatus('error')
    })
  }

  private handleMessage(message: WorkerMessage): void {
    switch (message.type) {
      case 'auth_ok':
        mainLog.info('[WorkerBridge] Authenticated successfully')
        this.setStatus('connected')
        this.reconnectDelay = 1000 // Reset on successful connection
        break

      case 'auth_error':
        mainLog.error('[WorkerBridge] Authentication failed:', message.error)
        this.setStatus('error')
        // Don't reconnect on auth errors - config is wrong
        this.stopped = true
        break

      case 'action':
        if (message.url) {
          mainLog.info('[WorkerBridge] Received action:', message.url, 'attachments:', message.attachments?.length ?? 0)
          this.handleAction(message)
        }
        break

      case 'query':
        if (message.id && message.resource) {
          mainLog.info('[WorkerBridge] Received query:', message.resource, 'workspace:', message.workspaceSlug ?? 'n/a')
          this.handleQuery(message)
        }
        break

      case 'pong':
        // Heartbeat response - connection is alive
        break
    }
  }

  /**
   * Handle an action message: download attachments (if any), then trigger deep link.
   */
  private async handleAction(message: WorkerMessage): Promise<void> {
    try {
      let attachments: FileAttachment[] | undefined

      if (message.attachments && message.attachments.length > 0 && this.config) {
        attachments = await this.downloadAttachments(message.attachments)
      }

      const result = await handleDeepLink(message.url!, this.windowManager, attachments)
      if (message.id) {
        this.send({ type: 'ack', id: message.id, success: result.success, error: result.error })
      }
    } catch (err) {
      mainLog.error('[WorkerBridge] Failed to handle action:', err)
      if (message.id) {
        this.send({ type: 'ack', id: message.id, success: false, error: String(err) })
      }
    }
  }

  /**
   * Handle a query message: read workspace data and send back query_response.
   */
  private async handleQuery(message: WorkerMessage): Promise<void> {
    const { id, resource, workspaceSlug } = message

    try {
      const {
        discoverWorkspacesInDefaultLocation,
        loadWorkspaceConfig,
        getWorkspaceSourcesPath,
      } = await import('@craft-agent/shared/workspaces')

      const data = await (async () => {
        // List all workspaces (no slug needed)
        if (resource === 'workspaces') {
          const paths = discoverWorkspacesInDefaultLocation()
          const workspaces = paths.map(rootPath => {
            const config = loadWorkspaceConfig(rootPath)
            if (!config) return null
            return { id: config.id, name: config.name, slug: config.slug, createdAt: config.createdAt }
          }).filter(Boolean)
          return { workspaces }
        }

        // All other resources require a workspace identifier (slug or ID)
        if (!workspaceSlug) {
          throw new Error('Workspace identifier is required')
        }

        // Resolve workspace identifier (slug or ID) to root path
        const allPaths = discoverWorkspacesInDefaultLocation()
        const rootPath = allPaths.find(p => {
          const config = loadWorkspaceConfig(p)
          return config?.slug === workspaceSlug || config?.id === workspaceSlug
        })

        if (!rootPath) {
          throw new Error('Workspace not found')
        }

        switch (resource) {
          case 'workspace': {
            const config = loadWorkspaceConfig(rootPath)
            return config ? {
              id: config.id,
              name: config.name,
              slug: config.slug,
              defaults: config.defaults,
              createdAt: config.createdAt,
              updatedAt: config.updatedAt,
            } : null
          }

          case 'labels': {
            const { loadLabelConfig } = await import('@craft-agent/shared/labels/storage')
            return loadLabelConfig(rootPath)
          }

          case 'statuses': {
            const { loadStatusConfig } = await import('@craft-agent/shared/statuses/storage')
            return loadStatusConfig(rootPath)
          }

          case 'sources': {
            const { loadWorkspaceSources } = await import('@craft-agent/shared/sources/storage')
            const loaded = loadWorkspaceSources(rootPath)
            return {
              sources: loaded.map(s => ({
                id: s.config.id,
                name: s.config.name,
                slug: s.config.slug,
                type: s.config.type,
                provider: s.config.provider,
                enabled: s.config.enabled,
                isAuthenticated: s.config.isAuthenticated,
                connectionStatus: s.config.connectionStatus,
                tagline: s.config.tagline,
                icon: s.config.icon,
              })),
            }
          }

          case 'working-directories': {
            const { listSessions } = await import('@craft-agent/shared/sessions')
            const config = loadWorkspaceConfig(rootPath)
            const seen = new Set<string>()
            const directories: { path: string; label: string }[] = []

            // Add workspace default first (if set)
            if (config?.defaults?.workingDirectory) {
              const dir = config.defaults.workingDirectory
              seen.add(dir)
              directories.push({
                path: dir,
                label: dir.split('/').pop() || dir,
              })
            }

            // Collect unique working directories from sessions (sorted by most recent)
            // Filter out internal session folder paths (sdkCwd) that aren't real working directories
            const sessions = listSessions(rootPath)
            sessions.sort((a, b) => (b.lastMessageAt ?? b.lastUsedAt) - (a.lastMessageAt ?? a.lastUsedAt))
            for (const session of sessions) {
              const dir = session.workingDirectory
              if (dir && !seen.has(dir) && !dir.includes('.craft-agent/workspaces/')) {
                seen.add(dir)
                directories.push({
                  path: dir,
                  label: dir.split('/').pop() || dir,
                })
              }
            }

            return { directories }
          }

          default:
            throw new Error(`Unknown resource: ${resource}`)
        }
      })()

      this.send({ type: 'query_response', id, data })
    } catch (err) {
      mainLog.error('[WorkerBridge] Failed to handle query:', err)
      this.send({ type: 'query_response', id, error: String(err) })
    }
  }

  /**
   * Download attachment files from R2 via the worker's /attachments endpoint.
   * Saves to a temp directory and returns FileAttachment objects.
   */
  private async downloadAttachments(metas: WorkerAttachmentMeta[]): Promise<FileAttachment[]> {
    if (!this.config) return []

    const tempDir = path.join(app.getPath('temp'), 'craft-agent-attachments')
    await fs.mkdir(tempDir, { recursive: true })

    const results: FileAttachment[] = []

    for (const meta of metas) {
      try {
        const url = `https://${this.config.workerUrl}/attachments/${meta.key}`
        mainLog.info('[WorkerBridge] Downloading attachment:', meta.name, 'from', url)

        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
        })

        if (!response.ok) {
          mainLog.error('[WorkerBridge] Failed to download attachment:', meta.name, response.status)
          continue
        }

        // Save to temp file
        const filePath = path.join(tempDir, `${Date.now()}-${meta.name}`)
        const buffer = Buffer.from(await response.arrayBuffer())
        await fs.writeFile(filePath, buffer)

        // Determine file type from mime
        let type: FileAttachment['type'] = 'unknown'
        if (meta.mimeType.startsWith('image/')) type = 'image'
        else if (meta.mimeType.startsWith('text/')) type = 'text'
        else if (meta.mimeType === 'application/pdf') type = 'pdf'
        else if (meta.mimeType.includes('office') || meta.mimeType.includes('document') ||
                 meta.mimeType.includes('spreadsheet') || meta.mimeType.includes('presentation')) type = 'office'

        const attachment: FileAttachment = {
          type,
          path: filePath,
          name: meta.name,
          mimeType: meta.mimeType,
          size: meta.size,
        }

        // For images, include base64 for inline display
        if (type === 'image') {
          attachment.base64 = buffer.toString('base64')
        } else if (type === 'text') {
          attachment.text = buffer.toString('utf-8')
        } else if (type === 'pdf') {
          attachment.base64 = buffer.toString('base64')
        }

        results.push(attachment)
        mainLog.info('[WorkerBridge] Downloaded attachment:', meta.name, `(${type}, ${meta.size} bytes)`)
      } catch (err) {
        mainLog.error('[WorkerBridge] Error downloading attachment:', meta.name, err)
      }
    }

    return results
  }

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  private startPing(): void {
    this.stopPing()
    // Send ping every 30 seconds to keep connection alive
    this.pingTimer = setInterval(() => {
      this.send({ type: 'ping' })
    }, 30000)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return

    mainLog.info(`[WorkerBridge] Reconnecting in ${this.reconnectDelay}ms...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectDelay)

    // Exponential backoff: 1s → 2s → 4s → 8s → ... → 30s max
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
  }

  private cleanup(): void {
    this.stopPing()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close()
      }
      this.ws = null
    }
  }

  private setStatus(status: WorkerBridgeStatus): void {
    if (this.status === status) return
    this.status = status
    mainLog.info('[WorkerBridge] Status:', status)
    for (const listener of this.statusListeners) {
      try {
        listener(status)
      } catch {
        // Ignore listener errors
      }
    }
  }
}
