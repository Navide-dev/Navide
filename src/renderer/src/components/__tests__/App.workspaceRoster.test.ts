// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Mounting App starts backend/terminal lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text.
//
// The workspace layer of the sidebar rests entirely on one backend contract:
// agent_msg.list returns EVERY registered pane when no workspace_path is
// given, and only the matching ones when it is. Passing the current workspace
// there would still return a valid answer, so the feature would degrade to a
// single section with no error anywhere — exactly the kind of silent failure
// a test has to catch.

const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)

describe('several workspaces in one window', () => {
  it('feeds the grouping builder every input it needs', () => {
    // The grouping itself moved to lib/workspaceGroups and is tested by
    // running it — App.vue cannot be mounted, so it could only ever be
    // grepped from here. What remains App's job is passing the right things
    // in: a missing input silently drops a whole band of the sidebar.
    const start = appSource.indexOf('const workspaceGroups = computed')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n)', start))
    expect(body).toContain('buildWorkspaceGroups({')
    // And nothing about other windows: the sidebar lists what THIS window
    // holds. Feeding it the machine-wide registry put the same project in
    // every window at once, one copy live and the rest read-only.
    expect(body).not.toContain('roster')
    expect(body).not.toContain('openPaths')
    for (const input of [
      'here: currentWorkspace.value',
      'order: workspaceOrder.value',
      'panes: panes.value',
      'lineage: paneLineage.value',
      'collapsed: collapsedWorkspaces.value',
      'homeDir: homeDir.value',
    ]) {
      expect(body, input).toContain(input)
    }
  })

  it('adds a picked workspace to THIS sidebar, not a new window', () => {
    const start = appSource.indexOf('async function openWorkspaceFromPicker')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('adoptWorkspace')
    expect(body).not.toContain('openMainWindow')
    // One already open elsewhere is still focused there: its panes live in the
    // window that owns them, and two windows on one folder would run two sets
    // of PTY and git operations on it.
    expect(body).toContain('focusWorkspaceWindow')
    // And it never repoints this window at it.
    expect(body).not.toContain('currentWorkspace.value =')
  })

  it('keeps adopted workspaces deduped and remembered', () => {
    const start = appSource.indexOf('function adoptWorkspace')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    // Never the primary, never twice — both come from the one predicate.
    expect(body).toContain('isLocalWorkspace(path)')
    expect(body).toContain('persistExtraWorkspaces')
    const pStart = appSource.indexOf('function isLocalWorkspace')
    const pred = appSource.slice(pStart, appSource.indexOf('\n}', pStart))
    expect(pred).toContain('normWs(currentWorkspace.value)')
    expect(pred).toContain('workspaceOrder.value.some')
    expect(appSource).toContain('sessionStorage.setItem(EXTRA_WS_KEY')
  })

  it('reuses the Welcome picker rather than a second copy of it', () => {
    // Browse / New / Home, the recent list, pinning, the already-open badge —
    // a rebuilt picker would drift from all of it.
    expect(appSource).toContain('v-else-if="workspacePickerOpen"')
    expect(appSource).toContain('@select="openWorkspaceFromPicker"')
    // Startup keeps its own non-dismissible instance.
    expect(appSource).toContain('v-if="!workspaceSelected"')
  })

  it('the titlebar no longer renders a duplicate workspace control', () => {
    // The reveal action remains available to Host contribution flows, but the
    // old titlebar workspace control itself must not return.
    expect(appSource).not.toContain('titlebar-workspace')
  })

  it('opens a picked workspace by actually going to it', () => {
    // A list headed "Open Workspace" that adds a sidebar row and leaves the
    // window on the previous project reads as nothing having happened. The
    // switch also loads it, which is what brings its persisted agents back —
    // a project with work in it must not come up empty.
    const start = appSource.indexOf('async function openWorkspaceFromPicker')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('adoptWorkspace(path)')
    expect(body).toContain('await switchToWorkspace(path)')
    // The restore rides on the switch rather than being done twice.
    expect(body).not.toContain('restoreWorkspacePanes')
  })

  it('lets restore run for any workspace this window holds', () => {
    // restoreWorkspacePanes and its helpers guarded on currentWorkspace, which
    // an adopted workspace is not — every one of those became isLocalWorkspace.
    const start = appSource.indexOf('async function restoreWorkspacePanes')
    const body = appSource.slice(start, appSource.indexOf('\nasync function restoreSessionDecision', start))
    expect(body).not.toContain('currentWorkspace.value !== workspacePath')
    expect(body).toContain('isLocalWorkspace(workspacePath)')
  })

  it('leaves no restore path comparing against currentWorkspace', () => {
    // The one-workspace-per-window assumption was spelled four different ways
    // — workspacePath, session.workspacePath, deferred.workspacePath,
    // batch.workspacePath — so the first sweep missed some and a restored
    // placeholder in an adopted workspace silently would not start. Anything
    // still comparing a *.workspacePath against currentWorkspace inside the
    // restore/realize functions is a missed one.
    const region = appSource.slice(
      appSource.indexOf('async function restoreWorkspacePanes'),
      appSource.indexOf('const paneLineage = computed')
    )
    expect(region.length).toBeGreaterThan(0)
    const leaks = region.match(/currentWorkspace\.value [!=]==? \w*\.?workspacePath/g) ?? []
    expect(leaks).toEqual([])
  })

  it('shows one workspace in the grid at a time', () => {
    // Switching is a change of view: the workspaces left behind keep running
    // and keep their sidebar headings, they are just not on screen.
    // The filter itself is lib/paneVisibility, tested by running it. Here:
    // App must hand it the OTHER workspaces, not the viewed one.
    const start = appSource.indexOf('const panesInView = computed')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n)', start))
    expect(body).toContain('panesOfViewedWorkspace(panes.value, extraWorkspaces.value)')
  })

  it('counts a tab over the same panes the tab will show', () => {
    // stageTabShapes built its counts from every pane in the window. After a
    // switch, the other workspace's ungrouped panes landed in this one's
    // manual-tab count while the grid filter — correctly — refused to show
    // them: a tab reading "3" with nothing behind it.
    // The strip's shape is lib/stageTabs, tested by running it. What App must
    // do is feed it the workspace-filtered panes — the bug was a count taken
    // over every pane in the window while the stage filtered by workspace.
    const start = appSource.indexOf('const stageTabShapes = computed')
    const shapes = appSource.slice(start, appSource.indexOf('\n)', start))
    // panesOnStage IS panesInView in the default sidebar mode; free mode is the
    // one case where the stage deliberately shows every workspace at once, and
    // its tabs follow the same list so a count still matches what opens.
    expect(shapes).toContain('panes: panesOnStage.value')
    expect(shapes).not.toContain('panes: panes.value')
    expect(appSource).toContain('sidebarMode.value === \'free\' ? panes.value : panesInView.value')
    // The synthetic tab's label was hard-coded Chinese, so an English UI
    // showed a Chinese tab. The key had existed all along.
    expect(shapes).toContain("manualLabel: i18n.global.t('label.manual')")
    // And the grid filter narrows the same source rather than rebuilding it.
    const gStart = appSource.indexOf('const tabFilteredPaneIds = computed')
    const grid = appSource.slice(gStart, appSource.indexOf('\n)', gStart))
    expect(grid).toContain('panesOfActiveTab(panesOnStage.value')
  })

  it('keeps the sweeping actions inside the workspace on screen', () => {
    // Kill-all hangs off one workspace's heading and is unrecoverable, so it
    // never reaches past the workspace on screen.
    const kStart = appSource.indexOf('async function onKillAll')
    expect(kStart).toBeGreaterThan(-1)
    const kill = appSource.slice(kStart, appSource.indexOf('\n}', kStart))
    expect(kill).toContain('panesInView.value')
    expect(kill).not.toContain('panes.value')
    // Rebuild is the one action that may name a workspace: every heading
    // carries its own ↻, and rebuild reads each pane's own workspacePath, so
    // another project's panes rebuild in place. Named nowhere — the toolbar,
    // the tab strip — it still means the workspace on screen.
    const start = appSource.indexOf('async function rebuildPanesViaResume')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('normWs(p.workspacePath) === normWs(workspacePath)')
    expect(body).toContain(': panesInView.value')
    expect(body).toContain('const ids = pool')
    // The count behind the toolbar's copy of the button stays on screen too.
    const cStart = appSource.indexOf('const rebuildableAllPaneCount')
    const count = appSource.slice(cStart, appSource.indexOf('\n)', cStart))
    expect(count).toContain('panesInView.value')
    expect(count).not.toContain('panes.value')
  })

  it('stops offering the all keyword once here is ambiguous', () => {
    // sendBroadcast reaches every pane the WINDOW registers, and `all` is
    // documented as workspace-local. Rather than teach the messaging registry
    // about workspaces, the menu stops offering the keyword — typing it by
    // hand still broadcasts window-wide, which the comment says out loud.
    const start = appSource.indexOf('function mentionCandidatesFor')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('extraWorkspaces.value.length === 0')
  })

  it('names the workspace being viewed in the titlebar', () => {
    // With several workspaces in one window, switching changed everything
    // below the titlebar and nothing in it. document.title already carried the
    // name for Mission Control; the bar itself said nothing.
    expect(appSource).toContain('class="titlebar-name titlebar-name--ws"')
    expect(appSource).toContain('{{ workspaceBaseName }}')
    // Sized to its text, centred by the spacers either side.
    expect(appSource).toContain('.titlebar-name--ws {')
    const at = appSource.indexOf('.titlebar-name--ws {')
    expect(appSource.slice(at, at + 120)).toContain('flex: 0 1 auto')
  })

  it('puts the path after that name', () => {
    // Two projects can share a folder name, so the name alone does not say
    // which one the window is looking at. Same shortening as the sidebar's
    // paths — home collapsed to ~ — rather than a second convention.
    expect(appSource).toContain('class="titlebar-path"')
    expect(appSource).toContain('{{ workspaceDisplayPath }}')
    expect(appSource).toContain('collapseHomePath(currentWorkspace.value, homeDir.value)')
    // Hidden until asked for: the path is long, and the name is what the bar
    // is for. Hovering swaps one for the other rather than showing both.
    const at = appSource.indexOf('.titlebar-path {')
    expect(at).toBeGreaterThan(-1)
    expect(appSource.slice(at, at + 200)).toContain('display: none')
    expect(appSource).toContain('.titlebar-id:hover .titlebar-name--ws { display: none; }')
    expect(appSource).toContain('.titlebar-id:hover .titlebar-path { display: block; }')
    // The bar is a drag region, and a drag region swallows hover.
    const box = appSource.indexOf('.titlebar-id {')
    expect(appSource.slice(box, box + 220)).toContain('-webkit-app-region: no-drag')
  })

  it('does not stamp another workspace group onto a pane', () => {
    // Run groups are per-workspace and only the viewed one's are loaded. The
    // ＋ on another workspace's heading spawns THERE; giving that pane a group
    // from THIS workspace's set leaves it on no tab over there — in the
    // sidebar, running, and unreachable.
    const at = appSource.indexOf('async function onManualSpawn')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(fn).toContain('const onScreen = normWs(target) === normWs(currentWorkspace.value)')
    expect(fn).toContain('const spawnGroupId = onScreen')
    // The branch exists, and its false arm is the empty id — a pane bound for
    // another workspace is ungrouped there, not stamped from this one's set.
    expect(fn).toContain("    : ''")
  })

  it('adopts the group a pane names instead of stripping the pane', () => {
    // The data is repaired rather than the view, but never by clearing the
    // pane: its run_group_id is the only surviving record of the assignment, so
    // clearing it destroyed the grouping for good — and did it to the whole
    // workspace at once. Rebuilding the record under that same id restores the
    // tab and leaves every pane alone.
    const at = appSource.indexOf('function adoptOrphanRunGroups')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(fn).toContain('const known = new Set(runGroups.value.map((g) => g.id))')
    expect(fn).toContain('known.has(gid)')
    expect(fn).toContain('createdAt: runGroupCreatedAt(id)')
    expect(fn).not.toContain('persistPaneRunGroup')
    expect(fn).not.toContain('pane.runGroupId = undefined')
  })

  it('adopts only after this workspace groups are authoritative', () => {
    // Before _loadRunGroups the list still belongs to the workspace being left,
    // so every id would look orphaned and this workspace would gain a tab for
    // every group of the one being left.
    expect(appSource.indexOf('_loadRunGroups(path, resp.project)')).toBeLessThan(
      appSource.indexOf('adoptOrphanRunGroups(path)')
    )
  })

  it('realizes a child against its live parent, not the snapshot', () => {
    // `saved` is a snapshot taken when the workspace loaded. Realizing the
    // PARENT gives it a new id and rekeyLineage repoints its children in
    // memory — but the snapshot still names the retired id. Writing that back
    // over the live value makes the child parentless, and a child with no
    // resolvable parent is a root: it leaves the subtree and sorts to the end.
    const at = appSource.indexOf('async function spawnRestoredPane')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(fn).toContain('spawnedBy: opts.spawnedBy || saved.spawned_by || undefined')
  })

  it('hands realize the placeholder live parent', () => {
    const at = appSource.indexOf('async function performRealizeRestoredPane')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(fn).toContain('spawnedBy: placeholder.spawnedBy')
  })

  it('keeps rekeyLineage as the thing that maintains it', () => {
    // The live value is only worth preferring because something keeps it
    // current. Every path that gives a pane a new id calls this.
    const at = appSource.indexOf('function rekeyLineage(')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(fn).toContain('rekeyChildren(panes.value, (p) => p.id, oldId, newId)')
  })

  it('gives a restore placeholder its parent', () => {
    // Without it buildPaneLineage cannot link the pane: an agent-spawned pane
    // came back flat and in spawn order until it was realized, which is when
    // the tree finally appeared. The backend persists and re-keys spawned_by
    // precisely so the shape survives a restart.
    const at = appSource.indexOf('const placeholder: ActivePane = {')
    expect(at).toBeGreaterThan(-1)
    const block = appSource.slice(at, appSource.indexOf('panes.value.push(placeholder)', at))
    expect(block).toContain('spawnedBy: saved.spawned_by || undefined')
  })

  it('lets go of a workspace it closes', () => {
    // Clearing currentWorkspace alone left it in workspaceOrder, so the window
    // still claimed to hold it: main kept reporting it open — the Recent list
    // showed the badge on a project just closed — and the sidebar listed it
    // beside the panes that had been killed.
    const at = appSource.indexOf('async function doCloseWorkspace')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(fn).toContain('const remaining = workspaceOrder.value.filter')
    expect(fn).toContain('workspaceOrder.value = remaining')
    expect(fn).toContain('persistExtraWorkspaces()')
  })

  it('captures what it holds before blanking the current workspace', () => {
    // panesInView and extraWorkspaces are both derived from currentWorkspace.
    // Reading either after it goes blank answers about a different set — which
    // is why the pane capture already sits above, and the release must too.
    const at = appSource.indexOf('async function doCloseWorkspace')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(fn.indexOf('const closing = currentWorkspace.value')).toBeLessThan(
      fn.indexOf("currentWorkspace.value = ''")
    )
  })

  it('lands on another held workspace rather than the picker', () => {
    // Closing one of several is not "back to the picker": the others are still
    // held and still running, so a Welcome screen over them says the window is
    // empty when it is not.
    const at = appSource.indexOf('async function doCloseWorkspace')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(fn).toContain('const next = remaining[0]')
    expect(fn).toContain('if (next) await switchToWorkspace(next)')
    // After the teardown, not before — the switch must not interleave with the
    // kill of the workspace being closed.
    expect(fn.indexOf('await onPipelineReset(paneIdsToKill)')).toBeLessThan(
      fn.indexOf('if (next) await switchToWorkspace(next)')
    )
  })

  it('asks before a switch stops a running pipeline', () => {
    // Panes survive a switch; a pipeline cannot — `pipeline` is one per window,
    // so entering another project overwrites the state tracking this one's run
    // and onWorkspaceBrowse aborts it. Right call, but everything else about a
    // switch keeps running, so nobody would expect this one thing to stop.
    const start = appSource.indexOf('async function switchToWorkspace')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain("pipeline.state === 'running'")
    expect(body).toContain('notifyRestore.confirm')
    // Declining leaves the window where it is.
    expect(body).toContain('if (!ok) return')
    // The abort itself still lives in onWorkspaceBrowse — no second copy.
    expect(body).not.toContain('onPipelineAbort')
  })

  it('never tears down panes while entering a workspace', () => {
    // The third leg of "switch away and back, the agents are still there".
    // The other two are v-show on TerminalPane (asserted above) and restore
    // skipping any pane_id already in the list. This one is the easiest to
    // break by accident: a tidy-up added to either function would end the CLIs
    // of every workspace not being entered, and nothing else would complain.
    const REMOVAL = /panes\.value\s*=|panes\.value\.splice|panes\.value\.filter|unregisterPaneMessaging|onKill\(|delete paneRefs/
    // Up to the next top-level declaration — anchoring on a named one further
    // down would sweep in whatever sits between.
    const bodyOf = (fn: string): string => {
      const start = appSource.indexOf(fn)
      expect(start, fn).toBeGreaterThan(-1)
      const after = start + fn.length
      const ends = ['\nasync function ', '\nfunction ', '\nconst ']
        .map((m) => appSource.indexOf(m, after))
        .filter((i) => i > -1)
      expect(ends.length, `${fn} end`).toBeGreaterThan(0)
      return appSource.slice(start, Math.min(...ends))
    }
    for (const fn of ['async function restoreWorkspacePanes', 'async function onWorkspaceCheck']) {
      expect(REMOVAL.test(bodyOf(fn)), fn).toBe(false)
    }
  })

  it('skips a pane the list already holds rather than spawning it twice', () => {
    // Switching back re-runs restore for a workspace whose panes never left.
    const start = appSource.indexOf('async function restoreWorkspacePanes')
    const body = appSource.slice(start, appSource.indexOf('\nasync function restoreSessionDecision', start))
    expect(body).toContain('const existing = panes.value.find((p) => p.id === saved.pane_id)')
    expect(body).toContain('if (existing) continue')
  })

  it('says so when a switch does not take', () => {
    // onWorkspaceBrowse declines by returning — chiefly on finding the
    // workspace open in another window — which from the caller is
    // indistinguishable from having worked. A switch that quietly does nothing
    // leaves the sidebar saying one thing and the screen another.
    const start = appSource.indexOf('async function switchToWorkspace')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('normWs(currentWorkspace.value) !== normWs(path)')
    expect(body).toContain("switchWorkspace.failed")
    // Nothing to undo: the list is the same either way, which is the point of
    // keeping order out of "which one is on screen".
    expect(body).not.toContain('extraWorkspaces.value =')
  })

  it('falls back to a pane the screen can actually render', () => {
    // Sidebar and spotlight render effectiveFocusPaneId and nothing else, and
    // onScreenPaneIds checks it against the workspace-filtered list. Answering
    // with a pane from another workspace renders nothing at all — a blank
    // main area with a full agent list beside it.
    // The fallback itself is lib/paneFocus, tested by running it. App's job is
    // handing it the workspace on screen rather than every pane in the window.
    const start = appSource.indexOf('const effectiveFocusPaneId = computed')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n)', start))
    // panesOnStage is panesInView unless the sidebar is in free mode, where the
    // stage draws every workspace — still "what the screen can render", which is
    // the property this guards.
    expect(body).toContain('panesOnStage.value')
    expect(body).not.toContain('panes.value')
  })

  it('never tears down the panes of the workspace it leaves', () => {
    // onWorkspaceBrowse resets the pipeline, and onPipelineReset is
    // `await onKillAll()` — browsing has always meant LEAVING, so a clean
    // slate was right. Switching is not leaving: the sidebar goes on listing
    // that workspace and its agents go on running. Without keepPanes the
    // switch destroyed exactly the work it was meant to leave running.
    const start = appSource.indexOf('async function switchToWorkspace')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('onWorkspaceBrowse(path, { keepPanes: true })')

    const bStart = appSource.indexOf('async function onWorkspaceBrowse')
    const browse = appSource.slice(bStart, appSource.indexOf('\n}', bStart))
    expect(browse).toContain('if (!opts?.keepPanes) await onPipelineReset()')
    // The pipeline still stops either way — one per window.
    expect(browse).toContain("if (pipeline.state === 'running') await onPipelineAbort()")

    // And the teardown really is in there, so this is not guarding a no-op.
    const rStart = appSource.indexOf('async function onPipelineReset')
    expect(appSource.slice(rStart, appSource.indexOf('\n}', rStart))).toContain('await onKillAll(')
  })

  it('has no unguarded teardown anywhere on the browse path', () => {
    // The previous test names the one call that tears panes down. This one
    // says there is no second: onWorkspaceBrowse is shared with the Welcome
    // picker, where a clean slate IS wanted, so anything destructive added
    // here later would reach the switch too — and a switch destroying the
    // workspace it leaves is exactly the bug that made this necessary.
    const bStart = appSource.indexOf('async function onWorkspaceBrowse')
    const browse = appSource.slice(bStart, appSource.indexOf('\n}', bStart))
    const destructive = browse.match(/onKillAll\(\)|onPipelineReset\(\)|onKill\(/g) ?? []
    expect(destructive).toEqual(['onPipelineReset()'])
    expect(browse).toContain('if (!opts?.keepPanes) await onPipelineReset()')
    // The rest of the path is clean, which is why nothing else is guarded.
    for (const fn of ['async function onPipelineAbort', 'function cancelAllWatchers']) {
      const start = appSource.indexOf(fn)
      expect(start, fn).toBeGreaterThan(-1)
      const body = appSource.slice(start, appSource.indexOf('\n}', start))
      expect(/onKillAll|onKill\(/.test(body), fn).toBe(false)
    }
  })

  it('does not check the same workspace twice for one switch', () => {
    // ControlPane reaches onWorkspaceCheck through a 400ms debounce, and a
    // switch calls it directly so the window does not spend those 400ms
    // pairing the new workspace with the old run groups. Both fire for one
    // switch, and the second bumps workspaceCheckSeq — which is exactly the
    // condition the first one's restore bails on. It gave up midway and the
    // workspace came up with none of its panes.
    const start = appSource.indexOf('async function onWorkspaceCheck')
    const body = appSource.slice(start, appSource.indexOf('\n  const seq =', start))
    expect(body).toContain('lastWorkspaceCheck.path')
    expect(body).toContain('WORKSPACE_RECHECK_MS')
    // The bail condition it protects is still there — this is not guarding a
    // mechanism that has since gone away.
    const full = appSource.slice(start, appSource.indexOf('\nasync function', start + 20))
    expect(full).toContain('seq !== workspaceCheckSeq')
  })

  it('files pane order under the workspace whose panes they are', () => {
    // `panes` holds every workspace the window runs. Sending all of them files
    // another project's pane ids under this one, and leaves that project's own
    // order unwritten — nothing else writes it.
    const start = appSource.indexOf('async function persistPaneOrder')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('panesInView.value.map((p) => p.id)')
    expect(body).not.toContain('panes.value.map((p) => p.id)')
  })

  it('scopes the all keyword to the sender\'s own workspace', () => {
    // The menu stops offering the keyword once a window holds more than one
    // workspace, but the bare-line protocol is typed by the agent and cannot
    // be gated that way. sendBroadcast reaches every pane the WINDOW
    // registers, so the scope is applied at the call site, which knows the
    // sender's workspace — the registry only knows names and agents.
    const at = appSource.indexOf('messaging.sendBroadcast(')
    expect(at).toBeGreaterThan(-1)
    const call = appSource.slice(at - 400, at + 500)
    expect(call).toContain('only: (targetPaneId)')
    expect(call).toContain('normWs(to) === normWs(from)')
    // A pane in neither list — a manual resume can pull a session in from any
    // folder — stays a recipient, as it always was.
    expect(call).toContain('return !to || ')
  })

  it('picking a workspace it already holds just looks at it', () => {
    // Nothing happened before: adopt refused it and no switch was attempted.
    const start = appSource.indexOf('async function openWorkspaceFromPicker')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('await switchToWorkspace(path)')
  })

  it('switching moves the view, not the list', () => {
    const start = appSource.indexOf('async function switchToWorkspace')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    // The window holds the same set either way. Deriving order from "which is
    // on screen" reshuffled the sidebar on every switch — two rows swapping
    // places under the cursor, so the next click lands on the wrong project.
    // The doc comment sits above the declaration, so read from it.
    const order = appSource.slice(
      appSource.indexOf('Every workspace this window holds'),
      appSource.indexOf('const extraWorkspaces = computed'),
    )
    expect(order).toContain('the order it took them on')
    expect(order).toContain('const workspaceOrder = ref')
    // The one being left is already in the list — the workspace a window opens
    // with joins it at the front, so it never sorts below something adopted
    // later.
    expect(appSource).toContain('workspaceOrder.value = [ws, ...workspaceOrder.value]')
    expect(body).not.toContain('workspaceOrder.value = [')
    // Everything that follows currentWorkspace moves with it, which is what
    // onWorkspaceBrowse already does — no second implementation. keepPanes is
    // asserted on its own below.
    expect(body).toContain('onWorkspaceBrowse(path, { keepPanes: true })')
    // Never for a workspace this window does not hold.
    expect(body).toContain('isLocalWorkspace(path)')
  })

  it('does not leave the focus on a pane it just hid', () => {
    // The focus follows the workspace: a pane that survived the filter keeps
    // it, and otherwise nothing is selected. Not the first pane of the entered
    // workspace — selecting a pane focuses its terminal, so a switch would
    // redirect the keyboard into an agent nobody opened. The stage still draws
    // a pane; effectiveFocusPaneId falls back on its own.
    const start = appSource.indexOf('async function switchToWorkspace')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('tabVisiblePanes.value')
    expect(body).toContain('selectPane(null, { userInitiated: false })')
  })

  it('keeps hidden panes alive rather than tearing them down', () => {
    // v-show, not v-if: switching away must not destroy the terminal or end
    // the CLI. This is what makes "keeps running, just not shown" true.
    const at = appSource.indexOf('<TerminalPane')
    const tag = appSource.slice(at, at + 200)
    expect(tag).toContain('v-show="onScreenPaneIds.has(p.id)"')
    expect(tag).not.toContain('v-if="onScreenPaneIds')
  })

  it('tells main which workspaces this window has taken on', () => {
    // Main answers "is this folder already open?" for every other window's
    // picker. Knowing only primaries, a second window could open a folder this
    // one is already running — two sets of PTY and git operations on one
    // checkout, which is the thing the whole design avoids.
    const start = appSource.indexOf('function persistExtraWorkspaces')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('reportAdoptedWorkspaces')
    // A reload restores the list from sessionStorage without going through
    // adoptWorkspace, so it has to be re-reported on mount. A relaunch reports
    // through adoptWorkspace instead, which is why the mount-time report is
    // conditional on having claimed nothing.
    expect(appSource).toContain('if (!restored.length) window.agentTeam?.reportAdoptedWorkspaces?.(')
  })

  it('answers an external spawn for any workspace it holds', () => {
    // cli_open_agent with a workspace_path is addressed by workspace, not by a
    // parent pane. Only the window holding it may answer — and now exactly one
    // does, because findMainWindowForWorkspace covers adopted ones.
    const start = appSource.indexOf('async function handleMcpSpawnRequest')
    const body = appSource.slice(start, appSource.indexOf('\n  const report', start))
    expect(body).toContain('isLocalWorkspace(ev.target_workspace')
    expect(body).not.toContain('ev.target_workspace !== currentWorkspace.value')
  })

  it('takes back its adopted workspaces after a relaunch', () => {
    // The claim is unconditional. It used to sit in the else of
    // `if (workspaceOrder.value.length)`, which never ran: the currentWorkspace
    // watcher seeds workspaceOrder during setup and a restored window always
    // carries a workspace_path, so the list is already one entry long by
    // onMounted and the else was dead code. sessionStorage still wins when both
    // exist — main hands the registry's copy out exactly once, so a reload
    // claims nothing and keeps its own live state.
    expect(appSource).toContain('takeRestoredAdoptedWorkspaces')
    const at = appSource.indexOf('takeRestoredAdoptedWorkspaces')
    const around = appSource.slice(at - 900, at + 1600)
    expect(around).not.toContain('if (workspaceOrder.value.length) {')
    expect(around).toContain('const restored = (await window.agentTeam?.takeRestoredAdoptedWorkspaces?.()) ?? []')
    expect(around).toContain('for (const path of restored) adoptWorkspace(path)')
    // A window that claimed nothing still has to tell main what it holds.
    expect(around).toContain('if (!restored.length) window.agentTeam?.reportAdoptedWorkspaces?.(')
    // And their agents come back, the same way a picked workspace's do.
    expect(around).toContain("'project.peek'")
    expect(around).toContain('restoreWorkspacePanes')
    // A peek that comes back empty says so instead of reading as "no panes".
    expect(around).toContain('[restore] project.peek returned nothing')
  })

  it('still ties the history pane to the primary workspace', () => {
    // Deliberately NOT widened: spawn history follows the workspace the window
    // was opened with.
    const start = appSource.indexOf('function hydrateSpawnHistory')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    expect(body).toContain('currentWorkspace.value !== workspacePath')
  })

  it('closing an adopted workspace takes its panes with it', () => {
    const start = appSource.indexOf('async function closeWorkspace')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    // Panes started in it would otherwise sit in the list with no heading.
    expect(body).toContain('onKill')
    expect(body).toContain('persistExtraWorkspaces')
  })

  it('lands somewhere before closing the workspace on screen', () => {
    const start = appSource.indexOf('async function closeWorkspace')
    const body = appSource.slice(start, appSource.indexOf('\n}', start))
    // Switch first, let go after. The other order leaves the window on a
    // project it no longer holds for the duration of the switch — and the
    // switch is what puts the focus on the next project's first CLI.
    expect(body).toContain('await switchToWorkspace(land)')
    expect(body.indexOf('await switchToWorkspace(land)')).toBeLessThan(body.indexOf('onKill'))
    // A switch can decline — the target turned out to be open in another
    // window. Closing anyway would strand this one with nothing on screen.
    expect(body).toContain("if (normWs(currentWorkspace.value) !== normWs(land)) return")
    // Nothing to land on: leave it alone rather than emptying the window.
    expect(body).toContain('if (!land) return')
  })

})
