import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import enUS from '../../../../../packages/plugin-ui/src/foundation/i18n/locales/en-US.json'

// channels.agent_action: the backend's channels_* tools announce every change
// they made (mcp_server/channel_tools.py _act). App.vue cannot be mounted by
// the suite, so the handler is asserted against the source like the other
// App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const toolsSource = readFileSync(
  resolve(process.cwd(), 'backend/agent_team_backend/mcp_server/channel_tools.py'), 'utf8',
)

describe('channels.agent_action toast', () => {
  it('has a toast for every channels_* tool that changes something', () => {
    const changing = [...toolsSource.matchAll(/await _act\(ctx, "(channels_[a-z_]+)"/g)].map((m) => m[1])
    expect(changing.length).toBeGreaterThan(0)
    for (const tool of changing) {
      if (tool === 'channels_bot_set_enabled') continue
      expect(appSource).toContain(`${tool}: 'msg.agent-channels-`)
    }
    expect(appSource).toContain("'msg.agent-channels-enabled' : 'msg.agent-channels-disabled'")
  })

  it('names only keys the locale has', () => {
    const msg = (enUS as { msg: Record<string, string> }).msg
    for (const m of appSource.matchAll(/'msg\.(agent-channels-[a-z]+)'/g)) expect(msg[m[1]], m[1]).toBeTruthy()
  })
})
