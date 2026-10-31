import type { CliProfile } from '../../composables/useCliProfiles'
import type { useBackend } from '../../composables/useBackend'

/** A CLI profile of the API key kind. The key itself never comes back from the
 *  backend: after saving, only its last four characters exist here. */
export interface ApiKeyProfile extends CliProfile {
  authKind: 'api-key'
  last4: string
  monthlyReminderUsd: number | null
  autoSwitch: boolean
}

export type ApiKeyTestResult = 'ok' | 'rejected' | 'unknown'

export interface ApiKeyAnswer {
  ok: boolean
  profile?: ApiKeyProfile
  result?: ApiKeyTestResult
  error_code?: string
}

/** Same list as the backend's api_key_accounts.SUPPORTED_AGENT_KEYS. */
export const API_KEY_AGENTS: readonly string[] = ['claude', 'codex']

export function isApiKeyProfile(profile: CliProfile | null | undefined): profile is ApiKeyProfile {
  return (profile as Partial<ApiKeyProfile> | null | undefined)?.authKind === 'api-key'
}

/** The `cli_profiles.api_key_*` messages. Accounts themselves come from
 *  `useCliProfiles`: each change here reaches it as `cli_profiles.changed`. */
export function apiKeyAccountCalls(backend: ReturnType<typeof useBackend>) {
  async function call(type: string, payload: Record<string, unknown>): Promise<ApiKeyAnswer> {
    try {
      const resp = await backend.send<ApiKeyAnswer>(type, payload)
      return resp.payload ?? { ok: false, error_code: 'internal-error' }
    } catch {
      return { ok: false, error_code: 'internal-error' }
    }
  }

  return {
    create: (agentKey: string, name: string, secret: string, monthlyReminderUsd: number | null) =>
      call('cli_profiles.api_key_create', { agentKey, name, secret, monthlyReminderUsd }),
    update: (id: string, fields: { name?: string; monthlyReminderUsd?: number | null; autoSwitch?: boolean }) =>
      call('cli_profiles.api_key_update', { id, ...fields }),
    replaceSecret: (id: string, secret: string) => call('cli_profiles.api_key_replace', { id, secret }),
    remove: (id: string) => call('cli_profiles.api_key_delete', { id }),
    testPasted: (agentKey: string, secret: string) => call('cli_profiles.api_key_test', { agentKey, secret }),
    testStored: (id: string) => call('cli_profiles.api_key_test', { id }),
  }
}
