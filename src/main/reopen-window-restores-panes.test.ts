// A PTY outlives its window (docs/en-US/architecture.md), so opening a
// workspace again must restore its panes and reattach those PTYs. Every path
// that opens a new main window for a workspace no window holds has to boot
// without duplicate=1: that flag makes the renderer skip pane restore, which
// left a closed window's CLIs running with no pane to show them (0.2.42 Linux
// VM: close wa with X, open it again → only the Default tab, bash/codex/claude
// still running). A workspace another window holds is still only focused.
//
// Source-scanned — the real thing needs live BrowserWindows.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function slice(marker: string, end: string): string {
  const at = mainSource.indexOf(marker)
  expect(at, `${marker} not found`).toBeGreaterThan(-1)
  return mainSource.slice(at, mainSource.indexOf(end, at))
}

describe('opening a workspace no window holds restores its panes', () => {
  const paths = {
    'window:openMain (openMainWindow)': slice('function openMainWindow(', '\n}'),
    'host shell openWorkspace': slice('  openWorkspace: (ws) => {', '\n  },'),
  }

  for (const [name, body] of Object.entries(paths)) {
    describe(name, () => {
      it('focuses a window that already holds the workspace before creating one', () => {
        const focus = body.indexOf('findMainWindowForWorkspace(ws)')
        const reveal = body.indexOf('revealMainWindow(existing)')
        const create = body.indexOf('createWindow(')
        expect(focus).toBeGreaterThan(-1)
        expect(reveal).toBeGreaterThan(focus)
        expect(create).toBeGreaterThan(reveal)
      })

      it('boots the new window without duplicate=1, so pane restore runs', () => {
        expect(body).not.toMatch(/duplicate\s*[:=]\s*'1'/)
        expect(body).toMatch(/skip_recent\s*[:=]\s*'1'/)
      })
    })
  }

  it('the renderer skips restore only for duplicate=1, so these boots restore', () => {
    expect(appSource).toContain("let suppressPaneRestoreOnce = _bootWorkspace !== '' && _bootIsDuplicate")
    expect(appSource).toContain("const _bootIsDuplicate = new URLSearchParams(window.location.search).get('duplicate') === '1'")
    const check = appSource.indexOf('if (suppressPaneRestoreOnce) {\n      // First load of a duplicated window')
    expect(check).toBeGreaterThan(-1)
    const branch = appSource.slice(check, check + 1600)
    expect(branch).toContain('} else {')
    expect(branch.slice(branch.indexOf('} else {'))).toContain('await restoreWorkspacePanes(resp, path, undefined,')
  })
})

describe('Reopen Closed Window (⇧⌘T) restores the closed window panes', () => {
  const body = slice('async function reopenClosedWindow(', '\n}')

  it('boots with restore=1 and no duplicate flag', () => {
    expect(body).toContain("createWindow({ workspace_path, restore: '1' }")
    expect(body).not.toContain('duplicate')
  })

  it('every restored pane carries its saved pane id as the replaces key', () => {
    // A pane with no pinned session (a terminal, codex before its first turn)
    // restores fresh; the former pane id is how terminal.create finds and reaps
    // the PTY the closed window left running (useTerminal.replacesFormerPty
    // covers the terminal side).
    const restored = appSource.slice(
      appSource.indexOf('async function spawnRestoredPane'),
      appSource.indexOf('\n}', appSource.indexOf('async function spawnRestoredPane')),
    )
    expect(restored).toContain("restoreMode: opts.isResume ? 'memory-resume' : 'fresh'")
    expect(restored).toContain('formerPaneIds: [saved.pane_id]')
    const spawn = appSource.slice(
      appSource.indexOf('async function spawnPane('),
      appSource.indexOf('\n}', appSource.indexOf('async function spawnPane(')),
    )
    expect(spawn).toContain("skipReattach: opts.restoreMode === 'fresh'")
    expect(spawn).toContain('replacesKey: opts.formerPaneIds?.[0]')
  })
})
