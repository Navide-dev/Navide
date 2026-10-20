// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// ui.pane.moveToWindow / ui.workspace.moveToWindow are the window side of the
// MCP window_move_pane tool (DESIGN-C S4b). A pane lives only in a window
// holding its project (approval (d)), so a single pane moves only into a
// detached window of its own or, from one, back into the main window; a
// project moves with every pane of it. Nothing is killed. Asserted against the
// source like the other App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(marker: string): string {
  const start = appSource.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n})\n', start)
  expect(end).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('ui.pane.moveToWindow', () => {
  const body = block("registerCommand('ui.pane.moveToWindow'")

  it('splits the pane into a group of its own before detaching, so only it goes', () => {
    expect(body).toContain('if (!groupId || sharing.length > 1) {')
    const split = body.indexOf('createRunGroup(label)')
    const detach = body.indexOf('window.agentTeam?.detachGroup?.({')
    expect(split).toBeGreaterThan(-1)
    expect(detach).toBeGreaterThan(split)
    expect(body).toContain('await persistPaneRunGroup(pane, group.id)')
  })

  it('moves a pane back only from a detached window, merging its group', () => {
    expect(body).toContain("throw new Error('pane-needs-workspace-move:")
    expect(body).toContain('setTimeout(() => { reattachThisWindow() }, 300)')
  })

  it('leaves a running pipeline slot alone', () => {
    expect(body).toContain("if (pane.origin === 'pipeline' && pipeline.state === 'running') {")
  })

  it('ends nothing', () => {
    expect(body).not.toContain('onKill')
    expect(body).not.toContain('closeWorkspace(')
  })

  it('says which pane did it', () => {
    expect(body).toContain("i18n.global.t('msg.agent-moved-pane'")
    expect(body).toContain("code: 'agent.window-action'")
  })
})

describe('ui.workspace.moveToWindow', () => {
  const body = block("registerCommand('ui.workspace.moveToWindow'")

  it('requires a path this window holds and keeps at least one project', () => {
    expect(body).toContain("if (!path) throw new Error('path-required:")
    expect(body).toContain('workspace-not-open:')
    expect(body).toContain('workspaceOrder.value.length < 2')
  })

  it('lets go keeping every CLI running: drag-out for a new window, plain close otherwise', () => {
    expect(body).toContain("if (a.to === 'new') await detachWorkspace(held, 120, 120)")
    expect(body).toContain('else await closeWorkspaceKeepPanes(held)')
    expect(body).not.toContain('closeWorkspace(held')
  })

  it('refuses a project with a running pipeline', () => {
    expect(body).toContain('pipeline-running:')
  })
})
