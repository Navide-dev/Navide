// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildStageTabs } from '../../lib/stageTabs'

// runGroups is one ref for whichever workspace is on screen, and a switch
// reaches the two halves of that pairing at different times: currentWorkspace
// changes immediately, the entered workspace's groups arrive several awaits
// later. In between, a save keyed off currentWorkspace wrote the LEAVING
// workspace's list into the ENTERED workspace's record — [] whenever the
// leaving project never made a group, so a wipe rather than a no-op. Restore
// hits that window every time, since ensureSavedGroup saves once per restored
// pane.
//
// What it looked like afterwards: the panes kept their run_group_id, so they
// matched no tab, and buildStageTabs did not adopt them into the manual tab
// either — the whole strip stopped rendering and the panes were listed in the
// sidebar but reachable from nowhere. Two things answer that now: buildStageTabs
// surfaces a tab for an id no record matches, and adoptOrphanRunGroups puts the
// record back under that same id rather than clearing the pane.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

/** A top-level declaration's text, up to the next one. */
function body(name: string): string {
  for (const pat of [`async function ${name}(`, `function ${name}(`]) {
    const at = appSource.indexOf(pat)
    if (at < 0) continue
    const rest = appSource.slice(at + pat.length)
    const next = /\n(?:async )?function \w+|\nconst \w+ =|\n\/\*\*/.exec(rest)
    return appSource.slice(at, at + pat.length + (next ? next.index : 4000))
  }
  throw new Error(`${name} not found`)
}

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1

describe('run groups are saved only into the workspace they belong to', () => {
  it('remembers which workspace the loaded list came from', () => {
    // The owner has to be stamped by the load itself. Anything later — a watch,
    // a nextTick — reopens the same gap it exists to close.
    const load = body('_loadRunGroups')
    expect(load).toContain('runGroupsOwner.value = path')
    expect(load.indexOf('runGroupsOwner.value = path')).toBeLessThan(
      load.indexOf('runGroups.value ='),
    )
  })

  it('refuses to persist a list that belongs to another workspace', () => {
    const save = body('_saveRunGroups')
    const guard = 'if (normWs(runGroupsOwner.value) !== normWs(ws)) {'
    expect(save).toContain(guard)
    // Ahead of the write, not merely present somewhere in the function, and it
    // still leaves rather than falling through into it.
    expect(save.indexOf(guard)).toBeLessThan(save.indexOf("sendQuiet('project.set_ui_state'"))
    expect(save.slice(save.indexOf(guard), save.indexOf("sendQuiet('project.set_ui_state'")))
      .toContain('return')
  })

  it('compares the owner against the very path it would write under', () => {
    // Checking one workspace and sending another is the same bug with an extra
    // step, so the payload's workspace_path and the guarded value are one
    // binding.
    const save = body('_saveRunGroups')
    expect(save).toContain('const ws = currentWorkspace.value')
    expect(save).toContain('normWs(ws)')
    expect(save).toContain('workspace_path: ws')
  })

  it('leaves no second path that persists the list unguarded', () => {
    // _loadRunGroups writes the migrated legacy list under its own `path`
    // argument, which is by construction the workspace it just read. Every
    // other persist has to go through the guarded save.
    const total = occurrences(appSource, 'run_groups: runGroups.value')
    const owned =
      occurrences(body('_saveRunGroups'), 'run_groups: runGroups.value') +
      occurrences(body('_loadRunGroups'), 'run_groups: runGroups.value')
    expect(total).toBe(owned)
  })

  it('hands ownership over with the list a peer window sends', () => {
    // The union merge re-saves what it added. Adopting the merged list without
    // moving the owner with it would make that save a silent no-op — and the
    // groups the peer lacked would never reach disk.
    const sync = body('onRunGroupsRemoteSync')
    expect(sync).toContain('runGroupsOwner.value = ws')
    expect(sync.indexOf('runGroupsOwner.value = ws')).toBeLessThan(
      sync.indexOf('runGroups.value = merged'),
    )
  })
})

describe('a superseded workspace check keeps its hands off runGroups', () => {
  it('rechecks the sequence immediately before loading the groups', () => {
    // pipelinesApi.setActivePipeline and stagesApi.refresh sit between the
    // earlier guard and this load, and either can span a switch. A superseded
    // check landing here pairs the workspace now on screen with the groups of
    // the one being left.
    expect(body('onWorkspaceCheck')).toContain(
      'if (seq !== workspaceCheckSeq || currentWorkspace.value !== path) return\n' +
        '    _loadRunGroups(path, resp.project)',
    )
  })

  it('does not lean on the guard taken before those awaits', () => {
    // The check already guards once, further up. What made a second one
    // necessary is the awaits between them — and what keeps it sufficient is
    // that nothing awaits again before the load.
    const check = body('onWorkspaceCheck')
    const guard = 'if (seq !== workspaceCheckSeq || currentWorkspace.value !== path) return'
    const loadAt = check.indexOf('_loadRunGroups(path, resp.project)')
    const first = check.indexOf(guard)
    const second = check.lastIndexOf(guard, loadAt)
    expect(first).toBeLessThan(second)
    expect(check.slice(first, second)).toContain('await')
    expect(check.slice(second, loadAt)).not.toContain('await')
  })
})

describe('restore puts back a tab whose record was lost', () => {
  it('recreates the missing group under the id the pane already holds', () => {
    // Routing the pane to some other group instead would be written back by the
    // spawn upsert, permanently replacing the saved assignment.
    const restore = body('restoreWorkspacePanes')
    expect(restore).toContain('const ensureSavedGroup = (gid: string): string => {')
    // savedGroupToRecreate builds the record under that same id (its own test
    // pins the shape); here it only has to be added to the list.
    expect(restore).toContain('runGroups.value = [...runGroups.value, missing]')
    expect(restore).toContain('return gid')
    // Both restore shapes — cold placeholders and the eager detached/only-group
    // path — take a saved id through it.
    expect(occurrences(restore, '? ensureSavedGroup(savedGid)')).toBe(2)
  })

  it('adopts orphaned group ids only after restore has had its say', () => {
    // Run before the panes are back, the adoption sees nothing to put back on a
    // cold start; run before ensureSavedGroup, it would rebuild a record the
    // restore is about to write anyway.
    const check = body('onWorkspaceCheck')
    const restoreAt = check.indexOf('await restoreWorkspacePanes(resp, path, undefined,')
    const adoptAt = check.indexOf('adoptOrphanRunGroups(path)')
    const resolveAt = check.indexOf('activeTab.value = resolveActiveTab(runGroups.value, activeTab.value)')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(adoptAt).toBeGreaterThan(restoreAt)
    expect(adoptAt).toBeLessThan(resolveAt)
    // And nowhere earlier in the check, which is where it used to sit.
    expect(check.slice(0, restoreAt)).not.toContain('adoptOrphanRunGroups')
  })

  it('rebuilds the missing record instead of clearing the pane that named it', () => {
    // The pane's run_group_id is the only surviving record of the assignment,
    // so clearing it — the repair this replaced did exactly that — destroys the
    // grouping with no way back. Nothing in here may write a pane's group id —
    // neither in memory (`runGroupId = undefined`) nor through the persist
    // helper the old repair called with an empty id.
    const adopt = body('adoptOrphanRunGroups')
    expect(adopt).toContain('const gid = pane.runGroupId')
    expect(adopt).not.toContain('persistPaneRunGroup')
    expect(adopt).not.toMatch(/runGroupId\s*=[^=]/)
  })

  it('puts the orphaned id itself back into runGroups', () => {
    // Under the same id, so the pane it came from lands on that very tab.
    const adopt = body('adoptOrphanRunGroups')
    expect(adopt).toContain('runGroups.value = [')
    expect(adopt).toContain('...runGroups.value,')
    expect(adopt).toContain('createdAt: runGroupCreatedAt(id)')
    expect(adopt).toContain('_saveRunGroups()')
  })

  it('is why the same id matters: only then does the pane land on its own tab', () => {
    const pane = { id: 'p1', runGroupId: 'rg-7' }
    const strip = (groupId: string) =>
      buildStageTabs({
        panes: [pane],
        groups: [{ id: groupId, name: 'Run 1' }],
        isDetached: false,
        detachedGroupId: '',
        detachedGroupIds: new Set<string>(),
        manualLabel: 'manual',
        orphanLabel: 'recovered',
      })
    expect(strip('rg-7')[0].paneIds).toEqual(['p1'])
    // A fresh id still leaves the pane reachable — the safety net catches it —
    // but on a nameless recovered tab, while the rebuilt group sits empty.
    expect(strip('rg-new').map((t) => [t.key, t.label, t.paneIds])).toEqual([
      ['rg-new', 'Run 1', []],
      ['rg-7', 'recovered', ['p1']],
    ])
  })
})

describe('a move between tabs that did not persist does not stay on screen', () => {
  it('puts the pane back on the tab it came from when the write fails', () => {
    // The move is optimistic — the pane jumps tabs before the write lands — so
    // a failed write leaves the screen showing a move that did not happen: the
    // record still names the old group, and the next restore takes the pane
    // back without a word.
    const move = body('movePaneToGroup')
    expect(move).toContain('const previous = pane.runGroupId')
    expect(move).toContain(
      'if (!(await persistPaneRunGroup(pane, targetGroupId))) pane.runGroupId = previous',
    )
  })

  it('remembers the old group before overwriting it', () => {
    // Read after the optimistic assignment, `previous` is the new value and
    // the restore is a no-op.
    const move = body('movePaneToGroup')
    expect(move.indexOf('const previous = pane.runGroupId')).toBeLessThan(
      move.indexOf('pane.runGroupId = targetGroupId'),
    )
  })

  it('restores per pane, not per batch', () => {
    // A drag can carry a multi-selection, and the writes are independent: one
    // failing must not undo the ones that landed, nor be covered by them.
    const move = body('movePaneToGroup')
    const loopAt = move.indexOf('for (const id of paneDragBatch(paneId))')
    expect(loopAt).toBeGreaterThan(-1)
    expect(move.indexOf('const previous = pane.runGroupId')).toBeGreaterThan(loopAt)
    expect(move.indexOf('pane.runGroupId = previous')).toBeGreaterThan(loopAt)
  })
})

describe('a relaunch restores other held workspaces without touching the list on screen', () => {
  // restoreWorkspacePanes runs for every workspace the window holds, while
  // runGroups is the viewed one's. Recreating a missing group there filed the
  // other workspace's group into the viewed record as an empty `Run N` tab.
  const restore = body('restoreWorkspacePanes')

  it('decides recreation against the workspace being restored', () => {
    expect(restore).toContain(
      'savedGroupToRecreate(runGroups.value, gid, workspacePath, currentWorkspace.value)',
    )
  })

  it('takes a fallback group only from the restored workspace\'s own list', () => {
    expect(restore).toContain('if (normWs(workspacePath) !== normWs(currentWorkspace.value)) {')
    expect(restore).toContain("return runGroupsOf(workspacePath)[0]?.id ?? ''")
  })
})
