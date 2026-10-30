// App Lock IPC. Two kinds of caller, checked separately: the Settings page
// (an app window's top frame) manages settings and the PIN; the lock screens
// (main's own WebContentsViews, which isAppWindowSender refuses by design)
// may only read their init data and try to unlock.

import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { AppLockScreenInit } from '../shared/appLock'
import type { AppLockController } from './appLock'
import { UNTRUSTED_SENDER } from './ipcSender'

interface Deps {
  controller: AppLockController
  isAppWindow: (event: IpcMainInvokeEvent) => boolean
  isLockScreen: (event: IpcMainInvokeEvent) => boolean
  /** Settings asked for the status: recheck what can change outside Navide. */
  onStatusRead?: () => void
  screenInit: () => AppLockScreenInit
}

export function registerAppLockIpc(ipc: Pick<IpcMain, 'handle'>, deps: Deps): void {
  const { controller } = deps
  const app = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipc.handle(channel, async (event, ...args: unknown[]) => (deps.isAppWindow(event) ? fn(...args) : UNTRUSTED_SENDER))
  }
  const screen = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipc.handle(channel, async (event, ...args: unknown[]) => (deps.isLockScreen(event) ? fn(...args) : UNTRUSTED_SENDER))
  }

  app('app-lock:status', () => {
    deps.onStatusRead?.()
    return controller.status()
  })
  app('app-lock:update-settings', patch => controller.updateSettings(patch))
  app('app-lock:set-pin', (newPin, currentPin) => controller.setPin(newPin, currentPin))
  app('app-lock:reset-pin-with-system', newPin => controller.resetPinWithSystem(newPin))
  app('app-lock:remove-pin', currentPin => controller.removePin(currentPin))
  app('app-lock:lock-now', () => ({ ok: controller.lock() }))

  screen('app-lock:screen-init', () => deps.screenInit())
  screen('app-lock:unlock-pin', pin => controller.unlockWithPin(pin))
  screen('app-lock:unlock-system', () => controller.unlockWithSystem())
}
