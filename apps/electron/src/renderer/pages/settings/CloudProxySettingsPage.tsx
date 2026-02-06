/**
 * CloudProxySettingsPage
 *
 * Settings page for configuring the Cloud Proxy (Worker Bridge).
 * Allows users to set the Worker URL and API Key for remote deeplink relay.
 * Auto-saves on change with debouncing (matches other settings pages).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { WorkerBridgeStatus } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsInput,
  SettingsSecretInput,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'cloud-proxy',
}

const STATUS_LABELS: Record<WorkerBridgeStatus, { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'text-green-500' },
  connecting: { label: 'Connecting...', className: 'text-yellow-500' },
  disconnected: { label: 'Disconnected', className: 'text-muted-foreground' },
  error: { label: 'Error', className: 'text-red-500' },
}

export default function CloudProxySettingsPage() {
  const [workerUrl, setWorkerUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<WorkerBridgeStatus>('disconnected')
  const isInitialLoadRef = useRef(true)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const workerUrlRef = useRef(workerUrl)
  const apiKeyRef = useRef(apiKey)
  const lastSavedRef = useRef<string | null>(null)

  // Keep refs in sync for unmount cleanup
  useEffect(() => { workerUrlRef.current = workerUrl }, [workerUrl])
  useEffect(() => { apiKeyRef.current = apiKey }, [apiKey])

  // Load config on mount
  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      try {
        const [config, currentStatus] = await Promise.all([
          window.electronAPI.getWorkerConfig(),
          window.electronAPI.getWorkerStatus(),
        ])
        const url = config.workerUrl ?? ''
        const key = config.apiKey ?? ''
        setWorkerUrl(url)
        setApiKey(key)
        setStatus(currentStatus)
        lastSavedRef.current = JSON.stringify({ url, key })
      } catch (error) {
        console.error('Failed to load worker config:', error)
      } finally {
        setTimeout(() => { isInitialLoadRef.current = false }, 100)
      }
    }
    load()
  }, [])

  // Listen for status changes
  useEffect(() => {
    if (!window.electronAPI) return
    const cleanup = window.electronAPI.onWorkerStatusChange((newStatus: WorkerBridgeStatus) => {
      setStatus(newStatus)
    })
    return cleanup
  }, [])

  // Auto-save with debouncing
  useEffect(() => {
    if (isInitialLoadRef.current) return

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
    }

    saveTimeoutRef.current = setTimeout(async () => {
      const current = JSON.stringify({ url: workerUrl, key: apiKey })
      if (current === lastSavedRef.current) return

      try {
        await window.electronAPI.setWorkerConfig({
          workerUrl: workerUrl.trim() || null,
          apiKey: apiKey.trim() || null,
        })
        lastSavedRef.current = current
      } catch (error) {
        console.error('Failed to save worker config:', error)
      }
    }, 800)

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
    }
  }, [workerUrl, apiKey])

  // Force save on unmount if unsaved changes
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
      }
      const current = JSON.stringify({ url: workerUrlRef.current, key: apiKeyRef.current })
      if (lastSavedRef.current !== current && !isInitialLoadRef.current) {
        window.electronAPI.setWorkerConfig({
          workerUrl: workerUrlRef.current.trim() || null,
          apiKey: apiKeyRef.current.trim() || null,
        }).catch((err) => {
          console.error('Failed to save worker config on unmount:', err)
        })
      }
    }
  }, [])

  const statusInfo = STATUS_LABELS[status]
  const isConfigured = !!(workerUrl.trim() && apiKey.trim())

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title="Cloud Proxy" actions={<HeaderMenu route={routes.view.settings('cloud-proxy')} helpFeature="cloud-proxy-settings" />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto space-y-8">
          {/* Connection */}
          <SettingsSection
            title="Connection"
            description="Connect to a Cloud Proxy for remote deeplink relay. Actions triggered via HTTP are relayed to your local app over WebSocket."
          >
            <SettingsCard divided>
              <SettingsInput
                label="Worker URL"
                description="Domain of your deployed Worker (e.g. my-worker.my-domain.workers.dev)"
                value={workerUrl}
                onChange={setWorkerUrl}
                placeholder="my-worker.my-domain.workers.dev"
                inCard
              />
              <SettingsSecretInput
                label="API Key"
                description="API key for authenticating with the Worker"
                value={apiKey}
                onChange={setApiKey}
                placeholder="Enter API key"
                inCard
              />
              {isConfigured && (
                <SettingsRow label="Status" inCard>
                  <span className={statusInfo.className}>{statusInfo.label}</span>
                </SettingsRow>
              )}
            </SettingsCard>
          </SettingsSection>
        </div>
        </ScrollArea>
      </div>
    </div>
  )
}
