import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { resolveReadySpawnGroupId } from '../../lib/runGroups'

// cli_open_agent from a pane naming another project: the window holding that
// project creates the child, parents it on the requester — which may live in
// another workspace or window — and has it report to the requester's
// `<folder>/<pane>` address.

const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function appFunction(name: string): string {
  const sync = source.indexOf(`function ${name}(`)
  const start = source.slice(sync - 6, sync) === 'async ' ? sync - 6 : sync
  return source.slice(start, source.indexOf('\n}\n', start) + 2)
}

function registeredCommand(id: string): string {
  const start = source.indexOf(`registerCommand('${id}'`)
  return source.slice(start, source.indexOf('\n})\n', start) + 3)
}

function spawnHarness(opts: { panes?: Record<string, unknown>[]; held?: string[] } = {}) {
  const names = ['runGroupsOf', 'resumableGroupId', 'assertRequestedSpawnGroup', 'isLocalWorkspace',
    'createRequestedPane', 'createStandaloneRequestedPane', 'handleMcpSpawnRequest']
  const functions = names.map(appFunction).join('\n')
  const eventStart = source.indexOf("backend.on('agent_spawn.request'")
  const eventHandler = source.slice(eventStart, source.indexOf('\n})\n', eventStart) + 3)
  const panes: { value: Record<string, unknown>[] } = { value: [...(opts.panes ?? [])] }
  const callbacks = new Map<string, (event: Record<string, unknown>) => void>()
  const backend = {
    on: (name: string, callback: (event: Record<string, unknown>) => void) => callbacks.set(name, callback),
    send: vi.fn(async (_kind: string, _payload: Record<string, unknown>) => ({})),
  }
  const spawnPane = vi.fn(async (o: Record<string, unknown>) => {
    panes.value.push({ id: 'child', messagingName: 'reviewer', ...o })
    return 'child'
  })
  const sendQuiet = vi.fn(async () => ({}))
  const kickoffRequestedPane = vi.fn(async () => true)
  const deps = {
    panes, backend, spawnPane, sendQuiet, injectStandaloneTask: vi.fn(async () => true), kickoffRequestedPane,
    runGroups: { value: [] }, runGroupsByWorkspace: { value: {} },
    currentWorkspace: { value: (opts.held ?? ['/beta'])[0] }, workspaceOrder: { value: opts.held ?? ['/beta'] },
    activeTab: { value: '' }, runGroupsReady: { value: true },
    normWs: (path: string) => path.replace(/\/+$/, ''), resolveReadySpawnGroupId,
    mcpSpawnCommandOverride: () => '',
    standaloneTaskDeps: () => ({}),
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
  function emit(extra: Record<string, unknown> = {}) {
    callbacks.get('agent_spawn.request')!({
      request_id: 'request-1', requester_pane_id: 'lead-id', agent_key: 'claude',
      name: 'reviewer', task: 'review', target_workspace: '/beta', cross_workspace: true,
      parent_address: 'alpha/lead', ...extra,
    })
  }
  async function open(extra: Record<string, unknown> = {}) {
    emit(extra)
    await vi.waitFor(() => expect(backend.send).toHaveBeenCalledWith(
      'agent_spawn.result', expect.objectContaining({ request_id: 'request-1' }),
    ))
    return backend.send.mock.calls.find(([kind]) => kind === 'agent_spawn.result')?.[1] as
      { ok: boolean; error: string }
  }
  return { emit, open, spawnPane, sendQuiet, kickoffRequestedPane, backend }
}

describe('cross-workspace spawn', () => {
  it('creates the child in the target project, parented on a requester this window does not have', async () => {
    const h = spawnHarness()
    expect((await h.open()).ok).toBe(true)
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: '/beta', spawnedBy: 'lead-id' }))
    expect(h.sendQuiet).toHaveBeenCalledWith('manual_pane.spawn', expect.objectContaining({
      workspace_path: '/beta', spawned_by: 'lead-id',
    }))
  })

  it('has the child report to the requester\'s qualified address, armed even though it is not local', async () => {
    const h = spawnHarness()
    await h.open()
    await vi.waitFor(() => expect(h.kickoffRequestedPane).toHaveBeenCalled())
    expect(h.kickoffRequestedPane).toHaveBeenCalledWith(
      'child', 'alpha/lead', 'review', 'request-1', expect.objectContaining({ crossParent: true }),
    )
  })

  it('puts the child in the target project even when the requester sits in the same window', async () => {
    const h = spawnHarness({
      held: ['/alpha', '/beta'],
      panes: [{ id: 'lead-id', workspacePath: '/alpha', runGroupId: 'rg-alpha', messagingName: 'lead' }],
    })
    expect((await h.open()).ok).toBe(true)
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: '/beta', spawnedBy: 'lead-id' }))
    expect(h.spawnPane).not.toHaveBeenCalledWith(expect.objectContaining({ runGroupId: 'rg-alpha' }))
  })

  it('stays silent in a window that does not hold the target project', async () => {
    const h = spawnHarness({ held: ['/gamma'] })
    h.emit()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.backend.send).not.toHaveBeenCalled()
    expect(h.spawnPane).not.toHaveBeenCalled()
  })
})

describe('ui.workspace.adopt', () => {
  function adoptHarness(opts: { local?: string[]; holder?: string; detached?: boolean } = {}) {
    const local = new Set(opts.local ?? [])
    const commands = new Map<string, (args: unknown) => Promise<unknown>>()
    const adoptWorkspace = vi.fn((path: string) => local.add(path))
    const deps = {
      registerCommand: (id: string, fn: (args: unknown) => Promise<unknown>) => commands.set(id, fn),
      isLocalWorkspace: (path: string) => local.has(path),
      isDetachedWindow: opts.detached ?? false,
      adoptWorkspace,
      window: { agentTeam: { workspaceHolder: async () => opts.holder ?? '' } },
    }
    const javascript = ts.transpileModule(registeredCommand('ui.workspace.adopt'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    new Function(...Object.keys(deps), javascript)(...Object.values(deps))
    return { run: (args: unknown) => commands.get('ui.workspace.adopt')!(args), adoptWorkspace }
  }

  it('takes a project no window holds, without switching to it', async () => {
    const h = adoptHarness()
    await expect(h.run({ path: '/beta' })).resolves.toEqual({ prepared: 'adopted' })
    expect(h.adoptWorkspace).toHaveBeenCalledWith('/beta')
  })

  it('reports a project it already holds as already open', async () => {
    const h = adoptHarness({ local: ['/beta'] })
    await expect(h.run({ path: '/beta' })).resolves.toEqual({ prepared: 'already-open' })
    expect(h.adoptWorkspace).not.toHaveBeenCalled()
  })

  it('refuses a project another window holds, naming that window', async () => {
    const h = adoptHarness({ holder: 'Navide — beta' })
    await expect(h.run({ path: '/beta' })).rejects.toThrow(/^workspace-in-other-window: Navide — beta/)
    expect(h.adoptWorkspace).not.toHaveBeenCalled()
  })

  it('refuses in a detached group window', async () => {
    const h = adoptHarness({ detached: true })
    await expect(h.run({ path: '/beta' })).rejects.toThrow(/^window-cannot-hold/)
  })
})

describe('the stand-in report to a parent in another workspace', () => {
  function settleHarness() {
    const child: Record<string, unknown> = { id: 'child', spawnedByName: 'alpha/lead', spawnReportPending: true, spawnedCrossWorkspace: true }
    const sendMessage = vi.fn()
    const deps = {
      panes: { value: [child] },
      persistPaneReportDebt: vi.fn(),
      isBroadcastTarget: () => false,
      renderFallbackReport: (text: string) => `fallback: ${text}`,
      messaging: { sendMessage },
    }
    const javascript = ts.transpileModule(`${appFunction('settleSpawnReport')}\nreturn settleSpawnReport`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    const settle = new Function(...Object.keys(deps), javascript)(...Object.values(deps))
    return { settle, sendMessage, child }
  }

  it('is not sent across projects for a parent whose name merely contains a slash', () => {
    // Review #546 MED-3: only the cross-workspace spawn marks a parent as
    // living in another project; the shape of a name proves nothing.
    const h = settleHarness()
    h.child.spawnedCrossWorkspace = undefined
    h.settle('child', 'reviewer', 'done', [])
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it('goes to the qualified address though no local pane answers to it', () => {
    const h = settleHarness()
    h.settle('child', 'reviewer', 'done', [])
    expect(h.sendMessage).toHaveBeenCalledWith('reviewer', 'alpha/lead', 'fallback: done', { kind: 'fallback' })
  })
})
