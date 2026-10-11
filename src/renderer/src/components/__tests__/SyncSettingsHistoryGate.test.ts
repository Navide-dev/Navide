// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import SyncSettings from '../SyncSettings.vue'

// Without a connected Navide Cloud link the sync page must look exactly as it
// did before version history existed.
function backend(state: string) {
  const responses: Record<string, unknown> = {
    'sync.status': {
      ok: true,
      payload: {
        available: ['prompts', 'mcp', 'skills'],
        scopes: { prompts: false, mcp: false, skills: false },
        hasKey: true,
        conflicts: 0,
        link: { state },
      },
    },
    'sync.conflicts': { ok: true, payload: { conflicts: [] } },
  }
  return { send: vi.fn(async (type: string) => responses[type]), on: vi.fn(() => () => {}) } as never
}

describe('SyncSettings version history', () => {
  it.each(['', 'connecting', 'unreachable', 'unauthorized'])('is absent when the link is %s', async (state) => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mount(SyncSettings, { props: { backend: backend(state) }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-test="history-open"]').exists()).toBe(false)
  })

  it('is offered once the link is connected', async () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mount(SyncSettings, { props: { backend: backend('connected') }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-test="history-open"]').exists()).toBe(true)
  })
})
