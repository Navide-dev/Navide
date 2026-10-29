// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingRule } from '../types'

// Sidebar tabs and Settings were bound to ⌘N / ⌘, only. Off macOS ⌘ is the
// Win/Super key the OS keeps, so the tooltips advertised a key that could not
// work (VM acceptance 0.2.22). Off macOS the sidebar now also answers
// Ctrl+Alt+N (Ctrl+N stays the CLI-type quick-select) and Settings Ctrl+,.

async function load(platform: string) {
  vi.resetModules()
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
  const { defaults, sidebarTabKeySpec, settingsKeySpec } = await import('../defaults')
  const { KeyResolver } = await import('../keyResolver')
  const { formatKeySpec } = await import('../keyDisplay')
  return { defaults, sidebarTabKeySpec, settingsKeySpec, KeyResolver, formatKeySpec }
}

function key(k: string, code: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, code, bubbles: true, ...mods })
}

const ADDED = /^controlPane\.selectSidebarTab[1-5]$|^workbench\.action\.openSettings$/
const keysOf = (rules: KeybindingRule[], re: RegExp) => rules.filter((r) => re.test(r.command)).map((r) => r.key)

afterEach(() => vi.restoreAllMocks())
// Each case re-imports the keybinding modules; the first cold import can be slow.
vi.setConfig({ testTimeout: 30_000 })

describe('macOS keeps its sidebar and Settings keys exactly', () => {
  it('binds the same rules as before: ⌘1..5 and ⌘, only', async () => {
    const { defaults } = await load('MacIntel')
    expect(keysOf(defaults, ADDED)).toEqual(['cmd+,', 'cmd+1', 'cmd+2', 'cmd+3', 'cmd+4', 'cmd+5'])
  })

  it('is the off-macOS table minus the six added rules, nothing else changed', async () => {
    const mac = (await load('MacIntel')).defaults
    const off = (await load('Win32')).defaults
    const added = off.filter((r) => /^ctrl\+alt\+[1-5]$|^ctrl\+,$/.test(r.key) && ADDED.test(r.command))
    expect(added).toHaveLength(6)
    // Plans, Git and the Mini IDE also take Ctrl+Shift off macOS (builtinPluginKeys.test.ts).
    added.push(...off.filter((r) => /^ctrl\+shift\+[dgm]$/.test(r.key)))
    expect(added).toHaveLength(9)
    expect(JSON.stringify(off.filter((r) => !added.includes(r)))).toBe(JSON.stringify(mac))
  })

  it('shows the same tooltip text as before (⌘5, ⌘,)', async () => {
    const { formatKeySpec, sidebarTabKeySpec, settingsKeySpec } = await load('MacIntel')
    expect(formatKeySpec(sidebarTabKeySpec(5))).toBe('⌘5')
    expect(formatKeySpec(settingsKeySpec())).toBe('⌘,')
  })

  it('still lets a physical digit match under Ctrl+Option, as before', async () => {
    const { KeyResolver } = await load('MacIntel')
    const r = new KeyResolver([{ key: 'ctrl+alt+2', command: 'user.rule' }])
    expect(r.resolve(key('™', 'Digit2', { ctrlKey: true, altKey: true }), {})?.command).toBe('user.rule')
  })
})

describe.each(['Win32', 'Linux x86_64'])('off macOS (%s)', (platform) => {
  it('opens sidebar tab N with Ctrl+Alt+N and keeps Ctrl+N for the CLI type', async () => {
    const { defaults, KeyResolver } = await load(platform)
    const r = new KeyResolver(defaults)
    const ctx = { paneStage: true }
    for (const n of [1, 2, 3, 4, 5]) {
      expect(r.resolve(key(String(n), `Digit${n}`, { ctrlKey: true, altKey: true }), ctx)?.command)
        .toBe(`controlPane.selectSidebarTab${n}`)
      expect(r.resolve(key(String(n), `Digit${n}`, { ctrlKey: true }), ctx)?.command)
        .toBe(`controlPane.selectCliType${n}`)
    }
  })

  it('opens Settings with Ctrl+,', async () => {
    const { defaults, KeyResolver } = await load(platform)
    expect(new KeyResolver(defaults).resolve(key(',', 'Comma', { ctrlKey: true }), {})?.command)
      .toBe('workbench.action.openSettings')
  })

  it('leaves an AltGr character to the text it types (German AltGr+2 = ²)', async () => {
    const { defaults, KeyResolver } = await load(platform)
    const r = new KeyResolver(defaults)
    expect(r.resolve(key('²', 'Digit2', { ctrlKey: true, altKey: true }), { paneStage: true })).toBeNull()
    // An IME that hides the key still resolves through the physical digit.
    expect(r.resolve(key('Process', 'Digit2', { ctrlKey: true, altKey: true }), { paneStage: true })?.command)
      .toBe('controlPane.selectSidebarTab2')
  })

  it('shows the key that works in the tooltips', async () => {
    const { formatKeySpec, sidebarTabKeySpec, settingsKeySpec } = await load(platform)
    expect(formatKeySpec(sidebarTabKeySpec(5))).toBe('Ctrl+Alt+5')
    expect(formatKeySpec(settingsKeySpec())).toBe('Ctrl+,')
  })
})
