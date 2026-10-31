// Bridges the flat keybindings.json rule array and the row-per-command view the
// Settings editor presents.
//
// A row is one (command, when) pair, because several defaults deliberately bind
// the same command under the same condition to more than one key
// (toggleAIChat has three, redo has two). Tracking rows per *rule* would make
// "which new key replaced which default" ambiguous the moment a command owns
// two default keys; tracking per (command, when) never is.
//
// Every edit funnels through setRowKeys, which rewrites the row's user rules
// from scratch: one removal per abandoned default, one addition per new key.
import type { KeybindingRule } from './types'
import { isRemovalRule, removalTarget } from './types'
import { canonicalizeKeySpec, validateKeySpec } from './parseKey'
import { evaluateWhen } from './whenEvaluator'
import { COMMAND_IDS, describeCommand } from './commandCatalog'
import { defaults } from './defaults'

export interface BindingKeyChip {
  key: string // canonical spec
  source: 'default' | 'user'
}

export interface BindingRow {
  id: string
  command: string
  label: string
  category: string
  when?: string
  defaultKeys: string[]
  keys: BindingKeyChip[]
  customized: boolean
  /** Must keep at least one binding; the editor hides its last remove button. */
  protected: boolean
}

/**
 * Commands that must always keep at least one binding.
 *
 * Unbinding the way into Settings locks the user out of the very screen that
 * could undo it — the only remaining fix would be deleting keybindings.json by
 * hand. Rebinding these to a different key is fine; removing every key is not.
 */
export const PROTECTED_COMMANDS: readonly string[] = [
  'workbench.action.openSettings',
  'workbench.action.openKeyboardShortcuts',
]

function isProtectedCommand(command: string): boolean {
  return PROTECTED_COMMANDS.includes(command)
}

/**
 * Last line of defence for the protected commands.
 *
 * The editor refuses to remove their final binding, but keybindings.json is a
 * plain file a user can edit by hand. If a hand-edit would leave a protected
 * command with nothing bound, its removals are dropped so the app stays
 * reachable. Additions are never touched — a deliberate rebind still works.
 */
export function sanitizeUserRules(
  userRules: KeybindingRule[],
  baseRules: KeybindingRule[] = defaults,
): KeybindingRule[] {
  const stranded = new Set<string>()
  for (const command of PROTECTED_COMMANDS) {
    const hasAddition = userRules.some((r) => !isRemovalRule(r) && r.command === command)
    if (hasAddition) continue
    const defaultCount = baseRules.filter((r) => r.command === command).length
    const removedCount = userRules.filter(
      (r) => isRemovalRule(r) && removalTarget(r) === command,
    ).length
    if (defaultCount > 0 && removedCount >= defaultCount) stranded.add(command)
  }
  if (!stranded.size) return userRules
  return userRules.filter((r) => !(isRemovalRule(r) && stranded.has(removalTarget(r))))
}

export function rowId(command: string, when?: string): string {
  return `${command}\u0000${when ?? ''}`
}

function belongsToRow(rule: KeybindingRule, command: string, when?: string): boolean {
  if ((rule.when ?? '') !== (when ?? '')) return false
  const target = isRemovalRule(rule) ? removalTarget(rule) : rule.command
  return target === command
}

function uniq(keys: string[]): string[] {
  return [...new Set(keys)]
}

/**
 * Merges the default rules with the user's overrides into display rows.
 * Rows keep the order defaults declare them in, so the editor reads like
 * defaults.ts rather than like a hash map.
 */
export function buildRows(
  userRules: KeybindingRule[],
  baseRules: KeybindingRule[] = defaults,
  catalog: readonly string[] = COMMAND_IDS,
): BindingRow[] {
  const order: string[] = []
  const byId = new Map<string, { command: string; when?: string; defaultKeys: string[] }>()

  for (const rule of baseRules) {
    if (isRemovalRule(rule)) continue
    const id = rowId(rule.command, rule.when)
    let entry = byId.get(id)
    if (!entry) {
      entry = { command: rule.command, when: rule.when, defaultKeys: [] }
      byId.set(id, entry)
      order.push(id)
    }
    entry.defaultKeys.push(canonicalizeKeySpec(rule.key))
  }

  // User rules may reference a (command, when) pair that has no default at all
  // — a binding the user invented. Those get their own rows at the end.
  for (const rule of userRules) {
    const command = isRemovalRule(rule) ? removalTarget(rule) : rule.command
    if (!command) continue
    const id = rowId(command, rule.when)
    if (byId.has(id)) continue
    byId.set(id, { command, when: rule.when, defaultKeys: [] })
    order.push(id)
  }

  // Commands that ship with no default key at all. Without these the editor
  // could only re-bind what already had a binding, which leaves out precisely
  // the commands a user most needs to reach (sort lines, change EOL, the case
  // transforms…). They get an unconditional row so a key can be assigned.
  const covered = new Set<string>()
  for (const entry of byId.values()) covered.add(entry.command)
  for (const command of catalog) {
    if (covered.has(command)) continue
    covered.add(command)
    const id = rowId(command, undefined)
    byId.set(id, { command, when: undefined, defaultKeys: [] })
    order.push(id)
  }

  return order.map((id) => {
    const entry = byId.get(id)!
    const defaultKeys = uniq(entry.defaultKeys)
    const mine = userRules.filter((r) => belongsToRow(r, entry.command, entry.when))
    const removed = new Set(
      mine.filter(isRemovalRule).map((r) => canonicalizeKeySpec(r.key)),
    )
    const added = uniq(
      mine.filter((r) => !isRemovalRule(r)).map((r) => canonicalizeKeySpec(r.key)),
    )

    const keys: BindingKeyChip[] = []
    for (const key of defaultKeys) {
      if (removed.has(key)) continue
      keys.push({ key, source: 'default' })
    }
    for (const key of added) {
      if (keys.some((k) => k.key === key)) continue
      keys.push({ key, source: 'user' })
    }

    const info = describeCommand(entry.command)
    return {
      id,
      command: entry.command,
      label: info.label,
      category: info.category,
      when: entry.when,
      defaultKeys,
      keys,
      customized: mine.length > 0,
      protected: isProtectedCommand(entry.command),
    }
  })
}

/**
 * Rewrites the user rules so `row` ends up bound to exactly `nextKeys`.
 * Passing an empty array unbinds the command in that context.
 */
export function setRowKeys(
  userRules: KeybindingRule[],
  row: BindingRow,
  nextKeys: string[],
): KeybindingRule[] {
  // Refuse to strand a protected command. Rebinding is allowed; ending up with
  // no key at all is not.
  if (row.protected && nextKeys.length === 0) return userRules

  const kept = userRules.filter((r) => !belongsToRow(r, row.command, row.when))
  // Validate here, not just on the import path: parseUserRules drops rules that
  // fail validateKeySpec when reading the file back, so accepting one now would
  // bind it for this session and then silently lose it on restart — leaving the
  // removal behind and the command with no key at all.
  const wanted = uniq(
    nextKeys
      .map(canonicalizeKeySpec)
      .filter((key): key is string => Boolean(key) && validateKeySpec(key).ok),
  )
  const out: KeybindingRule[] = [...kept]

  for (const key of row.defaultKeys) {
    if (wanted.includes(key)) continue
    out.push({ key, command: `-${row.command}`, ...(row.when ? { when: row.when } : {}) })
  }
  for (const key of wanted) {
    if (row.defaultKeys.includes(key)) continue
    out.push({ key, command: row.command, ...(row.when ? { when: row.when } : {}) })
  }
  return out
}

export type BindingSource = 'default' | 'modified' | 'custom' | 'unbound'

/**
 * The badge the editor shows for a row.
 *
 * Classification is derived from the row, not stored on the rule: a rule
 * carries no `source` field, and adding one would mean either giving all 177
 * defaults a stable id or re-deriving the answer from `(key, when)` anyway.
 * The row already knows which of its keys came from defaults and which the
 * user added, so the four states fall out of that.
 */
export function classifyRow(row: BindingRow): BindingSource {
  // No keys means unbound, whether the user switched a default off or the
  // command never shipped with one. Only the former has anything to reset, and
  // the row's own ↺ button already reflects that.
  if (!row.keys.length) return 'unbound'
  if (!row.customized) return 'default'
  return row.defaultKeys.length ? 'modified' : 'custom'
}

/** Drops every override touching this row, restoring the shipped defaults. */
export function resetRow(userRules: KeybindingRule[], row: BindingRow): KeybindingRule[] {
  return userRules.filter((r) => !belongsToRow(r, row.command, row.when))
}

/**
 * Rows that share a key. `hard` means the two rows also share an identical
 * `when`, so one is guaranteed to shadow the other; otherwise the contexts may
 * well keep them apart — defaults do this deliberately (cmd+shift+g is both
 * focusSourceControl and openGitWindow) and it must not be reported as broken.
 */
export interface KeyConflict {
  key: string
  rows: BindingRow[]
  /** Rows that lose in every window and every state — the only real breakage. */
  shadowed: BindingRow[]
  hard: boolean
}

/**
 * The windows a shortcut can be pressed in.
 *
 * The context keys below are not independent flags — they are window
 * identities, and no window ever sets two of them. Treating them as free
 * booleans is what made almost every shared key look broken: `⌘⇧F` is
 * findInFiles with no guard at all and git.fetch under `gitWindow`, which reads
 * as "always collides" unless you know the two can only ever meet inside the
 * Git window, where the override is the whole point.
 */
const WINDOW_SCENES: { id: string; ctx: Record<string, boolean> }[] = [
  { id: 'main', ctx: { paneStage: true } },
  { id: 'miniIde', ctx: { editorOpen: true } },
  { id: 'git', ctx: { gitWindow: true } },
  { id: 'plan', ctx: { planWindow: true } },
  // Pipeline Manager and friends: none of the identity flags.
  { id: 'other', ctx: {} },
]

/**
 * Transient state a guard can also test. Unlike the window identities these
 * come and go while a window is open, so a rule that needs one is not broken —
 * it just waits for it. Every combination is tried when asking whether a rule
 * can ever win.
 */
const TRANSIENT_KEYS = ['findOpen', 'modalOpen', 'terminalFocus', 'editorTextFocus', 'voiceInput'] as const

function transientAssignments(): Record<string, boolean>[] {
  const out: Record<string, boolean>[] = []
  for (let mask = 0; mask < 1 << TRANSIENT_KEYS.length; mask++) {
    const ctx: Record<string, boolean> = {}
    TRANSIENT_KEYS.forEach((k, i) => { ctx[k] = Boolean(mask & (1 << i)) })
    out.push(ctx)
  }
  return out
}

/**
 * Rows competing for `key`, in resolver priority order (last wins).
 *
 * Priority is NOT row order. The resolver is built as `[...defaults,
 * ...userRules]`, so every user rule outranks every default however early its
 * row appears in the table — and a row keeps its defaults position even when
 * the key in question is one the user added. Group by where the key came from
 * first, then by declaration order within each group.
 */
function contendersFor(rows: BindingRow[], key: string): BindingRow[] {
  const holds = (r: BindingRow, source: 'default' | 'user'): boolean =>
    r.keys.some((k) => k.key === key && k.source === source)
  return [...rows.filter((r) => holds(r, 'default')), ...rows.filter((r) => holds(r, 'user'))]
}

/**
 * Can this row ever be the rule that fires for `key`?
 *
 * Walks every window against every combination of transient state and asks who
 * the resolver would pick. A row that never comes out on top is genuinely dead
 * — that is the only thing worth showing in red. A row that wins somewhere is
 * merely sharing the key, however loudly the guards overlap on paper.
 */
function canEverWin(row: BindingRow, contenders: BindingRow[]): boolean {
  const passes = (r: BindingRow, ctx: Record<string, boolean>): boolean =>
    !r.when || evaluateWhen(r.when, ctx)

  for (const scene of WINDOW_SCENES) {
    for (const transient of transientAssignments()) {
      const ctx = { ...scene.ctx, ...transient }
      if (!passes(row, ctx)) continue
      // The resolver checks later rules first, so the last passing rule wins.
      let winner: BindingRow | null = null
      for (const c of contenders) if (passes(c, ctx)) winner = c
      if (winner === row) return true
    }
  }
  return false
}

export function findKeyConflicts(rows: BindingRow[]): KeyConflict[] {
  const byKey = new Map<string, BindingRow[]>()
  for (const row of rows) {
    for (const chip of row.keys) {
      const list = byKey.get(chip.key)
      if (list) list.push(row)
      else byKey.set(chip.key, [row])
    }
  }
  const out: KeyConflict[] = []
  for (const [key, list] of byKey) {
    if (list.length < 2) continue
    const contenders = contendersFor(rows, key)
    const shadowed = list.filter((row) => !canEverWin(row, contenders))
    out.push({ key, rows: list, shadowed, hard: shadowed.length > 0 })
  }
  return out
}

/** Conflicts keyed by row id, for per-row badges in the table. */
export function conflictsByRow(rows: BindingRow[]): Map<string, KeyConflict[]> {
  const out = new Map<string, KeyConflict[]>()
  for (const conflict of findKeyConflicts(rows)) {
    for (const row of conflict.rows) {
      const list = out.get(row.id)
      if (list) list.push(conflict)
      else out.set(row.id, [conflict])
    }
  }
  return out
}

export interface ImportReport {
  rules: KeybindingRule[]
  /** Human-readable reason per rejected entry, in file order. */
  rejected: string[]
  /** Commands kept in `rules` though nothing answers them yet. */
  deferred?: string[]
}

/**
 * Validates a file being imported.
 *
 * Stricter than `parseUserRules`, which only has to survive reading our own
 * file: an import comes from somewhere else, so a rule naming a command this
 * build does not have would sit in the list doing nothing. Rejections are
 * reported rather than dropped silently — the whole point of importing is
 * knowing what you got.
 */
export function reviewImportedRules(
  text: string,
  catalog: readonly string[] = COMMAND_IDS,
  /** A command this build may gain later, such as a Navide plugin's that is
   *  not installed: its rule is kept and named in `deferred`, not rejected. */
  isDeferred?: (command: string) => boolean,
): ImportReport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { rules: [], rejected: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] }
  }
  if (!Array.isArray(raw)) return { rules: [], rejected: ['Expected a JSON array of rules'] }

  const known = new Set(catalog)
  const rules: KeybindingRule[] = []
  const rejected: string[] = []
  let deferred: string[] | undefined

  raw.forEach((item, i) => {
    const at = `#${i + 1}`
    if (!item || typeof item !== 'object') { rejected.push(`${at}: not an object`); return }
    const { key, command, when, args } = item as Record<string, unknown>

    if (typeof key !== 'string') { rejected.push(`${at}: "key" must be a string`); return }
    const keyCheck = validateKeySpec(key)
    if (!keyCheck.ok) {
      rejected.push(`${at}: invalid key "${key}" (${keyCheck.reason}${keyCheck.detail ? `: ${keyCheck.detail}` : ''})`)
      return
    }
    if (typeof command !== 'string' || !command) {
      rejected.push(`${at}: "command" must be a non-empty string`); return
    }
    const target = command.startsWith('-') ? command.slice(1) : command
    if (!target) { rejected.push(`${at}: "-" is not a command`); return }
    const deferredCommand = !known.has(target) && isDeferred?.(target) === true
    if (!known.has(target) && !deferredCommand) {
      rejected.push(`${at}: unknown command "${target}"`); return
    }
    if (when !== undefined && typeof when !== 'string') {
      rejected.push(`${at}: "when" must be a string`); return
    }
    if (deferredCommand) (deferred ??= []).push(target)
    rules.push({ key, command, ...(when ? { when } : {}), ...(args !== undefined ? { args } : {}) })
  })

  return { rules, rejected, ...(deferred ? { deferred } : {}) }
}

export function serializeUserRules(rules: KeybindingRule[]): string {
  return `${JSON.stringify(rules, null, 2)}\n`
}

/**
 * Tolerant reader for keybindings.json: the file is user-editable, so a single
 * malformed entry must not throw away the rest. Returns the usable rules plus
 * how many entries were unusable, so a caller can report a hand-edit that went
 * wrong rather than losing the rule silently.
 */
export function parseUserRules(text: string): { rules: KeybindingRule[]; dropped: number } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { rules: [], dropped: 0 }
  }
  if (!Array.isArray(raw)) return { rules: [], dropped: 0 }

  const rules: KeybindingRule[] = []
  let dropped = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') { dropped++; continue }
    const { key, command, when, args } = item as Record<string, unknown>
    if (typeof key !== 'string' || !validateKeySpec(key).ok) { dropped++; continue }
    if (typeof command !== 'string' || !command) { dropped++; continue }
    if (when !== undefined && typeof when !== 'string') { dropped++; continue }
    rules.push({
      key,
      command,
      ...(when ? { when } : {}),
      ...(args !== undefined ? { args } : {}),
    })
  }
  return { rules, dropped }
}
