// Card K4: the Developer Mode switch is audited as a Host event row. Only the
// Host builds one; a plugin call can never carry the Host source.
import { describe, expect, it, vi } from 'vitest'
import { PluginActivityRecorder, type PluginActivityRow } from './pluginActivity'

function recorder() {
  const send = vi.fn(async () => undefined)
  return { send, recorder: new PluginActivityRecorder(() => send, 60_000) }
}

describe('Host event activity rows', () => {
  it('sends one exact row per switch change under the Host event identity', async () => {
    const { send, recorder: r } = recorder()
    r.recordHostEvent('developerMode.on', '0.2.26', 1_000)
    r.recordHostEvent('developerMode.off', '0.2.26', 2_000)
    await r.flush()
    expect(send).toHaveBeenCalledWith('plugin.activity.record', {
      rows: [
        { at: 1_000, plugin_id: 'host', plugin_version: '0.2.26', workspace: '', source: 'host', address: 'developerMode.on', outcome: 'allowed', count: 1 },
        { at: 2_000, plugin_id: 'host', plugin_version: '0.2.26', workspace: '', source: 'host', address: 'developerMode.off', outcome: 'allowed', count: 1 },
      ],
    })
  })

  it('drops a plugin call row that claims the Host source', async () => {
    const { send, recorder: r } = recorder()
    r.record({
      plugin_id: 'acme.demo', plugin_version: '1.0.0', workspace: '/w', source: 'host' as PluginActivityRow['source'],
      address: 'developerMode.on', outcome: 'allowed', at: 1_000, count: 1,
    })
    expect(r.pending).toBe(0)
    await r.flush()
    expect(send).not.toHaveBeenCalled()
  })
})
