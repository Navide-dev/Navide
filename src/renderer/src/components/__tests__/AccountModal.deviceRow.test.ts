// @vitest-environment happy-dom
// What a device row actually says, by rendering one.
//
// The rest of this modal's coverage is source-scan, on the belief that it could
// not be mounted. It takes two props. The things reported about the offline row
// — a name clipped to "M…", a raw ISO timestamp, a status sentence that wrapped,
// and English text in a Chinese window — are facts about output, and all but
// one are checkable here. The exception is the clipping itself, which is layout:
// happy-dom does no layout and a scoped stylesheet is not applied to a mounted
// component, so what holds that is a source assertion at the bottom, labelled
// as one.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import AccountModal from '../AccountModal.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { usePairingState, _resetForTest } from '../../composables/usePairingState'

const here = dirname(fileURLToPath(import.meta.url))
const MODAL = readFileSync(resolve(here, '../AccountModal.vue'), 'utf8')

const NAME = 'MacBook Pro 16 吋'
const THIRTY_EIGHT_MINUTES = 38 * 60_000
const EIGHT_MINUTES = 8 * 60_000

let wrapper: VueWrapper | undefined
const original = i18n.global.locale.value

afterEach(() => {
  _resetForTest()
  wrapper?.unmount()
  wrapper = undefined
  i18n.global.locale.value = original
  delete (window as unknown as Record<string, unknown>).agentTeam
})

function lastSeen(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString()
}

async function mountModal(locale: 'en-US' | 'zh-TW' = 'en-US', overrides: object = {}) {
  i18n.global.locale.value = locale
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
      {
        deviceId: 'f9c30189',
        deviceName: NAME,
        isLocal: false,
        online: false,
        paneCount: 1,
        panes: [],
        trustState: 'trusted',
        lastSeenAt: lastSeen(EIGHT_MINUTES),
        ...overrides,
      },
    ],
  })
  wrapper = mount(AccountModal, {
    props: { open: true, backend: mock.backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return mock
}

const rows = () => wrapper!.findAll('.dev')
const offline = () => rows()[1]
const t = (key: string, args?: Record<string, unknown>) => i18n.global.t(key, args ?? {})

describe('the offline device row', () => {
  it('gives the name the whole line, with nothing else competing for it', async () => {
    // Reported as "M…": the name shared a row with presence, a trust pill, a
    // pane count and a button, and it was the one that gave way. The two facts
    // that used to sit beside it are now on the line below.
    await mountModal()
    const head = offline().find('.dev-head')

    expect(head.find('.dev-name').text()).toBe(NAME)
    expect(head.find('.dev-presence').exists()).toBe(false)
    expect(head.find('.dev-count').exists()).toBe(false)
    // Left in the head: the lamp, the trust pill, the one action.
    expect(head.find('.dev-tag').text()).toBe(t('settings.p2p.trust.state-trusted'))
  })

  it('keeps everything on one line', async () => {
    // It was split into two, and a row per machine became two rows per machine.
    // What makes it one line is that the secondary text is a span inside the
    // head, not a paragraph after it.
    await mountModal()
    const meta = offline().find('.dev-meta')

    expect(meta.exists()).toBe(true)
    expect(meta.element.tagName).toBe('SPAN')
    expect(offline().find('.dev-head').find('.dev-meta').exists()).toBe(true)
    // Nothing block-level between the name and the end of the row.
    expect(offline().findAll('.dev-head p')).toHaveLength(0)
  })

  it('says when it was last here in words, not as an ISO timestamp', async () => {
    // It printed `Last seen 2026-09-05T02:39:47.539Z`.
    await mountModal()
    const meta = offline().find('.dev-meta')

    expect(meta.text()).toBe(`${t('settings.p2p.network.device-offline')} · ${t('time.ago-minutes', { count: 8 })}`)
    expect(meta.text()).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(wrapper!.text()).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
  })

  it('keeps the exact moment on hover, where comparing against a log needs it', async () => {
    await mountModal()
    const title = offline().find('.dev-meta').attributes('title') ?? ''

    expect(title).toBeTruthy()
    expect(title).not.toMatch(/T\d{2}:\d{2}.*Z/)
    expect(Number.isNaN(Date.parse(title))).toBe(false)
  })

  it('says only that it is offline, not a sentence that wraps', async () => {
    // "Offline — cannot be reached" took two lines in this column. The greyed
    // text and the disabled buttons carry the rest of that meaning.
    await mountModal()
    expect(offline().text()).toContain(t('settings.p2p.network.device-offline'))
    expect(offline().text()).not.toContain('cannot be reached')
  })

  it('says nothing false when the device has never been seen', async () => {
    await mountModal('en-US', { lastSeenAt: undefined })
    expect(offline().find('.dev-meta').text()).toContain(
      t('settings.p2p.network.last-seen-unknown'),
    )
    expect(offline().find('.dev-meta').attributes('title')).toBe('')
  })

  it('reports an online device by what it is running instead', async () => {
    // A machine that is not there has no current panes to report; one that is
    // has nothing to say about when it was last seen.
    await mountModal('en-US', { online: true })
    expect(offline().find('.dev-meta').text()).toBe(t('settings.p2p.network.panes-one'))
    expect(offline().find('.dev-meta').attributes('title')).toBe('')
  })
})

describe('the device row in Chinese', () => {
  it('translates the pairing state and the time, both of which were reported as English', async () => {
    // Reported twice: the pill reading "Paired", and the time reading
    // "38 minute(s) ago". Both keys exist in both locales and the row composes
    // them dynamically; this is what proves the composition resolves. Note what
    // it therefore means when a window shows English: that window's locale is
    // en-US. `fallbackLocale` is zh-TW, so a missing key falls back to Chinese
    // — English is never what a lookup failure produces here.
    await mountModal('zh-TW')

    expect(offline().find('.dev-tag').text()).toBe('已配對')
    expect(offline().find('.dev-meta').text()).toBe('離線 · 8 分鐘前')
    expect(wrapper!.text()).not.toContain('Paired')
    expect(wrapper!.text()).not.toContain('minute')
  })

  it('needs no plural form, and gets the one form it has', async () => {
    await mountModal('zh-TW', { lastSeenAt: lastSeen(THIRTY_EIGHT_MINUTES) })
    expect(offline().find('.dev-meta').text()).toBe('離線 · 38 分鐘前')

    wrapper!.unmount()
    await mountModal('zh-TW', { lastSeenAt: lastSeen(60_000) })
    expect(offline().find('.dev-meta').text()).toBe('離線 · 1 分鐘前')
  })
})

describe('English says minute and minutes, not minute(s)', () => {
  it('picks the singular for one', async () => {
    await mountModal('en-US', { lastSeenAt: lastSeen(60_000) })
    expect(offline().find('.dev-meta').text()).toBe('Offline · 1 minute ago')
  })

  it('picks the plural for thirty-eight', async () => {
    // The reported string was "38 minute(s) ago" — a form written to avoid
    // choosing, which no one says out loud.
    await mountModal('en-US', { lastSeenAt: lastSeen(THIRTY_EIGHT_MINUTES) })
    const text = offline().find('.dev-meta').text()
    expect(text).toBe('Offline · 38 minutes ago')
    expect(text).not.toContain('(s)')
  })
})

describe('the rule that actually stops the clipping', () => {
  it('makes the name the one item that gives up space, and lets it', () => {
    // The only part of this that no renderer here can answer: happy-dom does no
    // layout, and a scoped stylesheet is not applied to a mounted component
    // either, so "was it clipped to M…" is not a question a test can ask. This
    // is a source assertion and is worth exactly what a source assertion is
    // worth — it holds the two declarations that make the difference, and
    // whether they produce the intended line is a thing to look at.
    const rule = MODAL.slice(MODAL.indexOf('.dev-name {'), MODAL.indexOf('}', MODAL.indexOf('.dev-name {')))
    // `min-width: 0` is the one that matters: a flex item's floor is its own
    // content, so without it the name pushes the row wider instead of
    // shortening, and whatever follows wraps.
    expect(rule).toMatch(/flex:\s*1 1 auto/)
    expect(rule).toMatch(/min-width:\s*0/)
    expect(rule).toMatch(/text-overflow:\s*ellipsis/)
    // And nothing else on the row may take the free space, or the name is back
    // to fighting for it.
    expect(MODAL).not.toMatch(/\.dev-review \{[^}]*margin-left: auto/)
    expect(MODAL).toMatch(/\.dev-head \.dot \{[^}]*flex: none/)
    // The row must not wrap, and the secondary text must give way before the
    // name does — a shrink factor above the name's 1.
    const head = MODAL.slice(MODAL.indexOf('.dev-head {'), MODAL.indexOf('}', MODAL.indexOf('.dev-head {')))
    expect(head).toMatch(/flex-wrap:\s*nowrap/)
    expect(head).toMatch(/white-space:\s*nowrap/)
    const meta = MODAL.slice(MODAL.indexOf('.dev-meta {'), MODAL.indexOf('}', MODAL.indexOf('.dev-meta {')))
    const shrink = Number(meta.match(/flex:\s*0 (\d+) auto/)![1])
    expect(shrink).toBeGreaterThan(1)
    expect(meta).toMatch(/min-width:\s*0/)
  })
})

describe('the three actions on a row are one size', () => {
  // "Pair with this device…" in a `btn ghost small` was the widest thing on
  // every unpaired row, and read as the row's primary action. The other two are
  // `dev-review`; sharing the class is what makes "same size" a fact rather
  // than two rules that happen to look alike today.
  async function mountWith(device: object) {
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
        { deviceId: 'me', deviceName: 'This one', isLocal: true, online: true, paneCount: 0, panes: [] },
        { deviceId: 'd2', deviceName: NAME, isLocal: false, online: true, paneCount: 0, panes: [], ...device },
      ],
    })
    wrapper = mount(AccountModal, {
      props: { open: true, backend: mock.backend as never },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return wrapper.findAll('.dev')[1]
  }

  it('gives the pairing button the same class as unpair', async () => {
    i18n.global.locale.value = 'en-US'
    const pairRow = await mountWith({ canTrust: true, trustState: 'pending' })
    const pair = pairRow.findAll('button').find((b) => b.text() === t('settings.p2p.pair.start'))!
    expect([...pair.classes()].sort()).toEqual(['dev-review'])
    wrapper!.unmount()

    const pairedRow = await mountWith({ trustState: 'trusted' })
    const unpair = pairedRow.findAll('button').find((b) => b.text() === t('settings.p2p.trust.unpair'))!
    // Same base class, plus the one modifier that says it is destructive.
    expect(unpair.classes()).toContain('dev-review')
    expect([...unpair.classes()].sort()).toEqual(['dev-review', 'dev-undo'])
  })

  it('labels it with one word, and keeps the explanation in the tooltip', async () => {
    i18n.global.locale.value = 'en-US'
    const row = await mountWith({ canTrust: true, trustState: 'pending' })
    const pair = row.findAll('button').find((b) => b.classes('dev-review'))!

    expect(pair.text()).toBe('Pair')
    expect(pair.text().split(/\s+/)).toHaveLength(1)
    // Nothing is lost: the sentence it used to be is still one hover away.
    expect(pair.attributes('title')).toBe(t('settings.p2p.pair.start-title'))
    expect((pair.attributes('title') ?? '').length).toBeGreaterThan(40)
  })

  it('says 配對 in a Chinese window', async () => {
    i18n.global.locale.value = 'zh-TW'
    const row = await mountWith({ canTrust: true, trustState: 'pending' })
    const pair = row.findAll('button').find((b) => b.classes('dev-review'))!

    expect(pair.text()).toBe('配對')
    expect(row.text()).not.toContain('Pair')
  })
})

// ── The way out of a fail-closed trust lock ─────────────────────────────────
//
// The lock exists so a silent reset cannot happen, and it had no recovery at
// all — on a machine that hit it the only exit was Keychain Access, which is
// the same reset performed with less information. These pin the shape that
// makes a deliberate one safe: two clicks, the cost stated before the control,
// and a confirmation token so nothing but a window can ask for it.

async function mountLocked(reason = 'the record was created by __main__.py', extra: object = {}) {
  ;(window as unknown as Record<string, unknown>).agentTeam = {
    trustConfirm: vi.fn().mockResolvedValue({ token: 't', issuedAt: 1 }),
  }
  const mock = createMockBackend('connected')
  mock.setResponse('p2p.link.status', {
    status: { state: 'connected', accountEmail: 'a@b.c', serverUrl: 'wss://x', emailVerified: true },
  })
  mock.setResponse('p2p.network.snapshot', {
    state: 'connected', deviceId: 'me', devices: [], trustLocked: reason, ...extra,
  })
  wrapper = mount(AccountModal, {
    props: { open: true, backend: mock.backend as never },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return mock
}

const lockedCard = () => wrapper!.find('.locked-card')

describe('recovering from a locked trust store', () => {
  it('shows the lock and offers a way out, without offering it as one click', async () => {
    i18n.global.locale.value = 'en-US'
    await mountLocked()

    expect(lockedCard().exists()).toBe(true)
    expect(lockedCard().text()).toContain('__main__.py')
    const start = lockedCard().findAll('button')
    expect(start).toHaveLength(1)
    expect(start[0].text()).toBe(t('settings.p2p.trust.rebuild'))
    // Pressing it decides nothing: it reveals what the decision costs.
    expect(lockedCard().text()).not.toContain(t('settings.p2p.trust.rebuild-warn'))
  })

  it('states the cost before the button that pays it', async () => {
    i18n.global.locale.value = 'en-US'
    await mountLocked()
    const mock = createMockBackend('connected')
    void mock

    await lockedCard().find('button').trigger('click')

    const warn = lockedCard().find('.locked-warn')
    expect(warn.exists()).toBe(true)
    expect(warn.text()).toBe(t('settings.p2p.trust.rebuild-warn'))
    // Both halves of the cost are named: everything is lost, and the other
    // machine has work to do too.
    expect(warn.text()).toContain('every pairing')
    expect(warn.text()).toContain('both ends')
    // And backing out is offered beside going ahead.
    const labels = lockedCard().findAll('button').map((b) => b.text())
    expect(labels).toContain(t('settings.p2p.trust.rebuild-confirm'))
    expect(labels).toContain(t('settings.p2p.trust.rebuild-cancel'))
  })

  it('sends nothing until the second press, and sends a confirmation with it', async () => {
    i18n.global.locale.value = 'en-US'
    const mock = await mountLocked()

    await lockedCard().find('button').trigger('click')
    expect(mock.sent.some((s) => s.type === 'p2p.trust.rebuild')).toBe(false)

    const go = lockedCard().findAll('button')
      .find((b) => b.text() === t('settings.p2p.trust.rebuild-confirm'))!
    await go.trigger('click')
    await flushPromises()

    const sent = mock.sent.find((s) => s.type === 'p2p.trust.rebuild')!
    expect(sent).toBeTruthy()
    // The token is minted in the main process and nowhere else, which is what
    // keeps MCP and the plugin broker out of this.
    expect(sent.payload.confirm).toEqual({ token: 't', issuedAt: 1 })
    expect(
      (window as unknown as { agentTeam: { trustConfirm: ReturnType<typeof vi.fn> } })
        .agentTeam.trustConfirm,
    ).toHaveBeenCalledWith('p2p.trust.rebuild', '', '')
  })

  it('backing out leaves the lock in place', async () => {
    i18n.global.locale.value = 'en-US'
    const mock = await mountLocked()

    await lockedCard().find('button').trigger('click')
    const cancel = lockedCard().findAll('button')
      .find((b) => b.text() === t('settings.p2p.trust.rebuild-cancel'))!
    await cancel.trigger('click')

    expect(lockedCard().find('.locked-warn').exists()).toBe(false)
    expect(mock.sent.some((s) => s.type === 'p2p.trust.rebuild')).toBe(false)
  })

  it('says what happens next when it worked', async () => {
    // "It is gone" is not the useful half; "pair them again" is.
    i18n.global.locale.value = 'en-US'
    const mock = await mountLocked()
    mock.setResponse('p2p.trust.rebuild', { rebuilt: true, was: 'unreadable' })

    await lockedCard().find('button').trigger('click')
    await lockedCard().findAll('button')
      .find((b) => b.text() === t('settings.p2p.trust.rebuild-confirm'))!
      .trigger('click')
    await flushPromises()

    expect(lockedCard().text()).toContain(t('settings.p2p.trust.rebuild-done'))
  })
})

// R4-3: a record with no room left is not a lost one. It is intact, and
// unpairing a device is the way back; starting over would cost every pairing
// to fix something a single unpair fixes.
describe('a trust record with no room left', () => {
  const FULL_REASON = 'the pairing record is full: Update Navide to pair more devices'

  for (const locale of ['en-US', 'zh-TW', 'ja-JP'] as const) {
    it(`says it is full and to unpair a device, with no start over (${locale})`, async () => {
      i18n.global.locale.value = locale
      await mountLocked(FULL_REASON, { trustLockedCode: 'full' })

      expect(lockedCard().exists()).toBe(true)
      expect(lockedCard().text()).toContain(t('settings.p2p.trust.full-body'))
      expect(lockedCard().text()).not.toContain(t('settings.p2p.trust.locked-body'))
      expect(lockedCard().text()).not.toContain('Update Navide')
      expect(lockedCard().findAll('button')).toHaveLength(0)
    })
  }

  it('keeps the start over offer for every other lock', async () => {
    i18n.global.locale.value = 'en-US'
    await mountLocked('unreadable', { trustLockedCode: '' })
    expect(lockedCard().text()).not.toContain(t('settings.p2p.trust.full-body'))
    expect(lockedCard().findAll('button').map((b) => b.text())).toEqual([t('settings.p2p.trust.rebuild')])
  })

  it('has the full-record wording in all three languages', () => {
    for (const locale of ['zh-TW', 'en-US', 'ja-JP']) {
      const strings = JSON.parse(
        readFileSync(
          resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${locale}.json`),
          'utf8',
        ),
      )
      expect(strings.settings.p2p.trust['full-body']).toBeTruthy()
    }
  })
})

describe('pressing Pair', () => {
  async function mountPairable() {
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      trustConfirm: vi.fn().mockResolvedValue({ token: 't', issuedAt: 1 }),
    }
    const mock = createMockBackend('connected')
    mock.setResponse('p2p.link.status', {
      status: { state: 'connected', accountEmail: 'a@b.c', serverUrl: 'wss://x', emailVerified: true },
    })
    mock.setResponse('p2p.network.snapshot', {
      state: 'connected',
      deviceId: 'me',
      devices: [
        { deviceId: 'me', deviceName: 'This one', isLocal: true, online: true, paneCount: 0, panes: [] },
        {
          deviceId: 'd2', deviceName: NAME, isLocal: false, online: true,
          paneCount: 0, panes: [], canTrust: true, trustState: 'pending',
        },
      ],
    })
    wrapper = mount(AccountModal, {
      props: { open: true, backend: mock.backend as never },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    return mock
  }

  const pairButton = () =>
    wrapper!.findAll('button').find((b) => b.text() === t('settings.p2p.pair.start'))!

  it('says a failed request failed, instead of going quiet', async () => {
    // The wiring, not the store. The composable's own test proves
    // `noteAskFailed` records an error; only this proves anything calls it —
    // and a press that fails silently is the state this whole card replaced.
    i18n.global.locale.value = 'en-US'
    const mock = await mountPairable()
    mock.setResponse('p2p.pair.start', null, {
      ok: false,
      error: { code: 'TARGET_OFFLINE', message: 'that device is offline' },
    })

    await pairButton().trigger('click')
    await flushPromises()

    const state = usePairingState(mock.backend as never)
    expect(state.asked.value).toEqual([
      { deviceId: 'd2', deviceName: NAME, error: 'that device is offline' },
    ])
  })

  it('acknowledges the press before the request is answered', async () => {
    i18n.global.locale.value = 'en-US'
    const mock = await mountPairable()
    let release!: () => void
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      trustConfirm: vi.fn(() => new Promise((r) => { release = () => r({ token: 't' }) })),
    }

    await pairButton().trigger('click')
    await flushPromises()

    // The confirmation token is an IPC round trip of its own; the press is
    // acknowledged before even that.
    const state = usePairingState(mock.backend as never)
    expect(state.asked.value.map((a) => a.deviceId)).toEqual(['d2'])
    release()
    await flushPromises()
  })
})
