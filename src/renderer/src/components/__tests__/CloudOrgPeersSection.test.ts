// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import CloudOrgPeersSection from '../cloud/CloudOrgPeersSection.vue'
import CloudSubtabs from '../cloud/CloudSubtabs.vue'

const peer = (deviceId: string, extra: Record<string, unknown> = {}) => ({
  deviceId,
  deviceName: `${deviceId}-name`,
  ownerName: 'Chen',
  online: true,
  listed: true,
  trustState: 'pending',
  canTrust: true,
  signFingerprint: 'abcd1234abcd1234',
  pairedAt: null,
  revoked: null,
  ...extra,
})

const grant = {
  grantId: 'g_1',
  localOrg: { orgId: 'o_a', name: 'Galaxy Studio' },
  peerOrg: { orgId: 'o_b', name: 'North Design' },
  peers: [
    peer('dev-1'),
    peer('dev-2', { trustState: 'trusted', canTrust: false }),
    peer('dev-3', { online: false, canTrust: false }),
  ],
}

function backendWith(snapshot: unknown) {
  const send = vi.fn(async (type: string) => {
    if (type === 'p2p.network.snapshot') return snapshot
    return { ok: true, payload: {} }
  })
  return { backend: { send, on: vi.fn(() => () => {}) } as never, send }
}

describe('CloudOrgPeersSection', () => {
  let wrapper: VueWrapper | undefined
  const trustConfirm = vi.fn(async () => ({ nonce: 'n', expires: 'e', mac: 'm' }))
  const openOrgSite = vi.fn(async () => ({ ok: true }))

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { trustConfirm, openOrgSite }
    trustConfirm.mockClear()
    openOrgSite.mockClear()
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  async function mountWith(snapshot: unknown) {
    const mock = backendWith(snapshot)
    wrapper = mount(CloudOrgPeersSection, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return mock
  }

  it.each([
    ['an older server', { ok: true, payload: { org: { status: 'unsupported', grants: [], revokedGrants: [] }, pairings: [] } }],
    ['a snapshot without org', { ok: true, payload: { pairings: [] } }],
    ['a failed snapshot', { ok: false, error: { code: 'P2P_NOT_CONFIGURED', message: 'x' } }],
  ])('reads as not in an organization for %s', async (_label, snapshot) => {
    await mountWith(snapshot)
    expect(wrapper!.find('[data-notice="not-joined"]').exists()).toBe(true)
    expect(wrapper!.find('[data-grant-id]').exists()).toBe(false)
  })

  it('says the machine is not shared yet when no grant lists it', async () => {
    await mountWith({ ok: true, payload: { org: { status: 'ok', grants: [], revokedGrants: [] }, pairings: [] } })
    expect(wrapper!.find('[data-notice="not-exposed"]').exists()).toBe(true)
  })

  it('lists organization → machine with pair and unpair, and pairs through the six-digit flow', async () => {
    const { send } = await mountWith({ ok: true, payload: { org: { status: 'ok', grants: [grant], revokedGrants: [] }, pairings: [] } })
    const card = wrapper!.find('[data-grant-id="g_1"]')
    expect(card.text()).toContain('North Design')
    expect(wrapper!.text()).toContain('Galaxy Studio')
    const row = (id: string) => card.find(`[data-device-id="${id}"]`)
    expect(row('dev-1').text()).toContain('Owner Chen')
    expect(row('dev-2').find('[data-action="unpair"]').exists()).toBe(true)
    expect(row('dev-3').find('[data-action="pair"]').attributes('disabled')).toBeDefined()

    await row('dev-1').find('[data-action="pair"]').trigger('click')
    await flushPromises()
    expect(trustConfirm).toHaveBeenCalledWith('p2p.pair.start', 'dev-1', '')
    expect(send).toHaveBeenCalledWith('p2p.pair.start', expect.objectContaining({ deviceId: 'dev-1', confirm: expect.anything() }))
  })

  it('shows the comparison card for an organization pairing', async () => {
    const { send } = await mountWith({
      ok: true,
      payload: {
        org: { status: 'ok', grants: [grant], revokedGrants: [] },
        pairings: [
          { deviceId: 'dev-1', deviceName: 'dev-1-name', role: 'responder', state: 'awaiting-local', code: '482 917', fingerprint: 'abcd1234', org: { grantId: 'g_1', orgName: 'North Design', ownerName: 'Chen' } },
        ],
      },
    })
    const pairing = wrapper!.find('[data-device-id="dev-1"] [data-pairing]')
    expect(pairing.text()).toContain('482 917')
    await pairing.find('[data-action="match"]').trigger('click')
    await flushPromises()
    expect(send).toHaveBeenCalledWith('p2p.pair.confirm', expect.objectContaining({ deviceId: 'dev-1', accept: true }))
  })

  it('shows a same-organization grant as your own members, first, never as a linked organization', async () => {
    const same = { ...grant, grantId: 'g_same', peerOrg: { ...grant.localOrg }, sameOrg: true, peers: [peer('dev-7')] }
    await mountWith({ ok: true, payload: { org: { status: 'ok', grants: [grant, same], revokedGrants: [] }, pairings: [] } })
    const cards = wrapper!.findAll('[data-grant-id]')
    expect(cards.map((c) => c.attributes('data-grant-id'))).toEqual(['g_same', 'g_1'])
    const own = cards[0]
    expect(own.text()).toContain(i18n.global.t('settings.cloud.org.same-org-title', { org: 'Galaxy Studio' }))
    expect(own.text()).toContain(i18n.global.t('settings.cloud.org.same-org-badge'))
    expect(own.text()).not.toContain(i18n.global.t('settings.cloud.org.linked'))
    expect(cards[1].text()).toContain(i18n.global.t('settings.cloud.org.linked'))
  })

  it('shows revoked organization links with their reason, and pairing disabled', async () => {
    await mountWith({
      ok: true,
      payload: {
        org: {
          status: 'ok',
          grants: [{ ...grant, peers: [peer('dev-9', { listed: false, canTrust: false, trustState: 'revoked', revoked: { reason: 'member-removed', at: 1763870000000 } })] }],
          revokedGrants: [{ grantId: 'g_old', peerOrg: { orgId: 'o_c', name: 'Old Partner' }, revoked: { reason: 'link-revoked', at: 1763870000000 }, peers: [peer('dev-8', { trustState: 'revoked', canTrust: false, revoked: { reason: 'link-revoked', at: 1 } })] }],
        },
        pairings: [],
      },
    })
    const removed = wrapper!.find('[data-device-id="dev-9"]')
    expect(removed.text()).toContain('Member removed from the organization')
    expect(removed.find('[data-action="pair"]').attributes('disabled')).toBeDefined()
    const gone = wrapper!.find('[data-revoked-grant-id="g_old"]')
    expect(gone.find('[data-notice="revoked"]').text()).toContain('Organization link revoked')
    expect(gone.find('[data-action="pair"]').attributes('disabled')).toBeDefined()
  })

  it('opens the organization site through main, naming nothing', async () => {
    await mountWith({ ok: true, payload: { org: { status: 'unsupported', grants: [], revokedGrants: [] } } })
    await wrapper!.find('[data-action="manage"]').trigger('click')
    expect(openOrgSite).toHaveBeenCalledWith()
  })

  it('uses only manage / view / invite / remove wording, never block-or-limit words', () => {
    for (const locale of ['zh-TW', 'zh-CN'] as const) {
      const messages = i18n.global.getLocaleMessage(locale) as unknown as { settings?: { cloud?: { org?: unknown } } }
      const org = JSON.stringify(messages.settings?.cloud?.org ?? {})
      expect(org).not.toMatch(/禁止|限制/)
    }
  })
})

describe('CloudSubtabs with the Organizations tab', () => {
  it('renders the org slot only once that tab is chosen', async () => {
    i18n.global.locale.value = 'en-US'
    const w = mount(CloudSubtabs, {
      props: { modelValue: 'sync', tabs: ['sync', 'devices', 'org'] },
      slots: { org: '<p data-org-body>org</p>' },
      global: { plugins: [i18n] },
    })
    expect(w.findAll('[role="tab"]').map((t) => t.text())).toEqual(['Sync', 'Devices', 'Organizations'])
    expect(w.find('[data-org-body]').exists()).toBe(false)
    await w.find('[data-subtab="org"]').trigger('click')
    expect(w.find('[data-org-body]').exists()).toBe(true)
    w.unmount()
  })
})
