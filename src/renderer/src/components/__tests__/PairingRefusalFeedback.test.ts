// @vitest-environment happy-dom
// A pairing that one side refused ends at once, and both surfaces say why.
//
// Reported on 0.2.19: the far machine answered, this one refused the answer
// because its trust record could not be read — and the card kept saying
// "Waiting for TKM5 to answer" for five minutes, after which pressing Pair
// again said only that a pairing was already in progress.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import AccountModal from '../AccountModal.vue'
import PairingPrompt from '../PairingPrompt.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { _resetForTest, failureKey } from '../../composables/usePairingState'

let wrapper: VueWrapper | undefined

afterEach(() => {
  _resetForTest()
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
  delete (window as unknown as Record<string, unknown>).agentTeam
})

const t = (key: string, args?: Record<string, unknown>) => i18n.global.t(key, args ?? {})

const LOCAL_TRUST = {
  deviceId: 'dev-tkm5',
  deviceName: 'TKM5',
  reason: 'trust-unavailable',
  side: 'local',
  at: 1_700_000_000,
}

function confirmStub() {
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    trustConfirm: vi.fn().mockResolvedValue({ token: 't', issuedAt: 1 }),
  }
}

async function mountPrompt(snapshot: Record<string, unknown>) {
  confirmStub()
  const mock = createMockBackend('connected')
  mock.setResponse('p2p.network.snapshot', snapshot)
  wrapper = mount(PairingPrompt, {
    props: { backend: mock.backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return mock
}

async function mountModal(snapshot: Record<string, unknown>) {
  confirmStub()
  const mock = createMockBackend('connected')
  mock.setResponse('p2p.link.status', {
    status: { state: 'connected', accountEmail: 'a@b.c', serverUrl: 'wss://x', emailVerified: true },
  })
  mock.setResponse('p2p.network.snapshot', {
    state: 'connected',
    deviceId: 'me',
    devices: [
      { deviceId: 'me', deviceName: 'This one', isLocal: true, online: true, paneCount: 1, panes: [] },
      {
        deviceId: 'dev-tkm5', deviceName: 'TKM5', isLocal: false, online: true,
        paneCount: 0, panes: [], canTrust: true, trustState: '',
      },
    ],
    pairings: [],
    ...snapshot,
  })
  wrapper = mount(AccountModal, {
    props: { open: true, backend: mock.backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return mock
}

describe('the prompt over everything', () => {
  it('says the round ended, why, and what to do next', async () => {
    await mountPrompt({ pairings: [], pairingFailures: [LOCAL_TRUST] })

    const text = wrapper!.text()
    expect(text).toContain(t('settings.p2p.pair.failed-title', { device: 'TKM5' }))
    expect(text).toContain(
      t('settings.p2p.pair.failed-local-trust-unavailable', { device: 'TKM5' }),
    )
  })

  it('can be closed, and stays closed', async () => {
    const mock = await mountPrompt({ pairings: [], pairingFailures: [LOCAL_TRUST] })

    await wrapper!.find('.pp-close').trigger('click')
    await flushPromises()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)
    // The next poll still reports it; closing is remembered.
    expect(mock.sent.filter((s) => s.type === 'p2p.pair.confirm')).toHaveLength(0)
  })

  it('names the other side when it was the other side that refused', async () => {
    await mountPrompt({
      pairings: [],
      pairingFailures: [{ ...LOCAL_TRUST, side: 'remote', reason: 'policy-denied' }],
    })

    expect(wrapper!.text()).toContain(
      t('settings.p2p.pair.failed-remote-policy-denied', { device: 'TKM5' }),
    )
  })
})

describe('the account window', () => {
  it('shows the ended round where the waiting card was', async () => {
    await mountModal({ pairingFailures: [LOCAL_TRUST] })

    const text = wrapper!.text()
    expect(text).toContain(t('settings.p2p.pair.failed-title', { device: 'TKM5' }))
    expect(text).toContain(
      t('settings.p2p.pair.failed-local-trust-unavailable', { device: 'TKM5' }),
    )
  })

  it('offers a way out of the wait before the other side answers', async () => {
    const mock = await mountModal({
      pairings: [{
        deviceId: 'dev-tkm5', deviceName: 'TKM5', role: 'initiator',
        state: 'awaiting-response', code: '', fingerprint: '', startedAt: 1,
      }],
    })

    const cancel = wrapper!
      .findAll('.pair-card button')
      .find((b) => b.text() === t('settings.p2p.pair.cancel-request'))
    expect(cancel).toBeTruthy()
    await cancel!.trigger('click')
    await flushPromises()

    const sent = mock.sent.find((s) => s.type === 'p2p.pair.confirm')
    expect(sent?.payload).toMatchObject({ deviceId: 'dev-tkm5', accept: false })
  })

  it('says how long "already in progress" lasts, and how to end it', async () => {
    const expiresAt = Date.now() / 1000 + 4 * 60 - 5
    const mock = await mountModal({
      pairings: [{
        deviceId: 'dev-tkm5', deviceName: 'TKM5', role: 'initiator',
        state: 'awaiting-response', code: '', fingerprint: '', startedAt: 1, expiresAt,
      }],
    })
    mock.setResponse('p2p.pair.start', null, {
      ok: false,
      error: { code: 'PAIRING_BUSY', message: 'a pairing with that device is already in progress' },
    })

    const pair = wrapper!
      .findAll('button.dev-review')
      .find((b) => b.text() === t('settings.p2p.pair.start'))
    expect(pair).toBeTruthy()
    await pair!.trigger('click')
    await flushPromises()

    expect(wrapper!.text()).toContain(
      t('settings.p2p.pair.busy', { device: 'TKM5', minutes: 4 }),
    )
  })

  it('says why pairing cannot start while the trust record is unreadable', async () => {
    const mock = await mountModal({})
    mock.setResponse('p2p.pair.start', null, {
      ok: false,
      error: { code: 'TRUST_UNAVAILABLE', message: 'the device trust store could not be opened' },
    })

    const pair = wrapper!
      .findAll('button.dev-review')
      .find((b) => b.text() === t('settings.p2p.pair.start'))
    await pair!.trigger('click')
    await flushPromises()

    expect(wrapper!.text()).toContain(t('settings.p2p.pair.trust-unavailable-start'))
  })
})

describe('every reason has words in every language', () => {
  const failures = [
    { side: 'local', reason: 'trust-unavailable' },
    { side: 'local', reason: 'pairing-refused' },
    { side: 'local', reason: 'something-new' },
    { side: 'remote', reason: 'trust-unavailable' },
    { side: 'remote', reason: 'policy-denied' },
    { side: 'remote', reason: 'unauthenticated' },
    { side: 'remote', reason: 'pairing-refused' },
    { side: 'remote', reason: 'receiver-error' },
  ]
  for (const locale of ['en-US', 'zh-TW', 'ja-JP']) {
    it(locale, () => {
      const pair = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.pair
      for (const failure of failures) {
        expect(pair[failureKey(failure)], `${locale} ${failureKey(failure)}`).toBeTruthy()
      }
      for (const key of ['failed-title', 'busy', 'trust-unavailable-start', 'cancel-request']) {
        expect(pair[key], `${locale} ${key}`).toBeTruthy()
      }
    })
  }
})
