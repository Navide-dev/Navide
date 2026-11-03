// @vitest-environment happy-dom
// 0.2.37 Linux VM (a8af8f35a), 2/13 (sib5, sib12): a slot was found parked on
// a prompt, so the run would fail, yet a sibling's kickoff still went out and
// its agent ran into a permission box. The slot records its kickoff and its
// stage with the backend (pipeline.slot_kickoff, pipeline.stage_spawn) before
// failRunOnKickoff tears the run down, and for that second the run was still
// `running`: the sibling's check right before its Enter passed.
//
// The failure is now marked the moment it is decided, before the first await,
// and every "still wanted?" check reads the mark. These tests run the slot's
// own code out of App.vue and ask the sibling's check inside each of those
// awaits.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { retryLeft } from '../../lib/pipelineDagRun'
import type { DagPlan, DagRunState } from '../../lib/pipelineDagRun'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

function between(body: string, from: string, to: string, inclusive = true): string {
  const a = body.indexOf(from)
  expect(a, from).toBeGreaterThan(-1)
  const b = body.indexOf(to, a)
  expect(b, to).toBeGreaterThan(a)
  return body.slice(a, inclusive ? b + to.length : b)
}

const activate = functionSource('activateStage')
const stillWantedLine = activate.match(/const slotStillWanted = \(\): boolean => [^\n]+/)?.[0] ?? ''
// The mark, if App.vue has one; without it the slot's code below finds no-ops.
const markDecl = appSource.includes('const runEndingSlots = new Set<string>()')
  ? ['const runEndingSlots = new Set<string>()', functionSource('runEnding'), functionSource('markRunEnding')].join('\n')
  : 'const runEndingSlots = new Set(); function runEnding() { return false } function markRunEnding() {}'

type Harness = {
  pipeline: { state: string; stageIndex: number; workspacePath: string }
  siblingAt: Array<{ call: string; wanted: boolean }>
  sendQuiet: ReturnType<typeof vi.fn>
  scheduleSlotRetry: ReturnType<typeof vi.fn>
  siblingWanted: () => boolean
  runEnding: () => boolean
  failRunOnKickoff: (...args: unknown[]) => Promise<void>
}

/** The slot's segment `segment`, run as App.vue runs it, with the real
 *  failRunOnKickoff behind it and the sibling's check asked at every backend
 *  call. `ends` is what the graph says a failure does. */
async function harness(segment: string, locals: Record<string, unknown>, ends: { retry?: boolean; errorEdge?: boolean } = {}) {
  const pipeline = { state: 'running', stageIndex: 0, workspacePath: '/ws' }
  const siblingAt: Array<{ call: string; wanted: boolean }> = []
  let siblingWanted: () => boolean = () => true
  const sendQuiet = vi.fn(async (call: string) => {
    // pipeline.abort is failRunOnKickoff's own, after the teardown.
    if (call === 'pipeline.abort') return null
    siblingAt.push({ call, wanted: siblingWanted() })
    await new Promise((r) => setTimeout(r, 0))
    siblingAt.push({ call: `${call}:resolved`, wanted: siblingWanted() })
    return null
  })
  const scheduleSlotRetry = vi.fn()
  const pipelineDag = {
    failureEndsRun: (_i: number, _l: string, needsUser: boolean) => needsUser || (!ends.retry && !ends.errorEdge),
    retryAfterFailure: () => (ends.retry ? { attempt: 2, maxTries: 2, waitMs: 0, note: '' } : null),
    routeFailure: () => !!ends.errorEdge,
    slotFailed: vi.fn(),
    slotStarted: vi.fn(),
    end: vi.fn(async () => {}),
    isChildRun: () => false,
  }
  const deps: Record<string, unknown> = {
    pipeline, pipelineDag, sendQuiet, scheduleSlotRetry,
    stagesApi: { stages: { value: [{ id: '01' }] } },
    runSlotPane: () => undefined,
    onStageSlotCompleted: vi.fn(),
    pipelineLog: () => {},
    tearDownPipelineOrchestration: () => { pipeline.state = 'aborted' },
    stopFailedRunPanes: async () => {},
    runPaneSentAt: new Map(),
    applyProjectPaths: () => {},
    notifyRestore: { toast: () => {} },
    i18n: { global: { t: (k: string) => k } },
    returnToParent: async () => false,
    onWorkspaceCheck: async () => {},
    syncViews: () => {},
    heldKickoffPanes: new Set<string>(),
    ensureStageRouter: () => ({ workerPaneIds: new Map() }),
    armRouterCursors: () => {},
    startStageWatcher: vi.fn(),
    paneRefs: {},
    PARKED_ON_PROMPT_REASON: 'parked',
    MAX_KICKOFF_ATTEMPTS: 3,
    index: 0,
    tag: '[01/w]',
    slot: { label: 'w', agentKey: 'claude', roleKey: '' },
    stage: { id: '01', allowQuestions: false },
    pane: { id: 'p-w' },
    managerSlot: undefined,
    ...locals,
  }
  const { code } = await transformWithEsbuild(
    [
      markDecl,
      functionSource('failRunOnKickoff'),
      stillWantedLine,
      `return { slotStillWanted, runEnding, failRunOnKickoff, run: async () => { ${segment} } }`,
    ].join('\n'),
    'AppRunEnding.ts', { loader: 'ts' },
  )
  const made = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
    slotStillWanted: () => boolean
    runEnding: () => boolean
    failRunOnKickoff: (...args: unknown[]) => Promise<void>
    run: () => Promise<void>
  }
  // The sibling is another slot of the same stage: same index, same check.
  siblingWanted = made.slotStillWanted
  await made.run()
  const h: Harness = {
    pipeline, siblingAt, sendQuiet, scheduleSlotRetry,
    siblingWanted: made.slotStillWanted, runEnding: made.runEnding, failRunOnKickoff: made.failRunOnKickoff,
  }
  return h
}

const kickoffTail = between(activate, '    const ok = kickoffResult.sent\n', '    startStageWatcher(index, pane.id, kickoffScanFrom, kickoffStartedAt)\n')

describe.each([
  ['parked on a prompt', { sent: false, cancelled: false, parked: true }, false],
  ['held in the input box', { sent: false, cancelled: false }, true],
  ['never reached the agent', { sent: false, cancelled: false }, false],
])('a kickoff %s', (_name, kickoffResult, held) => {
  it('stops the sibling from the moment it is decided, through both backend calls', async () => {
    const h = await harness(kickoffTail, { kickoffResult, held, kickoffStartedAt: 0 })
    expect(h.sendQuiet.mock.calls.map((c) => c[0])).toEqual(['pipeline.slot_kickoff', 'pipeline.stage_spawn', 'pipeline.abort'])
    expect(h.siblingAt).toHaveLength(4)
    for (const at of h.siblingAt) expect(at, at.call).toEqual({ call: at.call, wanted: false })
    expect(h.pipeline.state).toBe('aborted')
    expect(h.runEnding()).toBe(false)
  })
})

describe('a kickoff that fails a slot with a try left', () => {
  it('leaves the sibling wanted: the run goes on with a retry', async () => {
    const h = await harness(kickoffTail, { kickoffResult: { sent: false, cancelled: false }, held: false, kickoffStartedAt: 0 }, { retry: true })
    expect(h.siblingAt.every((at) => at.wanted)).toBe(true)
    expect(h.scheduleSlotRetry).toHaveBeenCalledTimes(1)
    expect(h.pipeline.state).toBe('running')
    expect(h.siblingWanted()).toBe(true)
  })

  it('or an error edge', async () => {
    const h = await harness(kickoffTail, { kickoffResult: { sent: false, cancelled: false }, held: false, kickoffStartedAt: 0 }, { errorEdge: true })
    expect(h.siblingAt.every((at) => at.wanted)).toBe(true)
    expect(h.siblingWanted()).toBe(true)
  })
})

describe('a kickoff that went out', () => {
  it('marks nothing', async () => {
    const h = await harness(kickoffTail, { kickoffResult: { sent: true, cancelled: false }, held: false, kickoffStartedAt: 0 })
    expect(h.siblingAt.every((at) => at.wanted)).toBe(true)
    expect(h.runEnding()).toBe(false)
  })
})

describe('a pane found parked before anything is typed', () => {
  const parkedBlock = between(activate, "    if (turnWait === 'parked' || paneParkedOnPrompt(pane.id)) {", '\n      return\n    }\n')

  it('stops the sibling through both backend calls', async () => {
    const h = await harness(parkedBlock, { turnWait: 'parked', paneParkedOnPrompt: () => true })
    expect(h.siblingAt).toHaveLength(4)
    for (const at of h.siblingAt) expect(at, at.call).toEqual({ call: at.call, wanted: false })
    expect(h.pipeline.state).toBe('aborted')
  })
})

describe('a deferred role that never landed', () => {
  const roleBlock = between(activate, '      if (!roleOk) {', '      } else {', false) + '}'

  it('stops the sibling through both backend calls', async () => {
    const h = await harness(roleBlock, { roleOk: false, retry: false })
    expect(h.siblingAt).toHaveLength(4)
    for (const at of h.siblingAt) expect(at, at.call).toEqual({ call: at.call, wanted: false })
    expect(h.pipeline.state).toBe('aborted')
  })

  it('with a retry policy, leaves the sibling wanted', async () => {
    const h = await harness(roleBlock, { roleOk: false, retry: false }, { retry: true })
    expect(h.siblingAt.every((at) => at.wanted)).toBe(true)
    expect(h.siblingWanted()).toBe(true)
  })
})

describe('the mark', () => {
  it('is taken back when failRunOnKickoff gives the slot a retry after all', async () => {
    const h = await harness('markRunEnding(0, "w")', {}, { retry: true })
    // The graph said "ends" at the decision (here: forced), the retry came later.
    expect(h.runEnding()).toBe(false)
    const forced = await harness('runEndingSlots.add("0/w")', {}, { retry: true })
    expect(forced.siblingWanted()).toBe(false)
    await forced.failRunOnKickoff(0, 'w', 'x')
    expect(forced.scheduleSlotRetry).toHaveBeenCalledTimes(1)
    expect(forced.siblingWanted()).toBe(true)
  })

  it('is taken back for a slot of a run that moved on', async () => {
    const h = await harness('runEndingSlots.add("0/w"); pipeline.stageIndex = 1', {})
    await h.failRunOnKickoff(0, 'w', 'x')
    expect(h.runEnding()).toBe(false)
  })

  it.each(['onPipelineStart', 'runPipelineResume', 'onPipelineRestart', 'onPipelineReset', 'tearDownPipelineOrchestration'])(
    '%s empties it', (name) => {
      expect(functionSource(name)).toContain('runEndingSlots.clear()')
    },
  )

  it('is read by the spawn path checks too', () => {
    const spawned = appSource.match(/pane\.origin !== 'pipeline' \|\| \(pipeline\.state === 'running' && !runEnding\(\)\)/g) ?? []
    // The kickoff's Enter check, its attempt check, the role-turn wait and
    // the queued-kickoff confirmation.
    expect(spawned).toHaveLength(4)
    expect(appSource).not.toMatch(/pane\.origin !== 'pipeline' \|\| pipeline\.state === 'running',?\n/)
  })

  it('is read by the wait for the previous turn', () => {
    const wait = between(activate, 'turnWait = await waitUntilTurnEnds({', '})')
    expect(wait).toContain('stillWanted: slotStillWanted,')
  })
})

describe('retryLeft', () => {
  const plan = (maxTries?: number) => ({
    graph: { nodes: [{ id: 'n', kind: 'slot', retry: maxTries ? { maxTries, waitMs: 0 } : undefined }], edges: [] },
  }) as unknown as DagPlan
  const state = (used?: number) => ({ retries: used === undefined ? {} : { n: used } }) as unknown as DagRunState

  it('says what takeRetry would do, without taking a try', () => {
    expect(retryLeft(plan(), state(), 'n')).toBe(false)
    expect(retryLeft(plan(3), state(), 'n')).toBe(true)
    expect(retryLeft(plan(3), state(1), 'n')).toBe(true)
    expect(retryLeft(plan(3), state(2), 'n')).toBe(false)
    const s = state(1)
    retryLeft(plan(3), s, 'n')
    expect(s.retries).toEqual({ n: 1 })
  })
})
