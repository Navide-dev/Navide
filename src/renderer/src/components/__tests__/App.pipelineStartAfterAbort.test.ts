// @vitest-environment happy-dom
// #417: after an aborted run a workspace could never start again. Start ran
// off the window's stage cache, which loads before the active pipeline id is
// known and was never refetched when it changed — so it held nothing ("0-stage",
// start skipped) or another template's stages (a 13-stage run of a 2-stage
// pipeline). Every refusal was logged only in memory, because
// pipeline.workspacePath is set once a run starts and is empty after reset or
// restart. And reset never told the backend, so the aborted run survived it.
//
// App.vue cannot be mounted here (see App.pipelineActions.test.ts), so the
// functions are lifted out, compiled and run against stubs passed by name.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { linearPipelineDag } from './pipelineDagTestStub'
import { detailsAction, startRefusalText } from '../../lib/pipelineErrors'
import { resetConfirmDialog } from '../../lib/pipelineResetConfirm'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const startSource = block(
  'async function onPipelineStart(payload: { task: string; workspacePath: string; pipelineId?: string',
  '\n/** Before firing 🎉',
)

const stage = (id: string) => ({ id, title: id, sentinel: '', slots: [{ label: 'a', agentKey: 'claude', roleKey: '' }] })
const CURRENT = [stage('storyboard'), stage('illustration')]
const STALE = Array.from({ length: 13 }, (_, i) => stage(`old-${i}`))

interface StartOpts {
  cached?: ReturnType<typeof stage>[]
  loaded?: boolean
  served?: ReturnType<typeof stage>[]
  refreshError?: string
  activePipelineId?: string
  dag?: unknown
  /** Every slot of the first stage fails to spawn (releaseStageSlot aborts). */
  spawnFails?: boolean
  /** The backend refuses pipeline.start with this error code. */
  startRefusedCode?: string
}

async function loadStart(opts: StartOpts = {}) {
  const { code } = await transformWithEsbuild(`${startSource}\nreturn onPipelineStart`, 'AppStart.ts', { loader: 'ts' })
  const pipeline = { state: 'idle', workspacePath: '', task: '', stageIndex: -1, globalManager: null as unknown, log: [] as string[] }
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  const stagesApi = {
    isLoaded: { value: opts.loaded ?? true },
    stages: { value: opts.cached ?? [] },
    error: { value: '' },
    refresh: vi.fn(async (_pid?: string) => {
      stagesApi.error.value = ''
      if (opts.refreshError) {
        stagesApi.error.value = opts.refreshError
        return
      }
      stagesApi.stages.value = opts.served ?? CURRENT
      stagesApi.isLoaded.value = true
    }),
  }
  const pipelinesApi = {
    activePipelineId: { value: opts.activePipelineId ?? 'pl-2' },
    setActivePipeline: vi.fn(async (id: string) => {
      pipelinesApi.activePipelineId.value = id
      return true
    }),
  }
  const runPipelineId = { value: '' }
  const createRunGroup = vi.fn()
  const preSpawnStage = vi.fn(async () => { if (opts.spawnFails) pipeline.state = 'aborted' })
  const deps: Record<string, unknown> = {
    pipeline,
    pipelinesApi,
    stagesApi,
    runPipelineId,
    pipelineRunWorkspace: '',
    existingProject: { value: null },
    pipelineLog: (line: string) => pipeline.log.push(line),
    pipelineRunGroupName: () => 'Pipeline',
    createRunGroup,
    deriveGlobalManager: () => null,
    applyProjectPaths: vi.fn(),
    sendQuiet: vi.fn(async (type: string, payload: Record<string, unknown>, _timeout?: number, onRefused?: (code: string) => void) => {
      sent.push({ type, payload })
      if (type === 'pipeline.start' && opts.startRefusedCode !== undefined) onRefused?.(opts.startRefusedCode)
      return null
    }),
    preSpawnStage,
    activateStage: vi.fn(async () => {}),
    startGlobalManagerRouter: vi.fn(),
    pipelineDag: opts.dag ?? linearPipelineDag(() => pipeline.workspacePath).dag,
  }
  const onPipelineStart = new Function(...Object.keys(deps), code)(...Object.values(deps)) as (
    p: { task: string; workspacePath: string; pipelineId?: string },
    report?: (r: { code: string; params?: Record<string, unknown> }) => void,
  ) => Promise<string>
  return { onPipelineStart, pipeline, sent, stagesApi, pipelinesApi, runPipelineId, createRunGroup, preSpawnStage }
}

const START = { task: 'kite story', workspacePath: '/tmp/ws', pipelineId: 'pl-2' }

describe('start reloads the stages of the pipeline it starts', () => {
  it('starts from an empty cache when the pipeline is already the active one', async () => {
    // The reporter's case: MCP pipeline_start with the active id, cache empty.
    const t = await loadStart({ cached: [], loaded: false })
    expect(await t.onPipelineStart(START)).toBe('')
    expect(t.stagesApi.refresh).toHaveBeenCalledWith('pl-2')
    expect(t.pipeline.state).toBe('running')
    const start = t.sent.find((s) => s.type === 'pipeline.start')
    expect(start?.payload).toMatchObject({ total_stages: 2, pipeline_id: 'pl-2', workspace_path: '/tmp/ws' })
  })

  it('runs the current template, not a stale cached one', async () => {
    const t = await loadStart({ cached: STALE })
    await t.onPipelineStart(START)
    const start = t.sent.find((s) => s.type === 'pipeline.start')
    expect(start?.payload.total_stages).toBe(2)
    expect((start?.payload.stage_blueprint as Array<{ stage_id: string }>).map((s) => s.stage_id)).toEqual([
      'storyboard',
      'illustration',
    ])
  })

  it('runs another pipeline without making it the default (PR-E E4)', async () => {
    const t = await loadStart({ activePipelineId: 'pl-1', cached: STALE })
    await t.onPipelineStart(START)
    expect(t.pipelinesApi.setActivePipeline).not.toHaveBeenCalled()
    expect(t.pipelinesApi.activePipelineId.value).toBe('pl-1')
    expect(t.runPipelineId.value).toBe('pl-2')
    expect(t.stagesApi.refresh).toHaveBeenCalledWith('pl-2')
    expect(t.sent.find((s) => s.type === 'pipeline.start')?.payload.pipeline_id).toBe('pl-2')
  })
})

const refusalOf = (sent: Array<{ type: string; payload: Record<string, unknown> }>) =>
  sent.find((s) => s.type === 'pipeline.start_refused')?.payload

describe('a refused start says why, durably', () => {
  const refusal = (sent: Array<{ type: string; payload: Record<string, unknown> }>) =>
    sent.find((s) => s.type === 'pipeline.start_refused')?.payload

  it('a pipeline with no stages', async () => {
    const t = await loadStart({ served: [] })
    const reason = await t.onPipelineStart(START)
    expect(reason).toMatch(/pl-2.*no stages/)
    expect(t.pipeline.state).toBe('idle')
    expect(refusal(t.sent)).toEqual({ workspace_path: '/tmp/ws', pipeline_id: 'pl-2', reason })
    expect(t.sent.some((s) => s.type === 'pipeline.start')).toBe(false)
    expect(t.pipeline.log.at(-1)).toContain(reason)
  })

  it('stages that fail to load', async () => {
    const t = await loadStart({ refreshError: 'pipeline not found: pl-2' })
    const reason = await t.onPipelineStart(START)
    expect(reason).toContain('pipeline not found: pl-2')
    expect(refusal(t.sent)?.reason).toBe(reason)
    expect(t.pipeline.state).toBe('idle')
  })

  it('another pipeline whose stages fail to load leaves the default and the run alone', async () => {
    const t = await loadStart({ activePipelineId: 'pl-1', refreshError: 'pipeline not found: pl-2' })
    const reason = await t.onPipelineStart(START)
    expect(reason).toContain('pipeline not found: pl-2')
    expect(refusal(t.sent)?.reason).toBe(reason)
    expect(t.pipelinesApi.setActivePipeline).not.toHaveBeenCalled()
    expect(t.pipelinesApi.activePipelineId.value).toBe('pl-1')
    expect(t.runPipelineId.value).toBe('')
  })

  it('a run graph that cannot be prepared, restoring the state it had', async () => {
    const dag = { begin: vi.fn(async () => null), runStack: { value: [] } }
    const t = await loadStart({ dag })
    const reason = await t.onPipelineStart(START)
    expect(reason).toMatch(/run graph/)
    expect(refusal(t.sent)?.reason).toBe(reason)
    expect(t.pipeline.state).toBe('idle')
  })
})

describe('a start the backend refuses is rolled back (PR-E E1)', () => {
  it('a run already going elsewhere: nothing spawns, the state is put back, the code is reported', async () => {
    const t = await loadStart({ startRefusedCode: 'PIPELINE_ALREADY_RUNNING' })
    const report = vi.fn()
    const reason = await t.onPipelineStart(START, report)
    expect(reason).toMatch(/already in progress/)
    expect(report).toHaveBeenCalledWith({ code: 'already-running', params: {} })
    expect(t.pipeline.state).toBe('idle')
    expect(t.pipeline.workspacePath).toBe('')
    expect(t.pipeline.stageIndex).toBe(-1)
    expect(t.runPipelineId.value).toBe('')
    expect(t.createRunGroup).not.toHaveBeenCalled()
    expect(t.preSpawnStage).not.toHaveBeenCalled()
  })

  it('any other refusal or no answer is not-recorded, rolled back the same way', async () => {
    const t = await loadStart({ startRefusedCode: '' })
    const report = vi.fn()
    await t.onPipelineStart(START, report)
    expect(report).toHaveBeenCalledWith({ code: 'not-recorded', params: {} })
    expect(t.pipeline.state).toBe('idle')
    expect(t.preSpawnStage).not.toHaveBeenCalled()
  })
})

describe('every slot of the first stage failing to spawn is a refusal (B2)', () => {
  it('says so instead of returning as if it started', async () => {
    const t = await loadStart({ spawnFails: true })
    const report = vi.fn()
    const reason = await t.onPipelineStart(START, report)
    expect(reason).toMatch(/first stage could be started/)
    expect(report).toHaveBeenCalledWith({ code: 'spawn-failed', params: {} })
    expect(refusalOf(t.sent)?.reason).toBe(reason)
  })

  it('reports the code of every other refusal too', async () => {
    const t = await loadStart({ served: [] })
    const report = vi.fn()
    await t.onPipelineStart(START, report)
    expect(report).toHaveBeenCalledWith({ code: 'no-stages', params: {} })
  })
})

describe('the Run button shows the refusal', () => {
  async function loadPanel(refusal: string, coded?: { code: string; params?: Record<string, unknown> }) {
    const src = block('async function onPipelineStartFromPanel(', '\n/** Before firing 🎉')
    const { code } = await transformWithEsbuild(`${src}\nreturn onPipelineStartFromPanel`, 'AppPanel.ts', { loader: 'ts' })
    const toast = vi.fn()
    const alert = vi.fn()
    const deps: Record<string, unknown> = {
      onPipelineStart: vi.fn(async (_p: unknown, report?: (r: unknown) => void) => {
        if (coded) report?.(coded)
        return refusal
      }),
      notifyRestore: { toast, alert },
      i18n: { global: { t: (key: string, p?: { reason?: string }) => (p?.reason ? `${key}: ${p.reason}` : key) } },
      startRefusalText,
      detailsAction,
    }
    const fn = new Function(...Object.keys(deps), code)(...Object.values(deps)) as (p: unknown) => Promise<void>
    return { fn, toast, alert }
  }

  it('toasts the refusal in the UI language, the English reason behind Details (B2)', async () => {
    const t = await loadPanel('pipeline pl-2 has no stages', { code: 'no-stages', params: {} })
    await t.fn(START)
    const [text, opts] = t.toast.mock.calls[0]
    expect(text).toBe('pipelineErrors.start.no-stages')
    expect(opts.type).toBe('error')
    opts.action.run()
    expect(t.alert).toHaveBeenCalledWith('pipeline pl-2 has no stages', { title: 'pipelineErrors.details' })
  })

  it('an uncoded refusal still names its reason', async () => {
    const t = await loadPanel('pipeline pl-2 has no stages')
    await t.fn(START)
    expect(t.toast.mock.calls[0][0]).toBe('error.pipeline-start-refused: pipeline pl-2 has no stages')
  })

  it('stays quiet when the run started', async () => {
    const t = await loadPanel('')
    await t.fn(START)
    expect(t.toast).not.toHaveBeenCalled()
  })

  it('is what the Run button emits into', () => {
    expect(appSource).toContain('@pipeline-start="onPipelineStartFromPanel"')
  })
})

describe('the sidebar Abort asks first (Pipeline UX D4)', () => {
  async function loadAbort(confirmed: boolean) {
    const src = block('async function clearStoredPipelineRun(', '\n// ─────────── Switch / close workspace')
    const { code } = await transformWithEsbuild(`${src}\nreturn { onPipelineUserAbort }`, 'AppAbort.ts', { loader: 'ts' })
    const confirm = vi.fn(async (_message: string, _opts: { title?: string; danger?: boolean }) => confirmed)
    const onPipelineAbort = vi.fn(async () => {})
    const deps: Record<string, unknown> = {
      notifyRestore: { confirm },
      i18n: { global: { t: (key: string) => key } },
      resetConfirmDialog,
      panesInView: { value: [] },
      sendQuiet: vi.fn(),
      existingProject: { value: null },
      currentWorkspace: { value: '/tmp/ws' },
      buildExistingProjectInfo: () => null,
      pipelineLog: () => {},
      onPipelineReset: vi.fn(),
      onPipelineAbort,
    }
    const api = new Function(...Object.keys(deps), code)(...Object.values(deps)) as { onPipelineUserAbort: () => Promise<void> }
    return { api, confirm, onPipelineAbort }
  }

  it('confirms before aborting, saying the run pauses and can be resumed', async () => {
    const t = await loadAbort(true)
    await t.api.onPipelineUserAbort()
    expect(t.confirm).toHaveBeenCalledTimes(1)
    const [message, opts] = t.confirm.mock.calls[0]
    expect(message).toBe('pipelineEditor.run.abort-message')
    expect(opts).toMatchObject({ title: 'pipelineEditor.run.abort-title', danger: true })
    expect(t.onPipelineAbort).toHaveBeenCalledTimes(1)
  })

  it('a cancelled confirm leaves the run going', async () => {
    const t = await loadAbort(false)
    await t.api.onPipelineUserAbort()
    expect(t.onPipelineAbort).not.toHaveBeenCalled()
  })

  it('is wired to the sidebar Abort buttons; MCP (ui.pipeline.abort without confirm) is unchanged', () => {
    expect(appSource).toContain('@pipeline-abort="onPipelineUserAbort"')
    expect(appSource).not.toContain('@pipeline-abort="onPipelineAbort"')
  })
})

describe('reset clears the stored run, and only the user reset does', () => {
  async function loadReset(resp: unknown, confirmed = true) {
    const resetSource = block('async function clearStoredPipelineRun(', '\n// ─────────── Switch / close workspace')
    const { code } = await transformWithEsbuild(
      `${resetSource}\nreturn { clearStoredPipelineRun, onPipelineUserReset, confirmPipelineReset }`,
      'AppReset.ts',
      { loader: 'ts' },
    )
    const log: string[] = []
    const existingProject = { value: { state: 'aborted' } as unknown }
    const sendQuiet = vi.fn(async () => resp)
    const onPipelineReset = vi.fn(async () => {})
    const confirm = vi.fn(async (_message: string, _opts: { detail?: string; danger?: boolean }) => confirmed)
    const deps: Record<string, unknown> = {
      notifyRestore: { confirm },
      i18n: { global: { t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key) } },
      resetConfirmDialog,
      // What onKillAll tears down: the panes of the workspace on screen.
      panesInView: { value: [
        { id: 'a', origin: 'pipeline', agentLabel: 'Claude', customName: 'Planner' },
        { id: 'b', origin: 'manual', agentLabel: 'Codex', autoName: 'my shell' },
        { id: 'c', origin: 'mcp', agentLabel: 'Gemini' },
      ] },
      sendQuiet,
      existingProject,
      currentWorkspace: { value: '/tmp/ws' },
      buildExistingProjectInfo: (p: { project?: { state: string } }) => (p?.project ? { state: p.project.state } : null),
      pipelineLog: (l: string) => log.push(l),
      onPipelineReset,
    }
    const api = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
      clearStoredPipelineRun: (ws: string) => Promise<boolean>
      onPipelineUserReset: () => Promise<void>
      confirmPipelineReset: () => Promise<boolean>
    }
    return { api, sendQuiet, existingProject, log, onPipelineReset, confirm }
  }

  it('sends pipeline.reset and adopts the idle run it answers with', async () => {
    const t = await loadReset({ project: { state: 'idle' } })
    expect(await t.api.clearStoredPipelineRun('/tmp/ws')).toBe(true)
    expect(t.sendQuiet).toHaveBeenCalledWith('pipeline.reset', { workspace_path: '/tmp/ws' })
    expect(t.existingProject.value).toEqual({ state: 'idle' })
  })

  it('says so when the backend could not clear it', async () => {
    const t = await loadReset(null)
    expect(await t.api.clearStoredPipelineRun('/tmp/ws')).toBe(false)
    expect(t.log.at(-1)).toMatch(/stored run/)
  })

  it('the Reset button kills the panes, then clears the stored run', async () => {
    const t = await loadReset({ project: { state: 'idle' } })
    await t.api.onPipelineUserReset()
    expect(t.onPipelineReset).toHaveBeenCalled()
    expect(t.sendQuiet).toHaveBeenCalledWith('pipeline.reset', { workspace_path: '/tmp/ws' })
  })

  it('the Reset button asks first, naming every pane it closes — the ones the run did not open too', async () => {
    const t = await loadReset({ project: { state: 'idle' } })
    await t.api.onPipelineUserReset()
    expect(t.confirm).toHaveBeenCalledTimes(1)
    const [, opts] = t.confirm.mock.calls[0]
    expect(opts.danger).toBe(true)
    expect(opts.detail).toBe('• Planner\n• my shell (pipelineEditor.run.reset-manual-mark)\n• Gemini (pipelineEditor.run.reset-manual-mark)')
    expect(t.onPipelineReset).toHaveBeenCalled()
  })

  it('a cancelled confirm closes nothing and keeps the stored run', async () => {
    const t = await loadReset({ project: { state: 'idle' } }, false)
    await t.api.onPipelineUserReset()
    expect(t.onPipelineReset).not.toHaveBeenCalled()
    expect(t.sendQuiet).not.toHaveBeenCalled()
  })

  it('is wired to the Reset button, while closing or leaving a workspace keeps the run for Resume', () => {
    expect(appSource).toContain('@pipeline-reset="onPipelineUserReset"')
    const reset = block('async function onPipelineReset(', '\nasync function clearStoredPipelineRun(')
    expect(reset).not.toContain("'pipeline.reset'")
  })
})

describe('the stage cache follows the active pipeline', () => {
  it('refetches the stages whenever the active pipeline id changes', () => {
    // The run panel's "0-stage" read this cache; it loaded with the 'default'
    // placeholder id before pipelines.list answered and was never refetched.
    // Between runs, that is: a run keeps the cache on its own pipeline (E4).
    expect(appSource).toMatch(
      /watch\(\s*\(\) => pipelinesApi\.activePipelineId\.value,\s*\(id\) => \{\s*if \(pipeline\.state === 'running'\) return\s*runPipelineId\.value = ''\s*if \(id\) void stagesApi\.refresh\(id\)/,
    )
  })
})
