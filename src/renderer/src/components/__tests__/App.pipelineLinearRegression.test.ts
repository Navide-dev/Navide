// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { MAX_KICKOFF_ATTEMPTS, runPipelineKickoff } from '../../lib/cliCoordination'
import { registerStage } from '../../lib/stageTracker'
import { linearPipelineDag } from './pipelineDagTestStub'
import { usePipelineDag } from '../../composables/usePipelineDag'
import { applyGraphOps, deriveGraphFromStages, type PipelineGraph } from '../../lib/pipelineGraph'
import type { Stage as StageDef } from '../../data/stages'

// Regression lock for the DAG engine: a legacy LINEAR pipeline (stages only,
// no graph) must run exactly as it did before the engine learned gates,
// reject loops and pins — same spawns, same kickoff text, same backend calls,
// same order. Written against the pre-DAG App.vue and kept green after.
//
// App.vue cannot be mounted (see App.pipelineStagePrewarm.test.ts), so the run
// path — onPipelineStart → preSpawnStage → activateStage → onPipelineNext — is
// lifted out, compiled and driven against recording stubs. Dependencies are
// passed by name, so a dependency the lifted code gains without the test
// knowing fails loudly as a ReferenceError instead of being stubbed silently.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const sources = [
  block('const stagePrewarms = new Map<number, Promise<void>>()', '\n/** Spawn all slots for one stage WITHOUT injecting kickoffs.'),
  block('async function preSpawnStage(index: number): Promise<void> {', '\n/** Build cross-stage context'),
  block('async function activateStage(index: number): Promise<void> {', '\nasync function spawnPipelineStage('),
  block(
    'async function onPipelineStart(payload: { task: string; workspacePath: string; pipelineId?: string',
    '\n/** Before firing 🎉',
  ),
  block('async function onPipelineNext(): Promise<void> {', '\n/** Everything an abort does'),
]

interface Slot { label: string; agentKey: string; roleKey: string; kickoffBody: string }
interface Stage { id: string; title: string; sentinel: string; slots: Slot[]; allowQuestions?: boolean; docQuery?: string }

const STAGES: Stage[] = [
  {
    id: '01', title: 'Plan', sentinel: '---01---',
    slots: [
      { label: 'fe', agentKey: 'claude', roleKey: 'dev', kickoffBody: 'front {{task}}' },
      { label: 'be', agentKey: 'codex', roleKey: 'dev', kickoffBody: 'back {{task}}' },
    ],
  },
  { id: '02', title: 'Review', sentinel: '---02---', slots: [{ label: 'rv', agentKey: 'claude', roleKey: 'qa', kickoffBody: 'review' }] },
]

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function load(extraDeps: Record<string, unknown> = {}) {
  const { code } = await transformWithEsbuild(
    `${sources.join('\n')}\nreturn { onPipelineStart, onPipelineNext }`,
    'AppPipelineLinear.ts',
    { loader: 'ts' },
  )
  const events: string[] = []
  const pipeline = { state: 'idle', workspacePath: '', task: '', stageIndex: -1, globalManager: null as unknown, log: [] as string[] }
  const panes = { value: [] as Array<Record<string, unknown>> }
  let paneSeq = 0
  const { dag, sent: dagSent } = linearPipelineDag(() => pipeline.workspacePath)
  const deps: Record<string, unknown> = {
    pipeline,
    pipelinesApi: { activePipelineId: { value: 'pl-1' }, setActivePipeline: vi.fn(async () => true), error: { value: '' } },
    stagesApi: { isLoaded: { value: true }, stages: { value: STAGES }, refresh: vi.fn(), error: { value: '' } },
    panes,
    paneRefs: {},
    stageCompletions: new Map(),
    currentRunGroupId: { value: 'rg-1' },
    existingProject: { value: null },
    pipelineRunWorkspace: '',
    currentMode: { value: 'running' },
    watchers: new Map(),
    registerStage,
    releaseStageSlot: (i: number, key: string) => events.push(`release ${i} ${key}`),
    pipelineLog: (line: string) => pipeline.log.push(line),
    pipelineRunGroupName: () => 'Pipeline',
    createRunGroup: (name: string) => events.push(`runGroup ${name}`),
    deriveGlobalManager: () => null,
    applyProjectPaths: vi.fn(),
    sendQuiet: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      events.push(`send ${type} ${JSON.stringify(payload)}`)
      return null
    }),
    spawnPane: vi.fn(async (opts: Record<string, unknown>) => {
      const id = `p${++paneSeq}`
      events.push(`spawn ${opts.stageId}/${opts.slotLabel} ${opts.agentKey} kickoff=${JSON.stringify(opts.kickoffPrompt ?? null)}`)
      panes.value.push({
        id, stageId: opts.stageId, slotLabel: opts.slotLabel, origin: 'pipeline', realized: true,
        roleKey: opts.roleKey, injectionStatus: 'sent', kickoffStatus: 'none', sessionMarker: `m-${id}`,
      })
      return id
    }),
    startGlobalManagerRouter: () => events.push('globalRouter'),
    fetchDocPrefix: async () => '',
    stageCommanderSlot: () => null,
    buildStageContext: (i: number) => `[ctx ${i}]`,
    renderSlotKickoff: (slot: Slot, task: string) => slot.kickoffBody.replace('{{task}}', task),
    sessionMarkerLine: (m: string) => ` <${m}>`,
    persistPaneMuted: vi.fn(),
    onKill: vi.fn(),
    paneAlive: () => true,
    injectPane: vi.fn(async (id: string, text: string) => {
      events.push(`inject ${id} ${JSON.stringify(text)}`)
      return true
    }),
    syncViews: vi.fn(),
    startStageWatcher: (i: number, id: string) => events.push(`watch ${i} ${id}`),
    startRouterPoll: vi.fn(),
    ensureStageRouter: vi.fn(),
    armRouterCursors: vi.fn(),
    rolesApi: { find: () => null },
    sleep: async () => {},
    waitForActivityThenSettle: async () => 'settled',
    agentSpecs: [],
    roleLabel: () => '',
    ROLE_STANDBY_SUFFIX: '',
    runPipelineKickoff,
    MAX_KICKOFF_ATTEMPTS,
    cancelWatcher: vi.fn(),
    globalManagerPaneId: () => null,
    disposeStageRouter: (i: number) => events.push(`disposeRouter ${i}`),
    waitForStagePanesSettled: async (i: number) => { events.push(`settle ${i}`) },
    stopGlobalManagerRouter: () => events.push('stopGlobalRouter'),
    reclaimCompletedStagePanes: async (i: number) => { events.push(`reclaim ${i}`) },
    onStageSlotCompleted: (i: number, key: string) => events.push(`slotCompleted ${i} ${key}`),
    pipelineDag: dag,
    ...extraDeps,
  }
  const factory = new Function(...Object.keys(deps), code)
  const api = factory(...Object.values(deps)) as {
    onPipelineStart: (p: { task: string; workspacePath: string; pipelineId?: string }) => Promise<void>
    onPipelineNext: () => Promise<void>
  }
  return { api, events, pipeline, dagSent, deps }
}

/** The exact event trace the pre-DAG engine produced for STAGES. */
const EXPECTED = [
  'runGroup Pipeline',
  'send pipeline.start {"workspace_path":"/ws","task_description":"ship","total_stages":2,"stage_blueprint":[{"stage_id":"01","title":"Plan","sentinel":"---01---","slots":[{"agent":"claude","role":"dev","label":"fe"},{"agent":"codex","role":"dev","label":"be"}]},{"stage_id":"02","title":"Review","sentinel":"---02---","slots":[{"agent":"claude","role":"qa","label":"rv"}]}],"pipeline_id":"pl-1"}',
  'spawn 01/fe claude kickoff=null',
  'spawn 01/be codex kickoff=null',
  'send pipeline.slot_spawn {"workspace_path":"/ws","stage_index":0,"slot_label":"fe","pane_id":"p1","agent":"claude","role":"dev","session_id":"","session_home_id":"","run_group_id":"rg-1"}',
  'send pipeline.slot_spawn {"workspace_path":"/ws","stage_index":0,"slot_label":"be","pane_id":"p2","agent":"codex","role":"dev","session_id":"","session_home_id":"","run_group_id":"rg-1"}',
  'inject p1 "[ctx 0]front ship <m-p1>"',
  'inject p2 "[ctx 0]back ship <m-p2>"',
  'send pipeline.slot_kickoff {"workspace_path":"/ws","stage_index":0,"slot_label":"fe","kickoff_status":"sent"}',
  'send pipeline.slot_kickoff {"workspace_path":"/ws","stage_index":0,"slot_label":"be","kickoff_status":"sent"}',
  'send pipeline.stage_spawn {"workspace_path":"/ws","stage_index":0,"pane_id":"p1","agent":"claude","role":"dev"}',
  'send pipeline.stage_spawn {"workspace_path":"/ws","stage_index":0,"pane_id":"p2","agent":"codex","role":"dev"}',
  'watch 0 p1',
  'watch 0 p2',
  'spawn 02/rv claude kickoff=null',
  'send pipeline.slot_spawn {"workspace_path":"/ws","stage_index":1,"slot_label":"rv","pane_id":"p3","agent":"claude","role":"qa","session_id":"","session_home_id":"","run_group_id":"rg-1"}',
  // ── onPipelineNext: stage 01 → 02
  'disposeRouter 0',
  'reclaim 0',
  'inject p3 "[ctx 1]review <m-p3>"',
  'send pipeline.slot_kickoff {"workspace_path":"/ws","stage_index":1,"slot_label":"rv","kickoff_status":"sent"}',
  'send pipeline.stage_spawn {"workspace_path":"/ws","stage_index":1,"pane_id":"p3","agent":"claude","role":"qa"}',
  'watch 1 p3',
  // ── onPipelineNext: final stage
  'disposeRouter 1',
  'settle 1',
  'stopGlobalRouter',
  'send pipeline.complete {"workspace_path":"/ws"}',
]

async function runLinear(extraDeps: Record<string, unknown> = {}) {
  const { api, events, pipeline, dagSent } = await load(extraDeps)
  await api.onPipelineStart({ task: 'ship', workspacePath: '/ws' })
  await flush()
  events.push('// next')
  await api.onPipelineNext()
  await flush()
  events.push('// next')
  await api.onPipelineNext()
  await flush()
  return { events: events.filter((e) => !e.startsWith('// ')), pipeline, dagSent }
}

describe('a legacy linear pipeline runs exactly as before', () => {
  it('produces the pre-DAG spawn / kickoff / backend trace, in order', async () => {
    const { events, pipeline } = await runLinear()
    expect(events).toEqual(EXPECTED)
    expect(pipeline.state).toBe('completed')
    expect(pipeline.stageIndex).toBe(1)
  })
})

// ── The same run path with a graph: gates, reject loops, pins ──────────────

const gateSource = block(
  '/** Approve the gate the run is paused on and carry on with the hand-off. */',
  '\nasync function onPipelineReset(',
)

async function loadGraphRun(graph: PipelineGraph) {
  const { code } = await transformWithEsbuild(
    `${sources.join('\n')}\n${gateSource}\nreturn { onPipelineStart, onPipelineNext, onPipelineGateApprove, onPipelineGateReject }`,
    'AppPipelineDag.ts',
    { loader: 'ts' },
  )
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  let workspace = ''
  const dag = usePipelineDag({
    send: async (type, payload) => {
      sent.push({ type, payload })
      return type === 'pipelines.graph.get' ? { derived: false, graph } : {}
    },
    log: () => {},
    workspacePath: () => workspace,
  })
  const base = await load({ pipelineDag: dag })
  const deps = {
    ...base.deps,
    pipelineDag: dag,
    tearDownPipelineOrchestration: () => { base.pipeline.state = 'aborted'; base.events.push('teardown') },
    onWorkspaceCheck: async () => {},
  }
  const api = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
    onPipelineStart: (p: { task: string; workspacePath: string; fromNodeId?: string }) => Promise<void>
    onPipelineNext: () => Promise<void>
    onPipelineGateApprove: (id: string) => Promise<boolean>
    onPipelineGateReject: (id: string, comment?: string) => Promise<boolean>
  }
  const start = async (opts: { fromNodeId?: string } = {}) => {
    workspace = '/ws'
    await api.onPipelineStart({ task: 'ship', workspacePath: '/ws', ...opts })
    await flush()
  }
  return { api, dag, sent, events: base.events, pipeline: base.pipeline, start }
}

/** STAGES as a graph with a gate between 01 and 02 that loops back to 01. */
function gatedGraph(): PipelineGraph {
  return applyGraphOps(deriveGraphFromStages(STAGES as unknown as StageDef[]), [
    { op: 'add_node', node: { id: 'gate', kind: 'gate', label: 'OK?', position: { x: 0, y: 0 } }, after: ['n-01-0', 'n-01-1'], before: ['n-02-0'] },
    { op: 'add_edge', edge: { id: 'rej', from: 'gate', to: 'n-01-0', kind: 'reject', maxLoops: 1 } },
  ])
}

describe('a graph pipeline runs its gates, loops and pins', () => {
  it('holds the hand-off at a gate until it is approved', async () => {
    const run = await loadGraphRun(gatedGraph())
    await run.start()
    await run.api.onPipelineNext()
    await flush()
    expect(run.pipeline.stageIndex).toBe(0)
    expect(run.dag.awaitingGate.value?.gateId).toBe('gate')
    expect(run.events).not.toContain('reclaim 0')
    // Next cannot walk past the gate.
    await run.api.onPipelineNext()
    expect(run.pipeline.stageIndex).toBe(0)
    expect(await run.api.onPipelineGateApprove('gate')).toBe(true)
    await flush()
    expect(run.pipeline.stageIndex).toBe(1)
    expect(run.events).toContain('reclaim 0')
    const states = run.sent.filter((s) => s.type === 'pipeline.node_states').at(-1)!.payload.nodes as Record<string, { status: string }>
    expect(states.gate.status).toBe('done')
    expect(states['n-02-0'].status).toBe('running')
  })

  it('a reject loops back with a note, and a spent budget fails the run', async () => {
    const run = await loadGraphRun(gatedGraph())
    await run.start()
    await run.api.onPipelineNext()
    await flush()
    const before = run.events.length
    expect(await run.api.onPipelineGateReject('gate', 'tests are red')).toBe(true)
    await flush()
    const rerun = run.events.slice(before)
    expect(run.pipeline.stageIndex).toBe(0)
    // Stage 01's panes are alive, so the kickoff goes back into them with the
    // reject note in front — and no twin panes are spawned.
    expect(rerun.some((e) => e.startsWith('inject p1') && e.includes('tests are red'))).toBe(true)
    expect(rerun.some((e) => e.startsWith('spawn 01/'))).toBe(false)
    await run.api.onPipelineNext()
    await flush()
    expect(run.dag.awaitingGate.value?.gateId).toBe('gate')
    await run.api.onPipelineGateReject('gate')
    await flush()
    expect(run.pipeline.state).toBe('aborted')
    expect(run.events.some((e) => e.startsWith('send pipeline.abort') && e.includes('"reason":"failed"'))).toBe(true)
  })

  it('a pinned slot is not spawned and counts as done', async () => {
    const graph = applyGraphOps(deriveGraphFromStages(STAGES as unknown as StageDef[]), [{ op: 'set_pin', id: 'n-01-1', pinned: true }])
    const run = await loadGraphRun(graph)
    await run.start()
    expect(run.events.some((e) => e.startsWith('spawn 01/be'))).toBe(false)
    expect(run.events).toContain('slotCompleted 0 pinned:be')
  })

  it('restart-from-node starts at that node\'s stage and tells the backend', async () => {
    const run = await loadGraphRun(gatedGraph())
    await run.start({ fromNodeId: 'n-02-0' })
    expect(run.pipeline.stageIndex).toBe(1)
    expect(run.events.some((e) => e.startsWith('send pipeline.start') && e.includes('"start_index":1'))).toBe(true)
    expect(run.events.some((e) => e.startsWith('spawn 01/'))).toBe(false)
    expect(run.events.some((e) => e.startsWith('inject') && e.includes('review'))).toBe(true)
  })
})

// ── Run endings the engine must close out ───────────────────────────────────

const releaseSource = block(
  'function releaseStageSlot(stageIndex: number, slotKey: string, why: string): void {',
  '\nfunction startStageWatcher(',
)

describe('a run that loses every slot', () => {
  it('closes its running nodes as aborted', async () => {
    const { code } = await transformWithEsbuild(`${releaseSource}\nreturn { releaseStageSlot }`, 'AppRelease.ts', { loader: 'ts' })
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
    const dag = usePipelineDag({
      send: async (type, payload) => {
        sent.push({ type, payload })
        return type === 'pipelines.graph.get' ? { derived: true } : {}
      },
      log: () => {},
      workspacePath: () => '/ws',
    })
    await dag.begin('pl-1', STAGES as unknown as StageDef[])
    dag.slotStarted(0, 'fe', 'p1')
    dag.slotStarted(0, 'be', 'p2')
    const pipeline = { state: 'running', stageIndex: 0, log: [] as string[] }
    const stageCompletions = new Map()
    registerStage(stageCompletions, 0, 2)
    const deps: Record<string, unknown> = {
      releaseSlot: (await import('../../lib/stageTracker')).releaseSlot,
      stageCompletions,
      stagesApi: { stages: { value: STAGES } },
      pipelineLog: (l: string) => pipeline.log.push(l),
      pipeline,
      cancelStageWatchers: vi.fn(),
      disposeStageRouter: vi.fn(),
      stopGlobalManagerRouter: vi.fn(),
      onPipelineNext: vi.fn(),
      pipelineDag: dag,
    }
    const api = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
      releaseStageSlot: (i: number, key: string, why: string) => void
    }
    api.releaseStageSlot(0, 'p1', 'closed')
    api.releaseStageSlot(0, 'p2', 'closed')
    await flush()
    expect(pipeline.state).toBe('aborted')
    const nodes = sent.filter((s) => s.type === 'pipeline.node_states').at(-1)!.payload.nodes as Record<string, { status: string }>
    expect(nodes['n-01-0'].status).toBe('aborted')
    expect(nodes['n-01-1'].status).toBe('aborted')
  })
})

const abortSource = block('async function onPipelineAbort(): Promise<void> {', '\nasync function onPipelineGateApprove(')
const resumeSource = block('async function runPipelineResume(): Promise<void> {', '\n// Orders every project.set_ui_state')

describe('a run aborted while paused at a gate', () => {
  it('keeps the gate across the abort and resumes waiting on it, not re-running the stage', async () => {
    const graph = gatedGraph()
    const run = await loadGraphRun(graph)
    await run.start()
    // Stage 01's slots finish (what onStageSlotCompleted reports), then the
    // hand-off stops on the gate.
    run.dag.slotFinished(0, 'fe', 'front done')
    run.dag.slotFinished(0, 'be', 'back done')
    await run.api.onPipelineNext()
    await flush()
    expect(run.dag.awaitingGate.value?.gateId).toBe('gate')

    // Abort through the real handler.
    const { code: abortCode } = await transformWithEsbuild(`${abortSource}\nreturn { onPipelineAbort }`, 'AppAbort.ts', { loader: 'ts' })
    const abortDeps: Record<string, unknown> = {
      pipeline: run.pipeline,
      pipelineLog: () => {},
      tearDownPipelineOrchestration: () => { run.pipeline.state = 'aborted' },
      pipelineDag: run.dag,
      sendQuiet: async () => null,
      applyProjectPaths: () => {},
      onWorkspaceCheck: async () => {},
    }
    await (new Function(...Object.keys(abortDeps), abortCode)(...Object.values(abortDeps)) as { onPipelineAbort: () => Promise<void> }).onPipelineAbort()
    await flush()
    const persisted = run.sent.filter((s) => s.type === 'pipeline.node_states').at(-1)!.payload
    expect((persisted.gate as { gateId?: string }).gateId).toBe('gate')

    // What the backend would hand back on the next workspace check.
    const info = {
      taskDescription: 'ship', nextStageIndex: 0, stagesCompleted: 0, totalStages: 2,
      workspacePath: '/ws', pipelineId: 'pl-1',
      nodeGate: persisted.gate, nodeStates: persisted.nodes,
    }
    const { code: resumeCode } = await transformWithEsbuild(`${resumeSource}\nreturn { runPipelineResume }`, 'AppResume.ts', { loader: 'ts' })
    const activated: number[] = []
    const resumeDeps: Record<string, unknown> = {
      existingProject: { value: info },
      pipelinesApi: { activePipelineId: { value: 'pl-1' }, setActivePipeline: vi.fn(), error: { value: '' } },
      stagesApi: { stages: { value: STAGES }, refresh: vi.fn(), error: { value: '' } },
      pipeline: run.pipeline,
      pipelineRunWorkspace: '',
      pipelineDag: run.dag,
      deriveGlobalManager: () => null,
      pipelineLog: () => {},
      sendQuiet: async () => ({}),
      applyProjectPaths: () => {},
      panes: { value: [] },
      realizeRestoredPane: async () => {},
      activateStage: async (i: number) => { activated.push(i) },
      startGlobalManagerRouter: () => {},
    }
    await (new Function(...Object.keys(resumeDeps), resumeCode)(...Object.values(resumeDeps)) as { runPipelineResume: () => Promise<void> }).runPipelineResume()
    await flush()
    expect(run.pipeline.state).toBe('running')
    expect(activated).toEqual([])
    expect(run.dag.awaitingGate.value?.gateId).toBe('gate')
    expect(run.pipeline.stageIndex).toBe(0)
    // The stage before the gate keeps its finished state, not 'skipped'.
    expect(run.dag.nodeStates.value['n-01-0'].status).toBe('done')
    expect(run.dag.nodeStates.value['n-01-0'].summary).toBe('front done')
    // Passing it now carries on into stage 02.
    expect(await run.api.onPipelineGateApprove('gate')).toBe(true)
    await flush()
    expect(run.pipeline.stageIndex).toBe(1)
  })
})

// ── Gates the run reaches before its first stage ────────────────────────────

describe('a run that starts behind a gate', () => {
  it('restarting AT a gate waits on it before the stage after it runs', async () => {
    const run = await loadGraphRun(gatedGraph())
    await run.start({ fromNodeId: 'gate' })
    expect(run.pipeline.state).toBe('running')
    expect(run.dag.awaitingGate.value?.gateId).toBe('gate')
    // Review must not have been kicked off before the gate is decided.
    expect(run.events.some((e) => e.startsWith('inject') && e.includes('review'))).toBe(false)
    expect(run.events.some((e) => e.startsWith('send pipeline.start') && e.includes('"start_index":1'))).toBe(true)
    expect(await run.api.onPipelineGateApprove('gate')).toBe(true)
    await flush()
    expect(run.pipeline.stageIndex).toBe(1)
    expect(run.events.some((e) => e.startsWith('spawn 02/rv') || (e.startsWith('inject') && e.includes('review')))).toBe(true)
  })

  it('restarting at a gate after the last stage waits on it, then completes', async () => {
    const graph = applyGraphOps(deriveGraphFromStages(STAGES as unknown as StageDef[]), [
      { op: 'add_node', node: { id: 'tail', kind: 'gate', label: 'Ship?', position: { x: 0, y: 0 } }, after: ['n-02-0'] },
    ])
    const run = await loadGraphRun(graph)
    await run.start({ fromNodeId: 'tail' })
    expect(run.pipeline.state).toBe('running')
    expect(run.dag.awaitingGate.value?.gateId).toBe('tail')
    expect(await run.api.onPipelineGateApprove('tail')).toBe(true)
    await flush()
    expect(run.pipeline.state).toBe('completed')
    expect(run.events.some((e) => e.startsWith('send pipeline.complete'))).toBe(true)
  })

  it('a gate right after the trigger holds a fresh start before stage 01', async () => {
    const graph = applyGraphOps(deriveGraphFromStages(STAGES as unknown as StageDef[]), [
      { op: 'add_node', node: { id: 'head', kind: 'gate', label: 'Go?', position: { x: 0, y: 0 } }, after: ['trigger'], before: ['n-01-0', 'n-01-1'] },
    ])
    const run = await loadGraphRun(graph)
    await run.start()
    expect(run.dag.awaitingGate.value?.gateId).toBe('head')
    expect(run.events.some((e) => e.startsWith('spawn 01/'))).toBe(false)
    expect(await run.api.onPipelineGateApprove('head')).toBe(true)
    await flush()
    expect(run.pipeline.stageIndex).toBe(0)
    expect(run.events.some((e) => e.startsWith('spawn 01/fe'))).toBe(true)
  })
})

const restartSource = block(
  'async function onPipelineRestart(payload: { task: string; workspacePath: string; fromNodeId?: string }): Promise<void> {',
  '\n/** Serializes resumes.',
)

describe('restart from a node', () => {
  it('a node id that is not in the pipeline is refused before any pane is closed', async () => {
    const { code } = await transformWithEsbuild(`${restartSource}\nreturn { onPipelineRestart }`, 'AppRestart.ts', { loader: 'ts' })
    const dag = usePipelineDag({
      send: async (type) => (type === 'pipelines.graph.get' ? { derived: false, graph: gatedGraph() } : {}),
      log: () => {},
      workspacePath: () => '/ws',
    })
    const onKill = vi.fn()
    const onPipelineStart = vi.fn()
    const log: string[] = []
    const deps: Record<string, unknown> = {
      cancelAllWatchers: vi.fn(),
      stageCompletions: new Map(),
      activeQuestion: { value: null },
      panes: { value: [{ id: 'p1', origin: 'pipeline' }] },
      onKill,
      pipelineLog: (l: string) => log.push(l),
      onPipelineStart,
      pipelineDag: dag,
      pipelinesApi: { activePipelineId: { value: 'pl-1' } },
      stagesApi: { stages: { value: STAGES } },
    }
    const api = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
      onPipelineRestart: (p: { task: string; workspacePath: string; fromNodeId?: string }) => Promise<void>
    }
    await api.onPipelineRestart({ task: 'ship', workspacePath: '/ws', fromNodeId: 'typo' })
    expect(onKill).not.toHaveBeenCalled()
    expect(onPipelineStart).not.toHaveBeenCalled()
    expect(log.some((l) => l.includes('typo'))).toBe(true)
    // A real node still restarts.
    await api.onPipelineRestart({ task: 'ship', workspacePath: '/ws', fromNodeId: 'gate' })
    expect(onKill).toHaveBeenCalledTimes(1)
    expect(onPipelineStart).toHaveBeenCalledTimes(1)
  })
})
