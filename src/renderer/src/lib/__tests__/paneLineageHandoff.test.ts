// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPaneLineage, lineageHandoff, rekeyChildren, type LineagePane } from '../paneLineage'

// A chat wake that finds no placeholder opens the conversation in a NEW pane
// and retires the old record; the backend moves the children onto the new pane
// (_retire_superseded) and tells the window with pane.lineage_rekeyed. Without
// it the window's children keep the retired id, and the tree renders them as
// roots until the next reload (the 2026-11-01 report).

describe('wake hand-off re-keys the window lineage', () => {
  it('moves every child of the retired pane under the new one', () => {
    const panes: LineagePane[] = [
      { id: 'cmd-new' },
      { id: 'kid-a', spawnedBy: 'cmd-old' },
      { id: 'kid-b', spawnedBy: 'cmd-old' },
      { id: 'grandkid', spawnedBy: 'kid-a' },
      { id: 'other' },
    ]
    const handoff = lineageHandoff({ workspace_path: '/ws', old_pane_id: 'cmd-old', new_pane_id: 'cmd-new' })
    expect(handoff).toEqual({ oldId: 'cmd-old', newId: 'cmd-new' })
    expect(rekeyChildren(panes, (p) => p.id, handoff!.oldId, handoff!.newId)).toBe(true)
    expect(panes.find((p) => p.id === 'kid-a')?.spawnedBy).toBe('cmd-new')
    expect(panes.find((p) => p.id === 'kid-b')?.spawnedBy).toBe('cmd-new')
    expect(panes.find((p) => p.id === 'grandkid')?.spawnedBy).toBe('kid-a')
    expect(buildPaneLineage(panes, new Set()).map((r) => `${r.depth}:${r.id}`)).toEqual([
      '0:cmd-new', '1:kid-a', '2:grandkid', '1:kid-b', '0:other',
    ])
  })

  it('drops a self-reference and reports when nothing moved', () => {
    const items = [{ paneId: 'cmd-new', spawnedBy: 'cmd-old' as string | undefined }]
    expect(rekeyChildren(items, (e) => e.paneId, 'cmd-old', 'cmd-new')).toBe(true)
    expect(items[0].spawnedBy).toBeUndefined()
    expect(rekeyChildren(items, (e) => e.paneId, 'cmd-old', 'cmd-new')).toBe(false)
  })

  it('ignores an event that names no hand-off', () => {
    expect(lineageHandoff(null)).toBeNull()
    expect(lineageHandoff({ old_pane_id: 'a' })).toBeNull()
    expect(lineageHandoff({ old_pane_id: 'a', new_pane_id: 'a' })).toBeNull()
  })

  it('is wired: App.vue applies the event through rekeyLineage', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
    const at = app.indexOf("backend.on('pane.lineage_rekeyed'")
    expect(at).toBeGreaterThan(-1)
    const body = app.slice(at, app.indexOf('\n})', at))
    expect(body).toContain('lineageHandoff(')
    expect(body).toContain('rekeyLineage(')
  })
})
