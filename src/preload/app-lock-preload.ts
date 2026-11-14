import { contextBridge, ipcRenderer } from 'electron'
import type { AppLockScreenBridge } from '../shared/appLock'

const bridge: AppLockScreenBridge = {
  init: () => ipcRenderer.invoke('app-lock:screen-init'),
  unlockWithPin: pin => ipcRenderer.invoke('app-lock:unlock-pin', pin),
  unlockWithSystem: () => ipcRenderer.invoke('app-lock:unlock-system'),
}
contextBridge.exposeInMainWorld('navideAppLock', bridge)
