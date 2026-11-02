// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// A duplicate=1 window recomputed its "skip restore" flag from the URL on every
// page load, so a Reload dropped every pane it had and left their CLIs running
// with no window. Only the first load may skip; after a Reload the window takes
// back what it held and nothing else, because project.json also lists records
// that were never this window's.
//
// Source-scanned, like the other App.*.test.ts files: App.vue cannot be
// mounted, since backend and terminal lifecycles start on mount. What the list
// holds and matches is tested directly in lib/__tests__/windowHeldPanes.test.ts.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function slice(from: string, to: string): string {
  const start = appSource.indexOf(from)
  expect(start, `${from} not found`).toBeGreaterThan(-1)
  const end = appSource.indexOf(to, start)
  expect(end, `${to} not found`).toBeGreaterThan(start)
  return appSource.slice(start, end)
}

describe('reloading a duplicate=1 window', () => {
  const bootCheck = slice('if (suppressPaneRestoreOnce) {\n      // First load', 'adoptOrphanRunGroups(path)')
  const restore = slice('async function restoreWorkspacePanes(', 'const beforeDedupe = toRestore.length')

  it('still restores nothing on a first load, whose list is empty', () => {
    const guarded = bootCheck.indexOf('if (heldPanesAtBoot.size > 0)')
    expect(guarded).toBeGreaterThan(-1)
    expect(bootCheck.indexOf('restoreWorkspacePanes(')).toBeGreaterThan(guarded)
  })

  it('restores only the held panes after a Reload', () => {
    expect(bootCheck).toContain(
      'restoreWorkspacePanes(resp, path, undefined, () => seq !== workspaceCheckSeq, heldPanesAtBoot)',
    )
    expect(restore).toContain('onlyHeld?: ReadonlySet<string>')
    expect(restore).toContain('toRestore = toRestore.filter((p) => isHeldRecord(p, onlyHeld))')
  })

  it('filters before deduping, so a foreign record cannot win the dedupe and then be dropped', () => {
    const scoped = restore.indexOf('isHeldRecord(p, onlyHeld)')
    expect(scoped).toBeGreaterThan(-1)
    expect(appSource.indexOf('dedupeRestorablePanes(toRestore)', appSource.indexOf('async function restoreWorkspacePanes(')))
      .toBeGreaterThan(appSource.indexOf('isHeldRecord(p, onlyHeld)'))
  })

  it('hands the flag on when a newer check supersedes this one', () => {
    // Clearing it unconditionally would leave the newer check to run the
    // ordinary restore, which brings back every record in project.json.
    expect(bootCheck).toContain('if (seq === workspaceCheckSeq) suppressPaneRestoreOnce = false')
  })

  it('snapshots the list before anything can rewrite it', () => {
    expect(appSource).toContain('const heldPanesAtBoot = readHeldPanes()')
    expect(appSource.indexOf('const heldPanesAtBoot = readHeldPanes()'))
      .toBeLessThan(appSource.indexOf('() => heldPaneKeys(panes.value)'))
  })

  it('tracks panes from setup, not from the flag being spent', () => {
    // A folder with no project.json never reaches the branch that spends the
    // flag, and its first panes must still be on the list.
    const tracker = slice('if (suppressPaneRestoreOnce) {\n  watch(', 'const paneRefs = reactive')
    expect(tracker).toContain('() => heldPaneKeys(panes.value)')
    expect(tracker).toContain('writeHeldPanes(suppressPaneRestoreOnce ? [...heldPanesAtBoot, ...keys] : keys)')
  })

  it('leaves every other window out of it', () => {
    // Only the boot flag starts the tracker; a window without duplicate=1 keeps
    // its restore path unchanged.
    expect(appSource).toContain("let suppressPaneRestoreOnce = _bootWorkspace !== '' && _bootIsDuplicate")
    expect(appSource).toContain(
      'coldRestoreBatch = await restoreWorkspacePanes(resp, path, undefined, () => seq !== workspaceCheckSeq)\n',
    )
  })
})
