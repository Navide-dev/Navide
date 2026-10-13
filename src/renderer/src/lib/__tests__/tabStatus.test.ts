// rollupTabStatus — one dot per StageTabBar tab, rolled up from the statuses of
// the panes in that tab. Three colours by design: "is anything here waiting on
// me, and failing that, is anything moving?"
// Every case below is a rule the UI depends on, so a change in the vocabulary
// (a new DisplayStatus, say) fails here rather than silently reading as idle.
import { describe, expect, it } from 'vitest'
import { countLivePanes, rollupTabStatus, sameRenderedTabs } from '../tabStatus'

describe('rollupTabStatus', () => {
  it('reports empty for a tab with no panes', () => {
    expect(rollupTabStatus([])).toBe('empty')
  })

  it('reports empty when every pane is an unrealized cold-restore placeholder', () => {
    expect(rollupTabStatus(['waiting', 'waiting'])).toBe('empty')
  })

  it('reports active when any pane is running', () => {
    expect(rollupTabStatus(['idle', 'idle', 'running'])).toBe('active')
  })

  it('counts starting as active — the CLI is booting, not stalled', () => {
    expect(rollupTabStatus(['idle', 'starting'])).toBe('active')
  })

  it('reports idle when every pane is idle', () => {
    expect(rollupTabStatus(['idle', 'idle'])).toBe('idle')
  })

  it.each([
    ['stopped'],
    ['exited'],
    ['error'],
    ['disconnected'],
  ])('reports idle for a tab whose panes are all %s — none of them will move on their own', (status) => {
    expect(rollupTabStatus([status, status])).toBe('idle')
  })

  // The rule this file exists to protect: a tab full of busy panes must still
  // say so when one of them is blocked on a permission prompt. Short-circuiting
  // on 'running' hid exactly that case, which is the one worth walking over to.
  it('reports awaiting when any pane is blocked, even beside a running one', () => {
    expect(rollupTabStatus(['running', 'awaiting', 'running'])).toBe('awaiting')
    expect(rollupTabStatus(['starting', 'awaiting'])).toBe('awaiting')
  })

  it('reports awaiting when every pane is awaiting — not idle', () => {
    expect(rollupTabStatus(['awaiting', 'awaiting'])).toBe('awaiting')
  })

  it('ignores unrealized placeholders when ranking awaiting', () => {
    expect(rollupTabStatus(['waiting', 'awaiting'])).toBe('awaiting')
  })

  it('lets a realized pane outweigh unrealized placeholders', () => {
    expect(rollupTabStatus(['waiting', 'idle'])).toBe('idle')
    expect(rollupTabStatus(['waiting', 'running'])).toBe('active')
  })

  it('does not treat an unknown status as active', () => {
    expect(rollupTabStatus(['something-new'])).toBe('idle')
  })
})

describe('sameRenderedTabs', () => {
  const tabs = [
    { key: 'rg-1', label: 'Main', count: 2, live: 2, status: 'active' as const },
    { key: 'rg-2', label: 'Specs', count: 1, live: 1, status: 'idle' as const }
  ]

  it('treats an identical list as unchanged', () => {
    expect(sameRenderedTabs(tabs, tabs.map((t) => ({ ...t })))).toBe(true)
  })

  it.each([
    ['status', { status: 'idle' as const }],
    ['count', { count: 3 }],
    ['live count', { live: 1 }],
    ['label', { label: 'Renamed' }],
    ['key', { key: 'rg-9' }]
  ])('sees a changed %s', (_field, patch) => {
    const next = [{ ...tabs[0], ...patch }, tabs[1]]
    expect(sameRenderedTabs(tabs, next)).toBe(false)
  })

  it('sees an added or removed tab', () => {
    expect(sameRenderedTabs(tabs, tabs.slice(0, 1))).toBe(false)
    expect(sameRenderedTabs(tabs.slice(0, 1), tabs)).toBe(false)
  })
})

describe('countLivePanes', () => {
  // The workspace heading's "live / total": a cold-restored or reclaimed
  // placeholder is the only pane that reports 'waiting' and holds no process.
  it('counts every pane that is not a waiting placeholder', () => {
    expect(countLivePanes(['running', 'waiting', 'idle', 'disconnected', 'waiting'])).toBe(3)
  })

  it('is zero for a tab of placeholders or no panes', () => {
    expect(countLivePanes(['waiting', 'waiting'])).toBe(0)
    expect(countLivePanes([])).toBe(0)
  })
})
