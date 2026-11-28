// Drift guard for COMMAND_IDS.
//
// The manifest has to be static — registerCommand is called from four root
// components in four separate windows, so no single runtime registry ever holds
// all of them. A static list rots silently, so this test rebuilds the expected
// set from the source itself and compares both directions: a command added
// without a manifest entry fails, and a manifest entry with nothing behind it
// fails too.
//
// Two scans, because two things register commands:
//   - literal `registerCommand('id')` calls — the great majority
//   - loops with a template id (`editor.foldLevel${n}`), which have no literal
//     to find; those are recovered from the keys `defaults.ts` binds
// A loop-registered command that ALSO has no default binding is invisible to
// both scans. None exist today; if one appears it must be added by hand, and
// this comment is the only warning you get.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { COMMAND_IDS } from '../commandCatalog'

const APP_SRC = join(process.cwd(), 'src', 'renderer', 'src')
const SHARED_SRC = join(process.cwd(), 'packages/plugin-ui/src/shared')

// Comments are stripped before matching: prose that merely mentions
// `registerCommand('...')` — including the doc comment on COMMAND_IDS itself —
// would otherwise be scanned as a real registration.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|vue)$/.test(entry)) out.push(full)
  }
  return out
}

/** Literal ids: `registerCommand('workbench.action.save', …)`. */
function literalCommandIds(): Set<string> {
  const found = new Set<string>()
  for (const file of sourceFiles(APP_SRC)) {
    const text = stripComments(readFileSync(file, 'utf-8'))
    for (const m of text.matchAll(/registerCommand\('([^']+)'/g)) found.add(m[1])
  }
  return found
}

/** Ids registered through a template literal, e.g. `editor.foldLevel${n}`. */
function dynamicRegistrations(): string[] {
  const found: string[] = []
  for (const file of sourceFiles(APP_SRC)) {
    const text = stripComments(readFileSync(file, 'utf-8'))
    for (const m of text.matchAll(/registerCommand\(`([^`]+)`/g)) found.push(m[1])
  }
  return found
}

/** Commands `defaults.ts` binds a key to. */
function boundCommandIds(): Set<string> {
  const text = stripComments(readFileSync(join(SHARED_SRC, 'keybindings/defaults.ts'), 'utf-8'))
  const found = new Set<string>()
  for (const m of text.matchAll(/command: '([^']+)'/g)) found.add(m[1])
  return found
}

/** MCP-only surface: invoked through ui_invoke, never bound to a key. */
const EXTERNAL_ONLY = /^ui\./

const manifest = new Set(COMMAND_IDS)

describe('COMMAND_IDS covers every registered command', () => {
  it('contains every literal registerCommand id', () => {
    const missing = [...literalCommandIds()]
      .filter((id) => !EXTERNAL_ONLY.test(id))
      .filter((id) => !manifest.has(id))
      .sort()
    expect(missing).toEqual([])
  })

  it('contains every command that defaults.ts binds', () => {
    const missing = [...boundCommandIds()].filter((id) => !manifest.has(id)).sort()
    expect(missing).toEqual([])
  })

  it('leaves out the MCP-only ui.* surface', () => {
    // Driven by external clients through ui_invoke, never by a keystroke. If one
    // ever shows up in the editor it means the exclusion was dropped, and users
    // get a dozen rows they cannot act on.
    expect(COMMAND_IDS.filter((id) => EXTERNAL_ONLY.test(id))).toEqual([])
    // Guard the guard: if ui.* commands ever stop existing, this exclusion is
    // dead weight and the test should be removed with it.
    expect([...literalCommandIds()].some((id) => EXTERNAL_ONLY.test(id))).toBe(true)
  })
})

describe('COMMAND_IDS has nothing extra', () => {
  it('every entry is either registered literally or bound by defaults', () => {
    const known = new Set([...literalCommandIds(), ...boundCommandIds()])
    const stale = COMMAND_IDS.filter((id) => !known.has(id)).sort()
    expect(stale).toEqual([])
  })
})

describe('manifest hygiene', () => {
  it('has no duplicates', () => {
    expect(manifest.size).toBe(COMMAND_IDS.length)
  })

  it('is sorted, so additions produce a readable diff', () => {
    expect([...COMMAND_IDS].sort()).toEqual([...COMMAND_IDS])
  })

  it('holds more commands than defaults binds — the gap is the point', () => {
    // If these ever match, the manifest has silently collapsed back to
    // "whatever has a default key" and the unassignable commands are hidden
    // again, which is the bug this whole manifest exists to fix.
    expect(COMMAND_IDS.length).toBeGreaterThan(boundCommandIds().size)
  })
})

describe('loop-registered command families', () => {
  // These three are why the literal scan alone is not enough. Pinning them
  // means a new loop family shows up here as a failure rather than as a
  // quietly missing row in Settings.
  it('are exactly the four known ones', () => {
    expect(dynamicRegistrations().sort()).toEqual([
      'controlPane.selectCliType${i}',
      'controlPane.selectSidebarTab${i}',
      'editor.foldLevel${n}',
      'workbench.action.openEditorAtIndex${_i}',
    ])
  })

  it('have all of their members in the manifest', () => {
    for (const id of [
      ...Array.from({ length: 9 }, (_, i) => `controlPane.selectCliType${i + 1}`),
      ...Array.from({ length: 6 }, (_, i) => `controlPane.selectSidebarTab${i + 1}`),
      ...Array.from({ length: 7 }, (_, i) => `editor.foldLevel${i + 1}`),
      ...Array.from({ length: 9 }, (_, i) => `workbench.action.openEditorAtIndex${i + 1}`),
    ]) {
      expect(manifest.has(id)).toBe(true)
    }
  })
})

describe('the drift guard actually catches drift', () => {
  it('flags a manifest that is missing a registered command', () => {
    // The victim has to be a literally-registered id: dropping a
    // loop-registered one (which sorts first) would prove nothing, because the
    // literal scan never sees those in the first place. ui.* is filtered the
    // same way the real check filters it — those are absent by design, not drift.
    const scanned = [...literalCommandIds()].filter((id) => !EXTERNAL_ONLY.test(id))
    const [victim] = [...scanned].sort()
    const truncated = new Set(COMMAND_IDS.filter((id) => id !== victim))
    const missing = scanned.filter((id) => !truncated.has(id))
    expect(missing).toEqual([victim])
  })

  it('flags a manifest entry that no longer exists in the source', () => {
    const known = new Set([...literalCommandIds(), ...boundCommandIds()])
    expect(known.has('workbench.action.thisWasDeleted')).toBe(false)
  })
})

// The menu-owned key checks used to live here, back when MENU_OWNED_SPECS held
// only the specs defaults.ts also binds and "is it still bound?" was the only
// thing worth asking. The set is now the whole application menu, so those checks
// moved to menuAccelerators.test.ts, which pins it against src/main/menu.ts.
