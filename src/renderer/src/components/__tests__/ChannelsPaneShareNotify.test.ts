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

describe('ChannelsPane share-link opened notices switch', () => {
  it('is hidden when the backend does not know the setting', async () => {
    const w = await render()
    expect(mock.sent.some((s) => s.type === 'channels.get_share_open_notify')).toBe(true)
    expect(w.find('[data-testid="channels-share-open-notify-toggle"]').exists()).toBe(false)
  })

  it('shows the stored value and writes a change', async () => {
    respond('channels.get_share_open_notify', { ok: true, enabled: true })
    respond('channels.set_share_open_notify', { ok: true, enabled: false })
    const w = await render()
    const toggle = () => w.get('[data-testid="channels-share-open-notify-toggle"]')
    expect(toggle().attributes('aria-checked')).toBe('true')
    await toggle().trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'channels.set_share_open_notify')?.payload).toEqual({ enabled: false })
    expect(toggle().attributes('aria-checked')).toBe('false')
  })
})
