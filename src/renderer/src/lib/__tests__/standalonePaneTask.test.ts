import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  injectStandaloneTask, standaloneKickoffVerdict, STANDALONE_PROMPT_READY_TIMEOUT_MS,
  type StandaloneKickoffEvidence, type StandaloneTaskInjectionDeps,
} from '../standalonePaneTask'

function deps(overrides: Partial<StandaloneTaskInjectionDeps> = {}): StandaloneTaskInjectionDeps {
  return {
    selectPane: vi.fn(),
    sendSessionMarkerBootstrap: vi.fn(async () => false),
    dismissStartupDialog: vi.fn(async () => false),
    waitForStartupActivity: vi.fn(async () => true),
    waitForQuiet: vi.fn(async () => {}),
    waitForPromptReady: vi.fn(async () => true),
    paneStarting: vi.fn(() => false),
    paneAlive: vi.fn(() => true),
    injectPane: vi.fn(async () => true),
    onKill: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('lib/standalonePaneTask injectStandaloneTask', () => {
  it('does nothing and reports success when the task is empty', async () => {
    const d = deps()
    const ok = await injectStandaloneTask('pane-1', '', 'mcp-task', d)
    expect(ok).toBe(true)
    expect(d.selectPane).not.toHaveBeenCalled()
    expect(d.injectPane).not.toHaveBeenCalled()
    expect(d.onKill).not.toHaveBeenCalled()
  })

  it('settles the CLI then injects the task when one is given', async () => {
    const d = deps()
    const ok = await injectStandaloneTask('pane-1', 'do the thing', 'mcp-task', d)
    expect(ok).toBe(true)
    expect(d.selectPane).toHaveBeenCalledWith('pane-1', { userInitiated: false })
    expect(d.sendSessionMarkerBootstrap).toHaveBeenCalledWith('pane-1', '[pane pane-1]')
    // bootstrap returned false above, so the dialog-dismiss fallback runs
    expect(d.dismissStartupDialog).toHaveBeenCalledWith('pane-1')
    expect(d.waitForStartupActivity).toHaveBeenCalledWith('pane-1')
    expect(d.waitForPromptReady).toHaveBeenCalledWith('pane-1', STANDALONE_PROMPT_READY_TIMEOUT_MS)
    expect(d.waitForQuiet).not.toHaveBeenCalled()
    expect(d.injectPane).toHaveBeenCalledWith('pane-1', 'do the thing', 'mcp-task', true)
    expect(d.onKill).not.toHaveBeenCalled()
  })

  it('waits much longer for a RESUMED CLI to settle before injecting', async () => {
    // A fresh CLI prints its banner and is ready. A resumed one reloads the
    // transcript first — observed 20-30s of silence on a real session — and
    // the 1s/8s wait injected into a CLI that was not listening, saw no echo,
    // and killed the pane as a failed launch. Resume gets its own thresholds.
    const d = deps()
    const ok = await injectStandaloneTask('pane-1', 'carry on', 'mcp-task', d, { resume: true })
    expect(ok).toBe(true)
    expect(d.waitForQuiet).toHaveBeenCalledWith('pane-1', 3000, 60_000)
    expect(d.waitForPromptReady).not.toHaveBeenCalled()
    expect(d.injectPane).toHaveBeenCalledWith('pane-1', 'carry on', 'mcp-task', true)
  })

  it('a resume with no task still injects nothing', async () => {
    const d = deps()
    expect(await injectStandaloneTask('pane-1', '', 'mcp-task', d, { resume: true })).toBe(true)
    expect(d.waitForQuiet).not.toHaveBeenCalled()
    expect(d.injectPane).not.toHaveBeenCalled()
  })

  it('skips the dialog-dismiss fallback when the marker bootstrap already settled the CLI', async () => {
    const d = deps({ sendSessionMarkerBootstrap: vi.fn(async () => true) })
    await injectStandaloneTask('pane-1', 'do the thing', 'mcp-task', d)
    expect(d.dismissStartupDialog).not.toHaveBeenCalled()
    expect(d.waitForStartupActivity).not.toHaveBeenCalled()
  })

  it('rolls back (kills the pane) and reports failure when the pane died before injection', async () => {
    const d = deps({ paneAlive: vi.fn(() => false) })
    const ok = await injectStandaloneTask('pane-1', 'do the thing', 'mcp-task', d)
    expect(ok).toBe(false)
    expect(d.onKill).toHaveBeenCalledWith('pane-1')
    expect(d.injectPane).not.toHaveBeenCalled()
  })

  it('reports failure but leaves the live pane standing when injection fails', async () => {
    const d = deps({ injectPane: vi.fn(async () => false) })
    const evidence: StandaloneKickoffEvidence = {}
    const ok = await injectStandaloneTask('pane-1', 'do the thing', 'mcp-task', d, { evidence })
    expect(ok).toBe(false)
    expect(d.onKill).not.toHaveBeenCalled()
    expect(evidence.injectFailed).toBe(true)
  })
})

// Windows VM 0.2.38 (kick): cli_open_agent from an external client failed 6 of
// 7 times at +14-16s with 「建立失敗」. Claude Code had printed only control
// sequences when the 1s/8s quiet wait let the task through; nothing echoed for
// 6s, inject.failed, and the pane — a live CLI — was killed.
describe('lib/standalonePaneTask slow Windows CLI start (cli_open_agent target_workspace)', () => {
  /** A CLI that draws nothing until `readyAtMs`, on a fake clock the waits advance. */
  function slowCli(readyAtMs: number) {
    let now = 0
    const ready = () => now >= readyAtMs
    return deps({
      waitForQuiet: vi.fn(async (_id: string, quietMs: number, timeoutMs: number) => {
        // Silence reads as quiet: the old gate returned after quietMs.
        now += Math.min(quietMs, timeoutMs)
      }),
      waitForPromptReady: vi.fn(async (_id: string, timeoutMs: number) => {
        if (readyAtMs <= now + timeoutMs) { now = Math.max(now, readyAtMs); return true }
        now += timeoutMs
        return false
      }),
      paneStarting: vi.fn(() => !ready()),
      injectPane: vi.fn(async (_id, _text, _label, _keep, evidence) => {
        if (!ready()) { now += 6000; return false }
        if (evidence) { evidence.echo = 'tail'; evidence.submit = 'turn' }
        return true
      }),
    })
  }

  it('a CLI that prints nothing for 8s and is ready at 20s still gets its task, and is not killed', async () => {
    const d = slowCli(20_000)
    const evidence: StandaloneKickoffEvidence = {}
    expect(await injectStandaloneTask('pane-1', 'do the thing', 'mcp-task', d, { evidence })).toBe(true)
    expect(d.onKill).not.toHaveBeenCalled()
    expect(d.injectPane).toHaveBeenCalledTimes(1)
    expect(standaloneKickoffVerdict(evidence).kickoff).toBe('sent')
  })

  it('an echo that never appears leaves the pane open and the verdict unverified, typed once', async () => {
    const d = deps({ injectPane: vi.fn(async () => false) })
    const evidence: StandaloneKickoffEvidence = {}
    expect(await injectStandaloneTask('pane-1', 'do the thing', 'mcp-task', d, { evidence })).toBe(false)
    expect(d.onKill).not.toHaveBeenCalled()
    expect(d.injectPane).toHaveBeenCalledTimes(1)
    const v = standaloneKickoffVerdict(evidence)
    expect(v.kickoff).toBe('unverified')
    expect(v.reason).toMatch(/read its prompt before resending/)
  })

  it('a CLI that never draws anything is left untyped and open, and the verdict is failed', async () => {
    const d = slowCli(Number.POSITIVE_INFINITY)
    const evidence: StandaloneKickoffEvidence = {}
    expect(await injectStandaloneTask('pane-1', 'do the thing', 'mcp-task', d, { evidence })).toBe(false)
    expect(d.injectPane).not.toHaveBeenCalled()
    expect(d.onKill).not.toHaveBeenCalled()
    expect(standaloneKickoffVerdict(evidence).kickoff).toBe('failed')
  })

  it('growth-only evidence counts once the prompt-ready gate opened, as on the pane path', () => {
    expect(standaloneKickoffVerdict({ echo: 'growth', submit: 'turn', promptReady: true }).kickoff).toBe('sent')
    expect(standaloneKickoffVerdict({ echo: 'growth', submit: 'turn' }).kickoff).toBe('unverified')
  })

  it('App.vue reports the pane before typing its task, and no longer fails the spawn on a missed echo', () => {
    const app = readFileSync(resolve(__dirname, '../../App.vue'), 'utf8')
    const createStart = app.indexOf('async function createStandaloneRequestedPane(')
    const create = app.slice(createStart, app.indexOf('\nfunction standaloneSpawnGateContext(', createStart))
    expect(create).not.toMatch(/injectStandaloneTask\(/)
    const start = app.indexOf('async function handleMcpSpawnRequest(')
    const body = app.slice(start, app.indexOf('\nfunction describeSpawnRefusal(', start))
    const standalone = body.slice(body.indexOf('if (!parent && !cross) {'))
    const reported = standalone.indexOf('report({ ok: true')
    const injected = standalone.indexOf('injectStandaloneTask(')
    expect(reported).toBeGreaterThan(-1)
    expect(injected).toBeGreaterThan(reported)
    // The gate waits for the pane's terminal ref to be mounted with its session
    // before judging it, within the same ceiling.
    const deps = app.slice(app.indexOf('function standaloneTaskDeps('), app.indexOf('async function createStandaloneRequestedPane('))
    expect(deps).toMatch(/while \(!paneRefs\[id\]\?\.sessionId && paneAlive\(id\) && Date\.now\(\) < deadline\)/)
    expect(deps).toMatch(/return waitForPromptReady\(id, Math\.max\(0, deadline - Date\.now\(\)\)\)/)
  })
})

// cli_open_agent from an external client (target_workspace, no requesting
// pane) answered kickoff "failed" on every call — Linux VM 0.2.38, qa/qb, the
// task visibly typed and running — because this path never collected echo or
// submit evidence and the window hard-coded 'unverified', which the server
// reports as failed. The pane path judged the same evidence and said sent.
describe('lib/standalonePaneTask kickoff evidence (cli_open_agent target_workspace)', () => {
  it('hands injectPane an evidence object and keeps what it recorded', async () => {
    const d = deps({
      injectPane: vi.fn(async (_id, _text, _label, _keep, evidence) => {
        if (evidence) {
          evidence.echo = 'tail'
          evidence.submit = 'tail-left'
        }
        return true
      }),
    })
    const evidence: StandaloneKickoffEvidence = {}
    expect(await injectStandaloneTask('pane-1', 'do the thing', 'mcp-task', d, { evidence })).toBe(true)
    expect(evidence).toEqual({ echo: 'tail', submit: 'tail-left', promptReady: true })
  })

  it('is sent on payload-level evidence', () => {
    expect(standaloneKickoffVerdict({ echo: 'tail', submit: 'tail-left' }).kickoff).toBe('sent')
    expect(standaloneKickoffVerdict({ echo: 'placeholder', submit: 'turn' }).kickoff).toBe('sent')
    expect(standaloneKickoffVerdict({ echo: 'tail', submit: 'queued' }).kickoff).toBe('sent')
  })

  it('stays unverified, with a look-first reason, on growth-only or missing evidence', () => {
    for (const ev of [{ echo: 'growth', submit: 'growth' }, { echo: 'placeholder', submit: 'unconfirmed' }, {}] as const) {
      const v = standaloneKickoffVerdict(ev)
      expect(v.kickoff).toBe('unverified')
      expect(v.reason).toMatch(/read its prompt before resending/)
    }
  })

  it('a task-less standalone pane is sent: nothing was asked of it', () => {
    expect(standaloneKickoffVerdict({}, { task: '' }).kickoff).toBe('sent')
  })

  it('App.vue judges the standalone kickoff from the evidence instead of hard-coding unverified', () => {
    const app = readFileSync(resolve(__dirname, '../../App.vue'), 'utf8')
    const start = app.indexOf('async function handleMcpSpawnRequest(')
    const body = app.slice(start, app.indexOf('\nfunction describeSpawnRefusal(', start))
    expect(body).not.toMatch(/kickoff: 'unverified'/)
    expect(body).toMatch(/standaloneKickoffVerdict\(/)
  })
})
