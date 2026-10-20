// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ui.window.describe / ui.window.focus are the window side of the MCP
// window_list / window_focus tools (DESIGN-C S3). The registrations live in
// App.vue, which the suite cannot mount, so they are asserted against the
// source the way the other App.*.test.ts files do; main's focusSelf handler
// is checked the same way.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
const preloadSource = readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8')

function block(source: string, marker: string): string {
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('\n})\n', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('ui.window.describe', () => {
  const body = block(appSource, "registerCommand('ui.window.describe'")

  it('names the window by the page-load id the backend knows it by', () => {
    expect(body).toContain('window_id: WINDOW_INSTANCE_ID')
    expect(appSource).toContain("import { WINDOW_INSTANCE_ID } from './lib/windowInstanceId'")
  })

  it('tells a detached group window from a main window', () => {
    expect(body).toContain("kind: isDetachedWindow ? 'detached-group' : 'main'")
    expect(body).toContain('detached_group: detachedGroupId')
  })

  it('lists every workspace the window holds, the one on screen included', () => {
    expect(body).toContain('[...workspaceOrder.value]')
    expect(body).toContain('held.unshift(currentWorkspace.value)')
    expect(body).toContain('on_screen: currentWorkspace.value')
  })

  it('lists its panes by id and workspace', () => {
    expect(body).toContain('pane_id: p.id')
    expect(body).toContain('workspace_path: p.workspacePath')
  })

  it('changes nothing', () => {
    expect(body).not.toContain('switchToWorkspace')
    expect(body).not.toContain('focusSelf')
  })
})

describe('ui.window.focus', () => {
  const body = block(appSource, "registerCommand('ui.window.focus'")

  it('switches only through ui.workspace.switch, so its refusals are the answer', () => {
    expect(body).toContain("invokeCommand('ui.workspace.switch', { path: a.workspace_path })")
    expect(body).toContain('if (!switched.ok) throw new Error(')
    expect(body).not.toContain('switchToWorkspace(')
  })

  it('switches before it focuses, and focuses through the window itself', () => {
    const sw = body.indexOf("invokeCommand('ui.workspace.switch'")
    const focus = body.indexOf('window.agentTeam?.focusSelf?.()')
    expect(sw).toBeGreaterThan(-1)
    expect(focus).toBeGreaterThan(sw)
  })

  it('says which pane did it, on screen and in diagnostics', () => {
    expect(body).toContain("i18n.global.t('msg.window-focused-by', { caller })")
    expect(body).toContain("code: 'agent.window-action'")
  })

  it('reports what was on screen before, for an undo', () => {
    expect(body).toContain('const previous = currentWorkspace.value')
    expect(body).toContain('previous_on_screen: previous')
  })
})

describe('window:focusSelf (main)', () => {
  const body = block(mainSource, "ipcMain.handle('window:focusSelf'")

  it('focuses the sender window and takes no window argument', () => {
    expect(body).toContain("ipcMain.handle('window:focusSelf', (event) => {")
    expect(body).toContain('BrowserWindow.fromWebContents(event.sender)')
    expect(body).toContain('revealMainWindow(win)')
  })

  it('acts only on a Navide main window', () => {
    expect(body).toContain('!mainWindows.has(win)')
  })

  it('is exposed by preload without arguments', () => {
    expect(preloadSource).toContain("focusSelf: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('window:focusSelf'),")
  })
})
