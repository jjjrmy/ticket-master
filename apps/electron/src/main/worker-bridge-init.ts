/**
 * Worker Bridge Initialization
 *
 * Manages the singleton WorkerBridge instance and provides access
 * for IPC handlers and the main process startup.
 */

import { WorkerBridge, type WorkerBridgeStatus } from './worker-bridge'
import type { WindowManager } from './window-manager'
import { mainLog } from './logger'
import { IPC_CHANNELS } from '../shared/types'

let bridge: WorkerBridge | null = null

/**
 * Get the singleton WorkerBridge instance.
 */
export function getWorkerBridge(): WorkerBridge | null {
  return bridge
}

/**
 * Initialize the Worker Bridge.
 * Reads config and starts connection if Worker URL is configured.
 */
export async function initWorkerBridge(windowManager: WindowManager): Promise<void> {
  bridge = new WorkerBridge(windowManager)

  // Broadcast status changes to all renderer windows
  bridge.onStatusChange((status: WorkerBridgeStatus) => {
    for (const { window } of windowManager.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.WORKER_STATUS_CHANGED, status)
      }
    }
  })

  // Load config and start if configured
  try {
    const { getWorkerUrl, getWorkerApiKey } = await import('@craft-agent/shared/config/storage')
    const workerUrl = getWorkerUrl()
    const apiKey = await getWorkerApiKey()

    if (workerUrl && apiKey) {
      mainLog.info('[WorkerBridge] Starting with URL:', workerUrl)
      bridge.start({ workerUrl, apiKey })
    } else {
      mainLog.info('[WorkerBridge] Not configured, skipping')
    }
  } catch (err) {
    mainLog.error('[WorkerBridge] Failed to initialize:', err)
  }
}
