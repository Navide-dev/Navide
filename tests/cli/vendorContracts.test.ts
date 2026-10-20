import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLI_AGENT_SPECS } from '../../src/renderer/src/platform/plugin-shell/agents'
import { agentUsesBracketedPaste, encodeShiftEnter } from '../../src/renderer/src/platform/plugin-shell/agentProfile'
import { buildResumeCommand, normalizeResumeSessionId, paneRebuildVisible, sessionHomeIdFor } from '../../src/renderer/src/platform/plugin-shell/lib/resume-command'
import { modelArgsFor } from '../../src/renderer/src/platform/plugin-shell/lib/cliModel'
import { awaitingClearsOnMiss, hasAwaitingPattern, matchAwaitingInput } from '../../src/renderer/src/lib/cliAwaitingInput'

declare module 'vitest' {
  interface TaskMeta {
    cliContract?: string
  }
}

// Independently reviewed interactive contracts. Do not generate expected
// arguments or capabilities from AgentSpec: that would agree with any drift.
const contracts = [
  { key: 'claude', binary: 'claude', permission: '--dangerously-skip-permissions', resume: 'claude --resume session-123', model: true, effort: '--effort high', paste: true, fullScreen: true, silence: false },
  { key: 'codex', binary: 'codex', permission: '--dangerously-bypass-approvals-and-sandbox', resume: 'codex resume session-123', model: true, effort: null, paste: true, fullScreen: false, silence: false },
  { key: 'copilot', binary: 'copilot', permission: '--yolo', resume: 'copilot --resume=session-123', model: true, effort: '--reasoning-effort high', paste: false, fullScreen: true, silence: false },
  { key: 'cursor', binary: 'agent', permission: '--force', resume: 'agent --resume=session-123', model: true, effort: null, paste: false, fullScreen: false, silence: false },
  { key: 'droid', binary: 'droid', permission: '--auto high', resume: 'droid --resume session-123', model: false, effort: null, paste: true, fullScreen: false, silence: false },
  { key: 'antigravity', binary: 'agy', permission: '--dangerously-skip-permissions', resume: 'agy --conversation session-123', model: true, effort: '--effort high', paste: true, fullScreen: true, silence: false },
  { key: 'grok', binary: 'grok', permission: '', resume: 'grok -r session-123', model: true, effort: null, paste: true, fullScreen: false, silence: false },
  { key: 'kimi', binary: 'kimi', permission: '--yolo', resume: 'kimi --session session-123', model: true, effort: null, paste: true, fullScreen: false, silence: true },
  { key: 'opencode', binary: 'opencode', permission: '', resume: 'opencode --session session-123', model: true, effort: null, paste: false, fullScreen: true, silence: false },
  { key: 'kilo', binary: 'kilo', permission: '--auto', resume: 'kilo --session session-123', model: true, effort: null, paste: false, fullScreen: true, silence: false },
  { key: 'pi', binary: 'pi', permission: '', resume: 'pi --session-id session-123', model: true, effort: '--thinking high', paste: false, fullScreen: false, silence: true },
  { key: 'qwen', binary: 'qwen', permission: '--yolo', resume: 'qwen --resume session-123', model: true, effort: null, paste: false, fullScreen: true, silence: true },
  { key: 'aider', binary: 'aider', permission: '--yes-always', resume: 'aider --restore-chat-history', model: false, effort: null, paste: false, fullScreen: false, silence: false },
  { key: 'muse', binary: 'muse', permission: '--disable-approval', resume: 'muse resume session-123', model: true, effort: '--reasoning-effort high', paste: false, fullScreen: false, silence: false },
  { key: 'mcode', binary: 'mcode', permission: '', resume: null, model: false, effort: null, paste: false, fullScreen: false, silence: false },
] as const

describe('frontend CLI contract inventory', () => {
  it('matches the supported registry and backend regression catalog exactly', () => {
    const catalog = JSON.parse(readFileSync(resolve('tests/fixtures/cli-regression/catalog.json'), 'utf8'))
    const expected = contracts.map(({ key }) => key).sort()
    expect(CLI_AGENT_SPECS.map(({ agentKey }) => agentKey).sort()).toEqual(expected)
    expect(Object.keys(catalog.vendors).sort()).toEqual(expected)
  })

  for (const contract of contracts) {
    it(`frontend contract ${contract.key}`, ({ task }) => {
      expect.hasAssertions()
      const spec = CLI_AGENT_SPECS.find((candidate) => candidate.agentKey === contract.key)!
      expect(spec.defaultCommand).toBe(contract.binary)
      expect(spec.skipPermissionFlag ?? '').toBe(contract.permission)
      expect(modelArgsFor({ spec, request: { model: 'provider/model-1', effort: '' } })).toEqual(
        contract.model ? { ok: true, args: '--model provider/model-1' } : { ok: false, refusal: { kind: 'model-unsupported' } },
      )
      expect(modelArgsFor({ spec, request: { model: '', effort: 'high' } })).toEqual(
        contract.effort ? { ok: true, args: contract.effort } : { ok: false, refusal: { kind: 'effort-unsupported' } },
      )
      expect(modelArgsFor({ spec, request: { model: '', effort: '' } })).toEqual({ ok: true, args: '' })
      if (contract.model) {
        expect(modelArgsFor({ spec, request: { model: 'model;injected', effort: '' } })).toEqual({ ok: false, refusal: { kind: 'model-malformed' } })
      }
      if (contract.effort) {
        expect(modelArgsFor({ spec, request: { model: '', effort: 'not-a-level' } })).toMatchObject({ ok: false, refusal: { kind: 'effort-invalid' } })
      }
      if (contract.resume) {
        expect(buildResumeCommand(contract.key, 'session-123')).toBe(contract.resume)
        expect(buildResumeCommand(contract.key, 'session-123', contract.permission, '', { model: contract.model ? 'provider/model-1' : '', effort: '' }))
          .toBe([contract.resume, contract.permission, contract.model ? '--model provider/model-1' : ''].filter(Boolean).join(' '))
      } else {
        // No renderer UI path offers unsupported resume; the low-level builder
        // is deliberately not invoked with an invented mcode session ID.
        expect(spec.resumeArgs).toBeUndefined()
        expect(spec.resumeWithoutId).toBeUndefined()
        expect(paneRebuildVisible({ agentKey: contract.key })).toBe(false)
        expect(buildResumeCommand(contract.key, '')).toBe('')
      }
      expect(agentUsesBracketedPaste(contract.key)).toBe(contract.paste)
      expect(encodeShiftEnter(contract.key)).toBe(contract.key === 'codex' ? '\x1b[13;2u' : contract.paste ? '\x1b[200~\n\x1b[201~' : '\x16\x0a')
      expect(!!spec.fullScreenTui).toBe(contract.fullScreen)
      expect(!!spec.turnEndInferredFromSilence).toBe(contract.silence)
      task.meta.cliContract = contract.key
    })
  }
})

describe('vendor specific frontend session and prompt contracts', () => {
  it('preserves Codex home identity and repairs historical rollout filenames', () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(normalizeResumeSessionId('codex', `rollout-2026-08-11-${id}.jsonl`)).toBe(id)
    expect(sessionHomeIdFor('codex', 'new-pane', 'old-pane-home')).toBe('old-pane-home')
    expect(sessionHomeIdFor('codex', 'new-pane')).toBe('new-pane')
    expect(sessionHomeIdFor('claude', 'new-pane', 'old-pane-home')).toBe('')
  })

  it('recognizes Cursor aliases and Kimi uppercase short resume flag', () => {
    const cursor = CLI_AGENT_SPECS.find((spec) => spec.agentKey === 'cursor')!
    expect(cursor.resumeCommandPattern!.test('agent --resume=session-123')).toBe(true)
    expect(cursor.resumeCommandPattern!.test('cursor-agent --resume session-123')).toBe(true)
    expect(cursor.resumeCommandPattern!.test('grok --resume session-123')).toBe(false)
    const kimi = CLI_AGENT_SPECS.find((spec) => spec.agentKey === 'kimi')!
    expect(kimi.resumeCommandPattern!.test('kimi -S session-123')).toBe(true)
    expect(kimi.resumeCommandPattern!.test('kimi -s session-123')).toBe(false)
  })

  it('gives aider a quoted per-pane history file and ID-less restore', () => {
    const spec = CLI_AGENT_SPECS.find((entry) => entry.agentKey === 'aider')!
    expect(spec.paneArg!({ paneId: 'abcdef01-2345-6789-abcd-000000000000', historyRoot: '/workspace/my project' }))
      .toBe("--chat-history-file '/workspace/my project/.aider.chat.history.abcdef01.md'")
    expect(buildResumeCommand('aider', '', '', '/workspace/my project/.aider.chat.history.abcdef01.md'))
      .toBe("aider --chat-history-file '/workspace/my project/.aider.chat.history.abcdef01.md' --restore-chat-history")
  })

  it.each([
    ['claude', 'Enter to select · Tab to switch · Esc to cancel', false],
    ['codex', 'Would you like to run the following command?', true],
    ['antigravity', 'Question 1/2: choose an option', true],
    ['aider', 'Run shell command? (Y)es/(N)o [Yes]:', true],
    // Its folder-trust prompt, the one wait Grok Build shows as text (#402).
    ['grok', 'Do you trust the contents of this directory?\n/work\n  Yes, proceed   y\n  No, quit       n', true],
  ] as const)('recognizes %s awaiting input without treating completed prose as a live prompt', (key, screen, clearsOnMiss) => {
    expect(matchAwaitingInput(key, screen)).toBe(true)
    expect(matchAwaitingInput(key, 'Task completed.')).toBe(false)
    expect(awaitingClearsOnMiss(key)).toBe(clearsOnMiss)
  })

  it.each(['copilot', 'cursor', 'droid', 'kimi', 'opencode', 'kilo', 'pi', 'qwen', 'muse', 'mcode'])('does not invent a screen permission signal for %s', (key) => {
    expect(hasAwaitingPattern(key)).toBe(false)
    expect(matchAwaitingInput(key, 'Would you like to run the following command?')).toBe(false)
  })
})
