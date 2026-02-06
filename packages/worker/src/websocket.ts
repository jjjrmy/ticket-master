/**
 * Bridge Durable Object
 *
 * Manages WebSocket connections from Craft Agent clients
 * and relays action messages from HTTP triggers.
 */

import type { Env, WorkerToClientMessage, ClientToWorkerMessage, AttachmentMeta } from './types.ts'

interface ConnectedClient {
  websocket: WebSocket
  authenticated: boolean
  connectedAt: number
}

export class BridgeDurableObject {
  private clients: Map<string, ConnectedClient> = new Map()
  private env: Env

  constructor(state: DurableObjectState, env: Env) {
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/ws') {
      return this.handleWebSocket(request)
    }

    if (url.pathname === '/action') {
      return this.handleAction(request)
    }

    if (url.pathname === '/health') {
      return this.handleHealth()
    }

    return new Response('Not found', { status: 404 })
  }

  private handleWebSocket(request: Request): Response {
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    const clientId = crypto.randomUUID()

    server.accept()

    this.clients.set(clientId, {
      websocket: server,
      authenticated: false,
      connectedAt: Date.now(),
    })

    server.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data as string) as ClientToWorkerMessage

        switch (data.type) {
          case 'auth':
            this.handleAuth(clientId, data.apiKey)
            break
          case 'ack':
            // Acknowledgement received - could log or track
            break
          case 'ping':
            this.send(clientId, { type: 'pong' })
            break
        }
      } catch {
        // Invalid message - ignore
      }
    })

    server.addEventListener('close', () => {
      this.clients.delete(clientId)
    })

    server.addEventListener('error', () => {
      this.clients.delete(clientId)
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  private handleAuth(clientId: string, apiKey: string): void {
    const client = this.clients.get(clientId)
    if (!client) return

    if (apiKey === this.env.API_KEY) {
      client.authenticated = true
      this.send(clientId, { type: 'auth_ok' })
    } else {
      this.send(clientId, { type: 'auth_error', error: 'Invalid API key' })
      // Close after a brief delay to allow error message delivery
      setTimeout(() => {
        client.websocket.close(4001, 'Invalid API key')
        this.clients.delete(clientId)
      }, 100)
    }
  }

  private async handleAction(request: Request): Promise<Response> {
    const actionUrl = request.headers.get('X-Action-URL')

    if (!actionUrl || !actionUrl.startsWith('craftagents://')) {
      return new Response(JSON.stringify({ error: 'Missing or invalid action URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Use the action ID from the router (or generate one)
    const id = request.headers.get('X-Action-ID') || crypto.randomUUID()

    // Parse attachment metadata if present
    let attachments: AttachmentMeta[] | undefined
    const attachmentsHeader = request.headers.get('X-Attachments')
    if (attachmentsHeader) {
      try {
        attachments = JSON.parse(attachmentsHeader) as AttachmentMeta[]
      } catch {
        // Ignore malformed attachments header
      }
    }

    // Relay to all authenticated clients
    let delivered = 0

    for (const [clientId, client] of this.clients) {
      if (client.authenticated) {
        try {
          const message: WorkerToClientMessage = { type: 'action', url: actionUrl, id }
          if (attachments && attachments.length > 0) {
            message.attachments = attachments
          }
          this.send(clientId, message)
          delivered++
        } catch {
          // Client disconnected - clean up
          this.clients.delete(clientId)
        }
      }
    }

    return new Response(JSON.stringify({
      success: delivered > 0,
      id,
      delivered,
      attachments: attachments?.length ?? 0,
    }), {
      status: delivered > 0 ? 200 : 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  private handleHealth(): Response {
    const authenticated = Array.from(this.clients.values()).filter(c => c.authenticated).length
    const total = this.clients.size

    return new Response(JSON.stringify({
      status: 'ok',
      connections: { total, authenticated },
    }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  private send(clientId: string, message: WorkerToClientMessage): void {
    const client = this.clients.get(clientId)
    if (!client) return

    try {
      client.websocket.send(JSON.stringify(message))
    } catch {
      this.clients.delete(clientId)
    }
  }
}
