// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The sidebar's plain "Close Workspace" lets go of the workspace and leaves its
// CLIs running; "Close Workspace and Its Panes" (closeWorkspace) is the one
// that ends them. What makes the plain one easy to get wrong is the half detach
// skips: panesInView only holds back workspaces the window still HOLDS, so a
// let-go workspace's panes would surface on the stage of whatever project is
// on screen unless they leave the list — without being killed.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), 'utf8')
const appSource = read('src/renderer/src/App.vue')
const paneSource = read('src/renderer/src/components/ControlPane.vue')

/** A top-level function's text, up to the next declaration. */
function body(source: string, name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = source.indexOf(pat)
    if (at < 0) continue
    const rest = source.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return source.slice(at, at + pat.length + (next ? next.index : 3000))
  }
  throw new Error(`${name} not found`)
}

describe('closing a workspace while keeping its panes', () => {
  const fn = body(appSource, 'closeWorkspaceKeepPanes')

  it('never kills, never asks, never unspawns', () => {
    expect(fn).not.toContain('onKill(')
    expect(fn).not.toContain('release_pty')
    expect(fn).not.toContain('slot_unspawn')
    expect(fn).not.toContain('confirm(')
  })

  it('drops the panes from this window the non-killing way', () => {
    // The same removal handleGroupDetached does for a run group.
    const drop = body(appSource, 'dropWorkspacePanes')
    expect(drop).not.toContain('onKill(')
    expect(drop).toContain('delete paneRefs[p.id]')
    expect(drop).toContain('unregisterPaneMessaging(p.id, { keepPersisted: true })')
    expect(drop).toContain('sysNotify.forgetPane(p.id)')
    expect(drop).toContain("panes.value = panes.value.filter((p) => normWs(p.workspacePath) !== normWs(path))")
    expect(drop).toContain('syncViews()')
    expect(fn).toContain('dropWorkspacePanes(path)')
  })

  it('detach hands its panes over the same way, instead of leaving them on this stage', () => {
    // panesInView only holds back workspaces the window still HOLDS; a
    // detached workspace's panes used to stay listed and drawn here.
    const detach = body(appSource, 'detachWorkspace')
    const drop = detach.indexOf('dropWorkspacePanes(path)')
    expect(drop).toBeGreaterThan(-1)
    expect(drop).toBeGreaterThan(detach.indexOf('await switchToWorkspace(fallback)'))
    expect(drop).toBeLessThan(detach.indexOf('detachWorkspace?.({'))
  })

  it('steps off the workspace on screen before letting go, and needs somewhere to land', () => {
    const land = fn.indexOf('await switchToWorkspace(land)')
    expect(land).toBeGreaterThan(-1)
    expect(fn).toContain('if (!land) return')
    expect(land).toBeLessThan(fn.indexOf('dropWorkspacePanes(path)'))
    expect(land).toBeLessThan(fn.indexOf('workspaceOrder.value = workspaceOrder.value.filter'))
  })

  it('stops tracking a run paused in it, so the reopen is not refused', () => {
    // restoreBlockedByRun reads 'aborted' as "panes alive in this window";
    // they just left it.
    expect(fn).toContain("if (pipeline.state === 'aborted' && normWs(pipelineRunWorkspace) === normWs(path))")
    expect(fn).toContain("pipeline.state = 'idle'")
  })

  it('is what the sidebar row emits to', () => {
    expect(appSource).toContain('@close-workspace-keep-panes="closeWorkspaceKeepPanes"')
    // Both of a heading's menus — the right-click one and the ⋯ overflow —
    // reach it through one path-addressed action, so the emit no longer reads
    // the right-click menu's own state.
    expect(paneSource).toContain("emit('close-workspace-keep-panes', path)")
  })
})
