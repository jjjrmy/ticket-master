# @craft-agent/worker

A Cloudflare Worker that acts as a bridge between external HTTP triggers and your local Craft Agent desktop app via WebSocket. Send HTTP requests from anywhere (webhooks, automations, scripts, Shortcuts) and the Worker relays them to your running desktop app as `craftagents://` deeplink actions.

## How It Works

```
External Trigger ──HTTP──▶ Cloudflare Worker ──WebSocket──▶ Craft Agent Desktop
  (curl, webhook,           (relays actions)                 (executes deeplink
   Shortcut, etc.)                                            locally)
```

1. The **Worker** runs on Cloudflare and holds persistent WebSocket connections via a Durable Object
2. The **Craft Agent desktop app** connects to the Worker over WebSocket and authenticates with an API key
3. External triggers send HTTP requests to the Worker — the URL path directly maps to a deeplink action
4. The Worker relays the action to all connected clients, which execute it as a local deeplink

## Setup

### 1. Install Dependencies

From the monorepo root:

```bash
bun install
```

### 2. Deploy the Worker

```bash
cd packages/worker
bun run deploy
```

### 3. Set the API Key Secret

```bash
cd packages/worker
wrangler secret put API_KEY
```

Enter a strong, random string when prompted. This key is used to authenticate both HTTP requests and WebSocket clients.

### 4. Configure the Desktop App

Open **Settings > Cloud Proxy** in Craft Agent and enter:

- **Worker URL** — Your deployed Worker URL (e.g., `my-worker.example.workers.dev`)
- **API Key** — The same key you set in step 3

The connection will establish automatically.

## API Reference

### Authentication

All action requests require your API key. Pass it via either:

- **Header**: `Authorization: Bearer <API_KEY>`
- **Query param**: `?key=<API_KEY>`

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET/POST | `/action/{actionName}[/{id}][?params]` | Trigger a deeplink action |
| GET/POST | `/workspace/{wsId}/action/{actionName}[/{id}][?params]` | Action targeting a workspace |
| GET | `/attachments/{actionId}/{filename}` | Download a staged attachment (used internally by desktop app) |
| GET | `/health` | Health check + connection count |
| GET | `/ws` | WebSocket upgrade (used by the desktop app) |

### Response

```json
{
  "success": true,
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "delivered": 1
}
```

| Field | Description |
|-------|-------------|
| `success` | `true` if at least one client received the action |
| `id` | Unique ID for the action relay event |
| `delivered` | Number of connected clients the action was sent to |

Returns `503` if no clients are connected.

### `GET /health`

```bash
curl "https://YOUR_WORKER_URL/health"
```

```json
{
  "status": "ok",
  "connections": {
    "total": 1,
    "authenticated": 1
  }
}
```

## Action Examples

All examples below use `curl` with the `Authorization` header. Replace `YOUR_WORKER_URL` and `YOUR_API_KEY` with your actual values.

---

### New Chat

Open a new empty chat session.

```bash
# GET
curl "https://YOUR_WORKER_URL/action/new-chat" \
  -H "Authorization: Bearer YOUR_API_KEY"

# POST
curl -X POST "https://YOUR_WORKER_URL/action/new-chat" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### New Chat with Input

Open a new chat with pre-filled text.

```bash
curl "https://YOUR_WORKER_URL/action/new-chat?input=Hello%20world" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### New Chat with Input + Auto-Send

Open a new chat with text and immediately send the message.

```bash
curl "https://YOUR_WORKER_URL/action/new-chat?input=Hello%20world&send=true" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### New Chat with Custom Name

Open a new chat with a specific name.

```bash
curl "https://YOUR_WORKER_URL/action/new-chat?input=Hello%20world&name=My%20Chat" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### New Chat with All Options

Open a new chat with input, a custom name, and auto-send.

```bash
curl "https://YOUR_WORKER_URL/action/new-chat?input=Summarize%20my%20day&name=Daily%20Summary&send=true" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### New Chat with File Attachment

Send a screenshot or file with the message. Uses `multipart/form-data` via `-F`.

```bash
curl -X POST "https://YOUR_WORKER_URL/action/new-chat?input=Fix%20this%20bug&send=true" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@screenshot.png"
```

### New Chat with Multiple Files

Attach multiple files to a single message.

```bash
curl -X POST "https://YOUR_WORKER_URL/action/new-chat?input=Review%20these%20errors&send=true" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -F "file=@screenshot1.png" \
  -F "file=@screenshot2.png" \
  -F "file=@error-log.txt"
```

Files are temporarily staged in Cloudflare R2 and downloaded by the desktop app when the action is received. Supported file types include images, text files, PDFs, and more.

### New Chat Parameters

All query parameters supported by the `new-chat` action:

| Parameter | Description | Example Values |
|-----------|-------------|----------------|
| `input` | Pre-filled text for the chat | Any URL-encoded string |
| `send` | Auto-send the message immediately | `true` |
| `name` | Session name | `My%20Chat` |
| `mode` | Permission mode | `safe`, `ask`, `allow-all` |
| `model` | Model override | `haiku`, `sonnet` |
| `systemPrompt` | System prompt preset | `mini`, `default` |
| `status` | Initial status | Status ID |
| `label` | Initial label | Label ID |
| `workdir` | Working directory for the session | `user_default`, `none`, or absolute path |
| `sources` | Comma-separated source slugs to activate | `github,gmail` |
| `badges` | JSON-encoded content badges (internal) | `[{"type":"file","path":"/src/app.ts"}]` |

### New Chat with Working Directory

Open a new chat with a specific working directory.

```bash
curl "https://YOUR_WORKER_URL/action/new-chat?workdir=%2FUsers%2Fme%2Fmy-project" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Use `workdir=user_default` to use the user's configured default, or `workdir=none` for no working directory.

### New Chat with Sources

Open a new chat with specific sources pre-activated.

```bash
curl "https://YOUR_WORKER_URL/action/new-chat?input=Check%20my%20PRs&sources=github,linear&send=true" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### New Chat in a Specific Workspace

Target a specific workspace by ID.

```bash
curl "https://YOUR_WORKER_URL/workspace/my-workspace/action/new-chat?input=Hello&send=true" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Flag a Session

Mark a session as flagged for follow-up.

```bash
curl "https://YOUR_WORKER_URL/action/flag-session/SESSION_ID" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Unflag a Session

Remove the flag from a session.

```bash
curl "https://YOUR_WORKER_URL/action/unflag-session/SESSION_ID" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Delete a Session

Delete a session by ID.

```bash
curl -X POST "https://YOUR_WORKER_URL/action/delete-session/SESSION_ID" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Rename a Session

Rename a session. The `name` query parameter is required.

```bash
curl "https://YOUR_WORKER_URL/action/rename-session/SESSION_ID?name=New%20Name" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

### Resume a Claude Code Session

Resume an existing Claude Code SDK session by its ID.

```bash
curl "https://YOUR_WORKER_URL/action/resume-sdk-session/SDK_SESSION_ID" \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## URL Mapping Reference

The HTTP path directly mirrors the `craftagents://` deeplink structure:

| HTTP Path | Deeplink URL |
|---|---|
| `/action/new-chat` | `craftagents://action/new-chat` |
| `/action/new-chat?input=TEXT&send=true` | `craftagents://action/new-chat?input=TEXT&send=true` |
| `/action/new-chat?input=TEXT&name=NAME` | `craftagents://action/new-chat?input=TEXT&name=NAME` |
| `/action/new-chat?sources=github,gmail` | `craftagents://action/new-chat?sources=github,gmail` |
| `/workspace/WS_ID/action/new-chat` | `craftagents://workspace/WS_ID/action/new-chat` |
| `/workspace/WS_ID/action/new-chat?input=TEXT&send=true` | `craftagents://workspace/WS_ID/action/new-chat?input=TEXT&send=true` |
| `/action/flag-session/SESSION_ID` | `craftagents://action/flag-session/SESSION_ID` |
| `/action/unflag-session/SESSION_ID` | `craftagents://action/unflag-session/SESSION_ID` |
| `/action/delete-session/SESSION_ID` | `craftagents://action/delete-session/SESSION_ID` |
| `/action/rename-session/SESSION_ID?name=NAME` | `craftagents://action/rename-session/SESSION_ID?name=NAME` |
| `/action/resume-sdk-session/SDK_SESSION_ID` | `craftagents://action/resume-sdk-session/SDK_SESSION_ID` |
| `POST /action/new-chat -F file=@img.png` | Same as above, with file attachment staged in R2 |

## Development

### Run Locally

```bash
cd packages/worker
bun run dev
```

This starts a local dev server with `wrangler dev`. You can test endpoints at `http://localhost:8787`.

### View Logs

```bash
cd packages/worker
bun run tail
```

Streams real-time logs from the deployed Worker.

## Security

- All action requests require the API key — unauthenticated requests get `401 Unauthorized`
- WebSocket clients must send the API key as their first message after connecting
- Invalid API keys result in immediate WebSocket disconnection (close code `4001`)
- The API key is stored as a Cloudflare secret (not in source code)
- On the desktop side, the API key is encrypted with AES-256-GCM via CredentialManager
- The Worker only relays URLs with the `craftagents://` scheme — arbitrary URLs cannot be relayed
