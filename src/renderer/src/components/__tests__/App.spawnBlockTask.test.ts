// A bare-line SPAWN block's task reaches manual_pane.spawn (0.2.51): the
// backend records a commander's dispatch from that call, and without the task
// the dispatch tree shows the pane with nothing to say what it is doing.
// Same technique as App.mcpSpawnGroup.test.ts: the real App functions run,
// only the PTY, messaging and kickoff are replaced.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { parseSpawns } from '../../lib/agentMessaging'
import { resolveReadySpawnGroupId } from '../../lib/runGroups'
import { notePaneRecordWrite } from '../../lib/restoreDiagnostics'

const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function appFunction(name: string): string {
  const sync = source.indexOf(`function ${name}(`)
  const start = source.slice(sync - 6, sync) === 'async ' ? sync - 6 : sync
  return source.slice(start, source.indexOf('\n}\n', start) + 2)
}

function harness() {
  const names = ['runGroupsOf', 'resumableGroupId', 'assertRequestedSpawnGroup',
    'createRequestedPane', 'spawnRequestedPane', 'handleSpawnRequestsForTurn']
  const parent = { id: 'parent', workspacePath: '/alpha', runGroupId: 'rg-parent', messagingName: 'lead' }
  const panes: { value: Record<string, unknown>[] } = { value: [parent] }
  const spawnPane = vi.fn(async (opts: Record<string, unknown>) => {
    panes.value.push({ id: 'child', messagingName: 'worker', ...opts })
    return 'child'
  })
  const sendQuiet = vi.fn(async () => ({}))
  const deps = {
    panes, spawnPane, sendQuiet, parseSpawns,
    kickoffRequestedPane: vi.fn(async () => true),
    evaluateTurnSpawns: (requests: { agentKey: string }[]) => requests.map((r) => ({ ok: true, ...r })),
    spawnGateContextFor: () => ({}),
    runGroups: { value: [{ id: 'rg-parent' }] },
    runGroupsByWorkspace: { value: {} },
    currentWorkspace: { value: '/alpha' }, activeTab: { value: 'rg-parent' }, runGroupsReady: { value: true },
    normWs: (path: string) => path.replace(/\/+$/, ''), resolveReadySpawnGroupId,
    mcpSpawnCommandOverride: () => '',
    recordDiagnostic: vi.fn(), notePaneRecordWrite, notifyRestore: { toast: vi.fn() },
    i18n: { global: { t: (key: string) => key } }, sendSpawnFeedback: vi.fn(),
  }
  const javascript = ts.transpileModule(`${names.map(appFunction).join('\n')}\nreturn handleSpawnRequestsForTurn`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const handle = new Function(...Object.keys(deps), javascript)(...Object.values(deps)) as
    (parentPaneId: string, parentName: string, text: string) => Promise<void>
  return { handle, sendQuiet }
}

describe('SPAWN block → manual_pane.spawn', () => {
  it('carries the task, next to opened_by, for the dispatch record', async () => {
    const h = harness()
    await h.handle('parent', 'lead', [
      '---SPAWN-START---',
      'agent: codex',
      'name: worker',
      'task: review fix/git-panel-poll',
      '---SPAWN-END---',
    ].join('\n'))
    expect(h.sendQuiet).toHaveBeenCalledWith('manual_pane.spawn', expect.objectContaining({
      pane_id: 'child', origin: 'mcp', opened_by: 'parent', task: 'review fix/git-panel-poll',
    }))
  })
})
