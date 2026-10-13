import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { registerSpotlightSettingsIpc, SPOTLIGHT_SETTINGS_URL } from './spotlight-settings-ipc'

// Settings → Resource limits offers Spotlight's privacy settings as an opt-in
// action: Navide never edits the exclusion list itself. The destination is
// fixed in main — the renderer cannot name a URL — and only an app window may
// ask, the same rule shell:openExternal applies.
function setup(opts: { trusted?: boolean; mac?: boolean; fail?: boolean } = {}) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent) => Promise<unknown>>()
  const openExternal = vi.fn(async (_url: string) => {
    if (opts.fail) throw new Error('no handler')
  })
  registerSpotlightSettingsIpc(
    { handle: (channel: string, fn: (event: IpcMainInvokeEvent) => Promise<unknown>) => void handlers.set(channel, fn) } as unknown as Pick<IpcMain, 'handle'>,
    { openExternal, isTrusted: () => opts.trusted ?? true, isMac: () => opts.mac ?? true },
  )
  return { invoke: () => handlers.get('system:open-spotlight-settings')!({} as IpcMainInvokeEvent), openExternal }
}

describe('system:open-spotlight-settings', () => {
  it('opens Spotlight settings on macOS for an app window', async () => {
    const { invoke, openExternal } = setup()
    await expect(invoke()).resolves.toEqual({ ok: true })
    expect(openExternal).toHaveBeenCalledWith(SPOTLIGHT_SETTINGS_URL)
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
