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

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

async function loadFail() {
  const source = block('async function failRunOnKickoff(', '\n/** Approve the gate the run is paused on')
  const { code } = await transformWithEsbuild(`${source}\nreturn failRunOnKickoff`, 'AppKickoffFailed.ts', { loader: 'ts' })
  const pipeline = { state: 'running', workspacePath: '/ws', log: [] as string[] }
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = []
  const failed: Array<[number, string, string]> = []
  const ends: string[] = []
  const toasts: Array<{ text: string; type: string }> = []
  const deps: Record<string, unknown> = {
    pipeline,
    stagesApi: { stages: { value: [{ id: 'storyboard' }, { id: 'illustration' }] } },
    pipelineLog: (line: string) => pipeline.log.push(line),
    pipelineDag: {
      slotFailed: (index: number, label: string, reason: string) => failed.push([index, label, reason]),
      end: vi.fn(async (outcome: string) => { ends.push(outcome) }),
    },
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
    stageIndex: number, slotLabel: string, reason: string,
  ) => Promise<void>
  return { failRunOnKickoff, pipeline, sent, failed, ends, toasts, deps }
}

describe('a kickoff that never reached its pane fails the run (#448)', () => {
  it('fails the node with the reason, ends the run as failed and says so', async () => {
    const t = await loadFail()
    await t.failRunOnKickoff(1, 'codex-1', 'kickoff never reached the agent after 3 attempts')
    expect(t.failed).toEqual([[1, 'codex-1', 'kickoff never reached the agent after 3 attempts']])
    expect(t.pipeline.state).not.toBe('running')
    expect(t.ends).toEqual(['failed'])
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
    expect(t.ends).toEqual(['failed'])
    expect(t.toasts).toHaveLength(1)
  })
})

describe('no kickoff path arms a watcher over a kickoff that failed (#448)', () => {
  it('both kickoff paths hand a failed kickoff to failRunOnKickoff', () => {
    expect(appSource.includes('arming watcher anyway')).toBe(false)
    const calls = appSource.match(/await failRunOnKickoff\(/g) ?? []
    expect(calls.length).toBe(2)
  })
})
