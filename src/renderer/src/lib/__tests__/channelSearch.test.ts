import { describe, expect, it } from 'vitest'
import { filterChannelEntries, highlightChannelMatch, matchesChannelQuery, normalizeChannelQuery } from '../channelSearch'

describe('channelSearch', () => {
  it('ignores case, a leading @ and spaces', () => {
    expect(normalizeChannelQuery(' @NT Test ')).toBe('nttest')
    expect(matchesChannelQuery(['@nt_test_bot'], 'NT_TEST')).toBe(true)
    expect(matchesChannelQuery(['@nt_test_bot'], '')).toBe(true)
    expect(matchesChannelQuery(['@nt_test_bot'], 'sales')).toBe(false)
  })

  it('keeps only bot-id hits for a pasted number when there are any', () => {
    const rows = [{ id: '7421000', f: ['bot-a1'] }, { id: '6900', f: ['bot-7421'] }]
    const keep = (q: string) => filterChannelEntries(rows, q, (r) => r.f, (r) => r.id).map((r) => r.id)
    expect(keep('7421')).toEqual(['7421000'])
    expect(keep('a1')).toEqual(['7421000'])
    expect(keep('5555')).toEqual([])
  })

  it('cuts the text around the hit', () => {
    expect(highlightChannelMatch('bot-2e7877', '2E78')).toEqual([
      { text: 'bot-', hit: false }, { text: '2e78', hit: true }, { text: '77', hit: false },
    ])
    expect(highlightChannelMatch('abc', '')).toEqual([{ text: 'abc', hit: false }])
  })
})
