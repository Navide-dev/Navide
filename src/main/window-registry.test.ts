import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_RESTORE_ATTEMPTS, onScreenBounds, parseRegistryDoc, pendingFromDoc, WindowRegistry } from './window-registry'

describe('parseRegistryDoc', () => {
  it('returns a clean empty doc for missing or corrupt content', () => {
    for (const text of [null, '', 'not json', '[]', '{"windows": "nope"}']) {
      expect(parseRegistryDoc(text)).toEqual({
        version: 1, cleanExit: true, windows: [], snapshot: [], aux: [], auxSnapshot: [],
        restoreOnLaunch: true, restoreFailures: {},
      })
    }
  })

  it('parses a valid doc and drops malformed window entries', () => {
    const doc = parseRegistryDoc(JSON.stringify({
      version: 1,
      cleanExit: false,
      windows: [
        { workspace_path: '/a', bounds: { x: 0, y: 0, width: 800, height: 600 } },
        { workspace_path: '' }, // empty → dropped
        { nope: true }, // malformed → dropped
        { workspace_path: '/b' },
      ],
    }))
    expect(doc.cleanExit).toBe(false)
    expect(doc.windows).toEqual([
      { workspace_path: '/a', bounds: { x: 0, y: 0, width: 800, height: 600 } },
      { workspace_path: '/b' },
    ])
  })

  it('loads a doc written before auxiliary windows were tracked', () => {
    const doc = parseRegistryDoc(JSON.stringify({
      version: 1, cleanExit: true, windows: [], snapshot: [{ workspace_path: '/ws/alpha' }],
      restoreOnLaunch: true, restoreFailures: {},
    }))
    expect(doc.aux).toEqual([])
    expect(doc.auxSnapshot).toEqual([])
    expect(doc.snapshot).toEqual([{ workspace_path: '/ws/alpha' }]) // the rest still loads
  })

  it('drops auxiliary entries it has no opener for, and un-scopes the machine-wide one', () => {
    const doc = parseRegistryDoc(JSON.stringify({
      version: 1, cleanExit: true, windows: [],
      auxSnapshot: [
        { kind: 'plans', workspace_path: '/a', bounds: { x: 1, y: 2, width: 300, height: 400 } },
        { kind: 'diff', workspace_path: '/a' }, // unknown kind → dropped
        { kind: 'git' }, // per-workspace kind with no workspace → dropped
        { kind: 'git', workspace_path: '' }, // ...same, spelled empty
        // Machine-wide: a workspace here would make the restore filter gate it
        // on a workspace window, so it is stripped rather than trusted.
        { kind: 'token-monitor', workspace_path: '/a' },
        'nope',
      ],
    }))
    expect(doc.auxSnapshot).toEqual([
      { kind: 'plans', workspace_path: '/a', bounds: { x: 1, y: 2, width: 300, height: 400 } },
      { kind: 'token-monitor' },
    ])
  })
})

describe('pendingFromDoc', () => {
  const base = { snapshot: [], aux: [], auxSnapshot: [], restoreOnLaunch: true, restoreFailures: {} }

  it('offers nothing after a clean exit', () => {
    expect(pendingFromDoc({ version: 1, cleanExit: true, windows: [{ workspace_path: '/a' }], ...base })).toBeNull()
  })

  it('offers nothing when no workspaces were open', () => {
    expect(pendingFromDoc({ version: 1, cleanExit: false, windows: [], ...base })).toBeNull()
  })

  it('offers the windows after an unclean exit', () => {
    expect(pendingFromDoc({ version: 1, cleanExit: false, windows: [{ workspace_path: '/a' }], ...base }))
      .toEqual([{ workspace_path: '/a' }])
  })
})

describe('WindowRegistry', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'win-reg-'))
    file = join(dir, 'open-windows.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const readDoc = (): unknown => JSON.parse(readFileSync(file, 'utf-8'))

  it('simulated crash: next launch sees the previous windows as pending', () => {
    const run1 = new WindowRegistry(file)
    expect(run1.readPendingAndReset()).toBeNull() // first run ever
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    // ...crash: no markCleanExit, no remove...

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toEqual([
      { workspace_path: '/ws/alpha' },
      { workspace_path: '/ws/beta' },
    ])
    // and the offer is one-shot: a third run (also unclean) has no windows
    const run3 = new WindowRegistry(file)
    expect(run3.readPendingAndReset()).toBeNull()
  })

  it('clean exit: next launch has nothing to restore', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.markCleanExit()

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toBeNull()
  })

  it('clean exit snapshots open windows for auto-restore, surviving the remove() sweep', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    run1.markCleanExit()
    // Quit sequence: each window closes → remove(). This used to wipe the
    // snapshot to [] (the bug); it must survive.
    run1.remove(1)
    run1.remove(2)

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toBeNull() // clean exit → no crash banner
    expect(run2.cleanExitRestore()).toEqual([
      { workspace_path: '/ws/alpha' },
      { workspace_path: '/ws/beta' },
    ])
  })

  it('a second markCleanExit after the windows are gone keeps the first snapshot', () => {
    // The quit shapes that close every window before before-quit reach
    // markCleanExit twice — once while the windows are open, once after. The
    // second call must not re-freeze an empty entries map over a good
    // snapshot, or the restore list is lost exactly on those quits.
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    run1.markCleanExit()
    run1.remove(1)
    run1.remove(2)
    run1.markCleanExit()

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitRestore()).toEqual([
      { workspace_path: '/ws/alpha' },
      { workspace_path: '/ws/beta' },
    ])
  })

  it('markCleanExit with no windows open still records an empty snapshot', () => {
    // The plain "user closed everything, then quit" path: nothing to restore,
    // and the guard above must not resurrect a stale list.
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.markCleanExit()

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitRestore()).toEqual([])
  })

  it('clearCleanExit puts back the crash offer when an install never took the app down', () => {
    // The updater freezes the snapshot when an install starts; a refused or
    // timed-out install leaves the app running, and the run must stop counting
    // as a clean exit or a later crash comes back with nothing to restore.
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.markCleanExit()
    run1.clearCleanExit()
    // ...crash: no further markCleanExit...

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toEqual([{ workspace_path: '/ws/alpha' }])
  })

  it('restoreOnLaunch=false suppresses clean-exit auto-restore and persists across reset', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setRestoreOnLaunch(false)
    run1.markCleanExit()
    run1.remove(1)

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitRestore()).toEqual([]) // setting off → nothing
    expect(run2.getRestoreOnLaunch()).toBe(false) // setting preserved across the reset
  })

  it('a crash yields a restore banner but no clean-exit auto-restore', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    // ...crash: no markCleanExit, no remove...

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toEqual([{ workspace_path: '/ws/alpha' }]) // banner
    expect(run2.cleanExitRestore()).toEqual([]) // not clean → no auto-restore
  })

  it('closing a window or returning to Welcome removes its entry', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setWorkspace(1, '/ws/alpha')
    reg.setWorkspace(2, '/ws/beta')
    reg.remove(1)
    reg.setWorkspace(2, '') // back to Welcome
    expect(readDoc()).toMatchObject({ cleanExit: false, windows: [] })
  })

  it('keeps bounds attached to the window entry across workspace updates', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setWorkspace(1, '/ws/alpha')
    reg.setBounds(1, { x: 5, y: 6, width: 700, height: 500 })
    // bounds writes are debounced — force a flush via an immediate-persist op
    reg.setWorkspace(1, '/ws/alpha')
    expect(readDoc()).toMatchObject({
      windows: [{ workspace_path: '/ws/alpha', bounds: { x: 5, y: 6, width: 700, height: 500 } }],
    })
  })

  it('ignores bounds for untracked (Welcome) windows', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setBounds(9, { x: 0, y: 0, width: 100, height: 100 })
    reg.markCleanExit() // flush
    expect(readDoc()).toMatchObject({ windows: [] })
  })

  it('survives a corrupt file on disk', () => {
    writeFileSync(file, '{truncated', 'utf-8')
    const reg = new WindowRegistry(file)
    expect(reg.readPendingAndReset()).toBeNull()
  })
})

describe('auxiliary windows', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'win-reg-'))
    file = join(dir, 'open-windows.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const readDoc = (): { aux?: unknown; auxSnapshot?: unknown } => JSON.parse(readFileSync(file, 'utf-8'))

  it('tracks an auxiliary window, its bounds, and its close', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.addAux(7, { kind: 'plans', workspace_path: '/ws/alpha' })
    reg.addAux(8, { kind: 'token-monitor' })
    reg.setAuxBounds(7, { x: 10, y: 20, width: 900, height: 700 })
    reg.addAux(9, { kind: 'git', workspace_path: '/ws/alpha' }) // immediate persist → flushes the debounce
    expect(readDoc().aux).toEqual([
      { kind: 'plans', workspace_path: '/ws/alpha', bounds: { x: 10, y: 20, width: 900, height: 700 } },
      { kind: 'token-monitor' },
      { kind: 'git', workspace_path: '/ws/alpha' },
    ])
    reg.remove(9)
    expect(readDoc().aux).toEqual([
      { kind: 'plans', workspace_path: '/ws/alpha', bounds: { x: 10, y: 20, width: 900, height: 700 } },
      { kind: 'token-monitor' },
    ])
  })

  it('remove() reaches auxiliary windows, not just workspace windows', () => {
    // remove() used to return on the first miss, which is the workspace map —
    // so an auxiliary window's close never deleted anything and every one of
    // them stayed in the doc forever, to be "restored" on the next launch.
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setWorkspace(1, '/ws/alpha')
    reg.addAux(2, { kind: 'token-monitor' })
    reg.remove(2)
    expect(readDoc()).toMatchObject({ windows: [{ workspace_path: '/ws/alpha' }], aux: [] })
  })

  it('setAuxBounds ignores a window that is not tracked', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.setAuxBounds(5, { x: 0, y: 0, width: 100, height: 100 })
    reg.markCleanExit() // flush
    expect(readDoc().aux).toEqual([])
  })

  it('follows the shared Git window when it is re-targeted at another workspace', () => {
    // The Git window is keyed by its contribution alone, so opening Git for a
    // second project reuses the one window. Without this the entry would keep
    // the workspace that created it and the restore would reopen Git there.
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.addAux(4, { kind: 'git', workspace_path: '/ws/alpha' })
    reg.setAuxWorkspace(4, '/ws/beta')
    expect(readDoc().aux).toEqual([{ kind: 'git', workspace_path: '/ws/beta' }])
  })

  it('setAuxWorkspace ignores an untracked window and the machine-wide kind', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.addAux(2, { kind: 'token-monitor' })
    reg.setAuxWorkspace(2, '/ws/alpha') // machine-wide: no workspace to move
    reg.setAuxWorkspace(99, '/ws/alpha') // never tracked
    reg.markCleanExit() // flush
    expect(readDoc().aux).toEqual([{ kind: 'token-monitor' }])
  })

  it('clean exit snapshots the auxiliary windows for auto-restore', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.addAux(2, { kind: 'plans', workspace_path: '/ws/alpha' })
    run1.addAux(3, { kind: 'token-monitor' })
    run1.markCleanExit()
    run1.remove(1)
    run1.remove(2)
    run1.remove(3)

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitAuxRestore()).toEqual([
      { kind: 'plans', workspace_path: '/ws/alpha' },
      { kind: 'token-monitor' },
    ])
  })

  it('a second markCleanExit after the windows are gone keeps the aux snapshot', () => {
    // Same two-call quit shapes as the workspace snapshot, and the aux guard
    // has to count its own map: borrowing entries.size would freeze an empty
    // list here, because the workspace windows are already gone.
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.addAux(2, { kind: 'git', workspace_path: '/ws/alpha' })
    run1.markCleanExit()
    run1.remove(2)
    run1.markCleanExit()

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitAuxRestore()).toEqual([{ kind: 'git', workspace_path: '/ws/alpha' }])
  })

  it('freezes an auxiliary window that outlived the last workspace window', () => {
    // A Plans window left open after the main one closed: entries is empty at
    // markCleanExit, auxEntries is not, and the aux list must still be frozen.
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.addAux(2, { kind: 'plans', workspace_path: '/ws/alpha' })
    run1.remove(1)
    run1.markCleanExit()

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitRestore()).toEqual([])
    expect(run2.cleanExitAuxRestore()).toEqual([{ kind: 'plans', workspace_path: '/ws/alpha' }])
  })

  it('a crash offers no auxiliary auto-restore, and neither does restoreOnLaunch=false', () => {
    const crashed = new WindowRegistry(file)
    crashed.readPendingAndReset()
    crashed.addAux(2, { kind: 'token-monitor' })
    // ...crash: no markCleanExit...
    const afterCrash = new WindowRegistry(file)
    afterCrash.readPendingAndReset()
    expect(afterCrash.cleanExitAuxRestore()).toEqual([])

    afterCrash.addAux(2, { kind: 'token-monitor' })
    afterCrash.setRestoreOnLaunch(false)
    afterCrash.markCleanExit()
    const afterOptOut = new WindowRegistry(file)
    afterOptOut.readPendingAndReset()
    expect(afterOptOut.cleanExitAuxRestore()).toEqual([])
  })

  it('auxiliary windows are never charged a restore attempt', () => {
    // They have no budget of their own: index.ts only reopens the
    // per-workspace ones for a workspace whose main window it already
    // restored, which is what keeps a skipped workspace skipped.
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.addAux(2, { kind: 'plans', workspace_path: '/ws/alpha' })
    expect(reg.restoreFailureCounts()).toEqual({})
  })
})

describe('restore failure breaker', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'win-reg-'))
    file = join(dir, 'open-windows.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const readDoc = (): { restoreFailures?: Record<string, number> } =>
    JSON.parse(readFileSync(file, 'utf-8'))

  /** One launch that restores `paths` and then dies without ever going stable —
   *  the wedged-backend case the breaker exists for. */
  const wedgedLaunch = (paths: string[]): WindowRegistry => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.beginRestore(paths.map((p) => ({ workspace_path: p })))
    return reg
  }

  it('charges and persists the attempt BEFORE the window is restored', () => {
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    const plan = reg.beginRestore([{ workspace_path: '/ws/drive' }])
    expect(plan.restore).toEqual([{ workspace_path: '/ws/drive' }])
    expect(plan.skipped).toEqual([])
    // Already on disk: a hang or kill -9 from here on still leaves the charge.
    expect(readDoc().restoreFailures).toEqual({ '/ws/drive': 1 })
  })

  it('accumulates across launches and skips at the threshold, restoring the rest', () => {
    for (let i = 1; i <= MAX_RESTORE_ATTEMPTS; i++) {
      wedgedLaunch(['/ws/drive', '/ws/local'])
      expect(readDoc().restoreFailures).toEqual({ '/ws/drive': i, '/ws/local': i })
    }
    // Next launch: /ws/drive is out of budget, a never-seen workspace is not.
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    const plan = reg.beginRestore([{ workspace_path: '/ws/drive' }, { workspace_path: '/ws/fresh' }])
    expect(plan.skipped).toEqual([{ workspace_path: '/ws/drive' }])
    expect(plan.restore).toEqual([{ workspace_path: '/ws/fresh' }])
    // A skipped workspace is not charged again — it is already at the cap.
    expect(readDoc().restoreFailures).toEqual({
      '/ws/drive': MAX_RESTORE_ATTEMPTS, '/ws/local': MAX_RESTORE_ATTEMPTS, '/ws/fresh': 1,
    })
  })

  it('a stable backend clears the ledger, giving every workspace its budget back', () => {
    for (let i = 0; i < MAX_RESTORE_ATTEMPTS; i++) wedgedLaunch(['/ws/drive'])
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    reg.clearRestoreFailures() // ← what backend-autorestart's onStable calls
    expect(readDoc().restoreFailures).toEqual({})
    expect(reg.beginRestore([{ workspace_path: '/ws/drive' }]).restore)
      .toEqual([{ workspace_path: '/ws/drive' }])
  })

  it('an explicit user restore overrides the skip and resets that tally', () => {
    for (let i = 0; i < MAX_RESTORE_ATTEMPTS; i++) wedgedLaunch(['/ws/drive', '/ws/other'])
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    const plan = reg.beginRestore([{ workspace_path: '/ws/drive' }], { userInitiated: true })
    expect(plan.restore).toEqual([{ workspace_path: '/ws/drive' }])
    expect(plan.skipped).toEqual([])
    // Consent resets the workspace it named to a fresh budget (this attempt is
    // still charged), and touches nothing else.
    expect(readDoc().restoreFailures).toEqual({ '/ws/drive': 1, '/ws/other': MAX_RESTORE_ATTEMPTS })
  })

  it('carries the ledger across the startup reset', () => {
    wedgedLaunch(['/ws/drive'])
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset() // rewrites the file for this run
    expect(readDoc().restoreFailures).toEqual({ '/ws/drive': 1 })
    expect(reg.restoreFailureCounts()).toEqual({ '/ws/drive': 1 })
  })

  it('a doc written before the breaker existed loads with an empty ledger', () => {
    writeFileSync(file, JSON.stringify({
      version: 1, cleanExit: true, windows: [], snapshot: [{ workspace_path: '/ws/alpha' }],
      restoreOnLaunch: true,
    }), 'utf-8')
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    expect(reg.restoreFailureCounts()).toEqual({})
    // ...and the old snapshot still restores normally.
    expect(reg.beginRestore(reg.cleanExitRestore()).restore).toEqual([{ workspace_path: '/ws/alpha' }])
  })

  it('ignores a corrupt ledger rather than failing the whole doc', () => {
    writeFileSync(file, JSON.stringify({
      version: 1, cleanExit: true, windows: [], snapshot: [], restoreOnLaunch: true,
      restoreFailures: { '/ws/a': 2, '/ws/bad': 'nope', '/ws/zero': 0, '': 5, '/ws/frac': 1.7 },
    }), 'utf-8')
    expect(parseRegistryDoc(readFileSync(file, 'utf-8')).restoreFailures)
      .toEqual({ '/ws/a': 2, '/ws/frac': 1 })
  })

  it('skips every workspace when they have all burned their budget', () => {
    for (let i = 0; i < MAX_RESTORE_ATTEMPTS; i++) wedgedLaunch(['/ws/a', '/ws/b'])
    const reg = new WindowRegistry(file)
    reg.readPendingAndReset()
    const plan = reg.beginRestore([{ workspace_path: '/ws/a' }, { workspace_path: '/ws/b' }])
    // Nothing to open. index.ts only sets openedAny inside the plan.restore
    // loop, so an empty list falls through to the plain createWindow() that
    // opens the workspace-less Welcome window — the app is never left blind.
    expect(plan.restore).toEqual([])
    expect(plan.skipped).toHaveLength(2)
  })
})

describe('a quit that did not complete', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'win-reg-'))
    file = join(dir, 'open-windows.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps the windows that quit closed in the next clean-exit snapshot', () => {
    // A quit closes alpha, then beta refuses (or the quit stalls) and the quit
    // is cancelled. The next quit only sees beta open; it must not shrink the
    // snapshot to beta alone.
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    run1.markCleanExit()
    run1.remove(1)
    run1.clearCleanExit()
    run1.markCleanExit()
    run1.remove(2)

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitRestore()).toEqual([
      { workspace_path: '/ws/beta' },
      { workspace_path: '/ws/alpha' },
    ])
  })

  it('survives a second cancelled quit as well', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    run1.setWorkspace(3, '/ws/gamma')
    run1.markCleanExit()
    run1.remove(1)
    run1.clearCleanExit()
    run1.markCleanExit()
    run1.remove(2)
    run1.clearCleanExit()
    run1.markCleanExit()
    run1.remove(3)

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitRestore().map((w) => w.workspace_path).sort())
      .toEqual(['/ws/alpha', '/ws/beta', '/ws/gamma'])
  })

  it('still drops a window the user closed after the quit was cancelled', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    run1.setWorkspace(3, '/ws/gamma')
    run1.markCleanExit()
    run1.remove(1) // closed by the quit
    run1.clearCleanExit()
    run1.remove(2) // closed by the user, outside any quit
    run1.markCleanExit()
    run1.remove(3)

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitRestore()).toEqual([
      { workspace_path: '/ws/gamma' },
      { workspace_path: '/ws/alpha' },
    ])
  })

  it('a workspace reopened after the cancel is tracked once, and stays closed if the user closes it', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    run1.markCleanExit()
    run1.remove(1)
    run1.clearCleanExit()
    run1.setWorkspace(3, '/ws/alpha') // the user reopens alpha...
    run1.remove(3) // ...and closes it again
    run1.markCleanExit()
    run1.remove(2)

    const run2 = new WindowRegistry(file)
    run2.readPendingAndReset()
    expect(run2.cleanExitRestore()).toEqual([{ workspace_path: '/ws/beta' }])
  })

  it('a crash after the cancel still offers only the windows still open', () => {
    const run1 = new WindowRegistry(file)
    run1.readPendingAndReset()
    run1.setWorkspace(1, '/ws/alpha')
    run1.setWorkspace(2, '/ws/beta')
    run1.markCleanExit()
    run1.remove(1)
    run1.clearCleanExit()
    // ...crash...

    const run2 = new WindowRegistry(file)
    expect(run2.readPendingAndReset()).toEqual([{ workspace_path: '/ws/beta' }])
  })
})

describe('onScreenBounds', () => {
  const primary = { x: 0, y: 25, width: 1440, height: 875 }
  const external = { x: 1440, y: 0, width: 1920, height: 1080 }

  it('keeps bounds that overlap any display', () => {
    const onExternal = { x: 2000, y: 100, width: 1200, height: 800 }
    expect(onScreenBounds(onExternal, [primary, external], primary)).toEqual(onExternal)
    const straddling = { x: 1000, y: 100, width: 1200, height: 800 }
    expect(onScreenBounds(straddling, [primary, external], primary)).toEqual(straddling)
  })

  it('moves bounds that overlap no display onto the primary one', () => {
    // Saved on an external display that is no longer connected.
    const lost = { x: 2000, y: 100, width: 1200, height: 800 }
    const moved = onScreenBounds(lost, [primary], primary)
    expect(moved).toEqual({ x: 120, y: 62, width: 1200, height: 800 })
  })

  it('shrinks a window larger than the primary display to fit it', () => {
    const lost = { x: -5000, y: -5000, width: 3000, height: 2000 }
    expect(onScreenBounds(lost, [primary], primary)).toEqual(primary)
  })

  it('treats bounds that only touch an edge as off screen', () => {
    const touching = { x: 1440, y: 25, width: 800, height: 600 }
    expect(onScreenBounds(touching, [primary], primary).x).toBeLessThan(1440)
  })
})
