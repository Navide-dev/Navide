import { describe, expect, it } from 'vitest'
import { arenaDiffLines, arenaPaneName, candidatesToStop, defaultArenaLineup, formatElapsed, type ArenaStatus } from '../arena'

function status(overrides: Partial<ArenaStatus['candidates'][number]>[], stopped: string[] = []): ArenaStatus {
  const ids = ['A', 'B', 'C'].slice(0, overrides.length)
  return {
    elapsed_s: 0,
    run: {
      id: 'r1', workspace: '/w', task: 't', base_sha: 'abc', base_branch: 'main', check_command: '',
      time_limit_min: 30, budget_usd: 3, created_at: 0, state: 'running',
      candidates: ids.map((id, i) => ({
        id, agent: 'claude', model: '', slug: id, branch: `arena/r1/${id}`, worktree: `/w/${id}`,
        pane_id: `p${id}`, stopped: stopped[i] ?? '', rating: 0, adopted: false,
      })),
    },
    candidates: ids.map((id, i) => ({
      id, files: 0, added: 0, deleted: 0, protected: [],
      spend: { usd: 0, tokens: 0, unpriced_calls: 0, available: true },
      over_time: false, over_budget: false, ...overrides[i],
    })),
  }
}

describe('model arena rules', () => {
  it('stops a live candidate over budget first, then over time, and never twice', () => {
    const s = status([{ over_budget: true, over_time: true }, { over_time: true }, {}])
    expect(candidatesToStop(s, () => true)).toEqual([
      { id: 'A', paneId: 'pA', reason: 'budget' },
      { id: 'B', paneId: 'pB', reason: 'time' },
    ])
    const again = status([{ over_budget: true }, { over_time: true }], ['budget', ''])
    expect(candidatesToStop(again, (id) => id !== 'pB')).toEqual([])
  })

  it('lines up claude models by default and fills to the minimum otherwise', () => {
    expect(defaultArenaLineup(['codex', 'claude'])).toEqual([
      { agent: 'claude', model: 'claude-opus-5-5' },
      { agent: 'claude', model: 'claude-sonnet-5-5' },
      { agent: 'claude', model: 'claude-fable-5-2' },
    ])
    expect(defaultArenaLineup(['codex'])).toEqual([{ agent: 'codex', model: '' }, { agent: 'codex', model: '' }])
  })

  it('formats names and durations', () => {
    expect(arenaPaneName('ab12', { id: 'B', slug: 'claude-opus-5-5' })).toBe('arena-ab12-B-claude-opus-5-5')
    expect(formatElapsed(65)).toBe('1:05')
    expect(formatElapsed(3725)).toBe('1:02:05')
  })

  it('colours a unified diff, keeping file headers out of add/del', () => {
    const lines = arenaDiffLines('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n keep\n-old\n+new\n')
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add'])
  })
})
