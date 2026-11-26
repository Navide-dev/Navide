/**
 * Per-pane recent turns for the rich output view. One instance per window,
 * made in App.vue and provided under `richTurnsKey`; it listens to
 * `agent.activity` from the start so a pane switched to the rich view later
 * still shows the turns since the window opened.
 */
import { shallowRef, triggerRef, type InjectionKey, type ShallowRef } from 'vue'
import type { useBackend } from './useBackend'
import { applyActivity, type ActivityLike, type RichTurn } from '../lib/richTurns'

type Backend = Pick<ReturnType<typeof useBackend>, 'on'>

export function createRichTurns(backend: Backend) {
  const byPane = new Map<string, ShallowRef<RichTurn[]>>()

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
    if (!paneId) return
    const r = refFor(paneId)
    if (applyActivity(r.value, ev as ActivityLike)) triggerRef(r)
  })

  return {
    turnsFor: (paneId: string): ShallowRef<RichTurn[]> => refFor(paneId),
  }
}

export type RichTurns = ReturnType<typeof createRichTurns>

export const richTurnsKey: InjectionKey<RichTurns> = Symbol('richTurns')
