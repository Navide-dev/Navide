// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// Execute the real rebuildPaneViaResume with IO replaced at its boundaries.
// A claude pane pins `--session-id` at spawn but writes its transcript only on
// the first prompt, so a pane nobody typed in has nothing to resume: the
// single-pane account moves reopen it fresh instead of failing the preflight
// with "Session not found on disk".
const source = parse(readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('App.ts', source, ts.ScriptTarget.Latest, true)
const rebuildDecl = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === 'rebuildPaneViaResume'
)!
const rebuildJs = ts.transpileModule(rebuildDecl.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

function harness(sessionOnDisk: boolean | undefined) {
  const panes = ref<any[]>([{
    id: 'old', realized: true, agentKey: 'claude', agentLabel: 'Claude', workspacePath: '/ws',
    pinnedSessionId: 'sid-old', sessionOnDisk, profileId: 'acct-a', origin: 'manual',
  }])
  const scope = {
    panes,
    paneRefs: {},
    paneBusyForRebuild: () => false,
    notifyRestore: { toast: vi.fn(), confirm: vi.fn() },
    i18n: { global: { t: (key: string) => key } },
    paneResumeSessionId: (p: any) => p.pinnedSessionId ?? '',
    acquirePaneRebuildLock: () => () => {},
    rebuildingPanes: new Set<string>(),
    cancelStalePendingCreate: async () => {},
    pipelineLog: vi.fn(),
    canResumeSession: vi.fn(async (): Promise<boolean | null> => false),
    agentSpecs: [],
    skipFlagFor: () => '',
    buildResumeCommand: (_agent: string, sid: string) => `claude --resume ${sid}`,
    stagesApi: { stages: ref([]) },
    isPaneMuted: () => false,
    accountFollow: { has: () => false, remove: vi.fn(), add: vi.fn() },
    messagingHoldKey: () => null,
    onKill: vi.fn(async () => {}),
    spawnPane: vi.fn(async () => {
      panes.value.push({ id: 'new', pinnedSessionId: 'sid-new', profileId: 'acct-b' })
      return 'new'
    }),
    accountSpawnPin: (profileId: string) => profileId,
    followDirSignedIn: () => true,
    rekeyLineage: vi.fn(),
    setPaneMuted: vi.fn(),
    sendQuiet: vi.fn(async () => null),
    persistPaneMuted: vi.fn(),
  }
  const rebuild = new Function(...Object.keys(scope), `${rebuildJs}\nreturn rebuildPaneViaResume`)(
    ...Object.values(scope)
  ) as (paneId: string, opts?: Record<string, unknown>) => Promise<string | undefined>
  return { scope, rebuild }
}

describe('rebuildPaneViaResume on a pane with no transcript yet', () => {
  it('reopens fresh on the target account when the caller opts in and the probe says absent', async () => {
    const { scope, rebuild } = harness(undefined)
    const result = await rebuild('old', { profileId: 'acct-b', freshWhenNoTranscript: true })
    expect(result).toBeUndefined()
    expect(scope.canResumeSession).toHaveBeenCalledWith('claude', '/ws', 'sid-old')
    expect(scope.notifyRestore.toast).not.toHaveBeenCalled()
    expect(scope.spawnPane).toHaveBeenCalledWith(expect.objectContaining({
      commandOverride: '',
      isResume: false,
      skipRoleInjection: false,
      restoreMode: undefined,
      resumeSessionId: undefined,
      profileId: 'acct-b',
      replacePaneId: 'old',
    }))
    // The record follows the session the fresh spawn pinned, not the old id.
    expect(scope.sendQuiet).toHaveBeenCalledWith('manual_pane.spawn', expect.objectContaining({
      pane_id: 'new', previous_pane_id: 'old', session_id: 'sid-new', command: '', profile_id: 'acct-b',
    }))
  })

  it('still resumes a pane that has a transcript, even when the caller opts in', async () => {
    const { scope, rebuild } = harness(true)
    scope.canResumeSession.mockResolvedValueOnce(true)
    const result = await rebuild('old', { profileId: 'acct-b', freshWhenNoTranscript: true })
    expect(result).toBeUndefined()
    expect(scope.canResumeSession).toHaveBeenCalledWith('claude', '/ws', 'sid-old')
    expect(scope.spawnPane).toHaveBeenCalledWith(expect.objectContaining({
      commandOverride: 'claude --resume sid-old',
      isResume: true,
      resumeSessionId: 'sid-old',
    }))
    expect(scope.sendQuiet).toHaveBeenCalledWith('manual_pane.spawn', expect.objectContaining({
      session_id: 'sid-old',
    }))
  })

  it('resumes when the flag lags but the probe finds the transcript', async () => {
    // The first turn may still be running when the user moves the pane: the
    // in-memory flag has not caught up, the jsonl already exists. Reopening
    // fresh here would drop the conversation from the pane.
    const { scope, rebuild } = harness(undefined)
    scope.canResumeSession.mockResolvedValueOnce(true)
    const result = await rebuild('old', { profileId: 'acct-b', freshWhenNoTranscript: true })
    expect(result).toBeUndefined()
    expect(scope.spawnPane).toHaveBeenCalledWith(expect.objectContaining({
      commandOverride: 'claude --resume sid-old',
      isResume: true,
      resumeSessionId: 'sid-old',
    }))
  })

  it('never reopens fresh on a failed probe: it reports and leaves the pane running', async () => {
    const { scope, rebuild } = harness(undefined)
    scope.canResumeSession.mockResolvedValueOnce(null)
    const result = await rebuild('old', { profileId: 'acct-b', freshWhenNoTranscript: true })
    expect(result).toBe('probe-failed')
    expect(scope.notifyRestore.toast).toHaveBeenCalledWith('pane.terminal.rebuild-probe-failed', { type: 'error' })
    expect(scope.onKill).not.toHaveBeenCalled()
    expect(scope.spawnPane).not.toHaveBeenCalled()
  })

  it('a transcript the pane had and lost still refuses, even when the caller opts in', async () => {
    const { scope, rebuild } = harness(true)
    const result = await rebuild('old', { profileId: 'acct-b', freshWhenNoTranscript: true })
    expect(result).toBe('not-resumable')
    expect(scope.notifyRestore.toast).toHaveBeenCalledWith('pane.terminal.rebuild-not-resumable', { type: 'error' })
    expect(scope.onKill).not.toHaveBeenCalled()
  })

  it('without the opt-in keeps refusing, and leaves the pane running', async () => {
    const { scope, rebuild } = harness(undefined)
    const result = await rebuild('old', { profileId: 'acct-b' })
    expect(result).toBe('not-resumable')
    expect(scope.notifyRestore.toast).toHaveBeenCalledWith('pane.terminal.rebuild-not-resumable', { type: 'error' })
    expect(scope.onKill).not.toHaveBeenCalled()
    expect(scope.spawnPane).not.toHaveBeenCalled()
  })
})
