import { describe, expect, it } from 'vitest'
import { idleRebuildable, staleEntriesFromStatus, staleParts, type StaleConfigPane } from '../staleConfigPanes'

describe('staleConfigPanes', () => {
  it('maps config_status rows back to pane ids and drops unknown terminals', () => {
    const bySession = new Map([['t1', 'p1'], ['t2', 'p2']])
    expect(staleEntriesFromStatus(bySession, [
      { terminal_session_id: 't1', parts: ['mcp'] },
      { terminal_session_id: 'gone', parts: ['skills'] },
      { terminal_session_id: 't2', parts: [] },
    ])).toEqual({ p1: { terminalSessionId: 't1', parts: ['mcp'] } })
    expect(staleEntriesFromStatus(bySession, undefined)).toEqual({})
  })

  it('stops showing an answer once the pane runs a different terminal (rebuilt)', () => {
    const entry = { terminalSessionId: 't1', parts: ['mcp', 'skills'] as const }
    expect(staleParts({ ...entry, parts: [...entry.parts] }, 't1')).toEqual(['mcp', 'skills'])
    expect(staleParts({ ...entry, parts: [...entry.parts] }, 't2')).toEqual([])
    expect(staleParts({ ...entry, parts: [...entry.parts] }, undefined)).toEqual([])
    expect(staleParts(undefined, 't1')).toEqual([])
  })

  it('"rebuild all idle" leaves running and unrebuildable panes alone', () => {
    const pane = (id: string, busy: boolean, canRebuild: boolean): StaleConfigPane =>
      ({ id, name: id, parts: ['mcp'], busy, canRebuild })
    expect(idleRebuildable([
      pane('idle', false, true),
      pane('running', true, true),
      pane('no-session', false, false),
    ]).map((p) => p.id)).toEqual(['idle'])
  })
})
