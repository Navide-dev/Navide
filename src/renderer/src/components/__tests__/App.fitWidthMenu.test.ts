// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// App.vue mounts backend/terminal/onboarding lifecycles, so it is not
// practical to mount here (see App.idleReclaim.test.ts). The cap behavior is
// unit-tested in useTerminal.fitWidth.test.ts and lib/stageWidthCap.test.ts;
// this file guards the wiring of the pane menu's "Fit to Pane Width" and of
// the layout-mode cap it opts out of.
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

// A layout-mode switch caps every pane at its current cols (stageWidthCap owns
// the policy), then refits with a redraw after a frame. Widening the window is
// the only thing that lifts the cap, and it is routed through the same module.
describe('layout-mode switch wiring', () => {
  it('hands the new mode to the cap policy, then refits every pane with a redraw after a frame', () => {
    const watcher = block('watch(effectiveLayoutMode, (mode) => {', '// Tab switches and minimize/restore')
    expect(watcher).toContain('stageWidthCap.enterMode(mode)')
    expect(watcher).toContain('?.fitTerminal?.({ redrawAfterSettle: true })')
    expect(watcher.indexOf('stageWidthCap.enterMode(mode)')).toBeLessThan(watcher.indexOf('fitTerminal'))
  })

  it('routes the window resize through the cap policy', () => {
    const handler = block('function onWindowResize(): void {', '\nfunction onResizeEnd')
    expect(handler).toContain('stageWidthCap.onWindowResize()')
  })

  it('calls unlockCols only from the menu item; the window-widen lift lives in stageWidthCap', () => {
    expect(appSource.match(/unlockCols/g)?.length).toBe(1)
  })
})
