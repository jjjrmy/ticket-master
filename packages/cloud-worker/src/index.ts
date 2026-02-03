/**
 * Craft Agent Cloud Worker
 *
 * Entry point for the Cloudflare Worker. Routes all requests through
 * API key auth, then forwards to the appropriate Durable Object by
 * workspace slug.
 *
 * URL pattern: /workspace/:slug/* → WorkspaceDO(idFromName(slug))
 *
 * The slug IS the Durable Object identity. New slugs auto-create.
 * Auth is a single global API_KEY secret env var.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authMiddleware } from './middleware/auth.ts';
import { validateSignedUrl, generateSignedUrl } from './middleware/signed-url.ts';
import type { Env, FileMetadata } from './types.ts';
import { isValidFileType } from './types.ts';

const app = new Hono<{ Bindings: Env }>();

// CORS for cross-origin requests from Electron app
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type'],
}));

// All routes require API key authentication
app.use('*', authMiddleware);

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'craft-agent-cloud' }));

// ============================================================
// File Storage Routes (R2)
// ============================================================

// Helper to build R2 key: {workspace}/{session}/{type}/{filename}
function buildR2Key(workspace: string, session: string, type: string, filename: string): string {
  return `${workspace}/${session}/${type}/${filename}`;
}

// Upload file
app.put('/files/:workspace/:session/:type/:filename', async (c) => {
  const { workspace, session, type, filename } = c.req.param();

  if (!isValidFileType(type)) {
    return c.json({ error: `Invalid file type: ${type}. Must be one of: attachments, downloads, long_responses` }, 400);
  }

  const key = buildR2Key(workspace, session, type, filename);
  const contentType = c.req.header('Content-Type') || 'application/octet-stream';
  const body = await c.req.arrayBuffer();

  await c.env.FILES.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: { uploadedAt: Date.now().toString() },
  });

  const metadata: FileMetadata = {
    name: filename,
    size: body.byteLength,
    mimeType: contentType,
    uploadedAt: Date.now(),
  };

  return c.json(metadata, 201);
});

// Download file (supports both auth header and signed URLs)
app.get('/files/:workspace/:session/:type/:filename', async (c) => {
  const { workspace, session, type, filename } = c.req.param();
  const sig = c.req.query('sig');
  const exp = c.req.query('exp');

  // If this is a signed URL request (no auth header), validate the signature
  if (sig && exp) {
    // Path must match what was used for signing (includes files/ prefix)
    const path = `files/${workspace}/${session}/${type}/${filename}`;
    const isValid = await validateSignedUrl(path, sig, exp, c.env.API_KEY);
    if (!isValid) {
      return c.json({ error: 'Invalid or expired signature' }, 403);
    }
  }
  // Otherwise, auth middleware already validated the API key

  if (!isValidFileType(type)) {
    return c.json({ error: `Invalid file type: ${type}` }, 400);
  }

  const key = buildR2Key(workspace, session, type, filename);
  const object = await c.env.FILES.get(key);

  if (!object) {
    return c.json({ error: 'File not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Length', object.size.toString());
  // Allow caching for signed URLs (they're time-limited anyway)
  headers.set('Cache-Control', 'private, max-age=3600');

  return new Response(object.body, { headers });
});

// Generate a signed URL for a file
app.post('/files/:workspace/:session/:type/:filename/sign', async (c) => {
  const { workspace, session, type, filename } = c.req.param();

  if (!isValidFileType(type)) {
    return c.json({ error: `Invalid file type: ${type}` }, 400);
  }

  const body = await c.req.json<{ expiresIn?: number }>().catch(() => ({}));
  const expiresIn = body.expiresIn || 900; // Default 15 minutes

  // Verify the file exists before generating a signed URL
  const key = buildR2Key(workspace, session, type, filename);
  const object = await c.env.FILES.head(key);
  if (!object) {
    return c.json({ error: 'File not found' }, 404);
  }

  const path = `files/${workspace}/${session}/${type}/${filename}`;
  const baseUrl = new URL(c.req.url).origin;

  const signedUrl = await generateSignedUrl(baseUrl, path, c.env.API_KEY, expiresIn);
  const expiresAt = Date.now() + expiresIn * 1000;

  return c.json({ url: signedUrl, expiresAt });
});

// Delete file
app.delete('/files/:workspace/:session/:type/:filename', async (c) => {
  const { workspace, session, type, filename } = c.req.param();

  if (!isValidFileType(type)) {
    return c.json({ error: `Invalid file type: ${type}` }, 400);
  }

  const key = buildR2Key(workspace, session, type, filename);
  await c.env.FILES.delete(key);

  return c.json({ success: true });
});

// List files in a type folder
app.get('/files/:workspace/:session/:type', async (c) => {
  const { workspace, session, type } = c.req.param();

  if (!isValidFileType(type)) {
    return c.json({ error: `Invalid file type: ${type}` }, 400);
  }

  const prefix = `${workspace}/${session}/${type}/`;
  const listed = await c.env.FILES.list({ prefix });

  const files: FileMetadata[] = listed.objects.map((obj) => ({
    name: obj.key.slice(prefix.length), // Remove prefix to get filename
    size: obj.size,
    mimeType: obj.httpMetadata?.contentType || 'application/octet-stream',
    uploadedAt: parseInt(obj.customMetadata?.uploadedAt || '0', 10) || obj.uploaded.getTime(),
  }));

  return c.json(files);
});

// Delete all files for a session (used when deleting a session)
app.delete('/files/:workspace/:session', async (c) => {
  const { workspace, session } = c.req.param();
  const prefix = `${workspace}/${session}/`;

  // List all objects with this prefix
  const listed = await c.env.FILES.list({ prefix });

  // Delete them all (R2 doesn't have bulk delete, so we do it one by one)
  await Promise.all(listed.objects.map((obj) => c.env.FILES.delete(obj.key)));

  return c.json({ success: true, deleted: listed.objects.length });
});

// ============================================================
// Workspace Routes (Durable Object)
// ============================================================

// Route everything under /workspace/:slug/* to the Durable Object
app.all('/workspace/:slug/*', async (c) => {
  const slug = c.req.param('slug');
  const id = c.env.WORKSPACE.idFromName(slug);
  const stub = c.env.WORKSPACE.get(id);

  // Strip /workspace/:slug prefix so the DO sees clean paths
  const url = new URL(c.req.url);
  const prefix = `/workspace/${slug}`;
  url.pathname = url.pathname.slice(prefix.length) || '/';

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

// Also support /workspace/:slug (without trailing path) for WebSocket upgrade
app.all('/workspace/:slug', async (c) => {
  const slug = c.req.param('slug');
  const id = c.env.WORKSPACE.idFromName(slug);
  const stub = c.env.WORKSPACE.get(id);

  const url = new URL(c.req.url);
  url.pathname = '/';

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

export default app;
export { WorkspaceDO } from './durable-objects/workspace.ts';
