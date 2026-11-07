import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { resolveReadySpawnGroupId } from '../../lib/runGroups'
import { standaloneKickoffVerdict } from '../../lib/standalonePaneTask'

const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function appFunction(name: string): string {
  const sync = source.indexOf(`function ${name}(`)
  const start = source.slice(sync - 6, sync) === 'async ' ? sync - 6 : sync
  return source.slice(start, source.indexOf('\n}\n', start) + 2)
}

// Execute the real event adapter, spawn orchestration and persistence payloads.
// Only PTY, messaging and task injection are replaced, so tests never open a CLI.
function harness() {
  const names = ['runGroupsOf', 'resumableGroupId', 'assertRequestedSpawnGroup', 'isLocalWorkspace',
    'createRequestedPane', 'createStandaloneRequestedPane', 'handleMcpSpawnRequest']
  const functions = names.map(appFunction).join('\n')
  const eventStart = source.indexOf("backend.on('agent_spawn.request'")
  const eventHandler = source.slice(eventStart, source.indexOf('\n})\n', eventStart) + 3)
  const parent = { id: 'parent', workspacePath: '/alpha', runGroupId: 'rg-parent', messagingName: 'lead' }
  const panes: { value: Record<string, unknown>[] } = { value: [parent] }
  const callbacks = new Map<string, (event: Record<string, unknown>) => void>()
  const backend = {
    on: (name: string, callback: (event: Record<string, unknown>) => void) => callbacks.set(name, callback),
    send: vi.fn(async (_kind: string, _payload: Record<string, unknown>) => ({})),
  }
  const spawnPane = vi.fn(async (opts: Record<string, unknown>) => {
    panes.value.push({ id: 'child', messagingName: 'worker', ...opts })
    return 'child'
  })
  const sendQuiet = vi.fn(async () => ({}))
  const injectStandaloneTask = vi.fn(async () => true)
  const kickoffRequestedPane = vi.fn(async () => true)
  const deps = {
    panes, backend, spawnPane, sendQuiet, injectStandaloneTask, kickoffRequestedPane,
    runGroups: { value: [{ id: 'rg-active' }, { id: 'rg-parent' }, { id: 'rg-alpha' }] },
    runGroupsByWorkspace: { value: { '/beta': [{ id: 'rg-beta' }] } },
    currentWorkspace: { value: '/alpha' }, workspaceOrder: { value: ['/alpha', '/beta'] },
    activeTab: { value: 'rg-active' }, runGroupsReady: { value: true },
    normWs: (path: string) => path.replace(/\/+$/, ''), resolveReadySpawnGroupId,
    mcpSpawnCommandOverride: (req: { sessionId?: string }) => req.sessionId ? `codex resume ${req.sessionId}` : '',
    standaloneTaskDeps: () => ({}), standaloneKickoffVerdict,
    evaluateSpawnRequest: (req: Record<string, unknown>) => ({ ok: true, ...req, agentKey: req.agent }),
    spawnGateContextFor: () => ({}), standaloneSpawnGateContext: () => ({}),
    recordDiagnostic: vi.fn(), notifyRestore: { toast: vi.fn() },
    i18n: { global: { t: (key: string) => key } }, sendSpawnFeedback: vi.fn(),
    seenSpawnRequestIds: new Set(), SEEN_SPAWN_REQUEST_IDS_CAP: 200,
  }
  const javascript = ts.transpileModule(`${functions}\n${eventHandler}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function(...Object.keys(deps), javascript)(...Object.values(deps))
  async function open(extra: Record<string, unknown> = {}) {
    callbacks.get('agent_spawn.request')!({
      request_id: 'request-1', requester_pane_id: 'parent', agent_key: 'codex',
      name: 'worker', task: 'review', ...extra,
    })
    await vi.waitFor(() => expect(backend.send).toHaveBeenCalledWith(
      'agent_spawn.result', expect.objectContaining({ request_id: 'request-1' }),
    ))
    return backend.send.mock.calls.find(([kind]) => kind === 'agent_spawn.result')?.[1] as
      { ok: boolean; error: string }
  }
  return { open, spawnPane, sendQuiet, injectStandaloneTask, kickoffRequestedPane, deps }
}

describe('MCP spawn tab placement', () => {
  it('keeps the parent group when omitted, even when a different tab is active', async () => {
    const h = harness()
    expect((await h.open()).ok).toBe(true)
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({ runGroupId: 'rg-parent', spawnedBy: 'parent' }))
  })

  it.each(['', 'rg-alpha'])('places a child directly into the requested group %j and persists it', async (group) => {
    const h = harness()
    expect((await h.open({ run_group_id: group })).ok).toBe(true)
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({ runGroupId: group, spawnedBy: 'parent' }))
    expect(h.sendQuiet).toHaveBeenCalledWith('manual_pane.spawn', expect.objectContaining({ run_group_id: group }))
  })

  it.each(['', 'rg-alpha'])('overrides a resumed group %j while preserving its original parent', async (group) => {
    const h = harness()
    expect((await h.open({ run_group_id: group, session_id: 'session-1',
      resume_spawned_by: 'original-parent', resume_run_group_id: 'rg-parent' })).ok).toBe(true)
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({
      runGroupId: group, spawnedBy: 'original-parent', isResume: true, resumeSessionId: 'session-1',
    }))
    expect(h.sendQuiet).toHaveBeenCalledWith('manual_pane.spawn', expect.objectContaining({
      run_group_id: group, spawned_by: 'original-parent', session_id: 'session-1',
    }))
  })

  it('keeps a saved resume group when no override was given', async () => {
    const h = harness()
    await h.open({ session_id: 'session-1', resume_spawned_by: '', resume_run_group_id: 'rg-alpha' })
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({ runGroupId: 'rg-alpha', spawnedBy: '' }))
  })

  it('validates a background caller against its own groups', async () => {
    const h = harness()
    h.deps.panes.value[0].workspacePath = '/beta'
    expect((await h.open({ run_group_id: 'rg-beta' })).ok).toBe(true)
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: '/beta', runGroupId: 'rg-beta' }))
  })

  it.each(['rg-missing', 'rg-beta'])('refuses an unknown/foreign child group %s before any side effects', async (group) => {
    const h = harness()
    const result = await h.open({ run_group_id: group })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('run group')
    expect(h.spawnPane).not.toHaveBeenCalled()
    expect(h.sendQuiet).not.toHaveBeenCalled()
    expect(h.kickoffRequestedPane).not.toHaveBeenCalled()
    expect(h.injectStandaloneTask).not.toHaveBeenCalled()
  })

  it('keeps the viewed tab default for a standalone spawn in that workspace', async () => {
    const h = harness()
    await h.open({ requester_pane_id: '', target_workspace: '/alpha' })
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({ runGroupId: 'rg-active' }))
  })

  it.each(['', 'rg-beta'])('places a background workspace standalone pane into its requested group %j', async (group) => {
    const h = harness()
    expect((await h.open({ requester_pane_id: '', target_workspace: '/beta', run_group_id: group })).ok).toBe(true)
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/beta', runGroupId: group || undefined,
    }))
    expect(h.sendQuiet).toHaveBeenCalledWith('manual_pane.spawn', expect.objectContaining({
      workspace_path: '/beta', run_group_id: group,
    }))
  })

  it('rejects the viewed workspace group for a background workspace before creating a pane', async () => {
    const h = harness()
    expect((await h.open({ requester_pane_id: '', target_workspace: '/beta', run_group_id: 'rg-active' })).ok).toBe(false)
    expect(h.spawnPane).not.toHaveBeenCalled()
    expect(h.sendQuiet).not.toHaveBeenCalled()
  })

  it('restores a background workspace resume group unless explicitly overridden', async () => {
    const h = harness()
    await h.open({ requester_pane_id: '', target_workspace: '/beta', session_id: 'session-1',
      resume_spawned_by: 'original-parent', resume_run_group_id: 'rg-beta' })
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({ runGroupId: 'rg-beta', spawnedBy: 'original-parent' }))
  })

  it.each(['', 'rg-beta'])('overrides the group on a standalone resume with %j', async (group) => {
    const h = harness()
    await h.open({ requester_pane_id: '', target_workspace: '/beta', session_id: 'session-1',
      resume_spawned_by: 'original-parent', resume_run_group_id: 'rg-missing', run_group_id: group })
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({
      runGroupId: group || undefined, spawnedBy: 'original-parent', isResume: true,
    }))
    expect(h.sendQuiet).toHaveBeenCalledWith('manual_pane.spawn', expect.objectContaining({ run_group_id: group }))
  })
})

describe('explicit group validation after asynchronous spawn preparation', () => {
  it.each([
    { requested: 'rg-beta', deleted: true, error: 'unknown run group' },
    { requested: 'rg-beta', deleted: false, error: 'command-resolution-reached' },
    { requested: undefined, deleted: true, error: 'command-resolution-reached' },
    { requested: '', deleted: true, error: 'command-resolution-reached' },
  ])('checks $requested after preparation (deleted=$deleted)', async ({ requested, deleted, error }) => {
    let groups = [{ id: 'rg-beta' }]
    const resolveCommand = vi.fn(() => { throw new Error('command-resolution-reached') })
    const deps = {
      crypto: { randomUUID: () => 'child' },
      agentSpecs: [{ agentKey: 'aider', paneArg: () => '' }],
      paneHistoryRootFor: vi.fn(async () => {
        if (deleted) groups = []
        return '/history'
      }),
      runGroupsOf: () => groups, resolveCommand,
      webPaneSiteForAgentKey: () => undefined, // not a web pane
    }
    const javascript = ts.transpileModule(
      ['assertRequestedSpawnGroup', 'spawnPane'].map(appFunction).join('\n'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText
    const spawn = new Function(...Object.keys(deps), `${javascript}; return spawnPane`)(...Object.values(deps))
    await expect(spawn({ agentKey: 'aider', workspacePath: '/beta', runGroupId: 'rg-beta',
      requestedRunGroupId: requested })).rejects.toThrow(error)
    expect(deps.paneHistoryRootFor).toHaveBeenCalledOnce()
    if (error === 'unknown run group') expect(resolveCommand).not.toHaveBeenCalled()
    else expect(resolveCommand).toHaveBeenCalledOnce()
  })
})
