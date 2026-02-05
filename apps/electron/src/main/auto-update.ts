/**
 * Auto-update module using electron-updater
 *
 * Handles checking for updates, downloading, and installing via the standard
 * electron-updater library. Updates are served from https://agents.craft.do/electron/latest
 * using the generic provider (YAML manifests + binaries on R2/S3).
 *
 * Platform behavior:
 * - macOS: Downloads zip, extracts and swaps app bundle atomically
 *          NOTE: Squirrel.Mac does NOT fire download-progress events reliably.
 *          We use -1 (indeterminate) for progress and rely on update-downloaded event.
 * - Windows: Downloads NSIS installer, runs silently on quit (progress events work)
 * - Linux: Downloads AppImage, replaces current file (progress events work)
 *
 * All platforms: quitAndInstall() handles restart natively — no external scripts.
 */

import { autoUpdater } from 'electron-updater'
import { app } from 'electron'
import { platform } from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { mainLog } from './logger'
import { getAppVersion } from '@craft-agent/shared/version'
import {
  getDismissedUpdateVersion,
  clearDismissedUpdateVersion,
} from '@craft-agent/shared/config'
import type { UpdateInfo } from '../shared/types'
import type { WindowManager } from './window-manager'

// Platform detection for progress event support
// macOS (Squirrel.Mac) does NOT reliably fire download-progress events
const PLATFORM = platform()
const IS_MAC = PLATFORM === 'darwin'
const IS_WINDOWS = PLATFORM === 'win32'
const SUPPORTS_PROGRESS = !IS_MAC

// Get the update cache directory path (for file watcher fallback on macOS)
// electron-updater uses these paths:
// - Windows: %LOCALAPPDATA%/{appName}-updater/pending
// - macOS: ~/Library/Caches/{appName}-updater/pending
// - Linux: ~/.cache/{appName}-updater/pending
function getUpdateCacheDir(): string {
  const appName = app.getName()
  if (IS_MAC) {
    return path.join(app.getPath('home'), 'Library', 'Caches', `${appName}-updater`, 'pending')
  } else if (IS_WINDOWS) {
    // Windows uses LOCALAPPDATA, not APPDATA (roaming)
    const localAppData = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local')
    return path.join(localAppData, `${appName}-updater`, 'pending')
  } else {
    // Linux
    return path.join(app.getPath('home'), '.cache', `${appName}-updater`, 'pending')
  }
}

// Module state — keeps track of update info for IPC queries
let updateInfo: UpdateInfo = {
  available: false,
  currentVersion: getAppVersion(),
  latestVersion: null,
  downloadState: 'idle',
  downloadProgress: 0,
  supportsProgress: SUPPORTS_PROGRESS,
}

let windowManager: WindowManager | null = null

// Flag to indicate update is in progress — used to prevent force exit during quitAndInstall
let __isUpdating = false

/**
 * Check if an update installation is in progress.
 * Used by main process to avoid force-quitting during update.
 */
export function isUpdating(): boolean {
  return __isUpdating
}

/**
 * Set the window manager for broadcasting update events to renderer windows
 */
export function setWindowManager(wm: WindowManager): void {
  windowManager = wm
}

/**
 * Get current update info (called by IPC handler)
 */
export function getUpdateInfo(): UpdateInfo {
  return { ...updateInfo }
}

/**
 * Broadcast update info to all renderer windows.
 * Creates a snapshot to avoid race conditions during broadcast.
 */
function broadcastUpdateInfo(): void {
  if (!windowManager) return

  const snapshot = { ...updateInfo }
  const windows = windowManager.getAllWindows()
  for (const { window } of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('update:available', snapshot)
    }
  }
}

/**
 * Broadcast download progress to all renderer windows.
 */
function broadcastDownloadProgress(progress: number): void {
  if (!windowManager) return

  const windows = windowManager.getAllWindows()
  for (const { window } of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('update:downloadProgress', progress)
    }
  }
}

// ─── Configure electron-updater ───────────────────────────────────────────────

// Auto-download updates in the background after detection
autoUpdater.autoDownload = true

// Install on app quit (if update is downloaded but user hasn't clicked "Restart")
autoUpdater.autoInstallOnAppQuit = true

// Use the logger for electron-updater internal logging
autoUpdater.logger = {
  info: (msg: unknown) => mainLog.info('[electron-updater]', msg),
  warn: (msg: unknown) => mainLog.warn('[electron-updater]', msg),
  error: (msg: unknown) => mainLog.error('[electron-updater]', msg),
  debug: (msg: unknown) => mainLog.info('[electron-updater:debug]', msg),
}

// ─── macOS File Watcher Fallback ──────────────────────────────────────────────
// Squirrel.Mac doesn't fire download-progress events, so we watch the cache directory
// to detect when the download is complete as a fallback mechanism.

let macOSWatcherInterval: NodeJS.Timeout | null = null
let macOSFallbackTimeout: NodeJS.Timeout | null = null

/**
 * Start watching the update cache directory on macOS for download completion.
 * Uses polling since chokidar would add a dependency we want to avoid.
 */
function startMacOSDownloadWatcher(version: string): void {
  if (!IS_MAC) return

  const cacheDir = getUpdateCacheDir()
  mainLog.info(`[auto-update] Starting macOS download watcher on: ${cacheDir}`)

  // Clean up any existing watcher
  stopMacOSDownloadWatcher()

  // Poll every 2 seconds to check for downloaded file
  let lastSize = 0
  let stableCount = 0
  let pollCount = 0

  macOSWatcherInterval = setInterval(() => {
    pollCount++
    try {
      if (!fs.existsSync(cacheDir)) {
        if (pollCount % 5 === 0) {
          mainLog.info(`[auto-update] macOS watcher: cache directory doesn't exist yet (poll #${pollCount})`)
        }
        return // Directory doesn't exist yet, keep waiting
      }

      const files = fs.readdirSync(cacheDir)
      if (pollCount % 5 === 0) {
        mainLog.info(`[auto-update] macOS watcher poll #${pollCount}, files: ${JSON.stringify(files)}`)
      }

      // Look for any update file (zip, dmg, or update-info.json indicating completion)
      const updateFile = files.find(f =>
        f.endsWith('.zip') || f.endsWith('.dmg') || f === 'update-info.json'
      )

      if (updateFile) {
        const filePath = path.join(cacheDir, updateFile)
        const stats = fs.statSync(filePath)

        // Check if file size is stable (download complete)
        if (stats.size === lastSize && stats.size > 0) {
          stableCount++
          mainLog.info(`[auto-update] macOS watcher: ${updateFile} size stable (${stats.size} bytes), count: ${stableCount}`)
          // File size stable for 4 seconds (2 checks) = likely complete
          if (stableCount >= 2) {
            mainLog.info(`[auto-update] macOS watcher detected complete download: ${updateFile} (${stats.size} bytes)`)
            stopMacOSDownloadWatcher()

            // Only update state if we're still in 'downloading' state
            // (the update-downloaded event might have already fired)
            if (updateInfo.downloadState === 'downloading') {
              updateInfo = {
                ...updateInfo,
                downloadState: 'ready',
                downloadProgress: 100,
              }
              broadcastUpdateInfo()
            }
          }
        } else {
          lastSize = stats.size
          stableCount = 0
        }
      }
    } catch (error) {
      mainLog.warn(`[auto-update] macOS watcher error:`, error)
    }
  }, 2000)

  // Fallback: After 30 seconds, if we're still downloading, force check the file system
  // This handles cases where update-downloaded event never fires
  macOSFallbackTimeout = setTimeout(() => {
    mainLog.info('[auto-update] macOS 30-second fallback triggered')
    if (updateInfo.downloadState === 'downloading') {
      // Check if file actually exists now
      const existing = checkForExistingDownload()
      if (existing.exists) {
        mainLog.info('[auto-update] macOS fallback: file exists, forcing state to ready')
        stopMacOSDownloadWatcher()
        updateInfo = {
          ...updateInfo,
          downloadState: 'ready',
          downloadProgress: 100,
        }
        broadcastUpdateInfo()
      } else {
        mainLog.info('[auto-update] macOS fallback: file still not found, continuing to wait')
      }
    }
  }, 30 * 1000)

  // Stop watching after 10 minutes (download should be done by then)
  setTimeout(() => {
    if (macOSWatcherInterval) {
      mainLog.info('[auto-update] macOS watcher timed out after 10 minutes')
      stopMacOSDownloadWatcher()
    }
  }, 10 * 60 * 1000)
}

/**
 * Stop the macOS download watcher
 */
function stopMacOSDownloadWatcher(): void {
  if (macOSWatcherInterval) {
    clearInterval(macOSWatcherInterval)
    macOSWatcherInterval = null
  }
  if (macOSFallbackTimeout) {
    clearTimeout(macOSFallbackTimeout)
    macOSFallbackTimeout = null
  }
}

// ─── Event handlers ───────────────────────────────────────────────────────────

autoUpdater.on('checking-for-update', () => {
  mainLog.info('[auto-update] Checking for updates...')
})

autoUpdater.on('update-available', (info) => {
  mainLog.info(`[auto-update] Update available: ${updateInfo.currentVersion} → ${info.version}`)
  mainLog.info(`[auto-update] Platform: ${PLATFORM}, supports progress: ${SUPPORTS_PROGRESS}`)

  // First, check electron-updater's internal state (most reliable)
  const internalState = checkElectronUpdaterState()
  if (internalState.ready) {
    mainLog.info(`[auto-update] electron-updater reports download ready`)
    updateInfo = {
      ...updateInfo,
      available: true,
      latestVersion: info.version,
      downloadState: 'ready',
      downloadProgress: 100,
    }
    broadcastUpdateInfo()
    return
  }

  // Fallback: check if file exists in cache directory
  const existing = checkForExistingDownload()
  if (existing.exists) {
    mainLog.info(`[auto-update] Update already downloaded (file check), setting state to ready`)
    updateInfo = {
      ...updateInfo,
      available: true,
      latestVersion: info.version,
      downloadState: 'ready',
      downloadProgress: 100,
    }
    broadcastUpdateInfo()
    return
  }

  updateInfo = {
    ...updateInfo,
    available: true,
    latestVersion: info.version,
    downloadState: 'downloading',
    // On macOS, use -1 to indicate indeterminate progress (Squirrel.Mac doesn't fire progress events)
    // On Windows/Linux, start at 0 and progress will be updated via download-progress event
    downloadProgress: SUPPORTS_PROGRESS ? 0 : -1,
  }
  broadcastUpdateInfo()

  // On macOS, start file watcher as fallback for download completion detection
  if (IS_MAC) {
    startMacOSDownloadWatcher(info.version)
  }
})

autoUpdater.on('update-not-available', (info) => {
  mainLog.info(`[auto-update] Already up to date (${info.version})`)

  updateInfo = {
    ...updateInfo,
    available: false,
    latestVersion: info.version,
    downloadState: 'idle',
  }
  broadcastUpdateInfo()
})

autoUpdater.on('download-progress', (progress) => {
  const percent = Math.round(progress.percent)
  updateInfo = { ...updateInfo, downloadProgress: percent }
  broadcastDownloadProgress(percent)
})

autoUpdater.on('update-downloaded', async (info) => {
  mainLog.info(`[auto-update] Update downloaded: v${info.version}`)

  // Stop macOS watcher if running (no longer needed)
  stopMacOSDownloadWatcher()

  updateInfo = {
    ...updateInfo,
    available: true,
    latestVersion: info.version,
    downloadState: 'ready',
    downloadProgress: 100,
  }
  broadcastUpdateInfo()

  // Rebuild menu to show "Install Update..." option
  const { rebuildMenu } = await import('./menu')
  rebuildMenu()
})

autoUpdater.on('error', (error) => {
  mainLog.error('[auto-update] Error:', error.message)

  // Stop macOS watcher if running
  stopMacOSDownloadWatcher()

  updateInfo = {
    ...updateInfo,
    downloadState: 'error',
    error: error.message,
  }
  broadcastUpdateInfo()
})

// ─── Exported API ─────────────────────────────────────────────────────────────

/**
 * Check if electron-updater already has a validated download ready.
 * This uses electron-updater's internal state which is more reliable than file checks.
 */
function checkElectronUpdaterState(): { ready: boolean; version?: string } {
  try {
    // Access electron-updater's internal downloadedUpdateHelper
    // @ts-expect-error - accessing internal API for reliability
    const helper = autoUpdater.downloadedUpdateHelper
    if (helper) {
      mainLog.info(`[auto-update] downloadedUpdateHelper exists, cacheDir: ${helper.cacheDir}`)
      // @ts-expect-error - accessing internal API
      const versionInfo = helper.versionInfo
      if (versionInfo) {
        mainLog.info(`[auto-update] electron-updater has validated download: ${JSON.stringify(versionInfo)}`)
        return { ready: true, version: versionInfo.version }
      }
    }
  } catch (error) {
    mainLog.warn('[auto-update] Error checking electron-updater state:', error)
  }
  return { ready: false }
}

/**
 * Options for checkForUpdates
 */
interface CheckOptions {
  /** If true, automatically start download when update is found (default: true) */
  autoDownload?: boolean
}

/**
 * Check if a downloaded update already exists in the cache directory.
 * This helps detect updates that were downloaded in a previous session.
 */
function checkForExistingDownload(): { exists: boolean; version?: string } {
  try {
    const cacheDir = getUpdateCacheDir()
    mainLog.info(`[auto-update] Checking cache directory: ${cacheDir}`)

    if (!fs.existsSync(cacheDir)) {
      mainLog.info(`[auto-update] Cache directory does not exist`)
      return { exists: false }
    }

    const files = fs.readdirSync(cacheDir)
    mainLog.info(`[auto-update] Files in cache: ${JSON.stringify(files)}`)

    // Look for update info file that electron-updater creates
    const updateInfoFile = files.find(f => f === 'update-info.json')
    if (updateInfoFile) {
      const infoPath = path.join(cacheDir, updateInfoFile)
      const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8'))
      mainLog.info(`[auto-update] update-info.json contents: ${JSON.stringify(info)}`)

      // electron-updater uses 'fileName' (not 'path') in update-info.json
      const fileName = info.fileName || info.path
      if (fileName && fs.existsSync(path.join(cacheDir, fileName))) {
        mainLog.info(`[auto-update] Found existing download via update-info.json: ${fileName}`)
        return { exists: true, version: info.version }
      }
    }

    // Fallback: check for any installer/zip/dmg file
    const downloadFile = files.find(f =>
      f.endsWith('.zip') ||
      f.endsWith('.exe') ||
      f.endsWith('.AppImage') ||
      f.endsWith('.dmg') ||
      f.endsWith('.nupkg')
    )
    if (downloadFile) {
      mainLog.info(`[auto-update] Found existing download file: ${downloadFile}`)
      return { exists: true }
    }

    mainLog.info(`[auto-update] No existing download found in cache`)
    return { exists: false }
  } catch (error) {
    mainLog.warn('[auto-update] Error checking for existing download:', error)
    return { exists: false }
  }
}

/**
 * Check for available updates.
 * Returns the current UpdateInfo state after check completes.
 *
 * @param options.autoDownload - If false, only checks without downloading (for manual "Check Now")
 */
export async function checkForUpdates(options: CheckOptions = {}): Promise<UpdateInfo> {
  const { autoDownload = true } = options

  // Temporarily override autoDownload for this check if needed
  // (e.g., manual check from settings shouldn't auto-download on metered connections)
  const previousAutoDownload = autoUpdater.autoDownload
  autoUpdater.autoDownload = autoDownload

  try {
    // Check for updates - this returns a promise that resolves with the check result
    const result = await autoUpdater.checkForUpdates()

    // If update is available and was already downloaded, the update-downloaded event
    // should fire. Wait a moment for events to settle before returning.
    if (result?.updateInfo) {
      // Give electron-updater time to fire update-downloaded if file exists
      await new Promise(resolve => setTimeout(resolve, 500))

      // Double-check: if we're still showing 'downloading' but file exists, update state
      if (updateInfo.downloadState === 'downloading') {
        const existing = checkForExistingDownload()
        if (existing.exists) {
          mainLog.info('[auto-update] Update already downloaded, updating state to ready')
          updateInfo = {
            ...updateInfo,
            downloadState: 'ready',
            downloadProgress: 100,
          }
          broadcastUpdateInfo()
        }
      }
    }
  } catch (error) {
    mainLog.error('[auto-update] Check failed:', error)
    updateInfo = {
      ...updateInfo,
      downloadState: 'error',
      error: error instanceof Error ? error.message : 'Check failed',
    }
  } finally {
    // Restore previous autoDownload setting
    autoUpdater.autoDownload = previousAutoDownload
  }

  return getUpdateInfo()
}

/**
 * Install the downloaded update and restart the app.
 * Calls electron-updater's quitAndInstall which handles:
 * - macOS: Extracts zip and swaps app bundle
 * - Windows: Runs NSIS installer silently
 * - Linux: Replaces AppImage file
 * Then relaunches the app automatically.
 */
export async function installUpdate(): Promise<void> {
  if (updateInfo.downloadState !== 'ready') {
    throw new Error('No update ready to install')
  }

  mainLog.info('[auto-update] Installing update and restarting...')

  updateInfo = { ...updateInfo, downloadState: 'installing' }
  broadcastUpdateInfo()

  // Clear dismissed version since user is explicitly updating
  clearDismissedUpdateVersion()

  // Set flag to prevent force exit from breaking electron-updater's shutdown sequence
  __isUpdating = true

  try {
    // isSilent=false shows the installer UI on Windows if needed (fallback)
    // isForceRunAfter=true ensures the app relaunches after install
    autoUpdater.quitAndInstall(false, true)
  } catch (error) {
    __isUpdating = false
    mainLog.error('[auto-update] quitAndInstall failed:', error)
    updateInfo = { ...updateInfo, downloadState: 'error' }
    broadcastUpdateInfo()
    throw error
  }
}

/**
 * Result of update check on launch
 */
export interface UpdateOnLaunchResult {
  action: 'none' | 'skipped' | 'ready' | 'downloading'
  reason?: string
  version?: string | null
}

/**
 * Check for updates on app launch.
 * - Checks immediately (no delay)
 * - Respects dismissed version (skips notification but allows manual check)
 * - Auto-downloads if update available
 */
export async function checkForUpdatesOnLaunch(): Promise<UpdateOnLaunchResult> {
  mainLog.info('[auto-update] Checking for updates on launch...')

  const info = await checkForUpdates({ autoDownload: true })

  if (!info.available) {
    return { action: 'none' }
  }

  // Check if this version was dismissed by user
  const dismissedVersion = getDismissedUpdateVersion()
  if (dismissedVersion === info.latestVersion) {
    mainLog.info(`[auto-update] Update ${info.latestVersion} was dismissed, skipping notification`)
    return { action: 'skipped', reason: 'dismissed', version: info.latestVersion }
  }

  if (info.downloadState === 'ready') {
    return { action: 'ready', version: info.latestVersion }
  }

  // Download in progress — will notify when ready via update-downloaded event
  return { action: 'downloading', version: info.latestVersion }
}
