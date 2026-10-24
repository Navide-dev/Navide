// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// "Close Workspace" promised a teardown it never performed: the dialog said the
// workspace was closing while its agents kept running in the background.
//
// The cause was ordering, not the teardown itself. panesInView is derived from
// extraWorkspaces — "every workspace this window holds EXCEPT the current one"
// — so blanking currentWorkspace first turns every workspace into an extra,
// empties the view, and leaves onKillAll iterating nothing.
//
// Source-scanned, like the other App.*.test.ts files.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function body(name: string): string {
  const at = appSource.indexOf(`async function ${name}(`)
  expect(at).toBeGreaterThan(-1)
  return appSource.slice(at, at + 2200)
}

describe('closing a workspace actually tears its panes down', () => {
  it('captures the pane list before any state is cleared', () => {
    const close = body('doCloseWorkspace')
    const capture = close.indexOf('const paneIdsToKill = panesInView.value')
    const blanked = close.indexOf("currentWorkspace.value = ''")
    expect(capture).toBeGreaterThan(-1)
    expect(blanked).toBeGreaterThan(-1)
    // The whole bug in one assertion.
    expect(capture).toBeLessThan(blanked)
  })

  it('passes that captured list through to the teardown', () => {
    const close = body('doCloseWorkspace')
    expect(close).toContain('onPipelineReset(paneIdsToKill)')
    expect(body('onPipelineReset')).toContain('onKillAll(paneIds)')
  })

  it('still defaults to the on-screen workspace for every other caller', () => {
    // The ＋ menu's "kill all" must keep meaning "this workspace only" — passing
    // no list has to behave exactly as before.
    const killAll = body('onKillAll')
    expect(killAll).toContain('paneIds ?? panesInView.value.map((p) => p.id)')
  })

  it('keeps the derivation this depends on intact', () => {
    // If extraWorkspaces ever stops excluding the current workspace, the
    // ordering above is no longer load-bearing and this guard should be
    // revisited rather than silently kept.
    expect(appSource).toContain('workspaceOrder.value.filter((w) => normWs(w) !== normWs(currentWorkspace.value))')
  })
})
