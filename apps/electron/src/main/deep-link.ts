/**
 * Deep Link Handler
 *
 * Parses craftagents:// URLs and routes to appropriate actions.
 *
 * URL Formats (workspace is optional - uses active window if omitted):
 *
 * Compound format (hierarchical navigation):
 *   craftagents://allSessions[/session/{sessionId}]            - Session list (all sessions)
 *   craftagents://flagged[/session/{sessionId}]             - Session list (flagged filter)
 *   craftagents://state/{stateId}[/session/{sessionId}]     - Session list (state filter)
 *   craftagents://sources[/source/{sourceSlug}]          - Sources list
 *   craftagents://settings[/{subpage}]                   - Settings (general, shortcuts, preferences)
 *
 * Action format:
 *   craftagents://action/{actionName}[/{id}][?params]
 *   craftagents://workspace/{workspaceId}/action/{actionName}[?params]
 *
 * Actions:
 *   new-chat                  - Create new chat, optional ?input=text&name=name&send=true
 *                               If send=true is provided with input, immediately sends the message
 *   resume-sdk-session/{id}   - Resume Claude Code session by SDK session ID
 *   delete-session/{id}       - Delete session
 *   flag-session/{id}         - Flag session
 *   unflag-session/{id}       - Unflag session
 *   rename-session/{id}       - Rename session, requires ?name=New%20Name
 *
 * Examples:
 *   craftagents://allSessions                               (all sessions view)
 *   craftagents://allSessions/session/abc123                (specific session)
 *   craftagents://settings/shortcuts                     (shortcuts page)
 *   craftagents://sources/source/github                  (github source info)
 *   craftagents://action/new-chat                        (uses active window)
 *   craftagents://action/resume-sdk-session/{sdkId}      (resume Claude Code session)
 *   craftagents://workspace/ws123/allSessions/session/abc123   (targets specific workspace)
 */

import type { BrowserWindow } from 'electron'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'
import { IPC_CHANNELS } from '../shared/types'
import type { FileAttachment } from '../shared/types'

export interface DeepLinkTarget {
  /** Workspace ID - undefined means use active window */
  workspaceId?: string
  /** Compound route format (e.g., 'allSessions/session/abc123', 'settings/shortcuts') */
  view?: string
  /** Action route (e.g., 'new-chat', 'delete-session') */
  action?: string
  actionParams?: Record<string, string>
  /** Window mode - if set, opens in a new window instead of navigating in existing */
  windowMode?: 'focused' | 'full'
  /** Right sidebar param (e.g., 'sessionMetadata', 'files/path/to/file') */
  rightSidebar?: string
}

export interface DeepLinkResult {
  success: boolean
  error?: string
  windowId?: number
}

/**
 * Navigation payload sent to renderer via IPC
 */
export interface DeepLinkNavigation {
  /** Compound route format (e.g., 'allSessions/session/abc123', 'settings/shortcuts') */
  view?: string
  /** Action route (e.g., 'new-chat', 'delete-session') */
  action?: string
  actionParams?: Record<string, string>
  /** File attachments downloaded from worker (for new-chat with files) */
  attachments?: FileAttachment[]
}

/**
 * Parse window mode from URL search params
 */
function parseWindowMode(parsed: URL): 'focused' | 'full' | undefined {
  const windowParam = parsed.searchParams.get('window')
  if (windowParam === 'focused' || windowParam === 'full') {
    return windowParam
  }
  return undefined
}

/**
 * Parse right sidebar param from URL search params
 */
function parseRightSidebar(parsed: URL): string | undefined {
  return parsed.searchParams.get('sidebar') || undefined
}

/**
 * Parse a deep link URL into structured target
 */
export function parseDeepLink(url: string): DeepLinkTarget | null {
  try {
    const parsed = new URL(url)

    if (parsed.protocol !== 'craftagents:') {
      return null
    }

    // For custom protocols, the hostname contains the first path segment
    // e.g., craftagents://workspace/ws123 → hostname='workspace', pathname='/ws123'
    // e.g., craftagents://allSessions/chat/abc → hostname='allSessions', pathname='/chat/abc'
    const host = parsed.hostname
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    const windowMode = parseWindowMode(parsed)
    const rightSidebar = parseRightSidebar(parsed)

    // craftagents://auth-callback?... (OAuth callbacks - return null to let existing handler process)
    if (host === 'auth-callback') {
      return null
    }

    // Compound route prefixes
    const COMPOUND_ROUTE_PREFIXES = [
      'allSessions', 'flagged', 'state', 'sources', 'settings', 'skills'
    ]

    // craftagents://allSessions/..., craftagents://settings/..., etc. (compound routes)
    if (COMPOUND_ROUTE_PREFIXES.includes(host)) {
      // Reconstruct the full compound route from host + pathname
      const viewRoute = pathParts.length > 0 ? `${host}/${pathParts.join('/')}` : host
      return {
        workspaceId: undefined,
        view: viewRoute,
        windowMode,
        rightSidebar,
      }
    }

    // craftagents://workspace/{workspaceId}/... (with workspace targeting)
    if (host === 'workspace') {
      const workspaceId = pathParts[0]
      if (!workspaceId) return null

      const result: DeepLinkTarget = { workspaceId, windowMode, rightSidebar }

      // Check what type of route follows the workspace ID
      const routeType = pathParts[1]

      // Parse compound routes: /workspace/{id}/{compoundRoute}
      // e.g., /workspace/ws123/allSessions/session/abc123
      if (routeType && COMPOUND_ROUTE_PREFIXES.includes(routeType)) {
        const viewRoute = pathParts.slice(1).join('/')
        result.view = viewRoute
        return result
      }

      // Parse /action/{actionName}/...
      if (routeType === 'action') {
        result.action = pathParts[2]
        result.actionParams = {}
        // Handle path-based ID (e.g., /action/delete-session/{sessionId})
        if (pathParts[3]) {
          result.actionParams.id = pathParts[3]
        }
        parsed.searchParams.forEach((value, key) => {
          // Skip the window and sidebar params - they're handled separately
          if (key !== 'window' && key !== 'sidebar') {
            result.actionParams![key] = value
          }
        })
        return result
      }

      return result
    }

    // craftagents://action/... (no workspace - uses active window)
    if (host === 'action') {
      const result: DeepLinkTarget = {
        workspaceId: undefined,
        action: pathParts[0],
        actionParams: {},
        windowMode,
        rightSidebar,
      }

      if (pathParts[1]) {
        result.actionParams!.id = pathParts[1]
      }

      parsed.searchParams.forEach((value, key) => {
        // Skip the window and sidebar params - they're handled separately
        if (key !== 'window' && key !== 'sidebar') {
          result.actionParams![key] = value
        }
      })

      return result
    }

    return null
  } catch (error) {
    mainLog.error('[DeepLink] Failed to parse URL:', url, error)
    return null
  }
}

/**
 * Wait for window's renderer to signal ready
 */
function waitForWindowReady(window: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => {
        // TIMING NOTE: This 100ms delay allows React to mount and register
        // IPC listeners before we send the deep link. `did-finish-load` fires
        // when the HTML is loaded, but React's useEffect hooks haven't run yet.
        // A proper handshake (renderer signals "ready") would be cleaner but
        // adds complexity for minimal gain - this delay is sufficient for all
        // practical cases and only affects reload scenarios.
        setTimeout(resolve, 100)
      })
    } else {
      resolve()
    }
  })
}

/**
 * Build a deep link URL without the window query parameter
 */
function buildDeepLinkWithoutWindowParam(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.delete('window')
  return parsed.toString()
}

/**
 * Handle a deep link by navigating to the target
 */
export async function handleDeepLink(
  url: string,
  windowManager: WindowManager,
  attachments?: FileAttachment[]
): Promise<DeepLinkResult> {
  mainLog.info('[DeepLink] Received URL:', url)
  const target = parseDeepLink(url)

  if (!target) {
    mainLog.warn('[DeepLink] Failed to parse URL:', url)
    // Return success for null targets (like auth-callback) - they're handled elsewhere
    if (url.includes('auth-callback')) {
      return { success: true }
    }
    return { success: false, error: 'Invalid deep link URL' }
  }

  mainLog.info('[DeepLink] Parsed target:', JSON.stringify(target))

  // Resolve workspace identifier to actual workspace ID (from global config).
  // Deep links may use slugs (e.g., 'TSGS') or ws_-prefixed config IDs (e.g., 'ws_6f5eb9a1'),
  // but the window manager uses global config UUIDs. Without this resolution,
  // focusOrCreateWindow() never finds the existing window and always creates a new one.
  if (target.workspaceId) {
    const { getWorkspaces } = await import('@craft-agent/shared/config')
    const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
    const workspaces = getWorkspaces()

    const knownIds = workspaces.map(ws => ws.id)
    mainLog.info('[DeepLink] Workspace lookup — target:', target.workspaceId, '| known IDs:', knownIds)

    // 1. Try exact workspace ID match
    const directMatch = workspaces.find(ws => ws.id === target.workspaceId)
    if (directMatch) {
      mainLog.info('[DeepLink] Direct workspace ID match found')
    } else {
      // 2. Try matching by slug or workspace config ID (ws_-prefixed)
      mainLog.info('[DeepLink] No direct ID match, trying slug/config ID lookup...')
      let resolved = false
      for (const ws of workspaces) {
        const config = loadWorkspaceConfig(ws.rootPath)
        mainLog.info('[DeepLink] Checking workspace:', ws.id, '| slug:', config?.slug, '| configId:', config?.id)
        if (config?.slug === target.workspaceId || config?.id === target.workspaceId) {
          mainLog.info('[DeepLink] Resolved workspace identifier to ID:', target.workspaceId, '→', ws.id)
          target.workspaceId = ws.id
          resolved = true
          break
        }
      }

      // 3. If still unresolved, clear workspaceId so we fall back to focused/last active window
      //    instead of creating a new window with an invalid workspace ID
      if (!resolved) {
        mainLog.warn('[DeepLink] Could not resolve workspace identifier:', target.workspaceId, '— falling back to active window')
        target.workspaceId = undefined
      }
    }
  }

  // If windowMode is set, create a new window instead of navigating in existing
  if (target.windowMode) {
    mainLog.info('[DeepLink] windowMode detected:', target.windowMode)
    // Get workspaceId from target or from current window
    let wsId = target.workspaceId
    if (!wsId) {
      const focusedWindow = windowManager.getFocusedWindow()
      mainLog.info('[DeepLink] focusedWindow:', focusedWindow?.id)
      if (focusedWindow) {
        wsId = windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
        mainLog.info('[DeepLink] wsId from focused window:', wsId)
      }
      if (!wsId) {
        const allWindows = windowManager.getAllWindows()
        mainLog.info('[DeepLink] allWindows count:', allWindows.length)
        if (allWindows.length > 0) {
          wsId = allWindows[0].workspaceId
          mainLog.info('[DeepLink] wsId from first window:', wsId)
        }
      }
    }

    if (!wsId) {
      mainLog.error('[DeepLink] No workspace available for new window')
      return { success: false, error: 'No workspace available for new window' }
    }

    // Build URL without window param for navigation inside the new window
    const navUrl = buildDeepLinkWithoutWindowParam(url)
    mainLog.info('[DeepLink] Creating new window with navUrl:', navUrl)

    const window = windowManager.createWindow({
      workspaceId: wsId,
      focused: target.windowMode === 'focused',
      initialDeepLink: navUrl,
    })
    mainLog.info('[DeepLink] Window created:', window.webContents.id)

    return { success: true, windowId: window.webContents.id }
  }

  // 1. Get target window (existing behavior for non-window-mode links)
  let window: BrowserWindow | null = null

  const allManagedWindows = windowManager.getAllWindows()
  mainLog.info('[DeepLink] Window resolution — workspaceId:', target.workspaceId ?? '(none)',
    '| open windows:', allManagedWindows.map(w => `${w.workspaceId}:${w.window.webContents.id}`))

  if (target.workspaceId) {
    // Workspace specified - focus or create window for that workspace
    mainLog.info('[DeepLink] Looking for window with workspaceId:', target.workspaceId)
    window = windowManager.focusOrCreateWindow(target.workspaceId)
    mainLog.info('[DeepLink] focusOrCreateWindow result — webContentsId:', window.webContents.id,
      '| isNew:', !allManagedWindows.some(w => w.window.webContents.id === window!.webContents.id))
  } else {
    // No workspace - use focused window or last active
    const focused = windowManager.getFocusedWindow()
    const lastActive = windowManager.getLastActiveWindow()
    mainLog.info('[DeepLink] No workspace — focused:', focused?.webContents.id ?? 'none',
      '| lastActive:', lastActive?.webContents.id ?? 'none')
    window = focused ?? lastActive

    if (!window) {
      mainLog.warn('[DeepLink] No windows available to navigate')
      // No windows at all - can't navigate without a workspace
      return { success: false, error: 'No active window to navigate' }
    }

    // Focus the window
    if (window.isMinimized()) {
      window.restore()
    }
    window.focus()
  }

  // 2. Wait for window to be ready (renderer loaded)
  await waitForWindowReady(window)

  // 3. Send navigation command to renderer
  if (target.view || target.action) {
    const navigation: DeepLinkNavigation = {
      view: target.view,
      action: target.action,
      actionParams: target.actionParams,
      attachments,
    }
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      mainLog.info('[DeepLink] Sending navigation to window:', window.webContents.id, '| action:', target.action, '| view:', target.view)
      window.webContents.send(IPC_CHANNELS.DEEP_LINK_NAVIGATE, navigation)
    } else {
      mainLog.warn('[DeepLink] Window destroyed before navigation could be sent')
    }
  }

  const resultWindowId = window.isDestroyed() ? -1 : window.webContents.id
  mainLog.info('[DeepLink] Complete — success: true, windowId:', resultWindowId)
  return { success: true, windowId: resultWindowId }
}
