import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import { registerAppLockIpc } from './app-lock-ipc'
import type { AppLockController } from './appLock'

// Settings may manage App Lock; the lock screens may only unlock. Each kind
// of caller is refused on the other's channels.
function setup(opts: { app?: boolean; screen?: boolean } = {}) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>()
  const controller = {
    status: vi.fn(() => ({ locked: true })),
    updateSettings: vi.fn(() => ({ ok: true })),
    setPin: vi.fn(async () => ({ ok: true })),
    resetPinWithSystem: vi.fn(async () => ({ ok: true })),
    removePin: vi.fn(async () => ({ ok: true })),
    lock: vi.fn(() => true),
    unlockWithPin: vi.fn(async () => ({ ok: true })),
    unlockWithSystem: vi.fn(async () => ({ ok: true })),
  }
  registerAppLockIpc(
    { handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => void handlers.set(channel, fn) } as unknown as Pick<IpcMain, 'handle'>,
    {
      controller: controller as unknown as AppLockController,
      isAppWindow: () => opts.app ?? false,
      isLockScreen: () => opts.screen ?? false,
      screenInit: () => ({ strings: {} as never, systemUnlockAvailable: false, preferSystem: false }),
    },
  )
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args)
  return { invoke, controller }
}

const SETTINGS_CHANNELS = ['app-lock:status', 'app-lock:update-settings', 'app-lock:set-pin', 'app-lock:reset-pin-with-system', 'app-lock:remove-pin', 'app-lock:lock-now']
const SCREEN_CHANNELS = ['app-lock:screen-init', 'app-lock:unlock-pin', 'app-lock:unlock-system']

describe('app-lock IPC', () => {
  it('lets an app window manage settings and the PIN, but not unlock', async () => {
    const { invoke, controller } = setup({ app: true })
    expect(await invoke('app-lock:set-pin', '5678', '1234')).toEqual({ ok: true })
    expect(controller.setPin).toHaveBeenCalledWith('5678', '1234')
    expect(await invoke('app-lock:lock-now')).toEqual({ ok: true })
    for (const channel of SCREEN_CHANNELS) expect(await invoke(channel, '1234')).toMatchObject({ ok: false, error: 'unauthorized sender' })
    expect(controller.unlockWithPin).not.toHaveBeenCalled()
  })

  it('lets a lock screen unlock, but not touch settings or the PIN', async () => {
    const { invoke, controller } = setup({ screen: true })
    expect(await invoke('app-lock:unlock-pin', '1234')).toEqual({ ok: true })
    expect(controller.unlockWithPin).toHaveBeenCalledWith('1234')
    for (const channel of SETTINGS_CHANNELS) expect(await invoke(channel, '1234')).toMatchObject({ ok: false, error: 'unauthorized sender' })
    expect(controller.removePin).not.toHaveBeenCalled()
    expect(controller.lock).not.toHaveBeenCalled()
  })

  it('refuses everyone else on every channel', async () => {
    const { invoke } = setup()
    for (const channel of [...SETTINGS_CHANNELS, ...SCREEN_CHANNELS]) {
      expect(await invoke(channel)).toMatchObject({ ok: false, error: 'unauthorized sender' })
    }
  })
})
