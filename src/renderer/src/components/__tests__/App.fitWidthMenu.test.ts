// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so it is not
// practical to mount here (see App.idleReclaim.test.ts). The cap behavior is
// unit-tested in useTerminal.fitWidth.test.ts; this file guards the wiring of
// the pane menu's "Fit to pane width" and the layout-mode cap it opts out of.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

describe('fit to pane width in the pane context menu', () => {
  it('reads the cap of the right-clicked pane as the menu opens', () => {
    const open = block('function openPaneCtxMenu(', 'function closePaneCtxMenu(')
    expect(open).toContain('paneCtxColsCapped.value = !!paneRefs[paneId]?.isColsCapped?.()')
  })

  it('offers the item only when the pane is capped, and unlocks that pane', () => {
    const item = block("$t('action.unmute') : $t('action.mute')", "$t('action.fit-width') }}")
    expect(item).toContain('v-if="paneCtxColsCapped"')
    expect(item).toContain('paneRefs[paneCtxMenu!.paneId]?.unlockCols?.()')
    expect(item).toContain('closePaneCtxMenu()')
  })

  it('is not offered in the batch menu', () => {
    const batch = block('<template v-if="ctxIsBatch">', '<template v-else>')
    expect(batch).not.toContain('unlockCols')
  })
})

// The cap exists so a layout-mode switch never widens (and reflows) the
// scrollback on its own. Only the explicit menu action may lift it.
describe('layout-mode cols cap', () => {
  it('still caps every pane outside grid mode and refits after a frame', () => {
    const watcher = block('watch(effectiveLayoutMode, (mode) => {', '// Tab switches and minimize/restore')
    expect(watcher).toContain("const capped = mode !== 'grid'")
    expect(watcher).toContain('?.lockCols?.(capped)')
    expect(watcher).toContain('?.fitTerminal?.({ redrawAfterSettle: true })')
    expect(watcher).not.toContain('unlockCols')
  })

  it('lifts the cap nowhere else in App.vue but the menu item', () => {
    expect(appSource.match(/unlockCols/g)?.length).toBe(1)
  })
})
