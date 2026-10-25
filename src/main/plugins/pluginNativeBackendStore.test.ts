import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeBackendStore } from './pluginNativeBackendStore'

// The global third-party native backend switch (0.2.31): on for a profile
// with no decision file yet; once the file exists its `enabled` decides, so a
// 0.2.30 "off" stays off. Checked against 0.2.30's own read and save rules in
// both directions.
let root: string
let dir: string
const mainFile = (): string => join(dir, 'native-backends.json')
const readMain = (): Record<string, unknown> => JSON.parse(readFileSync(mainFile(), 'utf8'))
const consent = { binarySha256: 'a'.repeat(64), permissionsKey: '{}', packageVersion: '1.0.0' }

/** A file as 0.2.30 wrote it. */
function write0230(enabled: boolean): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(mainFile(), JSON.stringify({ schemaVersion: 1, enabled, plugins: { 'acme.indexer': { consent: { ...consent, grantedAt: '2026-10-20T00:00:00.000Z' } } } }), { mode: 0o600 })
}

/** How 0.2.30 reads the switch, and how it saves: only the keys it knows. */
function read0230(): boolean {
  return readMain().enabled === true
}
function save0230(enabled: boolean): void {
  const { schemaVersion, plugins } = readMain()
  writeFileSync(mainFile(), JSON.stringify({ schemaVersion, enabled, plugins }), { mode: 0o600 })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-backend-store-')))
  dir = join(root, 'plugin-native-backends')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('NativeBackendStore: the global switch', () => {
  it('is on for a fresh profile (no directory, or no file in it), and stays on after any save', () => {
    expect(new NativeBackendStore(dir).isEnabled()).toBe(true)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const store = new NativeBackendStore(dir)
    expect(store.isEnabled()).toBe(true)
    store.grantConsent('acme.indexer', consent)
    expect(readMain().enabled).toBe(true)
    expect(new NativeBackendStore(dir).isEnabled()).toBe(true)
  })

  it('keeps a value the user set across restarts and later saves', () => {
    new NativeBackendStore(dir).setEnabled(false)
    const off = new NativeBackendStore(dir)
    expect(off.isEnabled()).toBe(false)
    off.grantConsent('acme.indexer', consent)
    expect(new NativeBackendStore(dir).isEnabled()).toBe(false)
    new NativeBackendStore(dir).setEnabled(true)
    expect(new NativeBackendStore(dir).isEnabled()).toBe(true)
  })

  it('reads an unreadable file as off (nothing allowed)', () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(mainFile(), '{"schemaVersion":1,"enabled":true,"plugins":', { mode: 0o600 })
    expect(new NativeBackendStore(dir).isEnabled()).toBe(false)
  })
})

describe('NativeBackendStore: 0.2.30 settings read by 0.2.31', () => {
  it('keeps a 0.2.30 "off" off', () => {
    write0230(false)
    const store = new NativeBackendStore(dir)
    expect(store.isEnabled()).toBe(false)
    store.setWorkspaceWrite('acme.indexer', '/w', true)
    expect(new NativeBackendStore(dir).isEnabled()).toBe(false)
  })

  it('keeps a 0.2.30 "on" on, with its consents', () => {
    write0230(true)
    const store = new NativeBackendStore(dir)
    expect(store.isEnabled()).toBe(true)
    expect(store.record('acme.indexer').consent).toMatchObject({ packageVersion: '1.0.0' })
  })
})

describe('NativeBackendStore: 0.2.31 settings read by 0.2.30', () => {
  it('writes the switch 0.2.30 should see, in a file it parses', () => {
    const store = new NativeBackendStore(dir)
    store.grantConsent('acme.indexer', consent)
    expect(Object.keys(readMain()).sort()).toEqual(['enabled', 'plugins', 'schemaVersion'])
    expect(read0230()).toBe(true)
    store.setEnabled(false)
    expect(read0230()).toBe(false)
    store.setEnabled(true)
    expect(read0230()).toBe(true)
  })

  it('follows a change 0.2.30 made after 0.2.31 saved (latest wins)', () => {
    new NativeBackendStore(dir).setEnabled(true)
    save0230(false)
    expect(new NativeBackendStore(dir).isEnabled()).toBe(false)
    save0230(true)
    expect(new NativeBackendStore(dir).isEnabled()).toBe(true)
  })

  it('keeps the consent-revoked mark readable, and harmless to 0.2.30', () => {
    const store = new NativeBackendStore(dir)
    store.grantConsent('acme.indexer', consent)
    store.forgetGrants('acme.indexer')
    expect(new NativeBackendStore(dir).record('acme.indexer')).toEqual({ consentRevoked: true })
    save0230(true)
    expect(read0230()).toBe(true)
  })
})

describe('NativeBackendStore: a consent taken away is marked', () => {
  it('marks revoke and forgetGrants (with or without a record), keeps disabled, and a new consent clears it', () => {
    const store = new NativeBackendStore(dir)
    store.forgetGrants('never.bound')
    expect(store.record('never.bound')).toEqual({ consentRevoked: true })
    store.grantConsent('acme.indexer', consent)
    store.setDisabled('acme.indexer', true)
    store.forgetGrants('acme.indexer')
    expect(store.record('acme.indexer')).toEqual({ disabled: true, consentRevoked: true })
    store.grantConsent('acme.indexer', consent)
    expect(store.record('acme.indexer')).not.toHaveProperty('consentRevoked')
    store.revokeConsent('acme.indexer')
    expect(store.record('acme.indexer')).toMatchObject({ consentRevoked: true })
    expect(store.record('acme.indexer')).not.toHaveProperty('consent')
    store.forget('acme.indexer')
    expect(store.record('acme.indexer')).toEqual({})
  })
})

describe('NativeBackendStore: install consent (0.2.31)', () => {
  it('records the installed version, clears a revoke, is dropped by revoke, forgetGrants and uninstall, and persists', () => {
    const store = new NativeBackendStore(dir)
    store.revokeConsent('acme.indexer')
    store.noteInstallConsent('acme.indexer', '1.0.0')
    expect(store.record('acme.indexer')).toEqual({ installConsent: { packageVersion: '1.0.0' } })
    expect(new NativeBackendStore(dir).record('acme.indexer')).toEqual({ installConsent: { packageVersion: '1.0.0' } })
    store.revokeConsent('acme.indexer')
    expect(store.record('acme.indexer')).toEqual({ consentRevoked: true })
    store.noteInstallConsent('acme.indexer', '1.0.0')
    store.forgetGrants('acme.indexer')
    expect(store.record('acme.indexer')).toEqual({ consentRevoked: true })
    store.noteInstallConsent('acme.indexer', '1.1.0')
    store.forget('acme.indexer')
    expect(store.record('acme.indexer')).toEqual({})
  })

  it('forgetGrants keeps only the install consent of the replacing version', () => {
    const store = new NativeBackendStore(dir)
    store.noteInstallConsent('acme.indexer', '1.1.0')
    store.grantConsent('acme.indexer', consent)
    store.forgetGrants('acme.indexer', '1.1.0')
    expect(store.record('acme.indexer')).toEqual({ installConsent: { packageVersion: '1.1.0' } })
    store.forgetGrants('acme.indexer', '1.2.0')
    expect(store.record('acme.indexer')).toEqual({ consentRevoked: true })
  })

  it('a 0.2.30 package has no install record', () => {
    write0230(true)
    expect(new NativeBackendStore(dir).record('acme.indexer')).not.toHaveProperty('installConsent')
  })
})
