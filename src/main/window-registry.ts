import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Crash-restore registry: continuously persists which workspace windows are
// open so an unexpected exit (crash, kill -9, power loss) can be detected on
// the next launch and offered for restore. A clean quit marks `cleanExit`;
// a crash never gets the chance — that asymmetry IS the detector.
//
// The same file also carries a per-workspace restore failure ledger: a
// workspace whose filesystem wedges the backend would otherwise be restored,
// wedge the backend again, and loop forever (issue #24). See beginRestore().
//
// Only app-level window state lives here. Per-workspace pane state (and CLI
// session resume) is already persisted in each workspace's .agent-team/
// project.json and restored by the renderer when the workspace loads — this
// registry only needs to get the windows back on screen.

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowEntry {
  workspace_path: string
  bounds?: WindowBounds
  /** Run group this window was detached for, when it is a detached child
   *  rather than a main window. Recorded so a detached group comes back
   *  detached instead of silently folding into the main window on relaunch. */
  detached_group?: string
  /** Workspaces this window took on from its sidebar beyond `workspace_path`.
   *  Restored with it, so a window that was running three projects comes back
   *  running three projects rather than one. */
  adopted_workspaces?: string[]
}

/** The long-lived windows that live beside the workspace windows and are worth
 *  bringing back: the Plans review window, the unified Git window (its History
 *  view included — same window), and the machine-wide Token Monitor.
 *
 *  Deliberately NOT here: Diff, Branch Diff and the Editor. Those are one-shot
 *  viewers opened for a change the user has long since dealt with, so
 *  reopening them on the next launch is noise, not restore. Git Left is not a
 *  window at all — it is a contribution embedded in the main window. */
export type AuxWindowKind = 'plans' | 'git' | 'token-monitor'

export interface AuxWindowEntry {
  kind: AuxWindowKind
  /** Owning workspace for the per-workspace kinds; absent for machine-wide ones. */
  workspace_path?: string
  bounds?: WindowBounds
}

export interface RegistryDoc {
  version: 1
  cleanExit: boolean
  windows: WindowEntry[]
  /** Windows open at the last clean exit — the auto-restore snapshot. Kept
   *  separate from `windows` (live tracking) so the per-window remove() calls
   *  during the quit sequence can't wipe it. */
  snapshot: WindowEntry[]
  /** Auxiliary windows currently open — the `windows` equivalent for the kinds
   *  in AuxWindowKind, kept in its own list because they carry a kind instead
   *  of being defined by their workspace. */
  aux: AuxWindowEntry[]
  /** Auxiliary windows open at the last clean exit, frozen for the same reason
   *  `snapshot` is. */
  auxSnapshot: AuxWindowEntry[]
  /** User setting: reopen the last clean-exit windows on next launch. */
  restoreOnLaunch: boolean
  /** Consecutive restore attempts charged to each workspace path that the
   *  backend never survived. Cleared once the backend proves stable. */
  restoreFailures: Record<string, number>
}

/** Restore attempts a single workspace may cost before it is left unrestored.
 *  Matches backend-autorestart's attempt budget: three tries, then stop. */
export const MAX_RESTORE_ATTEMPTS = 3

/** The outcome of beginRestore(): what to open, and what was left alone. */
export interface RestorePlan {
  restore: WindowEntry[]
  skipped: WindowEntry[]
}

/** Keep only well-formed workspace entries (used for both windows and snapshot). */
function sanitizeEntries(list: unknown): WindowEntry[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((w: unknown): w is WindowEntry =>
      typeof w === 'object' && w !== null && typeof (w as WindowEntry).workspace_path === 'string'
      && (w as WindowEntry).workspace_path.length > 0)
    .map((w: WindowEntry) => ({
      workspace_path: w.workspace_path,
      ...(w.bounds ? { bounds: w.bounds } : {}),
      ...(typeof w.detached_group === 'string' && w.detached_group
        ? { detached_group: w.detached_group }
        : {}),
      ...(adopted(w.adopted_workspaces).length
        ? { adopted_workspaces: adopted(w.adopted_workspaces) }
        : {})
    }))
}

const AUX_WINDOW_KINDS: readonly AuxWindowKind[] = ['plans', 'git', 'token-monitor']

/** Keep only well-formed auxiliary entries (used for both aux and auxSnapshot).
 *
 *  An unknown kind is dropped rather than carried: a downgrade must not hand
 *  the restore loop a kind it has no opener for. The per-workspace kinds need
 *  their workspace or there is nothing to open them against, and the
 *  machine-wide one has its workspace_path stripped even when the file carries
 *  one — an older or hand-edited doc must not make the restore filter treat
 *  the Token Monitor as belonging to a workspace. */
function sanitizeAuxEntries(list: unknown): AuxWindowEntry[] {
  if (!Array.isArray(list)) return []
  const out: AuxWindowEntry[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as AuxWindowEntry
    if (!AUX_WINDOW_KINDS.includes(entry.kind)) continue
    const workspacePath = typeof entry.workspace_path === 'string' ? entry.workspace_path : ''
    if (entry.kind !== 'token-monitor' && !workspacePath) continue
    out.push({
      kind: entry.kind,
      ...(entry.kind === 'token-monitor' ? {} : { workspace_path: workspacePath }),
      ...(entry.bounds ? { bounds: entry.bounds } : {}),
    })
  }
  return out
}

/** The adopted-workspace list of a stored entry, or [] when it is missing or
 *  malformed. Non-string and empty items are dropped rather than failing the
 *  whole entry: the window still restores, just without that one workspace. */
function adopted(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((p): p is string => typeof p === 'string' && p.length > 0)
}

/** Keep only well-formed ledger entries: workspace path → positive attempt count. */
function sanitizeFailures(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [path, count] of Object.entries(value as Record<string, unknown>)) {
    if (!path) continue
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 1) continue
    out[path] = Math.floor(count)
  }
  return out
}

/** Parse a registry file's text, tolerating missing/corrupt content. */
export function parseRegistryDoc(text: string | null): RegistryDoc {
  const empty: RegistryDoc = {
    version: 1, cleanExit: true, windows: [], snapshot: [], aux: [], auxSnapshot: [],
    restoreOnLaunch: true, restoreFailures: {},
  }
  if (!text) return empty
  try {
    const data = JSON.parse(text)
    if (typeof data !== 'object' || data === null || !Array.isArray(data.windows)) return empty
    return {
      version: 1,
      cleanExit: data.cleanExit === true,
      windows: sanitizeEntries(data.windows),
      snapshot: sanitizeEntries(data.snapshot),
      // Missing keys (doc written before auxiliary windows were tracked) →
      // empty lists, same tolerance the ledger below gets.
      aux: sanitizeAuxEntries(data.aux),
      auxSnapshot: sanitizeAuxEntries(data.auxSnapshot),
      // Missing/undefined defaults to true (feature on); only explicit false disables.
      restoreOnLaunch: data.restoreOnLaunch !== false,
      // Missing key (doc written before the breaker existed) → empty ledger.
      restoreFailures: sanitizeFailures(data.restoreFailures),
    }
  } catch {
    return empty
  }
}

/** The windows to offer for restore, or null when the last exit was clean
 *  (or nothing restorable was open). */
export function pendingFromDoc(doc: RegistryDoc): WindowEntry[] | null {
  if (doc.cleanExit) return null
  return doc.windows.length ? doc.windows : null
}

/** Same window across lists: one workspace window per path, and a detached
 *  window per group of it. */
function sameWindow(a: WindowEntry, b: WindowEntry): boolean {
  return a.workspace_path === b.workspace_path && (a.detached_group ?? '') === (b.detached_group ?? '')
}

/** Saved bounds as they can be used on the displays attached now: unchanged
 *  when they overlap any display's work area, otherwise centred on the primary
 *  one (shrunk to fit). A window saved on a display that is no longer
 *  connected would otherwise open where nobody can see it. */
export function onScreenBounds(
  bounds: WindowBounds,
  workAreas: WindowBounds[],
  primary: WindowBounds,
): WindowBounds {
  const overlaps = workAreas.some((area) =>
    bounds.x < area.x + area.width && bounds.x + bounds.width > area.x
    && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y)
  if (overlaps) return bounds
  const width = Math.min(bounds.width, primary.width)
  const height = Math.min(bounds.height, primary.height)
  return {
    x: primary.x + Math.floor((primary.width - width) / 2),
    y: primary.y + Math.floor((primary.height - height) / 2),
    width,
    height,
  }
}

export class WindowRegistry {
  private entries = new Map<number, WindowEntry>()
  private cleanExit = false
  private snapshot: WindowEntry[] = []
  private auxEntries = new Map<number, AuxWindowEntry>()
  private auxSnapshot: AuxWindowEntry[] = []
  private restoreOnLaunch = true
  private lastCleanRestore: WindowEntry[] = []
  private lastCleanAuxRestore: AuxWindowEntry[] = []
  private restoreFailures = new Map<string, number>()
  /** Windows a cancelled quit had already closed. They are owed to the next
   *  clean-exit snapshot: the user never closed them, the quit did. */
  private cancelledQuitClosed: WindowEntry[] = []
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  // Accepts a path PROVIDER so the location can be resolved lazily: the dev
  // build re-points userData (…-dev suffix) after this module is imported, so
  // capturing app.getPath('userData') at construction would hit the wrong dir.
  constructor(private filePathOrFn: string | (() => string)) {}

  private get filePath(): string {
    return typeof this.filePathOrFn === 'function' ? this.filePathOrFn() : this.filePathOrFn
  }

  /** Read the previous run's doc, compute its restorable windows, then reset
   *  the file to this run's (empty, dirty) state. Call once at startup, after
   *  the single-instance lock is held. */
  readPendingAndReset(): WindowEntry[] | null {
    let text: string | null = null
    try { text = readFileSync(this.filePath, 'utf-8') } catch { /* first run */ }
    const doc = parseRegistryDoc(text)
    // Preserve the user setting across the reset, and capture the clean-exit
    // auto-restore list NOW — before persistNow() wipes the file to this run's
    // empty state. Crash pending and clean-exit restore are mutually exclusive:
    // cleanExit gates which one is non-empty.
    this.restoreOnLaunch = doc.restoreOnLaunch
    // The failure ledger must also survive the reset — it is the only record
    // that the previous launch charged a workspace an attempt it never
    // finished paying off.
    this.restoreFailures = new Map(Object.entries(doc.restoreFailures))
    this.lastCleanRestore = (doc.cleanExit && doc.restoreOnLaunch) ? doc.snapshot : []
    this.lastCleanAuxRestore = (doc.cleanExit && doc.restoreOnLaunch) ? doc.auxSnapshot : []
    const pending = pendingFromDoc(doc)
    this.persistNow()
    return pending
  }

  /** Windows to auto-restore after a clean exit. Valid only after
   *  readPendingAndReset() has run; empty if the last exit wasn't clean, the
   *  setting is off, or nothing was open. */
  cleanExitRestore(): WindowEntry[] {
    return this.lastCleanRestore
  }

  /** Auxiliary windows to auto-restore after a clean exit. Same validity rules
   *  as cleanExitRestore(), and deliberately NOT run through beginRestore():
   *  the per-workspace kinds are only reopened for a workspace whose main
   *  window this launch actually restored, so a workspace the breaker skipped
   *  can never be let back in through its Plans or Git window. The machine-wide
   *  kind loads no workspace at all, so it has nothing to charge. */
  cleanExitAuxRestore(): AuxWindowEntry[] {
    return this.lastCleanAuxRestore
  }

  /** Charge every candidate workspace one restore attempt BEFORE any window is
   *  created, then split the list into what may be opened and what has burned
   *  its budget. The charge is persisted immediately and on purpose: a
   *  workspace on a wedged filesystem can hang the backend hard enough that
   *  this launch never exits cleanly, so a counter written only on success
   *  could never fire. The increment on disk is the whole mechanism —
   *  clearRestoreFailures() is what pays it back.
   *
   *  `userInitiated` marks an explicit user action (the crash-restore banner's
   *  Apply): consent overrides the skip, and resets that workspace's tally so
   *  asking for a workspace can never leave the user locked out of it. */
  beginRestore(entries: WindowEntry[], opts?: { userInitiated?: boolean }): RestorePlan {
    const userInitiated = opts?.userInitiated === true
    const plan: RestorePlan = { restore: [], skipped: [] }
    for (const entry of entries) {
      const failures = userInitiated ? 0 : (this.restoreFailures.get(entry.workspace_path) ?? 0)
      if (failures >= MAX_RESTORE_ATTEMPTS) {
        plan.skipped.push(entry)
        continue
      }
      this.restoreFailures.set(entry.workspace_path, failures + 1)
      plan.restore.push(entry)
    }
    this.persistNow()
    return plan
  }

  /** Wipe the ledger: the backend has stayed up long enough to prove the
   *  restored workspaces did not kill it. Driven by backend-autorestart's
   *  stability window, so there is only one notion of "healthy" in the app. */
  clearRestoreFailures(): void {
    if (this.restoreFailures.size === 0) return
    this.restoreFailures.clear()
    this.persistNow()
  }

  /** Attempts currently charged to each workspace (diagnostics/tests). */
  restoreFailureCounts(): Record<string, number> {
    return Object.fromEntries(this.restoreFailures)
  }

  /** Record/replace the workspace for a window; empty path (back to Welcome)
   *  removes the entry — a workspace-less window isn't worth restoring. */
  setWorkspace(winId: number, workspacePath: string): void {
    if (!workspacePath) {
      this.entries.delete(winId)
    } else {
      // Everything else on the entry survives a workspace change: bounds,
      // detached_group, adopted_workspaces, and whatever gets added next.
      // This used to list them one by one, which meant every new field was a
      // silent data-loss bug waiting for someone to forget a line.
      const prev = this.entries.get(winId)
      const next = { ...prev, workspace_path: workspacePath }
      this.entries.set(winId, next)
      // Reopened: it is tracked live again, and closing it from here on is
      // the user's call like any other window.
      this.cancelledQuitClosed = this.cancelledQuitClosed.filter((w) => !sameWindow(w, next))
    }
    this.persistNow()
  }

  /** Mark a tracked window as the detached view of one run group.
   *
   *  Kept separate from setWorkspace because the two arrive independently:
   *  the renderer reports its workspace, main knows which group it detached.
   *  A window with no entry yet is ignored — setWorkspace lands first and the
   *  detach path re-states it right after. */
  setDetachedGroup(winId: number, groupId: string): void {
    const entry = this.entries.get(winId)
    if (!entry) return
    if (groupId) entry.detached_group = groupId
    else delete entry.detached_group
    this.persistNow()
  }

  /** Record the workspaces a window has taken on beyond its own.
   *
   *  Like setDetachedGroup: the renderer reports this independently of the
   *  workspace, and a window with no entry yet is ignored — a Welcome window
   *  has nothing to adopt into. */
  setAdoptedWorkspaces(winId: number, paths: string[]): void {
    const entry = this.entries.get(winId)
    if (!entry) return
    if (paths.length) entry.adopted_workspaces = [...paths]
    else delete entry.adopted_workspaces
    this.persistNow()
  }

  setBounds(winId: number, bounds: WindowBounds): void {
    const entry = this.entries.get(winId)
    if (!entry) return // Welcome window — not tracked
    entry.bounds = bounds
    this.persistDebounced()
  }

  /** Start tracking an auxiliary window. Unlike setWorkspace there is nothing
   *  to merge: the kind and workspace are fixed for the window's whole life. */
  addAux(winId: number, entry: AuxWindowEntry): void {
    this.auxEntries.set(winId, { ...entry })
    this.persistNow()
  }

  setAuxBounds(winId: number, bounds: WindowBounds): void {
    const entry = this.auxEntries.get(winId)
    if (!entry) return
    entry.bounds = bounds
    this.persistDebounced()
  }

  /** Re-point a tracked auxiliary window at another workspace.
   *
   *  Only the shared kinds need this. The Git window is keyed by its
   *  contribution alone, not by workspace, so opening Git for a second project
   *  re-targets the one window instead of creating another — and the entry has
   *  to follow, or a restore reopens Git on whichever workspace happened to
   *  create it. Ignores an untracked id and the machine-wide kind, which has no
   *  workspace to move. */
  setAuxWorkspace(winId: number, workspacePath: string): void {
    const entry = this.auxEntries.get(winId)
    if (!entry || entry.kind === 'token-monitor' || !workspacePath) return
    if (entry.workspace_path === workspacePath) return
    entry.workspace_path = workspacePath
    this.persistNow()
  }

  remove(winId: number): void {
    // Both maps, unconditionally: window ids are unique across the process, so
    // at most one of them holds this id, and returning early on the first miss
    // would leave every auxiliary window in the doc forever — it would look
    // open at the next launch and be restored on top of nothing.
    const removed = this.entries.delete(winId)
    const removedAux = this.auxEntries.delete(winId)
    if (!removed && !removedAux) return
    this.persistNow()
  }

  /** Mark this run as a clean exit. Synchronous — called from before-quit, and
   *  from the updater's install hook for the quit shapes that close the
   *  windows first. */
  markCleanExit(): void {
    this.cleanExit = true
    // Freeze the currently-open windows so the per-window remove() calls that
    // follow during the quit sequence can't empty the restore snapshot. A
    // second call once the windows are already gone must not undo the first:
    // the quit paths that close windows before before-quit reach this twice.
    if (this.entries.size || this.cancelledQuitClosed.length || !this.snapshot.length) {
      this.snapshot = [...this.entries.values(), ...this.cancelledQuitClosed]
      this.cancelledQuitClosed = []
    }
    // Same guard, on its own count: an auxiliary window can outlive the last
    // workspace window (a Plans window left open after the main one closed), so
    // borrowing `entries.size` here would refuse to freeze a list that is
    // genuinely there — and, on the second call, would happily overwrite a good
    // aux snapshot with an empty one.
    if (this.auxEntries.size || !this.auxSnapshot.length) {
      this.auxSnapshot = [...this.auxEntries.values()]
    }
    this.persistNow()
  }

  /** Undo markCleanExit for a quit that did not happen.
   *
   *  The updater freezes the snapshot when an install starts, but an install
   *  can be refused or time out and leave the app running. Without this the
   *  run would stay marked clean, and a crash later in it would come back with
   *  no restore offer — the exact case the crash banner exists for. */
  clearCleanExit(): void {
    if (!this.cleanExit) return
    this.cleanExit = false
    // A quit that closed some windows before it was cancelled (refused, stalled
    // or an install that never started) must not shrink the next snapshot to
    // the windows it left behind.
    const open = [...this.entries.values()]
    this.cancelledQuitClosed = this.snapshot.filter((w) => !open.some((o) => sameWindow(o, w)))
    this.persistNow()
  }

  getRestoreOnLaunch(): boolean {
    return this.restoreOnLaunch
  }

  setRestoreOnLaunch(value: boolean): void {
    this.restoreOnLaunch = value
    this.persistNow()
  }

  private doc(): RegistryDoc {
    return {
      version: 1,
      cleanExit: this.cleanExit,
      windows: [...this.entries.values()],
      snapshot: this.snapshot,
      aux: [...this.auxEntries.values()],
      auxSnapshot: this.auxSnapshot,
      restoreOnLaunch: this.restoreOnLaunch,
      restoreFailures: Object.fromEntries(this.restoreFailures),
    }
  }

  private persistNow(): void {
    if (this.persistTimer) { clearTimeout(this.persistTimer); this.persistTimer = null }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      // Atomic: write a sibling tmp file then rename over the target, so a
      // crash mid-write can't leave a truncated doc (parse falls back anyway).
      const tmp = join(dirname(this.filePath), '.open-windows.json.tmp')
      writeFileSync(tmp, JSON.stringify(this.doc(), null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
    } catch {
      // Best-effort: a failed persist only costs restore fidelity, never the app.
    }
  }

  // Bounds updates fire on every move/resize tick — coalesce them.
  private persistDebounced(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persistNow() }, 500)
  }
}
