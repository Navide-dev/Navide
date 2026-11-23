// A2-5 (DESIGN-A2 G5): the Developer Mode settings file is unsigned, so any
// unsandboxed process of the user can write it. Navide keeps an HMAC of what it
// wrote itself; an entry it did not write is disclosed and asked about again,
// never loaded on its own. The key is wrapped by a crypto provider (Electron
// safeStorage in the app); here a reversible fake, so no keychain is touched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PluginDeveloperModeStore,
  type DeveloperModeExternalChange,
  type DeveloperModeIntegrity,
} from './pluginDeveloperModeStore'
import { safeStorageCrypto } from '../safeStorageCrypto'
import { fakeSafeStorage, legacyCiphertext, type FakeSafeStorage } from '../safeStorageCrypto.fake'

const STORE = '.navide-plugin-developer-mode.json'
const SIGNATURE = '.navide-plugin-developer-mode.sig.json'
const DIGEST = 'a'.repeat(64)

let root = ''
let seen: DeveloperModeExternalChange[]

function integrity(overrides: Partial<DeveloperModeIntegrity> = {}): DeveloperModeIntegrity {
  return {
    available: async () => true,
    encrypt: async (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: async (enc) => {
      if (!enc.startsWith('enc:')) throw new Error('cannot decrypt')
      return Buffer.from(enc.slice(4), 'base64').toString('utf8')
    },
    onExternalChange: (change) => seen.push(change),
    ...overrides,
  }
}

/** A store as the app has it once ready: prepared, so signatures are checked. */
async function opened(provider: DeveloperModeIntegrity): Promise<PluginDeveloperModeStore> {
  const store = new PluginDeveloperModeStore(root, provider)
  await store.prepare()
  return store
}

const folder = (pluginId: string, path = `/dev/${pluginId}`) => ({
  path, pluginId, permissionsDigest: DIGEST, consentedAt: '2026-10-21T01:00:00.000Z',
})

/** What another program on the machine writes: the same shape, no signature. */
function writeOutside(state: { enabled: boolean; folders: ReturnType<typeof folder>[] }): void {
  writeFileSync(join(root, STORE), `${JSON.stringify({ schemaVersion: 1, ...state })}\n`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'navide-devmode-sig-'))
  seen = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('Developer Mode settings changed outside Navide (G5)', () => {
  it('keeps what Navide wrote itself: switch, folders and no notice', async () => {
    const store = await opened(integrity())
    await store.setEnabled(true)
    await store.consent(folder('acme.one'))
    const again = await opened(integrity())
    expect(again.isEnabled()).toBe(true)
    expect(again.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(again.untrustedFolders()).toEqual([])
    expect(again.externalChange()).toBeNull()
    expect(seen).toEqual([])
    // The signature is its own file; the store keeps the 0.2.27 shape.
    expect(existsSync(join(root, SIGNATURE))).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(join(root, STORE), 'utf8')))).toEqual(['schemaVersion', 'enabled', 'folders'])
  })

  it('does not turn Developer Mode on, or load a folder, that another program wrote; it discloses once', async () => {
    const store = await opened(integrity())
    await store.setEnabled(true)
    await store.consent(folder('acme.one'))
    await store.setEnabled(false)
    writeOutside({ enabled: true, folders: [folder('acme.one'), folder('evil.two')] })

    const after = await opened(integrity())
    expect(after.isEnabled()).toBe(false)
    expect(after.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(after.folder('evil.two')).toBeUndefined()
    expect(after.untrustedFolders().map((f) => f.pluginId)).toEqual(['evil.two'])
    expect(after.anyFolder('evil.two')?.path).toBe('/dev/evil.two')
    const change = after.externalChange()
    expect(change?.detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(seen).toEqual([change])
    // Seen once: reading again does not report it again.
    after.isEnabled()
    void (await opened(integrity())).folders()
    expect(seen).toHaveLength(1)
  })

  it('treats an edited consent (another path for the same id) as not consented', async () => {
    const store = await opened(integrity())
    await store.setEnabled(true)
    await store.consent(folder('acme.one'))
    writeOutside({ enabled: true, folders: [folder('acme.one', '/tmp/elsewhere')] })
    const after = await opened(integrity())
    expect(after.isEnabled()).toBe(true)
    expect(after.folders()).toEqual([])
    expect(after.untrustedFolders().map((f) => f.path)).toEqual(['/tmp/elsewhere'])
    expect(after.externalChange()).not.toBeNull()
  })

  it('is resolved by the user: turning the switch on and consenting again sign them, the notice goes', async () => {
    const store = await opened(integrity())
    await store.consent(folder('acme.one'))
    writeOutside({ enabled: true, folders: [folder('acme.one'), folder('evil.two')] })
    const after = await opened(integrity())
    expect(after.isEnabled()).toBe(false)
    await after.setEnabled(true)
    expect(after.isEnabled()).toBe(true)
    expect(after.untrustedFolders().map((f) => f.pluginId)).toEqual(['evil.two'])
    expect(after.externalChange()).not.toBeNull()
    await after.consent(folder('evil.two'))
    expect(after.untrustedFolders()).toEqual([])
    expect(after.folders().map((f) => f.pluginId).sort()).toEqual(['acme.one', 'evil.two'])
    expect(after.externalChange()).toBeNull()
  })

  it('is resolved by removing the folder too, and a consent of one folder does not sign another', async () => {
    const store = await opened(integrity())
    await store.setEnabled(true)
    writeOutside({ enabled: true, folders: [folder('evil.two'), folder('evil.three')] })
    const after = await opened(integrity())
    await after.consent(folder('evil.two'))
    expect(after.untrustedFolders().map((f) => f.pluginId)).toEqual(['evil.three'])
    await after.forget('evil.three')
    expect(after.untrustedFolders()).toEqual([])
    expect(after.externalChange()).toBeNull()
  })

  it('asks again, once, about a pre-0.2.28 file with no signature yet (HIGH-1)', async () => {
    writeOutside({ enabled: true, folders: [folder('acme.one')] })
    const store = await opened(integrity())
    expect(store.isEnabled()).toBe(false)
    expect(store.folders()).toEqual([])
    expect(store.untrustedFolders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(store.externalChange()).toMatchObject({ reason: 'signature-missing' })
    expect(seen).toHaveLength(1)
    // The user turns it on and consents: signed, notice gone.
    await store.setEnabled(true)
    await store.consent(store.untrustedFolders()[0]!)
    expect(store.isEnabled()).toBe(true)
    expect(store.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(store.externalChange()).toBeNull()
  })

  it('does not trust entries once the signature file is deleted (HIGH-1)', async () => {
    const store = await opened(integrity())
    await store.setEnabled(true)
    await store.consent(folder('acme.one'))
    writeOutside({ enabled: true, folders: [folder('acme.one'), folder('evil.two')] })
    rmSync(join(root, SIGNATURE))
    const after = await opened(integrity())
    expect(after.isEnabled()).toBe(false)
    expect(after.folders()).toEqual([])
    expect(after.untrustedFolders().map((f) => f.pluginId)).toEqual(['acme.one', 'evil.two'])
    expect(after.externalChange()).not.toBeNull()
  })

  it('asks again for everything when the key cannot be unwrapped (another machine or keychain)', async () => {
    const store = await opened(integrity())
    await store.setEnabled(true)
    await store.consent(folder('acme.one'))
    const sig = JSON.parse(readFileSync(join(root, SIGNATURE), 'utf8')) as Record<string, unknown>
    writeFileSync(join(root, SIGNATURE), JSON.stringify({ ...sig, keyEnc: 'garbage' }))
    const after = await opened(integrity())
    expect(after.isEnabled()).toBe(false)
    expect(after.untrustedFolders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(after.externalChange()).not.toBeNull()
  })

  it('touches no crypto while Developer Mode was never used, and checks nothing without secure storage', async () => {
    let calls = 0
    const counting = integrity({
      encrypt: async (plain) => { calls += 1; return `enc:${Buffer.from(plain).toString('base64')}` },
      decrypt: async (enc) => { calls += 1; return Buffer.from(enc.slice(4), 'base64').toString('utf8') },
    })
    const fresh = await opened(counting)
    expect(fresh.isEnabled()).toBe(false)
    expect(fresh.folders()).toEqual([])
    expect(calls).toBe(0)
    expect(existsSync(join(root, SIGNATURE))).toBe(false)

    writeOutside({ enabled: true, folders: [folder('acme.one')] })
    const unavailable = await opened(integrity({ available: async () => false }))
    expect(unavailable.isEnabled()).toBe(true)
    expect(unavailable.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(unavailable.externalChange()).toBeNull()
  })

  it('never throws when secure storage refuses; the write is kept unsigned, asked about again and disclosed (MED-2)', async () => {
    const refusing = integrity({ encrypt: async () => { throw new Error('keychain access denied') } })
    const store = await opened(refusing)
    await expect(store.setEnabled(true)).resolves.toBeUndefined()
    await expect(store.consent(folder('acme.one'))).resolves.toBeUndefined()
    expect(store.isEnabled()).toBe(false)
    expect(store.folders()).toEqual([])
    expect(store.untrustedFolders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(store.externalChange()).toMatchObject({ reason: 'signing-unavailable' })
    expect(JSON.parse(readFileSync(join(root, STORE), 'utf8'))).toMatchObject({ enabled: true, folders: [{ pluginId: 'acme.one' }] })
    expect(seen).toHaveLength(1)

    // A legacy file and a key that cannot be unwrapped: same, no exception.
    rmSync(join(root, SIGNATURE))
    const legacy = await opened(refusing)
    expect(() => legacy.isEnabled()).not.toThrow()
    expect(legacy.isEnabled()).toBe(false)
    const throwingDecrypt = await opened(integrity({ decrypt: async () => { throw new Error('locked') } }))
    expect(() => throwingDecrypt.folders()).not.toThrow()
  })

  it("the user's off replaces a switch another program turned on, and the notice goes (LOW-2)", async () => {
    const store = await opened(integrity())
    await store.setEnabled(true)
    await store.setEnabled(false)
    writeOutside({ enabled: true, folders: [] })
    const after = await opened(integrity())
    expect(after.isEnabled()).toBe(false)
    expect(after.externalChange()).not.toBeNull()
    await after.setEnabled(false)
    expect(JSON.parse(readFileSync(join(root, STORE), 'utf8'))).toMatchObject({ enabled: false })
    expect(after.externalChange()).toBeNull()
  })

  it('reports an outside change once across the two stores the app keeps (LOW-3)', async () => {
    const store = await opened(integrity())
    await store.setEnabled(true)
    writeOutside({ enabled: true, folders: [folder('evil.two')] })
    const fromIndex = await opened(integrity())
    const fromIpc = await opened(integrity())
    fromIndex.isEnabled()
    fromIpc.folders()
    fromIndex.untrustedFolders()
    fromIpc.externalChange()
    expect(seen).toHaveLength(1)
  })

  it('behaves exactly as before without an integrity provider', async () => {
    writeOutside({ enabled: true, folders: [folder('acme.one')] })
    const plain = new PluginDeveloperModeStore(root)
    expect(plain.isEnabled()).toBe(true)
    expect(plain.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(plain.untrustedFolders()).toEqual([])
    expect(plain.externalChange()).toBeNull()
    expect(existsSync(join(root, SIGNATURE))).toBe(false)
  })
})

describe('entryMac: the key signs the developer folder record, never leaves the store', () => {
  it('is null without secure storage, and before Navide signed anything', async () => {
    expect(new PluginDeveloperModeStore(root).entryMac('x')).toBeNull()
    expect((await opened(integrity({ available: async () => false }))).entryMac('x')).toBeNull()
    expect((await opened(integrity())).entryMac('x')).toBeNull()
  })

  it('is a stable HMAC per entry once a consent is signed, and differs from every store entry MAC', async () => {
    const store = await opened(integrity())
    await store.consent(folder('acme.one'))
    const mac = store.entryMac('record')
    expect(mac).toMatch(/^[0-9a-f]{64}$/)
    expect((await opened(integrity())).entryMac('record')).toBe(mac)
    expect(store.entryMac('other')).not.toBe(mac)
    const signature = JSON.parse(readFileSync(join(root, SIGNATURE), 'utf8')) as { macs: string[] }
    expect(signature.macs).not.toContain(mac)
  })

  it('is null when the key cannot be unwrapped, and never throws', async () => {
    await (await opened(integrity())).consent(folder('acme.one'))
    const broken = await opened(integrity({ decrypt: async () => { throw new Error('locked') } }))
    expect(broken.entryMac('record')).toBeNull()
  })
})

describe('upgrade from the synchronous safeStorage API (Electron 45)', () => {
  /** The two files as an earlier build left them: its HMAC key wrapped by the
   *  synchronous encryptString, and the entries it wrote signed with it. */
  function writeLegacy(fake: FakeSafeStorage, state: { enabled: boolean; folders: ReturnType<typeof folder>[] }): string {
    const key = randomBytes(32)
    const mac = (entry: string): string => createHmac('sha256', key).update(entry).digest('hex')
    const macs = [
      ...(state.enabled ? [mac(JSON.stringify(['enabled', true]))] : []),
      ...state.folders.map((f) => mac(JSON.stringify(['folder', f.path, f.pluginId, f.permissionsDigest, f.consentedAt]))),
    ]
    writeOutside(state)
    const signature = `${JSON.stringify({ schemaVersion: 1, keyEnc: legacyCiphertext(fake, key.toString('base64')), macs, externalChange: null })}\n`
    writeFileSync(join(root, SIGNATURE), signature)
    return signature
  }

  it('trusts what an earlier build signed, and rewrites neither file', async () => {
    const fake = fakeSafeStorage()
    const signature = writeLegacy(fake, { enabled: true, folders: [folder('acme.one')] })
    const before = readFileSync(join(root, STORE), 'utf8')
    const store = await opened({ ...safeStorageCrypto(fake), onExternalChange: (change) => seen.push(change) })
    expect(store.isEnabled()).toBe(true)
    expect(store.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(store.untrustedFolders()).toEqual([])
    expect(store.externalChange()).toBeNull()
    expect(seen).toEqual([])
    expect(readFileSync(join(root, SIGNATURE), 'utf8')).toBe(signature)
    expect(readFileSync(join(root, STORE), 'utf8')).toBe(before)
  })

  it('keeps signing with the earlier key, so the earlier build still trusts the file', async () => {
    const fake = fakeSafeStorage()
    writeLegacy(fake, { enabled: true, folders: [] })
    const keyEnc = (JSON.parse(readFileSync(join(root, SIGNATURE), 'utf8')) as { keyEnc: string }).keyEnc
    const store = await opened(safeStorageCrypto(fake))
    await store.consent(folder('acme.one'))
    expect((JSON.parse(readFileSync(join(root, SIGNATURE), 'utf8')) as { keyEnc: string }).keyEnc).toBe(keyEnc)
    expect(fake.calls.encrypt).toBe(0)
    expect((await opened(safeStorageCrypto(fake))).folders().map((f) => f.pluginId)).toEqual(['acme.one'])
  })

  it('checks nothing until prepared (as before the app is ready); a write prepares by itself', async () => {
    const provider = integrity()
    writeOutside({ enabled: true, folders: [folder('acme.one')] })
    const unprepared = new PluginDeveloperModeStore(root, provider)
    expect(unprepared.isEnabled()).toBe(true)
    expect(unprepared.externalChange()).toBeNull()
    expect(seen).toEqual([])
    await unprepared.setEnabled(true)
    expect(unprepared.isEnabled()).toBe(true)
    expect(unprepared.untrustedFolders().map((f) => f.pluginId)).toEqual(['acme.one'])
  })

  it('a second store on the same provider checks with the key the first one wrapped (main and IPC)', async () => {
    const provider = integrity()
    const fromIpc = await opened(provider)
    const fromIndex = new PluginDeveloperModeStore(root, provider)
    await fromIpc.setEnabled(true)
    await fromIpc.consent(folder('acme.one'))
    expect(fromIndex.isEnabled()).toBe(true)
    expect(fromIndex.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(fromIndex.externalChange()).toBeNull()
  })
})
