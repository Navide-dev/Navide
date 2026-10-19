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

// A layout-mode switch fills the container: a pane handed the whole stage
// must not stay pinned at its grid width with the rest left blank.
describe('layout-mode switch', () => {
  it('caps no pane and refits every pane with a redraw after a frame', () => {
    const watcher = block('watch(effectiveLayoutMode, () => {', '// Tab switches and minimize/restore')
    expect(watcher).not.toContain('lockCols')
    expect(watcher).toContain('?.fitTerminal?.({ redrawAfterSettle: true })')
  })

  it('lifts the cap nowhere else in App.vue but the menu item', () => {
    expect(appSource.match(/unlockCols/g)?.length).toBe(1)
  })
})
