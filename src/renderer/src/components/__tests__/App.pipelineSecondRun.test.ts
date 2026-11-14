// @vitest-environment happy-dom
// An aborted or finished run leaves its panes open, and the next run of the same
// pipeline has the same stage ids and slot labels. Looked up by those, the first
// match was the old pane: the new pane sat empty while the kickoff, webhook data
// included, went into the previous run's conversation. If the old pane was idle
// the data arrived there; if it was on a permission prompt the run failed.
//
// App.vue cannot be mounted here (see App.pipelineActions.test.ts), so the real
// functions are lifted out and run against stubs.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { MAX_KICKOFF_ATTEMPTS, runPipelineKickoff } from '../../lib/cliCoordination'
import { createRunSlotPanes } from '../../lib/runSlotPanes'
import { linearPipelineDag } from './pipelineDagTestStub'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, startMarker).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, endMarker).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const helpers = block('function runSlotPane(stageId: string', '\n/** Resolve the live pane id for the global Manager')
const globalManager = block('function globalManagerPaneId(): string | null {', '\n/** The Manager pane can still receive')
const preSpawn = block('async function preSpawnStage(index: number): Promise<void> {', '\n/** Build cross-stage context')
const activate = block(
  'async function activateStage(index: number, opts: { only?: string; note?: string } = {}): Promise<void> {',
  '\nasync function spawnPipelineStage(',
)
const failure = block('async function failRunOnKickoff(', '\n/** Approve the gate the run is paused on')

const STAGE = { id: 'L1', title: 'L1', slots: [{ label: 'Check', agentKey: 'claude', roleKey: '' }] }
const pipelinePane = (id: string) => ({
  id, stageId: 'L1', slotLabel: 'Check', origin: 'pipeline', realized: true, roleKey: '',
  injectionStatus: 'skipped', kickoffStatus: 'none', sessionMarker: 'm',
})

/** Everything the lifted code names and this test does not care about. */
const KNOWN_GLOBALS = new Set(['Promise', 'Date', 'Array', 'Map', 'Set', 'Object', 'String', 'Number', 'JSON', 'Error', 'console', 'Math', 'undefined'])

async function load(source: string, names: string, scope: Record<string, unknown>) {
  const { code } = await transformWithEsbuild(`${source}\nreturn { ${names} }`, 'AppSecondRun.ts', { loader: 'ts' })
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === 'string' && (key in target || !KNOWN_GLOBALS.has(key)),
    get: (target, key) => (key === Symbol.unscopables ? undefined : key in target ? target[key as string] : vi.fn()),
  })
  return new Function('scope', `with (scope) { return (function () {${code}})() }`)(proxy)
}

async function secondRun(oldPaneTakesText: boolean) {
  const panes = { value: [pipelinePane('old')] as ReturnType<typeof pipelinePane>[] }
  const runSlots = createRunSlotPanes()
  runSlots.record(runSlots.current(), 'L1', 'Check', 'old')
  runSlots.startRun(false)
  const typedInto: string[] = []
  const pipeline = { state: 'running', stageIndex: 0, workspacePath: '/ws', task: 'N-second', log: [] as string[], globalManager: null }
  const api = await load(`${helpers}\n${preSpawn}\n${activate}`, 'preSpawnStage, activateStage', {
    panes, runSlots, pipeline,
    stagesApi: { stages: { value: [STAGE] } },
    stageCompletions: new Map(),
    stagePrewarms: new Map(),
    currentRunGroupId: { value: 'rg' },
    paneRefs: {},
    pipelineDag: linearPipelineDag().dag,
    runPipelineKickoff,
    MAX_KICKOFF_ATTEMPTS,
    spawnPane: async () => { panes.value.push(pipelinePane('new')); return 'new' },
    injectPane: async (id: string) => { typedInto.push(id); return id === 'old' ? oldPaneTakesText : true },
    paneAlive: () => true,
    sleep: async () => {},
    sendQuiet: async () => null,
    fetchDocPrefix: async () => '',
    stageCommanderSlot: () => null,
    buildStageContext: () => '',
    renderSlotKickoff: () => 'kickoff',
    sessionMarkerLine: () => '',
    heldKickoffPanes: new Set(),
    runEndingSlots: new Set(),
    runPaneSentAt: new Map(),
    heldKickoffCopy: () => undefined,
    rolesApi: { find: () => null },
    agentSpecs: [],
    roleLabel: () => '',
    ROLE_STANDBY_SUFFIX: '',
    pipelineLog: (line: string) => pipeline.log.push(line),
  })
  return { api, panes, typedInto, pipeline, runSlots }
}

describe('a second run with the first run\'s pane still open', () => {
  it.each([
    ['stuck on a permission prompt', false],
    ['idle at its prompt', true],
  ])('the kickoff goes to the new pane when the old one is %s', async (_name, takesText) => {
    const run = await secondRun(takesText)
    await run.api.preSpawnStage(0)
    await run.api.activateStage(0)
    expect(run.typedInto).toEqual(['new'])
    expect(run.pipeline.state).toBe('running')
  })

  it('a slot with no pane in this run spawns one instead of reaching back', async () => {
    const run = await secondRun(true)
    await run.api.activateStage(0)
    expect(run.pipeline.log.join('\n')).toContain('not pre-spawned, spawning now')
    expect(run.typedInto).not.toContain('old')
  })
})

describe('the other lookups', () => {
  it('the global Manager is never a pane of the run before', async () => {
    const runSlots = createRunSlotPanes()
    runSlots.record(runSlots.current(), 'L1', 'Check', 'old')
    runSlots.startRun(false)
    const panes = { value: [pipelinePane('old')] }
    const pipeline = { globalManager: { stageId: 'L1', slotLabel: 'Check' } }
    const api = await load(`${helpers}\n${globalManager}`, 'globalManagerPaneId', { panes, runSlots, pipeline })
    expect(api.globalManagerPaneId()).toBeNull()
    runSlots.record(runSlots.current(), 'L1', 'Check', 'new')
    panes.value.push(pipelinePane('new'))
    expect(api.globalManagerPaneId()).toBe('new')
  })

  it('a slot failing down its error edge reports this run\'s pane', async () => {
    const runSlots = createRunSlotPanes()
    runSlots.record(runSlots.current(), 'L1', 'Check', 'old')
    runSlots.startRun(false)
    runSlots.record(runSlots.current(), 'L1', 'Check', 'new')
    const onStageSlotCompleted = vi.fn()
    const api = await load(`${helpers}\n${failure}`, 'failRunOnKickoff', {
      panes: { value: [pipelinePane('old'), pipelinePane('new')] }, runSlots, onStageSlotCompleted,
      pipeline: { state: 'running', stageIndex: 0 },
      stagesApi: { stages: { value: [STAGE] } },
      pipelineDag: { retryAfterFailure: () => null, routeFailure: () => true },
      runEndingSlots: new Set(),
    })
    await api.failRunOnKickoff(0, 'Check', 'no')
    expect(onStageSlotCompleted).toHaveBeenCalledWith(0, 'new', 'error-edge')
  })

  it('a failed kickoff tells the backend what failed', () => {
    expect(failure).toContain('kickoff_failed: !reported')
  })

  it('routing and sibling hand-offs leave earlier panes out', () => {
    const excluded = appSource.match(/!isPriorRunPane\(p\.id\)/g) ?? []
    // context, settle, slot signals, worker scan, DISPATCH target, sibling note
    expect(excluded).toHaveLength(6)
  })

  it('closing an old pane leaves this run\'s slot alone', () => {
    expect(appSource).toContain('if (isPriorRunPane(paneId)) stageIndex = -1')
  })

  it('no lookup by stage and slot takes the first match any more', () => {
    expect(appSource).not.toMatch(/panes\.value\.(find|some)\(\s*\(p\) => (p\.realized && )?p\.stageId === [\w.]+ && p\.slotLabel === /)
  })
})
