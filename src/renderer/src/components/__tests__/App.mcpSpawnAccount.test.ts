import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { resolveReadySpawnGroupId } from '../../lib/runGroups'

// cli_open_agent's `account` (plan mcp-pane-cli-usage_213031 P3). The backend
// resolves it to an explicit pin, `profile_id` on agent_spawn.request, and the
// window hands that pin to spawnPane: the same pin a 📌 pinned pane is spawned
// with, which runs a claude pane in that account's own folder. Without the key
// the spawn and the pane record must be exactly what they were before.

const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function appFunction(name: string): string {
  const sync = source.indexOf(`function ${name}(`)
  const start = source.slice(sync - 6, sync) === 'async ' ? sync - 6 : sync
  return source.slice(start, source.indexOf('\n}\n', start) + 2)
}

// The real event adapter, spawn orchestration and persistence payloads; only
// the PTY, messaging and task injection are replaced (as App.mcpSpawnGroup does).
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
  const sendQuiet = vi.fn(async (_kind: string, _payload: Record<string, unknown>) => ({}))
  const deps = {
    panes, backend, spawnPane, sendQuiet,
    injectStandaloneTask: vi.fn(async () => true), kickoffRequestedPane: vi.fn(async () => true),
    runGroups: { value: [{ id: 'rg-active' }, { id: 'rg-parent' }] },
    runGroupsByWorkspace: { value: {} },
    currentWorkspace: { value: '/alpha' }, workspaceOrder: { value: ['/alpha'] },
    activeTab: { value: 'rg-active' }, runGroupsReady: { value: true },
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
  async function open(extra: Record<string, unknown> = {}) {
    callbacks.get('agent_spawn.request')!({
      request_id: 'request-1', requester_pane_id: 'parent', agent_key: 'claude',
      name: 'worker', task: 'review', ...extra,
    })
    await vi.waitFor(() => expect(backend.send).toHaveBeenCalledWith(
      'agent_spawn.result', expect.objectContaining({ request_id: 'request-1' }),
    ))
  }
  const record = () => sendQuiet.mock.calls.find(([kind]) => kind === 'manual_pane.spawn')?.[1] as
    Record<string, unknown>
  return { open, spawnPane, record }
}

describe('MCP spawn account pin', () => {
  it('spawns and records exactly as before when the request carries no pin', async () => {
    const h = harness()
    await h.open()
    expect(h.spawnPane.mock.calls[0][0].profileId).toBeUndefined()
    expect(h.record()).not.toHaveProperty('profile_id')
  })

  it('hands a pin to spawnPane and keeps it in the pane record', async () => {
    const h = harness()
    await h.open({ profile_id: 'a14' })
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'a14', spawnedBy: 'parent' }))
    expect(h.record()).toEqual(expect.objectContaining({ profile_id: 'a14' }))
  })

  it('does the same for a standalone spawn', async () => {
    const h = harness()
    await h.open({ requester_pane_id: '', target_workspace: '/alpha', profile_id: 'a15' })
    expect(h.spawnPane).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'a15', workspacePath: '/alpha' }))
    expect(h.record()).toEqual(expect.objectContaining({ profile_id: 'a15' }))
  })

  it('treats a blank pin as none', async () => {
    const h = harness()
    await h.open({ profile_id: '  ' })
    expect(h.spawnPane.mock.calls[0][0].profileId).toBeUndefined()
    expect(h.record()).not.toHaveProperty('profile_id')
  })
})
