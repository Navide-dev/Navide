// SSH Remote terminal pane: what happens after its ssh ends.
//
// ssh exits 255 when the link dropped or never came up. Then the pane checks
// the host again on its own, backing off between tries, and says why each
// try failed. A key or host-key refusal stops the retries: trying again
// cannot fix it. Any other exit (the user typed `exit`) only offers Reconnect.

import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { SshFailureReason } from './useSshRemotePrefs'

/** Seconds before each automatic try; its length is the number of tries. */
export const SSH_RECONNECT_DELAYS_S = [2, 5, 15, 30, 60] as const

const SSH_LINK_LOST = 255

export interface SshReconnectState {
  /** Why the last check failed; null before any failure. */
  reason: Ref<SshFailureReason | null>
  /** Automatic tries made so far. */
  attempt: Ref<number>
  /** When the next automatic try runs (ms epoch); null when none is queued. */
  nextAt: Ref<number | null>
  busy: Ref<boolean>
  /** Banner "Reconnect": tries now, outside the automatic schedule. */
  reconnectNow: () => Promise<void>
}

export function useSshReconnect(opts: {
  down: () => boolean
  exitCode: () => number | null | undefined
  /** Checks the host and, when it answers, respawns the pane: null on
   *  success, else the reason. */
  reconnect: () => Promise<string | null>
}): SshReconnectState {
  const reason = ref<SshFailureReason | null>(null)
  const attempt = ref(0)
  const nextAt = ref<number | null>(null)
  const busy = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  function cancel(): void {
    if (timer) clearTimeout(timer)
    timer = null
    nextAt.value = null
  }

  function schedule(): void {
    cancel()
    const delay = SSH_RECONNECT_DELAYS_S[attempt.value]
    if (delay === undefined) return
    nextAt.value = Date.now() + delay * 1000
    timer = setTimeout(() => {
      timer = null
      nextAt.value = null
      attempt.value += 1
      void run(true)
    }, delay * 1000)
  }

  async function run(automatic: boolean): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      const failed = (await opts.reconnect()) as SshFailureReason | null
      reason.value = failed
      if (failed && automatic && failed !== 'auth' && failed !== 'host-key' && opts.down()) schedule()
    } catch {
      reason.value = 'other'
    } finally {
      busy.value = false
    }
  }

  watch(
    () => opts.down() && opts.exitCode() === SSH_LINK_LOST,
    (lost) => {
      if (lost) {
        attempt.value = 0
        reason.value = null
        schedule()
      } else if (!opts.down()) {
        cancel()
      }
    },
    { immediate: true },
  )
  onBeforeUnmount(cancel)

  return {
    reason,
    attempt,
    nextAt,
    busy,
    reconnectNow: async () => {
      cancel()
      await run(false)
    },
  }
}
