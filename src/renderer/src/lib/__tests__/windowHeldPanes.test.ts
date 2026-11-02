// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { heldPaneKeys, isHeldRecord, readHeldPanes, writeHeldPanes } from '../windowHeldPanes'

const heldRecords = <T extends { pane_id: string; session_id?: string }>(records: T[]): T[] => {
  const held = readHeldPanes()
  return records.filter((r) => isHeldRecord(r, held))
}

describe('the list of panes a window holds across a Reload', () => {
  beforeEach(() => sessionStorage.clear())

  it('is empty in a new window, which is how a first load is told from a Reload', () => {
    expect(readHeldPanes().size).toBe(0)
  })

  it('gives back what the window held before the Reload', () => {
    writeHeldPanes(heldPaneKeys([
      { id: 'pane-a', pinnedSessionId: 'session-a' },
      { id: 'pane-b' },
    ]))

    expect([...readHeldPanes()].sort()).toEqual(['pane-a', 'pane-b', 'session-a'])
  })

  it('leaves out the records the first load skipped, whatever their status', () => {
    writeHeldPanes(heldPaneKeys([{ id: 'mine', pinnedSessionId: 'my-session' }]))

    const kept = heldRecords([
      { pane_id: 'mine', session_id: 'my-session' },
      { pane_id: 'source-pane', session_id: 'source-session' },
      { pane_id: 'old-pane' },
    ])

    expect(kept.map((r) => r.pane_id)).toEqual(['mine'])
  })

  it('finds a pane mid-restore: new id on screen, old id still in project.json', () => {
    writeHeldPanes(heldPaneKeys([{ id: 'new-id', pinnedSessionId: 'same-session' }]))

    const kept = heldRecords([{ pane_id: 'old-id', session_id: ' same-session ' }])

    expect(kept.map((r) => r.pane_id)).toEqual(['old-id'])
  })

  it('does not let two records with no session id match each other', () => {
    writeHeldPanes(heldPaneKeys([{ id: 'mine' }]))

    expect(heldRecords([{ pane_id: 'other', session_id: '' }])).toEqual([])
  })

  it('drops a pane that left the window, so a Reload cannot take it back', () => {
    writeHeldPanes(heldPaneKeys([{ id: 'stays' }, { id: 'handed-over', pinnedSessionId: 's' }]))
    writeHeldPanes(heldPaneKeys([{ id: 'stays' }]))

    expect(heldRecords([
      { pane_id: 'stays' },
      { pane_id: 'handed-over', session_id: 's' },
    ]).map((r) => r.pane_id)).toEqual(['stays'])
  })

  it('treats an unreadable list as nothing held', () => {
    sessionStorage.setItem('agentTeam.heldPanes', '{not json')
    expect(readHeldPanes().size).toBe(0)

    sessionStorage.setItem('agentTeam.heldPanes', '{"a":1}')
    expect(readHeldPanes().size).toBe(0)

    sessionStorage.setItem('agentTeam.heldPanes', '["ok",1,null]')
    expect([...readHeldPanes()]).toEqual(['ok'])
  })
})
