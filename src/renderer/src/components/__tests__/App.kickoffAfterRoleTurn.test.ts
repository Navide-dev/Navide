// @vitest-environment happy-dom
// 0.2.37 Windows VM (a8af8f35a), sib1 and sib3 (2/13), reproduced as r1 and r2:
// a slot's kickoff was typed while its role prompt's turn was still running.
// Claude Code queued it ("Press up to edit queued messages"), injectText read
// the queue hint as a submit, the slot logged "✓ kickoff sent", and the
// kickoff never reached the model. The run stayed `running` for good.
//
// r2: the role went in at pre-spawn. Its turn's first activity reached the
//     window about 2s after the role's Enter, so the turn-busy check before
//     the kickoff read the pane as idle and typed at once.
// r1: the role was typed again at activation. Only the waitForActivityThenSettle
//     check ran after it, and during the turn the pane repainted nothing but
//     its title spinner, which read as a quiet pane.
//
// A kickoff now waits for the role's turn, read off the CLI's turn events, and
// a pipeline kickoff the CLI queues anyway is sent only once it starts a turn
// of its own.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { MAX_KICKOFF_ATTEMPTS, runPipelineKickoff } from '../../lib/cliCoordination'
import { echoEvidence, normalizeForMatch } from '../../lib/injectEcho'
import * as injectEcho from '../../lib/injectEcho'
import * as delivery from '../../lib/pipelineDelivery'
import { waitUntilTurnEnds } from '../../lib/pipelineDelivery'
import { createRunSlotPanes } from '../../lib/runSlotPanes'
import { isTurnInFlight, VENDORS_WITHOUT_TURN_END } from '../../lib/agentMessaging'
import { linearPipelineDag } from './pipelineDagTestStub'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, startMarker).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, endMarker).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

const helpers = block('function runSlotPane(stageId: string', '\n/** Resolve the live pane id for the global Manager')
const activate = block(
  'async function activateStage(index: number, opts: { only?: string; note?: string } = {}): Promise<void> {',
  '\nasync function spawnPipelineStage(',
)
// The role-turn wait, when App.vue has one. Without it the lifted
// activateStage below finds a stub there, as it does any other name it uses.
const roleWait = appSource.includes('async function awaitRoleTurn(')
  ? block('const TURN_END_WAIT_MS = ', '\nconst QUEUED_TURN_LINE')
    + block('function logInjectEvidence(', '\n/**\n * Whether this window has already told the backend')
  : ''

const KNOWN_GLOBALS = new Set(['Promise', 'Date', 'Array', 'Map', 'Set', 'Object', 'String', 'Number', 'JSON', 'Error', 'console', 'Math', 'undefined'])

async function load(source: string, names: string, scope: Record<string, unknown>) {
  const { code } = await transformWithEsbuild(`${source}\nreturn { ${names} }`, 'AppRoleTurn.ts', { loader: 'ts' })
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === 'string' && (key in target || !KNOWN_GLOBALS.has(key)),
    get: (target, key) => (key === Symbol.unscopables ? undefined : key in target ? target[key as string] : vi.fn()),
  })
  return new Function('scope', `with (scope) { return (function () {${code}})() }`)(proxy)
}

const T0 = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

/** One slot whose pane has a role, on a clock the test moves: `events` are
 *  the CLI's turn events, at ms after T0. */
async function slotRun(opts: {
  injectionStatus: 'sent' | 'failed'
  roleSentAt?: number
  events: Array<{ at: number; kind: 'active' | 'complete' }>
  /** waitForActivityThenSettle as it behaved on the VM: quiet after 2.5s,
   *  since only the title spinner moved. */
  settleMs?: number
  /** The real paneTurnBusy, its 120s fuse included, with the badge this
   *  reads at each moment (ms after T0). */
  badge?: (at: number) => string
}) {
  const STAGE = { id: 'L1', title: 'L1', slots: [{ label: 'wk', agentKey: 'claude', roleKey: 'worker' }] }
  const pane = {
    id: 'wk', stageId: 'L1', slotLabel: 'wk', origin: 'pipeline', realized: true, roleKey: 'worker', agentKey: 'claude',
    injectionStatus: opts.injectionStatus, kickoffStatus: 'none', sessionMarker: 'm', roleSentAt: opts.roleSentAt,
  }
  const panes = { value: [pane] }
  const runSlots = createRunSlotPanes()
  runSlots.startRun(false)
  runSlots.record(runSlots.current(), 'L1', 'wk', 'wk')
  const pipeline = { state: 'running', stageIndex: 0, workspacePath: '/ws', task: 't', log: [] as string[], globalManager: null }
  const paneLastActiveAt = new Map<string, number>()
  const paneTurnCompleteAt = new Map<string, number>()
  const paneTurnStartedAt = new Map<string, number>()
  const pending = [...opts.events]
  const deliver = (): void => {
    while (pending.length && T0 + pending[0].at <= Date.now()) {
      const ev = pending.shift()!
      const at = T0 + ev.at
      if (ev.kind === 'active') {
        if ((paneLastActiveAt.get('wk') ?? 0) <= (paneTurnCompleteAt.get('wk') ?? 0)) paneTurnStartedAt.set('wk', at)
        paneLastActiveAt.set('wk', at)
      } else {
        paneTurnCompleteAt.set('wk', at)
      }
    }
  }
  const sleep = async (ms: number): Promise<void> => {
    vi.setSystemTime(Date.now() + ms)
    deliver()
  }
  const typed: Array<{ what: string; at: number }> = []
  const injectPane = vi.fn(async (_id: string, _text: string, label: string, _paste: boolean, _abort: unknown, evidence?: Record<string, unknown>) => {
    typed.push({ what: label.startsWith('role') ? 'role' : 'kickoff', at: Date.now() - T0 })
    if (evidence) { evidence.echo = 'placeholder'; evidence.submit = 'growth'; evidence.enters = 1 }
    return true
  })
  const realBusy = opts.badge ? functionSource('paneTurnBusy') : ''
  const badge = opts.badge
  const paneRefs = badge ? { wk: { get displayStatus() { return badge(Date.now() - T0) } } } : {}
  const busyDeps = badge
    ? { isTurnInFlight, VENDORS_WITHOUT_TURN_END }
    : { paneTurnBusy: (id: string) => (paneLastActiveAt.get(id) ?? 0) > (paneTurnCompleteAt.get(id) ?? 0) }
  const api = await load(`${helpers}\n${realBusy}\n${roleWait}\n${activate}`, 'activateStage', {
    ...busyDeps,
    panes, runSlots, pipeline,
    stagesApi: { stages: { value: [STAGE] } },
    stageCompletions: new Map(),
    stagePrewarms: new Map(),
    currentRunGroupId: { value: 'rg' },
    paneRefs,
    pipelineDag: linearPipelineDag().dag,
    runPipelineKickoff,
    MAX_KICKOFF_ATTEMPTS,
    injectPane,
    paneAlive: () => true,
    paneParkedOnPrompt: () => false,
    paneLastActiveAt, paneTurnCompleteAt, paneTurnStartedAt,
    waitUntilTurnEnds,
    waitForRoleTurn: delivery.waitForRoleTurn,
    waitForActivityThenSettle: async () => { await sleep(opts.settleMs ?? 2500); return 'settled' },
    sleep,
    sendQuiet: async () => null,
    fetchDocPrefix: async () => '',
    stageCommanderSlot: () => null,
    buildStageContext: () => '',
    renderSlotKickoff: () => 'kickoff',
    sessionMarkerLine: () => '',
    heldKickoffPanes: new Set(),
    heldKickoffCopy: () => undefined,
    runPaneSentAt: new Map(),
    rolesApi: { find: () => ({ system_prompt: 'role', label: 'Worker' }) },
    ROLE_STANDBY_SUFFIX: '',
    runEnding: () => false,
    agentSpecs: [],
    pipelineLog: (line: string) => pipeline.log.push(line),
  })
  deliver()
  await api.activateStage(0)
  return { typed, log: pipeline.log, pane }
}

const kickoffAt = (typed: Array<{ what: string; at: number }>): number => typed.find((t) => t.what === 'kickoff')?.at ?? -1

describe('r2: a role typed at pre-spawn, its turn seen 2s after its Enter', () => {
  it('the kickoff waits for that turn to end', async () => {
    const { typed, log, pane } = await slotRun({
      injectionStatus: 'sent',
      roleSentAt: T0 - 10,
      events: [{ at: 2_000, kind: 'active' }, { at: 9_000, kind: 'complete' }],
    })
    expect(kickoffAt(typed)).toBeGreaterThanOrEqual(9_000)
    expect(log.join('\n')).toMatch(/role turn wait: ✓ the role's turn ended \(turn_complete\) after \d+ ms/)
    expect(pane.roleSentAt).toBeUndefined()
  })

  it('a role whose turn never starts holds the kickoff 10s, then it goes as before', async () => {
    const { typed, log } = await slotRun({ injectionStatus: 'sent', roleSentAt: T0 - 10, events: [] })
    expect(kickoffAt(typed)).toBeGreaterThanOrEqual(10_000)
    expect(kickoffAt(typed)).toBeLessThan(11_000)
    expect(log.join('\n')).toContain('no turn started within 10 s of the role')
  })

  it('a role whose turn already ended long ago holds nothing', async () => {
    const { typed } = await slotRun({
      injectionStatus: 'sent',
      roleSentAt: T0 - 60_000,
      events: [{ at: -50_000, kind: 'active' }, { at: -40_000, kind: 'complete' }],
    })
    expect(kickoffAt(typed)).toBeLessThan(1_000)
  })
})

describe('r1: the role typed again at activation, only a title spinner moving', () => {
  it('the kickoff waits for the role turn, not for a quiet screen', async () => {
    const { typed, log } = await slotRun({
      injectionStatus: 'failed',
      events: [{ at: 1_200, kind: 'active' }, { at: 12_000, kind: 'complete' }],
    })
    expect(typed.map((t) => t.what)).toEqual(['role', 'kickoff'])
    expect(kickoffAt(typed)).toBeGreaterThanOrEqual(12_000)
    expect(log.join('\n')).toMatch(/· role attempt 1: injected — echo placeholder, submit growth, 1 Enter\(s\)/)
    expect(log.join('\n')).toMatch(/· kickoff attempt 1: injected — echo placeholder, submit growth, 1 Enter\(s\)/)
  })
})

describe('e1: a long turn running its stop hooks, the screen frozen, turn_complete late', () => {
  // The turn's last activity is past paneTurnBusy's 120s fuse, and the badge
  // went idle on the frozen screen: the busy check let the kickoff in 3s in.
  const e1 = { badge: (at: number) => (at < 3_000 ? 'running' : 'idle') }

  it('the kickoff waits for that turn_complete', async () => {
    const { typed, log } = await slotRun({
      injectionStatus: 'sent', ...e1,
      events: [{ at: -125_000, kind: 'active' }, { at: 25_000, kind: 'complete' }],
    })
    expect(kickoffAt(typed)).toBeGreaterThanOrEqual(25_000)
    expect(log.join('\n')).toContain('✓ previous turn ended — proceeding')
  })

  it('past 90s without one, says so and goes on', async () => {
    const { typed, log } = await slotRun({
      injectionStatus: 'sent', ...e1,
      events: [{ at: -125_000, kind: 'active' }],
    })
    expect(kickoffAt(typed)).toBeGreaterThanOrEqual(90_000)
    expect(kickoffAt(typed)).toBeLessThan(92_000)
    expect(log.join('\n')).toContain("⚠ no turn_complete within 90 s of the turn's last activity — going on")
  })

  it('a turn that did end holds nothing', async () => {
    const { typed } = await slotRun({
      injectionStatus: 'sent', badge: () => 'idle',
      events: [{ at: -125_000, kind: 'active' }, { at: -100_000, kind: 'complete' }],
    })
    expect(kickoffAt(typed)).toBeLessThan(1_000)
  })
})

describe('waitForRoleTurn', () => {
  const run = async (o: { started: () => boolean; busy: () => boolean; parked?: () => boolean }) => {
    let now = 0
    return delivery.waitForRoleTurn({
      startedSince: o.started, busy: o.busy, parked: o.parked ?? (() => false),
      alive: () => true, stillWanted: () => true,
      sleep: async (ms) => { now += ms }, now: () => now,
    })
  }

  it('stops for a prompt the role turn raised', async () => {
    let n = 0
    expect(await run({ started: () => true, busy: () => true, parked: () => ++n > 3 })).toBe('parked')
  })

  it('says no-start after 10s without a turn', async () => {
    expect(await run({ started: () => false, busy: () => false })).toBe('no-start')
  })
})

describe('a pipeline kickoff the CLI queued', () => {
  const inject = vi.fn(async () => ({ injected: true, echo: 'placeholder' as const, submit: 'queued' as const }))

  it('is sent once it starts its own turn', async () => {
    const r = await runPipelineKickoff({ inject, sleep: async () => {}, paneAlive: () => true, confirmQueued: async () => true })
    expect(r).toEqual({ sent: true, cancelled: false })
  })

  it('is held, never typed again, when it starts none', async () => {
    const onHeld = vi.fn()
    const i = vi.fn(async () => ({ injected: true, echo: 'placeholder' as const, submit: 'queued' as const }))
    const r = await runPipelineKickoff({ inject: i, sleep: async () => {}, paneAlive: () => true, onHeld, confirmQueued: async () => false })
    expect(r).toEqual({ sent: false, cancelled: false })
    expect(onHeld).toHaveBeenCalledTimes(1)
    expect(i).toHaveBeenCalledTimes(1)
  })

  it('any other verdict is sent as before, and a caller without the check is unchanged', async () => {
    const confirmQueued = vi.fn(async () => false)
    const tail = vi.fn(async () => ({ injected: true, echo: 'tail' as const, submit: 'tail-left' as const }))
    expect((await runPipelineKickoff({ inject: tail, sleep: async () => {}, paneAlive: () => true, confirmQueued })).sent).toBe(true)
    expect(confirmQueued).not.toHaveBeenCalled()
    expect((await runPipelineKickoff({ inject, sleep: async () => {}, paneAlive: () => true })).sent).toBe(true)
  })

  it('both kickoff sites hand the check over', () => {
    expect(appSource.match(/confirmQueued: \(\) => confirmQueuedKickoff\(pane\.id, kickoffStartedAt, tag, /g) ?? []).toHaveLength(2)
    expect(appSource.match(/return \{ injected, echo: evidence\.echo, submit: evidence\.submit, stopped: evidence\.stopped \}/g) ?? []).toHaveLength(2)
  })
})

describe('waitForQueuedTurn', () => {
  const run = async (events: Array<{ at: number; kind: 'active' | 'complete' }>, parkedAt = Infinity) => {
    let now = 1_000
    let lastActive = 900
    let lastComplete = 500
    const pending = [...events]
    return delivery.waitForQueuedTurn({
      since: 1_000,
      lastCompleteAt: () => lastComplete,
      lastActiveAt: () => lastActive,
      parked: () => now >= parkedAt,
      alive: () => true,
      stillWanted: () => true,
      now: () => now,
      sleep: async (ms) => {
        now += ms
        while (pending.length && pending[0].at <= now) {
          const ev = pending.shift()!
          if (ev.kind === 'active') lastActive = ev.at
          else lastComplete = ev.at
        }
      },
    })
  }

  it('started: the turn ahead ends, then the kickoff starts its own', async () => {
    expect(await run([{ at: 5_000, kind: 'complete' }, { at: 7_000, kind: 'active' }])).toBe('started')
  })

  it('no-own-turn: the turn ahead ends and nothing follows (the VM runs)', async () => {
    expect(await run([{ at: 5_000, kind: 'complete' }])).toBe('no-own-turn')
  })

  it('turn-never-ended: the turn ahead runs past 5 minutes', async () => {
    expect(await run([])).toBe('turn-never-ended')
  })

  it('parked: the turn ahead stops on a permission box', async () => {
    expect(await run([], 3_000)).toBe('parked')
  })

  it('activity of the turn ahead is not taken for the kickoff\'s own', async () => {
    // The role turn's own activity arrives late, after the kickoff was typed.
    expect(await run([{ at: 2_000, kind: 'active' }, { at: 5_000, kind: 'complete' }])).toBe('no-own-turn')
  })
})

describe('injectText', () => {
  const body = functionSource('injectText')

  it('logs every role and kickoff injection, success included', () => {
    expect(body).toContain('if (evidence) evidence.enters = attempt')
    expect(functionSource('logInjectEvidence')).toContain('echo ${ev.echo ?? \'none\'}, submit ${ev.submit ?? \'none\'}')
  })

  it('a dialog already up before the first Enter is not a submit', () => {
    const sampled = body.indexOf('const dialogBeforeEnter = dialogShown()')
    const loop = body.indexOf('for (let attempt = 1; attempt <= MAX_SUBMITS; attempt++) {')
    expect(sampled).toBeGreaterThan(-1)
    expect(sampled).toBeLessThan(loop)
    expect(body).toMatch(/if \(attempt > 1 && dialogShown\(\)\) \{\s*if \(dialogBeforeEnter\) return false/)
  })

  it('matches the tail only in what arrived since this send', () => {
    expect(body).toContain('echoEvidenceSince(cleanBuf(), tail, cleanBytes() - preBytes, normalizedLen)')
  })
})

describe('echoEvidenceSince', () => {
  const tail = normalizeForMatch('the end of this kickoff, forty chars long or so')
  const kickoff = 'the end of this kickoff, forty chars long or so'

  it('does not take an earlier attempt\'s copy for this one', () => {
    const buffer = `${kickoff}\n…repaint of a permission box…`
    expect(echoEvidence(buffer, tail, 10, 400)).toBe('tail')
    expect(injectEcho.echoEvidenceSince(buffer, tail, 10, 400)).toBeNull()
  })

  it('finds this send\'s own copy', () => {
    const buffer = `old output\n${kickoff}`
    expect(injectEcho.echoEvidenceSince(buffer, tail, kickoff.length, 400)).toBe('tail')
  })

  it('keeps the placeholder and growth verdicts', () => {
    expect(injectEcho.echoEvidenceSince('[Pasted text #1 +40 lines]', 'nomatch', 5, 400)).toBe('placeholder')
    expect(injectEcho.echoEvidenceSince('unrelated repaint output', 'nowhere', 400, 40)).toBe('growth')
  })
})

describe('the spawn path', () => {
  const schedule = functionSource('scheduleInjection')

  it('waits for the role turn before its kickoff, and records when the role went in', () => {
    expect(schedule).toContain('pane.roleSentAt = Date.now()')
    const wait = schedule.indexOf('await awaitRoleTurn(pane.id, pane.roleSentAt, tag,')
    expect(wait).toBeGreaterThan(-1)
    expect(wait).toBeLessThan(schedule.indexOf('const kickoffResult = await runPipelineKickoff({'))
    expect(schedule).toContain('parkedOnPrompt: () => roleParked || paneParkedOnPrompt(pane.id),')
  })
})
