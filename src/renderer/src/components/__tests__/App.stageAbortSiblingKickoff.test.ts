// @vitest-environment happy-dom
// 0.2.37 Windows VM (89dd6e540), a Manager stage: wk's role never reached its
// pane, failRunOnKickoff failed the run (21:50:28), and the same stage's mgr
// slot went on anyway: its role at 21:50:31, its kickoff, with the webhook
// data, at 21:50:45, and the global Manager router at 21:50:46. The slot flow
// checked the run only after its kickoff had been typed, and neither router
// start checked it at all. Once the run is not running, a slot types nothing
// more and no router starts; what was already typed is left alone.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { runPipelineKickoff } from '../../lib/cliCoordination'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

describe('a kickoff the run no longer wants is not typed', () => {
  const base = { sleep: async () => {}, paneAlive: () => true }

  it('types nothing once a sibling slot has failed the run', async () => {
    const inject = vi.fn(async () => ({ injected: true }))
    const r = await runPipelineKickoff({ ...base, inject, stillWanted: () => false })
    expect(r).toEqual({ sent: false, cancelled: false, stopped: true })
    expect(inject).not.toHaveBeenCalled()
  })

  it('makes no further attempt when the run ends between attempts', async () => {
    let running = true
    const inject = vi.fn(async () => { running = false; return { injected: false, echo: null } })
    const r = await runPipelineKickoff({ ...base, inject, stillWanted: () => running })
    expect(r.stopped).toBe(true)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('does not press Enter on a held copy for a run that is over', async () => {
    const submit = vi.fn(async () => true)
    const inject = vi.fn(async () => ({ injected: true }))
    const r = await runPipelineKickoff({ ...base, inject, heldCopy: { holds: () => true, submit }, stillWanted: () => false })
    expect(r.stopped).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  it('sends as before while the run is running', async () => {
    const inject = vi.fn(async () => ({ injected: true }))
    expect(await runPipelineKickoff({ ...base, inject, stillWanted: () => true })).toEqual({ sent: true, cancelled: false })
    expect(inject).toHaveBeenCalledTimes(1)
  })
})

async function loadRouterStarts(state: string) {
  const { code } = await transformWithEsbuild(
    [functionSource('startGlobalManagerRouter'), functionSource('startRouterPoll'),
      'return { startGlobalManagerRouter, startRouterPoll }'].join('\n'),
    'AppRouterStarts.ts', { loader: 'ts' },
  )
  const setInterval = vi.fn(() => 7)
  const router = { pollHandle: null as number | null, armedAt: 0, watchdogFired: false, earlyTurnTexts: [], managerPaneId: 'mgr' }
  const deps: Record<string, unknown> = {
    globalRouterHandle: null,
    pipeline: { state, globalManager: { stageId: 'm1', slotLabel: 'mgr' } },
    pipelineLog: () => {},
    window: { setInterval },
    globalManagerRouterScan: async () => {},
    stageRouters: new Map([[0, router]]),
    managerRouterScan: async () => {},
    ROUTER_POLL_MS: 4000,
    routeManagerTurnText: async () => {},
  }
  const fns = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
    startGlobalManagerRouter: () => void
    startRouterPoll: (stageIndex: number) => void
  }
  return { ...fns, setInterval, router }
}

describe('no router starts on a run that is over', () => {
  it.each(['failed', 'aborted', 'idle'])('the global and stage routers stay off when the run is %s', async (state) => {
    const t = await loadRouterStarts(state)
    t.startGlobalManagerRouter()
    t.startRouterPoll(0)
    expect(t.setInterval).not.toHaveBeenCalled()
    expect(t.router.pollHandle).toBeNull()
  })

  it('both start while the run is running', async () => {
    const t = await loadRouterStarts('running')
    t.startGlobalManagerRouter()
    t.startRouterPoll(0)
    expect(t.setInterval).toHaveBeenCalledTimes(2)
  })
})

describe('activateStage checks the run before each thing it types into a slot', () => {
  const body = functionSource('activateStage')

  it('before the deferred role, after the role settles, and between kickoff attempts', () => {
    const roleCheck = body.indexOf("runEndedFirst('role or kickoff')")
    const roleInject = body.indexOf('➜ injecting role')
    const settle = body.indexOf('waitForActivityThenSettle(pane.id', roleInject)
    const kickoffCheck = body.indexOf("runEndedFirst('kickoff')")
    const kickoffInject = body.indexOf('➜ injecting kickoff', kickoffCheck)
    expect(roleCheck).toBeGreaterThan(-1)
    expect(roleCheck).toBeLessThan(roleInject)
    expect(settle).toBeGreaterThan(roleInject)
    expect(kickoffCheck).toBeGreaterThan(settle)
    expect(kickoffCheck).toBeLessThan(kickoffInject)
    expect(body).toContain('stillWanted: slotStillWanted,')
    expect(body).toMatch(/if \(kickoffResult\.stopped\) \{\s*pipelineLog\([^\n]*\)\s*return\s*\}/)
  })

  it('asks for a running run at this stage, the same test the post-kickoff check makes', () => {
    expect(body).toContain("const slotStillWanted = (): boolean => pipeline.state === 'running' && pipeline.stageIndex === index")
  })
})
