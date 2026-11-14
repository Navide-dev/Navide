import { describe, expect, it } from 'vitest'
import {
  buildStageTabs,
  type RunGroupLike,
  type StageTabInput,
  type TabPane,
} from '../stageTabs'

// The tab strip's shape. It lived in App.vue and could only be grepped, and
// two of the things it decides are hard to reason about from the source: which
// groups a detached window hides, and when the synthetic tab exists at all.

const pane = (id: string, group?: string): TabPane => ({ id, ...(group ? { runGroupId: group } : {}) })
const G1 = { id: 'g1', name: 'Main work' }
const G2 = { id: 'g2', name: 'Review' }

function tabs(over: Partial<StageTabInput> = {}) {
  return buildStageTabs({
    panes: [],
    groups: [],
    isDetached: false,
    detachedGroupId: '',
    detachedGroupIds: new Set<string>(),
    manualLabel: 'manual',
    orphanLabel: 'orphan',
    defaultLabel: 'Default',
    ...over,
  })
}

describe('buildStageTabs', () => {
  it('makes one tab per run group, in the given order', () => {
    expect(tabs({ groups: [G1, G2] }).map((t) => [t.key, t.label])).toEqual([
      ['g1', 'Main work'],
      ['g2', 'Review'],
    ])
  })

  it('counts a group over the panes it will show', () => {
    const t = tabs({
      groups: [G1, G2],
      panes: [pane('a', 'g1'), pane('b', 'g1'), pane('c', 'g2')],
    })
    expect(t.find((x) => x.key === 'g1')?.count).toBe(2)
    expect(t.find((x) => x.key === 'g1')?.paneIds).toEqual(['a', 'b'])
    expect(t.find((x) => x.key === 'g2')?.count).toBe(1)
  })

  it('shows the default tab in the UI language until it is renamed', () => {
    // The default tab is created as '預設' and project.json keeps that name.
    expect(tabs({ groups: [{ id: 'rg-default', name: '預設' }] })[0].label).toBe('Default')
    expect(tabs({ groups: [{ id: 'rg-default', name: 'Inbox' }] })[0].label).toBe('Inbox')
    expect(tabs({ groups: [{ id: 'g9', name: '預設' }] })[0].label).toBe('預設')
  })

  it('keeps an empty group as a tab', () => {
    // The group exists in the project; a tab with nothing in it is still a
    // place to spawn into.
    const t = tabs({ groups: [G1] })
    expect(t).toHaveLength(1)
    expect(t[0].count).toBe(0)
  })

  it('adds the synthetic tab only when something is ungrouped', () => {
    expect(tabs({ groups: [G1], panes: [pane('a', 'g1')] }).some((t) => t.type === 'manual')).toBe(false)
    const t = tabs({ groups: [G1], panes: [pane('a', 'g1'), pane('m')] })
    const manual = t.find((x) => x.type === 'manual')
    expect(manual?.key).toBe('manual')
    expect(manual?.paneIds).toEqual(['m'])
  })

  it('shows the synthetic tab even with no run groups left', () => {
    // Groups can be deleted while their panes are not; those panes still need
    // somewhere to appear.
    const t = tabs({ groups: [], panes: [pane('m1'), pane('m2')] })
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ type: 'manual', count: 2 })
  })

  it('puts the synthetic tab last', () => {
    const t = tabs({ groups: [G1, G2], panes: [pane('m')] })
    expect(t[t.length - 1].type).toBe('manual')
  })

  it('hides a group this window handed to a detached child', () => {
    const t = tabs({ groups: [G1, G2], detachedGroupIds: new Set(['g1']) })
    expect(t.map((x) => x.key)).toEqual(['g2'])
  })

  it('shows only its own group in a detached window', () => {
    const t = tabs({
      groups: [G1, G2],
      isDetached: true,
      detachedGroupId: 'g2',
      panes: [pane('a', 'g1'), pane('b', 'g2')],
    })
    expect(t.map((x) => x.key)).toEqual(['g2'])
    expect(t[0].paneIds).toEqual(['b'])
  })

  it('never gives a detached window the synthetic tab', () => {
    // It is one group's view; ungrouped panes are not its to show.
    const t = tabs({
      groups: [G1],
      isDetached: true,
      detachedGroupId: 'g1',
      panes: [pane('a', 'g1'), pane('m')],
    })
    expect(t.some((x) => x.type === 'manual')).toBe(false)
  })

  it('leaves an ordinary window untouched by both detach filters', () => {
    const t = tabs({ groups: [G1, G2], panes: [pane('a', 'g1'), pane('m')] })
    expect(t.map((x) => x.key)).toEqual(['g1', 'g2', 'manual'])
  })

  it('surfaces an orphan tab for panes whose group record is missing', () => {
    // A pane with a missing group record is given an orphan tab so it is not
    // lost from the UI while keeping its run group identity.
    const t = tabs({ groups: [G1], panes: [pane('a', 'g1'), pane('ghost', 'deleted-group')] })
    expect(t).toHaveLength(2)
    expect(t[0].paneIds).toEqual(['a'])
    expect(t[1]).toMatchObject({ key: 'deleted-group', label: 'orphan', paneIds: ['ghost'] })
  })

  it('does not fold an orphaned pane into the synthetic tab', () => {
    // Promoting it would make the manual tab's count disagree with the group
    // the pane still claims, and would hide the missing record from the repair.
    const t = tabs({ groups: [G1], panes: [pane('m'), pane('ghost', 'gone')] })
    expect(t.find((x) => x.type === 'manual')?.paneIds).toEqual(['m'])
    expect(t.find((x) => x.key === 'gone')?.paneIds).toEqual(['ghost'])
  })

  it('groups orphans by the id they carry, one tab each', () => {
    const t = tabs({
      groups: [],
      panes: [pane('a', 'gone-1'), pane('b', 'gone-2'), pane('c', 'gone-1')],
    })
    expect(t.map((x) => [x.key, x.count, x.paneIds])).toEqual([
      ['gone-1', 2, ['a', 'c']],
      ['gone-2', 1, ['b']],
    ])
  })

  it('still renders a strip when every pane is orphaned', () => {
    // The whole tab bar disappearing is what the missing-record incident looked
    // like: panes running, listed in the sidebar, openable from nowhere.
    const t = tabs({ groups: [], panes: [pane('a', 'gone'), pane('b', 'gone')] })
    expect(t).not.toEqual([])
    expect(t).toHaveLength(1)
    expect(t[0]).toMatchObject({ key: 'gone', label: 'orphan', type: 'stage', count: 2 })
  })

  it('never rebuilds a tab in a detached window', () => {
    // It is one group's view: an id it does not show is not its to recover.
    const t = tabs({
      groups: [G1],
      isDetached: true,
      detachedGroupId: 'g1',
      panes: [pane('a', 'g1'), pane('ghost', 'gone')],
    })
    expect(t.map((x) => x.key)).toEqual(['g1'])
  })

  it('rebuilds nothing for a group handed to a detached child — the child took its panes', () => {
    // The ordinary hand-off, and the reason the safety net does not need an
    // exclusion for it: detaching moves the group's panes into the child
    // window, so nothing is left here under that id and no tab is raised.
    const t = tabs({ groups: [G1], panes: [pane('m')], detachedGroupIds: new Set(['g1']) })
    expect(t.map((x) => x.key)).toEqual(['manual'])
  })

  it('still rebuilds one when panes of a handed-off group stayed behind', () => {
    // Two states disagreeing: the group is marked handed off, yet this window
    // still holds panes that name it. Skipping it for the hand-off's sake is
    // precisely what leaves those panes on no tab at all, so reachability
    // wins. The tab carries the orphan label either way — the group loop
    // skipped the record, so its name never reached the strip, which is the
    // visible sign that the two states disagree.
    const kept = tabs({
      groups: [G1],
      panes: [pane('a', 'g1')],
      detachedGroupIds: new Set(['g1']),
    })
    expect(kept).toEqual([{ key: 'g1', label: 'orphan', count: 1, type: 'stage', paneIds: ['a'] }])

    // Same when the record is gone as well.
    const noRecord = tabs({
      groups: [],
      panes: [pane('a', 'g1')],
      detachedGroupIds: new Set(['g1']),
    })
    expect(noRecord.map((x) => [x.key, x.paneIds])).toEqual([['g1', ['a']]])
  })

  it('leaves no pane off every tab, whatever the mix', () => {
    // The invariant the rebuilt tab exists for. Detached windows are excluded
    // by design — they show one group, not the workspace.
    const scenarios: { groups: RunGroupLike[]; panes: TabPane[] }[] = [
      { groups: [G1, G2], panes: [pane('a', 'g1'), pane('b', 'g2')] },
      { groups: [G1], panes: [pane('a', 'g1'), pane('m')] },
      { groups: [], panes: [pane('m1'), pane('m2')] },
      { groups: [G1], panes: [pane('ghost', 'gone')] },
      { groups: [], panes: [pane('x', 'gone'), pane('y', 'gone-too')] },
      {
        groups: [G1, G2],
        panes: [pane('a', 'g1'), pane('m'), pane('x', 'gone'), pane('y', 'gone'), pane('b', 'g2')],
      },
    ]
    for (const s of scenarios) {
      const shown = new Set(tabs(s).flatMap((t) => t.paneIds))
      expect(s.panes.filter((p) => !shown.has(p.id)).map((p) => p.id)).toEqual([])
    }
  })
})
