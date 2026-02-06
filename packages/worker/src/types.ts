/**
 * Worker Bridge Message Types
 *
 * Shared types for communication between the Cloudflare Worker
 * and the Electron client via WebSocket.
 */

/** Metadata for a file attachment staged in R2 */
export interface AttachmentMeta {
  name: string
  key: string       // R2 object key (used to build download URL)
  mimeType: string
  size: number
}

/** Messages sent from Worker to Client */
export type WorkerToClientMessage =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; error: string }
  | { type: 'action'; url: string; id?: string; attachments?: AttachmentMeta[] }
  | { type: 'pong' }

/** Messages sent from Client to Worker */
export type ClientToWorkerMessage =
  | { type: 'auth'; apiKey: string }
  | { type: 'ack'; id: string; success: boolean; error?: string }
  | { type: 'ping' }

/** Worker environment bindings */
export interface Env {
  API_KEY: string
  BRIDGE: DurableObjectNamespace
  ATTACHMENTS: R2Bucket
}
