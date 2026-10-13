import { describe, expect, it } from 'vitest'
import { reclaimRefusalReason, reclaimRequestPaneIds } from '../paneReclaimRequest'
import type { ReclaimBlock } from '../idleReclaim'

describe('reclaimRequestPaneIds', () => {
  it('takes one pane id as a string', () => {
    expect(reclaimRequestPaneIds({ paneId: 'p1' })).toEqual(['p1'])
  })

  it('takes several pane ids as an array, dropping blanks and repeats', () => {
    expect(reclaimRequestPaneIds({ paneId: ['p1', '', 'p2', 'p1', 7] })).toEqual(['p1', 'p2'])
  })

  it('answers empty for no args, a missing paneId or a non-string one', () => {
    expect(reclaimRequestPaneIds(undefined)).toEqual([])
    expect(reclaimRequestPaneIds({})).toEqual([])
    expect(reclaimRequestPaneIds({ paneId: 3 })).toEqual([])
    expect(reclaimRequestPaneIds({ paneId: '  ' })).toEqual([])
  })
})

describe('reclaimRefusalReason', () => {
  const blocks: ReclaimBlock[] = [
    'not-realized', 'restoring', 'focused', 'no-resume-id', 'rebuilding', 'loop-active',
    'preparing', 'injecting', 'spawn-report-pending', 'no-ref', 'manager-routing',
    'global-manager-routing', 'stage-watched', 'has-queued-messages', 'not-idle',
    'has-draft', 'never-touched', 'too-recent',
  ]

  it('explains every guard in words, not just its code', () => {
    for (const block of blocks) {
      const reason = reclaimRefusalReason(block)
      expect(reason.length, block).toBeGreaterThan(10)
      expect(reason, block).not.toBe(block)
    }
  })

  it('names the guards a caller most often hits', () => {
    expect(reclaimRefusalReason('not-idle')).toMatch(/busy|idle/i)
    expect(reclaimRefusalReason('focused')).toMatch(/focus/i)
    expect(reclaimRefusalReason('has-draft')).toMatch(/unsent/i)
    expect(reclaimRefusalReason('no-resume-id')).toMatch(/resume/i)
    expect(reclaimRefusalReason('not-found')).toMatch(/no pane/i)
    expect(reclaimRefusalReason('gone-after-kill')).toMatch(/stopped/i)
    expect(reclaimRefusalReason('error')).toMatch(/fail/i)
  })
})
