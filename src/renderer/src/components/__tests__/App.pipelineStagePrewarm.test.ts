// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { MAX_KICKOFF_ATTEMPTS, runPipelineKickoff } from '../../lib/cliCoordination'
import { linearPipelineDag } from './pipelineDagTestStub'

// A pipeline used to pre-spawn EVERY stage the moment Start was pressed, so an
// N-stage run held N×M CLIs at once and paid the ~190MB-per-claude floor for
// stages nobody had reached. The run now warms one stage ahead: stage 01 at
// start, and stage i+1 only once stage i is running.
//
// App.vue mounts backend/terminal/onboarding lifecycles, so it cannot be
// mounted here (same reasoning as App.pipelineActions.test.ts). "Only stage 01
// spawned" is a claim about what RAN, not about what the source says, so the
// functions are lifted out of App.vue, compiled, and executed against stubs.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const preSpawnSource = block(
  'async function preSpawnStage(index: number): Promise<void> {',
  '\n/** Build cross-stage context',
)

const startSource = block(
  'async function onPipelineStart(payload: { task: string; workspacePath: string; pipelineId?: string',
  '\n/** Before firing 🎉',
)

const prewarmSource = block(
  'const stagePrewarms = new Map<number, Promise<void>>()',
  '\n/** Spawn all slots for one stage WITHOUT injecting kickoffs.',
)

const activateSource = block(
  'async function activateStage(index: number): Promise<void> {',
  '\nasync function spawnPipelineStage(',
)

interface Slot {
  label: string
  agentKey: string
  roleKey: string
}
interface Stage {
  id: string
  title: string
  slots: Slot[]
  allowQuestions?: boolean
  docQuery?: string
}

/** Three stages of two slots each — the shape the whole point is about: the
 *  old code held 6 CLIs, the new one never holds more than 4. */
function stages(count = 3, slotsPerStage = 2): Stage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `S${i + 1}`,
    title: `Stage ${i + 1}`,
    slots: Array.from({ length: slotsPerStage }, (_, s) => ({
      label: `slot${s + 1}`,
      agentKey: 'claude',
      roleKey: 'dev',
    })),
  }))
}

type SpawnCall = { stageId: string; slotLabel: string }

// ── Start: stage 01 and nothing else ────────────────────────────────────────

/** onPipelineStart plus the REAL preSpawnStage, with activateStage stubbed out.
 *  Stubbing activation is what isolates the question: everything stage 02 and
 *  later gets is warmed from inside activateStage (covered below), so whatever
 *  spawns here is what Start itself decided to spawn. */
async function loadStart(over: { stageCount?: number } = {}) {
  const { code } = await transformWithEsbuild(
    `${preSpawnSource}\n${startSource}\nreturn { onPipelineStart, preSpawnStage }`,
    'AppPipelineStart.ts',
    { loader: 'ts' },
  )
  const spawned: SpawnCall[] = []
  const stageList = stages(over.stageCount ?? 3)
  const pipeline = {
    state: 'idle' as string,
    workspacePath: '',
    task: '',
    stageIndex: -1,
    globalManager: null as unknown,
    log: [] as string[],
  }
  const activateStage = vi.fn(async (_index: number) => {})
  const factory = new Function(
    'pipeline',
    'pipelinesApi',
    'stagesApi',
    'panes',
    'stageCompletions',
    'currentRunGroupId',
    'existingProject',
    'pipelineRunWorkspace',
    'registerStage',
    'releaseStageSlot',
    'pipelineLog',
    'pipelineRunGroupName',
    'createRunGroup',
    'deriveGlobalManager',
    'applyProjectPaths',
    'sendQuiet',
    'spawnPane',
    'activateStage',
    'startGlobalManagerRouter',
    'pipelineDag',
    code,
  )
  const api = factory(
    pipeline,
    { activePipelineId: { value: 'pl-1' }, setActivePipeline: vi.fn(), error: { value: '' } },
    { isLoaded: { value: true }, stages: { value: stageList }, refresh: vi.fn(), error: { value: '' } },
    { value: [] as unknown[] },
    new Map(),
    { value: 'rg-1' },
    { value: null },
    '',
    vi.fn(),
    vi.fn(),
    (line: string) => pipeline.log.push(line),
    () => 'Pipeline',
    vi.fn(),
    () => null,
    vi.fn(),
    vi.fn(async () => null),
    vi.fn(async (opts: { stageId: string; slotLabel: string }) => {
      spawned.push({ stageId: opts.stageId, slotLabel: opts.slotLabel })
      return `pane-${spawned.length}`
    }),
    activateStage,
    vi.fn(),
    linearPipelineDag().dag,
  )
  return { api, spawned, stageList, pipeline, activateStage }
}

describe('pressing Start pre-spawns stage 01 only', () => {
  it('spawns the first stage\'s slots and no later stage\'s', async () => {
    const { api, spawned, activateStage } = await loadStart()
    await api.onPipelineStart({ task: 'ship it', workspacePath: '/tmp/ws' })
    // Two slots, both in stage 01. The old code spawned all six here.
    expect(spawned).toEqual([
      { stageId: 'S1', slotLabel: 'slot1' },
      { stageId: 'S1', slotLabel: 'slot2' },
    ])
    expect(spawned.some((s) => s.stageId === 'S2')).toBe(false)
    expect(spawned.some((s) => s.stageId === 'S3')).toBe(false)
    // …and the run really did start, so the assertion above is not just an
    // early return that spawned nothing.
    expect(activateStage.mock.calls).toEqual([[0]])
  })

  it('still spawns the whole of stage 01, not one slot of it', async () => {
    // The look-ahead is per STAGE. A regression that warmed slot-by-slot would
    // leave stage 01 short a worker and the stage waiting on N/N forever.
    const { api, spawned } = await loadStart({ stageCount: 1 })
    await api.onPipelineStart({ task: 'ship it', workspacePath: '/tmp/ws' })
    expect(spawned).toHaveLength(2)
  })
})

// ── Look-ahead: activateStage warms exactly one stage ahead ─────────────────

/** The prewarm bookkeeping plus the REAL activateStage, with preSpawnStage
 *  stubbed so the pre-warms it triggers can be counted (and deferred). */
async function loadActivate(over: { stageCount?: number } = {}) {
  const { code } = await transformWithEsbuild(
    `${prewarmSource}\n${activateSource}\nreturn { activateStage, awaitStagePrewarm, prewarmNextStage }`,
    'AppPipelineActivate.ts',
    { loader: 'ts' },
  )
  const stageList = stages(over.stageCount ?? 3)
  const prewarmed: number[] = []
  let gate: Promise<void> | null = null
  const preSpawnStage = vi.fn(async (index: number) => {
    prewarmed.push(index)
    if (gate) await gate
  })
  const pipeline = { state: 'running' as string, workspacePath: '/tmp/ws', task: 'ship it', log: [] as string[] }
  // Every slot already has a live, role-injected pane, which is the state a
  // pre-spawn leaves behind — so activateStage takes its normal path rather
  // than the never-pre-spawned fallback.
  const panes = {
    value: stageList.flatMap((stage) =>
      stage.slots.map((slot, i) => ({
        id: `${stage.id}-${i}`,
        stageId: stage.id,
        slotLabel: slot.label,
        origin: 'pipeline',
        realized: true,
        roleKey: slot.roleKey,
        injectionStatus: 'sent',
        kickoffStatus: 'none',
        sessionMarker: 'm',
      })),
    ),
  }
  const factory = new Function(
    'pipeline',
    'stagesApi',
    'panes',
    'paneRefs',
    'stageCompletions',
    'currentRunGroupId',
    'preSpawnStage',
    'pipelineLog',
    'fetchDocPrefix',
    'stageCommanderSlot',
    'buildStageContext',
    'renderSlotKickoff',
    'sessionMarkerLine',
    'registerStage',
    'releaseStageSlot',
    'persistPaneMuted',
    'onKill',
    'paneAlive',
    'injectPane',
    'syncViews',
    'sendQuiet',
    'applyProjectPaths',
    'startStageWatcher',
    'startRouterPoll',
    'ensureStageRouter',
    'armRouterCursors',
    'rolesApi',
    'sleep',
    'waitForActivityThenSettle',
    'agentSpecs',
    'roleLabel',
    'ROLE_STANDBY_SUFFIX',
    'runPipelineKickoff',
    'MAX_KICKOFF_ATTEMPTS',
    'pipelineDag',
    code,
  )
  const api = factory(
    pipeline,
    { stages: { value: stageList } },
    panes,
    {},
    new Map(),
    { value: 'rg-1' },
    preSpawnStage,
    (line: string) => pipeline.log.push(line),
    async () => '',
    // No commander, so the Manager router wiring stays out of the way.
    () => null,
    () => '',
    () => 'kickoff',
    () => '',
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    () => true,
    vi.fn(async () => true),
    vi.fn(),
    vi.fn(async () => null),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
    { find: () => null },
    vi.fn(async () => {}),
    vi.fn(async () => 'settled'),
    [],
    () => '',
    '',
    runPipelineKickoff,
    MAX_KICKOFF_ATTEMPTS,
    linearPipelineDag().dag,
  )
  return {
    api,
    prewarmed,
    pipeline,
    preSpawnStage,
    /** Make every pre-spawn from here on hang until the returned resolver runs. */
    deferPreSpawn: () => {
      let resolve = (): void => {}
      gate = new Promise<void>((r) => { resolve = r })
      return () => { gate = null; resolve() }
    },
  }
}

describe('activating a stage warms the next one', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('pre-warms stage 02 once stage 01 is running', async () => {
    const { api, prewarmed } = await loadActivate()
    await api.activateStage(0)
    // Exactly one stage ahead: warming two would put the peak back up.
    expect(prewarmed).toEqual([1])
  })

  it('warms the stage after this one, not the same one again', async () => {
    const { api, prewarmed } = await loadActivate()
    await api.activateStage(1)
    expect(prewarmed).toEqual([2])
  })

  it('does not warm past the end of the pipeline on the final stage', async () => {
    // index + 1 === stages.length. A missing bounds check here either throws
    // out of the fire-and-forget promise (an unhandled rejection with no caller)
    // or registers a pre-warm for a stage that does not exist.
    const { api, prewarmed } = await loadActivate()
    await expect(api.activateStage(2)).resolves.toBeUndefined()
    expect(prewarmed).toEqual([])
  })

  it('does not start a second pre-warm for a stage already warming', async () => {
    // activateStage can be reached twice for the same index (a stage whose
    // slots release and re-register), and the second call must join the
    // in-flight warm rather than spawn its CLIs again.
    const { api, prewarmed } = await loadActivate()
    api.prewarmNextStage(0)
    api.prewarmNextStage(0)
    expect(prewarmed).toEqual([1])
  })

  it('waits for an in-flight pre-warm before reading the stage\'s panes', async () => {
    // The hand-off can beat the pre-warm: a fast stage reaches activateStage(i)
    // while stage i is still booting. Without the await, every slot reads as
    // never-pre-spawned and the stage is spawned a second time.
    const { api, deferPreSpawn } = await loadActivate()
    const release = deferPreSpawn()
    await api.activateStage(0)
    let settled = false
    const pending = api.activateStage(1).then(() => { settled = true })
    // Drains every microtask, so an activateStage that did NOT wait would have
    // run to completion by here.
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toBe(false)
    release()
    await pending
    expect(settled).toBe(true)
  })
})
