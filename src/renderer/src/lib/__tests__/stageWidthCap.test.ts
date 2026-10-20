import { describe, expect, it } from 'vitest'
import { createStageWidthCap, type CappablePane } from '../stageWidthCap'

// A pane reduced to the state the cap policy drives: its cols, its cap and the
// width its container offers. It follows useTerminal's contract (lockCols sets
// or clears the cap at the current cols, and never fits by itself; unlockCols
// lifts the cap and fits) so assertions are on cols and cap state, not on which
// calls happened. A pane on its alternate screen declining the cap is the pane's
// own rule and is pinned in useTerminal.fitWidth.test.ts.
function fakePane(opts: { cols: number; container: number }) {
  let { cols, container } = opts
  let cap: number | null = null
  return {
    get cols() { return cols },
    get cap() { return cap },
    setContainer(n: number) { container = n },
    // What the refit after a mode switch (or the reconciler) does.
    fit() { cols = cap === null ? container : Math.min(container, cap) },
    lockCols(locked: boolean) { cap = locked ? cols : null },
    unlockCols() { cap = null; cols = container },
    isColsCapped() { return cap !== null && cap < container },
  } satisfies CappablePane & Record<string, unknown>
}

function harness(width: number, panes: Array<ReturnType<typeof fakePane> | null | undefined>) {
  let windowWidth = width
  const cap = createStageWidthCap(() => panes, () => windowWidth)
  return {
    cap,
    resizeWindow(n: number) { windowWidth = n; cap.onWindowResize() },
  }
}

describe('layout-mode cols cap', () => {
  it('a mode switch alone never changes the cols of a normal-buffer pane', () => {
    const pane = fakePane({ cols: 90, container: 90 })
    const { cap } = harness(1000, [pane])
    cap.enterMode('spotlight')
    pane.setContainer(180) // the stage hands it twice the width
    pane.fit()
    expect(pane.cols).toBe(90)
    expect(pane.cap).toBe(90)
  })

  // paneRefs holds null for a pane Vue has unmounted: one such entry must not
  // stop the real panes being capped, lifted or (in App.vue) refitted afterwards.
  it('skips a null pane ref without disturbing the real panes', () => {
    const pane = fakePane({ cols: 90, container: 90 })
    const { cap, resizeWindow } = harness(1000, [null, pane, undefined])
    cap.enterMode('spotlight')
    expect(pane.cap).toBe(90)
    pane.setContainer(180)
    resizeWindow(1200)
    expect(pane.cap).toBeNull()
    expect(pane.cols).toBe(180)
  })

  it('widening the window above the entry width lifts the cap and the pane fills', () => {
    const pane = fakePane({ cols: 90, container: 90 })
    const { cap, resizeWindow } = harness(1000, [pane])
    cap.enterMode('sidebar')
    pane.setContainer(180)
    pane.fit()
    pane.setContainer(240)
    resizeWindow(1200)
    expect(pane.cap).toBeNull()
    expect(pane.cols).toBe(240)
  })

  it('a resize at or below the entry width keeps the cap', () => {
    const pane = fakePane({ cols: 90, container: 90 })
    const { cap, resizeWindow } = harness(1000, [pane])
    cap.enterMode('fullscreen')
    pane.setContainer(180)
    pane.fit()
    resizeWindow(1000)
    resizeWindow(800)
    pane.fit()
    expect(pane.cap).toBe(90)
    expect(pane.cols).toBe(90)
  })

  it('a drag whose first step leaves nothing blank still lifts on a later event', () => {
    const pane = fakePane({ cols: 90, container: 90 })
    const { cap, resizeWindow } = harness(1000, [pane])
    cap.enterMode('spotlight')
    resizeWindow(1001) // container still 90: no blank space yet
    expect(pane.cap).toBe(90)
    pane.setContainer(150)
    resizeWindow(1100)
    expect(pane.cap).toBeNull()
    expect(pane.cols).toBe(150)
  })

  it('grid mode ignores window resizes and caps nothing', () => {
    const pane = fakePane({ cols: 90, container: 90 })
    const { cap, resizeWindow } = harness(1000, [pane])
    cap.enterMode('grid')
    expect(pane.cap).toBeNull()
    pane.setContainer(140)
    resizeWindow(1400)
    expect(pane.cap).toBeNull()
  })

  // The 09-02 fix (bb2d93ab0): a grid → stage → grid round trip must never
  // widen a normal-buffer pane, so the return to grid is not a narrowing reflow
  // of its scrollback.
  it('a grid → spotlight → grid round trip never changes the cols of a normal-buffer pane', () => {
    const pane = fakePane({ cols: 90, container: 90 })
    const { cap } = harness(1000, [pane])
    const seen: number[] = []
    cap.enterMode('spotlight')
    pane.setContainer(180)
    pane.fit()
    seen.push(pane.cols)
    cap.enterMode('grid')
    pane.setContainer(90)
    pane.fit()
    seen.push(pane.cols)
    expect(seen).toEqual([90, 90])
    expect(pane.cap).toBeNull()
  })

  it('going back to grid lifts the cap; widening afterwards does nothing more', () => {
    const pane = fakePane({ cols: 90, container: 90 })
    const { cap, resizeWindow } = harness(1000, [pane])
    cap.enterMode('spotlight')
    cap.enterMode('grid')
    expect(pane.cap).toBeNull()
    pane.setContainer(120)
    resizeWindow(1300)
    expect(pane.cap).toBeNull()
  })

  it('switching between stage modes re-caps at the current cols and resets the baseline', () => {
    const pane = fakePane({ cols: 90, container: 90 })
    const { cap, resizeWindow } = harness(1000, [pane])
    cap.enterMode('spotlight')
    pane.setContainer(240)
    resizeWindow(1200) // widened: lifted
    expect(pane.cols).toBe(240)
    cap.enterMode('fullscreen') // re-caps at the widened 240, baseline now 1200
    expect(pane.cap).toBe(240)
    pane.setContainer(300)
    resizeWindow(1200) // not wider than the new baseline
    expect(pane.cap).toBe(240)
    resizeWindow(1300)
    expect(pane.cap).toBeNull()
    expect(pane.cols).toBe(300)
  })
})
