// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The status bar's branch pill is workspace-scoped — it asks git.status for
// currentWorkspace — but nothing told it to ask again when that changed.
//
// Its only triggers were a watch on workspaceSelected, a 5s poll, and the
// window becoming visible. Switching between two workspaces one window holds
// never flips workspaceSelected, so the pill kept showing the branch of the
// workspace being left until the poll caught up. Wrong is worse than absent
// here: a branch name beside a project you just switched to reads as that
// project's branch.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

describe('the branch pill follows the workspace', () => {
  // Sliced to the end of the watch body rather than a fixed number of
  // characters: a fixed window silently stops covering the block the moment a
  // line is added to it, which is a test that reports on its own length.
  const workspaceWatch = ((): string => {
    const at = appSource.indexOf('watch(currentWorkspace, () => {\n  statusBarGit.value')
    return at === -1 ? '' : appSource.slice(at, appSource.indexOf('\n})', at))
  })()

  it('refetches when the workspace on screen changes', () => {
    expect(workspaceWatch).not.toBe('')
    expect(workspaceWatch).toContain('void refreshStatusBarGit()')
  })

  it('clears before it refetches, rather than showing the old branch', () => {
    // The refetch is a round trip. Leaving the previous branch up for its
    // duration is the exact failure this fixes, just shorter — and the pill
    // hides itself when the branch is empty, so absent costs nothing.
    expect(workspaceWatch.indexOf("branch: ''")).toBeGreaterThan(-1)
    expect(workspaceWatch.indexOf("branch: ''")).toBeLessThan(
      workspaceWatch.indexOf('void refreshStatusBarGit()'),
    )
  })

  it('still asks about the workspace on screen', () => {
    // The fetch was always workspace-scoped; only its triggers were wrong.
    const at = appSource.indexOf('async function refreshStatusBarGit')
    expect(at).toBeGreaterThan(-1)
    const fn = appSource.slice(at, appSource.indexOf('\n}', at))
    expect(fn).toContain("'git.status', { workspace_path: currentWorkspace.value }")
  })

  it('offers to open the folder beside the path', () => {
    // Rides with the path, not the name: it acts on the folder, and the folder
    // is what is on screen while hovering. A button on a bar showing a project
    // name would read as acting on the project.
    expect(appSource).toContain('class="titlebar-reveal"')
    expect(appSource).toContain('@click="revealWorkspaceFolder(currentWorkspace)"')
    const at = appSource.indexOf('.titlebar-reveal {')
    expect(at).toBeGreaterThan(-1)
    expect(appSource.slice(at, at + 120)).toContain('display: none')
    expect(appSource).toContain('.titlebar-id:hover .titlebar-reveal { display: flex; }')
  })

  it('gives the hover zone a fixed share of the bar, without taking its drag handles', () => {
    // Hovering swaps the short name for the longer path; a zone sized to the
    // name would slide out from under the pointer the moment it did. The
    // spacers either side must stay draggable or the window loses the only
    // part of its titlebar it can be moved by.
    const at = appSource.indexOf('.titlebar-id {')
    expect(at).toBeGreaterThan(-1)
    const zone = appSource.slice(at, appSource.indexOf('}', at))
    expect(zone).toContain('flex: 0 0 70%')
    expect(zone).toContain('align-self: stretch')
    expect(zone).toContain('-webkit-app-region: no-drag')
    const sp = appSource.indexOf('.titlebar-spacer {')
    expect(sp).toBeGreaterThan(-1)
    expect(appSource.slice(sp, appSource.indexOf('}', sp))).toContain('-webkit-app-region: drag')
  })

  it('lets Windows/Linux drag the window by the identity block, keeping only its content as the hover zone', () => {
    // VM acceptance (0.2.22): with drawn window controls the 70% no-drag block
    // left only two thin spacers to move the window by.
    expect(appSource).toContain(":root[data-window-controls='drawn'] .titlebar-id { -webkit-app-region: drag; }")
    expect(appSource).toContain(":root[data-window-controls='drawn'] .titlebar-id > * { -webkit-app-region: no-drag; }")
    // The hover zone's children are siblings with no gap between them, so
    // the pointer can travel from the path to either button without leaving it.
    const at = appSource.indexOf('.titlebar-id {')
    expect(appSource.slice(at, appSource.indexOf('}', at))).not.toContain('gap')
  })

  it('opens the real path, not the shortened one', () => {
    // The bar shows ~/… — handing that to the OS would open a folder named
    // "~" if anything at all.
    expect(appSource).toContain('@click="revealWorkspaceFolder(currentWorkspace)"')
    expect(appSource).not.toContain('revealWorkspaceFolder(workspaceDisplayPath)')
  })

  it('hides the pill rather than rendering an empty branch', () => {
    expect(appSource).toContain('v-if="statusBarGit.branch"')
    expect(appSource).toContain('class="sb-item sb-git"')
  })
})

// The pill used to refetch on a 5s interval. Each tick costs three git
// subprocesses in the backend (rev-parse --is-inside-work-tree, status
// --porcelain, rev-parse --git-dir) and ran whether or not anything had
// changed: measured at ~107 git processes a minute across three idle windows,
// which was the whole of the idle git load. The backend already broadcasts
// git.changed for every git write, every fs write, and every watched
// worktree/.git change, so the pill listens instead of asking.
describe('the branch pill listens instead of polling', () => {
  // Everything from the fetch down to the keybinding section: the triggers.
  const region = appSource.slice(
    appSource.indexOf('async function refreshStatusBarGit'),
    appSource.indexOf('// ── Keybinding system'),
  )

  it('has no timer that refetches git', () => {
    expect(region.length).toBeGreaterThan(0)
    expect(region).not.toContain('setInterval')
  })

  it('refetches when the backend says the worktree changed', () => {
    expect(region).toContain("backend.on('git.changed'")
    const at = region.indexOf("backend.on('git.changed'")
    expect(region.slice(at, region.indexOf('})', at))).toContain('scheduleStatusBarGit()')
  })

  it('ignores broadcasts about other workspaces', () => {
    // git.changed goes to every connected session, not just this window's.
    const at = region.indexOf("backend.on('git.changed'")
    expect(region.slice(at, region.indexOf('})', at))).toContain('ws !== currentWorkspace.value')
  })

  it('coalesces a burst into one refetch', () => {
    // One user action (a commit, a branch switch) lands as several file
    // events; without this each would cost its own three subprocesses.
    const at = region.indexOf('function scheduleStatusBarGit')
    expect(at).toBeGreaterThan(-1)
    const fn = region.slice(at, region.indexOf('\n}', at))
    expect(fn).toContain('if (_gitRefreshTimer !== null) return')
    expect(fn).toContain('}, 300)')
  })

  it('does no git work while the window is hidden', () => {
    const at = region.indexOf('function scheduleStatusBarGit')
    const fn = region.slice(at, region.indexOf('\n}', at))
    expect(fn).toContain('if (!_windowVisible) { _gitStale = true; return }')
  })

  it('catches up when the window comes back, but only if it missed something', () => {
    const at = region.indexOf('onWindowVisibility')
    expect(at).toBeGreaterThan(-1)
    const cb = region.slice(at, region.indexOf('})', at))
    expect(cb).toContain('if (visible && _gitStale) { _gitStale = false; void refreshStatusBarGit() }')
  })

  it('resyncs after a reconnect', () => {
    // Broadcasts sent while this window was disconnected are gone, and with no
    // poll nothing else would ever fetch them — the pill would sit stale.
    const at = region.indexOf('watch(() => backend.status.value')
    expect(at).toBeGreaterThan(-1)
    const w = region.slice(at, region.indexOf('})', at))
    expect(w).toContain("s === 'connected'")
    expect(w).toContain('void refreshStatusBarGit()')
  })

  it('drops its subscription and pending timer when the window goes away', () => {
    const at = region.indexOf('onUnmounted(() => {')
    expect(at).toBeGreaterThan(-1)
    const body = region.slice(at, region.indexOf('\n})', at))
    expect(body).toContain('_offGitChanged?.()')
    expect(body).toContain('_offWindowVisibility?.()')
    expect(body).toContain('clearTimeout(_gitRefreshTimer)')
  })
})

// Removing the poll removed three things it had been quietly providing: a
// retry after a failed request, a second chance to notice the window went
// away, and a per-tick reset of what "stale" meant. Each is covered here.
describe('what the poll used to cover for', () => {
  const region = appSource.slice(
    appSource.indexOf('async function refreshStatusBarGit'),
    appSource.indexOf('// ── Keybinding system'),
  )

  it('retries once when the request fails, instead of sitting blank', () => {
    // sendQuiet does not retry, and a cold-start git.status can time out even
    // after the socket reports connected. The poll used to try again in 5s.
    const at = region.indexOf('_gitRetryTimer === null')
    expect(at).toBeGreaterThan(-1)
    const guard = region.slice(at, at + 220)
    expect(guard).toContain('!statusBarGit.value.branch')
    expect(guard).toContain('void refreshStatusBarGit()')
  })

  it('does not turn that retry into a second poll', () => {
    // Bounded two ways: only while the bar is empty, and only one in flight.
    expect(region).not.toContain('setInterval')
    const at = region.indexOf('_gitRetryTimer = window.setTimeout')
    expect(at).toBeGreaterThan(-1)
    expect(region.slice(at, at + 160)).toContain('_gitRetryTimer = null')
  })

  it('rechecks visibility when the debounce fires, not only when it is set', () => {
    // The window can be hidden during the 300ms wait; scheduling-time was the
    // only check, so that one request went out to a window nobody could see.
    const at = region.indexOf('_gitRefreshTimer = window.setTimeout')
    const body = region.slice(at, region.indexOf('}, 300)', at))
    expect(body).toContain('if (!_windowVisible) { _gitStale = true; return }')
  })

  it('does not carry staleness across a workspace switch', () => {
    const at = region.indexOf('watch(currentWorkspace, () => {')
    const body = region.slice(at, region.indexOf('\n})', at))
    expect(body).toContain('_gitStale = false')
    expect(body.indexOf('_gitStale = false')).toBeLessThan(
      body.indexOf('void refreshStatusBarGit()'),
    )
  })

  it('clears the retry timer on unmount too', () => {
    const at = region.indexOf('onUnmounted(() => {')
    expect(region.slice(at, region.indexOf('\n})', at))).toContain(
      'clearTimeout(_gitRetryTimer)',
    )
  })
})
