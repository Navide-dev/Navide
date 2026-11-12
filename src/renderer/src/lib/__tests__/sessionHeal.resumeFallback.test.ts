import { describe, expect, it } from 'vitest'
import { markResumeFallback } from '../sessionHeal'

// The backend turned a pinned resume into a new conversation (the transcript
// was not reachable from the pane's account dir). The pane must learn the new
// session like a restored pane does, or the next Rebuild would resume the old
// id again, fall back again and lose the work done since.
describe('markResumeFallback', () => {
  it('marks a pane still pinned to the id that fell back as replaceable', () => {
    const pane: { pinnedSessionId?: string; pinnedFromRestore?: boolean } = { pinnedSessionId: 'old-id' }
    expect(markResumeFallback(pane, 'old-id')).toBe(true)
    expect(pane.pinnedFromRestore).toBe(true)
    expect(pane.pinnedSessionId).toBe('old-id')
  })

  it('leaves a pane that pins something else alone', () => {
    const pane: { pinnedSessionId?: string; pinnedFromRestore?: boolean } = { pinnedSessionId: 'other' }
    expect(markResumeFallback(pane, 'old-id')).toBe(false)
    expect(pane.pinnedFromRestore).toBeUndefined()
  })

  it('does nothing without a fallback id (every ordinary launch)', () => {
    const pane: { pinnedSessionId?: string; pinnedFromRestore?: boolean } = { pinnedSessionId: 'old-id' }
    expect(markResumeFallback(pane, '')).toBe(false)
    expect(pane.pinnedFromRestore).toBeUndefined()
  })
})
