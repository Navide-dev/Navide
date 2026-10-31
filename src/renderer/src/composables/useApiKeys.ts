import { onScopeDispose, ref } from 'vue'
import type { useBackend } from './useBackend'

/** A stored API key as the renderer sees it. The key itself never comes back
 *  from the backend: after saving, only the last four characters exist here. */
export interface ApiKeyRow {
  id: string
  kind: 'api-key'
  agentKey: string
  name: string
  last4: string
  monthlyReminderUsd: number | null
  createdAt: number
}

export type ApiKeyTestResult = 'ok' | 'rejected' | 'unknown'

interface ListPayload {
  ok?: boolean
  keys?: ApiKeyRow[]
  supportedAgents?: string[]
}

export interface ApiKeyAnswer {
  ok: boolean
  key?: ApiKeyRow
  result?: ApiKeyTestResult
  error_code?: string
}

export function useApiKeys(backend: ReturnType<typeof useBackend>) {
  const keys = ref<ApiKeyRow[]>([])
  const supportedAgents = ref<string[]>([])

  function apply(payload: ListPayload): void {
    keys.value = payload.keys ?? []
    supportedAgents.value = payload.supportedAgents ?? []
  }

  async function refresh(): Promise<void> {
    try {
      const resp = await backend.send<ListPayload>('api_keys.list', {})
      if (resp.payload?.ok) apply(resp.payload)
    } catch {
      // The list stays as it was; the next api_keys.changed refills it.
    }
  }

  async function call(type: string, payload: Record<string, unknown>): Promise<ApiKeyAnswer> {
    try {
      const resp = await backend.send<ApiKeyAnswer>(type, payload)
      return resp.payload ?? { ok: false, error_code: 'internal-error' }
    } catch {
      return { ok: false, error_code: 'internal-error' }
    }
  }

  const unsubscribe = backend.on('api_keys.changed', (raw) => apply(raw as ListPayload))
  onScopeDispose(unsubscribe)

  return {
    keys,
    supportedAgents,
    refresh,
    keysForAgent: (agentKey: string) => keys.value.filter((key) => key.agentKey === agentKey),
    create: (agentKey: string, name: string, secret: string, monthlyReminderUsd: number | null) =>
      call('api_keys.create', { agentKey, name, secret, monthlyReminderUsd }),
    update: (id: string, fields: { name?: string; monthlyReminderUsd?: number | null }) =>
      call('api_keys.update', { id, ...fields }),
    replaceSecret: (id: string, secret: string) => call('api_keys.replace_secret', { id, secret }),
    remove: (id: string) => call('api_keys.delete', { id }),
    testPasted: (agentKey: string, secret: string) => call('api_keys.test', { agentKey, secret }),
    testStored: (id: string) => call('api_keys.test', { id }),
  }
}
