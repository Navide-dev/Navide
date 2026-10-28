// App Lock state machine. Main is the only owner: it decides when to lock,
// checks the PIN and runs Touch ID. Locking only puts a screen over the
// windows (see appLockOverlay.ts); nothing else in Navide reads this state.

import {
  isValidAppLockPin,
  type AppLockResult,
  type AppLockSettings,
  type AppLockStatus,
} from '../shared/appLock'
import { hashPin, readAppLockDoc, sanitizeSettings, verifyPin, writeAppLockDoc, type AppLockDoc } from './appLockStore'

/** Wrong PINs allowed before a cooldown starts. */
export const APP_LOCK_MAX_ATTEMPTS = 5
export const APP_LOCK_COOLDOWN_MS = 60_000
export const APP_LOCK_MAX_COOLDOWN_MS = 15 * 60_000

export interface AppLockControllerDeps {
  filePath: string
  now: () => number
  /** Seconds since the last keyboard or mouse input anywhere on the machine. */
  systemIdleSeconds: () => number
  canPromptSystem: () => boolean
  /** Resolves when the user passed Touch ID (or its password fallback). */
  promptSystem: () => Promise<void>
  onChange: (status: AppLockStatus) => void
}

export class AppLockController {
  private doc: AppLockDoc
  private locked = false
  private failures = 0
  private cooldowns = 0
  private blockedUntil = 0
  private systemPrompt: Promise<boolean> | null = null

  constructor(private readonly deps: AppLockControllerDeps) {
    this.doc = readAppLockDoc(deps.filePath)
  }

  status(): AppLockStatus {
    return {
      settings: { ...this.doc.settings },
      hasPin: this.doc.pin !== null,
      locked: this.locked,
      systemUnlockAvailable: this.deps.canPromptSystem(),
    }
  }

  isLocked(): boolean {
    return this.locked
  }

  lock(): boolean {
    if (!this.doc.settings.enabled || !this.doc.pin || this.locked) return false
    this.locked = true
    this.emit()
    return true
  }

  handleStart(): void {
    if (this.doc.settings.lockOnStart) this.lock()
  }

  handleScreenLock(): void {
    if (this.doc.settings.lockOnScreenLock) this.lock()
  }

  handleSuspend(): void {
    if (this.doc.settings.lockOnSuspend) this.lock()
  }

  /** Called on a timer: lock once the machine has been idle long enough. */
  tick(): void {
    const minutes = this.doc.settings.idleMinutes
    if (minutes > 0 && this.deps.systemIdleSeconds() >= minutes * 60) this.lock()
  }

  async unlockWithPin(pin: unknown): Promise<AppLockResult> {
    if (!this.locked) return { ok: true }
    const checked = await this.checkPin(pin)
    if (!checked.ok) return checked
    this.unlock()
    return { ok: true }
  }

  async unlockWithSystem(): Promise<AppLockResult> {
    if (!this.locked) return { ok: true }
    if (this.doc.settings.unlockMethod !== 'system' || !this.deps.canPromptSystem()) return { ok: false, error: 'system-unavailable' }
    if (!(await this.promptSystemOnce())) return { ok: false, error: 'system-failed' }
    this.unlock()
    return { ok: true }
  }

  updateSettings(patch: unknown): AppLockResult {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid-settings' }
    const next: AppLockSettings = sanitizeSettings({ ...this.doc.settings, ...(patch as object) })
    if (next.enabled && !this.doc.pin) return { ok: false, error: 'no-pin' }
    this.save({ ...this.doc, settings: next })
    return { ok: true }
  }

  /** Set the first PIN, or change it given the current one. */
  async setPin(newPin: unknown, currentPin?: unknown): Promise<AppLockResult> {
    if (!isValidAppLockPin(newPin)) return { ok: false, error: 'invalid-pin' }
    if (this.doc.pin) {
      const checked = await this.checkPin(currentPin)
      if (!checked.ok) return checked
    }
    this.save({ ...this.doc, pin: await hashPin(newPin) })
    return { ok: true }
  }

  /** Forgot the PIN: Touch ID stands in for the current one. */
  async resetPinWithSystem(newPin: unknown): Promise<AppLockResult> {
    if (!isValidAppLockPin(newPin)) return { ok: false, error: 'invalid-pin' }
    if (!this.deps.canPromptSystem()) return { ok: false, error: 'system-unavailable' }
    if (!(await this.promptSystemOnce())) return { ok: false, error: 'system-failed' }
    this.resetAttempts()
    this.save({ ...this.doc, pin: await hashPin(newPin) })
    return { ok: true }
  }

  /** Removing the PIN turns App Lock off: there is nothing left to unlock with. */
  async removePin(currentPin: unknown): Promise<AppLockResult> {
    if (!this.doc.pin) return { ok: false, error: 'no-pin' }
    const checked = await this.checkPin(currentPin)
    if (!checked.ok) return checked
    this.save({ ...this.doc, pin: null, settings: { ...this.doc.settings, enabled: false } })
    return { ok: true }
  }

  private async checkPin(pin: unknown): Promise<AppLockResult> {
    const now = this.deps.now()
    if (now < this.blockedUntil) return { ok: false, error: 'cooldown', retryAfterMs: this.blockedUntil - now }
    if (!this.doc.pin) return { ok: false, error: 'no-pin' }
    if (isValidAppLockPin(pin) && (await verifyPin(pin, this.doc.pin))) {
      this.resetAttempts()
      return { ok: true }
    }
    this.failures += 1
    if (this.failures >= APP_LOCK_MAX_ATTEMPTS) {
      const wait = Math.min(APP_LOCK_COOLDOWN_MS * 2 ** this.cooldowns, APP_LOCK_MAX_COOLDOWN_MS)
      this.cooldowns += 1
      this.failures = 0
      this.blockedUntil = this.deps.now() + wait
      return { ok: false, error: 'cooldown', retryAfterMs: wait }
    }
    return { ok: false, error: 'wrong-pin' }
  }

  // One system dialog at a time, however many lock screens ask for it.
  private promptSystemOnce(): Promise<boolean> {
    this.systemPrompt ??= this.deps.promptSystem().then(() => true, () => false).finally(() => { this.systemPrompt = null })
    return this.systemPrompt
  }

  private resetAttempts(): void {
    this.failures = 0
    this.cooldowns = 0
    this.blockedUntil = 0
  }

  private unlock(): void {
    this.locked = false
    this.emit()
  }

  private save(doc: AppLockDoc): void {
    writeAppLockDoc(this.deps.filePath, doc)
    this.doc = doc
    this.emit()
  }

  private emit(): void {
    this.deps.onChange(this.status())
  }
}
