// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { useCliProfiles } from '../useCliProfiles'
import { createMockBackend, flush, withScope } from './mockBackend'

// Credentials never sync, and the pasted-credential feature that read the
// cloud's credentials into the CLI accounts page is gone (0.2.32): loading the
// accounts and following their broadcasts asks the cloud nothing, whatever a
// switch an older build left on still says.
describe('useCliProfiles with credentials that never sync', () => {
  it('loads the accounts without asking for any sync state or credential inventory', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('cli_profiles.list', {
      profiles: [],
      defaults: {},
      supported_agents: ['claude'],
      // An older backend still sends these; they are ignored.
      portable_credentials: { 'claude/__default__': { agentKey: 'claude', slotId: '__default__' } },
      portable_supported: ['claude'],
    })
    const { result, scope } = withScope(() => useCliProfiles(mock.backend))
    await flush()
    mock.emit('cli_profiles.changed', { portable_credentials: {}, reason: 'portable-set' })
    mock.emit('ui.settings_changed', { settings: { 'sync-scopes': { credentials: true } } })
    await flush()

    expect(result.loaded.value).toBe(true)
    expect(mock.sent.map((s) => s.type).filter((t) => t.startsWith('sync.'))).toEqual([])
    expect(Object.keys(result)).not.toContain('portable')
    scope.stop()
  })
})
