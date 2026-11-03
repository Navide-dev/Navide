// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text.
//
// Every case below shares one failure mode, which is why they sit together:
// buildPaneLineage treats a parent it cannot resolve as a ROOT and reports
// nothing. Each way of losing a parent therefore looks identical from the
// outside — the tree silently comes back flat — and none of them throws.

const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

function bodyOf(signature: string): string {
  const at = appSource.indexOf(signature)
  expect(at).toBeGreaterThan(-1)
  return appSource.slice(at, appSource.indexOf('\n}', at))
}

describe('lineage survives a resume', () => {
  it('reads the resumed pane parent from the backend record', () => {
    // The pane record is the authoritative source: it outlives the pane, and
    // the backend re-keys its spawned_by to the parent's CURRENT id. History
    // keeps a durable copy too, but only as the fallback below.
    const fn = bodyOf('async function resumablePaneState')
    expect(fn).toContain("sendQuiet<ProjectPayload>('project.peek'")
    expect(fn).toContain('rec.pane_id === historyPaneId')
    expect(fn).toContain('spawned_by')
  })

  it('applies the recorded parent verbatim, like the MCP resume path', () => {
    // Deliberately NOT filtered against the live pane list. A parent this
    // window cannot resolve may be live in another one; buildPaneLineage
    // already renders an unresolvable parent as a root, so filtering buys no
    // display benefit — and writing '' into the record instead would destroy a
    // real relationship the next full restore would have put back.
    // App.resumeSession.test.ts pins the same rule for createRequestedPane:
    // the record must agree with where the pane was placed.
    const fn = bodyOf('async function resumablePaneState')
    expect(fn).toContain('spawnedBy: recorded?.spawned_by ?? history?.spawnedBy ?? fallbackParent')
    expect(fn).not.toContain('panes.value.some(')
  })

  it('puts a history resume back under its parent', () => {
    const fn = bodyOf('async function onManualResume')
    expect(fn).toContain('payload.historyPaneId')
    expect(fn).toContain('resumablePaneState(payload.historyPaneId, workspacePath, payload.spawnedBy)')
    // Into the live pane...
    expect(fn).toContain('spawnedBy: resumeSpawnedBy || undefined')
    // ...and into the NEW record, or the next restart flattens it again. The
    // resume gets a fresh pane id with no previous_pane_id, so the backend
    // creates a new record and nothing else would ever fill this in.
    // Both take the SAME value: a record that disagreed with where the pane
    // was actually placed would pull the conversation somewhere else on the
    // next restore (App.resumeSession.test.ts pins this for the MCP path).
    expect(fn).toContain('spawned_by: resumeSpawnedBy')
  })

  it('leaves the ad-hoc Resume field parentless', () => {
    // Manual Spawn → Resume passes no historyPaneId. It has no pane to
    // inherit from, and must not fall back to whoever is focused.
    const fn = bodyOf('async function onManualResume')
    expect(fn).toMatch(/payload\.historyPaneId\s*\n?\s*\?\s*await resumablePaneState/)
    expect(fn).toContain("const resumeSpawnedBy = historyState?.spawnedBy ?? ''")
  })

  it('re-keys the whole eager restore once every pane has landed', () => {
    // The eager spawns run under Promise.all. rekeyLineage inside
    // spawnRestoredPane only repoints children ALREADY in panes.value, so a
    // parent finishing first left every later child holding the retired id —
    // a dead pointer no subsequent pass would have fixed.
    const at = appSource.indexOf('if (!fullRestore) {')
    expect(at).toBeGreaterThan(-1)
    const branch = appSource.slice(at, appSource.indexOf('sortByIdOrder(panes.value', at))
    expect(branch).toContain('toRestore.forEach((saved, idx) => {')
    expect(branch).toContain('rekeyLineage(saved.pane_id, newId)')
    // It has to run after the barrier, not inside the map.
    const awaitAll = branch.indexOf('await Promise.all(')
    const finalRekey = branch.indexOf('toRestore.forEach((saved, idx) => {')
    expect(awaitAll).toBeGreaterThan(-1)
    expect(finalRekey).toBeGreaterThan(awaitAll)
  })

  it('keeps the reclaim snapshot in step with the restore record', () => {
    // projectPaneFromActive claims to mirror what cold restore reads back, so
    // the realize path cannot tell the two apart. It was missing both of
    // these: a reclaimed pane realized from this snapshot came back as a root,
    // and came back expanded.
    const fn = bodyOf('function projectPaneFromActive')
    expect(fn).toContain('spawned_by: pane.spawnedBy')
    expect(fn).toContain('collapsed: collapsedPanes.value.has(pane.id)')
  })
})

describe('lineage is persisted in the workspace', () => {
  it('writes the parent into the history entry at spawn', () => {
    // The pane record is authoritative while it lasts, but records are pruned
    // and history is not — and resuming from Agent History is precisely the
    // case where the record may be long gone.
    const at = appSource.indexOf('spawnHistory.value.push({')
    expect(at).toBeGreaterThan(-1)
    const block = appSource.slice(at, appSource.indexOf('})', at))
    expect(block).toContain('spawnedBy: pane.spawnedBy')
  })

  it('carries the parent over when a closed pane is backfilled', () => {
    // The backfill reads the record anyway; this is the last point at which a
    // closed pane's parent is still knowable.
    const at = appSource.indexOf('for (const saved of removedManual) {')
    expect(at).toBeGreaterThan(-1)
    const block = appSource.slice(at, appSource.indexOf('backfilledIds.add', at))
    expect(block).toContain('spawnedBy: saved.spawned_by || undefined')
  })

  it('re-keys the history copy alongside the live one', () => {
    // History outlives the pane record, so a stale pointer there survives
    // restarts — and a resume falling back to it would rebuild the tree
    // against a pane retired long ago.
    const fn = bodyOf('function rekeyLineage')
    // rekeyChildren (lib/paneLineage) drops the self-reference; its own test runs it.
    expect(fn).toContain('rekeyChildren(spawnHistory.value, (e) => e.paneId, oldId, newId)')
    // Reassigned, not mutated in place, or the persistence watcher never fires
    // and the re-key is lost on the next restart.
    expect(fn).toContain('spawnHistory.value = [...spawnHistory.value]')
  })

  it('prefers the record and falls back to history only when it is missing', () => {
    // An empty spawned_by on a live record is a positive statement that the
    // pane is a root. Treating it as "unknown" would let a stale history entry
    // re-parent a pane the user deliberately dragged out.
    const fn = bodyOf('async function resumablePaneState')
    expect(fn).toContain('spawnedBy: recorded?.spawned_by ?? history?.spawnedBy ?? fallbackParent')
    expect(fn).not.toContain("?.spawned_by ?? ''")
  })
})

describe('a restored child keeps its parent run group', () => {
  it('walks up the lineage when a record has no group of its own', () => {
    // workspaceGroups sections by run group and assumes a child shares its
    // parent's. A record written before the group existed breaks that, and the
    // fallbacks then split parent and child across sections — the tree looks
    // broken even though the lineage survived.
    const at = appSource.indexOf('const inheritedGroupId = (saved: ProjectPane): string => {')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n  }', at))
    expect(fn).toContain('savedByPaneId.get(cur.spawned_by)')
    // A spawned_by chain that loops must not hang the restore.
    expect(fn).toContain('seen.has(cur.pane_id)')
  })

  it('never overrides a group the user chose', () => {
    // run_group_id '' is NOT "unassigned": dragging a pane to the 手動 tab
    // writes it on purpose, and so does deleting the last tab. Inheriting on
    // every empty value would undo the user's own placement on the next
    // restart. Only pipeline panes inherit — their fallback
    // (ensureRestoreGroup) was a tab they never chose either way.
    const at = appSource.indexOf('const inheritedGroupId = (saved: ProjectPane): string => {')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n  }', at))
    expect(fn).toContain("if (saved.origin !== 'pipeline') return ''")
    // A group of its own always wins, whatever the origin.
    expect(fn).toMatch(/const own = \(saved\.run_group_id \?\? ''\)\.trim\(\)\s*\n\s*if \(own\) return own/)
  })

  it('uses it on both restore branches', () => {
    // Cold placeholders and the eager detached/reattach path each compute the
    // group separately; fixing only one leaves the other splitting trees.
    const uses = appSource.split('inheritedGroupId(saved)').length - 1
    expect(uses).toBe(2)
    expect(appSource).not.toContain("const savedGid = saved.run_group_id || ''")
  })
})


describe('re-parenting is persisted everywhere the pointer lives', () => {
  it('updates the history copy when a pane is dragged to a new parent', () => {
    // Three places hold this pointer: the pane object, the pane record (the
    // backend writes it), and Agent History. Missing the last one means a pane
    // dragged out to the root reappears under its old parent the next time it
    // is resumed — the drag looks undone.
    const fn = bodyOf('async function reparentPane')
    expect(fn).toContain('pane.spawnedBy = spawnedBy || undefined')
    expect(fn).toContain('histEntry.spawnedBy = spawnedBy || undefined')
    expect(fn).toContain('spawnHistory.value = [...spawnHistory.value]')
  })
})

describe('every resume path carries the lineage', () => {
  it('hands the ghost reconnect its own pane id', () => {
    // A reconnect replaces the pane and then kills the old one, so without
    // this the reattached pane comes back a root and the backend hands its
    // children to their grandparent.
    const fn = bodyOf('async function onConfirmReconnect')
    expect(fn).toContain('historyPaneId: paneId')
  })

})
