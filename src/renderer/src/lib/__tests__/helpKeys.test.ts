// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

// The Help pages read their shortcuts from the live bindings, so they show
// what works on this platform and what the user re-bound, not a ⌘ glyph.

async function load(platform: string) {
  vi.resetModules()
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
  const helpKeys = await import('../helpKeys')
  const shared = await import('@navide/plugin-ui/shared')
  return { ...helpKeys, setUserRules: shared.setUserRules }
}

afterEach(() => vi.restoreAllMocks())
vi.setConfig({ testTimeout: 30_000 })

describe('helpKey', () => {
  it('shows the macOS bindings on a Mac', async () => {
    const { helpKey, helpKeySpec } = await load('MacIntel')
    expect(helpKey('workbench.action.openPlans')).toBe('⌘⇧D')
    expect(helpKey('controlPane.selectSidebarTab5')).toBe('⌘5')
    expect(helpKeySpec('mod+o')).toBe('⌘O')
  })

  it('prefers a binding without the Win key off macOS', async () => {
    const { helpKey, helpKeySpec } = await load('Win32')
    expect(helpKey('workbench.action.openPlans')).toBe('Ctrl+Shift+D')
    expect(helpKey('workbench.action.openMiniIDE')).toBe('Ctrl+Shift+M')
    expect(helpKey('controlPane.selectSidebarTab5')).toBe('Ctrl+Alt+5')
    expect(helpKeySpec('mod+o')).toBe('Ctrl+O')
  })

  it('honours the preferred binding when the command still has it', async () => {
    const { helpKey } = await load('MacIntel')
    expect(helpKey('workbench.action.toggleAIChat', 'cmd+j')).toBe('⌘J')
    expect(helpKey('workbench.action.toggleAIChat', 'cmd+shift+a')).toBe('⌘⇧A')
  })

  it('follows a re-bound key and shows a dash once it is unbound', async () => {
    const { helpKey, setUserRules } = await load('MacIntel')
    setUserRules([{ key: 'cmd+shift+d', command: '-workbench.action.openPlans' }])
    expect(helpKey('workbench.action.openPlans')).toBe('—')
    setUserRules([{ key: 'cmd+alt+p', command: 'workbench.action.openPlans' }])
    expect(helpKey('workbench.action.openPlans')).toBe('⌘⌥P')
    setUserRules([])
  })
})
