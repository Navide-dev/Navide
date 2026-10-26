// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { channelsKey, useChannels } from '../../composables/useChannels'
import PaneChannelIcon from '../PaneChannelIcon.vue'

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

function seed(status: Record<string, unknown>): void {
  mock.setResponse('channels.list', {
    ok: true,
    enabled: true,
    platforms: [{
      platform: 'telegram', configured: true, enabled: true,
      status: { lifecycle: 'ready', connected: true, ...status }, config: {}, capabilities: null,
    }],
  })
  mock.setResponse('channels.bindings', {
    ok: true,
    bindings: [{ pane_id: 'p1', platform: 'telegram', account: 'default', chat_id: '-100', thread_id: '', title: 'api-refactor' }],
  })
  mock.setResponse('channels.pairing.list', { ok: true, requests: [] })
  mock.setResponse('channels.allow.list', { ok: true, entries: [] })
}

async function render() {
  const store = useChannels(mock.backend)
  await store.refresh()
  wrapper = mount(PaneChannelIcon, {
    props: { paneId: 'p1' },
    global: { plugins: [i18n], provide: { [channelsKey as symbol]: store } },
  })
  await flushPromises()
  return wrapper.get('[data-testid="channel-sidebar-icon"]').attributes('title')
}

describe('PaneChannelIcon', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    mock = createMockBackend('connected')
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('names the platform and the bot, as the pane chip does', async () => {
    seed({ identity: '@neil_m4_bot', display_name: 'Neil M4' })
    expect(await render()).toBe('Telegram · Neil M4')
  })

  it('falls back to the platform alone while the bot has no name', async () => {
    seed({ identity: '' })
    expect(await render()).toBe('Telegram')
  })
})
