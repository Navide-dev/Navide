// @vitest-environment happy-dom
// The merge layer between keybindings.json and the Settings editor.
//
// The invariant worth pinning hardest: a customization must change exactly the
// binding the user edited. Defaults deliberately stack several commands on the
// same key under different `when` clauses (cmd+shift+g is focusSourceControl in
// the Mini IDE and openGitWindow in the main window), so a rebind or an unbind
// that leaks across those contexts is a real user-facing break, not a detail.
import { describe, it, expect, vi } from 'vitest'
import {
  buildRows,
  classifyRow,
  conflictsByRow,
  findKeyConflicts,
  parseUserRules,
  resetRow,
  reviewImportedRules,
  rowId,
  sanitizeUserRules,
  serializeUserRules,
  setRowKeys,
} from '../customization'
import { KeyResolver } from '../keyResolver'
import { defaults } from '../defaults'
import type { KeybindingRule } from '../types'

// These cases pin the macOS rule table and tooltips (⌘N, ⌘,); happy-dom's
// navigator.platform reads as non-mac, which would add the Ctrl+Alt+N / Ctrl+,
// rules. platformSidebarKeys.test.ts covers Windows and Linux.
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, 'platform', { value: 'MacIntel', configurable: true })
})

const base: KeybindingRule[] = [
  { key: 'cmd+s', command: 'editor.action.save', when: 'editorOpen' },
  { key: 'cmd+shift+z', command: 'editor.action.redo', when: 'editorTextFocus' },
  { key: 'cmd+y', command: 'editor.action.redo', when: 'editorTextFocus' },
  { key: 'cmd+shift+g', command: 'workbench.action.focusSourceControl', when: '!findOpen' },
  { key: 'cmd+shift+g', command: 'workbench.action.openGitWindow', when: 'paneStage && !findOpen' },
  { key: 'cmd+k cmd+s', command: 'workbench.action.openKeyboardShortcuts' },
]

function rowFor(rows: ReturnType<typeof buildRows>, command: string, when?: string) {
  const row = rows.find((r) => r.id === rowId(command, when))
  if (!row) throw new Error(`no row for ${command}`)
  return row
}

function mkEvent(
  key: string,
  opts: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }> = {},
): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, ...opts })
}

describe('buildRows', () => {
  it('groups the keys a command owns under one row', () => {
    const rows = buildRows([], base)
    const redo = rowFor(rows, 'editor.action.redo', 'editorTextFocus')
    expect(redo.defaultKeys).toEqual(['cmd+shift+z', 'cmd+y'])
    expect(redo.keys.map((k) => k.source)).toEqual(['default', 'default'])
    expect(redo.customized).toBe(false)
  })

  it('keeps same-key commands in separate rows when their when-clause differs', () => {
    const rows = buildRows([], base)
    expect(rowFor(rows, 'workbench.action.focusSourceControl', '!findOpen').keys).toHaveLength(1)
    expect(rowFor(rows, 'workbench.action.openGitWindow', 'paneStage && !findOpen').keys).toHaveLength(1)
  })

  it('canonicalizes key order so modifier spelling never splits a row', () => {
    const rows = buildRows([], [{ key: 'shift+cmd+p', command: 'workbench.action.showCommands' }])
    expect(rows[0].defaultKeys).toEqual(['cmd+shift+p'])
  })

  it('carries a humanized label and category from the command id', () => {
    const rows = buildRows([], base)
    const save = rowFor(rows, 'editor.action.save', 'editorOpen')
    expect(save.label).toBe('Save')
    expect(save.category).toBe('Editor')
  })

  it('gives a user-invented binding its own row', () => {
    const rows = buildRows([{ key: 'cmd+alt+j', command: 'custom.thing' }], base)
    const row = rowFor(rows, 'custom.thing')
    expect(row.defaultKeys).toEqual([])
    expect(row.keys).toEqual([{ key: 'cmd+alt+j', source: 'user' }])
    expect(row.customized).toBe(true)
  })
})

describe('setRowKeys', () => {
  it('rebinding emits one removal for the default and one addition for the new key', () => {
    const rows = buildRows([], base)
    const rules = setRowKeys([], rowFor(rows, 'editor.action.save', 'editorOpen'), ['cmd+alt+s'])
    expect(rules).toEqual([
      { key: 'cmd+s', command: '-editor.action.save', when: 'editorOpen' },
      { key: 'cmd+alt+s', command: 'editor.action.save', when: 'editorOpen' },
    ])
  })

  it('keeping a default key emits no removal for it', () => {
    const rows = buildRows([], base)
    const redo = rowFor(rows, 'editor.action.redo', 'editorTextFocus')
    const rules = setRowKeys([], redo, ['cmd+shift+z', 'cmd+alt+y'])
    expect(rules).toEqual([
      { key: 'cmd+y', command: '-editor.action.redo', when: 'editorTextFocus' },
      { key: 'cmd+alt+y', command: 'editor.action.redo', when: 'editorTextFocus' },
    ])
  })

  it('unbinding emits removals only', () => {
    const rows = buildRows([], base)
    const rules = setRowKeys([], rowFor(rows, 'editor.action.redo', 'editorTextFocus'), [])
    expect(rules.every((r) => r.command === '-editor.action.redo')).toBe(true)
    expect(rules).toHaveLength(2)
  })

  it('is idempotent: re-editing a row replaces its rules instead of stacking them', () => {
    const rows1 = buildRows([], base)
    const once = setRowKeys([], rowFor(rows1, 'editor.action.save', 'editorOpen'), ['cmd+alt+s'])
    const rows2 = buildRows(once, base)
    const twice = setRowKeys(once, rowFor(rows2, 'editor.action.save', 'editorOpen'), ['cmd+ctrl+s'])
    expect(twice).toHaveLength(2)
    expect(twice.filter((r) => r.command.startsWith('-'))).toHaveLength(1)
  })

  it('leaves other rows’ rules untouched', () => {
    const rows = buildRows([], base)
    const first = setRowKeys([], rowFor(rows, 'editor.action.save', 'editorOpen'), ['cmd+alt+s'])
    const second = setRowKeys(first, rowFor(buildRows(first, base), 'editor.action.redo', 'editorTextFocus'), [])
    expect(second.filter((r) => r.command.endsWith('editor.action.save'))).toHaveLength(2)
  })

  it('round-trips through buildRows', () => {
    const rows = buildRows([], base)
    const rules = setRowKeys([], rowFor(rows, 'editor.action.save', 'editorOpen'), ['cmd+alt+s'])
    const after = rowFor(buildRows(rules, base), 'editor.action.save', 'editorOpen')
    expect(after.keys).toEqual([{ key: 'cmd+alt+s', source: 'user' }])
    expect(after.customized).toBe(true)
  })

  it('supports recording a chord', () => {
    const rows = buildRows([], base)
    const rules = setRowKeys([], rowFor(rows, 'editor.action.save', 'editorOpen'), ['cmd+k cmd+w'])
    const after = rowFor(buildRows(rules, base), 'editor.action.save', 'editorOpen')
    expect(after.keys).toEqual([{ key: 'cmd+k cmd+w', source: 'user' }])
  })
})

describe('resetRow', () => {
  it('drops every override for that row and nothing else', () => {
    const rows = buildRows([], base)
    let rules = setRowKeys([], rowFor(rows, 'editor.action.save', 'editorOpen'), ['cmd+alt+s'])
    rules = setRowKeys(rules, rowFor(buildRows(rules, base), 'editor.action.redo', 'editorTextFocus'), [])
    const reset = resetRow(rules, rowFor(buildRows(rules, base), 'editor.action.save', 'editorOpen'))
    expect(reset.some((r) => r.command.endsWith('editor.action.save'))).toBe(false)
    expect(reset.filter((r) => r.command === '-editor.action.redo')).toHaveLength(2)
  })
})

describe('classifyRow', () => {
  const classify = (rules: KeybindingRule[], command: string, when?: string) =>
    classifyRow(rowFor(buildRows(rules, base), command, when))

  it('an untouched row is default', () => {
    expect(classify([], 'editor.action.save', 'editorOpen')).toBe('default')
  })

  it('a rebound row is modified', () => {
    const rows = buildRows([], base)
    const rules = setRowKeys([], rowFor(rows, 'editor.action.save', 'editorOpen'), ['cmd+alt+s'])
    expect(classify(rules, 'editor.action.save', 'editorOpen')).toBe('modified')
  })

  it('a row that only gained an extra key is still modified, not custom', () => {
    const rows = buildRows([], base)
    const rules = setRowKeys([], rowFor(rows, 'editor.action.save', 'editorOpen'), ['cmd+s', 'cmd+alt+s'])
    expect(classify(rules, 'editor.action.save', 'editorOpen')).toBe('modified')
  })

  it('a command the user invented is custom', () => {
    expect(classify([{ key: 'cmd+alt+j', command: 'custom.thing' }], 'custom.thing')).toBe('custom')
  })

  it('a row whose every default was removed is unbound', () => {
    const rows = buildRows([], base)
    const rules = setRowKeys([], rowFor(rows, 'editor.action.redo', 'editorTextFocus'), [])
    expect(classify(rules, 'editor.action.redo', 'editorTextFocus')).toBe('unbound')
  })

  it('returns to default after a reset', () => {
    const rows = buildRows([], base)
    const row = rowFor(rows, 'editor.action.save', 'editorOpen')
    const rules = resetRow(setRowKeys([], row, ['cmd+alt+s']), row)
    expect(classify(rules, 'editor.action.save', 'editorOpen')).toBe('default')
  })

  it('a command with no default key reads as unbound', () => {
    // The four states are default / modified / custom / unbound. A command that
    // never shipped with a key and one whose default the user switched off both
    // show as unbound; the row's own ↺ button is what distinguishes them.
    const row = rowFor(buildRows([]), 'editor.action.sortLinesAscending')
    expect(classifyRow(row)).toBe('unbound')
  })

  it('with no overrides, every row is either default or unbound', () => {
    const states = new Set(buildRows([]).map(classifyRow))
    expect([...states].sort()).toEqual(['default', 'unbound'])
  })

  it('assigning a key to an unassigned command makes it custom', () => {
    const row = rowFor(buildRows([]), 'editor.action.sortLinesAscending')
    const rules = setRowKeys([], row, ['cmd+alt+1'])
    expect(classifyRow(rowFor(buildRows(rules), 'editor.action.sortLinesAscending'))).toBe('custom')
  })
})

describe('conflict reporting', () => {
  it('reports a hard conflict when two rows share a key AND a when-clause', () => {
    const rows = buildRows([], [
      { key: 'cmd+s', command: 'a.one', when: 'editorOpen' },
      { key: 'cmd+s', command: 'a.two', when: 'editorOpen' },
    ])
    const [conflict] = findKeyConflicts(rows)
    expect(conflict.key).toBe('cmd+s')
    expect(conflict.hard).toBe(true)
  })


  it('reports a soft conflict when neither when-clause implies the other', () => {
    const rows = buildRows([], [
      { key: 'cmd+e', command: 'a.one', when: 'editorTextFocus' },
      { key: 'cmd+e', command: 'a.two', when: 'terminalFocus' },
    ])
    const conflict = findKeyConflicts(rows).find((c) => c.key === 'cmd+e')
    expect(conflict?.hard).toBe(false)
  })


  it('does not report a key owned by a single row', () => {
    const rows = buildRows([], base)
    expect(findKeyConflicts(rows).some((c) => c.key === 'cmd+s')).toBe(false)
  })

  it('indexes conflicts by row for per-row badges', () => {
    const rows = buildRows([], base)
    const index = conflictsByRow(rows)
    expect(index.has(rowId('workbench.action.openGitWindow', 'paneStage && !findOpen'))).toBe(true)
    expect(index.has(rowId('editor.action.save', 'editorOpen'))).toBe(false)
  })

  it('ranks a user override above every default competing for the key', () => {
    // The resolver is built as [...defaults, ...userRules] and the last match
    // wins, so a key the user assigned outranks a default no matter where its
    // row sits in the table. Ordering contenders by row position instead would
    // invert both verdicts here.
    const rows = buildRows(
      [{ key: 'cmd+j', command: 'a.early' }],
      [
        { key: 'cmd+1', command: 'a.early' },
        { key: 'cmd+j', command: 'a.late' },
      ],
    )
    const conflict = findKeyConflicts(rows).find((c) => c.key === 'cmd+j')
    expect(conflict?.shadowed.map((r) => r.command)).toEqual(['a.late'])
  })

  it('surfaces a conflict introduced by the user’s own rebind', () => {
    const rows = buildRows([], base)
    const rules = setRowKeys([], rowFor(rows, 'editor.action.save', 'editorOpen'), ['cmd+k cmd+s'])
    const conflict = findKeyConflicts(buildRows(rules, base)).find((c) => c.key === 'cmd+k cmd+s')
    expect(conflict).toBeDefined()
  })
})

describe('parseUserRules', () => {
  it('accepts a well-formed array', () => {
    const { rules, dropped } = parseUserRules('[{"key":"cmd+s","command":"a.b","when":"x"}]')
    expect(rules).toEqual([{ key: 'cmd+s', command: 'a.b', when: 'x' }])
    expect(dropped).toBe(0)
  })

  it('keeps the good entries and counts the bad ones', () => {
    const { rules, dropped } = parseUserRules(
      '[{"key":"cmd+s","command":"a.b"},{"key":""},{"command":"c.d"},null,{"key":"cmd+t","command":"e.f","when":3}]',
    )
    expect(rules).toEqual([{ key: 'cmd+s', command: 'a.b' }])
    expect(dropped).toBe(4)
  })

  it('returns empty for malformed JSON or a non-array root', () => {
    expect(parseUserRules('not json').rules).toEqual([])
    expect(parseUserRules('{"key":"cmd+s"}').rules).toEqual([])
  })

  it('preserves args', () => {
    const { rules } = parseUserRules('[{"key":"cmd+s","command":"a.b","args":{"n":1}}]')
    expect(rules[0].args).toEqual({ n: 1 })
  })

  it('round-trips what serializeUserRules writes', () => {
    const rules: KeybindingRule[] = [{ key: 'cmd+alt+s', command: 'editor.action.save', when: 'editorOpen' }]
    expect(parseUserRules(serializeUserRules(rules)).rules).toEqual(rules)
  })
})

// The point of the whole layer: what the editor writes has to change what the
// resolver does, and only that.
describe('end-to-end against the real defaults', () => {
  it('rebinding save moves the command off cmd+s and onto the new key', () => {
    const row = rowFor(buildRows([]), 'editor.action.save', 'editorOpen && !terminalFocus')
    const rules = setRowKeys([], row, ['cmd+alt+s'])
    const resolver = new KeyResolver([...defaults, ...rules])
    const ctx = { editorOpen: true, terminalFocus: false }

    expect(resolver.resolve(mkEvent('s', { metaKey: true }), ctx)).toBeNull()
    expect(resolver.resolve(mkEvent('s', { metaKey: true, altKey: true }), ctx)?.command)
      .toBe('editor.action.save')
  })

  it('unbinding the Mini IDE’s cmd+shift+g leaves the main window’s Git window binding alone', () => {
    const row = rowFor(buildRows([]), 'workbench.action.focusSourceControl', '!findOpen')
    const rules = setRowKeys([], row, [])
    const resolver = new KeyResolver([...defaults, ...rules])

    expect(resolver.resolve(mkEvent('G', { metaKey: true, shiftKey: true }), { findOpen: false }))
      .toBeNull()
    expect(
      resolver.resolve(mkEvent('G', { metaKey: true, shiftKey: true }), { paneStage: true, findOpen: false })
        ?.command,
    ).toBe('workbench.action.openGitWindow')
  })

  it('resetting restores the shipped behaviour exactly', () => {
    const row = rowFor(buildRows([]), 'editor.action.save', 'editorOpen && !terminalFocus')
    const rules = resetRow(setRowKeys([], row, ['cmd+alt+s']), row)
    const resolver = new KeyResolver([...defaults, ...rules])
    expect(resolver.resolve(mkEvent('s', { metaKey: true }), { editorOpen: true })?.command)
      .toBe('editor.action.save')
  })

  it('splits into exactly two populations: bound defaults, and unassigned commands', () => {
    // Since the manifest joined in, a keyless row is no longer a bug — it is a
    // command that ships without a key and is waiting to be assigned. What must
    // still hold is that the two populations do not overlap.
    const rows = buildRows([])
    expect(rows.filter((r) => r.defaultKeys.length).every((r) => r.keys.length > 0)).toBe(true)
    expect(rows.filter((r) => !r.keys.length).every((r) => !r.defaultKeys.length)).toBe(true)
  })

  it('lists commands that have no default key at all', () => {
    const rows = buildRows([])
    const unassigned = rows.filter((r) => !r.defaultKeys.length).map((r) => r.command)
    // A representative sample from the transform/EOL families, none of which
    // has a default binding — invisible before the manifest existed.
    expect(unassigned).toContain('editor.action.sortLinesAscending')
    expect(unassigned).toContain('editor.action.changeEOLtoLF')
    expect(unassigned).toContain('editor.action.transformToSnakeCase')
    // Was >40 before ui.* left the manifest; those 13 were unassigned too, but
    // they are MCP-only and never belonged in the editor. The floor exists to
    // catch the list collapsing back to "defaults only", not to pin an exact
    // count — 31 is still far from zero.
    expect(unassigned.length).toBeGreaterThan(25)
  })

  it('gives an unassigned command exactly one row, not one per when-clause', () => {
    const rows = buildRows([]).filter((r) => r.command === 'editor.action.sortLinesAscending')
    expect(rows).toHaveLength(1)
    expect(rows[0].when).toBeUndefined()
  })

  it('can assign a key to a command that shipped without one', () => {
    const row = rowFor(buildRows([]), 'editor.action.sortLinesAscending')
    const rules = setRowKeys([], row, ['cmd+alt+1'])
    // No removal to emit — there was no default to cancel.
    expect(rules).toEqual([{ key: 'cmd+alt+1', command: 'editor.action.sortLinesAscending' }])

    const resolver = new KeyResolver([...defaults, ...rules])
    expect(resolver.resolve(mkEvent('1', { metaKey: true, altKey: true, code: 'Digit1' }), {})?.command)
      .toBe('editor.action.sortLinesAscending')
  })
})

// ── Lockout protection ────────────────────────────────────────────────────────
// Removing every binding for "open Settings" would hide the only screen that
// can undo it. Rebinding stays allowed; ending up with nothing does not.
describe('protected commands', () => {
  const settingsRow = () =>
    rowFor(buildRows([]), 'workbench.action.openSettings')

  it('marks the way back into Settings as protected', () => {
    expect(settingsRow().protected).toBe(true)
    expect(rowFor(buildRows([]), 'editor.action.save', 'editorOpen && !terminalFocus').protected)
      .toBe(false)
  })

  it('refuses to remove the last binding', () => {
    expect(setRowKeys([], settingsRow(), [])).toEqual([])
  })

  it('still allows rebinding it to another key', () => {
    const rules = setRowKeys([], settingsRow(), ['cmd+alt+,'])
    expect(rules.some((r) => r.command === 'workbench.action.openSettings')).toBe(true)
    const after = rowFor(buildRows(rules), 'workbench.action.openSettings')
    expect(after.keys.map((k) => k.key)).toEqual(['cmd+alt+,'])
  })

  it('drops a hand-edited removal that would strand the command', () => {
    const handEdited: KeybindingRule[] = [
      { key: 'cmd+,', command: '-workbench.action.openSettings' },
    ]
    expect(sanitizeUserRules(handEdited)).toEqual([])
  })

  it('keeps the removal when the same file rebinds the command elsewhere', () => {
    const handEdited: KeybindingRule[] = [
      { key: 'cmd+,', command: '-workbench.action.openSettings' },
      { key: 'cmd+alt+,', command: 'workbench.action.openSettings' },
    ]
    expect(sanitizeUserRules(handEdited)).toEqual(handEdited)
  })

  it('leaves unrelated removals alone', () => {
    const rules: KeybindingRule[] = [
      { key: 'cmd+s', command: '-editor.action.save', when: 'editorOpen && !terminalFocus' },
    ]
    expect(sanitizeUserRules(rules)).toEqual(rules)
  })

  it('keeps Settings reachable after a stranding hand-edit', () => {
    const sanitized = sanitizeUserRules([
      { key: 'cmd+,', command: '-workbench.action.openSettings' },
    ])
    const resolver = new KeyResolver([...defaults, ...sanitized])
    expect(resolver.resolve(mkEvent(',', { metaKey: true }), {})?.command)
      .toBe('workbench.action.openSettings')
  })
})

// ── Cmd+1..5 moved into the keybinding system ─────────────────────────────────
describe('main-window sidebar tabs', () => {
  it('are ordinary rules now, so the editor can list and rebind them', () => {
    const rows = buildRows([])
    for (let i = 1; i <= 5; i++) {
      const row = rowFor(rows, `controlPane.selectSidebarTab${i}`, 'paneStage && !editorOpen')
      expect(row.defaultKeys).toEqual([`cmd+${i}`])
    }
  })

  it('fire in the main window', () => {
    const resolver = new KeyResolver(defaults)
    expect(resolver.resolve(mkEvent('1', { metaKey: true, code: 'Digit1' }), { paneStage: true })?.command)
      .toBe('controlPane.selectSidebarTab1')
  })

  it('yield to the editor tab jumps where an editor is open', () => {
    const resolver = new KeyResolver(defaults)
    expect(
      resolver.resolve(mkEvent('1', { metaKey: true, code: 'Digit1' }), { editorOpen: true })?.command,
    ).toBe('workbench.action.openEditorAtIndex1')
  })

  it('unbinding one really stops it — the point of moving it in', () => {
    const row = rowFor(buildRows([]), 'controlPane.selectSidebarTab1', 'paneStage && !editorOpen')
    const resolver = new KeyResolver([...defaults, ...setRowKeys([], row, [])])
    expect(resolver.resolve(mkEvent('1', { metaKey: true, code: 'Digit1' }), { paneStage: true }))
      .toBeNull()
  })
})

// ── Import review ─────────────────────────────────────────────────────────────
// An imported file comes from elsewhere, so it gets checked harder than our own:
// a rule naming a command this build does not have would sit in the list doing
// nothing. Rejections are reported, never dropped silently.
describe('reviewImportedRules', () => {
  it('accepts a well-formed export', () => {
    const { rules, rejected } = reviewImportedRules(
      '[{"key":"cmd+alt+s","command":"editor.action.save","when":"editorOpen"}]',
    )
    expect(rejected).toEqual([])
    expect(rules).toEqual([{ key: 'cmd+alt+s', command: 'editor.action.save', when: 'editorOpen' }])
  })

  it('accepts a removal rule', () => {
    const { rules, rejected } = reviewImportedRules('[{"key":"cmd+s","command":"-editor.action.save"}]')
    expect(rejected).toEqual([])
    expect(rules).toHaveLength(1)
  })

  it('rejects a command this build does not have', () => {
    const { rules, rejected } = reviewImportedRules('[{"key":"cmd+s","command":"editor.action.fromTheFuture"}]')
    expect(rules).toEqual([])
    expect(rejected[0]).toContain('unknown command')
  })

  it('rejects a three-segment chord', () => {
    const { rejected } = reviewImportedRules('[{"key":"cmd+k cmd+s cmd+t","command":"editor.action.save"}]')
    expect(rejected[0]).toContain('too-many-segments')
  })

  it('reports the position of each bad entry and keeps the good ones', () => {
    const { rules, rejected } = reviewImportedRules(JSON.stringify([
      { key: 'cmd+alt+s', command: 'editor.action.save' },
      { key: 'cmmd+x', command: 'editor.action.undo' },
      { key: 'cmd+alt+u', command: 'nope.not.real' },
    ]))
    expect(rules).toHaveLength(1)
    expect(rejected).toHaveLength(2)
    expect(rejected[0]).toContain('#2')
    expect(rejected[1]).toContain('#3')
  })

  it('rejects a non-array and malformed JSON with a readable reason', () => {
    expect(reviewImportedRules('{}').rejected[0]).toContain('array')
    expect(reviewImportedRules('nope').rejected[0]).toContain('Not valid JSON')
  })

  it('round-trips what the export writes', () => {
    const row = rowFor(buildRows([]), 'editor.action.save', 'editorOpen && !terminalFocus')
    const exported = serializeUserRules(setRowKeys([], row, ['cmd+alt+s']))
    const { rules, rejected } = reviewImportedRules(exported)
    expect(rejected).toEqual([])
    expect(rules).toHaveLength(2)
  })
})

// ── setRowKeys rejects what the loader would later drop ───────────────────────
// Without this, a bad key survives the session and dies on restart: the
// addition is dropped by parseUserRules while its removal stays, leaving the
// command with no binding at all and no message.
describe('setRowKeys key validation', () => {
  const saveRow = () => rowFor(buildRows([]), 'editor.action.save', 'editorOpen && !terminalFocus')

  it('does not write a key validateKeySpec rejects', () => {
    const rules = setRowKeys([], saveRow(), ['insert'])
    expect(rules.some((r) => !r.command.startsWith('-'))).toBe(false)
  })

  it('drops only the bad key when several are given', () => {
    const rules = setRowKeys([], saveRow(), ['cmd+alt+s', 'cmd+k cmd+s cmd+t'])
    const additions = rules.filter((r) => !r.command.startsWith('-')).map((r) => r.key)
    expect(additions).toEqual(['cmd+alt+s'])
  })

  it('survives a round trip through the loader, which is the point', () => {
    const rules = setRowKeys([], saveRow(), ['cmd+alt+s'])
    const reloaded = parseUserRules(serializeUserRules(rules))
    expect(reloaded.dropped).toBe(0)
    expect(reloaded.rules).toEqual(rules)
  })
})

// ── Conflict severity accounts for one guard implying another ─────────────────
describe('hard conflicts include implied guards', () => {

  it('still treats genuinely exclusive guards as a soft share', () => {
    const rows = buildRows([], [
      { key: 'cmd+j', command: 'a.one', when: 'editorOpen' },
      { key: 'cmd+j', command: 'a.two', when: 'gitWindow' },
    ])
    expect(findKeyConflicts(rows).find((c) => c.key === 'cmd+j')?.hard).toBe(false)
  })
})

// ── Conflict severity is decided per window, not per guard string ─────────────
// The guards alone say `⌘⇧F` collides: findInFiles has no guard and git.fetch
// wants `gitWindow`. They only ever meet inside the Git window, where the
// override is the entire point — so the honest answer is "shared", not "broken".
describe('conflict severity across windows', () => {
  const conflictFor = (key: string, rows = buildRows([])) =>
    findKeyConflicts(rows).find((c) => c.key === key)

  it('no shipped default is fully shadowed', () => {
    const broken = findKeyConflicts(buildRows([])).filter((c) => c.hard)
    expect(broken.map((c) => c.key)).toEqual([])
  })

  it('a window-scoped override is shared, not broken', () => {
    const c = conflictFor('cmd+shift+f')
    expect(c?.rows.length).toBeGreaterThan(1)
    expect(c?.hard).toBe(false)
    expect(c?.shadowed).toEqual([])
  })

  it('⌘⇧G keeps all three owners: each wins in some window', () => {
    const c = conflictFor('cmd+shift+g')
    expect(c?.rows).toHaveLength(3)
    expect(c?.shadowed).toEqual([])
  })

  // The detector must still bite, or it is just a green light.
  it('flags a row that can never win anywhere', () => {
    const rows = buildRows([], [
      { key: 'cmd+j', command: 'a.loser', when: 'editorOpen' },
      { key: 'cmd+j', command: 'a.winner', when: 'editorOpen' },
    ])
    const c = findKeyConflicts(rows).find((x) => x.key === 'cmd+j')
    expect(c?.hard).toBe(true)
    expect(c?.shadowed.map((r) => r.command)).toEqual(['a.loser'])
  })

  it('flags an unguarded row buried under a later unguarded one', () => {
    const rows = buildRows([], [
      { key: 'cmd+j', command: 'a.first' },
      { key: 'cmd+j', command: 'a.second' },
    ])
    const c = findKeyConflicts(rows).find((x) => x.key === 'cmd+j')
    expect(c?.shadowed.map((r) => r.command)).toEqual(['a.first'])
  })

  it('a guard that is strictly narrower does not shadow the broader one', () => {
    // The narrow rule wins where it applies; the broad one still wins elsewhere.
    const rows = buildRows([], [
      { key: 'cmd+j', command: 'a.broad' },
      { key: 'cmd+j', command: 'a.narrow', when: 'gitWindow' },
    ])
    expect(findKeyConflicts(rows).find((x) => x.key === 'cmd+j')?.hard).toBe(false)
  })

  it('mutually exclusive windows are never a conflict', () => {
    const rows = buildRows([], [
      { key: 'cmd+j', command: 'a.git', when: 'gitWindow' },
      { key: 'cmd+j', command: 'a.main', when: 'paneStage' },
    ])
    expect(findKeyConflicts(rows).find((x) => x.key === 'cmd+j')?.hard).toBe(false)
  })
})

describe('reviewImportedRules with deferred commands', () => {
  const file = JSON.stringify([{ key: 'cmd+alt+t', command: 'acme.runner.go' }])

  it('still rejects an unknown command when the caller defers nothing', () => {
    expect(reviewImportedRules(file)).toEqual({ rules: [], rejected: ['#1: unknown command "acme.runner.go"'] })
  })

  it('keeps a deferred command and names it', () => {
    const report = reviewImportedRules(file, [], (id) => id.startsWith('acme.'))
    expect(report.rules).toEqual([{ key: 'cmd+alt+t', command: 'acme.runner.go' }])
    expect(report.rejected).toEqual([])
    expect(report.deferred).toEqual(['acme.runner.go'])
  })
})
