import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NativeBackendStore } from './pluginNativeBackendStore'

// The global third-party native backend switch: on until the user sets it
// (0.2.31), with the files read and written by 0.2.30 in both directions.
let root: string
let dir: string
const mainFile = (): string => join(dir, 'native-backends.json')
const markerFile = (): string => join(dir, 'native-backends-switch.json')
const readMain = (): Record<string, unknown> => JSON.parse(readFileSync(mainFile(), 'utf8'))
const consent = { binarySha256: 'a'.repeat(64), permissionsKey: '{}', packageVersion: '1.0.0' }

/** What 0.2.30 wrote: its default `enabled: false` on any save, no marker. */
function write0230(enabled: boolean): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(mainFile(), JSON.stringify({ schemaVersion: 1, enabled, plugins: { 'acme.indexer': { consent: { ...consent, grantedAt: '2026-10-20T00:00:00.000Z' } } } }), { mode: 0o600 })
}

/** How 0.2.30 reads the switch, and how it saves: it keeps only the keys it
 * knows, so it never touches (or knows about) the marker file. */
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

describe('NativeBackendStore: the global switch defaults to on', () => {
  it('reads a fresh profile as on, with no notice, and keeps it on after any save', () => {
    const store = new NativeBackendStore(dir)
    expect(store.isEnabled()).toBe(true)
    expect(store.takeDefaultOnNotice()).toBe(false)
    store.grantConsent('acme.indexer', consent)
    expect(readMain().enabled).toBe(true)
    expect(existsSync(markerFile())).toBe(false)
    const reloaded = new NativeBackendStore(dir)
    expect(reloaded.isEnabled()).toBe(true)
    expect(reloaded.takeDefaultOnNotice()).toBe(false)
  })

  it('keeps an explicit off across restarts, without a notice', () => {
    new NativeBackendStore(dir).setEnabled(false)
    const reloaded = new NativeBackendStore(dir)
    expect(reloaded.isEnabled()).toBe(false)
    expect(reloaded.takeDefaultOnNotice()).toBe(false)
    reloaded.grantConsent('acme.indexer', consent)
    expect(new NativeBackendStore(dir).isEnabled()).toBe(false)
  })

  it('keeps an explicit on across restarts, without a notice', () => {
    new NativeBackendStore(dir).setEnabled(true)
    const reloaded = new NativeBackendStore(dir)
    expect(reloaded.isEnabled()).toBe(true)
    expect(reloaded.takeDefaultOnNotice()).toBe(false)
  })

  it('reads an unreadable marker as "set", so the main file decides (fail closed)', () => {
    write0230(false)
    writeFileSync(markerFile(), '{', { mode: 0o600 })
    const store = new NativeBackendStore(dir)
    expect(store.isEnabled()).toBe(false)
    expect(store.takeDefaultOnNotice()).toBe(false)
  })
})

describe('NativeBackendStore: 0.2.30 settings read by 0.2.31', () => {
  it('migrates a 0.2.30 "off" to on and reports it exactly once', () => {
    write0230(false)
    const store = new NativeBackendStore(dir)
    expect(store.isEnabled()).toBe(true)
    // A save before the notice is taken keeps the file as 0.2.30 wrote it.
    store.setWorkspaceWrite('acme.indexer', '/w', true)
    expect(readMain().enabled).toBe(false)
    expect(new NativeBackendStore(dir).takeDefaultOnNotice()).toBe(true)
    expect(existsSync(markerFile())).toBe(true)
    expect(readMain()).toMatchObject({ enabled: true, plugins: { 'acme.indexer': { workspaceWrite: ['/w'] } } })
    const reloaded = new NativeBackendStore(dir)
    expect(reloaded.isEnabled()).toBe(true)
    expect(reloaded.takeDefaultOnNotice()).toBe(false)
  })

  it('takes the notice once per process too', () => {
    write0230(false)
    const store = new NativeBackendStore(dir)
    expect(store.takeDefaultOnNotice()).toBe(true)
    expect(store.takeDefaultOnNotice()).toBe(false)
  })

  it('drops the notice once the user sets the switch first', () => {
    write0230(false)
    const store = new NativeBackendStore(dir)
    store.setEnabled(false)
    expect(store.takeDefaultOnNotice()).toBe(false)
    expect(store.isEnabled()).toBe(false)
    expect(new NativeBackendStore(dir).isEnabled()).toBe(false)
  })

  it('keeps a 0.2.30 "on" on, without a notice, and keeps its consents', () => {
    write0230(true)
    const store = new NativeBackendStore(dir)
    expect(store.isEnabled()).toBe(true)
    expect(store.takeDefaultOnNotice()).toBe(false)
    expect(store.record('acme.indexer').consent).toMatchObject({ packageVersion: '1.0.0' })
  })
})

describe('NativeBackendStore: 0.2.31 settings read by 0.2.30', () => {
  it('writes only the keys 0.2.30 parses into its file, with the switch it should see', () => {
    const store = new NativeBackendStore(dir)
    store.grantConsent('acme.indexer', consent)
    expect(Object.keys(readMain()).sort()).toEqual(['enabled', 'plugins', 'schemaVersion'])
    expect(read0230()).toBe(true)
    store.setEnabled(false)
    expect(read0230()).toBe(false)
    store.setEnabled(true)
    expect(read0230()).toBe(true)
  })

  it('follows a change 0.2.30 made after 0.2.31 set the switch (latest wins)', () => {
    new NativeBackendStore(dir).setEnabled(true)
    save0230(false)
    expect(new NativeBackendStore(dir).isEnabled()).toBe(false)
    save0230(true)
    expect(new NativeBackendStore(dir).isEnabled()).toBe(true)
  })

  it('a 0.2.31 explicit off survives a save by 0.2.30', () => {
    new NativeBackendStore(dir).setEnabled(false)
    save0230(false)
    const reloaded = new NativeBackendStore(dir)
    expect(reloaded.isEnabled()).toBe(false)
    expect(reloaded.takeDefaultOnNotice()).toBe(false)
  })
})
