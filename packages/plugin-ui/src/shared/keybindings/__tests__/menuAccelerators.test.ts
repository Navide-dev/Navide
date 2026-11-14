// Drift guard for the application-menu key tables in externalKeys.ts.
//
// The menu lives in the main process (src/main/menu.ts) and its accelerators
// fire before the renderer's dispatcher ever runs, so a rule bound to one of
// them looks changed in Settings and does nothing. externalKeys.ts transcribes
// what the menu owns so the editor can flag those caps — a transcription that
// rots the moment someone edits the menu.
//
// So this rebuilds the expected tables from src/main/menu.ts itself and compares
// both directions: a role added to the menu without an entry here fails, and an
// entry here with no role behind it fails too.
//
// What it CANNOT catch: Electron changing the accelerator that sits behind a
// role. The role names are pinned; the strings they map to are Electron's, and
// an Electron upgrade still needs a manual pass over MENU_ROLE_ACCELERATORS.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MENU_DISPLAY_ONLY_ACCELERATORS,
  MENU_LITERAL_ACCELERATORS,
  MENU_OMITTED_ROLES,
  MENU_ROLE_ACCELERATORS,
  acceleratorToSpec,
  menuOwnedSpecs,
} from '../externalKeys'
import { canonicalizeKeySpec, validateKeySpec } from '../parseKey'

const MENU_SOURCE = join(process.cwd(), 'src/main/menu.ts')
const DEFAULTS_SOURCE = join(process.cwd(), 'packages/plugin-ui/src/shared/keybindings/defaults.ts')

// The menu's own doc comment names roles it deliberately does NOT install
// (`role: 'copy'`, forceReload, the zoom family). Scanning them as real entries
// would invert the very thing this file checks.
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const menuSource = stripComments(readFileSync(MENU_SOURCE, 'utf-8'))

/** Every `role: 'x'` the menu template actually installs. */
function installedRoles(): string[] {
  return [...new Set([...menuSource.matchAll(/role:\s*'([^']+)'/g)].map((m) => m[1]))].sort()
}

/** Every `accelerator: 'x'` the menu writes by hand. */
function literalAccelerators(): string[] {
  return [...new Set([...menuSource.matchAll(/accelerator:\s*'([^']+)'/g)].map((m) => m[1]))].sort()
}

/** Keys `defaults.ts` binds, in canonical form. */
function boundSpecs(): Set<string> {
  const text = stripComments(readFileSync(DEFAULTS_SOURCE, 'utf-8'))
  const found = new Set<string>()
  for (const m of text.matchAll(/key:\s*'([^']+)'/g)) found.add(canonicalizeKeySpec(m[1]))
  return found
}

describe('the menu tables match src/main/menu.ts', () => {
  it('has an entry for every role the menu installs', () => {
    const missing = installedRoles().filter((role) => !(role in MENU_ROLE_ACCELERATORS))
    expect(missing).toEqual([])
  })

  it('has no entry for a role the menu no longer installs', () => {
    const installed = new Set(installedRoles())
    const stale = Object.keys(MENU_ROLE_ACCELERATORS).filter((role) => !installed.has(role))
    expect(stale).toEqual([])
  })

  it('lists exactly the accelerators the menu writes by hand', () => {
    expect(literalAccelerators()).toEqual([...MENU_LITERAL_ACCELERATORS, ...MENU_DISPLAY_ONLY_ACCELERATORS].sort())
  })
})

describe('deliberately omitted roles stay out of the menu', () => {
  // Each of these would silently shadow a renderer binding the user can still
  // see in Settings. menu.ts explains why they are gone; this is what stops
  // someone putting them back without noticing what they take with them.
  it('installs none of them', () => {
    const installed = new Set(installedRoles())
    const resurrected = Object.keys(MENU_OMITTED_ROLES).filter((role) => installed.has(role))
    expect(resurrected).toEqual([])
  })

  it('leaves the keys they would have claimed to the rule table', () => {
    const owned = menuOwnedSpecs(true)
    const bound = boundSpecs()
    for (const [role, accelerator] of Object.entries(MENU_OMITTED_ROLES)) {
      const spec = acceleratorToSpec(accelerator, true)
      expect(owned.has(spec), `${role} (${spec}) must not be menu-owned`).toBe(false)
    }
    // The one that actually carries a shortcut today: Rebuild pane. If this
    // fails, forceReload came back and ⇧⌘R died with it.
    expect(bound.has(acceleratorToSpec(MENU_OMITTED_ROLES.forceReload, true))).toBe(true)
  })
})

describe('MENU_OWNED_SPECS covers the whole menu', () => {
  const mac = menuOwnedSpecs(true)

  it('no longer owns ⌘R — the key this whole table started from', () => {
    // Three states, in order. It was absent while no default bound it, which
    // left a user recording ⌘R onto a row with no warning at all. Then it was
    // present and correct, because the menu really did own it. Now the `reload`
    // role is gone from the menu (⌘R rebuilds the focused pane), so the warning
    // has to stop as well — a stale ⚠ on a key that works is its own bug.
    expect(mac.has('cmd+r')).toBe(false)
    expect(acceleratorToSpec(MENU_OMITTED_ROLES.reload, true)).toBe('cmd+r')
    expect(boundSpecs().has('cmd+r')).toBe(true)
  })

  it('keeps the three specs defaults.ts also binds', () => {
    for (const spec of ['cmd+,', 'cmd+n', 'cmd+o']) expect(mac.has(spec)).toBe(true)
  })

  it('includes the rest of the menu the old set missed', () => {
    for (const spec of ['cmd+q', 'cmd+m', 'cmd+h', 'cmd+c', 'cmd+v', 'cmd+x', 'cmd+z', 'cmd+a']) {
      expect(mac.has(spec)).toBe(true)
    }
  })

  it('leaves cmd+w to the rule table on macOS', () => {
    // The `close` role was dropped from the macOS File menu so that ⌘W reaches
    // closeActiveEditor. It stays in the Window menu off macOS, where Ctrl+W
    // collides with nothing and is the only way to close a window by keyboard.
    expect(mac.has('cmd+w')).toBe(false)
    expect(menuOwnedSpecs(false).has('ctrl+w')).toBe(true)
    expect(boundSpecs().has('cmd+w')).toBe(true)
  })

  it('leaves the replacement window-closing chord alone too', () => {
    // ⌘⇧W took over what the dropped `close` role used to do. It is only worth
    // having on a key no menu accelerator claims on either platform.
    expect(boundSpecs().has('cmd+shift+w')).toBe(true)
    expect(mac.has('cmd+shift+w')).toBe(false)
    expect(menuOwnedSpecs(false).has('cmd+shift+w')).toBe(false)
  })

  it('emits only specs the resolver can parse', () => {
    for (const spec of [...mac, ...menuOwnedSpecs(false)]) {
      expect(validateKeySpec(spec).ok, `${spec} must be a valid key spec`).toBe(true)
      // Canonical form, or `MENU_OWNED_SPECS.has(chip.key)` in the editor would
      // miss the cap it is meant to flag.
      expect(canonicalizeKeySpec(spec)).toBe(spec)
    }
  })
})

describe('the macOS column matches what Electron actually installs', () => {
  // Captured from Electron 33.4.11 with `npx electron scripts/probe-menu-roles.mjs`
  // (MenuItem.getDefaultRoleAccelerator, canonicalised). Three entries in the
  // table disagreed with this before the probe existed: pasteAndMatchStyle was
  // ⇧⌘V rather than ⌥⇧⌘V, redo claimed Ctrl+Y off macOS, and quit claimed no
  // key there at all.
  //
  // A unit test cannot run Electron, so this is a snapshot, not a live check:
  // it guards edits to the table, not an Electron upgrade. Re-run the script
  // after upgrading and update both sides together.
  const PROBED_MAC: Record<string, string | null> = {
    about: null, close: 'cmd+w', cut: 'cmd+x', delete: null, front: null,
    help: null, hide: 'cmd+h', hideOthers: 'cmd+alt+h', minimize: 'cmd+m',
    paste: 'cmd+v', pasteAndMatchStyle: 'cmd+alt+shift+v', quit: 'cmd+q',
    redo: 'cmd+shift+z', reload: 'cmd+r', selectAll: 'cmd+a', services: null,
    toggleDevTools: 'cmd+alt+i', togglefullscreen: 'cmd+ctrl+f', undo: 'cmd+z',
    unhide: null, zoom: null,
  }

  it('agrees with the probe on every role it installs on macOS', () => {
    const mismatched: string[] = []
    for (const [role, entry] of Object.entries(MENU_ROLE_ACCELERATORS)) {
      // `close` is the one role whose macOS column is deliberately null while
      // Electron does have a key for it: menu.ts stops installing it there.
      if (role === 'close') continue
      const ours = entry.mac ? acceleratorToSpec(entry.mac, true) : null
      if (ours !== PROBED_MAC[role]) mismatched.push(`${role}: ours=${ours} probed=${PROBED_MAC[role]}`)
    }
    expect(mismatched).toEqual([])
  })

  it('drops close on macOS even though Electron would bind ⌘W', () => {
    expect(MENU_ROLE_ACCELERATORS.close.mac).toBeNull()
    expect(PROBED_MAC.close).toBe('cmd+w')
  })

  it('agrees with the probe on the omitted roles too', () => {
    expect(acceleratorToSpec(MENU_OMITTED_ROLES.forceReload, true)).toBe('cmd+shift+r')
    expect(acceleratorToSpec(MENU_OMITTED_ROLES.resetZoom, true)).toBe('cmd+0')
  })
})

describe('platform differences survive the transcription', () => {
  const mac = menuOwnedSpecs(true)
  const other = menuOwnedSpecs(false)

  it('maps CmdOrCtrl to the platform modifier', () => {
    // undo, because it is a role the menu still installs on both platforms —
    // reload used to be the example here until it left the menu entirely.
    expect(mac.has('cmd+z')).toBe(true)
    expect(other.has('ctrl+z')).toBe(true)
    expect(other.has('cmd+z')).toBe(false)
  })

  it('keeps the roles that genuinely differ per platform apart', () => {
    // Only these two branch inside Electron. Their `other` values are the one
    // part of the table a macOS probe cannot confirm — see externalKeys.ts.
    expect(mac.has('cmd+ctrl+f')).toBe(true) // togglefullscreen
    expect(other.has('f11')).toBe(true)
    expect(mac.has('cmd+alt+i')).toBe(true) // toggleDevTools
    expect(other.has('ctrl+shift+i')).toBe(true)
  })

  it('carries the cross-platform roles to both', () => {
    // redo and quit read as platform-specific and are not: Electron gives both
    // a single CommandOrControl string. Guessing otherwise put 'ctrl+y' and a
    // missing 'ctrl+q' in this table until the probe was run.
    expect(mac.has('cmd+shift+z')).toBe(true)
    expect(other.has('ctrl+shift+z')).toBe(true)
    expect(other.has('ctrl+y')).toBe(false)
    expect(mac.has('cmd+q')).toBe(true)
    expect(other.has('ctrl+q')).toBe(true)
  })

  it('drops the macOS-only roles off macOS', () => {
    // Not "roles Electron limits to macOS" — roles menu.ts only installs in its
    // isMac arm. pasteAndMatchStyle belongs here for that reason alone.
    for (const spec of ['cmd+h', 'cmd+alt+h', 'cmd+alt+shift+v']) expect(mac.has(spec)).toBe(true)
    for (const spec of ['ctrl+h', 'ctrl+alt+h', 'ctrl+alt+shift+v']) expect(other.has(spec)).toBe(false)
  })
})

describe('defaults.ts does not bind keys the menu eats', () => {
  // Replaces the old "every MENU_OWNED_SPECS entry is bound in defaults" check,
  // which only made sense while the set WAS the overlap. Now the set is the
  // whole menu, the overlap is the interesting part: every spec below is a rule
  // whose key the menu claims first, so each one has to be a deliberate,
  // reviewed decision rather than something that drifted in.
  //
  // macOS only. Off macOS the menu takes Ctrl+… while these rules ask for Cmd+…,
  // so they cannot collide there.
  //
  // Benign — the menu item and the renderer command do the same thing, so the
  // shortcut works either way; only *clearing* the key in Settings fails.
  const AGREES_WITH_MENU = ['cmd+,', 'cmd+n', 'cmd+o']
  // Not benign, and not new: these predate this table, which is how they went
  // unnoticed. The menu's role and the renderer's command are near-synonyms
  // rather than the same action, and the menu wins every time — Chromium's
  // native undo / redo / selectAll roles against the editor's own undo stack
  // and selection model.
  //
  // Listed so the build stays green on the status quo while staying loud about
  // it. Fixing one means dropping the role from menu.ts — as forceReload, the
  // zoom family and (for macOS) `close` already were — or dropping the rule.
  const SHADOWED_BY_MENU = ['cmd+a', 'cmd+shift+z', 'cmd+z']

  it('overlaps the menu only where we already decided it should', () => {
    const overlap = [...boundSpecs()].filter((spec) => menuOwnedSpecs(true).has(spec)).sort()
    expect(overlap).toEqual([...AGREES_WITH_MENU, ...SHADOWED_BY_MENU].sort())
  })
})

describe('the drift guard actually catches drift', () => {
  it('scanned a menu that really has roles and accelerators', () => {
    // Guard the guard: a regex that silently stops matching would make every
    // check above pass by comparing two empty lists.
    expect(installedRoles().length).toBeGreaterThan(10)
    expect(literalAccelerators().length).toBeGreaterThan(0)
  })

  it('flags a role the menu installs with no table entry', () => {
    const truncated = { ...MENU_ROLE_ACCELERATORS }
    const victim = installedRoles()[0]
    delete truncated[victim]
    expect(installedRoles().filter((role) => !(role in truncated))).toEqual([victim])
  })

  it('flags a table entry the menu no longer installs', () => {
    const installed = new Set(installedRoles())
    expect(installed.has('thisRoleWasRemoved')).toBe(false)
  })

  it('ignores roles that appear only in prose', () => {
    // menu.ts names forceReload and the zoom roles in its doc comment to explain
    // why they are absent. If stripComments ever stops working they would scan
    // as installed, and the omission checks above would invert.
    expect(menuSource).not.toMatch(/forceReload/)
    expect(readFileSync(MENU_SOURCE, 'utf-8')).toMatch(/forceReload/)
  })
})
