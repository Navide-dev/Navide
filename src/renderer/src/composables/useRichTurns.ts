/**
 * Per-pane recent turns for the rich output view. One instance per window,
 * made in App.vue and provided under `richTurnsKey`; it listens to
 * `agent.activity` from the start so a pane switched to the rich view later
 * still shows the turns since the window opened.
 */
import { shallowReactive, shallowRef, type InjectionKey, type ShallowRef } from 'vue'
import type { useBackend } from './useBackend'
import { applyActivity, type ActivityLike, type RichTurn } from '../lib/richTurns'

type Backend = Pick<ReturnType<typeof useBackend>, 'on'>

export interface RichTurnsOptions {
  /** Whether a pane's turns may be kept: false for a pane this window does
   *  not hold and for a sign-in pane, whose replies can quote its sign-in. */
  accepts: (paneId: string) => boolean
}

export function createRichTurns(backend: Backend, opts: RichTurnsOptions) {
  // Reactive by key, so a view reading a pane with no entry yet (or one just
  // forgotten) picks up the entry its next turn creates.
  const byPane = shallowReactive(new Map<string, ShallowRef<RichTurn[]>>())
  const none: Readonly<ShallowRef<RichTurn[]>> = shallowRef<RichTurn[]>([])

  function refFor(paneId: string): ShallowRef<RichTurn[]> {
    let r = byPane.get(paneId)
    if (!r) {
      r = shallowRef<RichTurn[]>([])
      byPane.set(paneId, r)
    }
    return r
  }

  backend.on('agent.activity', (raw) => {
    const ev = raw as ActivityLike | null
    const paneId = typeof ev?.pane_id === 'string' ? ev.pane_id : ''
    if (!paneId || typeof ev?.text !== 'string' || !ev.text || !opts.accepts(paneId)) return
    const r = refFor(paneId)
    // A new array per change: a view reads it through a computed, which only
    // notifies when the value it returns is a different one.
    const next = r.value.slice()
    if (applyActivity(next, ev as ActivityLike)) r.value = next
  })

  return {
    turnsFor: (paneId: string): readonly RichTurn[] => (byPane.get(paneId) ?? none).value,
    /** Drop a pane's turns when the window lets go of it (close, rebuild,
     *  reclaim, detach). */
    forget: (paneId: string): void => void byPane.delete(paneId),
  }
}

export type RichTurns = ReturnType<typeof createRichTurns>

export const richTurnsKey: InjectionKey<RichTurns> = Symbol('richTurns')
