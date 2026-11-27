/**
 * A quit the user confirmed has to end. On Windows (0.2.50 VM) a confirmed
 * quit was seen to stall with every window gone from screen, the backend never
 * asked to stop and no 'quit' ever emitted — the process stayed until killed.
 * quitCancelWatch only covers the path without a backend, so this is the
 * backstop for every confirmed quit: once armed, if 'quit' has not come within
 * the budget it reports the last stage reached and the caller finishes the
 * quit itself.
 *
 * Time the user spends answering something (a dialog, a plugin asking whether
 * to save) is not the quit stalling: while any hold is taken the timer is
 * stopped, and the full budget starts again once the last one is released.
 */
export interface QuitDeadlineDeps {
  timeoutMs: number
  onExpired(stage: string): void
}

export interface QuitDeadline {
  /** The user confirmed the quit. A timer already running is left as it is. */
  arm(stage: string): void
  /** Record how far the quit got, for the expiry report. */
  stage(name: string): void
  /** The quit finished ('quit') or was cancelled. */
  disarm(): void
  /** Pause the deadline while the user is being asked something. */
  hold(): () => void
}

export function createQuitDeadline(deps: QuitDeadlineDeps): QuitDeadline {
  let armed = false
  let fired = false
  let holds = 0
  let lastStage = ''
  let timer: ReturnType<typeof setTimeout> | null = null

  function stop(): void {
    if (timer) clearTimeout(timer)
    timer = null
  }
  function start(): void {
    if (!armed || fired || holds > 0 || timer) return
    timer = setTimeout(() => {
      timer = null
      if (!armed || fired) return
      fired = true
      deps.onExpired(lastStage)
    }, deps.timeoutMs)
  }

  return {
    arm(stageName) {
      lastStage = stageName
      if (armed) return
      armed = true
      fired = false
      start()
    },
    stage(name) {
      lastStage = name
    },
    disarm() {
      armed = false
      stop()
    },
    hold() {
      holds++
      stop()
      let released = false
      return () => {
        if (released) return
        released = true
        holds--
        start()
      }
    },
  }
}

/** A window URL for the log: the last path segment and the query keys only —
 *  query values can carry workspace paths or other private data. */
export function describeWindowUrl(url: string): string {
  if (!url) return '(none)'
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return '(unparsed)'
  }
  const segments = parsed.pathname.split('/')
  const tail = segments[segments.length - 1] || '/'
  const keys = [...new Set(parsed.searchParams.keys())]
  return keys.length ? `${tail}?${keys.join(',')}` : tail
}
