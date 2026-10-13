// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import {
  cliPermissionKey,
  parseCliPermissionMode,
  skipPermissionFlagFor,
} from '../../platform/plugin-shell/lib/cliPermission'

// App.vue mounts backend/terminal/onboarding lifecycles, so it isn't practical
// to mount it here (same reasoning as App.spawnAdvisories.test.ts /
// App.interruptCommand.test.ts). But `ok: true` on a pipeline that never
// actually spawned a stage is precisely the failure these actions exist to
// prevent, so asserting the source text is not enough: the two registrations
// are lifted out of App.vue, compiled, and RUN against stubs, which lets the
// tests below assert that onPipelineStart / onPipelineAbort / onPipelineNext /
// onPipelineResume / onPipelineReset / onPipelineRestart — the very functions
// ControlPane's buttons emit into — are the ones that get called.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const actionsSource = block(
  "registerCommand('ui.pipeline.start', async (args) => {",
  "\nregisterCommand('ui.workspace.open'",
)

// The permission-bypass toggle is a window-wide setting, not pipeline state,
// so it is registered with the other ui.settings.* actions and lifted out on
// its own.
const yoloSource = block(
  "registerCommand('ui.settings.yolo', (args) => {",
  "\nregisterCommand('ui.pane.create'",
)

type PipelineState = 'idle' | 'running' | 'completed' | 'aborted'
type StartPayload = { task: string; workspacePath: string; pipelineId?: string }
type Handler = (args?: unknown) => unknown

interface ExistingRun {
  taskDescription: string
  nextStageIndex: number
  stagesCompleted: number
  totalStages: number
}

interface Stubs {
  currentWorkspace: { value: string }
  pipeline: { state: PipelineState; workspacePath: string; task: string; stageIndex: number }
  pipelinesApi: { activePipelineId: { value: string } }
  stagesApi: { stages: { value: unknown[] } }
  existingProject: { value: ExistingRun | null }
  onPipelineStart: ReturnType<typeof vi.fn>
  onPipelineAbort: ReturnType<typeof vi.fn>
  onPipelineNext: ReturnType<typeof vi.fn>
  onPipelineResume: ReturnType<typeof vi.fn>
  onPipelineReset: ReturnType<typeof vi.fn>
  onPipelineRestart: ReturnType<typeof vi.fn>
}

interface StubOverrides {
  state?: PipelineState
  workspace?: string
  activePipelineId?: string
  stages?: number
  stageIndex?: number
  existingProject?: ExistingRun | null
}

function makeStubs(overrides: StubOverrides = {}): Stubs {
  const pipeline = {
    state: overrides.state ?? ('idle' as PipelineState),
    workspacePath: '',
    task: '',
    stageIndex: overrides.stageIndex ?? -1,
  }
  const existingProject = { value: overrides.existingProject ?? null }
  return {
    currentWorkspace: { value: overrides.workspace ?? '/tmp/ws' },
    pipeline,
    pipelinesApi: { activePipelineId: { value: overrides.activePipelineId ?? 'pl-active' } },
    stagesApi: { stages: { value: new Array(overrides.stages ?? 3).fill({}) } },
    existingProject,
    // The real onPipelineStart is what moves the run to 'running'; a stub that
    // did not would make every success path unreachable. Same for the four
    // below: each one reproduces the state move its real counterpart makes, so
    // a test that wants the soft-exit case has to opt into it explicitly.
    onPipelineStart: vi.fn(async (payload: StartPayload) => {
      pipeline.state = 'running'
      pipeline.workspacePath = payload.workspacePath
      pipeline.task = payload.task
      pipeline.stageIndex = 0
    }),
    onPipelineAbort: vi.fn(async () => {
      pipeline.state = 'aborted'
    }),
    onPipelineNext: vi.fn(async () => {
      pipeline.stageIndex += 1
    }),
    onPipelineResume: vi.fn(async () => {
      if (!existingProject.value) return
      pipeline.state = 'running'
      pipeline.stageIndex = existingProject.value.nextStageIndex
      pipeline.task = existingProject.value.taskDescription
      pipeline.workspacePath = '/tmp/ws'
    }),
    onPipelineReset: vi.fn(async () => {
      pipeline.state = 'idle'
      pipeline.stageIndex = -1
      pipeline.task = ''
    }),
    onPipelineRestart: vi.fn(async (payload: StartPayload) => {
      pipeline.state = 'running'
      pipeline.workspacePath = payload.workspacePath
      pipeline.task = payload.task
      pipeline.stageIndex = 0
    }),
  }
}

/** Compile the pipeline registrations out of App.vue and collect their
 *  handlers. */
async function loadActions(stubs: Stubs): Promise<Record<string, Handler>> {
  const { code } = await transformWithEsbuild(actionsSource, 'AppPipelineActions.ts', { loader: 'ts' })
  const handlers: Record<string, Handler> = {}
  const factory = new Function(
    'registerCommand',
    'currentWorkspace',
    'pipeline',
    'pipelinesApi',
    'stagesApi',
    'existingProject',
    'onPipelineStart',
    'onPipelineAbort',
    'onPipelineNext',
    'onPipelineResume',
    'onPipelineReset',
    'onPipelineRestart',
    'pipelineDag',
    'onPipelineGateApprove',
    'onPipelineGateReject',
    code,
  )
  factory(
    (id: string, fn: Handler) => { handlers[id] = fn },
    stubs.currentWorkspace,
    stubs.pipeline,
    stubs.pipelinesApi,
    stubs.stagesApi,
    stubs.existingProject,
    stubs.onPipelineStart,
    stubs.onPipelineAbort,
    stubs.onPipelineNext,
    stubs.onPipelineResume,
    stubs.onPipelineReset,
    stubs.onPipelineRestart,
    // Not waiting on a gate: the DAG actions are covered by
    // App.pipelineLinearRegression.test.ts; these tests are about the rest.
    { awaitingGate: { value: null } },
    vi.fn(async () => true),
    vi.fn(async () => true),
  )
  return handlers
}

/** A run recorded on disk, as ControlPane's Resume banner sees it. */
function recordedRun(over: Partial<ExistingRun> = {}): ExistingRun {
  return {
    taskDescription: 'the recorded task',
    nextStageIndex: 2,
    stagesCompleted: 2,
    totalStages: 3,
    ...over,
  }
}

describe('pipeline UI action registration', () => {
  it('registers every pipeline control on the action bus', async () => {
    const handlers = await loadActions(makeStubs())
    expect(Object.keys(handlers).sort()).toEqual([
      'ui.pipeline.abort',
      'ui.pipeline.gate_pass',
      'ui.pipeline.gate_reject',
      'ui.pipeline.next',
      'ui.pipeline.reset',
      'ui.pipeline.restart',
      'ui.pipeline.restart_from',
      'ui.pipeline.resume',
      'ui.pipeline.start',
    ])
  })

  it('keeps the ui. prefix every bus action needs', async () => {
    const handlers = await loadActions(makeStubs())
    for (const id of Object.keys(handlers)) expect(id.startsWith('ui.')).toBe(true)
  })

  it('sits in the external UI action bus block, not somewhere else in the file', () => {
    const busStart = appSource.indexOf('── External UI action bus (MCP-driven) ──')
    const busEnd = appSource.indexOf('interface UiActionSnapshotPane', busStart)
    expect(busStart).toBeGreaterThan(-1)
    for (const action of [
      'ui.pipeline.start',
      'ui.pipeline.abort',
      'ui.pipeline.next',
      'ui.pipeline.resume',
      'ui.pipeline.reset',
      'ui.pipeline.restart',
      'ui.settings.yolo',
    ]) {
      const idx = appSource.indexOf(`registerCommand('${action}'`)
      expect(idx, `${action} should be registered`).toBeGreaterThan(busStart)
      expect(idx, `${action} should sit inside the bus block`).toBeLessThan(busEnd)
    }
  })
})

describe('ui.pipeline.start', () => {
  it('drives onPipelineStart — the same handler ControlPane emits pipeline-start into', async () => {
    const stubs = makeStubs({ stages: 4 })
    const handlers = await loadActions(stubs)
    const result = await handlers['ui.pipeline.start']({ pipelineId: 'pl-7', task: 'ship it' })
    expect(stubs.onPipelineStart).toHaveBeenCalledTimes(1)
    expect(stubs.onPipelineStart).toHaveBeenCalledWith({
      task: 'ship it',
      workspacePath: '/tmp/ws',
      pipelineId: 'pl-7',
    })
    expect(result).toEqual({
      pipelineId: 'pl-active',
      stages: 4,
      workspacePath: '/tmp/ws',
      state: 'running',
    })
  })

  it('falls back to the active pipeline when pipelineId is omitted', async () => {
    const stubs = makeStubs({ activePipelineId: 'pl-current' })
    const handlers = await loadActions(stubs)
    await handlers['ui.pipeline.start']({ task: 'go' })
    expect(stubs.onPipelineStart).toHaveBeenCalledWith({
      task: 'go',
      workspacePath: '/tmp/ws',
      pipelineId: 'pl-current',
    })
  })

  it('defaults task to an empty string when none was given', async () => {
    const stubs = makeStubs()
    const handlers = await loadActions(stubs)
    await handlers['ui.pipeline.start'](undefined)
    expect(stubs.onPipelineStart).toHaveBeenCalledWith({
      task: '',
      workspacePath: '/tmp/ws',
      pipelineId: 'pl-active',
    })
  })

  it('refuses a second run while one is already running, without touching the first', async () => {
    const stubs = makeStubs({ state: 'running' })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.start']({ task: 'again' })).rejects.toThrow(
      /already running/,
    )
    expect(stubs.onPipelineStart).not.toHaveBeenCalled()
  })

  it('refuses when the window has no open workspace', async () => {
    const stubs = makeStubs({ workspace: '' })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.start']({})).rejects.toThrow(/open workspace/)
    expect(stubs.onPipelineStart).not.toHaveBeenCalled()
  })

  it('refuses when no pipeline is active and none was named', async () => {
    const stubs = makeStubs({ activePipelineId: '' })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.start']({})).rejects.toThrow(/requires a pipelineId/)
    expect(stubs.onPipelineStart).not.toHaveBeenCalled()
  })

  it('reports failure when onPipelineStart bails softly instead of starting', async () => {
    // onPipelineStart logs and returns on its own refusals (stages not loaded,
    // pipeline switch failed, every stage-01 slot failing to spawn). Answering
    // ok there is the "started but nothing happened" reply this action exists
    // to avoid.
    const stubs = makeStubs()
    stubs.onPipelineStart.mockImplementation(async () => { /* logs and returns */ })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.start']({ task: 'x' })).rejects.toThrow(/did not start/)
    expect(stubs.onPipelineStart).toHaveBeenCalledTimes(1)
  })
})

describe('ui.pipeline.abort', () => {
  it('drives onPipelineAbort — the same handler ControlPane emits pipeline-abort into', async () => {
    const stubs = makeStubs({ state: 'running' })
    stubs.pipeline.workspacePath = '/tmp/ws'
    const handlers = await loadActions(stubs)
    const result = await handlers['ui.pipeline.abort']()
    expect(stubs.onPipelineAbort).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ workspacePath: '/tmp/ws', state: 'aborted' })
  })

  it('refuses when no run is in progress', async () => {
    const stubs = makeStubs({ state: 'idle' })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.abort']()).rejects.toThrow(/no pipeline is running/)
    expect(stubs.onPipelineAbort).not.toHaveBeenCalled()
  })

  it('refuses on an already-aborted run rather than aborting it twice', async () => {
    const stubs = makeStubs({ state: 'aborted' })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.abort']()).rejects.toThrow(/state "aborted"/)
    expect(stubs.onPipelineAbort).not.toHaveBeenCalled()
  })
})

describe('ui.pipeline.next', () => {
  it('drives onPipelineNext — the same handler ControlPane emits pipeline-next into', async () => {
    const stubs = makeStubs({ state: 'running', stageIndex: 0, stages: 3 })
    stubs.pipeline.workspacePath = '/tmp/ws'
    const handlers = await loadActions(stubs)
    const result = await handlers['ui.pipeline.next']()
    expect(stubs.onPipelineNext).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      workspacePath: '/tmp/ws',
      state: 'running',
      stageIndex: 1,
      stages: 3,
    })
  })

  it('refuses when no run is in progress', async () => {
    const stubs = makeStubs({ state: 'idle', stageIndex: 0 })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.next']()).rejects.toThrow(/no pipeline is running/)
    expect(stubs.onPipelineNext).not.toHaveBeenCalled()
  })

  it('refuses on the final stage, where onPipelineNext completes the run instead of advancing', async () => {
    // ControlPane's Next button is disabled here too (pipelineNextStage is
    // null). Advancing past the last stage is the COMPLETION path, and a
    // caller that asked to step forward must not get a finished run instead.
    const stubs = makeStubs({ state: 'running', stageIndex: 2, stages: 3 })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.next']()).rejects.toThrow(/is the last one/)
    expect(stubs.onPipelineNext).not.toHaveBeenCalled()
  })

  it('reports failure when onPipelineNext bails softly instead of advancing', async () => {
    // onPipelineNext returns silently when the run stopped being 'running'
    // under it (an abort landing during the settle wait). The stage index is
    // where it was, and that must not read as ok.
    const stubs = makeStubs({ state: 'running', stageIndex: 0, stages: 3 })
    stubs.onPipelineNext.mockImplementation(async () => { /* logs and returns */ })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.next']()).rejects.toThrow(/did not advance/)
    expect(stubs.onPipelineNext).toHaveBeenCalledTimes(1)
  })
})

describe('ui.pipeline.resume', () => {
  it('drives onPipelineResume — the same handler ControlPane emits pipeline-resume into', async () => {
    const stubs = makeStubs({ state: 'aborted', stages: 3, existingProject: recordedRun() })
    const handlers = await loadActions(stubs)
    const result = await handlers['ui.pipeline.resume']()
    expect(stubs.onPipelineResume).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      workspacePath: '/tmp/ws',
      state: 'running',
      stageIndex: 2,
      stages: 3,
    })
  })

  it('refuses when the window has no open workspace', async () => {
    const stubs = makeStubs({ workspace: '', existingProject: recordedRun() })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.resume']()).rejects.toThrow(/open workspace/)
    expect(stubs.onPipelineResume).not.toHaveBeenCalled()
  })

  it('refuses while a run is already in progress rather than resuming over it', async () => {
    const stubs = makeStubs({ state: 'running', existingProject: recordedRun() })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.resume']()).rejects.toThrow(/already running/)
    expect(stubs.onPipelineResume).not.toHaveBeenCalled()
  })

  it('refuses when this workspace has no recorded run', async () => {
    const stubs = makeStubs({ state: 'idle', existingProject: null })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.resume']()).rejects.toThrow(/no recorded run/)
    expect(stubs.onPipelineResume).not.toHaveBeenCalled()
  })

  it('refuses when the recorded run has no stage left to resume', async () => {
    const stubs = makeStubs({
      state: 'completed',
      existingProject: recordedRun({ nextStageIndex: -1, stagesCompleted: 3 }),
    })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.resume']()).rejects.toThrow(/no stage left/)
    expect(stubs.onPipelineResume).not.toHaveBeenCalled()
  })

  it('reports failure when onPipelineResume bails softly instead of resuming', async () => {
    // Its soft refusals — the run's pipeline could not be made active, its
    // stages failed to load — leave the state short of 'running'.
    const stubs = makeStubs({ state: 'aborted', existingProject: recordedRun() })
    stubs.onPipelineResume.mockImplementation(async () => { /* logs and returns */ })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.resume']()).rejects.toThrow(/did not resume/)
    expect(stubs.onPipelineResume).toHaveBeenCalledTimes(1)
  })
})

describe('ui.pipeline.reset', () => {
  it('drives onPipelineReset — the same handler ControlPane emits pipeline-reset into', async () => {
    const stubs = makeStubs({ state: 'running', stageIndex: 1 })
    const handlers = await loadActions(stubs)
    const result = await handlers['ui.pipeline.reset']()
    // No pane ids: the button passes none either, and a list would narrow the
    // teardown to a subset of the panes reset exists to clear.
    expect(stubs.onPipelineReset.mock.calls).toEqual([[]])
    expect(result).toEqual({ workspacePath: '/tmp/ws', state: 'idle', stageIndex: -1 })
  })

  it('refuses when the window has no open workspace', async () => {
    const stubs = makeStubs({ state: 'running', workspace: '' })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.reset']()).rejects.toThrow(/open workspace/)
    expect(stubs.onPipelineReset).not.toHaveBeenCalled()
  })

  it('reports failure when onPipelineReset leaves the run uncleared', async () => {
    const stubs = makeStubs({ state: 'running', stageIndex: 1 })
    stubs.onPipelineReset.mockImplementation(async () => { /* cleared nothing */ })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.reset']()).rejects.toThrow(/was not cleared/)
    expect(stubs.onPipelineReset).toHaveBeenCalledTimes(1)
  })
})

describe('ui.pipeline.restart', () => {
  it('drives onPipelineRestart — the same handler ControlPane emits pipeline-restart into', async () => {
    const stubs = makeStubs({
      state: 'aborted',
      stages: 3,
      existingProject: recordedRun({ taskDescription: 'ship it again' }),
    })
    const handlers = await loadActions(stubs)
    const result = await handlers['ui.pipeline.restart']()
    expect(stubs.onPipelineRestart).toHaveBeenCalledTimes(1)
    expect(stubs.onPipelineRestart).toHaveBeenCalledWith({
      task: 'ship it again',
      workspacePath: '/tmp/ws',
    })
    expect(result).toEqual({
      pipelineId: 'pl-active',
      stages: 3,
      workspacePath: '/tmp/ws',
      state: 'running',
      stageIndex: 0,
    })
  })

  it('falls back to the live task when no run is recorded on disk', async () => {
    const stubs = makeStubs({ state: 'aborted', existingProject: null })
    stubs.pipeline.task = 'the live task'
    const handlers = await loadActions(stubs)
    await handlers['ui.pipeline.restart']()
    expect(stubs.onPipelineRestart).toHaveBeenCalledWith({
      task: 'the live task',
      workspacePath: '/tmp/ws',
    })
  })

  it('refuses when the window has no open workspace', async () => {
    const stubs = makeStubs({ workspace: '', existingProject: recordedRun() })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.restart']()).rejects.toThrow(/open workspace/)
    expect(stubs.onPipelineRestart).not.toHaveBeenCalled()
  })

  it('refuses while a run is already in progress, without wiping its panes', async () => {
    const stubs = makeStubs({ state: 'running', existingProject: recordedRun() })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.restart']()).rejects.toThrow(/already running/)
    expect(stubs.onPipelineRestart).not.toHaveBeenCalled()
  })

  it('refuses when there is no previous task to start over from', async () => {
    const stubs = makeStubs({ state: 'idle', existingProject: null })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.restart']()).rejects.toThrow(/no previous run/)
    expect(stubs.onPipelineRestart).not.toHaveBeenCalled()
  })

  it('reports failure when onPipelineRestart bails softly instead of starting over', async () => {
    // Start over ends in onPipelineStart and inherits its soft refusals — by
    // which point the previous attempt's panes are already killed, so ok here
    // would leave the caller believing a run it destroyed is under way.
    const stubs = makeStubs({ state: 'aborted', existingProject: recordedRun() })
    stubs.onPipelineRestart.mockImplementation(async () => { /* logs and returns */ })
    const handlers = await loadActions(stubs)
    await expect(handlers['ui.pipeline.restart']()).rejects.toThrow(/did not start/)
    expect(stubs.onPipelineRestart).toHaveBeenCalledTimes(1)
  })
})

// ── ui.settings.yolo ────────────────────────────────────────────────────────
// The permission-bypass toggle reaches every spawn path in the window, not
// just pipeline ones, so it is a settings action rather than a pipeline one.

interface YoloStubs {
  yoloEnabled: { value: boolean }
  agentSpecs: { agentKey: string; skipPermissionFlag?: string }[]
  settings: Record<string, string>
  skipFlagFor: ReturnType<typeof vi.fn>
}

function makeYoloStubs(over: { yolo?: boolean; settings?: Record<string, string> } = {}): YoloStubs {
  const yoloEnabled = { value: over.yolo ?? true }
  const settings = over.settings ?? {}
  const agentSpecs = [
    { agentKey: 'claude', skipPermissionFlag: '--dangerously-skip-permissions' },
    { agentKey: 'codex', skipPermissionFlag: '--yolo' },
    // A vendor with no bypass flag at all, like grok / opencode / pi.
    { agentKey: 'grok' },
  ]
  return {
    yoloEnabled,
    agentSpecs,
    settings,
    // Mirrors App.vue's skipFlagFor: the real resolution of global toggle
    // against per-vendor override, so the reported flags are the ones a spawn
    // would actually use.
    skipFlagFor: vi.fn((agentKey: string, spec: { skipPermissionFlag?: string } | undefined) =>
      skipPermissionFlagFor({
        spec,
        globalYolo: yoloEnabled.value,
        mode: parseCliPermissionMode(settings[cliPermissionKey(agentKey)] ?? null),
      }),
    ),
  }
}

async function loadYoloAction(stubs: YoloStubs): Promise<Handler> {
  const { code } = await transformWithEsbuild(yoloSource, 'AppYoloAction.ts', { loader: 'ts' })
  const handlers: Record<string, Handler> = {}
  const factory = new Function(
    'registerCommand',
    'yoloEnabled',
    'agentSpecs',
    'parseCliPermissionMode',
    'settingsGet',
    'cliPermissionKey',
    'skipFlagFor',
    code,
  )
  factory(
    (id: string, fn: Handler) => { handlers[id] = fn },
    stubs.yoloEnabled,
    stubs.agentSpecs,
    parseCliPermissionMode,
    (key: string, fallback: unknown) => (key in stubs.settings ? stubs.settings[key] : fallback),
    cliPermissionKey,
    stubs.skipFlagFor,
  )
  return handlers['ui.settings.yolo']
}

describe('ui.settings.yolo', () => {
  it('reads the toggle without changing it when no yolo argument was given', async () => {
    const stubs = makeYoloStubs({ yolo: true })
    const yolo = await loadYoloAction(stubs)
    const result = await yolo(undefined)
    expect(stubs.yoloEnabled.value).toBe(true)
    expect(result).toEqual({
      yolo: true,
      agents: [
        { agent: 'claude', mode: 'inherit', skipFlag: '--dangerously-skip-permissions' },
        { agent: 'codex', mode: 'inherit', skipFlag: '--yolo' },
        { agent: 'grok', mode: 'inherit', skipFlag: '' },
      ],
    })
  })

  it('sets the global toggle and reports the state that follows from it', async () => {
    const stubs = makeYoloStubs({ yolo: true })
    const yolo = await loadYoloAction(stubs)
    const result = await yolo({ yolo: false })
    expect(stubs.yoloEnabled.value).toBe(false)
    expect(result).toMatchObject({
      yolo: false,
      agents: [
        { agent: 'claude', mode: 'inherit', skipFlag: '' },
        { agent: 'codex', mode: 'inherit', skipFlag: '' },
        { agent: 'grok', mode: 'inherit', skipFlag: '' },
      ],
    })
  })

  it('reports the per-vendor overrides that overrule the global toggle', async () => {
    // `yolo: true` alone would tell the caller that every CLI starts with the
    // bypass flag. force-off on one vendor and force-on on another while the
    // global is off are exactly the cases that answer would get wrong.
    const stubs = makeYoloStubs({
      yolo: false,
      settings: {
        [cliPermissionKey('claude')]: 'force-on',
        [cliPermissionKey('codex')]: 'force-off',
      },
    })
    const yolo = await loadYoloAction(stubs)
    const result = await yolo({}) as { agents: unknown[] }
    expect(result.agents).toEqual([
      { agent: 'claude', mode: 'force-on', skipFlag: '--dangerously-skip-permissions' },
      { agent: 'codex', mode: 'force-off', skipFlag: '' },
      { agent: 'grok', mode: 'inherit', skipFlag: '' },
    ])
    expect(stubs.skipFlagFor).toHaveBeenCalledTimes(3)
  })

  it('ignores a non-boolean yolo instead of casting it to one', async () => {
    const stubs = makeYoloStubs({ yolo: true })
    const yolo = await loadYoloAction(stubs)
    const result = await yolo({ yolo: 'off' })
    expect(stubs.yoloEnabled.value).toBe(true)
    expect(result).toMatchObject({ yolo: true })
  })
})
