// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveReadySpawnGroupId } from '../../lib/runGroups'

// A switch reaches the two halves of "which workspace, whose groups" at
// different times: currentWorkspace changes in onWorkspaceBrowse, the entered
// workspace's groups arrive several awaits later in _loadRunGroups. The owner
// guard added after the 2026-08-27 wipe closed one exit from that window — a
// save keyed off currentWorkspace writing the LEAVING workspace's list into the
// ENTERED workspace's record. It left the other two open:
//
//   - the tab strip is a computed, so it recomputes inside the window from the
//     entered workspace's panes crossed with the left workspace's groups;
//   - a pane spawned inside the window takes its run_group_id from the LEFT
//     workspace's active tab, and that id is persisted into the entered
//     workspace's pane record — permanently.
//
// The second one is not a flicker. Reading the projects on disk, one id
// (rg-1789476153599, minted 2026-09-15 in Agent-Team as "Run 5") is now also
// IDA's "主要開發" and nt-official's "Run 2"; ids are `rg-${Date.now()}`, so two
// projects cannot mint the same one. ensureSavedGroup then rebuilds the foreign
// id as a group named `Run N` in the workspace it leaked into — the empty tabs
// the user reported.
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

describe('a spawn waits for the groups of the workspace it is spawning into', () => {
  const groups = [{ id: 'rg-1' }, { id: 'rg-2' }]

  it('lands in the active tab once the groups are known to be this workspace\'s', () => {
    expect(resolveReadySpawnGroupId(groups, 'rg-2', true)).toBe('rg-2')
  })

  it('honours an asked-for group the same way, when ready', () => {
    expect(resolveReadySpawnGroupId(groups, 'rg-2', true, 'rg-1')).toBe('rg-1')
  })

  it('hands out no id at all while the groups may belong to another workspace', () => {
    // The pane lands on the manual tab: visible, draggable back, and carrying
    // no claim about a group it may not belong to. Stamping the active tab's id
    // here is what put one workspace's id into another's pane records.
    expect(resolveReadySpawnGroupId(groups, 'rg-2', false)).toBe('')
    expect(resolveReadySpawnGroupId(groups, 'rg-2', false, 'rg-1')).toBe('')
  })

  it('still refuses an id no loaded group matches', () => {
    // The pre-existing rule: an id no tab here lists strands the pane.
    expect(resolveReadySpawnGroupId(groups, 'rg-gone', true)).toBe('')
    expect(resolveReadySpawnGroupId(groups, 'rg-2', true, 'rg-gone')).toBe('rg-2')
  })
})

describe('entering a workspace hands the group state over in the same tick', () => {
  it('swaps the on-screen groups where currentWorkspace changes', () => {
    // Not in a watcher and not after an await: every consumer of runGroups is a
    // computed, and the first one to read between the two assignments sees the
    // entered workspace's panes crossed with the left workspace's groups.
    const browse = body('onWorkspaceBrowse')
    const swapAt = browse.indexOf('_adoptGroupsForEnteredWorkspace(path)')
    const setAt = browse.indexOf('currentWorkspace.value = path')
    expect(setAt).toBeGreaterThan(-1)
    expect(swapAt).toBeGreaterThan(setAt)
    // Comments stripped: the claim is about what runs between the two, and the
    // comment explaining it says the word too.
    const between = browse.slice(setAt, swapAt).replace(/\/\/.*$/gm, '')
    expect(between).not.toContain('await')
  })

  it('takes the entered workspace\'s own cached list, not the one on screen', () => {
    const adopt = body('_adoptGroupsForEnteredWorkspace')
    expect(adopt).toContain('runGroupsByWorkspace.value[normWs(path)] ?? []')
    expect(adopt).toContain('runGroups.value =')
  })

  it('leaves ownership unclaimed until the authoritative list lands', () => {
    // The cache can be empty (a workspace this window never viewed) or behind a
    // peer window's edit. Claiming ownership here would let _saveRunGroups
    // write that back — [] included, which is the wipe the owner guard exists
    // to prevent. Unclaimed means: readable, not writable.
    const adopt = body('_adoptGroupsForEnteredWorkspace')
    expect(adopt).toContain("runGroupsOwner.value = ''")
    expect(adopt).not.toContain('runGroupsOwner.value = path')
    // And the one thing that may claim it stays the load itself.
    expect(body('_loadRunGroups')).toContain('runGroupsOwner.value = path')
  })

  it('does not carry the left workspace\'s active tab into the entered one', () => {
    // activeTab is what a spawn stamps onto a pane. Keeping it across the swap
    // is the same leak by another route.
    const adopt = body('_adoptGroupsForEnteredWorkspace')
    expect(adopt).toContain('activeTab.value = resolveActiveTab(cached, \'\')')
  })

  it('says so when a save was dropped for want of an owner', () => {
    // _saveRunGroups returns silently, and a dropped save looks exactly like a
    // save that worked until the next load contradicts it.
    const save = body('_saveRunGroups')
    expect(save).toContain("code: 'runGroups.ownerMismatch'")
  })
})

describe('a spawn cannot stamp another workspace\'s group id', () => {
  it('gates every spawn on the groups being this workspace\'s', () => {
    expect(appSource).toContain('const runGroupsReady = computed(')
    const ready = appSource.slice(appSource.indexOf('const runGroupsReady = computed('))
    expect(ready.slice(0, 300)).toContain(
      'normWs(runGroupsOwner.value) === normWs(currentWorkspace.value)',
    )
  })

  it('routes every spawn site through the gated resolver', () => {
    // Seven sites stamp a group onto a new pane: the MCP standalone spawn (twice,
    // resumed and fresh), the issue handler, the requested spawn, the plan
    // kickoff, the resume, the messaging-named spawn, and the ACP spawn. An
    // eighth added later must not reach for the ungated helpers again.
    expect(occurrences(appSource, 'resolveReadySpawnGroupId(')).toBe(8)
    expect(appSource).not.toContain('resolveManualSpawnGroupId(runGroups.value, activeTab.value)')
    expect(appSource).not.toContain(
      'resolveSpawnGroupId(runGroups.value, activeTab.value, payload.runGroupId',
    )
  })

  it('imports the gated resolver rather than re-deriving the rule', () => {
    expect(appSource).toContain('resolveReadySpawnGroupId')
  })
})

describe('nothing else files one workspace\'s tab state under another', () => {
  it('holds the activeTab write until the groups are this workspace\'s', () => {
    // The watcher persists ui_active_tab keyed off currentWorkspace. Mid-switch
    // that is the entered workspace while the tab is still the left one's — and
    // the write races project.peek, the read fetching the real saved tab. Being
    // handed the entered workspace's cached tab does not make it safe: the
    // cache can be empty or behind, so the write still has to wait.
    const at = appSource.indexOf('watch(activeTab, (v) => {')
    expect(at).toBeGreaterThan(-1)
    const w = appSource.slice(at, appSource.indexOf("active_tab: v,", at))
    expect(w).toContain('runGroupsReady.value')
  })

  it('holds the tab-order write on the same condition', () => {
    // Its companion _saveRunGroups declines while unowned, so letting this one
    // through leaves ui_run_groups and tab_order disagreeing.
    const persist = body('persistTabOrder')
    expect(persist).toContain('if (!runGroupsReady.value) return')
    expect(persist.indexOf('if (!runGroupsReady.value) return')).toBeLessThan(
      persist.indexOf("sendQuiet('project.set_tab_order'"),
    )
  })

  it('leaves the pane-order write reading the filtered list, as it already did', () => {
    // Not gated: it is keyed off panesInView, which is already per-workspace.
    // Pinned here so the gate above is not "helpfully" extended to it.
    const persist = body('persistPaneOrder')
    expect(persist).toContain('panesInView.value.map((p) => p.id)')
    expect(persist).not.toContain('runGroupsReady')
  })
})

describe('a switch always loads the workspace it entered', () => {
  it('forces the check it makes itself past the repeat-check guard', () => {
    // A→B→A within 1.5s: the switch's own check is dropped as a repeat, and
    // with it _loadRunGroups, restoreWorkspacePanes and adoptOrphanRunGroups.
    // The window then sits on the left workspace's groups indefinitely — tabs
    // gone or rebuilt as orphans — with no path back until some later check.
    expect(body('switchToWorkspace')).toContain('await onWorkspaceCheck(path, { force: true })')
  })

  it('takes the force flag at the guard, and nowhere else', () => {
    const check = body('onWorkspaceCheck')
    expect(check).toContain('async function onWorkspaceCheck(path: string, opts?: { force?: boolean })')
    expect(check).toContain('if (!opts?.force && path === lastWorkspaceCheck.path')
  })

  it('still records the check, so the debounced twin is dropped as before', () => {
    // ControlPane's 400ms debounce fires for the same switch. Forcing the first
    // must not stop it recording — that is what drops the second.
    const check = body('onWorkspaceCheck')
    const guardAt = check.indexOf('if (!opts?.force && path === lastWorkspaceCheck.path')
    const recordAt = check.indexOf('lastWorkspaceCheck = { path, at: now }')
    expect(recordAt).toBeGreaterThan(guardAt)
    // Outside the guard's own branch: the record happens on the forced path too.
    expect(check.slice(guardAt, recordAt)).toContain('return')
  })

  it('leaves the debounced entry point unforced', () => {
    // ControlPane must keep going through the guard, or the pair of checks a
    // single switch makes both run and the second aborts the first's restore.
    expect(appSource).not.toContain('onWorkspaceCheck(path, { force: true })\n    // ControlPane')
    expect(occurrences(appSource, '{ force: true }')).toBe(1)
  })
})
