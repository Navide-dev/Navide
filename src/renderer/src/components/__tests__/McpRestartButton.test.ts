// @vitest-environment happy-dom
// The Backend popover's "Restart MCP" button. Windows cannot restart MCP on
// its own (backend own_loop.py), so there the button is off and a line points
// at the whole-backend restart, instead of a "failed: unsupported-platform"
// after the click.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'

import McpRestartButton from '../McpRestartButton.vue'
import { UNSUPPORTED_REASON, useMcpHealth } from '../../composables/useMcpHealth'
import { platformId, setPlatformId } from '../../../../shared/osplat'
import en from '../../i18n/locales/en-US.json'

function mcpOn(platform: 'win32' | 'darwin' | 'linux') {
  setPlatformId(platform)
  const send = vi.fn(async () => ({ id: '1', type: 'mcp.soft_restart', ok: true, payload: { ok: true }, error: null, timestamp: '' }))
  const mcp = useMcpHealth({ send: send as never, api: {}, setTimer: () => {} })
  return { mcp, send }
}

function mountButton(supported: boolean) {
  return mount(McpRestartButton, {
    props: { supported, restarting: false, busy: false, note: '' },
    global: { plugins: [i18n] },
  })
}

// Back to what this file loaded with, not the host (src/shared/platformBaseline.test.ts).
const BASELINE = platformId()
afterEach(() => setPlatformId(BASELINE))

describe('McpRestartButton', () => {
  it('on win32 is disabled and says to restart the whole backend instead', async () => {
    const { mcp, send } = mcpOn('win32')
    expect(mcp.restartSupported).toBe(false)
    const wrapper = mountButton(mcp.restartSupported)
    expect(wrapper.get('button.bp-mcp-restart').attributes('disabled')).toBeDefined()
    expect(wrapper.get('.bp-mcp-unsupported').text()).toBe(en.label['mcp-restart-unsupported'])
    // Asked anyway, the backend is not bothered and the answer is the one
    // the window turns into that same line.
    expect(await mcp.restartMcp()).toEqual({ ok: false, reason: UNSUPPORTED_REASON })
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux'] as const)('on %s is enabled, has no such line and asks for the restart', async (platform) => {
    const { mcp } = mcpOn(platform)
    expect(mcp.restartSupported).toBe(true)
    const wrapper = mountButton(mcp.restartSupported)
    const button = wrapper.get('button.bp-mcp-restart')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.bp-mcp-unsupported').exists()).toBe(false)
    await button.trigger('click')
    expect(wrapper.emitted('restart')).toHaveLength(1)
  })
})
