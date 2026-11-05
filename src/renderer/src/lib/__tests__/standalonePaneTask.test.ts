import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  injectStandaloneTask, standaloneKickoffVerdict, type StandaloneKickoffEvidence, type StandaloneTaskInjectionDeps,
} from '../standalonePaneTask'

function deps(overrides: Partial<StandaloneTaskInjectionDeps> = {}): StandaloneTaskInjectionDeps {
  return {
    selectPane: vi.fn(),
    sendSessionMarkerBootstrap: vi.fn(async () => false),
    dismissStartupDialog: vi.fn(async () => false),
    waitForStartupActivity: vi.fn(async () => true),
    waitForQuiet: vi.fn(async () => {}),
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
    expect(d.waitForQuiet).toHaveBeenCalledWith('pane-1', 1000, 8000)
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
    expect(d.waitForQuiet).not.toHaveBeenCalledWith('pane-1', 1000, 8000)
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

  it('rolls back (kills the pane) and reports failure when injection fails', async () => {
    const d = deps({ injectPane: vi.fn(async () => false) })
    const ok = await injectStandaloneTask('pane-1', 'do the thing', 'mcp-task', d)
    expect(ok).toBe(false)
    expect(d.onKill).toHaveBeenCalledWith('pane-1')
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
    expect(evidence).toEqual({ echo: 'tail', submit: 'tail-left' })
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

  it('a prefill asks injectPane not to press Enter and is sent on its echo alone', async () => {
    const d = deps()
    const evidence: StandaloneKickoffEvidence = {}
    expect(await injectStandaloneTask('pane-1', 'sudo -v', 'mcp-task', d, { evidence, prefill: true })).toBe(true)
    expect(d.injectPane).toHaveBeenCalledWith('pane-1', 'sudo -v', 'mcp-task', true, evidence, true)
    expect(standaloneKickoffVerdict({ echo: 'tail' }, { task: 'sudo -v', prefill: true }).kickoff).toBe('sent')
    expect(standaloneKickoffVerdict({}, { task: 'sudo -v', prefill: true }).kickoff).toBe('unverified')
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
