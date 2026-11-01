import { describe, expect, it } from 'vitest'
import { createRunSlotPanes } from '../runSlotPanes'

describe('runSlotPanes', () => {
  it('a new run knows no pane of the one before', () => {
    const slots = createRunSlotPanes()
    slots.record(slots.current(), 'L1', 'Check', 'old')
    slots.startRun(false)
    expect(slots.paneId('L1', 'Check')).toBeUndefined()
    expect(slots.has('old')).toBe(false)
  })

  it('a pre-spawn that finishes after the next run began stays out of it', () => {
    const slots = createRunSlotPanes()
    const held = slots.current()
    slots.startRun(false)
    slots.record(held, 'L1', 'Check', 'late')
    expect(slots.paneId('L1', 'Check')).toBeUndefined()
  })

  it('a sub-pipeline hands the caller its panes back', () => {
    const slots = createRunSlotPanes()
    slots.record(slots.current(), 'L1', 'Check', 'parent')
    slots.startRun(true)
    slots.record(slots.current(), 'L1', 'Check', 'child')
    expect(slots.paneId('L1', 'Check')).toBe('child')
    slots.endChildRun()
    expect(slots.paneId('L1', 'Check')).toBe('parent')
  })

  it('a rebuilt pane keeps the slot, a parked caller included', () => {
    const slots = createRunSlotPanes()
    slots.record(slots.current(), 'L1', 'Check', 'parent')
    slots.startRun(true)
    slots.rekey('parent', 'rebuilt')
    slots.endChildRun()
    expect(slots.paneId('L1', 'Check')).toBe('rebuilt')
  })

  it('a resume takes the pipeline panes the backend recorded', () => {
    const slots = createRunSlotPanes()
    slots.adopt([
      { pane_id: 'a', origin: 'pipeline', stage_id: 'L1', slot_label: 'Check' },
      { pane_id: 'b', origin: 'manual', stage_id: 'L1', slot_label: 'Other' },
      { pane_id: 'c', origin: 'pipeline', stage_id: 'L2', slot_label: 'Gone', spawn_status: 'removed' },
    ])
    expect(slots.paneId('L1', 'Check')).toBe('a')
    expect(slots.paneId('L1', 'Other')).toBeUndefined()
    expect(slots.paneId('L2', 'Gone')).toBeUndefined()
  })

  it('nothing recorded reads as empty', () => {
    const slots = createRunSlotPanes()
    expect(slots.isEmpty()).toBe(true)
    slots.adopt(undefined)
    expect(slots.isEmpty()).toBe(true)
  })
})
