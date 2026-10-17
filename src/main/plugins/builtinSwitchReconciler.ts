/**
 * Applies a change to the built-in Disabled set that did not come through the
 * Extensions switch: the store becoming unreadable while the app runs (the
 * built-ins then fail closed), or being repaired or edited on disk. The
 * switch and the reset run inside `hold()` and call `sync()` after applying
 * their own change, so a change is never applied twice and a check never
 * interleaves with them.
 *
 * A set is taken as seen before its changes are applied: a change that fails
 * is reported and not retried, so a Host that keeps failing is not driven
 * through the same drain every 15 s.
 */
export interface BuiltinSwitchReconciler {
  /** Compare the current set with the last one seen and apply the difference. */
  check(): Promise<void>
  /** Take the current set as seen, without applying anything. */
  sync(): void
  /** Run the user's switch or reset: after a check in progress, and with no
   *  check starting until it ends. */
  hold<T>(task: () => Promise<T>): Promise<T>
}

export function createBuiltinSwitchReconciler(deps: {
  list: () => readonly string[]
  apply: (pluginId: string, disabled: boolean) => Promise<void>
  warn: (message: string) => void
}): BuiltinSwitchReconciler {
  let seen = new Set(deps.list())
  let running: Promise<void> | null = null
  let holds = 0

  async function reconcile(): Promise<void> {
    const now = new Set(deps.list())
    const changes: Array<[string, boolean]> = [
      ...[...now].filter((id) => !seen.has(id)).map((id): [string, boolean] => [id, true]),
      ...[...seen].filter((id) => !now.has(id)).map((id): [string, boolean] => [id, false]),
    ]
    seen = now
    for (const [pluginId, disabled] of changes) {
      // The store may have moved on while an earlier change drained (a reset,
      // an edit on disk); apply only what it still holds.
      if (deps.list().includes(pluginId) !== disabled) {
        if (disabled) seen.delete(pluginId)
        else seen.add(pluginId)
        continue
      }
      try {
        await deps.apply(pluginId, disabled)
      } catch (error) {
        deps.warn(`${pluginId} ${disabled ? 'disable' : 'enable'} from the store failed: ${
          error instanceof Error ? error.message : String(error)
        }`)
      }
    }
  }

  return {
    check() {
      if (holds > 0) return Promise.resolve()
      running ??= reconcile().finally(() => { running = null })
      return running
    },
    sync() {
      seen = new Set(deps.list())
    },
    async hold(task) {
      holds += 1
      try {
        await running
        return await task()
      } finally {
        holds -= 1
      }
    },
  }
}
