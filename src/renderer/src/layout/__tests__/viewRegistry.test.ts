import { describe, it, expect } from 'vitest'
import {
  VIEWS,
  viewById,
  isMovable,
  canPlace,
  defaultViewsFor,
  moveTargetsFor,
  reconcileOccupancy,
} from '../viewRegistry'
import { SLOT_IDS, type SlotId } from '../slots'

const occ = (o: Partial<Record<SlotId, string[]>>) =>
  reconcileOccupancy(SLOT_IDS.map((id) => [id, o[id] ?? []]))

describe('view registry', () => {
  it('gives every view a unique id', () => {
    const ids = VIEWS.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('declares each view in a slot it is actually allowed into', () => {
    // A default the whitelist forbids would make the shipped layout illegal:
    // reconcile would drop the view on first load and re-home it right back,
    // looping the two rules against each other.
    for (const v of VIEWS) {
      if (!isMovable(v.id)) continue
      expect(v.allowedSlots).toContain(v.defaultSlot)
    }
  })

  it('pins cli-stage to main by leaving it nowhere to go', () => {
    expect(viewById('cli-stage')?.defaultSlot).toBe('main')
    expect(isMovable('cli-stage')).toBe(false)
    expect(moveTargetsFor('cli-stage', null)).toEqual([])
    for (const slot of SLOT_IDS) expect(canPlace('cli-stage', slot)).toBe(false)
  })

  it('reports no move targets for the slot a view already occupies', () => {
    expect(moveTargetsFor('history', 'right')).toEqual(['up', 'down'])
    expect(moveTargetsFor('history', null)).toEqual(['right', 'up', 'down'])
  })

  it('treats an unknown id as belonging nowhere rather than throwing', () => {
    expect(viewById('nope')).toBeUndefined()
    expect(isMovable('nope')).toBe(false)
    expect(canPlace('nope', 'left')).toBe(false)
    expect(moveTargetsFor('nope', 'left')).toEqual([])
  })

  it('seeds the shipped slots from the declaration order', () => {
    expect(defaultViewsFor('left')).toEqual(['agents', 'commanders', 'pipeline', 'explorer', 'git', 'plans'])
    expect(defaultViewsFor('right')).toEqual(['history', 'time', 'tokens', 'tasker', 'messages', 'preview'])
    expect(defaultViewsFor('up')).toEqual([])
    expect(defaultViewsFor('down')).toEqual([])
  })
})

describe('reconcileOccupancy', () => {
  it('leaves a valid arrangement untouched', () => {
    const out = occ({ left: defaultViewsFor('left'), right: defaultViewsFor('right') })
    expect(out.left).toEqual(defaultViewsFor('left'))
    expect(out.right).toEqual(defaultViewsFor('right'))
    expect(out.up).toEqual([])
  })

  it('keeps a view in the first slot that claims it', () => {
    // right is visited before down (SLOT_IDS order), so a duplicated history
    // stays on the right and the down copy goes.
    const out = occ({ down: ['history'], right: ['history'] })
    expect(out.right).toContain('history')
    expect(out.down).not.toContain('history')
    const all = out.left.concat(out.right, out.up, out.down)
    expect(all.filter((v) => v === 'history')).toHaveLength(1)
  })

  it('drops unknown ids without disturbing their neighbours', () => {
    const out = occ({ left: ['agents', 'a-view-that-was-removed', 'explorer'] })
    expect(out.left.slice(0, 2)).toEqual(['agents', 'explorer'])
    expect(out.left).not.toContain('a-view-that-was-removed')
  })

  it('drops a view from a slot its whitelist forbids', () => {
    // agents is inline in ControlPane, so `left` is the only slot that can
    // draw it — putting it anywhere else would render an empty panel.
    const out = occ({ up: ['agents'], left: [] })
    expect(out.up).toEqual([])
  })

  it('only the self-contained panels are offered to the new slots', () => {
    // Everything else is reached by a shortcut, a command or an agent push
    // that only its host knows how to serve.
    const movable = VIEWS.filter((v) => v.allowedSlots.some((s) => s === 'up' || s === 'down'))
    expect(movable.map((v) => v.id)).toEqual(['history', 'tasker', 'messages'])
  })

  it('pins each view that no other slot can render to its host', () => {
    // The three views still inlined in their host component. Widening these
    // is the final step of extracting them, never a step taken in advance.
    expect(moveTargetsFor('agents', 'left')).toEqual([])
    expect(moveTargetsFor('pipeline', 'left')).toEqual([])
    expect(moveTargetsFor('tokens', 'right')).toEqual([])
    // Pinned for the other reason in the registry's note: something reveals
    // these — a shortcut or an agent push — and only their host knows how.
    for (const id of ['git', 'explorer', 'plans', 'preview']) {
      const home = viewById(id)!.defaultSlot as SlotId
      expect(moveTargetsFor(id, home), id).toEqual([])
    }
  })

  it('re-homes anything that fell out so no view becomes unreachable', () => {
    // Everything the caller omitted comes back at its default slot; without
    // this a narrowed whitelist would silently delete a panel with no way back.
    const out = occ({ up: ['agents'] })
    expect(out.left).toEqual(defaultViewsFor('left'))
    expect(out.right).toEqual(defaultViewsFor('right'))
  })

  it('never re-homes the pinned view into a real slot', () => {
    const out = occ({})
    for (const id of SLOT_IDS) expect(out[id]).not.toContain('cli-stage')
  })

  it('appends re-homed views after the ones the user placed', () => {
    const out = occ({ left: ['plans', 'agents'] })
    expect(out.left).toEqual(['plans', 'agents', 'commanders', 'pipeline', 'explorer', 'git'])
  })
})
