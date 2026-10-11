// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { useCliProfiles } from '../useCliProfiles'
import { createMockBackend, flush, withScope } from './mockBackend'

// Review N1: a credentials switch an older build left on is shown as main
// showed it. Offline, sync.status carries the stored switch (true) and the
// inventory answers not-connected (the shapes test_sync_credentials_never_sync.py
// pins), so the CLI accounts page says "not connected", never a blank error.
const SUPPORTED = ['claude']

describe('useCliProfiles with credentials that never sync', () => {
  it.each(['unreachable', 'connecting', 'unauthorized'] as const)(
    'shows "not connected" as main did, never an error, when the link is %s',
    async (state) => {
      const mock = createMockBackend('connected')
      mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
      mock.setResponse('sync.status', {
        available: ['prompts', 'mcp', 'skills', 'memory', 'credentials'],
        scopes: { prompts: true, mcp: false, skills: false, memory: false, credentials: true },
        neverSynced: ['memory', 'credentials'],
        link: { state },
      })
      mock.setResponse('sync.inventory', {
        status: 'not-connected',
        scopes: { credentials: { scope: 'credentials', status: 'not-connected', items: [] } },
      })
      const { result, scope } = withScope(() => useCliProfiles(mock.backend))
      await flush()

      await result.refreshCloud()
      expect(result.cloudStatus.value).toBe('not-connected')
      expect(result.cloudError.value).toBe('')
      scope.stop()
    },
  )
})
