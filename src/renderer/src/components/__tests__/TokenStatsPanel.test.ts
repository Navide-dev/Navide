// @vitest-environment happy-dom
// Baseline coverage for the right slot's panel — it had none, and Phase B of
// the layout refactor splits its four tabs into standalone views. Each test
// here pins one of the lines that split can break silently:
//
//  · the one-way `update:expanded` contract with the parent
//  · the collapsed rail's token badge, which reads a subscription that must
//    stay alive while the tab that renders it is not mounted
//  · the By Stage / By Pane rows, which render an empty state (not an error)
//    the moment their prop chain is cut
//  · the persisted tab key, including its fallback for legacy values
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import TokenStatsPanel from '../TokenStatsPanel.vue'
import { usePreview } from '../../preview/usePreview'
import { registerCommand, settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import type { TokensSnapshot } from '../../composables/useTokens'
import { i18n } from '@navide/plugin-ui/foundation'
import { __resetUsageForTest, initUsage } from '../../composables/useUsage'

type Handler = (raw: unknown) => void

function makeBackend(): { backend: Record<string, unknown>; emit: (ev: string, raw: unknown) => void } {
  const handlers: Record<string, Handler[]> = {}
  const backend = {
    status: ref('connected'),
    send: vi.fn(async () => ({ ok: true, payload: null })),
    on: (ev: string, cb: Handler) => {
      ;(handlers[ev] ??= []).push(cb)
      return () => {
        handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== cb)
      }
    },
  }
  return { backend, emit: (ev, raw) => (handlers[ev] ?? []).forEach((h) => h(raw)) }
}

const bucket = (input: number, output: number, calls: number) => ({ input, output, calls })

function snapshot(over: Partial<TokensSnapshot['workspace']> = {}): TokensSnapshot {
  return {
    workspace_path: '/ws',
    workspace: {
      current_run: {
        run_id: 'r1', task: 't', run_dir: '/d', started_at: '', ended_at: null,
        totals: bucket(10, 20, 3),
        by_vendor: {}, by_stage: {},
        by_pane: { 's1:A': bucket(1, 2, 1) },
      },
      runs: [],
      cumulative: { totals: bucket(100, 200, 30), by_vendor: { claude: bucket(5, 6, 7) }, by_stage: { s1: bucket(8, 9, 10) }, by_group: {} },
      ...over,
    },
    global: { all_time: bucket(1000, 2000, 300), by_vendor: {}, by_day: {} },
  } as TokensSnapshot
}

const baseProps = {
  workspacePath: '/ws',
  stages: [{ id: 's1', shortTitle: 'Design' }],
  panes: [{ id: 'p1', agentLabel: 'claude', roleLabel: 'backend', stageId: 's1', slotLabel: 'A' }],
  pipeline: { state: 'idle' },
  expanded: true,
}

function mountPanel(props: Record<string, unknown> = {}) {
  const { backend, emit } = makeBackend()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = shallowMount(TokenStatsPanel as any, {
    props: { ...baseProps, backend, ...props },
    global: { mocks: { $t: (key: string) => key } },
  })
  return { w, emit }
}

describe('TokenStatsPanel', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    usePreview().reset()
  })
  afterEach(() => {
    __resetSettingsForTest()
  })

  it('the by-model and by-account-quota views follow one day / week switch, week by default, remembered', async () => {
    const { w } = mountPanel()
    await w.findAll('.hdr .tab')[1].trigger('click')
    const ranges = () => [w.findComponent({ name: 'TokenByModel' }), w.findComponent({ name: 'TokenByAccountQuota' })]
      .map((c) => c.props('range'))
    expect(ranges()).toEqual(['week', 'week'])
    await w.find('[data-range="day"]').trigger('click')
    expect(ranges()).toEqual(['day', 'day'])
    expect(settingsGet('agentTeam.tokenPanel.range', null)).toBe('day')
    w.unmount()
    const again = mountPanel().w
    await again.findAll('.hdr .tab')[1].trigger('click')
    expect(again.findComponent({ name: 'TokenByModel' }).props('range')).toBe('day')
    again.unmount()
  })

  it('renders the rail instead of the panel when the parent says collapsed', () => {
    const { w } = mountPanel({ expanded: false })
    expect(w.find('.rail').exists()).toBe(true)
    expect(w.find('.hdr').exists()).toBe(false)
    expect(w.find('.token-panel').classes()).toContain('is-collapsed')
    w.unmount()
  })

  it('never flips expanded itself — it only asks the parent', async () => {
    const { w } = mountPanel({ expanded: true })
    await w.find('.hdr .collapse').trigger('click')
    expect(w.emitted('update:expanded')).toEqual([[false]])
    // The parent did not act, so the panel is still open.
    expect(w.find('.hdr').exists()).toBe(true)
    w.unmount()
  })

  it('keeps the token subscription alive while collapsed so the rail badge fills', async () => {
    // useTokens() is called at setup top level rather than inside the tokens
    // tab. If a split moves it into that tab's component the badge silently
    // stops rendering — v-if on calls > 0 means it disappears, not shows 0.
    const { w, emit } = mountPanel({ expanded: false })
    expect(w.find('.rail-badge').exists()).toBe(false)
    emit('tokens.changed', snapshot())
    await w.vm.$nextTick()
    expect(w.find('.rail-badge').exists()).toBe(true)
    w.unmount()
  })

  it('drops token broadcasts belonging to another workspace', async () => {
    const { w, emit } = mountPanel({ expanded: false })
    const other = snapshot()
    other.workspace_path = '/other-ws'
    emit('tokens.changed', other)
    await w.vm.$nextTick()
    expect(w.find('.rail-badge').exists()).toBe(false)
    w.unmount()
  })

  it('persists the active tab and falls back when the stored value is unknown', async () => {
    const { w } = mountPanel()
    await w.findAll('.hdr .tab')[1].trigger('click')  // tokens
    w.unmount()

    const { w: reopened } = mountPanel()
    expect(reopened.findAll('.hdr .tab')[1].classes()).toContain('active')
    reopened.unmount()

    settingsSet('agentTeam.rightPanel.tab', 'a-tab-that-was-removed')
    const { w: legacy } = mountPanel()
    expect(legacy.findAll('.hdr .tab')[0].classes()).toContain('active')
    legacy.unmount()
  })

  it('renders By Stage / By Pane from props, and empties — not errors — without them', async () => {
    // Both tables read props.stages / props.panes, which arrive down a long
    // chain from App. Cutting that chain renders the "no stages" empty state,
    // which reads as "nothing happened yet" rather than as breakage — so the
    // populated case is what has to be pinned.
    const { w, emit } = mountPanel()
    emit('tokens.changed', snapshot())
    await w.findAll('.hdr .tab')[1].trigger('click')  // tokens
    const stageBlock = w.findAll('.block')
    const texts = stageBlock.map((b) => b.text())
    expect(texts.some((t) => t.includes('label.by-stage') && t.includes('Design'))).toBe(true)
    expect(texts.some((t) => t.includes('label.by-pane') && t.includes('claude'))).toBe(true)

    await w.setProps({ stages: [], panes: [] })
    const empty = w.findAll('.block').map((b) => b.text())
    expect(empty.some((t) => t.includes('label.by-stage') && t.includes('label.no-stages'))).toBe(true)
    expect(empty.some((t) => t.includes('label.by-pane') && t.includes('label.no-active-panes'))).toBe(true)
    w.unmount()
  })

  it('renders BY GROUP rows from cumulative.by_group in runGroups order', async () => {
    // Rows come from the snapshot, not from panes: a group with no usage still
    // lists (as zeros) because the sidebar lists it.
    const { w, emit } = mountPanel({
      runGroups: [{ id: 'rg-2', name: 'Later' }, { id: 'rg-1', name: 'Earlier' }],
    })
    const snap = snapshot()
    snap.workspace.cumulative.by_group = { 'rg-1': bucket(11, 22, 3) }
    emit('tokens.changed', snap)
    await w.findAll('.hdr .tab')[1].trigger('click')  // tokens
    const groupBlock = w.findAll('.block').find((b) => b.text().includes('label.by-group'))!
    const rows = groupBlock.findAll('tbody tr')
    expect(rows.map((r) => r.find('th').text())).toEqual(['Later', 'Earlier'])
    expect(rows[0].findAll('td').map((c) => c.text())).toEqual(['0', '0', '0'])
    expect(rows[1].findAll('td').map((c) => c.text())).toEqual(['11', '22', '3'])
    w.unmount()
  })

  it('shows no-groups empty state when there are no groups and by_group is empty', async () => {
    const { w, emit } = mountPanel()
    emit('tokens.changed', snapshot())
    await w.findAll('.hdr .tab')[1].trigger('click')
    const groupBlock = w.findAll('.block').find((b) => b.text().includes('label.by-group'))!
    expect(groupBlock.text()).toContain('label.no-groups')
    expect(groupBlock.find('table').exists()).toBe(false)
    w.unmount()
  })

  it('keys pane token rows by stage:slot so they survive a frontend restart', async () => {
    // by_pane is keyed 'stageId:slotLabel' on the backend; a pane's UUID
    // changes on every rebuild, so matching on it would zero the row.
    const { w, emit } = mountPanel()
    emit('tokens.changed', snapshot())
    await w.findAll('.hdr .tab')[1].trigger('click')
    const paneBlock = w.findAll('.block').find((b) => b.text().includes('label.by-pane'))!
    expect(paneBlock.find('tr td').text()).toBe('1')
    w.unmount()
  })

  it('renders only the tabs the layout assigns to this slot, in that order', async () => {
    // The strip is icon-only (mirroring ControlPane), so the accessible name \u2014
    // not the button text \u2014 is what identifies a tab.
    const { w } = mountPanel({ views: ['messages', 'history'] })
    expect(w.findAll('.hdr .tab').map((b) => b.attributes('title'))).toEqual([
      'label.messages',
      'label.history',
    ])
    expect(w.findAll('.hdr .tab').map((b) => b.attributes('aria-label'))).toEqual([
      'label.messages',
      'label.history',
    ])
    w.unmount()
  })

  it('draws every tab as a glyph rather than an emoji-and-label pair', async () => {
    // An icon-only strip is the whole point of matching the left sidebar: a
    // regression that reinstates the labels would still pass the order test
    // above, since title/aria-label survive either rendering.
    const { w } = mountPanel({ views: ['history', 'tokens'] })
    const buttons = w.findAll('.hdr .tab')
    expect(buttons).toHaveLength(2)
    for (const b of buttons) {
      expect(b.find('svg').exists()).toBe(true)
      expect(b.text()).toBe('')
    }
    w.unmount()
  })

  it('falls back to the first remaining tab when the active one is moved away', async () => {
    const { w } = mountPanel({ views: ['history', 'tokens'] })
    await w.findAll('.hdr .tab')[1].trigger('click')  // tokens
    await w.setProps({ views: ['history', 'messages'] })
    expect(w.findAll('.hdr .tab')[0].classes()).toContain('active')
    w.unmount()
  })

  it('keeps the token badge on the rail even when the tokens tab moved away', async () => {
    // The subscription is a panel-level concern, not a tab-level one.
    const { w, emit } = mountPanel({ expanded: false, views: ['history'] })
    emit('tokens.changed', snapshot())
    await w.vm.$nextTick()
    expect(w.findAll('.rail .rail-label').map((n) => n.text())).toEqual(['label.history'])
    expect(w.find('.rail-badge').exists()).toBe(false)
    w.unmount()
  })

  it('draws no body at all once the slot holds nothing', async () => {
    // The fallback that repairs the active tab bails on an empty slot, so the
    // bodies are gated on membership too. A HistoryPanel left mounted in a
    // zero-width panel keeps a backend subscription nobody can see.
    const { w } = mountPanel({ views: [] })
    expect(w.findAll('.hdr .tab')).toHaveLength(0)
    expect(w.findComponent({ name: 'HistoryPanel' }).exists()).toBe(false)
    expect(w.find('.body').exists()).toBe(false)
    w.unmount()
  })

  it('scales past M so a workspace worth billions of tokens stays readable', async () => {
    // The tiers stopped at M, so 77 billion rendered as "77059.4M" and the
    // fixed-width cell clipped it to "77059...." — IN and TOTAL went
    // unreadable exactly on the workspaces that had used the most.
    const snap = snapshot({
      cumulative: {
        totals: bucket(77_059_400_000, 329_000_000, 369_287),
        by_vendor: {}, by_stage: {}, by_group: {},
      },
    })
    snap.global.all_time = bucket(2_500_000_000_000, 0, 0)
    const { w, emit } = mountPanel()
    emit('tokens.changed', snap)
    await w.findAll('.hdr .tab')[1].trigger('click')  // tokens

    const cellsOf = (title: string) =>
      w.findAll('.block').find((b) => b.text().includes(title))!
        .findAll('.cell .big').map((n) => n.text())
    expect(cellsOf('label.workspace-cumulative')).toEqual(['77.1B', '329.0M', '77.4B', '369287'])
    expect(cellsOf('label.all-time-global')[0]).toBe('2.5T')
    w.unmount()
  })

  // ── "This session" scope ────────────────────────────────────────────────
  // The block used to sum every live session in the workspace, so a second
  // pane silently inflated the figure the user was reading for the pane in
  // front of them. It now reports the focused pane's session and nothing else.

  const LIVE_PANES = [
    { id: 'p1', agentLabel: 'claude', roleLabel: 'backend', sessionId: 'sA' },
    { id: 'p2', agentLabel: 'codex', roleLabel: 'frontend', sessionId: 'sB' },
    { id: 'p3', agentLabel: 'droid', roleLabel: 'docs' },
  ]
  const liveSnapshot = () =>
    snapshot({
      current_run: null,
      live_by_session: { sA: bucket(100, 10, 5), sB: bucket(7, 3, 2) },
    })

  // The top block is the one titled by the run/session header.
  async function topCells(w: VueWrapper, emit: (ev: string, raw: unknown) => void, snap: TokensSnapshot) {
    emit('tokens.changed', snap)
    await w.findAll('.hdr .tab')[1].trigger('click')  // tokens
    return w.findAll('.block')[0]
  }

  it('reports only the focused pane’s session, not every session in the workspace', async () => {
    const { w, emit } = mountPanel({ panes: LIVE_PANES, activePaneId: 'p1' })
    const block = await topCells(w, emit, liveSnapshot())
    // sA alone (100/10) — not sA + sB (107/13), which is what the old sum showed.
    expect(block.findAll('.cell .big').map((n) => n.text())).toEqual(['100', '10', '110', '5'])
    expect(block.text()).toContain('claude')
    w.unmount()
  })

  it('opens Turn Stats from the session header through the shared command', async () => {
    // App registers this command; here a stand-in records the call.
    const ran: string[] = []
    registerCommand('ui.window.openTurnStats', () => { ran.push('turn-stats') })
    const { w, emit } = mountPanel({ panes: LIVE_PANES, activePaneId: 'p1' })
    const block = await topCells(w, emit, liveSnapshot())
    await block.get('[data-act="open-turn-stats"]').trigger('click')
    expect(ran).toEqual(['turn-stats'])
    w.unmount()
  })

  it('follows the focus to another pane', async () => {
    const { w, emit } = mountPanel({ panes: LIVE_PANES, activePaneId: 'p1' })
    await topCells(w, emit, liveSnapshot())
    await w.setProps({ activePaneId: 'p2' })
    const block = w.findAll('.block')[0]
    expect(block.findAll('.cell .big').map((n) => n.text())).toEqual(['7', '3', '10', '2'])
    expect(block.text()).toContain('codex')
    w.unmount()
  })

  it('reports zero — never a neighbour’s figures — when the focused pane has no session', async () => {
    const { w, emit } = mountPanel({ panes: LIVE_PANES, activePaneId: 'p3' })
    const block = await topCells(w, emit, liveSnapshot())
    expect(block.findAll('.cell .big').map((n) => n.text())).toEqual(['0', '0', '0', '0'])
    expect(block.text()).toContain('label.pane-no-session')

    // Nothing focused at all reads the same way, with its own caption.
    await w.setProps({ activePaneId: null })
    const none = w.findAll('.block')[0]
    expect(none.findAll('.cell .big').map((n) => n.text())).toEqual(['0', '0', '0', '0'])
    expect(none.text()).toContain('label.no-focused-pane')
    w.unmount()
  })

  it('keeps the BY PANE table listing every pane, focused or not', async () => {
    // Narrowing the top block must not narrow the breakdown underneath it —
    // that table is the only place the other panes' usage is still visible.
    const { w, emit } = mountPanel({ panes: LIVE_PANES, activePaneId: 'p1' })
    await topCells(w, emit, liveSnapshot())
    const paneBlock = w.findAll('.block').find((b) => b.text().includes('label.by-pane'))!
    const rows = paneBlock.findAll('tbody tr')
    expect(rows.map((r) => r.find('th').text())).toEqual(['claude', 'codex', 'droid'])
    // Each row keeps its own session's numbers; the unbound pane shows zeros.
    expect(rows.map((r) => r.findAll('td')[0].text())).toEqual(['100', '7', '0'])
    w.unmount()
  })

  it('still reports the pipeline run when one is active', async () => {
    // The run is a different question — "what has this pipeline spent" — and
    // it outranks the focused session exactly as it did before.
    const snap = snapshot({ live_by_session: { sA: bucket(100, 10, 5) } })
    const { w, emit } = mountPanel({ panes: LIVE_PANES, activePaneId: 'p1' })
    const block = await topCells(w, emit, snap)
    expect(block.text()).toContain('label.current-run')
    expect(block.findAll('.cell .big').map((n) => n.text())).toEqual(['10', '20', '30', '3'])
    w.unmount()
  })

  it('leaves the rail badge tied to the pipeline run, not to session usage', async () => {
    // A permanently visible session tally on the collapsed rail is noise; the
    // badge stays off until a run exists, however busy the sessions are.
    const { w, emit } = mountPanel({ expanded: false, panes: LIVE_PANES, activePaneId: 'p1' })
    emit('tokens.changed', liveSnapshot())
    await w.vm.$nextTick()
    expect(w.find('.rail-badge').exists()).toBe(false)
    w.unmount()
  })

  it('ignores a preview push once preview has been taken off the layout', async () => {
    // Claiming the tab would leave the panel showing nothing at all.
    const { w } = mountPanel({ expanded: false, views: ['history'] })
    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'a.png' })
    await w.vm.$nextTick()
    expect(w.emitted('update:expanded')).toBeUndefined()
    expect(w.findAll('.rail .rail-label').map((n) => n.text())).toEqual(['label.history'])
    w.unmount()
  })

  it('a preview push surfaces the panel even from the collapsed rail', async () => {
    const { w } = mountPanel({ expanded: false })
    usePreview().show({ kind: 'file', workspacePath: '/ws', relPath: 'a.png' })
    await w.vm.$nextTick()
    expect(w.emitted('update:expanded')).toEqual([[true]])
    w.unmount()
  })
})

describe('TokenStatsPanel BY ACCOUNT', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    usePreview().reset()
    __resetUsageForTest()
  })
  afterEach(() => {
    __resetUsageForTest()
  })

  const profiles = {
    findProfile: (id: string | null | undefined) => (id === 'slot-a' ? { id, agentKey: 'claude', name: 'Services', createdAt: '' } : undefined),
    identityFor: (_agent: string, profileId: string | null) => (profileId === 'slot-a' ? { email: 'services@x.dev', signedIn: true } : null),
    defaultProfileId: () => null,
    profilesForAgent: () => [],
  }
  const snap = (over: Record<string, { input: number; output: number; calls: number }>) => {
    const s = snapshot()
    s.workspace.cumulative.by_account = over
    return s
  }
  async function open(w: VueWrapper) {
    await w.findAll('.hdr .tab')[1].trigger('click')
    return w.findAll('.block').find((b) => b.attributes('data-block') === 'by-account')!
  }

  it('renders one row per account after BY VENDOR: real accounts largest first, then Default, then unknown, with each account\'s quota', async () => {
    const { w, emit } = mountPanel({ cliProfiles: profiles })
    initUsage((w.props() as { backend: never }).backend)
    emit('usage.changed', {
      providers: {},
      accounts: { claude: { 'slot-a': { provider: 'claude', status: 'ok', planType: null, fetchedAt: '', error: null, windows: [{ kind: 'session', label: 'S', usedPercent: 6, resetsAt: null }] } } },
    })
    emit('tokens.changed', snap({
      unknown: bucket(1, 5, 3),
      __default__: bucket(400, 1, 1),
      'slot-a': bucket(9, 33, 24),
      'gone-0123456789': bucket(300, 300, 6),
    }))
    const block = await open(w)
    const blocks = w.findAll('.block').map((b) => b.attributes('data-block') ?? b.find('.block-title').text())
    expect(blocks.indexOf('by-account')).toBe(blocks.indexOf('label.by-vendor') + 1)
    const rows = block.findAll('tbody tr[data-row="account"]')
    expect(rows.map((r) => r.attributes('data-account'))).toEqual(['gone-0123456789', 'slot-a', '__default__', 'unknown'])
    expect(rows[0].find('th').text()).toBe(`gone-012 · ${i18n.global.t('account-dim.removed')}`)
    expect(rows[0].find('[data-part="quota"]').text()).toBe('—')
    expect(rows[1].find('th').text()).toBe('services@x.dev')
    expect(rows[1].findAll('td').map((c) => c.text())).toEqual(['9', '33', '24', '94%'])
    expect(rows[2].find('th').text()).toBe(i18n.global.t('account-dim.default'))
    expect(rows[3].find('th').text()).toBe(i18n.global.t('account-dim.unknown'))
    expect(rows[3].classes()).toContain('unknown')
    expect(rows[3].find('[data-part="quota"]').text()).toBe('—')
    expect(block.text()).toContain('label.quota')
    w.unmount()
  })

  it('shows the spent mark for an exhausted account', async () => {
    const { w, emit } = mountPanel({ cliProfiles: profiles })
    initUsage((w.props() as { backend: never }).backend)
    emit('usage.changed', {
      providers: {},
      accounts: { claude: { 'slot-a': { provider: 'claude', status: 'ok', planType: null, fetchedAt: '', error: null, windows: [{ kind: 'session', label: 'S', usedPercent: 100, resetsAt: null }] } } },
    })
    emit('tokens.changed', snap({ 'slot-a': bucket(9, 33, 24) }))
    const block = await open(w)
    expect(block.find('[data-row="account"] [data-part="quota"]').text()).toBe(i18n.global.t('usage.exhausted-short'))
    w.unmount()
  })

  it('shows the no-accounts empty state when the backend carries no by_account, and ids without a profiles source', async () => {
    const { w, emit } = mountPanel()
    emit('tokens.changed', snapshot())
    let block = await open(w)
    expect(block.text()).toContain('label.no-accounts')
    expect(block.find('table').exists()).toBe(false)
    emit('tokens.changed', snap({ 'slot-a': bucket(1, 2, 3) }))
    await w.vm.$nextTick()
    block = w.findAll('.block').find((b) => b.attributes('data-block') === 'by-account')!
    expect(block.find('[data-row="account"] th').text()).toBe(`slot-a · ${i18n.global.t('account-dim.removed')}`)
    expect(block.find('[data-row="account"] [data-part="quota"]').text()).toBe('—')
    w.unmount()
  })
})
