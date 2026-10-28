// @vitest-environment happy-dom
// #448: a stage-2 kickoff that never reached its pane was logged as "arming
// watcher anyway" and the run went on as `running` — its nodes running, its
// panes idle without a task, nothing on screen or in pipeline_status saying so.
// A kickoff that failed now fails its node with the reason and ends the run as
// failed (panes kept, so it can be resumed), with a toast.
//
// App.vue cannot be mounted here (see App.pipelineActions.test.ts), so the
// function is lifted out, compiled and run against stubs passed by name.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { runPipelineKickoff } from '../../lib/cliCoordination'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

async function loadFail(opts: { errorEdge?: boolean; retry?: boolean } = {}) {
  const source = block('async function failRunOnKickoff(', '\n/** Approve the gate the run is paused on')
  const { code } = await transformWithEsbuild(`${source}\nreturn failRunOnKickoff`, 'AppKickoffFailed.ts', { loader: 'ts' })
  const pipeline = { state: 'running', stageIndex: 1, workspacePath: '/ws', log: [] as string[] }
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  const failed: Array<[number, string, string]> = []
  const ends: Array<[string, string | undefined]> = []
  const toasts: Array<{ text: string; type: string }> = []
  const routed: Array<[number, string, string]> = []
  const completed: Array<[number, string, string]> = []
  const retried: Array<[number, string, number]> = []
  const deps: Record<string, unknown> = {
    pipeline,
    stagesApi: { stages: { value: [{ id: 'storyboard' }, { id: 'illustration' }] } },
    pipelineLog: (line: string) => pipeline.log.push(line),
    pipelineDag: {
      slotFailed: (index: number, label: string, reason: string) => failed.push([index, label, reason]),
      retryAfterFailure: (_index: number, _label: string, reason: string) =>
        opts.retry ? { attempt: 2, maxTries: 3, waitMs: 0, note: `[retry] ${reason}` } : null,
      routeFailure: (index: number, label: string, reason: string) => {
        if (!opts.errorEdge) return false
        routed.push([index, label, reason])
        return true
      },
      end: vi.fn(async (outcome: string, reason?: string) => { ends.push([outcome, reason]) }),
    },
    panes: { value: [{ id: 'pane-c1', stageId: 'illustration', slotLabel: 'codex-1', origin: 'pipeline' }] },
    onStageSlotCompleted: (index: number, key: string, reason: string) => completed.push([index, key, reason]),
    scheduleSlotRetry: (index: number, label: string, retry: { attempt: number }) => retried.push([index, label, retry.attempt]),
    tearDownPipelineOrchestration: vi.fn(() => { pipeline.state = 'aborted' }),
    sendQuiet: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload })
      return null
    }),
    applyProjectPaths: vi.fn(),
    onWorkspaceCheck: vi.fn(async () => {}),
    notifyRestore: { toast: (text: string, opts: { type: string }) => toasts.push({ text, type: opts.type }) },
    i18n: { global: { t: (key: string, named?: Record<string, unknown>) => `${key} ${JSON.stringify(named ?? {})}` } },
  }
  const failRunOnKickoff = new Function(...Object.keys(deps), code)(...Object.values(deps)) as (
    stageIndex: number, slotLabel: string, reason: string, held?: boolean, reported?: boolean,
  ) => Promise<void>
  return { failRunOnKickoff, pipeline, sent, failed, ends, toasts, routed, completed, retried, deps }
}

describe('a kickoff that never reached its pane fails the run (#448)', () => {
  it('fails the node with the reason, ends the run as failed and says so', async () => {
    const t = await loadFail()
    await t.failRunOnKickoff(1, 'codex-1', 'kickoff never reached the agent after 3 attempts')
    expect(t.failed).toEqual([[1, 'codex-1', 'kickoff never reached the agent after 3 attempts']])
    expect(t.pipeline.state).not.toBe('running')
    expect(t.ends.map((e) => e[0])).toEqual(['failed'])
    expect(t.sent).toEqual([{ type: 'pipeline.abort', payload: { workspace_path: '/ws', reason: 'failed' } }])
    expect(t.toasts).toHaveLength(1)
    expect(t.toasts[0].type).toBe('error')
    expect(t.toasts[0].text).toContain('pipeline-kickoff-failed')
    expect(t.toasts[0].text).toContain('codex-1')
    expect(t.pipeline.log.some((l) => l.includes('illustration') && l.includes('pipeline failed'))).toBe(true)
  })

  it('a second slot failing after the run ended only fails its own node', async () => {
    const t = await loadFail()
    await Promise.all([
      t.failRunOnKickoff(1, 'manager', 'kickoff never reached the agent'),
      t.failRunOnKickoff(1, 'codex-1', 'kickoff never reached the agent'),
    ])
    expect(t.failed.map((f) => f[1])).toEqual(['manager', 'codex-1'])
    expect(t.sent.filter((s) => s.type === 'pipeline.abort')).toHaveLength(1)
    expect(t.ends.map((e) => e[0])).toEqual(['failed'])
    expect(t.toasts).toHaveLength(1)
  })

  it('names the failing slot on the nodes it stops with the run', async () => {
    const t = await loadFail()
    await t.failRunOnKickoff(1, 'codex-1', 'kickoff never reached the agent')
    expect(t.ends[0][1]).toContain('codex-1')
    expect(t.ends[0][1]).toContain('kickoff never reached the agent')
  })

  it('tells the user to leave a held kickoff for resume, not to send it by hand', async () => {
    // Sending it by hand and then resuming would paste the task a second time.
    const t = await loadFail()
    await t.failRunOnKickoff(1, 'codex-1', 'kickoff is waiting in the input box', true)
    expect(t.toasts[0].text).toContain('pipeline-kickoff-held')
    expect(t.toasts[0].text).toContain('codex-1')
    for (const locale of ['en-US', 'zh-TW', 'ja-JP']) {
      const path = resolve(process.cwd(), `packages/plugin-ui/src/foundation/i18n/locales/${locale}.json`)
      const text = JSON.parse(readFileSync(path, 'utf8')).error['pipeline-kickoff-held'] as string
      expect(text, locale).toMatch(/resume/i)
    }
    expect(appSource.includes('submit or clear it before resuming')).toBe(false)
  })

  it('a late failure from a stage the run has moved past fails nothing', async () => {
    // The scheduleInjection kickoff is long-lived; it can finish after the
    // user aborted and started another run, which is now at another stage.
    const t = await loadFail()
    t.pipeline.stageIndex = 0
    await t.failRunOnKickoff(1, 'codex-1', 'kickoff never reached the agent')
    expect(t.failed).toEqual([])
    expect(t.sent).toEqual([])
    expect(t.pipeline.state).toBe('running')
  })
})

describe('a slot with a retry policy tries again before anything else', () => {
  it('schedules the retry and neither routes nor fails anything', async () => {
    const t = await loadFail({ retry: true, errorEdge: true })
    await t.failRunOnKickoff(1, 'codex-1', 'kickoff never reached the agent')
    expect(t.retried).toEqual([[1, 'codex-1', 2]])
    expect(t.routed).toEqual([])
    expect(t.failed).toEqual([])
    expect(t.pipeline.state).toBe('running')
  })

  it('a reported failure out of tries says so in its toast', async () => {
    const t = await loadFail()
    await t.failRunOnKickoff(1, 'codex-1', 'tests are red', false, true)
    expect(t.toasts[0].text).toContain('pipeline-node-failed')
    expect(t.toasts[0].text).toContain('tests are red')
  })
})

describe('a slot with an error edge fails down that edge instead of failing the run', () => {
  it('routes the failure, counts the slot finished and keeps the run going', async () => {
    const t = await loadFail({ errorEdge: true })
    await t.failRunOnKickoff(1, 'codex-1', 'kickoff never reached the agent')
    expect(t.routed).toEqual([[1, 'codex-1', 'kickoff never reached the agent']])
    expect(t.completed).toEqual([[1, 'pane-c1', 'error-edge']])
    expect(t.failed).toEqual([])
    expect(t.pipeline.state).toBe('running')
    expect(t.sent).toEqual([])
    expect(t.toasts).toEqual([])
  })

  it('a slot with no pane is counted under a synthetic key', async () => {
    const t = await loadFail({ errorEdge: true })
    await t.failRunOnKickoff(1, 'manager', 'role prompt never reached the agent')
    expect(t.completed).toEqual([[1, 'failed:manager', 'error-edge']])
  })
})

describe('a kickoff held in the input box is never pasted a second time (#448)', () => {
  const base = { sleep: async () => {}, paneAlive: () => true }

  it('submits the copy still in the input box instead of injecting', async () => {
    const inject = vi.fn(async () => ({ injected: true }))
    const submit = vi.fn(async () => true)
    const r = await runPipelineKickoff({ ...base, inject, heldCopy: { holds: () => true, submit } })
    expect(r).toEqual({ sent: true, cancelled: false })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(inject).not.toHaveBeenCalled()
  })

  it('reports it held again when Enter does not take, still without pasting', async () => {
    const inject = vi.fn(async () => ({ injected: true }))
    const onHeld = vi.fn()
    const r = await runPipelineKickoff({ ...base, inject, onHeld, heldCopy: { holds: () => true, submit: async () => false } })
    expect(r).toEqual({ sent: false, cancelled: false })
    expect(onHeld).toHaveBeenCalledTimes(1)
    expect(inject).not.toHaveBeenCalled()
  })

  it('injects as usual once the input box no longer holds it', async () => {
    const inject = vi.fn(async () => ({ injected: true }))
    const submit = vi.fn(async () => true)
    const r = await runPipelineKickoff({ ...base, inject, heldCopy: { holds: () => false, submit } })
    expect(r).toEqual({ sent: true, cancelled: false })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('no kickoff path arms a watcher over a kickoff that failed (#448)', () => {
  it('both kickoff paths hand a failed kickoff to failRunOnKickoff', () => {
    expect(appSource.includes('arming watcher anyway')).toBe(false)
    const schedule = block('function scheduleInjection(pane: ActivePane): void {', '\ninterface SpawnInternal')
    const activate = block('async function activateStage(index: number, opts: { only?: string; note?: string } = {}): Promise<void> {', '\nasync function spawnPipelineStage(')
    expect(schedule).toContain('await failRunOnKickoff(')
    expect(activate).toContain('await failRunOnKickoff(')
  })
})
