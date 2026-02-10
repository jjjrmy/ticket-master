/**
 * Craft Agent Worker
 *
 * Cloudflare Worker that acts as a message broker between external HTTP triggers
 * and connected Craft Agent clients via WebSocket.
 *
 * Routes:
 *   GET/POST /action/{actionName}[/{id}][?params]              - Trigger a deeplink action
 *   GET/POST /workspace/{wsId}/action/{actionName}[/{id}][?params] - Action targeting a workspace
 *   GET      /attachments/{key+}                               - Download a staged attachment from R2
 *   GET      /workspaces                                       - List all workspaces
 *   GET      /workspace/{slug}                                 - Workspace config
 *   GET      /workspace/{slug}/labels                          - Labels config
 *   GET      /workspace/{slug}/statuses                        - Statuses config
 *   GET      /workspace/{slug}/sources                         - Sources list
 *   GET      /workspace/{slug}/working-directories             - Working directories
 *   GET      /ws                                               - WebSocket upgrade for clients
 *   GET      /health                                           - Health check / connection status
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { Env, AttachmentMeta, QueryResource } from './types.ts'

// Re-export the Durable Object class so Wrangler can find it
export { BridgeDurableObject } from './websocket.ts'

const app = new Hono<{ Bindings: Env }>()

// Enable CORS for flexibility
app.use('*', cors())

// Auth middleware for action endpoints
app.use('/action/*', async (c, next) => {
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '')
    || c.req.query('key')

  if (!apiKey || apiKey !== c.env.API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
})

app.use('/workspace/*', async (c, next) => {
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '')
    || c.req.query('key')

  if (!apiKey || apiKey !== c.env.API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
})

// Auth middleware for workspaces query endpoints
app.use('/workspaces', async (c, next) => {
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '')
    || c.req.query('key')

  if (!apiKey || apiKey !== c.env.API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
})

// Auth middleware for attachment downloads
app.use('/attachments/*', async (c, next) => {
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '')
    || c.req.query('key')

  if (!apiKey || apiKey !== c.env.API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  await next()
})

// Forward all requests to the Durable Object (singleton)
function getBridge(env: Env): DurableObjectStub {
  const id = env.BRIDGE.idFromName('bridge')
  return env.BRIDGE.get(id)
}

/**
 * Reconstruct a craftagents:// deep link URL from the HTTP request URL.
 * Strips the `key` query param (auth only) before reconstructing.
 *
 *   /action/new-chat?input=Hello  →  craftagents://action/new-chat?input=Hello
 *   /workspace/ws1/action/new-chat  →  craftagents://workspace/ws1/action/new-chat
 */
function buildDeepLinkUrl(requestUrl: string): string {
  const url = new URL(requestUrl)

  // Rebuild query string, excluding the `key` param (used for auth only)
  const params = new URLSearchParams()
  url.searchParams.forEach((value, key) => {
    if (key !== 'key') {
      params.append(key, value)
    }
  })
  const qs = params.toString()

  // craftagents:// uses the path after the leading slash as host + pathname
  // e.g. /action/new-chat → craftagents://action/new-chat
  return `craftagents://${url.pathname.slice(1)}${qs ? '?' + qs : ''}`
}

/**
 * Parse multipart form data and upload files to R2.
 * Returns attachment metadata array for the WebSocket message.
 */
async function handleFileUploads(
  request: Request,
  bucket: R2Bucket,
  actionId: string
): Promise<AttachmentMeta[]> {
  const contentType = request.headers.get('Content-Type') || ''
  if (!contentType.includes('multipart/form-data')) {
    return []
  }

  const formData = await request.formData()
  const attachments: AttachmentMeta[] = []

  for (const [_fieldName, value] of formData.entries()) {
    if (!(value instanceof File)) continue

    const key = `${actionId}/${value.name}`
    await bucket.put(key, value.stream(), {
      httpMetadata: { contentType: value.type || 'application/octet-stream' },
    })

    attachments.push({
      name: value.name,
      key,
      mimeType: value.type || 'application/octet-stream',
      size: value.size,
    })
  }

  return attachments
}

// GET/POST /action/* - Trigger a deeplink action
app.all('/action/*', async (c) => {
  const actionUrl = buildDeepLinkUrl(c.req.url)
  const actionId = crypto.randomUUID()

  // Handle file uploads if multipart
  const attachments = await handleFileUploads(c.req.raw, c.env.ATTACHMENTS, actionId)

  const bridge = getBridge(c.env)
  const headers: Record<string, string> = {
    'X-Action-URL': actionUrl,
    'X-Action-ID': actionId,
  }
  if (attachments.length > 0) {
    headers['X-Attachments'] = JSON.stringify(attachments)
  }

  return bridge.fetch(new Request('https://bridge/action', {
    method: 'POST',
    headers,
  }))
})

// GET/POST /workspace/:workspaceId/action/* - Trigger a deeplink targeting a workspace
app.all('/workspace/:workspaceId/action/*', async (c) => {
  const actionUrl = buildDeepLinkUrl(c.req.url)
  const actionId = crypto.randomUUID()

  // Handle file uploads if multipart
  const attachments = await handleFileUploads(c.req.raw, c.env.ATTACHMENTS, actionId)

  const bridge = getBridge(c.env)
  const headers: Record<string, string> = {
    'X-Action-URL': actionUrl,
    'X-Action-ID': actionId,
  }
  if (attachments.length > 0) {
    headers['X-Attachments'] = JSON.stringify(attachments)
  }

  return bridge.fetch(new Request('https://bridge/action', {
    method: 'POST',
    headers,
  }))
})

// GET /attachments/{key+} - Download a staged attachment from R2
app.get('/attachments/:actionId/:filename', async (c) => {
  const key = `${c.req.param('actionId')}/${c.req.param('filename')}`
  const object = await c.env.ATTACHMENTS.get(key)

  if (!object) {
    return c.json({ error: 'Attachment not found' }, 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
  headers.set('Content-Length', String(object.size))
  headers.set('Content-Disposition', `attachment; filename="${c.req.param('filename')}"`)

  return new Response(object.body, { headers })
})

// ============================================================
// Query Endpoints - GET workspace data via WebSocket relay
// ============================================================

/** Helper to relay a query to the Durable Object and return the response */
async function relayQuery(env: Env, resource: QueryResource, workspaceSlug?: string): Promise<Response> {
  const bridge = getBridge(env)
  const headers: Record<string, string> = {
    'X-Query-Resource': resource,
  }
  if (workspaceSlug) {
    headers['X-Query-Workspace'] = workspaceSlug
  }
  return bridge.fetch(new Request('https://bridge/query', { headers }))
}

// GET /workspaces - List all workspaces
app.get('/workspaces', async (c) => {
  return relayQuery(c.env, 'workspaces')
})

// GET /workspace/:slug - Workspace config
app.get('/workspace/:slug', async (c) => {
  return relayQuery(c.env, 'workspace', c.req.param('slug'))
})

// GET /workspace/:slug/labels - Labels config
app.get('/workspace/:slug/labels', async (c) => {
  return relayQuery(c.env, 'labels', c.req.param('slug'))
})

// GET /workspace/:slug/statuses - Statuses config
app.get('/workspace/:slug/statuses', async (c) => {
  return relayQuery(c.env, 'statuses', c.req.param('slug'))
})

// GET /workspace/:slug/sources - Sources list
app.get('/workspace/:slug/sources', async (c) => {
  return relayQuery(c.env, 'sources', c.req.param('slug'))
})

// GET /workspace/:slug/working-directories - Working directories
app.get('/workspace/:slug/working-directories', async (c) => {
  return relayQuery(c.env, 'working-directories', c.req.param('slug'))
})

// GET /ws - WebSocket upgrade
app.get('/ws', async (c) => {
  const upgradeHeader = c.req.header('Upgrade')
  if (upgradeHeader !== 'websocket') {
    return c.json({ error: 'Expected WebSocket upgrade' }, 426)
  }

  const bridge = getBridge(c.env)
  return bridge.fetch(new Request(c.req.url, {
    headers: c.req.raw.headers,
  }))
})

// GET /health - Health check
app.get('/health', async (c) => {
  const bridge = getBridge(c.env)
  return bridge.fetch(new Request(c.req.url))
})

// Catch-all
app.all('*', (c) => c.json({ error: 'Not found' }, 404))

export default app
