// @vitest-environment happy-dom
// 0.2.37 Windows VM (03ffff1ed), 5/5: a sibling slot failed the run in the
// same second another slot's kickoff was being typed. The run check before the
// attempt had passed, so the kickoff was pasted, Enter went out and the agent
// started work on a failed run. The run is now asked again right before every
// Enter; a kickoff it no longer wants is cleared out of the input box, not
// submitted. A kickoff already submitted is left alone.
//
// The same VM runs showed the slot's "no longer running" line in 1/5: the
// other paths stopped without a word. Each of them now says so.
//
// Clearing was measured on Claude Code 2.1.286 (the VM's) and 2.1.316 in a
// PTY: Ctrl-U deletes one screen row of the input box, a second one the line
// break before it, and on an empty box it does nothing. A collapsed paste
// ("[Pasted text #1 +59 lines]") goes with one. One read of 64 or more Ctrl-U
// is taken as a paste and does nothing, so they go in writes of at most 32.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { composerClearKeys, MAX_KICKOFF_ATTEMPTS, runPipelineKickoff } from '../../lib/cliCoordination'
import type { EchoEvidence } from '../../lib/injectEcho'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

describe('the keys that empty a Claude Code input box', () => {
  const rowsCleared = (writes: string[]): number => writes.join('').length / 2

  it('are Ctrl-U only', () => {
    expect(composerClearKeys('a\nb', 120).join('')).toMatch(/^\x15+$/)
  })

  it('go in writes of at most 32, which the TUI does not take for a paste', () => {
    const long = Array.from({ length: 60 }, (_, i) => `kickoff line ${i} with some task text`).join('\n')
    const writes = composerClearKeys(long, 120)
    expect(writes.length).toBeGreaterThan(1)
    for (const w of writes) expect(w.length).toBeLessThanOrEqual(32)
    expect(rowsCleared(writes)).toBeGreaterThanOrEqual(60)
  })

  it('cover every line of a short paste the TUI did not collapse', () => {
    // Measured: three lines took six.
    expect(rowsCleared(composerClearKeys('line one\nline two\nline three', 120))).toBeGreaterThanOrEqual(3)
  })

  it('cover every screen row of a line the box wraps', () => {
    // Measured: 420 characters at 120 columns wrapped to four rows, and one
    // Ctrl-U took only the last.
    expect(rowsCleared(composerClearKeys('wrapped kickoff text '.repeat(20), 120))).toBeGreaterThanOrEqual(4)
  })

  it('count wide characters as two columns', () => {
    expect(rowsCleared(composerClearKeys('任'.repeat(200), 120))).toBeGreaterThanOrEqual(4)
  })
})

describe('runPipelineKickoff on an injection stopped before its Enter', () => {
  it('reports stopped, and neither retries nor calls the kickoff held', async () => {
    const inject = vi.fn(async () => ({ injected: false, echo: 'tail' as EchoEvidence, stopped: true }))
    const onHeld = vi.fn()
    const sleep = vi.fn(async () => {})
    const r = await runPipelineKickoff({ inject, sleep, paneAlive: () => true, onHeld, stillWanted: () => true })
    expect(r).toEqual({ sent: false, cancelled: false, stopped: true })
    expect(inject).toHaveBeenCalledTimes(1)
    expect(onHeld).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })
})

const kickoffSites = [...appSource.matchAll(/const kickoffResult = await runPipelineKickoff\(\{[\s\S]*?\n {4,6}\}\)/g)]
  .map((match) => match[0])

async function runSiteWhereTheRunFailsMidInjection(site: string) {
  const pipeline = { state: 'running', stageIndex: 0 }
  const injectPane = vi.fn(async (
    _paneId: string, _prompt: string, _tag: string, _paste: boolean, _shouldAbort: unknown,
    evidence?: { echo?: EchoEvidence | null; stopped?: boolean }, _onInputBlocked?: unknown,
    stillWanted?: () => boolean,
  ) => {
    // The paste has echoed; a sibling fails the run before the Enter.
    pipeline.state = 'failed'
    if (evidence) evidence.echo = 'tail'
    if (stillWanted && !stillWanted()) {
      if (evidence) evidence.stopped = true
      return false
    }
    return true
  })
  const sleep = vi.fn(async () => {})
  const { code } = await transformWithEsbuild(
    `return async () => { ${site}; return kickoffResult }`,
    'AppKickoffFinalEnter.ts', { loader: 'ts' },
  )
  const run = new Function(
    'runPipelineKickoff', 'injectPane', 'sleep', 'paneAlive', 'pipelineLog',
    'pane', 'stage', 'kickoff', 'tag', 'MAX_KICKOFF_ATTEMPTS', 'heldKickoffCopy', 'paneParkedOnPrompt',
    'slotStillWanted', 'pipeline', 'roleParked', 'kickoffAttempt', 'logInjectEvidence', 'runEnding', 'runPaneSentAt', code,
  )(
    runPipelineKickoff, injectPane, sleep, () => true, () => {},
    { id: 'pane', stageId: 'stage', kickoffPrompt: 'kickoff', origin: 'pipeline' }, { id: 'stage' },
    'kickoff', 'test', MAX_KICKOFF_ATTEMPTS, () => undefined, () => false,
    () => pipeline.state === 'running' && pipeline.stageIndex === 0, pipeline, false, 0, () => {}, () => false, new Map(),
  ) as () => ReturnType<typeof runPipelineKickoff>
  return { result: await run(), injectPane, sleep }
}

describe.each([0, 1])('kickoff call site %i', (index) => {
  it('hands the run check to the injection, which stops before its Enter', async () => {
    expect(kickoffSites).toHaveLength(2)
    const { result, injectPane, sleep } = await runSiteWhereTheRunFailsMidInjection(kickoffSites[index])
    expect(injectPane).toHaveBeenCalledTimes(1)
    expect(injectPane.mock.calls[0][7]).toBeTypeOf('function')
    expect(result.stopped).toBe(true)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('injectText asks right before every Enter', () => {
  const body = functionSource('injectText')
  const enterLoop = body.slice(body.indexOf('for (let attempt = 1; attempt <= MAX_SUBMITS; attempt++) {'))

  it('checks the run before the loop presses Enter, clears the box and says stopped', () => {
    const check = enterLoop.indexOf('if (stillWanted && !stillWanted())')
    const firstEnter = enterLoop.indexOf("data: '\\r'")
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(firstEnter)
    expect(body).toContain('for (const keys of composerClearKeys(body,')
    expect(body).toMatch(/data: keys \}\)[\s\S]{0,120}await sleep\(100\)/)
    expect(body).toMatch(/evidence\.stopped = true/)
  })

  it('checks it again before the one extra Enter a collapsed paste can get', () => {
    const press = enterLoop.slice(enterLoop.indexOf('pressEnter: async () => {'))
    expect(press.indexOf('stillWanted')).toBeGreaterThan(-1)
    expect(press.indexOf('stillWanted')).toBeLessThan(press.indexOf("data: '\\r'"))
  })

  it('injectPane passes the check through', () => {
    const pane = functionSource('injectPane')
    expect(pane).toMatch(/stillWanted\?: \(\) => boolean/)
    expect(pane).toMatch(/onInputBlocked, stillWanted,?\s*\)/)
  })
})

describe('every path that stops a slot for a run that is over says so', () => {
  const body = functionSource('activateStage')

  it('the deferred role is asked the same and stops the slot with a line', () => {
    const roleInject = body.slice(body.indexOf('const roleOk = await injectPane('))
    expect(roleInject.slice(0, roleInject.indexOf('\n'))).toContain('slotStillWanted')
    expect(body).toMatch(/if \(roleEvidence\.stopped\) \{\s*pipelineLog\(`\$\{tag\} ⏹ the run is no longer running[^\n]*\)\s*return\s*\}/)
  })

  it('a wait for the previous turn that the run ended', () => {
    expect(body).toMatch(/if \(turnWait === 'moved-on'\) \{\s*pipelineLog\(`\$\{tag\} ⏹ the run is no longer running[^\n]*\)\s*return\s*\}/)
  })

  it('a kickoff that went out as the run ended', () => {
    const moved = body.slice(body.indexOf('if (runMovedOn()) {'))
    expect(moved.slice(0, moved.indexOf('\n      return\n'))).toMatch(/pipelineLog\(`\$\{tag\} ⏹ the run is no longer running/)
  })

  it('the stage that ends before its router starts', () => {
    expect(body).toMatch(/if \(pipeline\.state !== 'running' \|\| pipeline\.stageIndex !== index\) \{\s*pipelineLog\(`Stage \$\{stage\.id\} ⏹ the run is no longer running[^\n]*\)\s*return\s*\}/)
  })
})

async function loadRouterStarts(state: string) {
  const { code } = await transformWithEsbuild(
    [functionSource('startGlobalManagerRouter'), functionSource('startRouterPoll'),
      'return { startGlobalManagerRouter, startRouterPoll }'].join('\n'),
    'AppRouterStartLogs.ts', { loader: 'ts' },
  )
  const log: string[] = []
  const router = { pollHandle: null as number | null, armedAt: 0, watchdogFired: false, earlyTurnTexts: [], managerPaneId: 'mgr' }
  const deps: Record<string, unknown> = {
    globalRouterHandle: null,
    pipeline: { state, globalManager: { stageId: 'm1', slotLabel: 'mgr' } },
    pipelineLog: (line: string) => log.push(line),
    window: { setInterval: () => 7 },
    globalManagerRouterScan: async () => {},
    stageRouters: new Map([[0, router]]),
    managerRouterScan: async () => {},
    ROUTER_POLL_MS: 4000,
    routeManagerTurnText: async () => {},
  }
  const fns = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
    startGlobalManagerRouter: () => void
    startRouterPoll: (stageIndex: number) => boolean
  }
  return { ...fns, log }
}

describe('a router that does not start on a run that is over says so', () => {
  it('both routers log why they stayed off, and the stage poll reports it did not start', async () => {
    const t = await loadRouterStarts('failed')
    t.startGlobalManagerRouter()
    expect(t.startRouterPoll(0)).toBe(false)
    expect(t.log.filter((l) => l.includes('⏹ the run is no longer running'))).toHaveLength(2)
  })

  it('a started stage poll reports it started', async () => {
    const t = await loadRouterStarts('running')
    expect(t.startRouterPoll(0)).toBe(true)
  })

  it('the resume path logs the poll as started only when it did start', () => {
    expect(appSource).not.toMatch(/\n {4}startRouterPoll\(index\)\n {4}pipelineLog\(`Stage \$\{stage\.id\} 🎯 Manager router poll started \(/)
    expect(appSource).toMatch(/if \(startRouterPoll\(index\)\) pipelineLog\(`Stage \$\{stage\.id\} 🎯 Manager router poll started \(/)
  })
})
