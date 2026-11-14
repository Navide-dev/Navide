/** Which pane holds each stage slot in the run this window is driving.
 *
 *  A stage id and slot label do not name a pane: an aborted or finished run
 *  leaves its panes open, and the next run of the same pipeline uses the same
 *  ids. Anything that looks a pane up by them and takes the first match reaches
 *  the previous run's pane, and a kickoff written there lands in that run's
 *  conversation. This record holds only panes of the current run, so a slot it
 *  does not know has no pane yet. */

export interface RunSlotRecord {
  pane_id: string
  origin: string
  stage_id?: string
  slot_label?: string
  spawn_status?: string
}

export type RunSlots = Map<string, string>

function keyOf(stageId: string, slotLabel: string): string {
  return `${stageId}\u0000${slotLabel}`
}

export function createRunSlotPanes() {
  let current: RunSlots = new Map()
  const parents: RunSlots[] = []

  return {
    /** The record of the run in progress. A pre-spawn holds on to this, so one
     *  that finishes after the next run began cannot land in that run's record. */
    current: (): RunSlots => current,

    record(slots: RunSlots, stageId: string, slotLabel: string, paneId: string): void {
      slots.set(keyOf(stageId, slotLabel), paneId)
    },

    paneId: (stageId: string, slotLabel: string): string | undefined => current.get(keyOf(stageId, slotLabel)),

    /** A sub-pipeline's panes are its own; the caller's come back with it. */
    startRun(child: boolean): void {
      if (child) parents.push(current)
      else parents.length = 0
      current = new Map()
    },

    endChildRun(): void {
      current = parents.pop() ?? new Map()
    },

    /** A rebuilt or restored pane took over this id. */
    rekey(oldId: string, newId: string): void {
      for (const map of [current, ...parents]) {
        for (const [key, id] of map) if (id === oldId) map.set(key, newId)
      }
    },

    /** A resumed run: the backend's record is of this run alone, because
     *  pipeline.start clears the pipeline panes of the one before. */
    adopt(records: readonly RunSlotRecord[] | undefined): void {
      for (const record of records ?? []) {
        if (record.origin !== 'pipeline' || !record.stage_id || !record.slot_label) continue
        if (record.spawn_status === 'removed') continue
        current.set(keyOf(record.stage_id, record.slot_label), record.pane_id)
      }
    },

    has: (paneId: string): boolean => [...current.values()].includes(paneId),

    isEmpty: (): boolean => current.size === 0,
  }
}
