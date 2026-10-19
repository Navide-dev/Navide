/**
 * The layout-mode cols cap, and when it is lifted.
 *
 * Sidebar, spotlight and fullscreen hand one pane the whole stage: a step change
 * in width, not a drag. Widening makes xterm reflow the scrollback, and a CLI
 * that paints absolute-positioned full-width rows (claude) can never repaint
 * what reflow strands there, so each pane is capped at the column count it had
 * and the extra stage space stays blank. A mode switch alone therefore never
 * changes the cols of a normal-buffer pane. A pane on its alternate screen has
 * no scrollback and is never reflowed, so the pane itself declines the cap
 * (useTerminal.lockCols) and fills the stage at once.
 *
 * Widening the WINDOW is different: the user asked for width. The cap is lifted
 * once the window is wider than it was when the mode was entered. Comparing the
 * one window width (not per-pane container widths) means a mode switch can never
 * look like a widen.
 */

export interface CappablePane {
  lockCols?: (locked: boolean) => void
  unlockCols?: () => void
  isColsCapped?: () => boolean
}

export type StageLayoutMode = 'grid' | 'spotlight' | 'sidebar' | 'fullscreen'

/** App.vue's pane ref map holds null for a pane Vue has unmounted. */
type PaneRef = CappablePane | null | undefined

export function createStageWidthCap(getPanes: () => PaneRef[], getWindowWidth: () => number) {
  // Window width on entering a stage-wide mode; 0 in grid mode, where nothing is capped.
  let baseline = 0

  return {
    /** Entering (or switching between) stage-wide modes re-caps every pane at its
     *  current cols and resets the baseline; entering grid lifts the cap. */
    enterMode(mode: StageLayoutMode): void {
      const stage = mode !== 'grid'
      baseline = stage ? getWindowWidth() : 0
      for (const pane of getPanes()) pane?.lockCols?.(stage)
    },

    /** Window 'resize': once the window is wider than on entry, lift the cap from
     *  every pane that still leaves blank space. The baseline stays put, so a drag
     *  that starts with a sub-column step (nothing blank yet) still lifts on a
     *  later event. A pane already lifted reads as uncapped, so repeats are no-ops. */
    onWindowResize(): void {
      if (baseline <= 0 || getWindowWidth() <= baseline) return
      for (const pane of getPanes()) if (pane?.isColsCapped?.()) pane.unlockCols?.()
    },
  }
}
