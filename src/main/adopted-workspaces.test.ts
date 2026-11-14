// A window's sidebar can take on workspaces beyond the one it was opened with.
// Main tracks those separately from the primary, because "already open
// somewhere" has to cover them: two windows on one folder run two sets of PTY
// and git operations on it, which is the thing the design exists to prevent.
//
// Source-scanned — the real thing needs live BrowserWindows.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

/** The body of a top-level `function name(...)` in main. */
function body(name: string): string {
  const at = mainSource.indexOf(`function ${name}(`)
  expect(at, `${name} not found`).toBeGreaterThan(-1)
  return mainSource.slice(at, mainSource.indexOf('\n}', at))
}

const registrySource = readFileSync(resolve(process.cwd(), 'src/main/window-registry.ts'), 'utf8')

describe('adopted workspaces', () => {
  it('are tracked apart from the window primary', () => {
    // Everything that means "this window's own workspace" — the registry, the
    // run-group hand-off, the titlebar — must keep meaning exactly that.
    expect(mainSource).toContain('const adoptedWorkspaces = new Map<BrowserWindow, string[]>()')
    expect(body('broadcastToWorkspace')).not.toContain('adoptedWorkspaces')
  })

  it('count as open when another window asks', () => {
    const find = body('findMainWindowForWorkspace')
    expect(find).toContain('adoptedWorkspaces')
    // The window whose primary it is wins: that is where its tabs, git and
    // explorer already point.
    expect(find.indexOf('mainWindowWorkspaces')).toBeLessThan(find.indexOf('adoptedWorkspaces'))
  })

  it("show up in Welcome's open badges", () => {
    const at = mainSource.indexOf("ipcMain.handle('workspace:listOpen'")
    expect(at).toBeGreaterThan(-1)
    const handler = mainSource.slice(at, mainSource.indexOf('\n})', at))
    expect(handler).toContain('adoptedWorkspaces')
  })

  it('are reported by the renderer and dropped with the window', () => {
    const at = mainSource.indexOf("ipcMain.on('window:reportAdoptedWorkspaces'")
    expect(at).toBeGreaterThan(-1)
    const handler = mainSource.slice(at, mainSource.indexOf('\n})', at))
    // Same two guards the workspace report has: only real main windows.
    expect(handler).toContain('mainWindows.has(win)')
    expect(handler).toContain('detachedWindowIds.has(win.id)')
    // An empty list clears the entry rather than storing [].
    expect(handler).toContain('adoptedWorkspaces.delete(win)')
    // Other windows' pickers need to hear about it.
    expect(handler).toContain('broadcastOpenWorkspacesChanged()')
    // And the map must not outlive the window: cleared alongside the primary.
    const teardown = mainSource.indexOf('mainWindows.delete(win)')
    expect(teardown).toBeGreaterThan(-1)
    expect(mainSource.slice(teardown, teardown + 300)).toContain('adoptedWorkspaces.delete(win)')
  })

  it('survive a relaunch', () => {
    // A window that was running three projects should come back running three,
    // not one. The registry is the only thing that outlives the process.
    expect(registrySource).toContain('adopted_workspaces?: string[]')
    expect(registrySource).toContain('setAdoptedWorkspaces(winId: number, paths: string[])')
    const at = mainSource.indexOf("ipcMain.on('window:reportAdoptedWorkspaces'")
    const handler = mainSource.slice(at, mainSource.indexOf('\n})', at))
    expect(handler).toContain('windowRegistry.setAdoptedWorkspaces')
  })

  it('survive a workspace switch, which rebuilds the entry', () => {
    // setWorkspace replaces the entry outright, and switching workspaces goes
    // through it. It used to list the fields to carry over one by one, which
    // made every new field a silent data-loss bug waiting for a forgotten
    // line; it spreads the previous entry now, so this holds for whatever is
    // added next as well.
    const at = registrySource.indexOf('setWorkspace(winId: number')
    const body = registrySource.slice(at, registrySource.indexOf('\n  }', at))
    expect(body).toContain('{ ...prev, workspace_path: workspacePath }')
    expect(body).not.toContain('prev?.bounds ?')
  })

  it('are snapshotted before an update install closes the windows', () => {
    // Source-scanned, so this proves the wiring and not the ordering: the
    // ordering is Electron's, documented on quitAndInstall — it emits
    // before-quit AFTER closing every window, so the before-quit call to
    // markCleanExit freezes an entries map the 'closed' handlers have already
    // emptied. onInstallStarting is the only hook that still runs with the
    // windows open, which is why the freeze has to happen there too.
    const at = mainSource.indexOf('onInstallStarting:')
    expect(at).toBeGreaterThan(-1)
    // ...via the wrapper that also settles this run's restore charges.
    expect(mainSource.slice(at, mainSource.indexOf('\n', at)))
      .toContain('markCleanExitAndSettleRestores()')
  })

  it('are handed to the window restored for them, once', () => {
    // Taken, not read: a reload must not resurrect a list the user has since
    // emptied.
    const at = mainSource.indexOf("ipcMain.handle('window:takeRestoredAdopted'")
    expect(at).toBeGreaterThan(-1)
    const handler = mainSource.slice(at, mainSource.indexOf('\n})', at))
    expect(handler).toContain('pendingAdoptedWorkspaces.delete(win.id)')
    // Every restore path — the crash prompt, the clean-exit snapshot, and
    // Reopen Closed Window.
    expect(mainSource.match(/pendingAdoptedWorkspaces\.set\(/g)).toHaveLength(3)
  })
})
