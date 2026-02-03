/**
 * Workspace Durable Object
 *
 * One instance per workspace, keyed by workspace slug via idFromName().
 * Uses SQLite storage (built into Durable Objects) for all workspace data.
 * Uses WebSocket Hibernation API for cost-effective persistent connections.
 *
 * Responsibilities:
 * - Store all workspace data (sessions, sources, statuses, labels, skills, plans)
 * - Handle WebSocket messages for real-time mutations
 * - Broadcast changes to all other connected clients
 * - Serve REST GET endpoints for bulk loading
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types.ts';
import type { WSClientMessage, WSServerMessage, WSRemoteChangeEvent } from '@craft-agent/core/types/cloud';

export class WorkspaceDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initializeSchema();
  }

  private initializeSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        header TEXT NOT NULL,
        messages TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sources (
        slug TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        guide TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS statuses (
        id TEXT PRIMARY KEY DEFAULT 'config',
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS labels (
        id TEXT PRIMARY KEY DEFAULT 'config',
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skills (
        slug TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        metadata TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plans (
        session_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, file_name)
      );
    `);
  }

  // ============================================================
  // HTTP Fetch Handler (WebSocket upgrade + REST endpoints)
  // ============================================================

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // REST GET endpoints for bulk loading
    if (request.method === 'GET') {
      return this.handleRestGet(url.pathname);
    }

    return new Response('Not Found', { status: 404 });
  }

  private handleRestGet(pathname: string): Response {
    // GET /sessions — list all session headers
    if (pathname === '/sessions' || pathname === '/sessions/') {
      const rows = this.sql.exec('SELECT header FROM sessions ORDER BY updated_at DESC').toArray();
      return Response.json(rows.map(r => JSON.parse(r.header as string)));
    }

    // GET /sessions/:id — load full session (header + messages)
    const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const row = this.sql.exec('SELECT header, messages FROM sessions WHERE id = ?', sessionMatch[1]).toArray()[0];
      if (!row) return new Response('Not Found', { status: 404 });
      return Response.json({
        ...JSON.parse(row.header as string),
        messages: JSON.parse((row.messages as string) ?? '[]'),
      });
    }

    // GET /sources — list all sources
    if (pathname === '/sources' || pathname === '/sources/') {
      const rows = this.sql.exec('SELECT config FROM sources ORDER BY updated_at DESC').toArray();
      return Response.json(rows.map(r => JSON.parse(r.config as string)));
    }

    // GET /sources/:slug — load single source with guide
    const sourceMatch = pathname.match(/^\/sources\/([^/]+)$/);
    if (sourceMatch) {
      const row = this.sql.exec('SELECT config, guide FROM sources WHERE slug = ?', sourceMatch[1]).toArray()[0];
      if (!row) return new Response('Not Found', { status: 404 });
      return Response.json({
        config: JSON.parse(row.config as string),
        guide: row.guide ? JSON.parse(row.guide as string) : null,
      });
    }

    // GET /statuses
    if (pathname === '/statuses' || pathname === '/statuses/') {
      const row = this.sql.exec("SELECT data FROM statuses WHERE id = 'config'").toArray()[0];
      return Response.json(row ? JSON.parse(row.data as string) : { version: 1, statuses: [], defaultStatusId: 'todo' });
    }

    // GET /labels
    if (pathname === '/labels' || pathname === '/labels/') {
      const row = this.sql.exec("SELECT data FROM labels WHERE id = 'config'").toArray()[0];
      return Response.json(row ? JSON.parse(row.data as string) : { version: 1, labels: [] });
    }

    // GET /skills
    if (pathname === '/skills' || pathname === '/skills/') {
      const rows = this.sql.exec('SELECT slug, content, metadata FROM skills ORDER BY updated_at DESC').toArray();
      return Response.json(rows.map(r => ({
        slug: r.slug,
        content: r.content,
        metadata: r.metadata ? JSON.parse(r.metadata as string) : null,
      })));
    }

    // GET /sessions/:id/plans — list plans for a session
    const plansMatch = pathname.match(/^\/sessions\/([^/]+)\/plans$/);
    if (plansMatch) {
      const rows = this.sql.exec(
        'SELECT file_name, updated_at FROM plans WHERE session_id = ? ORDER BY updated_at DESC',
        plansMatch[1]
      ).toArray();
      return Response.json(rows.map(r => ({
        name: r.file_name,
        modifiedAt: r.updated_at,
      })));
    }

    // GET /sessions/:id/plans/:fileName — load a specific plan
    const planMatch = pathname.match(/^\/sessions\/([^/]+)\/plans\/([^/]+)$/);
    if (planMatch) {
      const row = this.sql.exec(
        'SELECT content FROM plans WHERE session_id = ? AND file_name = ?',
        planMatch[1], planMatch[2]
      ).toArray()[0];
      if (!row) return new Response('Not Found', { status: 404 });
      return new Response(row.content as string, { headers: { 'Content-Type': 'text/markdown' } });
    }

    return new Response('Not Found', { status: 404 });
  }

  // ============================================================
  // WebSocket Hibernation API Handlers
  // ============================================================

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    let msg: WSClientMessage;
    try {
      msg = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: 'response', requestId: 'unknown', error: 'Invalid JSON' }));
      return;
    }

    try {
      const result = await this.handleMessage(msg);
      const response: WSServerMessage = { type: 'response', requestId: msg.requestId, data: result };
      ws.send(JSON.stringify(response));

      // Broadcast to all OTHER connected clients (pass result so computed fields like timestamps are included)
      const changeEvent = this.toChangeEvent(msg, result);
      if (changeEvent) {
        this.broadcast(ws, { type: 'broadcast', event: changeEvent });
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      ws.send(JSON.stringify({ type: 'response', requestId: msg.requestId, error: errorMessage }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // WebSocket closed — hibernation API handles cleanup automatically
    ws.close(code, reason);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    ws.close(1011, 'WebSocket error');
  }

  // ============================================================
  // Message Handling (CRUD operations)
  // ============================================================

  private async handleMessage(msg: WSClientMessage): Promise<unknown> {
    switch (msg.type) {
      // --- Sessions ---
      case 'session:create': {
        const now = Date.now();
        const header = { ...msg.data, createdAt: now, lastUsedAt: now };
        this.sql.exec(
          'INSERT INTO sessions (id, header, messages, updated_at) VALUES (?, ?, ?, ?)',
          (header as Record<string, unknown>).id as string,
          JSON.stringify(header),
          '[]',
          now,
        );
        return header;
      }

      case 'session:save': {
        this.sql.exec(
          'INSERT OR REPLACE INTO sessions (id, header, messages, updated_at) VALUES (?, ?, ?, ?)',
          msg.data.id,
          JSON.stringify(msg.data.header),
          JSON.stringify(msg.data.messages),
          Date.now(),
        );
        return { success: true };
      }

      case 'session:delete': {
        this.sql.exec('DELETE FROM sessions WHERE id = ?', msg.data.sessionId);
        this.sql.exec('DELETE FROM plans WHERE session_id = ?', msg.data.sessionId);
        return { success: true };
      }

      case 'session:updateMeta': {
        const existing = this.sql.exec(
          'SELECT header FROM sessions WHERE id = ?',
          msg.data.sessionId,
        ).toArray()[0];
        if (!existing) throw new Error(`Session not found: ${msg.data.sessionId}`);
        const header = { ...JSON.parse(existing.header as string), ...msg.data.updates };
        this.sql.exec(
          'UPDATE sessions SET header = ?, updated_at = ? WHERE id = ?',
          JSON.stringify(header),
          Date.now(),
          msg.data.sessionId,
        );
        return header;
      }

      case 'session:updateSdkId': {
        const existing = this.sql.exec(
          'SELECT header FROM sessions WHERE id = ?',
          msg.data.sessionId,
        ).toArray()[0];
        if (!existing) throw new Error(`Session not found: ${msg.data.sessionId}`);
        const header = { ...JSON.parse(existing.header as string), sdkSessionId: msg.data.sdkSessionId };
        this.sql.exec(
          'UPDATE sessions SET header = ?, updated_at = ? WHERE id = ?',
          JSON.stringify(header),
          Date.now(),
          msg.data.sessionId,
        );
        return { success: true };
      }

      case 'session:clearMessages': {
        this.sql.exec(
          'UPDATE sessions SET messages = ?, updated_at = ? WHERE id = ?',
          '[]',
          Date.now(),
          msg.data.sessionId,
        );
        return { success: true };
      }

      // --- Sources ---
      case 'source:create': {
        const config = msg.data as Record<string, unknown>;
        this.sql.exec(
          'INSERT INTO sources (slug, config, updated_at) VALUES (?, ?, ?)',
          config.slug as string,
          JSON.stringify(config),
          Date.now(),
        );
        return config;
      }

      case 'source:saveConfig': {
        const config = msg.data as Record<string, unknown>;
        this.sql.exec(
          'INSERT OR REPLACE INTO sources (slug, config, guide, updated_at) VALUES (?, ?, (SELECT guide FROM sources WHERE slug = ?), ?)',
          config.slug as string,
          JSON.stringify(config),
          config.slug as string,
          Date.now(),
        );
        return { success: true };
      }

      case 'source:delete': {
        this.sql.exec('DELETE FROM sources WHERE slug = ?', msg.data.sourceSlug);
        return { success: true };
      }

      case 'source:saveGuide': {
        this.sql.exec(
          'UPDATE sources SET guide = ?, updated_at = ? WHERE slug = ?',
          JSON.stringify(msg.data.guide),
          Date.now(),
          msg.data.sourceSlug,
        );
        return { success: true };
      }

      // --- Statuses ---
      case 'statuses:save': {
        this.sql.exec(
          "INSERT OR REPLACE INTO statuses (id, data) VALUES ('config', ?)",
          JSON.stringify(msg.data),
        );
        return { success: true };
      }

      // --- Labels ---
      case 'labels:save': {
        this.sql.exec(
          "INSERT OR REPLACE INTO labels (id, data) VALUES ('config', ?)",
          JSON.stringify(msg.data),
        );
        return { success: true };
      }

      // --- Skills ---
      case 'skill:save': {
        this.sql.exec(
          'INSERT OR REPLACE INTO skills (slug, content, metadata, updated_at) VALUES (?, ?, ?, ?)',
          msg.data.slug,
          msg.data.content,
          JSON.stringify(msg.data.metadata),
          Date.now(),
        );
        return { success: true };
      }

      case 'skill:delete': {
        this.sql.exec('DELETE FROM skills WHERE slug = ?', msg.data.slug);
        return { success: true };
      }

      // --- Plans ---
      case 'plan:save': {
        this.sql.exec(
          'INSERT OR REPLACE INTO plans (session_id, file_name, content, updated_at) VALUES (?, ?, ?, ?)',
          msg.data.sessionId,
          msg.data.fileName,
          msg.data.content,
          Date.now(),
        );
        return { success: true };
      }

      case 'plan:delete': {
        this.sql.exec(
          'DELETE FROM plans WHERE session_id = ? AND file_name = ?',
          msg.data.sessionId,
          msg.data.fileName,
        );
        return { success: true };
      }

      default:
        throw new Error(`Unknown message type: ${(msg as { type: string }).type}`);
    }
  }

  // ============================================================
  // Broadcast & Change Events
  // ============================================================

  private broadcast(sender: WebSocket, message: WSServerMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== sender) {
        try {
          ws.send(payload);
        } catch {
          // Client disconnected — hibernation API will clean up
        }
      }
    }
  }

  private toChangeEvent(msg: WSClientMessage, result: unknown): WSRemoteChangeEvent | null {
    switch (msg.type) {
      case 'session:create':
        // Use result (which has computed timestamps) instead of msg.data
        return { entity: 'session', action: 'created', data: result as Record<string, unknown> };
      case 'session:save':
        // Broadcast header (flat session metadata), not the full { id, header, messages } payload
        return { entity: 'session', action: 'updated', data: msg.data.header };
      case 'session:updateMeta':
      case 'session:updateSdkId':
      case 'session:clearMessages':
        return { entity: 'session', action: 'updated', data: msg.data };
      case 'session:delete':
        return { entity: 'session', action: 'deleted', data: msg.data };

      case 'source:create':
        return { entity: 'source', action: 'created', data: msg.data };
      case 'source:saveConfig':
      case 'source:saveGuide':
        return { entity: 'source', action: 'updated', data: msg.data };
      case 'source:delete':
        return { entity: 'source', action: 'deleted', data: msg.data };

      case 'statuses:save':
        return { entity: 'statuses', action: 'updated', data: msg.data };

      case 'labels:save':
        return { entity: 'labels', action: 'updated', data: msg.data };

      case 'skill:save':
        return { entity: 'skill', action: 'updated', data: msg.data };
      case 'skill:delete':
        return { entity: 'skill', action: 'deleted', data: msg.data };

      case 'plan:save':
        return { entity: 'plan', action: 'updated', data: msg.data };
      case 'plan:delete':
        return { entity: 'plan', action: 'deleted', data: msg.data };

      default:
        return null;
    }
  }
}
