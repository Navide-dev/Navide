// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ShareLinksPane from '../cloud/ShareLinksPane.vue'

const LIVE = 'ab'.repeat(16)
const GONE = 'cd'.repeat(16)

function mockBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    'share.list': {
      ok: true,
      payload: {
        links: [
          { linkId: LIVE, kind: 'plan', title: 'Roadmap', createdBy: 'user', active: true, expiresAt: '2026-10-18T00:00:00Z' },
          { linkId: GONE, kind: 'plan', title: 'Old', createdBy: 'user', active: false, revokedAt: '2026-10-10T00:00:00Z' },
        ],
      },
    },
    'share.copy_link': { ok: true, payload: { linkId: LIVE, url: 'https://share.navide.dev/s/' + LIVE + '#k=K' } },
    'share.extend': { ok: true, payload: { linkId: LIVE, expiresAt: '2026-10-25T00:00:00Z' } },
    'share.rekey': { ok: true, payload: { linkId: 'ef'.repeat(16), url: 'https://share.navide.dev/s/new#k=N', replaces: LIVE } },
    'share.revoke': { ok: true, payload: { linkId: LIVE, revokedAt: 'now' } },
    'share.revoke_all': { ok: true, payload: { revoked: 1, linkIds: [LIVE] } },
    ...overrides,
  }
  const send = vi.fn(async (type: string, _payload?: unknown, _timeout?: number) => responses[type])
  const on = vi.fn(() => () => {})
  return { backend: { send, on } as never, send }
}

describe('ShareLinksPane actions', () => {
  let wrapper: VueWrapper | undefined
  const writeText = vi.fn(async () => {})

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    writeText.mockClear()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  async function mountPane(overrides: Record<string, unknown> = {}) {
    const mock = mockBackend(overrides)
    wrapper = mount(ShareLinksPane, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return mock
  }
  const row = (id: string) => wrapper!.find(`[data-link-id="${id}"]`)
  const action = (id: string, name: string) => row(id).find(`[data-action="${name}"]`)
  const calls = (send: ReturnType<typeof vi.fn>, type: string) => send.mock.calls.filter(([t]) => t === type)

  it('offers actions only on links that still work', async () => {
    await mountPane()
    expect(action(LIVE, 'copy').exists()).toBe(true)
    expect(row(GONE).find('[data-action]').exists()).toBe(false)
  })

  it('copies the rebuilt link to the clipboard', async () => {
    const { send } = await mountPane()
    await action(LIVE, 'copy').trigger('click')
    await flushPromises()
    expect(calls(send, 'share.copy_link')[0][1]).toEqual({ linkId: LIVE })
    expect(writeText).toHaveBeenCalledWith('https://share.navide.dev/s/' + LIVE + '#k=K')
    expect(wrapper!.find('[data-notice="done"]').exists()).toBe(true)
  })

  it('extends by seven days and reloads the list', async () => {
    const { send } = await mountPane()
    await action(LIVE, 'extend').trigger('click')
    await flushPromises()
    expect(calls(send, 'share.extend')[0][1]).toEqual({ linkId: LIVE, ttlSeconds: 7 * 86400 })
    expect(calls(send, 'share.list')).toHaveLength(2)
  })

  it('asks before re-keying, copies the new link and says the old one stopped (B5-6)', async () => {
    const { send } = await mountPane({
      'share.rekey': { ok: true, payload: { linkId: 'ef'.repeat(16), url: 'https://share.navide.dev/s/new#k=N', replaces: LIVE, oldRevoked: true } },
    })
    await action(LIVE, 'rekey').trigger('click')
    expect(calls(send, 'share.rekey')).toHaveLength(0)
    await action(LIVE, 'rekey-confirm').trigger('click')
    await flushPromises()
    expect(calls(send, 'share.rekey')[0][1]).toEqual({ linkId: LIVE })
    expect(writeText).toHaveBeenCalledWith('https://share.navide.dev/s/new#k=N')
    expect(wrapper!.find('[data-notice="done"]').text()).toBe(i18n.global.t('settings.cloud.share.rekeyed'))
  })

  it('does not claim the old link stopped unless the server said so (B5-6)', async () => {
    await mountPane({
      'share.rekey': { ok: true, payload: { linkId: 'ef'.repeat(16), url: 'https://share.navide.dev/s/new#k=N', replaces: LIVE, oldRevoked: false } },
    })
    await action(LIVE, 'rekey').trigger('click')
    await action(LIVE, 'rekey-confirm').trigger('click')
    await flushPromises()
    expect(wrapper!.find('[data-notice="done"]').text()).toBe(i18n.global.t('settings.cloud.share.rekeyed-old-alive'))
  })

  it('asks before revoking one link or all of them', async () => {
    const { send } = await mountPane()
    await action(LIVE, 'revoke').trigger('click')
    expect(calls(send, 'share.revoke')).toHaveLength(0)
    await action(LIVE, 'revoke-confirm').trigger('click')
    await flushPromises()
    expect(calls(send, 'share.revoke')[0][1]).toEqual({ linkId: LIVE })

    await wrapper!.find('[data-action="revoke-all"]').trigger('click')
    expect(calls(send, 'share.revoke_all')).toHaveLength(0)
    await wrapper!.find('[data-action="revoke-all-confirm"]').trigger('click')
    await flushPromises()
    expect(calls(send, 'share.revoke_all')).toHaveLength(1)
  })

  it('says why an action failed', async () => {
    await mountPane({ 'share.rekey': { ok: false, error: { code: 'NO_SYNC_KEY', message: 'no key' } } })
    await action(LIVE, 'rekey').trigger('click')
    await action(LIVE, 'rekey-confirm').trigger('click')
    await flushPromises()
    const notice = wrapper!.find('[data-notice="action-error"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('NO_SYNC_KEY')
  })
})
