// App Lock: a privacy screen over every Navide window. It only hides what is
// on screen — agents, terminals, the backend, chat channels, MCP tools and
// schedules keep running while it is up. Main owns the state and the PIN; the
// Settings page and the lock screen reach it over IPC with these shapes.

export type AppLockUnlockMethod = 'system' | 'pin'

/** Idle choices offered in Settings, in minutes; 0 means never. */
export const APP_LOCK_IDLE_CHOICES = [0, 1, 5, 10, 15, 30, 60] as const

export interface AppLockSettings {
  enabled: boolean
  /** 'system' tries Touch ID first and keeps the PIN as the fallback. */
  unlockMethod: AppLockUnlockMethod
  idleMinutes: number
  lockOnScreenLock: boolean
  lockOnSuspend: boolean
  lockOnStart: boolean
}

export const DEFAULT_APP_LOCK_SETTINGS: AppLockSettings = {
  enabled: false,
  unlockMethod: 'system',
  idleMinutes: 10,
  lockOnScreenLock: true,
  lockOnSuspend: true,
  lockOnStart: false,
}

export interface AppLockStatus {
  settings: AppLockSettings
  hasPin: boolean
  locked: boolean
  /** Touch ID can be offered on this machine. */
  systemUnlockAvailable: boolean
}

export type AppLockError =
  | 'invalid-pin'
  | 'wrong-pin'
  | 'cooldown'
  | 'no-pin'
  | 'system-unavailable'
  | 'system-failed'
  | 'invalid-settings'
  | 'unauthorized sender'

export type AppLockResult = { ok: true } | { ok: false; error: AppLockError; retryAfterMs?: number }

/** A PIN is 4 to 12 digits. */
export function isValidAppLockPin(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{4,12}$/.test(pin)
}

export interface AppLockScreenStrings {
  title: string
  subtitle: string
  pinLabel: string
  unlock: string
  unlockWithSystem: string
  wrongPin: string
  /** Contains `{seconds}`. */
  cooldown: string
  systemFailed: string
  forgotPin: string
}

/** The lock screen is always dark, like the system's own lock screen. */
export const APP_LOCK_BACKGROUND = '#16181d'

export interface AppLockScreenInit {
  strings: AppLockScreenStrings
  systemUnlockAvailable: boolean
  preferSystem: boolean
}

/** The lock screen's preload bridge (`window.navideAppLock`). */
export interface AppLockScreenBridge {
  init(): Promise<AppLockScreenInit>
  unlockWithPin(pin: string): Promise<AppLockResult>
  unlockWithSystem(): Promise<AppLockResult>
}

/** The Settings page's API (`window.agentTeam.appLock`). */
export interface AppLockApi {
  status: () => Promise<AppLockStatus>
  updateSettings: (patch: Partial<AppLockSettings>) => Promise<AppLockResult>
  setPin: (newPin: string, currentPin?: string) => Promise<AppLockResult>
  resetPinWithSystem: (newPin: string) => Promise<AppLockResult>
  removePin: (currentPin: string) => Promise<AppLockResult>
  lockNow: () => Promise<{ ok: boolean }>
  onStatus: (handler: (status: AppLockStatus) => void) => () => void
}
