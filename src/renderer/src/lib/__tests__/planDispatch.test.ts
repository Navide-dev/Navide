import { describe, it, expect, vi } from 'vitest'
import {
  validatePlanDispatch,
  pickReusablePane,
  runReportedDispatch,
  type PlanDispatchOutcome,
  type ReusablePaneCandidate,
} from '../planDispatch'

const WS = '/Users/dev/project'

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_path: WS,
    rel_path: '.agent-team/plans/my-plan_a1b2c3.html',
    agent_key: 'claude',
    ...overrides,
  }
}

describe('lib/planDispatch validatePlanDispatch', () => {
  it('accepts a valid payload for the current workspace', () => {
    expect(validatePlanDispatch(payload(), WS)).toEqual({
      relPath: '.agent-team/plans/my-plan_a1b2c3.html',
      agentKey: 'claude',
    })
  })

  it('accepts every known CLI agent key', () => {
    for (const key of ['claude', 'codex', 'antigravity', 'grok']) {
      expect(validatePlanDispatch(payload({ agent_key: key }), WS)?.agentKey).toBe(key)
    }
  })

  it('ignores null/undefined payloads', () => {
    expect(validatePlanDispatch(null, WS)).toBeNull()
    expect(validatePlanDispatch(undefined, WS)).toBeNull()
  })

  it('ignores missing or non-string fields', () => {
    expect(validatePlanDispatch(payload({ rel_path: undefined }), WS)).toBeNull()
    expect(validatePlanDispatch(payload({ workspace_path: 42 }), WS)).toBeNull()
    expect(validatePlanDispatch(payload({ agent_key: null }), WS)).toBeNull()
    expect(validatePlanDispatch(payload({ rel_path: '' }), WS)).toBeNull()
    expect(validatePlanDispatch(payload({ agent_key: '   ' }), WS)).toBeNull()
  })

  it('ignores a dispatch for a different (or nonexistent) workspace', () => {
    expect(validatePlanDispatch(payload({ workspace_path: '/Users/dev/other' }), WS)).toBeNull()
    expect(validatePlanDispatch(payload(), '/Users/dev/other')).toBeNull()
  })

  it('matches workspaces despite trailing slashes and surrounding whitespace', () => {
    expect(validatePlanDispatch(payload({ workspace_path: `${WS}/` }), WS)).not.toBeNull()
    expect(validatePlanDispatch(payload(), `${WS}//`)).not.toBeNull()
    expect(validatePlanDispatch(payload({ workspace_path: ` ${WS} ` }), WS)).not.toBeNull()
  })

  it('ignores unknown agent keys and the terminal pseudo-agent', () => {
    expect(validatePlanDispatch(payload({ agent_key: 'gemini' }), WS)).toBeNull()
    expect(validatePlanDispatch(payload({ agent_key: 'terminal' }), WS)).toBeNull()
  })
})

describe('lib/planDispatch pickReusablePane', () => {
  function pane(overrides: Partial<ReusablePaneCandidate> & { id: string }): ReusablePaneCandidate & { id: string } {
    return {
      agentKey: 'claude',
      workspacePath: WS,
      status: 'idle',
      sessionId: `pty-${overrides.id}`,
      ...overrides,
    }
  }

  it('picks an idle same-agent pane in the same workspace', () => {
    const idle = pane({ id: 'b' })
    const picked = pickReusablePane([pane({ id: 'a', status: 'running' }), idle], 'claude', WS)
    expect(picked?.id).toBe('b')
  })

  it('skips busy, dead, and other-agent panes', () => {
    const panes = [
      pane({ id: 'busy', status: 'running' }),
      pane({ id: 'starting', status: 'starting' }),
      pane({ id: 'dead', status: 'exited' }),
      pane({ id: 'errored', status: 'error' }),
      pane({ id: 'no-session', sessionId: undefined }),
      pane({ id: 'other-agent', agentKey: 'codex' }),
      pane({ id: 'other-ws', workspacePath: '/Users/dev/other' }),
    ]
    expect(pickReusablePane(panes, 'claude', WS)).toBeNull()
  })

  // A CLI sign-in pane sits at the CLI's sign-in wizard: a plan prompt typed
  // into it would land in the wizard. Only the user types into one.
  it('never picks a CLI sign-in pane, and picks the next idle pane instead', () => {
    const login = pane({ id: 'login', isLogin: true })
    const idle = pane({ id: 'b' })
    expect(pickReusablePane([login, idle], 'claude', WS)?.id).toBe('b')
    expect(pickReusablePane([login], 'claude', WS)).toBeNull()
  })

  it('matches pane workspace despite a trailing slash', () => {
    const idle = pane({ id: 'slash', workspacePath: `${WS}/` })
    expect(pickReusablePane([idle], 'claude', WS)?.id).toBe('slash')
  })

  it('returns null when there are no panes', () => {
    expect(pickReusablePane([], 'claude', WS)).toBeNull()
  })
})

describe('lib/planDispatch runReportedDispatch', () => {
  it('reports success without a reason', async () => {
    const report = vi.fn()
    await runReportedDispatch(async () => ({ ok: true }), report)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(true, undefined)
  })

  it('reports each explicit failure with its reason', async () => {
    for (const reason of ['pane-spawn-failed', 'pane-exited', 'inject-failed'] as const) {
      const report = vi.fn()
      const outcome: PlanDispatchOutcome = { ok: false, reason }
      await runReportedDispatch(async () => outcome, report)
      expect(report).toHaveBeenCalledTimes(1)
      expect(report).toHaveBeenCalledWith(false, reason)
    }
  })

  it('reports a thrown attempt as a failure with reason "error"', async () => {
    const report = vi.fn()
    await runReportedDispatch(async () => {
      throw new Error('boom')
    }, report)
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(false, 'error')
  })
})
