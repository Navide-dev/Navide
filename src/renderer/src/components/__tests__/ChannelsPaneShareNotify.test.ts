// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import ChannelsPane from '../settings/ChannelsPane.vue'

let wrapper: VueWrapper | undefined
let mock: ReturnType<typeof createMockBackend>

function respond(type: string, payload: Record<string, unknown>): void {
  mock.setResponse(type, payload)
}

async function render(): Promise<VueWrapper> {
  wrapper = mount(ChannelsPane, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  mock = createMockBackend('connected')
  respond('channels.list', { ok: true, enabled: true, platforms: [] })
  respond('channels.bindings', { ok: true, bindings: [] })
  respond('channels.overview', { ok: true, bots: [] })
  respond('channels.pairing.list', { ok: true, requests: [] })
  respond('channels.allow.list', { ok: true, entries: [] })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

const TOGGLE = '[data-testid="channels-share-open-notify-toggle"]'

function linkState(state: string): void {
  respond('p2p.link.status', { status: { state } })
}

/** The pane as a backend without the feature renders it. */
async function baselineHtml(): Promise<string> {
  const w = await render()
  const html = w.html()
  w.unmount()
  wrapper = undefined
  return html
}

describe('ChannelsPane share-link opened notices switch', () => {
  it('is hidden on a backend that does not know the setting, even with Cloud connected', async () => {
    linkState('connected')
    const w = await render()
    expect(mock.sent.some((s) => s.type === 'channels.get_share_open_notify')).toBe(true)
    expect(w.find(TOGGLE).exists()).toBe(false)
  })

  it.each(['unconfigured', 'connecting', 'unreachable', 'unauthorized'])(
    'with Cloud %s the pane is exactly what it was without the feature', async (state) => {
      const before = await baselineHtml()
      linkState(state)
      respond('channels.get_share_open_notify', { ok: true, enabled: true })
      const w = await render()
      expect(w.find(TOGGLE).exists()).toBe(false)
      expect(w.html()).toBe(before)
      expect(mock.sent.some((s) => s.type === 'channels.get_share_open_notify')).toBe(false)
    })

  it('is hidden when the link status cannot be read', async () => {
    mock.setRejection('p2p.link.status')
    respond('channels.get_share_open_notify', { ok: true, enabled: true })
    const w = await render()
    expect(w.find(TOGGLE).exists()).toBe(false)
  })

  it('shows the stored value with Cloud connected and writes a change', async () => {
    linkState('connected')
    respond('channels.get_share_open_notify', { ok: true, enabled: true })
    respond('channels.set_share_open_notify', { ok: true, enabled: false })
    const w = await render()
    const toggle = () => w.get(TOGGLE)
    expect(toggle().attributes('aria-checked')).toBe('true')
    await toggle().trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.set_share_open_notify')?.payload).toEqual({ enabled: false })
    expect(toggle().attributes('aria-checked')).toBe('false')
  })

  it('follows the link as it connects and drops', async () => {
    linkState('connecting')
    respond('channels.get_share_open_notify', { ok: true, enabled: true })
    const w = await render()
    expect(w.find(TOGGLE).exists()).toBe(false)
    linkState('connected')
    mock.emit('p2p.link.changed', { status: { state: 'connected' } })
    await flushPromises()
    expect(w.find(TOGGLE).exists()).toBe(true)
    linkState('unreachable')
    mock.emit('p2p.link.changed', { status: { state: 'unreachable' } })
    await flushPromises()
    expect(w.find(TOGGLE).exists()).toBe(false)
  })
})
