import { describe, expect, it } from 'vitest'
import { isSpawnReportSend } from '../spawnReportSend'

const child = { id: 'kid', spawnReportPending: true, spawnedBy: 'parent-id', spawnedByName: 'Commander' }
const local = (name: string): string | undefined => (name === 'Commander' ? 'parent-id' : undefined)
const none = (): undefined => undefined

describe('isSpawnReportSend', () => {
  it('counts a cli_send from the child to its parent as the spawn report', () => {
    expect(isSpawnReportSend(child, { fromPaneId: 'kid', targetPaneId: 'parent-id', targetName: 'Commander' }, local)).toBe(true)
  })

  it('matches the parent by handle when no lineage id was recorded', () => {
    const c = { ...child, spawnedBy: undefined }
    expect(isSpawnReportSend(c, { fromPaneId: 'kid', targetPaneId: 'parent-id' }, local)).toBe(true)
  })

  it('matches a parent in another workspace by folder and pane name', () => {
    const c = { ...child, spawnedBy: undefined, spawnedByName: 'Agent-Team/Commander' }
    const ev = { fromPaneId: 'kid', targetPaneId: 'far', targetName: 'Commander', targetWorkspacePath: '/Users/x/Agent-Team' }
    expect(isSpawnReportSend(c, ev, none)).toBe(true)
    expect(isSpawnReportSend(c, { ...ev, targetWorkspacePath: '/Users/x/Other' }, none)).toBe(false)
  })

  it('does not count an ack, a send to another pane, or a pane that owes nothing', () => {
    expect(isSpawnReportSend(child, { fromPaneId: 'kid', targetPaneId: 'parent-id', kind: 'ack' }, local)).toBe(false)
    expect(isSpawnReportSend(child, { fromPaneId: 'kid', targetPaneId: 'someone-else', targetName: 'Bob' }, local)).toBe(false)
    expect(isSpawnReportSend({ ...child, spawnReportPending: false }, { fromPaneId: 'kid', targetPaneId: 'parent-id' }, local)).toBe(false)
    expect(isSpawnReportSend(child, { fromPaneId: 'other', targetPaneId: 'parent-id' }, local)).toBe(false)
    expect(isSpawnReportSend(undefined, { fromPaneId: 'kid', targetPaneId: 'parent-id' }, local)).toBe(false)
  })
})
