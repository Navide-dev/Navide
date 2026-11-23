// @vitest-environment happy-dom
// The pairing card in the account window, and the prompt over it, saying the
// same thing about the same exchange.
//
// They are two surfaces on purpose — the prompt is the notification, the card
// is the record and the way back in after dismissing it — and until the prompt
// was fixed to sit above this window, nobody ever saw both at once. Once they
// are both on screen, a disagreement between them is a person deciding which
// one to believe about a security question.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import AccountModal from '../AccountModal.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { _resetForTest } from '../../composables/usePairingState'

let wrapper: VueWrapper | undefined
const original = i18n.global.locale.value

afterEach(() => {
  _resetForTest()
  wrapper?.unmount()
  wrapper = undefined
  i18n.global.locale.value = original
  delete (window as unknown as Record<string, unknown>).agentTeam
})

const t = (key: string, args?: Record<string, unknown>) => i18n.global.t(key, args ?? {})

const EXCHANGE = {
  deviceId: 'dev-far',
  deviceName: 'M4',
  role: 'initiator',
  state: 'awaiting-local',
  code: '482 913',
  fingerprint: '8fe2 1661 6449 c594',
  startedAt: 1_000,
}

async function mountWith(pairing: Record<string, unknown>) {
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    trustConfirm: vi.fn().mockResolvedValue({ token: 't' }),
  }
  const mock = createMockBackend('connected')
  mock.setResponse('p2p.link.status', {
    status: { state: 'connected', accountEmail: 'a@b.c', serverUrl: 'wss://x', emailVerified: true },
  })
  mock.setResponse('p2p.network.snapshot', {
    state: 'connected',
    deviceId: 'me',
    devices: [
      { deviceId: 'me', deviceName: 'This one', isLocal: true, online: true, paneCount: 1, panes: [] },
    ],
    pairings: [pairing],
  })
  wrapper = mount(AccountModal, {
    props: { open: true, backend: mock.backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return mock
}

const card = () => wrapper!.find('.pair-card')

describe('the pairing card', () => {
  it('stops saying they have not answered once they have', async () => {
    // Reported from a screenshot: "Waiting for M4 to answer", directly above
    // six digits that exist only because M4 answered — and beside a prompt
    // asking this person to compare them.
    await mountWith(EXCHANGE)

    expect(card().find('.dev-name').text()).toBe(t('settings.p2p.pair.with-device', { device: 'M4' }))
    expect(wrapper!.text()).not.toContain(t('settings.p2p.pair.asking', { device: 'M4' }))
    // And it still says whose turn it is, which is the part that tells somebody
    // what to do next.
    expect(card().text()).toContain(t('settings.p2p.pair.step-your-turn'))
  })

  it('still says it while they really have not', async () => {
    // Before the far machine answers there are no digits, nothing to compare
    // and nothing being asked of this person — which is exactly what that
    // sentence is for.
    await mountWith({ ...EXCHANGE, code: '', fingerprint: '' })

    expect(card().find('.dev-name').text()).toBe(t('settings.p2p.pair.asking', { device: 'M4' }))
    expect(card().text()).toContain(t('settings.p2p.pair.step-waiting-them'))
  })

  it('is worded from the other end when the request came in', async () => {
    await mountWith({ ...EXCHANGE, role: 'responder' })

    expect(card().find('.dev-name').text()).toBe(t('settings.p2p.pair.asked-by', { device: 'M4' }))
  })

  it('shows the digits the prompt shows, so there is one thing to compare', async () => {
    // Two surfaces, one exchange: different digits between them would make the
    // comparison meaningless, and they come from the same snapshot for that
    // reason.
    await mountWith(EXCHANGE)

    expect(card().find('.pair-code').text()).toBe('482 913')
  })
})

describe('the pairing card for another organization', () => {
  const ORG = { grantId: 'g_1', orgName: 'North Design', ownerName: 'Chen' }

  it('names the organization, owner and machine; the rest is unchanged', async () => {
    await mountWith({ ...EXCHANGE, org: ORG })
    expect(card().find('[data-org-tag]').text()).toBe(t('settings.cloud.org.from-org', { org: 'North Design' }))
    const facts = card().find('[data-org-facts]').text()
    expect(facts).toContain('North Design')
    expect(facts).toContain('Chen')
    expect(facts).toContain('M4')
    expect(card().find('.pair-code').text()).toBe('482 913')
  })

  it('adds nothing for one of your own machines', async () => {
    await mountWith(EXCHANGE)
    expect(card().find('[data-org-tag]').exists()).toBe(false)
    expect(card().find('[data-org-facts]').exists()).toBe(false)
  })
})

describe('a knock from another organization', () => {
  async function mountKnock(org?: Record<string, string>) {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      trustConfirm: vi.fn().mockResolvedValue({ token: 't' }),
    }
    const mock = createMockBackend('connected')
    mock.setResponse('p2p.link.status', {
      status: { state: 'connected', accountEmail: 'a@b.c', serverUrl: 'wss://x', emailVerified: true },
    })
    mock.setResponse('p2p.network.snapshot', {
      state: 'connected',
      deviceId: 'me',
      devices: [{ deviceId: 'me', deviceName: 'This one', isLocal: true, online: true, paneCount: 1, panes: [] }],
      pairings: [],
      accessRequests: [
        { key: 'k1', memberId: 'm-org', deviceId: 'dev-org', deviceName: 'iMac', workspace: 'Agent-Team', paneName: 'lead', attempts: 3, ...(org ? { org } : {}) },
      ],
    })
    wrapper = mount(AccountModal, { props: { open: true, backend: mock.backend as never }, global: { plugins: [i18n] } })
    await flushPromises()
    return mock
  }

  it('explains a refusal while the trust record cannot be read', async () => {
    const mock = await mountKnock({ grantId: 'g_1', orgName: 'North Design', ownerName: 'Chen' })
    mock.setResponse('p2p.access_requests.approve', null, {
      ok: false,
      error: { code: 'TRUST_UNAVAILABLE', message: 'the device trust store could not be opened' },
    })
    const allow = wrapper!.findAll('button').find((b) => b.text() === t('settings.cloud.org.allow-one'))!
    await allow.trigger('click')
    await flushPromises()
    expect(wrapper!.text()).toContain(t('settings.p2p.trust.approve-trust-unavailable'))
  })

  it('says which organization and offers to allow just that pane', async () => {
    await mountKnock({ grantId: 'g_1', orgName: 'North Design', ownerName: 'Chen' })
    expect(wrapper!.find('[data-org-tag]').text()).toBe(t('settings.cloud.org.from-org', { org: 'North Design' }))
    expect(wrapper!.find('[data-org-facts]').text()).toContain(t('settings.cloud.org.owner', { name: 'Chen' }))
    expect(wrapper!.text()).toContain(t('settings.cloud.org.allow-one'))
    expect(wrapper!.find('[data-org-hint]').exists()).toBe(true)
  })

  it('looks exactly as before for a knock with no organization', async () => {
    await mountKnock()
    expect(wrapper!.find('[data-org-tag]').exists()).toBe(false)
    expect(wrapper!.find('[data-org-hint]').exists()).toBe(false)
    expect(wrapper!.text()).toContain(t('settings.p2p.trust.approve'))
  })
})
