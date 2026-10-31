// Drift guard for UI_ACTION_SPECS, and proof ui.actions.describe adds to the
// bus without changing what ui_list_actions already answers.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeCommand, registerCommand } from '@navide/plugin-ui/shared'
import { _resetRegistry } from '@navide/plugin-ui/shared/testing'
import { DESTRUCTIVE_ACTIONS, describeUiAction, describeUiActions, UI_ACTION_SPECS } from '../uiActionCatalog'
import { handleUiInvokeRequest, type UiInvokeRequest } from '../useUiActionBus'

const RENDERER_SRC = join(process.cwd(), 'src', 'renderer', 'src')
const SERVER_PY = join(process.cwd(), 'backend', 'agent_team_backend', 'mcp_server', 'server.py')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === '__tests__') return []
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.(ts|vue)$/.test(entry) ? [full] : []
  })
}

function registeredUiIds(): Set<string> {
  const ids = new Set<string>()
  for (const file of sourceFiles(RENDERER_SRC)) {
    for (const m of readFileSync(file, 'latin1').matchAll(/registerCommand\('(ui\.[\w.]+)'/g)) ids.add(m[1])
  }
  return ids
}

describe('UI_ACTION_SPECS stays in step with the source', () => {
  it('has one entry per registered ui.* command, both ways', () => {
    expect(Object.keys(UI_ACTION_SPECS).sort()).toEqual([...registeredUiIds()].sort())
  })

  it("matches the backend's dedicated-tool refusals", () => {
    const server = readFileSync(SERVER_PY, 'utf8')
    const block = server.match(/_DEDICATED_CLOSE_ACTIONS = \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const backend = [...block.matchAll(/^\s+"([^"]+)": "([^"]+)",$/gm)].map((m) => [m[1], m[2]])
    expect(backend.length).toBeGreaterThan(0)
    for (const [action, tool] of backend) expect(describeUiAction(action).dedicatedTool).toBe(tool)
    const declared = Object.entries(UI_ACTION_SPECS).filter(([, s]) => s.dedicatedTool).map(([id]) => id)
    expect(declared.sort()).toEqual(backend.map(([a]) => a).filter((a) => a.startsWith('ui.')).sort())
  })

  it("matches the backend's human-only refusals", () => {
    const server = readFileSync(SERVER_PY, 'utf8')
    const fn = server.match(/def _human_only_refusal[\s\S]*?\n\n/)?.[0] ?? ''
    const body = server.slice(server.indexOf(fn), server.indexOf('error_code": "ui_human_only"'))
    const refused = [...body.matchAll(/action == "(ui\.[\w.]+)"/g)].map((m) => m[1])
    expect(refused.length).toBeGreaterThan(0)
    const declared = Object.entries(UI_ACTION_SPECS).filter(([, s]) => s.humanOnly).map(([id]) => id)
    expect(declared.sort()).toEqual([...refused].sort())
  })
})

describe('describeUiActions', () => {
  it('gives a ui.* id its contract', () => {
    expect(describeUiAction('ui.pane.create')).toEqual({
      id: 'ui.pane.create',
      title: 'Pane Create',
      category: 'External Control',
      args: '{agent, name?, task?}',
      summary: "Spawn a pane in the window's open workspace",
      workspaceScoped: true,
    })
  })

  it('marks what an agent will be refused', () => {
    expect(describeUiAction('ui.pane.sendKeys').humanOnly).toBe(true)
    expect(describeUiAction('ui.settings.yolo').humanOnly).toBe('yolo is true')
    expect(describeUiAction('ui.window.close').dedicatedTool).toBe('window_close')
    expect(describeUiAction('workbench.action.closeWindow').dedicatedTool).toBe('window_close')
  })

  it('promises nothing about an id with no documented contract', () => {
    expect(describeUiAction('workbench.action.showCommands')).toEqual({
      id: 'workbench.action.showCommands',
      title: 'Show Command Palette',
      category: 'Workbench',
      workspaceScoped: false,
    })
  })

  it('narrows by prefix and ignores one that is not a string', () => {
    const ids = ['ui.pane.close', 'ui.tab.switch']
    expect(describeUiActions(ids, 'ui.pane.').map((a) => a.id)).toEqual(['ui.pane.close'])
    expect(describeUiActions(ids, 7).map((a) => a.id)).toEqual(ids)
  })
})

describe('ui_list_actions is unchanged', () => {
  beforeEach(() => _resetRegistry())

  it('still answers plain ids with no catalog field', async () => {
    registerCommand('a.one', () => {})
    const send = vi.fn(async () => undefined)
    const req: UiInvokeRequest = {
      request_id: 'r', workspace_path: '/ws', op: 'list_actions', action: null, args: null, global: false,
    }
    await handleUiInvokeRequest(req, {
      backend: { send, on: () => {} },
      currentWorkspace: { value: '/ws' },
      buildSnapshot: () => ({}),
    })
    expect(send).toHaveBeenCalledWith('ui.invoke.result', {
      request_id: 'r', ok: true, result: ['a.one'], error: null,
    })
  })
})

describe('a Navide plugin command on the bus', () => {
  beforeEach(() => _resetRegistry())

  const request = (action: string, caller_pane_id = 'pane-1'): UiInvokeRequest => ({
    request_id: 'r', workspace_path: '/ws', op: 'invoke', action, args: null, global: false, caller_pane_id,
  })
  const deps = (isHumanOnlyCommand?: (action: string) => boolean) => {
    const send = vi.fn(async () => undefined)
    return {
      send,
      opts: {
        backend: { send, on: () => {} },
        currentWorkspace: { value: '/ws' },
        buildSnapshot: () => ({}),
        isHumanOnlyCommand,
      },
    }
  }
  const isPlugin = (action: string) => action.startsWith('acme.')

  it('is refused with ui_human_only and never runs', async () => {
    const handler = vi.fn()
    registerCommand('acme.runner.go', handler)
    const { send, opts } = deps(isPlugin)
    await handleUiInvokeRequest(request('acme.runner.go'), opts)
    expect(handler).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('ui.invoke.result', expect.objectContaining({ ok: false, code: 'ui_human_only' }))
  })

  it('is refused for a caller with no pane too', async () => {
    registerCommand('acme.runner.go', () => {})
    const { send, opts } = deps(isPlugin)
    await handleUiInvokeRequest(request('acme.runner.go', ''), opts)
    expect(send).toHaveBeenCalledWith('ui.invoke.result', expect.objectContaining({ ok: false, code: 'ui_human_only' }))
  })

  it('still runs from a key', () => {
    const handler = vi.fn()
    registerCommand('acme.runner.go', handler)
    expect(executeCommand('acme.runner.go')).toBe(true)
    expect(handler).toHaveBeenCalled()
  })

  it.each([[undefined], [isPlugin]])('leaves a ui.* action exactly as it was (%#)', async (rule) => {
    registerCommand('ui.tab.switch', () => 'switched')
    const { send, opts } = deps(rule)
    await handleUiInvokeRequest(request('ui.tab.switch'), opts)
    expect(send).toHaveBeenCalledWith('ui.invoke.result', { request_id: 'r', ok: true, result: 'switched', error: null })
  })

  it('is listed as humanOnly by ui.actions.describe', () => {
    const [row] = describeUiActions(['acme.runner.go'], undefined, () => ({ title: 'Go', category: 'Runner', humanOnly: true }))
    expect(row).toMatchObject({ id: 'acme.runner.go', title: 'Go', category: 'Runner', humanOnly: true })
  })
})

describe('DESTRUCTIVE_ACTIONS', () => {
  /** Reviewed and left out: closing a dialog or an editor tab loses nothing the
   *  editor would not ask about itself. */
  const HARMLESS = new Set([
    'ui.settings.close',
    'workbench.action.closeModal',
    'workbench.action.zoomUiReset',
  ])
  const RISKY = /close|reset|abort|restart|remove|delete|kill|rebuild|reclaim|quit|discard/i

  it('classifies every close or reset the main window registers', () => {
    const app = readFileSync(join(RENDERER_SRC, 'App.vue'), 'latin1')
    const risky = [...app.matchAll(/registerCommand\('([\w.]+)'/g)].map((m) => m[1]).filter((id) => RISKY.test(id))
    expect(risky.length).toBeGreaterThan(0)
    expect(risky.filter((id) => !DESTRUCTIVE_ACTIONS.has(id) && !HARMLESS.has(id))).toEqual([])
  })

  it('lists only ids the catalog can describe', () => {
    for (const id of DESTRUCTIVE_ACTIONS) expect(describeUiAction(id).destructive).toBe(true)
  })

  it('marks nothing else', () => {
    expect(describeUiAction('ui.pane.focus').destructive).toBeUndefined()
  })
})
