import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Closing a window that hosts an embedded AI panel (AiCliDock) ends that
// window's panels (owner ruling Q8: no ~1h linger for a reattach that cannot
// come). Each surface must match dockSurfaceForOrigin in the renderer
// (plan-window → plans, git-window → git, mini-ide → editor). The quit gate is
// what keeps the records 'spawned' across an app quit so the panels restore.
//
// Source-scanned: the windows are created deep inside index.ts and the plugin
// manager, behind Electron; the send itself is unit-tested in
// plugins/frontendPluginManager.test.ts.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const indexSource = read('src/main/index.ts')
const managerSource = read('src/main/plugins/frontendPluginManager.ts')
const contextSource = read('src/renderer/src/platform/plugin-shell/lib/aiCliContext.ts')

/** The text of the first `win.on('closed', …)` handler after `marker`. */
function closedHandlerAfter(source: string, marker: string): string {
  const at = source.indexOf(marker)
  expect(at, marker).toBeGreaterThan(-1)
  const handler = source.indexOf("win.on('closed', () => {", at)
  expect(handler, marker).toBeGreaterThan(-1)
  return source.slice(handler, source.indexOf('\n  })', handler))
}

describe('a window hosting AI panels ends them when it closes', () => {
  it('keeps the surfaces in step with the renderer mapping', () => {
    expect(contextSource).toContain("'plan-window': { surface: 'plans', windowKind: 'plans' }")
    expect(contextSource).toContain("'git-window': { surface: 'git', windowKind: 'git' }")
    expect(contextSource).toContain("'mini-ide': { surface: 'editor', windowKind: 'editor' }")
  })

  it('the Plan window ends the plans panel of its workspace', () => {
    const handler = closedHandlerAfter(indexSource, 'function openLegacyPlanWindow(')
    expect(handler).toContain("frontendPluginManager.endDockSurface('plans', workspacePath)")
  })

  it('the Mini-IDE window ends the editor panels', () => {
    expect(closedHandlerAfter(managerSource, 'function ensureMiniIdeWindow(')).toContain(
      "frontendPluginManager.endDockSurface('editor')",
    )
  })

  it('tells the manager when the app is quitting, by both quit flags', () => {
    // dockQuitInProgress, not quitConfirmed: the latter stays set after a vetoed
    // quit (see dockQuitProbe.test.ts, which drives the cancel paths).
    expect(indexSource).toContain(
      'frontendPluginManager.setAppQuittingProbe(() => dockQuitInProgress || quittingWindowsPrepared)',
    )
  })
})
