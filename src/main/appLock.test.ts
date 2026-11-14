import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppLockStatus } from '../shared/appLock'
import { APP_LOCK_COOLDOWN_MS, APP_LOCK_MAX_ATTEMPTS, AppLockController, type AppLockControllerDeps } from './appLock'
import { APP_LOCK_FILE, hashPin, readAppLockDoc, verifyPin, writeAppLockDoc } from './appLockStore'

// App Lock is a privacy screen: main decides when it goes up and checks the
// PIN or Touch ID before it comes down. Touch ID is always a fake here — no
// test may raise a real system authentication dialog.
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'app-lock-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(over: Partial<AppLockControllerDeps> = {}) {
  let clock = 1_000_000
  let idle = 0
  const changes: AppLockStatus[] = []
  const promptSystem = vi.fn(async () => {})
  const controller = new AppLockController({
    filePath: join(dir, APP_LOCK_FILE),
    now: () => clock,
    systemIdleSeconds: () => idle,
    systemKind: 'touch-id',
    canPromptSystem: () => true,
    promptSystem,
    onChange: (s) => changes.push(s),
    ...over,
  })
  return {
    controller, changes, promptSystem,
    advance: (ms: number) => { clock += ms },
    setIdle: (s: number) => { idle = s },
  }
}

async function enabled(over: Partial<AppLockControllerDeps> = {}) {
  const t = setup(over)
  expect(await t.controller.setPin('1234')).toEqual({ ok: true })
  expect(t.controller.updateSettings({ enabled: true })).toEqual({ ok: true })
  return t
}

describe('appLockStore', () => {
  it('hashes a PIN with scrypt and a fresh salt, and verifies only that PIN', async () => {
    const a = await hashPin('1234')
    const b = await hashPin('1234')
    expect(a.kdf).toBe('scrypt')
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
    expect(await verifyPin('1234', a)).toBe(true)
    expect(await verifyPin('1235', a)).toBe(false)
  })

  it('writes an owner-only file with no PIN in clear', async () => {
    const file = join(dir, APP_LOCK_FILE)
    writeAppLockDoc(file, { v: 1, settings: readAppLockDoc(file).settings, pin: await hashPin('987654') })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf-8')).not.toContain('987654')
  })

  it('reads a missing or broken file as the defaults: off, no PIN', () => {
    const file = join(dir, APP_LOCK_FILE)
    expect(readAppLockDoc(file)).toMatchObject({ pin: null, settings: { enabled: false, lockOnStart: false, idleMinutes: 10 } })
    writeFileSync(file, '{not json')
    expect(readAppLockDoc(file).settings.enabled).toBe(false)
  })

  it('treats a file that lost its PIN as off, and drops unknown or ill-typed settings', () => {
    const file = join(dir, APP_LOCK_FILE)
    writeFileSync(file, JSON.stringify({ v: 1, settings: { enabled: true, idleMinutes: 7, unlockMethod: 'face', extra: 1 }, pin: null }))
    const doc = readAppLockDoc(file)
    expect(doc.settings).toEqual({ enabled: false, unlockMethod: 'system', idleMinutes: 10, lockOnScreenLock: true, lockOnSuspend: true, lockOnStart: false })
  })
})

describe('AppLockController', () => {
  it('cannot be turned on, or lock, without a PIN', () => {
    const { controller } = setup()
    expect(controller.updateSettings({ enabled: true })).toEqual({ ok: false, error: 'no-pin' })
    expect(controller.lock()).toBe(false)
    expect(controller.status()).toMatchObject({ locked: false, hasPin: false })
  })

  it('rejects a PIN that is not 4 to 12 digits', async () => {
    const { controller } = setup()
    for (const pin of ['123', '1234567890123', '12a4', '', 1234]) {
      expect(await controller.setPin(pin)).toEqual({ ok: false, error: 'invalid-pin' })
    }
  })

  it('locks on Lock Now and tells the overlay, then unlocks with the right PIN', async () => {
    const { controller, changes } = await enabled()
    expect(controller.lock()).toBe(true)
    expect(changes.at(-1)).toMatchObject({ locked: true })
    expect(await controller.unlockWithPin('0000')).toEqual({ ok: false, error: 'wrong-pin' })
    expect(controller.isLocked()).toBe(true)
    expect(await controller.unlockWithPin('1234')).toEqual({ ok: true })
    expect(changes.at(-1)).toMatchObject({ locked: false })
  })

  it('locks on start only when asked to (off by default)', async () => {
    const { controller } = await enabled()
    controller.handleStart()
    expect(controller.isLocked()).toBe(false)
    controller.updateSettings({ lockOnStart: true })
    controller.handleStart()
    expect(controller.isLocked()).toBe(true)
  })

  it('locks when the screen locks or the machine sleeps, unless that trigger is off', async () => {
    const { controller } = await enabled()
    controller.handleScreenLock()
    expect(controller.isLocked()).toBe(true)
    await controller.unlockWithPin('1234')
    controller.updateSettings({ lockOnScreenLock: false, lockOnSuspend: false })
    controller.handleScreenLock()
    controller.handleSuspend()
    expect(controller.isLocked()).toBe(false)
    controller.updateSettings({ lockOnSuspend: true })
    controller.handleSuspend()
    expect(controller.isLocked()).toBe(true)
  })

  it('locks after the chosen system idle time, and never when idle is off', async () => {
    const { controller, setIdle } = await enabled()
    setIdle(9 * 60 + 59)
    controller.tick()
    expect(controller.isLocked()).toBe(false)
    setIdle(10 * 60)
    controller.tick()
    expect(controller.isLocked()).toBe(true)
    await controller.unlockWithPin('1234')
    controller.updateSettings({ idleMinutes: 0 })
    setIdle(10 * 60 * 60)
    controller.tick()
    expect(controller.isLocked()).toBe(false)
  })

  it('starts a cooldown after too many wrong PINs, doubling it each time', async () => {
    const { controller, advance } = await enabled()
    controller.lock()
    for (let i = 1; i < APP_LOCK_MAX_ATTEMPTS; i++) expect(await controller.unlockWithPin('0000')).toMatchObject({ error: 'wrong-pin' })
    expect(await controller.unlockWithPin('0000')).toEqual({ ok: false, error: 'cooldown', retryAfterMs: APP_LOCK_COOLDOWN_MS })
    // Even the right PIN waits out the cooldown.
    expect(await controller.unlockWithPin('1234')).toMatchObject({ error: 'cooldown' })
    advance(APP_LOCK_COOLDOWN_MS)
    for (let i = 0; i < APP_LOCK_MAX_ATTEMPTS - 1; i++) await controller.unlockWithPin('0000')
    expect(await controller.unlockWithPin('0000')).toMatchObject({ error: 'cooldown', retryAfterMs: APP_LOCK_COOLDOWN_MS * 2 })
    advance(APP_LOCK_COOLDOWN_MS * 2)
    expect(await controller.unlockWithPin('1234')).toEqual({ ok: true })
  })

  it('unlocks with Touch ID through the injected prompt, one dialog for many lock screens', async () => {
    let pass: () => void = () => {}
    const promptSystem = vi.fn(() => new Promise<void>((resolve) => { pass = resolve }))
    const { controller } = await enabled({ promptSystem })
    controller.lock()
    const a = controller.unlockWithSystem()
    const b = controller.unlockWithSystem()
    pass()
    expect(await a).toEqual({ ok: true })
    expect(await b).toEqual({ ok: true })
    expect(promptSystem).toHaveBeenCalledTimes(1)
    expect(controller.isLocked()).toBe(false)
  })

  it('stays locked when Touch ID fails, is unavailable, or the user chose PIN only', async () => {
    const failing = await enabled({ promptSystem: async () => { throw new Error('cancelled') } })
    failing.controller.lock()
    expect(await failing.controller.unlockWithSystem()).toEqual({ ok: false, error: 'system-failed' })
    expect(failing.controller.isLocked()).toBe(true)

    rmSync(join(dir, APP_LOCK_FILE))
    const none = await enabled({ canPromptSystem: () => false })
    none.controller.lock()
    expect(await none.controller.unlockWithSystem()).toEqual({ ok: false, error: 'system-unavailable' })
    expect(none.promptSystem).not.toHaveBeenCalled()

    none.controller.updateSettings({ unlockMethod: 'pin' })
    expect(await none.controller.unlockWithSystem()).toMatchObject({ ok: false })
  })

  it('reports which system unlock this platform has, null for PIN only', () => {
    expect(setup().controller.status().systemUnlockKind).toBe('touch-id')
    expect(setup({ systemKind: 'windows-hello' }).controller.status().systemUnlockKind).toBe('windows-hello')
    expect(setup({ systemKind: null, canPromptSystem: () => false }).controller.status()).toMatchObject({ systemUnlockKind: null, systemUnlockAvailable: false })
  })

  it('changes the PIN only with the current one', async () => {
    const { controller } = await enabled()
    expect(await controller.setPin('5678')).toEqual({ ok: false, error: 'wrong-pin' })
    expect(await controller.setPin('5678', '0000')).toEqual({ ok: false, error: 'wrong-pin' })
    expect(await controller.setPin('5678', '1234')).toEqual({ ok: true })
    controller.lock()
    expect(await controller.unlockWithPin('1234')).toMatchObject({ error: 'wrong-pin' })
    expect(await controller.unlockWithPin('5678')).toEqual({ ok: true })
  })

  it('resets a forgotten PIN after Touch ID, and not without it', async () => {
    const { controller, promptSystem } = await enabled()
    expect(await controller.resetPinWithSystem('2468')).toEqual({ ok: true })
    expect(promptSystem).toHaveBeenCalledTimes(1)
    controller.lock()
    expect(await controller.unlockWithPin('2468')).toEqual({ ok: true })

    rmSync(join(dir, APP_LOCK_FILE))
    const off = await enabled({ canPromptSystem: () => false })
    expect(await off.controller.resetPinWithSystem('2468')).toEqual({ ok: false, error: 'system-unavailable' })
  })

  it('removing the PIN needs the PIN and turns App Lock off', async () => {
    const { controller } = await enabled()
    expect(await controller.removePin('0000')).toMatchObject({ error: 'wrong-pin' })
    expect(await controller.removePin('1234')).toEqual({ ok: true })
    expect(controller.status()).toMatchObject({ hasPin: false, settings: { enabled: false } })
    expect(controller.lock()).toBe(false)
  })

  it('keeps settings and the PIN across restarts', async () => {
    const first = await enabled()
    first.controller.updateSettings({ idleMinutes: 30, lockOnStart: true })
    const second = setup()
    expect(second.controller.status()).toMatchObject({ hasPin: true, settings: { enabled: true, idleMinutes: 30, lockOnStart: true } })
    second.controller.handleStart()
    expect(await second.controller.unlockWithPin('1234')).toEqual({ ok: true })
  })
})
