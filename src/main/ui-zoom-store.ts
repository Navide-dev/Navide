import { clampUiScale, DEFAULT_UI_SCALE, UI_SCALE_SETTING_KEY } from '../shared/uiScale'

// Single owner of the interface scale in the main process.
//
// Every window — the main shell, editor/plans/diff windows, and each plugin
// bundle's own document — is a separate WebContents with its own zoom factor.
// Rather than making every renderer entry apply the scale itself (four of them
// never import the host preload at all), the main process tracks each
// WebContents as it is created and pushes the factor to all of them at once.
// That is what makes one Settings change scale the whole app consistently.

type ZoomableContents = {
  setZoomFactor(factor: number): void
  isDestroyed(): boolean
  send(channel: string): void
}

export interface UiZoomStore {
  /** Current interface scale, already clamped. */
  get(): number
  /** Start tracking a WebContents; it receives every later scale change. */
  track(contents: ZoomableContents): void
  /** Stop tracking (call on 'destroyed'). */
  untrack(contents: ZoomableContents): void
  /** Set and broadcast a new scale. Returns the clamped value actually applied. */
  set(next: unknown): number
  /** Number of live tracked WebContents — for diagnostics and tests. */
  size(): number
}

/**
 * The scale to start at, read from the ui_settings document. The renderer
 * stores it as a raw number, while other keys (and older values) use the
 * legacy JSON-encoded string, so accept both: a string is decoded the way
 * index.ts uiSetting() decodes it, falling back to the raw string.
 */
export function initialUiScaleFrom(settings: Record<string, unknown>): number {
  const raw = settings[UI_SCALE_SETTING_KEY]
  if (typeof raw !== 'string') return clampUiScale(raw)
  try {
    return clampUiScale(JSON.parse(raw))
  } catch {
    return clampUiScale(raw)
  }
}

export function createUiZoomStore(initial: unknown = DEFAULT_UI_SCALE): UiZoomStore {
  let scale = clampUiScale(initial)
  const tracked = new Set<ZoomableContents>()

  const applyTo = (contents: ZoomableContents): void => {
    // A WebContents can be torn down between tracking and the next broadcast;
    // calling into a destroyed one throws and would abort the whole loop,
    // leaving the remaining windows at the old scale.
    if (contents.isDestroyed()) {
      tracked.delete(contents)
      return
    }
    try {
      contents.setZoomFactor(scale)
      // A renderer that positions a native WebContentsView converts CSS pixels
      // to device-independent pixels by dividing by the zoom factor
      // (GitPluginHostSlot). Electron only emits 'zoom-changed' for user
      // gestures, so without this push an app-driven scale change would leave
      // those views at stale bounds.
      contents.send('window:zoom-changed')
    } catch {
      tracked.delete(contents)
    }
  }

  return {
    get: () => scale,
    track(contents) {
      tracked.add(contents)
    },
    untrack(contents) {
      tracked.delete(contents)
    },
    set(next) {
      scale = clampUiScale(next)
      for (const contents of [...tracked]) applyTo(contents)
      return scale
    },
    size: () => tracked.size
  }
}
