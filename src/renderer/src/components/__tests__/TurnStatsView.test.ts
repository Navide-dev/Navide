// @vitest-environment happy-dom
// TurnStatsView — it owns no pane state; every assertion is on the seams it
// has: the pane (and quota snapshot) the host passes in, the `tokens.turns`
// request it sends, and how it renders the contract's three shapes (exact
// data, unsupported, error) plus the quota block and the limit-hit mark.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import TurnStatsView, { type TurnStatsPane } from '../TurnStatsView.vue'
import type { TokenTurnsResult } from '../../composables/useTokenTurns'
import { __resetUsageForTest, initUsage, type UsageSnapshot } from '../../composables/useUsage'
import type { useCliProfiles } from '../../composables/useCliProfiles'

/** The slice of useCliProfiles the view reads, as a plain object. */
type FakeCliProfiles = {
  identityFor: (agent: string, profileId: string | null) => { email: string | null; signedIn: boolean } | null
  findProfile: (id: string | null | undefined) => { id: string; agentKey: string; name: string; createdAt: string } | undefined
  defaultProfileId: (agent: string) => string | null
}
function fakeProfiles(opts: { emails?: Record<string, string>; names?: Record<string, string>; active?: string | null } = {}): FakeCliProfiles {
  return {
    identityFor: (_agent, profileId) => {
      const slot = profileId ?? '__default__'
      return opts.emails && slot in opts.emails ? { email: opts.emails[slot], signedIn: true } : null
    },
    findProfile: (id) => (id && opts.names?.[id] ? { id, agentKey: 'claude', name: opts.names[id], createdAt: '' } : undefined),
    defaultProfileId: () => opts.active ?? null,
  }
}

const wire = vi.hoisted(() => ({
  status: 'connected' as string,
  calls: [] as Array<{ type: string; payload?: Record<string, unknown> }>,
  /** What `tokens.turns` answers with — the contract body (inside an ok envelope). */
  answer: null as unknown,
  /** When set, `tokens.turns` answers with a transport-level error envelope. */
  envelopeError: null as null | { code: string; message: string },
}))

function fakeBackend() {
  return {
    status: ref(wire.status),
    wsUrl: ref(''),
    httpUrl: ref(''),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string, sent?: Record<string, unknown>) => {
      wire.calls.push({ type, payload: sent })
      if (type === 'tokens.turns' && wire.envelopeError) {
        return { id: 'r', type, ok: false, payload: null, error: wire.envelopeError, timestamp: '' }
      }
      const payload = type === 'tokens.turns' ? wire.answer : { ok: true }
      return { id: 'r', type, ok: true, payload, error: null, timestamp: '' }
    }),
    on: vi.fn(() => () => {}),
    restart: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  } as unknown as never
}

function exactAnswer(): TokenTurnsResult {
  return {
    ok: true,
    pane_id: 'p1',
    session_id: '3e146a7d-ba35-4e81-9999-cb65cddda625',
    vendor: 'claude',
    file_path: '/Users/x/.claude/projects/a/3e146a7d.jsonl',
    method: 'exact',
    turns: [
      {
        turn_index: 1,
        started_at: '2026-09-16T00:54:02Z',
        ended_at: '2026-09-16T00:55:00Z',
        prompt_excerpt: 'Analyze the quota detection, "with quotes"',
        input: 2101,
        cache_read: 498006,
        cache_creation: 900,
        output: 3455,
        total: 504462,
        calls: 3,
        calls_detail: [
          { ts: '2026-09-16T00:54:05Z', model: 'claude-opus-5', input: 2000, cache_read: 400000, cache_creation: 900, output: 3000 },
          { ts: '2026-09-16T00:54:20Z', model: 'claude-opus-5', input: 101, cache_read: 98006, cache_creation: 0, output: 455 },
        ],
      },
      {
        turn_index: 2,
        started_at: '2026-09-16T01:01:40Z',
        ended_at: null,
        prompt_excerpt: '',
        input: 4812,
        cache_read: 612340,
        cache_creation: 0,
        output: 9120,
        total: 626272,
        calls: 11,
        calls_detail: [],
      },
    ],
    totals: { input: 6913, cache_read: 1110346, cache_creation: 900, output: 12575, total: 1130734, calls: 14 },
    scanned_at: '2026-09-16T01:02:00Z',
  }
}

const PANES: TurnStatsPane[] = [
  { id: 'p1', agentKey: 'claude', agentLabel: 'Scan the code', status: 'idle', sessionId: '3e146a7d-ba35-4e81-9999-cb65cddda625' },
  { id: 'p2', agentKey: 'codex', agentLabel: 'Deploy notes', status: 'running' },
  { id: 'p3', agentKey: 'cursor', agentLabel: 'Cursor', status: 'idle' },
  { id: 'p4', agentKey: 'claude', agentLabel: 'Old review', status: 'waiting' },
  { id: 't1', agentKey: 'terminal', agentLabel: 'Terminal', status: 'idle' },
]

beforeEach(() => {
  wire.status = 'connected'
  wire.calls = []
  wire.answer = exactAnswer()
  wire.envelopeError = null
  i18n.global.locale.value = 'en-US'
})
afterEach(() => {
  document.body.innerHTML = ''
  __resetUsageForTest()
})

async function mountView(
  opts: { pane?: TurnStatsPane | null; usage?: UsageSnapshot; cliProfiles?: FakeCliProfiles; backend?: never } = {}
): Promise<VueWrapper> {
  const w = mount(TurnStatsView, {
    props: {
      backend: opts.backend ?? fakeBackend(),
      pane: opts.pane === undefined ? PANES[0] : opts.pane,
      usage: opts.usage,
      cliProfiles: opts.cliProfiles as unknown as ReturnType<typeof useCliProfiles> | undefined,
    },
    global: { plugins: [i18n] },
  })
  await flushPromises()
  return w
}

function claudeUsage(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: 'claude',
    status: 'ok',
    planType: 'max',
    windows: [
      // Turn 1 started 00:54Z and turn 2 at 01:01Z; a session window that
      // resets at 05:30Z started at 00:30Z, so both fall inside it.
      { kind: 'session', label: 'Session', usedPercent: 42, resetsAt: '2026-09-16T05:30:00Z' },
      { kind: 'weekly', label: 'Week', usedPercent: 12, resetsAt: '2026-09-20T00:00:00Z' },
    ],
    fetchedAt: '2026-09-16T01:00:00Z',
    error: null,
    ...over,
  }
}

function turnsCalls() {
  return wire.calls.filter((c) => c.type === 'tokens.turns')
}

describe('TurnStatsView pane', () => {
  it('shows the pane name and the empty state, sending nothing, when there is no pane', async () => {
    const w = await mountView({ pane: null })
    expect(w.get('[data-state="no-panes"]').text()).toBe(i18n.global.t('turn-stats.empty-panes'))
    expect(w.find('[data-part="pane-name"]').exists()).toBe(false)
    expect(turnsCalls()).toHaveLength(0)
  })

  it('a placeholder with a saved session is scanned by session id and vendor', async () => {
    const w = await mountView({ pane: { ...PANES[3], sessionId: 'saved-session-id' } })
    expect(w.get('[data-part="pane-name"]').text()).toBe('Old review')
    expect(turnsCalls()).toHaveLength(1)
    expect(turnsCalls()[0].payload).toMatchObject({
      pane_id: 'p4',
      session_id: 'saved-session-id',
      agent_key: 'claude',
    })
  })

  it('a placeholder that was never started says so locally, without a scan', async () => {
    const w = await mountView({ pane: PANES[3] })
    expect(w.get('[data-state="never-started"]').text()).toBe(i18n.global.t('turn-stats.error-never-started'))
    expect(turnsCalls()).toHaveLength(0)
  })

  it('rescans when the pane changes, not when the same pane is handed over as a fresh object', async () => {
    const w = await mountView()
    expect(turnsCalls()).toHaveLength(1)
    await w.setProps({ pane: { ...PANES[0] } })
    await flushPromises()
    expect(turnsCalls()).toHaveLength(1)
    await w.setProps({ pane: PANES[1] })
    await flushPromises()
    expect(turnsCalls()).toHaveLength(2)
    expect(turnsCalls()[1].payload).toMatchObject({ pane_id: 'p2', agent_key: 'codex' })
  })
})

describe('TurnStatsView with exact data', () => {
  it('requests the selected pane with calls included', async () => {
    await mountView()
    expect(turnsCalls()).toHaveLength(1)
    expect(turnsCalls()[0].payload).toMatchObject({
      pane_id: 'p1',
      session_id: '3e146a7d-ba35-4e81-9999-cb65cddda625',
      agent_key: 'claude',
      include_calls: true,
    })
  })

  it('renders the summary, session, method badge, rows newest first, and the totals row', async () => {
    const w = await mountView()
    expect(w.get('[data-part="summary"]').text()).toBe(
      i18n.global.t('turn-stats.summary', { turns: 2, calls: '14', total: '1.1M' })
    )
    expect(w.get('[data-part="session"]').text()).toContain('3e146a7d…')
    expect(w.get('.ts-method').attributes('data-method')).toBe('exact')
    expect(w.find('[data-part="method-note"]').exists()).toBe(false)

    const rows = w.findAll('[data-row="turn"]')
    expect(rows.map((r) => r.attributes('data-turn'))).toEqual(['2', '1'])
    const first = rows[1]
    expect(first.get('[data-part="input"]').text()).toBe('2,101')
    expect(first.get('[data-part="cache-read"]').text()).toBe('498,006')
    expect(first.get('[data-part="cache-write"]').text()).toBe('900')
    expect(first.get('[data-part="output"]').text()).toBe('3,455')
    expect(first.get('[data-part="total"]').text()).toBe('504,462')
    expect(first.get('[data-part="calls"]').text()).toBe('3')
    expect(first.get('.c-prompt').text()).toContain('Analyze the quota detection')
    // A turn without prompt text says so instead of rendering an empty cell.
    expect(rows[0].get('.c-prompt').text()).toBe(i18n.global.t('turn-stats.no-prompt'))

    const totals = w.get('[data-row="totals"]')
    expect(totals.get('[data-part="total"]').text()).toBe('1,130,734')
    expect(totals.get('[data-part="calls"]').text()).toBe('14')
    expect(totals.text()).toContain(i18n.global.t('turn-stats.row-total'))

    expect(w.get('[data-part="note"]').text()).toBe(i18n.global.t('turn-stats.note'))
  })

  it('expands a row to its calls and collapses it again', async () => {
    const w = await mountView()
    expect(w.find('[data-row="detail"]').exists()).toBe(false)
    await w.get('[data-row="turn"][data-turn="1"]').trigger('click')
    const detail = w.get('[data-row="detail"][data-turn="1"]')
    const calls = detail.findAll('[data-row="call"]')
    expect(calls).toHaveLength(2)
    expect(calls[0].text()).toContain('claude-opus-5')
    expect(calls[0].text()).toContain('400,000')
    await w.get('[data-row="turn"][data-turn="1"]').trigger('click')
    expect(w.find('[data-row="detail"]').exists()).toBe(false)
  })

  it('an expanded turn with no calls says so', async () => {
    const w = await mountView()
    await w.get('[data-row="turn"][data-turn="2"]').trigger('click')
    expect(w.get('[data-row="detail"][data-turn="2"]').text()).toBe(i18n.global.t('turn-stats.no-calls'))
  })

  it('labels an inferred cut and shows the caveat', async () => {
    wire.answer = { ...exactAnswer(), method: 'inferred' }
    const w = await mountView()
    expect(w.get('.ts-method').attributes('data-method')).toBe('inferred')
    expect(w.get('[data-part="method-note"]').text()).toBe(i18n.global.t('turn-stats.method-inferred-note'))
  })

  it('rescans on demand', async () => {
    const w = await mountView()
    expect(turnsCalls()).toHaveLength(1)
    await w.get('[data-act="rescan"]').trigger('click')
    await flushPromises()
    expect(turnsCalls()).toHaveLength(2)
  })

  it('builds a CSV with a header, one row per turn in transcript order, and quoted prompts', async () => {
    const w = await mountView()
    const csv = (w.vm as unknown as { buildCsv: (t: TokenTurnsResult['turns']) => string }).buildCsv(
      exactAnswer().turns
    )
    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe('turn,started_at,ended_at,account,profile_id,cli_version,prompt,input,cache_read,cache_creation,output,total,calls')
    expect(lines).toHaveLength(3)
    // No account dimension on this answer: the three columns stay empty.
    expect(lines[1]).toBe(
      '1,2026-09-16T00:54:02Z,2026-09-16T00:55:00Z,,,,"Analyze the quota detection, ""with quotes""",2101,498006,900,3455,504462,3'
    )
    expect(lines[2]).toBe('2,2026-09-16T01:01:40Z,,,,,,4812,612340,0,9120,626272,11')
    expect(w.get('[data-act="export"]').attributes('disabled')).toBeUndefined()
  })

  it('an empty transcript shows the empty state and disables export', async () => {
    wire.answer = { ...exactAnswer(), turns: [], totals: { input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, calls: 0 } }
    const w = await mountView()
    expect(w.get('[data-state="empty"]').text()).toBe(i18n.global.t('turn-stats.empty-turns'))
    expect(w.get('[data-act="export"]').attributes('disabled')).toBeDefined()
  })
})

describe('TurnStatsView unsupported', () => {
  it('a vendor known to have no token usage is answered locally, without a scan', async () => {
    const w = await mountView({ pane: PANES[2] })
    expect(w.get('[data-state="unsupported"]').text()).toBe(i18n.global.t('turn-stats.method-unsupported'))
    expect(turnsCalls()).toHaveLength(0)
  })

  it('an unsupported answer from the backend renders the same message', async () => {
    wire.answer = {
      ...exactAnswer(),
      vendor: 'codex',
      method: 'unsupported',
      turns: [],
      totals: { input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, calls: 0 },
    }
    const w = await mountView({ pane: PANES[1] })
    expect(turnsCalls()).toHaveLength(1)
    expect(w.get('[data-state="unsupported"]').text()).toBe(i18n.global.t('turn-stats.method-unsupported'))
    expect(w.find('[data-row="turn"]').exists()).toBe(false)
  })
})

describe('TurnStatsView quota', () => {
  it('lists the agent windows, flags the spent one, and sums the turns inside Claude\'s 5h session window', async () => {
    const w = await mountView({ usage: claudeUsage() })
    const windows = w.findAll('[data-part="quota-window"]')
    expect(windows.map((el) => el.attributes('data-kind'))).toEqual(['session', 'weekly'])
    expect(windows[0].text()).toContain('42%')
    expect(windows[0].attributes('data-exhausted')).toBe('false')
    // resetsAt 05:30Z − 5h = 00:30Z: both turns (00:54Z, 01:01Z) count.
    const spend = w.get('[data-part="quota-spend"]')
    expect(spend.text()).toContain('1,130,734')
    expect(spend.text()).toContain('14')
    expect(spend.text()).toContain(`2 ${i18n.global.t('turn-stats.quota-window-turns')}`)
  })

  it('adds the 5H note beside the real windows, and only for a confirmed account', async () => {
    const weekly = { kind: 'weekly', label: 'Week', usedPercent: 12, resetsAt: '2026-09-20T00:00:00Z' }
    const w = await mountView({ usage: claudeUsage({ windows: [weekly], absentWindows: ['session'] }) })
    expect(w.get('[data-part="quota-session-note"]').text()).toContain(i18n.global.t('usage.window-unlimited'))
    expect(w.findAll('[data-part="quota-window"]').map((el) => el.attributes('data-kind'))).toEqual(['weekly'])
    const other = await mountView({ usage: claudeUsage({ windows: [weekly] }) })
    expect(other.find('[data-part="quota-session-note"]').exists()).toBe(false)
  })

  it('marks an exhausted window and leaves turns outside the window out of the sum', async () => {
    const usage = claudeUsage({
      windows: [{ kind: 'session', label: 'Session', usedPercent: 100, resetsAt: '2026-09-16T06:00:00Z' }],
    })
    const w = await mountView({ usage })
    expect(w.get('[data-part="quota-window"]').attributes('data-exhausted')).toBe('true')
    // 06:00Z − 5h = 01:00Z: only turn 2 (01:01Z) is inside.
    expect(w.get('[data-part="quota-spend"]').text()).toContain('626,272')
    expect(w.get('[data-part="quota-spend"]').text()).not.toContain('1,130,734')
  })

  it('sums a 5h session window for the other fixed-window vendors too (codex), not only Claude', async () => {
    wire.answer = { ...exactAnswer(), vendor: 'codex' }
    const w = await mountView({
      pane: PANES[1],
      usage: claudeUsage({ provider: 'codex', windows: [{ kind: 'session', label: '5h', usedPercent: 12, resetsAt: '2026-09-16T06:00:00Z' }] }),
    })
    // 06:00Z − 5h = 01:00Z: only turn 2 (01:01Z) is inside, as for Claude.
    const spend = w.get('[data-part="quota-spend"]').text()
    expect(spend).toContain('626,272')
    expect(spend).not.toContain('1,130,734')
  })

  it('says the window start is unknown for a vendor other than Claude, and says so when there is no reading', async () => {
    wire.answer = { ...exactAnswer(), vendor: 'codex' }
    const w = await mountView({
      pane: PANES[1],
      usage: claudeUsage({ provider: 'codex', windows: [{ kind: 'weekly', label: 'Week', usedPercent: 3, resetsAt: null }] }),
    })
    expect(w.get('[data-part="quota-spend"]').text()).toBe(i18n.global.t('turn-stats.quota-window-spend-unknown'))
    await w.setProps({ usage: undefined })
    expect(w.get('[data-part="quota-none"]').text()).toBe(i18n.global.t('turn-stats.quota-none'))
    expect(w.find('[data-part="quota-window"]').exists()).toBe(false)
  })

  it('skips expired windows and a snapshot that is not ok', async () => {
    const w = await mountView({
      usage: claudeUsage({
        windows: [{ kind: 'session', label: 'Old', usedPercent: 100, resetsAt: '2026-09-15T00:00:00Z', expired: true }],
      }),
    })
    expect(w.find('[data-part="quota-window"]').exists()).toBe(false)
    await w.setProps({ usage: claudeUsage({ status: 'expired' }) })
    expect(w.find('[data-part="quota-window"]').exists()).toBe(false)
  })
})

describe('TurnStatsView limit hit', () => {
  it('marks the turn the limit was detected in and adds the footnote', async () => {
    // Detected at 00:58Z: after turn 1 started (00:54Z), before turn 2 (01:01Z).
    const seenAt = Date.parse('2026-09-16T00:58:00Z')
    const until = Date.parse('2026-09-16T05:00:00Z')
    const w = await mountView({ pane: { ...PANES[0], usageLimitAt: seenAt, usageLimitUntil: until, usageLimitSeenAt: seenAt } })
    const rows = w.findAll('[data-row="turn"]')
    expect(rows.find((r) => r.attributes('data-turn') === '1')!.attributes('data-limit-hit')).toBe('true')
    expect(rows.find((r) => r.attributes('data-turn') === '2')!.attributes('data-limit-hit')).toBe('false')
    const mark = w.get('[data-part="limit-mark"]')
    expect(mark.attributes('title')).toContain(i18n.global.t('turn-stats.limit-hit-row', { time: '' }).split('(')[0].trim())
    expect(w.get('[data-part="limit-note"]').text()).toBe(i18n.global.t('turn-stats.limit-hit-note'))
  })

  it('a detection after the last turn started lands on the last turn; before the first, on none', async () => {
    const late = Date.parse('2026-09-16T03:00:00Z')
    let w = await mountView({ pane: { ...PANES[0], usageLimitSeenAt: late } })
    expect(w.get('[data-row="turn"][data-turn="2"]').attributes('data-limit-hit')).toBe('true')
    w.unmount()
    const early = Date.parse('2026-09-16T00:00:00Z')
    w = await mountView({ pane: { ...PANES[0], usageLimitSeenAt: early } })
    expect(w.find('[data-part="limit-mark"]').exists()).toBe(false)
    expect(w.find('[data-part="limit-note"]').exists()).toBe(false)
  })

  it('a pane that never hit the limit shows no mark', async () => {
    const w = await mountView()
    expect(w.find('[data-part="limit-mark"]').exists()).toBe(false)
  })
})

describe('TurnStatsView errors', () => {
  it('maps a contract error code to its message', async () => {
    wire.answer = { ok: false, error: 'no-session' }
    const w = await mountView()
    expect(w.get('[data-state="error"]').text()).toBe(i18n.global.t('turn-stats.error-no-session'))
  })

  it('maps a transport-level error envelope to its message', async () => {
    wire.envelopeError = { code: 'file-missing', message: 'gone' }
    const w = await mountView()
    expect(w.get('[data-state="error"]').text()).toBe(i18n.global.t('turn-stats.error-file-missing'))
  })

  it('shows an unknown error with its detail', async () => {
    wire.answer = { ok: false, error: 'boom', detail: 'disk on fire' }
    const w = await mountView()
    expect(w.get('[data-state="error"]').text()).toBe(
      i18n.global.t('turn-stats.error-generic', { detail: 'disk on fire' })
    )
  })

  it('never leaks a raw i18n key in either locale', async () => {
    for (const locale of ['en-US', 'zh-TW'] as const) {
      i18n.global.locale.value = locale
      const w = await mountView()
      await w.get('[data-row="turn"][data-turn="1"]').trigger('click')
      expect(w.text()).not.toMatch(/turn-stats\.[a-z-]+/)
      w.unmount()
    }
  })
})

// ── The account and version dimensions ──────────────────────────────────────
function accountsAnswer(): TokenTurnsResult {
  const base = exactAnswer()
  return {
    ...base,
    turns: [
      { ...base.turns[0], profile_id: 'slot-a', cli_version: '2.1.251', calls_detail: base.turns[0].calls_detail!.map((c) => ({ ...c, cli_version: '2.1.251' })) },
      { ...base.turns[1], profile_id: '__default__', cli_version: '2.1.273' },
      {
        turn_index: 3, started_at: '2026-09-16T01:10:00Z', ended_at: null, prompt_excerpt: 'old',
        input: 100, cache_read: 1000, cache_creation: 0, output: 50, total: 1150, calls: 1, calls_detail: [],
        profile_id: 'unknown', cli_version: '',
      },
    ],
    totals: { input: 7013, cache_read: 1111346, cache_creation: 900, output: 12625, total: 1131884, calls: 15 },
    accounts: ['slot-a', '__default__', 'unknown'],
  }
}

/** A backend whose `on` keeps its handlers, so `usage.changed` can be fed
 *  into the useUsage singleton the view reads per-account snapshots from. */
function usageBackend() {
  const handlers: Record<string, Array<(raw: unknown) => void>> = {}
  const b = fakeBackend() as unknown as { on: unknown }
  b.on = vi.fn((ev: string, cb: (raw: unknown) => void) => {
    ;(handlers[ev] ??= []).push(cb)
    return () => {}
  })
  return {
    backend: b as unknown as never,
    emit(payload: { providers?: Record<string, unknown>; accounts?: Record<string, Record<string, unknown>> }) {
      for (const h of handlers['usage.changed'] ?? []) h(payload)
    },
  }
}

describe('TurnStatsView accounts', () => {
  const profiles = () => fakeProfiles({ emails: { 'slot-a': 'services@x.dev', __default__: 'me@x.dev' }, names: { 'slot-a': 'Services' }, active: null })

  it('adds the account column, one chip per account with its turn count (unknown last), subtotals and the total', async () => {
    wire.answer = accountsAnswer()
    const w = await mountView({ cliProfiles: profiles() })
    const rows = w.findAll('[data-row="turn"]')
    expect(rows.map((r) => r.attributes('data-account'))).toEqual(['unknown', '__default__', 'slot-a'])
    expect(rows[2].get('[data-part="account"]').text()).toBe('services@x.dev')
    expect(rows[1].get('[data-part="account"]').text()).toBe('me@x.dev')
    expect(rows[0].get('[data-part="account"]').text()).toBe(i18n.global.t('account-dim.unknown'))
    expect(rows[0].get('[data-part="account"]').classes()).toContain('unknown')

    const chips = w.findAll('[data-act="account-chip"]')
    expect(chips.map((c) => c.attributes('data-account'))).toEqual(['', 'slot-a', '__default__', 'unknown'])
    expect(chips[0].classes()).toContain('on')
    expect(chips[1].text()).toBe(`services@x.dev (${i18n.global.t('turn-stats.account-turns', { turns: 1 })})`)

    const subtotals = w.findAll('[data-row="subtotal"]')
    expect(subtotals.map((r) => r.attributes('data-account'))).toEqual(['slot-a', '__default__', 'unknown'])
    expect(subtotals[0].get('[data-part="total"]').text()).toBe('504,462')
    expect(subtotals[0].text()).toContain(i18n.global.t('turn-stats.row-subtotal', { account: 'services@x.dev', turns: 1 }))
    const totals = w.get('[data-row="totals"]')
    expect(totals.get('[data-part="total"]').text()).toBe('1,131,884')
    expect(totals.text()).toContain(i18n.global.t('turn-stats.account-turns', { turns: 3 }))
  })

  it('a chip filters the rows and the total, hides the subtotals, and the All chip clears it', async () => {
    wire.answer = accountsAnswer()
    const w = await mountView({ cliProfiles: profiles() })
    await w.get('[data-act="account-chip"][data-account="slot-a"]').trigger('click')
    expect(w.findAll('[data-row="turn"]').map((r) => r.attributes('data-turn'))).toEqual(['1'])
    expect(w.findAll('[data-row="subtotal"]')).toHaveLength(0)
    expect(w.get('[data-row="totals"] [data-part="total"]').text()).toBe('504,462')
    expect(w.get('[data-row="totals"]').text()).toContain(i18n.global.t('turn-stats.account-turns', { turns: 1 }))
    // Clicking the same chip again also clears; the All chip always does.
    await w.get('[data-act="account-chip"][data-account="__default__"]').trigger('click')
    expect(w.findAll('[data-row="turn"]').map((r) => r.attributes('data-turn'))).toEqual(['2'])
    await w.get('[data-act="account-chip"][data-account=""]').trigger('click')
    expect(w.findAll('[data-row="turn"]')).toHaveLength(3)
    expect(w.findAll('[data-row="subtotal"]')).toHaveLength(3)
  })

  it('a rescan drops the filter', async () => {
    wire.answer = accountsAnswer()
    const w = await mountView({ cliProfiles: profiles() })
    await w.get('[data-act="account-chip"][data-account="slot-a"]').trigger('click')
    expect(w.findAll('[data-row="turn"]')).toHaveLength(1)
    await w.get('[data-act="rescan"]').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-row="turn"]')).toHaveLength(3)
    expect(w.get('[data-act="account-chip"][data-account=""]').classes()).toContain('on')
  })

  it('without the dimension on the answer there is no account column, no chips and no subtotal', async () => {
    const w = await mountView({ cliProfiles: profiles() })
    expect(w.find('[data-part="account-filter"]').exists()).toBe(false)
    expect(w.find('[data-part="account"]').exists()).toBe(false)
    expect(w.findAll('[data-row="subtotal"]')).toHaveLength(0)
    expect(w.findAll('[data-row="turn"]')).toHaveLength(2)
  })

  it('names accounts without a profiles source by id, and a removed profile by its shortened id', async () => {
    const answer = accountsAnswer()
    answer.turns[0].profile_id = '0123456789abcdef'
    wire.answer = { ...answer, accounts: ['0123456789abcdef', '__default__'] }
    const w = await mountView()
    const rows = w.findAll('[data-row="turn"]')
    expect(rows[2].get('[data-part="account"]').text()).toBe(`01234567 · ${i18n.global.t('account-dim.removed')}`)
    expect(rows[1].get('[data-part="account"]').text()).toBe(i18n.global.t('account-dim.default'))
  })

  it('exports the account name, its id and the CLI version per turn, filtered rows only', async () => {
    wire.answer = accountsAnswer()
    const w = await mountView({ cliProfiles: profiles() })
    const csv = (w.vm as unknown as { buildCsv: (t: TokenTurnsResult['turns']) => string }).buildCsv(accountsAnswer().turns)
    const lines = csv.trimEnd().split('\n')
    expect(lines[1].startsWith('1,2026-09-16T00:54:02Z,2026-09-16T00:55:00Z,services@x.dev,slot-a,2.1.251,')).toBe(true)
    expect(lines[2].startsWith('2,2026-09-16T01:01:40Z,,me@x.dev,__default__,2.1.273,')).toBe(true)
    expect(lines[3].startsWith(`3,2026-09-16T01:10:00Z,,${i18n.global.t('account-dim.unknown')},unknown,,old,`)).toBe(true)
  })

  it('the export button writes only the rows the account filter leaves visible', async () => {
    wire.answer = accountsAnswer()
    const w = await mountView({ cliProfiles: profiles() })
    const blobs: string[] = []
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob as unknown as string)
      return 'blob:turn-stats'
    })
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: vi.fn() })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      await w.get('[data-act="account-chip"][data-account="slot-a"]').trigger('click')
      await w.get('[data-act="export"]').trigger('click')
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      const csv = await (blobs[0] as unknown as Blob).text()
      const lines = csv.trimEnd().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[1].startsWith('1,2026-09-16T00:54:02Z,2026-09-16T00:55:00Z,services@x.dev,slot-a,')).toBe(true)
    } finally {
      click.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})

describe('TurnStatsView versions', () => {
  it('shows the version column by default, hides it on the toggle, and carries the version into the call rows', async () => {
    wire.answer = accountsAnswer()
    const w = await mountView()
    const rows = w.findAll('[data-row="turn"]')
    expect(rows.map((r) => r.get('[data-part="version"]').text())).toEqual(['—', '2.1.273', '2.1.251'])
    await rows[2].trigger('click')
    expect(w.findAll('[data-row="call"] [data-part="call-version"]').map((c) => c.text())).toEqual(['2.1.251', '2.1.251'])
    const toggle = w.get('[data-act="toggle-version"]')
    expect(toggle.attributes('data-on')).toBe('true')
    await toggle.trigger('click')
    expect(w.find('[data-part="version"]').exists()).toBe(false)
    expect(w.find('[data-part="call-version"]').exists()).toBe(false)
    expect(w.get('[data-act="toggle-version"]').text()).toBe(i18n.global.t('turn-stats.version-show'))
  })

  it('folds a per-version chart above the table: average total per turn with the sample count, and a bar click filters the table', async () => {
    wire.answer = accountsAnswer()
    const w = await mountView()
    const chart = w.get('[data-part="version-chart"]')
    expect(chart.find('svg').exists()).toBe(false)
    await chart.get('[data-act="toggle-version-chart"]').trigger('click')
    const labels = chart.findAll('[data-part="y-label"]').map((l) => l.text())
    expect(labels).toEqual(['2.1.251', '2.1.273'])
    const values = chart.findAll('[data-part="value"]').map((v) => v.text())
    expect(values[0]).toContain('504k')
    expect(values[0]).toContain(i18n.global.t('turn-stats.version-samples', { turns: '1' }))
    await chart.get('[data-part="bar"][data-index="1"]').trigger('click')
    expect(w.findAll('[data-row="turn"]').map((r) => r.attributes('data-turn'))).toEqual(['2'])
    expect(w.get('[data-act="version-chip"]').text()).toContain('2.1.273')
    await w.get('[data-act="version-chip"]').trigger('click')
    expect(w.findAll('[data-row="turn"]')).toHaveLength(3)
  })

  it('draws no chart when no turn carries a version', async () => {
    const w = await mountView()
    expect(w.find('[data-part="version-chart"]').exists()).toBe(false)
  })
})

describe('TurnStatsView per-account quota', () => {
  function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
    return claudeUsage(over)
  }

  it('lists one quota row per account with its own snapshot, active mark, clock, windows and window spend; unknown gets the note', async () => {
    wire.answer = accountsAnswer()
    const { backend, emit } = usageBackend()
    initUsage(backend)
    emit({
      providers: { claude: snapshot({ windows: [{ kind: 'session', label: 'Session', usedPercent: 6, resetsAt: '2026-09-16T05:30:00Z' }] }) },
      accounts: {
        claude: {
          __default__: snapshot({ fetchedAt: '2026-09-16T01:05:00Z', windows: [{ kind: 'session', label: 'Session', usedPercent: 6, resetsAt: '2026-09-16T05:30:00Z' }] }),
          'slot-a': snapshot({ fetchedAt: '2026-09-16T00:40:00Z', stale: true, windows: [{ kind: 'session', label: 'Session', usedPercent: 90, resetsAt: '2026-09-16T05:30:00Z' }, { kind: 'weekly', label: 'Week', usedPercent: 64, resetsAt: '2026-09-18T04:00:00Z' }] }),
        },
      },
    })
    const w = await mountView({
      backend,
      cliProfiles: fakeProfiles({ emails: { 'slot-a': 'services@x.dev', __default__: 'me@x.dev' }, active: null }),
    })
    const rows = w.findAll('[data-part="quota-account"]')
    expect(rows.map((r) => r.attributes('data-account'))).toEqual(['slot-a', '__default__', 'unknown'])

    const services = rows[0]
    expect(services.get('[data-part="quota-account-name"]').text()).toContain('services@x.dev')
    expect(services.attributes('data-active')).toBe('false')
    expect(services.get('[data-part="quota-active"]').text()).toBe(i18n.global.t('account-dim.inactive'))
    expect(services.attributes('data-stale')).toBe('true')
    expect(services.get('[data-part="quota-asof"]').text()).toContain(i18n.global.t('turn-stats.quota-as-of-stale', { time: '' }).split('·')[0].trim())
    expect(services.findAll('[data-part="quota-window"]').map((el) => el.attributes('data-kind'))).toEqual(['session', 'weekly'])
    expect(services.findAll('[data-part="quota-window"]')[0].text()).toContain('90%')
    // Only turn 1 (slot-a) is inside 00:30Z–05:30Z for this account.
    expect(services.get('[data-part="quota-spend"]').text()).toContain('504,462')

    const me = rows[1]
    expect(me.attributes('data-active')).toBe('true')
    expect(me.get('[data-part="quota-active"]').text()).toBe(i18n.global.t('account-dim.active'))
    expect(me.attributes('data-stale')).toBe('false')
    expect(me.findAll('[data-part="quota-window"]')[0].text()).toContain('6%')
    expect(me.get('[data-part="quota-spend"]').text()).toContain('626,272')

    const unknown = rows[2]
    expect(unknown.get('[data-part="quota-unknown"]').text()).toBe(i18n.global.t('turn-stats.quota-unknown-account'))
    expect(unknown.find('[data-part="quota-window"]').exists()).toBe(false)
    expect(unknown.find('[data-part="quota-spend"]').exists()).toBe(false)
    expect(w.find('[data-part="quota-none"]').exists()).toBe(false)
  })

  it('the active account without a per-slot snapshot reads the agent snapshot; other accounts without one say so; a removed profile is marked', async () => {
    const answer = accountsAnswer()
    answer.turns[0].profile_id = 'gone'
    wire.answer = { ...answer, accounts: ['gone', '__default__'] }
    const w = await mountView({
      usage: snapshot({ windows: [{ kind: 'session', label: 'Session', usedPercent: 42, resetsAt: '2026-09-16T05:30:00Z' }] }),
      cliProfiles: fakeProfiles({ active: null }),
    })
    const rows = w.findAll('[data-part="quota-account"]')
    expect(rows.map((r) => r.attributes('data-account'))).toEqual(['gone', '__default__', 'unknown'])
    expect(rows[0].get('[data-part="quota-removed"]').text()).toBe(i18n.global.t('turn-stats.quota-removed'))
    expect(rows[1].get('[data-part="quota-window"]').text()).toContain('42%')
    expect(rows[1].get('[data-part="quota-spend"]').text()).toContain('626,272')
  })

  it('filtering to one account shows only that account\'s quota row', async () => {
    wire.answer = accountsAnswer()
    const w = await mountView({ usage: snapshot(), cliProfiles: fakeProfiles({ active: null }) })
    await w.get('[data-act="account-chip"][data-account="__default__"]').trigger('click')
    expect(w.findAll('[data-part="quota-account"]').map((r) => r.attributes('data-account'))).toEqual(['__default__'])
  })

  it('never leaks a raw i18n key with the dimensions on, in either locale', async () => {
    wire.answer = accountsAnswer()
    for (const locale of ['en-US', 'zh-TW'] as const) {
      i18n.global.locale.value = locale
      const w = await mountView({ usage: snapshot(), cliProfiles: fakeProfiles({ active: null }) })
      await w.get('[data-act="toggle-version-chart"]').trigger('click')
      expect(w.text()).not.toMatch(/(turn-stats|account-dim)\.[a-z-]+/)
      w.unmount()
    }
  })
})
