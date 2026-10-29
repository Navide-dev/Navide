// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

// Open Plans (⌘⇧D), the Git window (⌘⇧G) and the Mini IDE (⌘⇧I) were bound to
// ⌘ only. Off macOS ⌘ is the Win/Super key, so none of them could work on
// Windows or Linux. Off macOS they now also answer Ctrl+Shift+D, Ctrl+Shift+G
// and Ctrl+Shift+M (Ctrl+Shift+I stays the menu's DevTools accelerator).
// Navide Browser (⌘⇧X) answers Ctrl+Shift+X there.

async function load(platform: string) {
  vi.resetModules()
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
  const { defaults } = await import('../defaults')
  const { KeyResolver } = await import('../keyResolver')
  return new KeyResolver(defaults)
}

function key(k: string, code: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, code, bubbles: true, ...mods })
}

afterEach(() => vi.restoreAllMocks())
vi.setConfig({ testTimeout: 30_000 })

describe.each(['Win32', 'Linux x86_64'])('off macOS (%s)', (platform) => {
  it('opens Plans with Ctrl+Shift+D', async () => {
    const r = await load(platform)
    expect(r.resolve(key('D', 'KeyD', { ctrlKey: true, shiftKey: true }), { paneStage: true })?.command)
      .toBe('workbench.action.openPlans')
  })

  it('opens the Git window with Ctrl+Shift+G in the main window, not while find is open', async () => {
    const r = await load(platform)
    const g = () => key('G', 'KeyG', { ctrlKey: true, shiftKey: true })
    expect(r.resolve(g(), { paneStage: true })?.command).toBe('workbench.action.openGitWindow')
    expect(r.resolve(g(), { paneStage: true, findOpen: true })?.command).not.toBe('workbench.action.openGitWindow')
  })

  it('opens the Mini IDE with Ctrl+Shift+M and leaves Ctrl+Shift+I unbound for DevTools', async () => {
    const r = await load(platform)
    expect(r.resolve(key('M', 'KeyM', { ctrlKey: true, shiftKey: true }), { paneStage: true })?.command)
      .toBe('workbench.action.openMiniIDE')
    expect(r.resolve(key('I', 'KeyI', { ctrlKey: true, shiftKey: true }), { paneStage: true })).toBeNull()
  })

  it('opens Navide Browser with Ctrl+Shift+X', async () => {
    const r = await load(platform)
    expect(r.resolve(key('X', 'KeyX', { ctrlKey: true, shiftKey: true }), { paneStage: true })?.command)
      .toBe('workbench.action.openBrowser')
  })
})

describe('macOS', () => {
  it('leaves Ctrl+Shift+D / G / M unbound and keeps ⌘⇧D / ⌘⇧G / ⌘⇧I', async () => {
    const r = await load('MacIntel')
    const ctx = { paneStage: true }
    expect(r.resolve(key('D', 'KeyD', { ctrlKey: true, shiftKey: true }), ctx)).toBeNull()
    expect(r.resolve(key('G', 'KeyG', { ctrlKey: true, shiftKey: true }), ctx)).toBeNull()
    expect(r.resolve(key('M', 'KeyM', { ctrlKey: true, shiftKey: true }), ctx)).toBeNull()
    expect(r.resolve(key('I', 'KeyI', { metaKey: true, shiftKey: true }), ctx)?.command).toBe('workbench.action.openMiniIDE')
    expect(r.resolve(key('D', 'KeyD', { metaKey: true, shiftKey: true }), ctx)?.command).toBe('workbench.action.openPlans')
    expect(r.resolve(key('G', 'KeyG', { metaKey: true, shiftKey: true }), ctx)?.command).toBe('workbench.action.openGitWindow')
  })

  it('opens Navide Browser with ⌘⇧X and leaves Ctrl+Shift+X unbound', async () => {
    const r = await load('MacIntel')
    const ctx = { paneStage: true }
    expect(r.resolve(key('X', 'KeyX', { metaKey: true, shiftKey: true }), ctx)?.command).toBe('workbench.action.openBrowser')
    expect(r.resolve(key('X', 'KeyX', { ctrlKey: true, shiftKey: true }), ctx)).toBeNull()
  })
})
