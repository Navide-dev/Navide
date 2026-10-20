// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ui.window.close / ui.workspace.close are the window side of the MCP
// window_close / workspace_close tools (DESIGN-C S4a). The caller's own
// window and workspace are refused before these run (backend
// _self_scope_refusal and the bus's selfCloseRefusal, S1); what is pinned
// here is what the commands themselves add. App.vue cannot be mounted by the
// suite, so the registrations are asserted against the source, like the other
// App.*.test.ts files; main's closeSelf handler is checked the same way.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
const hostSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/NotificationHost.vue'), 'utf8')

function block(source: string, marker: string): string {
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n})\n', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('ui.window.close', () => {
  const body = block(appSource, "registerCommand('ui.window.close'")

  it('acts only when the id names this very page', () => {
    expect(body).toContain('a.windowId !== WINDOW_INSTANCE_ID')
    expect(body).toContain("throw new Error(`unknown-window:")
  })

  it('refuses while a pipeline runs, before letting anything go', () => {
    const guard = body.indexOf("if (pipeline.state === 'running')")
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(body.indexOf('dropWorkspacePanes(path)'))
    expect(body).toContain('pipeline-running:')
  })

  it('ends no CLI: the panes are let go of, never killed', () => {
    expect(body).toContain('dropWorkspacePanes(path)')
    expect(body).not.toContain('onKill')
    expect(body).not.toContain('closeWorkspace(')
    expect(body).not.toContain('terminal.kill')
  })

  it('closes itself only after answering, through the window itself', () => {
    expect(body).toContain('setTimeout(() => { void window.agentTeam?.closeSelf?.() }, 300)')
  })

  it('leaves a detached group window to hand its group back', () => {
    expect(body).toContain('if (!isDetachedWindow) for (const path of held) dropWorkspacePanes(path)')
    expect(body).toContain('reattached_to_main: true')
  })
})

describe('ui.workspace.close', () => {
  const body = block(appSource, "registerCommand('ui.workspace.close'")

  it('requires path, so an empty one never means the project on screen', () => {
    expect(body).toContain("if (!path) throw new Error('path-required:")
    expect(body).not.toContain('currentWorkspace.value')
  })

  it('closes only a project this window holds', () => {
    expect(body).toContain('workspaceOrder.value.find((w) => normWs(w) === normWs(path))')
    expect(body).toContain('workspace-not-open:')
  })

  it('never empties the window', () => {
    expect(body).toContain('workspaceOrder.value.length < 2')
    expect(body).toContain('last-workspace:')
  })

  it('keeps the CLIs running by default', () => {
    expect(body).toContain('await closeWorkspaceKeepPanes(held)')
  })

  it('ends the CLIs only after the user agrees, asked every time', () => {
    const ask = body.indexOf('notifyRestore.confirm(')
    const close = body.indexOf('await closeWorkspace(held, { confirmed: true })')
    expect(ask).toBeGreaterThan(-1)
    expect(close).toBeGreaterThan(ask)
    expect(body.slice(ask, close)).toContain("if (!agreed) throw new Error(`user-declined:")
    // Not gated on the user's "don't ask again" setting.
    expect(body).not.toContain('confirmBeforeCloseWorkspace')
    expect(body).toContain('danger: true')
  })

  it('gives up waiting before the backend does, as a no', () => {
    expect(body).toContain('notifyRestore.resolveDialog(false); resolve(false) }, 55_000)')
  })

  it('says which pane did it, with an undo when the CLIs kept running', () => {
    expect(body).toContain("i18n.global.t('msg.agent-closed-workspace-kept'")
    expect(body).toContain('run: () => adoptWorkspace(held)')
    expect(body).toContain("code: 'agent.window-action'")
  })
})

describe('closeWorkspace', () => {
  it('skips its own confirm only when the caller already asked', () => {
    expect(appSource).toContain('async function closeWorkspace(path: string, opts: { confirmed?: boolean } = {}): Promise<void> {')
    expect(appSource).toContain('if (confirmBeforeCloseWorkspace.value && !opts.confirmed) {')
  })
})

describe('agent.window_action', () => {
  it('shows the caller window what its agent closed, with an undo that reopens each project', () => {
    const start = appSource.indexOf("backend.on('agent.window_action'")
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf("backend.on('agent_spawn.request'", start))
    expect(body).toContain("i18n.global.t('msg.agent-closed-window'")
    expect(body).toContain('openMainWindow?.({ workspace_path: p })')
  })
})

describe('window:closeSelf (main)', () => {
  const body = block(mainSource, "ipcMain.handle('window:closeSelf'")

  it('closes the sender window and takes no window argument', () => {
    expect(body).toContain("ipcMain.handle('window:closeSelf', (event) => {")
    expect(body).toContain('BrowserWindow.fromWebContents(event.sender)')
    expect(body).toContain('!mainWindows.has(win)')
    // close(), not destroy(): the last-window guard still sees it.
    expect(body).toContain('win.close()')
    expect(body).not.toContain('destroy()')
  })
})

describe('toast action button', () => {
  it('runs the action and dismisses the toast, without the toast click also firing', () => {
    expect(hostSource).toContain('@click.stop="t.action.run(); dismissToast(t.id)"')
  })
})
