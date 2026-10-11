// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { useCliProfiles } from '../useCliProfiles'
import { createMockBackend, flush, withScope } from './mockBackend'

// Review N1: credentials never sync, and a switch an older build left on must
// not surface on the CLI accounts page as a blank cloud error. The backend's
// answers below are the shapes test_sync_credentials_never_sync.py pins:
// sync.status reports credentials off whatever the disk says, and the
// inventory answers credentials as main did (not-connected offline, disabled
// connected).
const SUPPORTED = ['claude']

describe('useCliProfiles with credentials that never sync', () => {
  it.each(['connected', 'unreachable', 'connecting'] as const)(
    'shows the section as off, never as an error, when the link is %s',
    async (state) => {
      const mock = createMockBackend('connected')
      mock.setResponse('cli_profiles.list', { profiles: [], defaults: {}, supported_agents: SUPPORTED })
      mock.setResponse('sync.status', {
        available: ['prompts', 'mcp', 'skills', 'memory', 'credentials'],
        scopes: { prompts: true, mcp: false, skills: false, memory: false, credentials: false },
        link: { state },
      })
      mock.setResponse('sync.inventory', {
        status: state === 'connected' ? 'ok' : 'not-connected',
        scopes: {
          credentials: {
            scope: 'credentials',
            status: state === 'connected' ? 'disabled' : 'not-connected',
            items: [],
          },
        },
      })
      const { result, scope } = withScope(() => useCliProfiles(mock.backend))
      await flush()

      await result.refreshCloud()
      expect(result.cloudStatus.value).toBe('off')
      expect(result.cloudStatus.value).not.toBe('error')
      expect(result.cloudError.value).toBe('')
      expect(mock.sent.some((s) => s.type === 'sync.inventory')).toBe(false)
      scope.stop()
    },
  )
})
