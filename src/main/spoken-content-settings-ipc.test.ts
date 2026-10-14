import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { registerSpokenContentSettingsIpc, SPOKEN_CONTENT_SETTINGS_URL } from './spoken-content-settings-ipc'

// Settings → Voice → Read aloud sends the user to Spoken Content to download a
// better system voice: an app cannot install one itself. The destination is
// fixed in main — the renderer cannot name a URL — and only an app window may
// ask, the same rule shell:openExternal applies.
function setup(opts: { trusted?: boolean; mac?: boolean; fail?: boolean } = {}) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => Promise<unknown>>()
  const openExternal = vi.fn(async (_url: string) => {
    if (opts.fail) throw new Error('no handler')
  })
  registerSpokenContentSettingsIpc(
    { handle: (channel: string, fn: (event: IpcMainInvokeEvent) => Promise<unknown>) => void handlers.set(channel, fn) } as unknown as Pick<IpcMain, 'handle'>,
    { openExternal, isTrusted: () => opts.trusted ?? true, isMac: () => opts.mac ?? true },
  )
  return { invoke: () => handlers.get('system:open-spoken-content-settings')!({} as IpcMainInvokeEvent), openExternal }
}

describe('system:open-spoken-content-settings', () => {
  it('opens Accessibility › Spoken Content on macOS for an app window', async () => {
    const { invoke, openExternal } = setup()
    await expect(invoke()).resolves.toEqual({ ok: true })
    expect(openExternal).toHaveBeenCalledWith(SPOKEN_CONTENT_SETTINGS_URL)
  })

  it('refuses an untrusted sender without opening anything', async () => {
    const { invoke, openExternal } = setup({ trusted: false })
    expect(await invoke()).toMatchObject({ ok: false })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('does nothing off macOS', async () => {
    const { invoke, openExternal } = setup({ mac: false })
    expect(await invoke()).toMatchObject({ ok: false })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('reports a failure instead of throwing', async () => {
    const { invoke } = setup({ fail: true })
    expect(await invoke()).toMatchObject({ ok: false })
  })
})

describe('SPOKEN_CONTENT_SETTINGS_URL', () => {
  it('names the Accessibility settings extension and its Spoken Content anchor', () => {
    // Verified against macOS 27.2: the extension's bundle id is
    // com.apple.Accessibility-Settings.extension (allowsXAppleSystemPreferencesURLScheme)
    // and "SpokenContent" is the anchor its search extension routes to.
    expect(SPOKEN_CONTENT_SETTINGS_URL).toBe('x-apple.systempreferences:com.apple.Accessibility-Settings.extension?SpokenContent')
  })
})
