// Keys the central rule table does not own.
//
// Two families never reach KeyResolver, so they cannot be listed — let alone
// rebound — by the generated editor:
//
//   - terminal keys, which useTerminal intercepts and turns into control
//     sequences before the dispatcher ever sees them
//   - the Electron application menu, whose accelerators fire in the main
//     process ahead of the renderer
//
// They still have to be documented somewhere, so the editor renders them as
// read-only reference sections. Moved here verbatim from the old
// KeyboardShortcutsHelp page, which this replaces.

import { canonicalizeKeySpec, isMacPlatform } from './parseKey'
import { keySpecToTokens } from './keyDisplay'

export interface ExternalKeyRow {
  /** Display glyphs, space-separated; '/' and '–' read as separators. */
  keys: string
  /** i18n key under settings.keybindings.reference.desc */
  desc: string
}

export const TERMINAL_KEYS: ExternalKeyRow[] = [
  { keys: '⇧ Enter', desc: 'newlineNoSend' },
  { keys: '⇧ ← / ⇧ →', desc: 'extendSelection' },
  { keys: '⌘ ⇧ ← / ⌘ ⇧ →', desc: 'selectToLineEdge' },
  { keys: '⌘ ← / ⌘ → / ⌘ Backspace', desc: 'lineNavAndClear' },
  { keys: '⌥ Backspace', desc: 'deleteWord' },
  { keys: '⌘', desc: 'cmdClickHover' },
]

// Accelerators owned by the application menu (src/main/menu.ts). Anything listed
// here fires in the main process before the renderer sees the key, so a binding
// for it in the editable table above would look changed but do nothing.
//
// The three app-defined entries are easy to miss when editing the menu — they
// are not Electron roles, so nothing else points at them: Settings… (menu.ts,
// CmdOrCtrl+,), New Window (CmdOrCtrl+N) and Open Workspace (CmdOrCtrl+O).
export const NATIVE_MENU_KEYS: ExternalKeyRow[] = [
  { keys: '⌘ ,', desc: 'menuSettings' },
  { keys: '⌘ N', desc: 'menuNewWindow' },
  { keys: '⌘ O', desc: 'menuOpenWorkspace' },
  { keys: '⌘ R', desc: 'reload' },
  { keys: '⌥ ⌘ I', desc: 'devTools' },
  { keys: '⌃ ⌘ F', desc: 'fullScreen' },
  { keys: '⌘ C / V / X / Z / A', desc: 'clipboard' },
  { keys: '⌘ Q / ⌘ M', desc: 'windowControls' },
  { keys: '⌘ H / ⌥ ⌘ H', desc: 'hide' },
]

// ── What the application menu owns ────────────────────────────────────────────
//
// Every accelerator below fires in the main process before the renderer sees the
// key, so a rule bound to one of them looks changed in Settings and does
// nothing. The editor flags these caps so that promise is not made silently.
//
// This used to hold only the three specs `defaults.ts` also binds, on the
// reasoning that a key the rule table never claims has nothing to mislabel.
// That holds for the shipped defaults and fails for user overrides: recording
// ⌘R onto any row produces exactly the overlap the marker exists to catch, and
// a set built from the defaults cannot see it. So the set is now the whole menu.

/**
 * Accelerators `src/main/menu.ts` writes itself, in Electron's syntax.
 *
 * Pinned here rather than derived, because they are the entries with nothing
 * else pointing at them: Copy (the app re-implements `role: 'copy'` to read a
 * terminal selection), Settings…, New Window, Open Workspace… and Lock Now.
 */
export const MENU_LITERAL_ACCELERATORS = [
  'CmdOrCtrl+C',
  'CmdOrCtrl+,',
  'CmdOrCtrl+N',
  'CmdOrCtrl+O',
  'CmdOrCtrl+Alt+L',
] as const

/**
 * Every Electron role `src/main/menu.ts` installs, and the accelerator that role
 * carries. `null` means the role ships no accelerator at all — listed anyway, so
 * that a role appearing in the menu with no entry here is a missing transcription
 * rather than a deliberate "no key".
 *
 * Electron owns these strings; nothing in this repo declares them. `menuAccelerators.test.ts`
 * pins the ROLE SET against `src/main/menu.ts`, so a role added or dropped there
 * fails the build. It cannot see Electron changing the accelerator behind a role.
 *
 * The `mac` column was read out of Electron 33.4.11 itself with
 * `scripts/probe-menu-roles.mjs` — three entries here were wrong before it was
 * run. Re-run it after an Electron upgrade, and run it ON Windows or Linux to
 * fill in `other`: MenuItem.getDefaultRoleAccelerator() reports the accelerator
 * for the platform it executes on, so a macOS run cannot see the other arm of
 * the roles that branch (toggleDevTools, togglefullscreen). Those two `other`
 * values are from Electron's documentation and remain unverified.
 */
export const MENU_ROLE_ACCELERATORS: Record<string, { mac: string | null; other: string | null }> = {
  about: { mac: null, other: null },
  // macOS installs no `close` role at all — ⌘W belongs to closeActiveEditor
  // (menu.ts explains it). The role is still in the Window menu off macOS,
  // where Ctrl+W collides with nothing, so this entry cannot simply go away.
  close: { mac: null, other: 'CmdOrCtrl+W' },
  cut: { mac: 'CmdOrCtrl+X', other: 'CmdOrCtrl+X' },
  delete: { mac: null, other: null },
  front: { mac: null, other: null },
  help: { mac: null, other: null },
  hide: { mac: 'Command+H', other: null },
  hideOthers: { mac: 'Command+Alt+H', other: null },
  minimize: { mac: 'CmdOrCtrl+M', other: 'CmdOrCtrl+M' },
  paste: { mac: 'CmdOrCtrl+V', other: 'CmdOrCtrl+V' },
  // ⌥⇧⌘V, not ⇧⌘V — and macOS-only, because menu.ts installs this role in the
  // isMac arm alone.
  pasteAndMatchStyle: { mac: 'Cmd+Option+Shift+V', other: null },
  quit: { mac: 'Command+Q', other: 'CommandOrControl+Q' },
  redo: { mac: 'Shift+CmdOrCtrl+Z', other: 'Shift+CmdOrCtrl+Z' },
  selectAll: { mac: 'CmdOrCtrl+A', other: 'CmdOrCtrl+A' },
  services: { mac: null, other: null },
  toggleDevTools: { mac: 'Alt+Command+I', other: 'Ctrl+Shift+I' },
  togglefullscreen: { mac: 'Control+Command+F', other: 'F11' },
  undo: { mac: 'CmdOrCtrl+Z', other: 'CmdOrCtrl+Z' },
  unhide: { mac: null, other: null },
  zoom: { mac: null, other: null },
}

/**
 * Roles deliberately left out of the menu so the renderer can have their keys,
 * with the binding each one would otherwise shadow.
 *
 * `menu.ts` explains the reasoning; this is the machine-readable half, so that
 * re-adding one of them fails a test instead of silently killing a shortcut the
 * user can still see in Settings.
 */
export const MENU_OMITTED_ROLES: Record<string, string> = {
  // ⇧⌘R — reloadWindow in the rule table (defaults.ts).
  forceReload: 'Shift+CmdOrCtrl+R',
  // ⌘R — rebuildFocusedPane. The View menu keeps a Reload Window item with no
  // accelerator, so reloading survives as a mouse action.
  reload: 'CmdOrCtrl+R',
  // ⌘0 / ⌘+ / ⌘- scale the whole window; zoom here is per-pane content zoom.
  resetZoom: 'CmdOrCtrl+0',
  zoomIn: 'CmdOrCtrl+Plus',
  zoomOut: 'CmdOrCtrl+-',
}

/** Electron accelerator syntax → the canonical spec form the rule table uses. */
export function acceleratorToSpec(accelerator: string, mac: boolean): string {
  const parts = accelerator.split('+').map((raw) => {
    const part = raw.toLowerCase()
    if (part === 'cmdorctrl' || part === 'commandorcontrol') return mac ? 'cmd' : 'ctrl'
    if (part === 'command') return 'cmd'
    if (part === 'control') return 'ctrl'
    if (part === 'option') return 'alt'
    return part
  })
  return canonicalizeKeySpec(parts.join('+'))
}

/**
 * The specs the application menu owns on a given platform.
 *
 * Platform-dependent because several roles differ: redo is ⇧⌘Z on macOS and
 * Ctrl+Y elsewhere, full screen is ⌃⌘F versus F11, and the whole hide/quit
 * family is macOS-only.
 */
export function menuOwnedSpecs(mac: boolean): Set<string> {
  const specs = new Set<string>()
  for (const accelerator of MENU_LITERAL_ACCELERATORS) {
    specs.add(acceleratorToSpec(accelerator, mac))
  }
  for (const role of Object.values(MENU_ROLE_ACCELERATORS)) {
    const accelerator = mac ? role.mac : role.other
    if (accelerator) specs.add(acceleratorToSpec(accelerator, mac))
  }
  return specs
}

export const MENU_OWNED_SPECS = menuOwnedSpecs(isMacPlatform())

/**
 * The "Application menu" reference rows for a platform.
 *
 * NATIVE_MENU_KEYS is the macOS table and is returned as is. Elsewhere the rows
 * are built from the accelerators the menu actually carries there, so Windows
 * and Linux read Ctrl rather than ⌘, and a row whose keys do not exist on the
 * platform (Hide, and Reload, which MENU_OMITTED_ROLES keeps out of the menu)
 * is dropped.
 */
export function nativeMenuKeys(mac = isMacPlatform()): ExternalKeyRow[] {
  if (mac) return NATIVE_MENU_KEYS
  const role = (name: string): string | null => MENU_ROLE_ACCELERATORS[name]?.other ?? null
  const sources: [desc: string, accelerators: (string | null)[]][] = [
    ['menuSettings', ['CmdOrCtrl+,']],
    ['menuNewWindow', ['CmdOrCtrl+N']],
    ['menuOpenWorkspace', ['CmdOrCtrl+O']],
    ['devTools', [role('toggleDevTools')]],
    ['fullScreen', [role('togglefullscreen')]],
    ['clipboard', ['CmdOrCtrl+C', role('paste'), role('cut'), role('undo'), role('selectAll')]],
    ['windowControls', [role('quit'), role('minimize')]],
    ['hide', [role('hide'), role('hideOthers')]],
  ]
  const rows: ExternalKeyRow[] = []
  for (const [desc, accelerators] of sources) {
    const keys = accelerators
      .filter((accelerator): accelerator is string => accelerator !== null)
      .map((accelerator) => keySpecToTokens(acceleratorToSpec(accelerator, false), false)[0].join(' '))
    if (keys.length) rows.push({ keys: keys.join(' / '), desc })
  }
  return rows
}

const SEPARATORS = new Set(['/', '–'])

export interface KeyToken {
  type: 'key' | 'sep'
  value: string
  /** True when this cap follows another cap and needs a '+' between them. */
  plus?: boolean
}

/** Splits a display string like '⌘ ⇧ ← / ⌘ ⇧ →' into caps and separators. */
export function splitKeyTokens(str: string): KeyToken[] {
  const out: KeyToken[] = []
  for (const tok of str.split(/\s+/).filter(Boolean)) {
    if (SEPARATORS.has(tok)) {
      out.push({ type: 'sep', value: tok })
    } else {
      const prev = out[out.length - 1]
      out.push({ type: 'key', value: tok, plus: prev?.type === 'key' })
    }
  }
  return out
}
