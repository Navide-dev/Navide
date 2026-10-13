// @vitest-environment happy-dom
// AgentMessagesPanel (the right-rail "Messages" tab) — the inter-CLI delivery
// log. The panel reads the useAgentMessaging singleton directly, so every
// assertion goes through the real composable rather than a stubbed prop.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import AgentMessagesPanel from '../AgentMessagesPanel.vue'
import {
  useAgentMessaging,
  _resetMessagingForTest,
  type MessagingDeps,
} from '../../composables/useAgentMessaging'

let clock: number
let idlePanes: Set<string>
let deliverResult: boolean
/** When set, `deliver` parks on it — used to observe the `delivering` status. */
let deliverGate: Promise<void> | null

const deps: MessagingDeps = {
  now: () => clock,
  deliver: async () => {
    if (deliverGate) await deliverGate
    return deliverResult
  },
  isPaneIdle: (paneId) => idlePanes.has(paneId),
}

let m: ReturnType<typeof useAgentMessaging>

function mountPanel(): VueWrapper {
  return mount(AgentMessagesPanel, { global: { plugins: [i18n] } })
}

function rowIds(wrapper: VueWrapper): (string | undefined)[] {
  return wrapper.findAll('[data-msg-id]').map((el) => el.attributes('data-msg-id'))
}

/** The route renders each party as vendor + workspace prefix + pane name, all
 *  separate elements; recompose just the handles for the assertions below. */
function routes(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('.msg-route')
    .map(
      (el) =>
        `${el.get('.msg-from').get('.msg-name').text()} → ${el.get('.msg-to').get('.msg-name').text()}`
    )
}

describe('AgentMessagesPanel', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    _resetMessagingForTest()
    clock = 1_000_000
    idlePanes = new Set()
    deliverResult = true
    deliverGate = null
    m = useAgentMessaging()
    m.configureMessaging(deps)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
  })

  it('shows the empty state when nothing has been sent', () => {
    wrapper = mountPanel()

    expect(wrapper.find('.msg-empty').text()).toBe(i18n.global.t('msg.empty'))
    expect(rowIds(wrapper)).toEqual([])
  })

  it('lists messages newest first', () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.registerPane('p2', 'codex', 'beta') // never idle → everything stays queued
    m.sendMessage('alpha', 'beta', 'first')
    m.sendMessage('alpha', 'beta', 'second')
    wrapper = mountPanel()

    expect(rowIds(wrapper)).toEqual(['2', '1'])
    expect(routes(wrapper)).toEqual(['alpha → beta', 'alpha → beta'])
    expect(wrapper.findAll('.msg-preview').map((el) => el.text())).toEqual(['second', 'first'])
  })

  it('expands and collapses a row', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.sendMessage('alpha', 'nobody', 'the full body')
    wrapper = mountPanel()

    expect(wrapper.find('.msg-detail').exists()).toBe(false)

    await wrapper.get('[data-msg-id="1"]').trigger('click')
    expect(wrapper.get('.msg-detail').get('pre').text()).toBe('the full body')

    await wrapper.get('[data-msg-id="1"]').trigger('click')
    expect(wrapper.find('.msg-detail').exists()).toBe(false)
  })

  it('shows a failure reason without having to expand the row', () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.sendMessage('alpha', 'nobody', 'the full body')
    wrapper = mountPanel()

    expect(wrapper.find('.msg-detail').exists()).toBe(false)
    expect(wrapper.get('.msg-reason').text()).toBe(
      i18n.global.t('msg.reason-unknown-target', { to: 'nobody' })
    )
  })

  it('renders a reason from a store that predates structured reasons verbatim', () => {
    m.hydrateLog([
      {
        uid: 'old:1',
        created_at: 1_000,
        status: 'failed',
        sender: 'alpha',
        recipient: 'beta',
        content: 'from an older build',
        reason: 'unknown target "beta"',
      },
    ])
    wrapper = mountPanel()

    expect(wrapper.get('.msg-reason').text()).toBe('unknown target "beta"')
  })

  it('names the CLI vendor on each side of the route', () => {
    m.registerPane('p1', 'claude', 'analysis')
    m.registerPane('p2', 'codex', 'reviewer')
    m.sendMessage('analysis', 'reviewer', 'take a look')
    wrapper = mountPanel()

    expect(wrapper.get('.msg-from').get('.msg-vendor').text()).toBe('Claude Code (Anthropic) ·')
    expect(wrapper.get('.msg-to').get('.msg-vendor').text()).toBe('Codex CLI (OpenAI) ·')
  })

  it('omits the vendor when the handle is still the auto-assigned one', () => {
    // `claude-1` already names the vendor; repeating it reads as noise.
    m.registerPane('p1', 'claude') // → claude-1
    m.registerPane('p2', 'codex', 'reviewer')
    m.sendMessage('claude-1', 'reviewer', 'hi')
    wrapper = mountPanel()

    expect(wrapper.get('.msg-from').find('.msg-vendor').exists()).toBe(false)
    expect(wrapper.get('.msg-to').get('.msg-vendor').text()).toBe('Codex CLI (OpenAI) ·')
  })

  it('shows no vendor for a sender that is not a pane we know', () => {
    m.registerPane('p2', 'codex', 'reviewer')
    // An external MCP client has no pane, so the event carries no agent key.
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'an external client',
      content: 'hello',
    })
    wrapper = mountPanel()

    expect(wrapper.get('.msg-from').find('.msg-vendor').exists()).toBe(false)
    expect(wrapper.get('.msg-to').get('.msg-vendor').text()).toBe('Codex CLI (OpenAI) ·')
  })

  it('dims the workspace prefix and keeps the pane name whole', () => {
    m.registerPane('p2', 'codex', 'beta')
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'other-project/analysis',
      content: 'hello',
    })
    wrapper = mountPanel()

    const from = wrapper.get('.msg-from')
    expect(from.get('.msg-ws').text()).toBe('other-project/')
    expect(from.get('.msg-name').text()).toBe('analysis')
    // An unqualified handle has no prefix to dim.
    expect(wrapper.get('.msg-to').find('.msg-ws').exists()).toBe(false)
    expect(wrapper.get('.msg-to').get('.msg-name').text()).toBe('beta')
  })

  it('explains why a queued message has not been delivered', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.registerPane('p2', 'codex', 'beta') // never idle
    m.sendMessage('alpha', 'beta', 'first')
    m.sendMessage('alpha', 'beta', 'second')
    m.pump()
    wrapper = mountPanel()
    await flushPromises()

    // Newest first: the second message is behind the first, which is waiting on
    // the target itself.
    expect(wrapper.findAll('.msg-hold').map((el) => el.text())).toEqual([
      i18n.global.t('msg.hold-behind', { n: 1 }),
      i18n.global.t('msg.hold-busy'),
    ])
  })

  it('resends a failed message from the row and leaves the original alone', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.sendMessage('alpha', 'beta', 'no such pane yet')
    wrapper = mountPanel()
    expect(wrapper.get('.msg-reason').text()).toBe(
      i18n.global.t('msg.reason-unknown-target', { to: 'beta' })
    )

    // The target shows up, then the user retries.
    m.registerPane('p2', 'codex', 'beta')
    await wrapper.get('[data-act="retry"]').trigger('click')

    // 1 failed, 2 is the failure notice sent back to alpha, 3 is the retry.
    expect(rowIds(wrapper)).toEqual(['3', '2', '1'])
    expect(m.messages.value.map((msg) => msg.status)).toEqual(['failed', 'queued', 'queued'])
    // Retrying must not also expand the row it was clicked in.
    expect(wrapper.find('.msg-detail').exists()).toBe(false)
  })

  it('withdraws a queued message from the row, then offers to resend it', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.registerPane('p2', 'codex', 'beta') // never idle → the message stays queued
    m.sendMessage('alpha', 'beta', 'never mind')
    wrapper = mountPanel()

    await wrapper.get('[data-act="cancel"]').trigger('click')

    expect(wrapper.get('[data-st]').attributes('data-st')).toBe('cancelled')
    expect(wrapper.find('[data-act="cancel"]').exists()).toBe(false)
    // Withdrawing must not also expand the row it was clicked in.
    expect(wrapper.find('.msg-detail').exists()).toBe(false)

    await wrapper.get('[data-act="retry"]').trigger('click')
    expect(m.messages.value.map((msg) => msg.status)).toEqual(['cancelled', 'queued'])
  })

  it('offers no Withdraw once a message is on its way in', async () => {
    let release = (): void => {}
    deliverGate = new Promise<void>((resolve) => {
      release = resolve
    })
    m.registerPane('p1', 'claude', 'alpha')
    m.registerPane('p2', 'codex', 'beta')
    idlePanes.add('p2')
    m.sendMessage('alpha', 'beta', 'in flight')
    m.pump()
    await flushPromises()
    wrapper = mountPanel()

    expect(wrapper.get('[data-st]').attributes('data-st')).toBe('delivering')
    expect(wrapper.find('[data-act="cancel"]').exists()).toBe(false)

    release()
    await flushPromises()
  })

  it('badges a delivery-failure notice and offers no Resend for it', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.sendMessage('alpha', 'nobody', 'this one failed')
    wrapper = mountPanel()

    // Row 2 is the notice Navide sent back to alpha; row 1 is the failed send.
    expect(rowIds(wrapper)).toEqual(['2', '1'])
    const notice = wrapper.get('[data-msg-id="2"]')
    expect(notice.get('.msg-notice').text()).toBe(i18n.global.t('msg.notice-badge'))
    expect(notice.find('[data-act="retry"]').exists()).toBe(false)
    // The row it is about keeps its own Resend.
    expect(wrapper.get('[data-msg-id="1"]').find('[data-act="retry"]').exists()).toBe(true)
  })

  it('keeps the notice badge after a reload, without reading the text', async () => {
    // `kind` is persisted, so a restored row does not have to be recognized by
    // its content prefix.
    m.hydrateLog([
      {
        uid: 'oldboot:1',
        created_at: 10,
        status: 'failed',
        sender: 'Navide',
        recipient: 'alpha',
        content: 'anything at all',
        kind: 'notice',
      },
    ])
    wrapper = mountPanel()

    expect(wrapper.get('.msg-notice').text()).toBe(i18n.global.t('msg.notice-badge'))
    expect(wrapper.find('[data-act="retry"]').exists()).toBe(false)
  })

  it('shows only one expanded row at a time', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.sendMessage('alpha', 'nobody', 'one')
    m.sendMessage('alpha', 'nobody', 'two')
    wrapper = mountPanel()

    await wrapper.get('[data-msg-id="1"]').trigger('click')
    // 2 is the failure notice for the first message; 3 is the second send.
    await wrapper.get('[data-msg-id="3"]').trigger('click')

    expect(wrapper.findAll('.msg-detail')).toHaveLength(1)
    expect(wrapper.get('.msg-detail').get('pre').text()).toBe('two')
  })

  it('pauses and resumes delivery from the header button', async () => {
    wrapper = mountPanel()
    const btn = wrapper.get('[data-act="pause"]')

    expect(btn.text()).toBe(i18n.global.t('msg.pause'))
    expect(wrapper.find('.msg-paused').exists()).toBe(false)

    await btn.trigger('click')
    expect(m.paused.value).toBe(true)
    expect(btn.text()).toBe(i18n.global.t('msg.resume'))
    expect(wrapper.get('.msg-paused').text()).toBe(i18n.global.t('msg.paused-banner'))

    await btn.trigger('click')
    expect(m.paused.value).toBe(false)
    expect(btn.text()).toBe(i18n.global.t('msg.pause'))
    expect(wrapper.find('.msg-paused').exists()).toBe(false)
  })

  it('clears finished rows but keeps the ones still in flight', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.registerPane('p2', 'codex', 'beta') // never idle → stays queued
    m.sendMessage('alpha', 'nobody', 'this one failed')
    m.sendMessage('alpha', 'beta', 'still queued')
    wrapper = mountPanel()
    // 2 is the failure notice sent back to alpha, itself queued behind the gate.
    expect(rowIds(wrapper)).toEqual(['3', '2', '1'])

    await wrapper.get('[data-act="clear"]').trigger('click')

    expect(rowIds(wrapper)).toEqual(['3', '2'])
    expect(wrapper.get('.msg-preview').text()).toBe('still queued')
  })

  it('badges a message that crossed a workspace boundary', () => {
    m.registerPane('p2', 'codex', 'beta') // never idle → stays queued
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'from another project',
      remoteWorkspace: '/ws/alpha',
    })
    wrapper = mountPanel()

    const badge = wrapper.get('.msg-xws')
    expect(badge.text()).toBe(i18n.global.t('msg.cross-workspace-badge'))
    expect(badge.attributes('title')).toBe('/ws/alpha')
  })

  it('notes a message that went in while the recipient was busy, and only that one', async () => {
    const routedKeys: string[] = []
    m.configureMessaging({
      ...deps,
      routeRemote: async (args) => {
        routedKeys.push(args.msgKey)
        return { ok: true, targetDisplay: 'beta/reviewer', targetWorkspacePath: '/ws/beta' }
      },
    })
    m.registerPane('p1', 'claude', 'alpha')
    const busy = m.sendMessage('alpha', 'beta/reviewer', 'mid-turn')
    const plain = m.sendMessage('alpha', 'beta/reviewer', 'between turns')
    await flushPromises()
    expect(routedKeys).toHaveLength(2)

    m.resolveRemoteDelivery(routedKeys[0], true, 'delivered-while-busy')
    m.resolveRemoteDelivery(routedKeys[1], true, '')
    wrapper = mountPanel()

    const note = i18n.global.t('msg.delivered-while-busy')
    expect(busy.status).toBe('delivered')
    expect(wrapper.get(`[data-msg-id="${busy.id}"]`).text()).toContain(note)
    expect(plain.status).toBe('delivered')
    expect(wrapper.get(`[data-msg-id="${plain.id}"]`).text()).not.toContain(note)
    expect(wrapper.html()).not.toContain('msg.')
  })

  it('renders no untranslated i18n keys across every row state', async () => {
    m.registerPane('p1', 'claude', 'alpha')
    m.registerPane('p2', 'codex', 'beta')
    m.registerPane('p3', 'qwen', 'gamma')
    m.registerPane('p4', 'grok', 'delta')

    // failed
    m.sendMessage('alpha', 'nobody', 'no such pane')
    // queued (target never idle)
    m.sendMessage('alpha', 'beta', 'waiting its turn')
    // delivered
    idlePanes.add('p3')
    m.sendMessage('alpha', 'gamma', 'went through')
    m.pump()
    await flushPromises()
    // delivering — parked inside deliver()
    let release = (): void => {}
    deliverGate = new Promise<void>((resolve) => {
      release = resolve
    })
    idlePanes.add('p4')
    m.sendMessage('alpha', 'delta', 'in flight')
    m.pump()
    await flushPromises()
    // inbound cross-workspace, for the badge
    m.acceptRemoteMessage({
      msgKey: 'k1',
      targetPaneId: 'p2',
      fromDisplay: 'alpha/sender',
      content: 'from another project',
      remoteWorkspace: '/ws/alpha',
    })

    wrapper = mountPanel()
    // Paused banner + an expanded detail block, so those strings render too.
    await wrapper.get('[data-act="pause"]').trigger('click')
    await wrapper.get('[data-msg-id="1"]').trigger('click')

    expect(wrapper.findAll('[data-st]').map((el) => el.attributes('data-st'))).toEqual(
      expect.arrayContaining(['queued', 'delivering', 'delivered', 'failed'])
    )
    expect(wrapper.text()).toContain(i18n.global.t('msg.panel-title'))
    // vue-i18n only warns on a missing key and renders the key itself, so a typo
    // would otherwise sail through every structural assertion above. html() also
    // covers the keys that only reach `title` attributes.
    expect(wrapper.text()).not.toContain('msg.')
    expect(wrapper.html()).not.toContain('msg.')

    release()
    await flushPromises()
  })
})
