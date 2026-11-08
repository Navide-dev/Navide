import { describe, it, expect } from 'vitest'
import { buildTokenGroupRows } from '../tokenGroups'

const bucket = (input: number, output: number, calls: number) => ({ input, output, calls })
const labels = { manual: 'Manual', orphan: 'Recovered', default: 'Default' }

describe('buildTokenGroupRows', () => {
  it('lists one row per group in the order the sidebar gives them', () => {
    const rows = buildTokenGroupRows(
      [{ id: 'rg-2', name: 'Two' }, { id: 'rg-1', name: 'One' }],
      { 'rg-1': bucket(1, 2, 3), 'rg-2': bucket(4, 5, 6) },
      labels,
    )
    expect(rows.map((r) => r.key)).toEqual(['rg-2', 'rg-1'])
    expect(rows.map((r) => r.label)).toEqual(['Two', 'One'])
    expect(rows[0].bucket).toEqual(bucket(4, 5, 6))
  })

  it('shows a zero row for a group that has spent nothing', () => {
    const rows = buildTokenGroupRows([{ id: 'rg-1', name: 'One' }], {}, labels)
    expect(rows).toEqual([{ key: 'rg-1', label: 'One', bucket: bucket(0, 0, 0) }])
  })

  it('adds a manual row for ungrouped usage, but not when it is all zero', () => {
    const withUsage = buildTokenGroupRows([], { '': bucket(7, 0, 1) }, labels)
    expect(withUsage).toEqual([{ key: 'manual', label: 'Manual', bucket: bucket(7, 0, 1) }])

    expect(buildTokenGroupRows([], { '': bucket(0, 0, 0) }, labels)).toEqual([])
    expect(buildTokenGroupRows([], {}, labels)).toEqual([])
  })

  it('folds every unknown group key into one orphan row, absent when it sums to zero', () => {
    const rows = buildTokenGroupRows(
      [{ id: 'rg-1', name: 'One' }],
      { 'rg-1': bucket(1, 1, 1), 'rg-gone': bucket(2, 3, 4), 'rg-gone-2': bucket(10, 20, 30) },
      labels,
    )
    expect(rows.map((r) => r.key)).toEqual(['rg-1', 'orphan'])
    expect(rows[1]).toEqual({ key: 'orphan', label: 'Recovered', bucket: bucket(12, 23, 34) })

    const zero = buildTokenGroupRows([], { 'rg-gone': bucket(0, 0, 0) }, labels)
    expect(zero).toEqual([])
  })

  it('orders groups, then manual, then orphan', () => {
    const rows = buildTokenGroupRows(
      [{ id: 'rg-1', name: 'One' }],
      { 'rg-gone': bucket(1, 0, 0), '': bucket(1, 0, 0), 'rg-1': bucket(1, 0, 0) },
      labels,
    )
    expect(rows.map((r) => r.key)).toEqual(['rg-1', 'manual', 'orphan'])
  })

  it('shows the default group in the UI language until it is renamed', () => {
    // project.json stores the default group's name as the fixed string '預設'
    // whatever the UI language was; only a rename replaces it.
    const rows = buildTokenGroupRows(
      [{ id: 'rg-default', name: '預設' }, { id: 'rg-default-2', name: '預設' }],
      {},
      labels,
    )
    expect(rows.map((r) => r.label)).toEqual(['Default', '預設'])
    const renamed = buildTokenGroupRows([{ id: 'rg-default', name: 'Main' }], {}, labels)
    expect(renamed[0].label).toBe('Main')
  })
})
