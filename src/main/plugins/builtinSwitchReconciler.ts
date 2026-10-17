/**
 * Applies a change to the built-in Disabled set that did not come through the
 * Extensions switch: the store becoming unreadable while the app runs (the
 * built-ins then fail closed), or being repaired or edited on disk. The
 * switch and the reset call `sync()` after applying their own change, so a
 * change is never applied twice.
 */
export interface BuiltinSwitchReconciler {
  /** Compare the current set with the last one seen and apply the difference. */
  check(): Promise<void>
  /** Take the current set as seen, without applying anything. */
  sync(): void
}

export function createBuiltinSwitchReconciler(deps: {
  list: () => readonly string[]
  apply: (pluginId: string, disabled: boolean) => Promise<void>
  warn: (message: string) => void
}): BuiltinSwitchReconciler {
  let seen = new Set(deps.list())
  let running: Promise<void> | null = null

  async function reconcile(): Promise<void> {
    const now = new Set(deps.list())
    const changes: Array<[string, boolean]> = [
      ...[...now].filter((id) => !seen.has(id)).map((id): [string, boolean] => [id, true]),
      ...[...seen].filter((id) => !now.has(id)).map((id): [string, boolean] => [id, false]),
    ]
    seen = now
    for (const [pluginId, disabled] of changes) {
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
      running ??= reconcile().finally(() => { running = null })
      return running
    },
    sync() {
      seen = new Set(deps.list())
    },
  }
}
