// @vitest-environment happy-dom
// 0.2.37 Linux VM (70e669130), run 20261103-204149: the wk slot parked on a
// permission box and failed the run (markRunEnding 20:41:59.538,
// pipeline.abort .741). The mgr slot's kickoff had gone out just before, and
// nothing stopped it: it printed MANAGER-READY, ran `touch RAN.txt` and parked
// on a permission box of its own, on a run that was over.
//
// failRunOnKickoff and stopFailedRunPanes are lifted out of App.vue and run
// against panes that only answer their display status.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { createRunSlotPanes } from '../../lib/runSlotPanes'
import { failedRunStop } from '../../lib/failedRunStop'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

const KNOWN_GLOBALS = new Set(['Promise', 'Date', 'Array', 'Map', 'Set', 'Object', 'String', 'Number', 'JSON', 'Error', 'console', 'Math', 'undefined', 'RegExp'])

async function load(scope: Record<string, unknown>) {
  const names = ['failRunOnKickoff', 'stopFailedRunPanes', 'runSlotPane']
  const body = names.map(functionSource).join('\n')
  const { code } = await transformWithEsbuild(`${body}\nreturn { failRunOnKickoff }`, 'AppFailedRunStop.ts', { loader: 'ts' })
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === 'string' && (key in target || !KNOWN_GLOBALS.has(key)),
    get: (target, key) => (key === Symbol.unscopables ? undefined : key in target ? target[key as string] : vi.fn()),
  })
  return new Function('scope', `with (scope) { return (function () {${code}})() }`)(proxy) as {
    failRunOnKickoff: (stageIndex: number, slotLabel: string, reason: string, held?: boolean, reported?: boolean, needsUser?: boolean) => Promise<void>
  }
}

type Status = 'running' | 'awaiting' | 'idle' | 'exited'

async function failWk(statuses: Record<string, Status>, opts: { retry?: boolean; errorEdge?: boolean; foreign?: Status } = {}) {
  const runSlots = createRunSlotPanes()
  const panes: Array<{ id: string; slotLabel: string; realized: boolean }> = []
  const paneRefs: Record<string, { sessionId: string; displayStatus: Status }> = {}
  for (const [label, status] of Object.entries(statuses)) {
    const id = `pane-${label}`
    runSlots.record(runSlots.current(), 'S1', label, id)
    panes.push({ id, slotLabel: label, realized: true })
    paneRefs[id] = { sessionId: `s-${label}`, displayStatus: status }
  }
  // A pane of an earlier run, same stage and slot names, still open.
  if (opts.foreign) {
    panes.push({ id: 'pane-old', slotLabel: 'mgr', realized: true })
    paneRefs['pane-old'] = { sessionId: 's-old', displayStatus: opts.foreign }
  }
  const pipeline = { state: 'running', stageIndex: 0, workspacePath: '/ws' }
  const onInterrupt = vi.fn(async () => true)
  const send = vi.fn(async () => ({ ok: true }))
  const log: string[] = []
  const scheduleSlotRetry = vi.fn()
  const onStageSlotCompleted = vi.fn()
  const { failRunOnKickoff } = await load({
    runSlots,
    panes: { value: panes },
    paneRefs,
    pipeline,
    runEndingSlots: new Set<string>(),
    stagesApi: { stages: { value: [{ id: 'S1' }] } },
    pipelineDag: {
      retryAfterFailure: () => (opts.retry ? { attempt: 1, maxTries: 2, waitMs: 0, note: '' } : null),
      routeFailure: () => !!opts.errorEdge,
      slotFailed: vi.fn(),
      end: vi.fn(async () => {}),
      isChildRun: () => false,
    },
    tearDownPipelineOrchestration: () => { pipeline.state = 'aborted' },
    sendQuiet: vi.fn(async () => null),
    applyProjectPaths: vi.fn(),
    notifyRestore: { toast: vi.fn() },
    i18n: { global: { t: (k: string) => k } },
    onWorkspaceCheck: vi.fn(async () => {}),
    acp: { owns: () => false },
    failedRunStop,
    onInterrupt,
    backend: { send },
    pipelineLog: (line: string) => { log.push(line) },
    scheduleSlotRetry,
    onStageSlotCompleted,
  })
  await failRunOnKickoff(0, 'wk', 'parked on a permission prompt', false, false, !opts.retry && !opts.errorEdge)
  await new Promise((r) => setTimeout(r, 0))
  const escs = send.mock.calls.filter((c) => (c as unknown[])[0] === 'terminal.input' && ((c as unknown[])[1] as { data: string }).data === '\x1b')
    .map((c) => ((c as unknown[])[1] as { terminal_session_id: string }).terminal_session_id)
  return { interrupted: onInterrupt.mock.calls.map((c) => (c as unknown[])[0]), escs, log, scheduleSlotRetry }
}

describe('a slot failing the run stops the others', () => {
  it('a sibling in a turn gets its interrupt key, and the log says so', async () => {
    const r = await failWk({ wk: 'awaiting', mgr: 'running' })
    expect(r.interrupted).toEqual(['pane-mgr'])
    expect(r.log).toContain('⏹ interrupted mgr — the run failed')
  })

  it('a sibling parked on a permission box gets Esc, not left on Yes/No', async () => {
    const r = await failWk({ wk: 'awaiting', mgr: 'awaiting' })
    expect(r.escs).toEqual(['s-mgr'])
    expect(r.interrupted).toEqual([])
    expect(r.log).toContain('⏹ interrupted mgr — the run failed')
  })

  it('an idle sibling gets nothing', async () => {
    const r = await failWk({ wk: 'awaiting', mgr: 'idle', qa: 'exited' })
    expect(r.interrupted).toEqual([])
    expect(r.escs).toEqual([])
    expect(r.log.filter((l) => l.startsWith('⏹'))).toEqual([])
  })

  it('the failed slot itself is left for the resume', async () => {
    const r = await failWk({ wk: 'running', mgr: 'running' })
    expect(r.interrupted).toEqual(['pane-mgr'])
  })

  it('a pane of another run is not touched', async () => {
    const r = await failWk({ wk: 'awaiting' }, { foreign: 'running' })
    expect(r.interrupted).toEqual([])
    expect(r.escs).toEqual([])
  })

  it('a failure that retries sends nothing', async () => {
    const r = await failWk({ wk: 'awaiting', mgr: 'running' }, { retry: true })
    expect(r.scheduleSlotRetry).toHaveBeenCalled()
    expect(r.interrupted).toEqual([])
    expect(r.escs).toEqual([])
  })

  it('a failure down an error edge sends nothing', async () => {
    const r = await failWk({ wk: 'awaiting', mgr: 'running' }, { errorEdge: true })
    expect(r.interrupted).toEqual([])
    expect(r.escs).toEqual([])
  })
})

describe('failedRunStop', () => {
  it.each([
    ['running', 'interrupt'],
    ['awaiting', 'dismiss'],
    ['idle', null],
    ['starting', null],
    ['exited', null],
    [undefined, null],
  ])('%s → %s', (status, stop) => {
    expect(failedRunStop(status)).toBe(stop)
  })
})

describe('the user\'s abort is unchanged', () => {
  it('onPipelineAbort does not stop the panes', () => {
    expect(functionSource('onPipelineAbort')).not.toContain('stopFailedRunPanes')
  })
})
