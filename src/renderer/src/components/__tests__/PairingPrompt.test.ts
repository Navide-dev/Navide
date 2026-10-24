// @vitest-environment happy-dom
// The prompt that appears when a machine asks to pair.
//
// Two halves. The first is source-scan — where it is mounted, which state it
// reads, which stacking level it uses. The second mounts it for real, because
// what a person pressing Allow sees cannot be established by finding a string
// in a file: the failure it was reported for (button dims, nothing else ever
// happens) would have passed every scan in the first half.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import PairingPrompt from '../PairingPrompt.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { _resetForTest, POLL_MS, usePairingState } from '../../composables/usePairingState'

const here = dirname(fileURLToPath(import.meta.url))
const PROMPT = readFileSync(resolve(here, '../PairingPrompt.vue'), 'utf8')
const APP = readFileSync(resolve(here, '../../App.vue'), 'utf8')
const MODAL = readFileSync(resolve(here, '../AccountModal.vue'), 'utf8')
const LOCALES = ['en-US', 'zh-TW'] as const

describe('PairingPrompt', () => {
  it('is mounted at the app root, not inside the account window', () => {
    // A request expires in five minutes; it cannot wait for somebody to open a
    // window and scroll five sections down.
    expect(APP).toContain('<PairingPrompt :backend="backend" />')
    expect(APP).toContain("import PairingPrompt from './components/PairingPrompt.vue'")
    // Not lazy: it has to be listening before anybody asks.
    expect(APP).not.toMatch(/defineAsyncComponent\(\(\) => import\('\.\/components\/PairingPrompt/)
  })

  it('reads the same state the account window does', () => {
    // Two copies would drift by exactly one poll — long enough for the card to
    // answer a question this is still asking.
    expect(PROMPT).toContain("from '../composables/usePairingState'")
    expect(MODAL).toContain("from '../composables/usePairingState'")
    expect(PROMPT).toContain('state.prompts.value')
    expect(MODAL).toContain('pairingState.pairings.value')
  })

  it('asks both ends, and does not filter by role', () => {
    // The filter used to be `row.role === 'responder'`. Removing it is the
    // change: both ends confirm now, and the initiator's account window is as
    // likely to be closed as the responder's was.
    expect(PROMPT).toContain('state.prompts.value')
    const composable = readFileSync(
      resolve(here, '../../composables/usePairingState.ts'), 'utf8',
    )
    expect(composable).not.toContain("row.role === 'responder'")
    // What it does still filter on is whether the person has waved it away.
    expect(composable).toMatch(/prompts:[\s\S]{0,400}dismissed\.value\.has\(requestKey\(row\)\)/)
  })

  it('shows nothing until there are digits to compare', () => {
    expect(PROMPT).toMatch(/filter\(\(row\) => Boolean\(row\.code\)\)/)
  })

  it('offers allow, refuse and later — and only the first two decide', () => {
    expect(PROMPT).toContain('settings.p2p.pair.allow')
    expect(PROMPT).toContain('settings.p2p.pair.mismatch')
    expect(PROMPT).toContain('settings.p2p.pair.later')
    expect(PROMPT).toContain('answer(card.row, true)')
    expect(PROMPT).toContain('answer(card.row, false)')
    // "Later" hides the prompt; the card in the account window keeps it until
    // it expires, so it decides nothing and is sent nowhere.
    expect(PROMPT).toMatch(/function later\([\s\S]{0,120}state\.dismiss\(row\)/)
    expect(PROMPT).not.toMatch(/function later\([\s\S]{0,200}backend\.send/)
  })

  it('carries a confirmation token for both answers', () => {
    expect(PROMPT).toContain("trustConfirm('p2p.pair.confirm', row.deviceId)")
  })

  it('sits at the notification level, above modals', () => {
    // Reported: the account and settings windows covered it. A question that
    // expires in five minutes and is covered has not appeared at all — and the
    // level for that already exists, so nothing new is invented.
    expect(PROMPT).toContain('z-index: var(--z-toast)')
    expect(PROMPT).not.toContain('var(--z-popover)')
    expect(PROMPT).toContain('position: fixed')
    const tokens = readFileSync(
      resolve(here, '../../../../../packages/plugin-ui/src/foundation/styles/tokens/semantic.css'),
      'utf8',
    )
    // The band this belongs to, and that it really is the top one.
    expect(tokens).toMatch(/--z-toast: (\d+)/)
    const level = (name: string) => Number(tokens.match(new RegExp(`--z-${name}: (\\d+)`))![1])
    expect(level('toast')).toBeGreaterThan(level('modal'))
    // **What this cannot see**, and it was green while the prompt was buried:
    // both things it compares are true and neither was in the fight. The
    // account window did not use `--z-modal` — it wrote 8000, which beats the
    // toast band without ever mentioning it. A window that hardcodes a number
    // is not visible to a comparison between two tokens, and that is the case
    // this misses entirely. What covers it is stackingOrder.test.ts, which
    // reads the numbers actually written in the stylesheets.
  })

  it('respects a request for less motion', () => {
    expect(PROMPT).toMatch(/prefers-reduced-motion: reduce[\s\S]{0,80}animation: none/)
  })

  it('does not steal the keyboard', () => {
    // A notification, not a modal: somebody mid-sentence keeps typing.
    expect(PROMPT).toContain('role="status"')
    expect(PROMPT).not.toContain('autofocus')
  })

  for (const locale of LOCALES) {
    it(`does not send the other end looking for a window in ${locale}`, () => {
      // It read "Open the account window on that device to answer." Both ends
      // get a prompt now — the responder's row carries the six digits the
      // instant the request lands (device_pairing.accept_request stores both
      // nonces and starts in awaiting-local), and this component is mounted at
      // the app root, so the far machine shows it over whatever is on screen.
      // The sentence was instructions for a version that no longer exists.
      const pair = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.pair
      expect(pair['waiting-response']).toBeTruthy()
      expect(pair['waiting-response']).not.toMatch(/account window|帳號視窗/)
      // And the close button says what it does and does not do, because "×" on
      // a pairing card reads as cancelling the pairing.
      expect(pair.dismiss).toBeTruthy()
      expect(pair['dismiss-title']).toBeTruthy()
    })

    it(`names its two answers in ${locale}`, () => {
      const pair = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.pair
      expect(pair.allow).toBeTruthy()
      expect(pair['cancel-request']).toBeTruthy()
    })
  }
})

describe('both ends confirm, and the card says whose turn it is', () => {
  const CARD = MODAL.slice(
    MODAL.indexOf('settings.p2p.pair.title'),
    MODAL.indexOf('settings.p2p.trust.needs-you'),
  )

  it('offers the same two answers whichever end you are', () => {
    // The initiator used to have only "Cancel Request" here, on the reasoning
    // that comparing digits is one act by one person at two screens. That holds
    // only when there is another machine and another person: a relay can answer
    // with its own key without forwarding anything, and this side would pin it
    // having compared nothing. The digits cannot be the check either — a relay
    // knows them — so the button is the only place the property lives.
    expect(CARD).not.toMatch(/v-if="row\.role === 'initiator'"/)
    expect(CARD).toContain('settings.p2p.pair.match')
    expect(CARD).toContain('settings.p2p.pair.mismatch')
    expect(CARD).toContain('answerPairing(row, true)')
    // And the branch that shows them is reached by role and state alike: the
    // only thing gating it is whether this side has already answered.
    expect(CARD).toMatch(/v-if="row\.state === 'awaiting-remote'"/)
  })

  it('says the wait is on the person, not on the other machine', () => {
    // The heading still reads "waiting for them" from before they answered.
    // Left as the only status, somebody would wait for a machine that is
    // waiting for them.
    expect(CARD).toMatch(/pair\.step-your-turn[\s\S]{0,200}pair\.your-turn/)
    expect(CARD).toMatch(/pair\.your-turn[\s\S]{0,400}answerPairing\(row, true\)/)
  })

  for (const locale of LOCALES) {
    it(`never calls an unconfirmed exchange paired in ${locale}`, () => {
      const pair = (i18n.global.getLocaleMessage(locale) as Record<string, any>).settings.p2p.pair
      for (const key of ['your-turn', 'step-your-turn', 'waiting-remote']) {
        expect(pair[key]).toBeTruthy()
        expect(pair[key]).not.toMatch(/Paired|已配對/)
      }
    })
  }
})

// ---- mounted, because pressing a button is what was broken -------------------
//
// This block was deleted by accident in 9a976ea8: a rewrite of the section
// above replaced everything to the end of the file, and seven behaviour tests
// went with it. Nothing noticed — the suite stayed green, because a deleted
// test is not a failing one. Restored here, unchanged apart from this note.
//
// The bug: `answer()` sent the confirmation and ignored the reply. A reply of
// `{ok: false}` is not an exception, so the catch never ran, the error was
// never shown, and the same unanswered question was re-rendered — indis-
// tinguishable from a button that does nothing. A successful answer was barely
// better: the card left only when a later poll happened to stop listing it.

const RESPONDER = {
  deviceId: 'dev-asking',
  deviceName: 'M4',
  role: 'responder',
  state: 'awaiting-local',
  code: '482 913',
  fingerprint: '8fe21661 6449c594',
  startedAt: 1_000,
}

/** Long enough to outlast the settled card, whatever its exact duration. */
const AFTER_SETTLED_MS = 10_000

let wrapper: VueWrapper | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  _resetForTest()
  vi.useRealTimers()
  delete (window as unknown as Record<string, unknown>).agentTeam
})

async function mountPrompt(pairings: unknown[] = [RESPONDER]) {
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    trustConfirm: vi.fn().mockResolvedValue({ token: 't', issuedAt: 1 }),
  }
  const mock = createMockBackend('connected')
  mock.setResponse('p2p.network.snapshot', { pairings })
  wrapper = mount(PairingPrompt, {
    props: { backend: mock.backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return mock
}

const t = (key: string, args?: Record<string, unknown>): string => i18n.global.t(key, args ?? {})
const buttons = () => wrapper!.findAll('.pp-btn')
const allow = () => buttons().find((b) => b.classes('pp-primary'))!

/** The "sent" notice, which reports and asks nothing — the one card here that
 *  is allowed to leave on its own. Its counterpart with the digits is not, and
 *  the difference is the subject of half these tests. */
async function mountAsked(pairings: unknown[] = []) {
  const mock = await mountPrompt(pairings)
  usePairingState(mock.backend as never).noteAsked('dev-far', 'M4')
  await flushPromises()
  return mock
}

const asked = () => wrapper!.find('.pp-close')

describe('the notice that a request went out', () => {
  it('can be closed by hand', async () => {
    // Reported: it had no close button and never left. It is a notification —
    // it reports that something was sent, and asks for nothing.
    await mountAsked()
    expect(wrapper!.text()).toContain(t('settings.p2p.pair.asking', { device: 'M4' }))

    await asked().trigger('click')
    await flushPromises()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)
  })

  it('goes by itself, having outlasted the round trip', async () => {
    vi.useFakeTimers()
    await mountAsked()

    // Still there while the answer could plausibly still be coming: three polls
    // is the worst ordinary case before anything can come back.
    vi.advanceTimersByTime(3 * POLL_MS)
    await flushPromises()
    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(1)

    vi.advanceTimersByTime(2000)
    await flushPromises()
    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)
  })

  it('closing it does not call off the pairing', async () => {
    // The one that matters. Closing a notice must not be a silent cancel: the
    // request keeps running, and when the far machine answers, the question
    // with the digits has to arrive exactly as it would have.
    const mock = await mountAsked()
    await asked().trigger('click')
    await flushPromises()
    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)

    // Nothing was sent anywhere when it was closed.
    expect(mock.sent.map((s) => s.type)).not.toContain('p2p.pair.confirm')
    expect(mock.sent.map((s) => s.type)).not.toContain('p2p.pair.cancel')

    // They answered.
    mock.setResponse('p2p.network.snapshot', {
      pairings: [{ ...RESPONDER, deviceId: 'dev-far', role: 'initiator' }],
    })
    await usePairingState(mock.backend as never).refresh()
    await flushPromises()

    expect(wrapper!.find('.pp-code').text()).toBe('482 913')
  })

  it('and neither does letting it go by itself', async () => {
    vi.useFakeTimers()
    const mock = await mountAsked()
    vi.advanceTimersByTime(3 * POLL_MS + 2000)
    await flushPromises()
    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)

    mock.setResponse('p2p.network.snapshot', {
      pairings: [{ ...RESPONDER, deviceId: 'dev-far', role: 'initiator' }],
    })
    await usePairingState(mock.backend as never).refresh()
    await flushPromises()

    expect(wrapper!.find('.pp-code').text()).toBe('482 913')
  })

  it('holds still when the request never went out', async () => {
    // An error is the only record that nothing is happening, and nothing is
    // coming to replace it. It waits to be read.
    vi.useFakeTimers()
    const mock = await mountAsked()
    usePairingState(mock.backend as never).noteAskFailed('dev-far', 'ws not open')
    await flushPromises()

    vi.advanceTimersByTime(10 * (3 * POLL_MS + 1000))
    await flushPromises()

    expect(wrapper!.find('.pp-err').text()).toBe('ws not open')
  })
})

describe('the question with the digits', () => {
  it('never takes itself away', async () => {
    // A question that removes itself has answered itself. Whoever pressed Pair
    // may be walking to the other machine; the digits have to be there when
    // they get back, and the exchange's own five-minute expiry is what ends it.
    vi.useFakeTimers()
    await mountPrompt()
    expect(wrapper!.find('.pp-code').exists()).toBe(true)

    vi.advanceTimersByTime(50 * (3 * POLL_MS + 1000))
    await flushPromises()

    expect(wrapper!.find('.pp-code').text()).toBe('482 913')
    expect(allow().exists()).toBe(true)
  })

  it('has no close button — "Later" is the way out, and it is a choice', async () => {
    // "Later" says a person decided to deal with it elsewhere; the card in the
    // account window keeps the request. A ✕ in the corner of a security
    // question is the same gesture as dismissing a banner.
    await mountPrompt()

    expect(wrapper!.find('.pp-close').exists()).toBe(false)
    expect(buttons().some((b) => b.text() === t('settings.p2p.pair.later'))).toBe(true)
  })
})

describe('PairingPrompt — answering', () => {
  it('draws the question with the digits to compare', async () => {
    await mountPrompt()
    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(1)
    expect(wrapper!.find('.pp-code').text()).toBe('482 913')
  })

  it('replaces the question with the outcome, then takes it away by itself', async () => {
    // The reported failure: pressing Allow paired the devices and left the same
    // card on screen. Nothing about the press was visible.
    vi.useFakeTimers()
    const mock = await mountPrompt()
    mock.setResponse('p2p.pair.confirm', { state: 'confirmed' })

    await allow().trigger('click')
    await flushPromises()
    // The backend has already dropped the pairing by the time it answers, so
    // the card cannot be driven by the list any more.
    mock.setResponse('p2p.network.snapshot', { pairings: [] })
    await flushPromises()

    expect(wrapper!.text()).toContain(t('settings.p2p.pair.paired', { device: 'M4' }))
    expect(buttons()).toHaveLength(0)

    vi.advanceTimersByTime(AFTER_SETTLED_MS)
    await flushPromises()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)
  })

  it('says so when the answer was refused, rather than looking the same as allowing', async () => {
    vi.useFakeTimers()
    const mock = await mountPrompt()
    mock.setResponse('p2p.pair.confirm', { state: 'rejected' })

    await buttons().find((b) => b.classes('pp-danger'))!.trigger('click')
    await flushPromises()

    expect(wrapper!.text()).toContain(t('settings.p2p.pair.done-refused'))
    expect(wrapper!.text()).not.toContain(t('settings.p2p.pair.paired', { device: 'M4' }))
  })

  it('shows the backend’s refusal verbatim and keeps the question open', async () => {
    // `{ok: false}` is a resolved promise. Nothing here used to look at it.
    const mock = await mountPrompt()
    mock.setResponse('p2p.pair.confirm', null, {
      ok: false,
      error: { code: 'CONFIRMATION_REQUIRED', message: 'this action needs a confirmation token' },
    })

    await allow().trigger('click')
    await flushPromises()

    expect(wrapper!.find('.pp-err').text()).toBe('this action needs a confirmation token')
    // Still answerable: a refusal that removed the card would lose the request.
    expect(wrapper!.find('.pp-code').exists()).toBe(true)
    expect(allow().attributes('disabled')).toBeUndefined()
  })

  it('shows a dropped connection too, not just a refusal', async () => {
    const mock = await mountPrompt()
    mock.setRejection('p2p.pair.confirm', 'ws not open')

    await allow().trigger('click')
    await flushPromises()

    expect(wrapper!.find('.pp-err').text()).toContain('ws not open')
  })

  it('says it is working while the answer is in flight, and locks the row', async () => {
    // The whole round trip is an IPC for the token plus a socket call. Without
    // this there is nothing between the press and the outcome.
    const mock = await mountPrompt()
    let release!: () => void
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      trustConfirm: vi.fn(() => new Promise((resolve) => { release = () => resolve({ token: 't' }) })),
    }
    mock.setResponse('p2p.pair.confirm', { state: 'confirmed' })

    await allow().trigger('click')
    await flushPromises()

    expect(allow().text()).toBe(t('settings.p2p.pair.sending'))
    for (const button of buttons()) expect(button.attributes('disabled')).toBeDefined()

    release()
    await flushPromises()
    expect(wrapper!.text()).toContain(t('settings.p2p.pair.paired', { device: 'M4' }))
  })

  it('does not answer for the person when they only asked for it later', async () => {
    const mock = await mountPrompt()

    await buttons().find((b) => b.classes('pp-quiet'))!.trigger('click')
    await flushPromises()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)
    expect(mock.sent.some((s) => s.type === 'p2p.pair.confirm')).toBe(false)
  })
})

describe('PairingPrompt — the end that asked', () => {
  const INITIATOR_ROW = {
    deviceId: 'dev-asked',
    deviceName: 'M5',
    role: 'initiator',
    state: 'awaiting-local',
    code: '271 604',
    fingerprint: 'aaaa bbbb cccc dddd',
    startedAt: 2_000,
  }

  it('pops up for the initiator too, once there are digits', async () => {
    // The account window may be closed or scrolled elsewhere, and that button
    // is the whole exchange — the same reason the responder got a popup.
    await mountPrompt([INITIATOR_ROW])

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(1)
    expect(wrapper!.find('.pp-code').text()).toBe('271 604')
    const labels = buttons().map((b) => b.text())
    // "Allow Pairing" belongs to the end that was asked. This end is saying the
    // digits match, which is the only claim either button ever makes.
    expect(labels).toContain(t('settings.p2p.pair.match'))
    expect(labels).not.toContain(t('settings.p2p.pair.allow'))
    expect(labels).toContain(t('settings.p2p.pair.mismatch'))
  })

  it('does not tell the asker that somebody asked them', async () => {
    // "X wants to pair with you" is true only at the end that was asked.
    await mountPrompt([INITIATOR_ROW])

    expect(wrapper!.text()).toContain(t('settings.p2p.pair.with-device', { device: 'M5' }))
    expect(wrapper!.text()).not.toContain(t('settings.p2p.pair.asked-by', { device: 'M5' }))
  })

  it('shows nothing before the far machine has answered', async () => {
    // No digits means no question to ask. What fills the gap is the "sent"
    // card, which comes from the press rather than from the snapshot.
    await mountPrompt([{ ...INITIATOR_ROW, code: '', state: 'awaiting-response' }])

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)
  })

  it('acknowledges the press without waiting for anything', async () => {
    // The complaint was "空空的等" — pressing Pair and watching nothing happen.
    // Asserted with no refresh and no resolved promise in between: if this
    // needed a round trip, the card would not be there yet.
    const mock = await mountPrompt([])
    const state = usePairingState(mock.backend as never)

    state.noteAsked('dev-new', 'M5')
    await nextTick()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(1)
    expect(wrapper!.text()).toContain(t('settings.p2p.pair.asking', { device: 'M5' }))
    expect(wrapper!.text()).toContain(t('settings.p2p.pair.waiting-response'))
    // Nothing to decide yet, so nothing to press.
    expect(buttons()).toHaveLength(0)
  })

  it('says so when the request could not be sent', async () => {
    const mock = await mountPrompt([])
    const state = usePairingState(mock.backend as never)
    state.noteAsked('dev-new', 'M5')
    await nextTick()

    state.noteAskFailed('dev-new', 'that device is offline')
    await nextTick()

    expect(wrapper!.find('.pp-err').text()).toBe('that device is offline')
    expect(wrapper!.text()).not.toContain(t('settings.p2p.pair.waiting-response'))
  })

  it('allows dismissing the sent notice early with the close button', async () => {
    const mock = await mountPrompt([])
    const state = usePairingState(mock.backend as never)
    state.noteAsked('dev-new', 'M5')
    await nextTick()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(1)
    const closeBtn = wrapper!.find('.pp-close')
    expect(closeBtn.exists()).toBe(true)
    await closeBtn.trigger('click')
    await nextTick()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)
    expect(state.asked.value).toHaveLength(0)
  })

  it('automatically dismisses the sent notice after timeout', async () => {
    vi.useFakeTimers()
    const mock = await mountPrompt([])
    const state = usePairingState(mock.backend as never)
    state.noteAsked('dev-new', 'M5')
    await nextTick()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(1)
    vi.advanceTimersByTime(10_000)
    await nextTick()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(0)
    expect(state.asked.value).toHaveLength(0)
  })

  it('does not auto-dismiss an error notice', async () => {
    vi.useFakeTimers()
    const mock = await mountPrompt([])
    const state = usePairingState(mock.backend as never)
    state.noteAsked('dev-new', 'M5')
    await nextTick()
    state.noteAskFailed('dev-new', 'that device is offline')
    await nextTick()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(1)
    vi.advanceTimersByTime(20_000)
    await nextTick()

    expect(wrapper!.findAll('.pair-prompt')).toHaveLength(1)
    expect(wrapper!.find('.pp-err').text()).toBe('that device is offline')
  })
})
