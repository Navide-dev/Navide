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
  switchOk?: boolean
  activePipelineId?: string
  dag?: unknown
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
    error: { value: 'switch refused' },
    setActivePipeline: vi.fn(async (id: string) => {
      if (opts.switchOk === false) return false
      pipelinesApi.activePipelineId.value = id
      return true
    }),
  }
  const deps: Record<string, unknown> = {
    pipeline,
    pipelinesApi,
    stagesApi,
    pipelineRunWorkspace: '',
    existingProject: { value: null },
    pipelineLog: (line: string) => pipeline.log.push(line),
    pipelineRunGroupName: () => 'Pipeline',
    createRunGroup: vi.fn(),
    deriveGlobalManager: () => null,
    applyProjectPaths: vi.fn(),
    sendQuiet: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload })
      return null
    }),
    preSpawnStage: vi.fn(async () => {}),
    activateStage: vi.fn(async () => {}),
    startGlobalManagerRouter: vi.fn(),
    pipelineDag: opts.dag ?? linearPipelineDag(() => pipeline.workspacePath).dag,
  }
  const onPipelineStart = new Function(...Object.keys(deps), code)(...Object.values(deps)) as (
    p: { task: string; workspacePath: string; pipelineId?: string },
  ) => Promise<string>
  return { onPipelineStart, pipeline, sent, stagesApi, pipelinesApi }
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

  it('still switches first when another pipeline is requested', async () => {
    const t = await loadStart({ activePipelineId: 'pl-1', cached: STALE })
    await t.onPipelineStart(START)
    expect(t.pipelinesApi.setActivePipeline).toHaveBeenCalledWith('pl-2', '/tmp/ws')
    expect(t.stagesApi.refresh).toHaveBeenCalledWith('pl-2')
    expect(t.sent.find((s) => s.type === 'pipeline.start')?.payload.pipeline_id).toBe('pl-2')
  })
})

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

  it('a pipeline it cannot switch to', async () => {
    const t = await loadStart({ activePipelineId: 'pl-1', switchOk: false })
    const reason = await t.onPipelineStart(START)
    expect(reason).toContain('switch refused')
    expect(refusal(t.sent)?.reason).toBe(reason)
    expect(t.stagesApi.refresh).not.toHaveBeenCalled()
  })

  it('a run graph that cannot be prepared, restoring the state it had', async () => {
    const dag = { begin: vi.fn(async () => null) }
    const t = await loadStart({ dag })
    const reason = await t.onPipelineStart(START)
    expect(reason).toMatch(/run graph/)
    expect(refusal(t.sent)?.reason).toBe(reason)
    expect(t.pipeline.state).toBe('idle')
  })
})

describe('the Run button shows the refusal', () => {
  async function loadPanel(refusal: string) {
    const src = block('async function onPipelineStartFromPanel(', '\n/** Before firing 🎉')
    const { code } = await transformWithEsbuild(`${src}\nreturn onPipelineStartFromPanel`, 'AppPanel.ts', { loader: 'ts' })
    const toast = vi.fn()
    const deps: Record<string, unknown> = {
      onPipelineStart: vi.fn(async () => refusal),
      notifyRestore: { toast },
      i18n: { global: { t: (key: string, p: { reason: string }) => `${key}: ${p.reason}` } },
    }
    const fn = new Function(...Object.keys(deps), code)(...Object.values(deps)) as (p: unknown) => Promise<void>
    return { fn, toast }
  }

  it('toasts the reason when the start is refused', async () => {
    const t = await loadPanel('pipeline pl-2 has no stages')
    await t.fn(START)
    expect(t.toast).toHaveBeenCalledWith('error.pipeline-start-refused: pipeline pl-2 has no stages', { type: 'error' })
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

describe('reset clears the stored run, and only the user reset does', () => {
  async function loadReset(resp: unknown) {
    const resetSource = block('async function clearStoredPipelineRun(', '\n// ─────────── Switch / close workspace')
    const { code } = await transformWithEsbuild(
      `${resetSource}\nreturn { clearStoredPipelineRun, onPipelineUserReset }`,
      'AppReset.ts',
      { loader: 'ts' },
    )
    const log: string[] = []
    const existingProject = { value: { state: 'aborted' } as unknown }
    const sendQuiet = vi.fn(async () => resp)
    const onPipelineReset = vi.fn(async () => {})
    const deps: Record<string, unknown> = {
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
    }
    return { api, sendQuiet, existingProject, log, onPipelineReset }
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
    expect(appSource).toMatch(
      /watch\(\s*\(\) => pipelinesApi\.activePipelineId\.value,\s*\(id\) => \{\s*if \(id\) void stagesApi\.refresh\(id\)/,
    )
  })
})
