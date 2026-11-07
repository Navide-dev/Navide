import type { useBackend } from './useBackend'
import type { SettingsPort } from '../ports/settings'

type HostBackend = ReturnType<typeof useBackend>

function errorMessage(response: { error?: { message?: string } | null }): string {
  return response.error?.message || 'Host capability failed'
}

export function createHostSettingsPort(backend: HostBackend): SettingsPort {
  return {
    status: backend.status,
    async getAll(): Promise<Record<string, unknown> | null> {
      const response = await backend.send<{ settings?: Record<string, unknown> }>('ui.settings.get', {})
      if (!response.ok) throw new Error(errorMessage(response))
      return response.payload?.settings ?? null
    },
    async setMany(updates: Record<string, unknown>): Promise<void> {
      const response = await backend.send('ui.settings.set', { updates })
      if (!response.ok) throw new Error(errorMessage(response))
    },
    onChanged(callback) {
      return backend.on('ui.settings_changed' as never, callback)
    },
  }
}
