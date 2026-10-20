// A2-5 (DESIGN-A2 G5): the Developer Mode settings file is unsigned, so any
// unsandboxed process of the user can write it. Navide keeps an HMAC of what it
// wrote itself; an entry it did not write is disclosed and asked about again,
// never loaded on its own. The key is wrapped by a crypto provider (Electron
// safeStorage in the app); here a reversible fake, so no keychain is touched.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PluginDeveloperModeStore,
  type DeveloperModeExternalChange,
  type DeveloperModeIntegrity,
} from './pluginDeveloperModeStore'

const STORE = '.navide-plugin-developer-mode.json'
const SIGNATURE = '.navide-plugin-developer-mode.sig.json'
const DIGEST = 'a'.repeat(64)

let root = ''
let seen: DeveloperModeExternalChange[]

function integrity(overrides: Partial<DeveloperModeIntegrity> = {}): DeveloperModeIntegrity {
  return {
    available: true,
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (enc) => {
      if (!enc.startsWith('enc:')) throw new Error('cannot decrypt')
      return Buffer.from(enc.slice(4), 'base64').toString('utf8')
    },
    onExternalChange: (change) => seen.push(change),
    ...overrides,
  }
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
  it('keeps what Navide wrote itself: switch, folders and no notice', () => {
    const store = new PluginDeveloperModeStore(root, integrity())
    store.setEnabled(true)
    store.consent(folder('acme.one'))
    const again = new PluginDeveloperModeStore(root, integrity())
    expect(again.isEnabled()).toBe(true)
    expect(again.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(again.untrustedFolders()).toEqual([])
    expect(again.externalChange()).toBeNull()
    expect(seen).toEqual([])
    // The signature is its own file; the store keeps the 0.2.27 shape.
    expect(existsSync(join(root, SIGNATURE))).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(join(root, STORE), 'utf8')))).toEqual(['schemaVersion', 'enabled', 'folders'])
  })

  it('does not turn Developer Mode on, or load a folder, that another program wrote; it discloses once', () => {
    const store = new PluginDeveloperModeStore(root, integrity())
    store.setEnabled(true)
    store.consent(folder('acme.one'))
    store.setEnabled(false)
    writeOutside({ enabled: true, folders: [folder('acme.one'), folder('evil.two')] })

    const after = new PluginDeveloperModeStore(root, integrity())
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
    new PluginDeveloperModeStore(root, integrity()).folders()
    expect(seen).toHaveLength(1)
  })

  it('treats an edited consent (another path for the same id) as not consented', () => {
    const store = new PluginDeveloperModeStore(root, integrity())
    store.setEnabled(true)
    store.consent(folder('acme.one'))
    writeOutside({ enabled: true, folders: [folder('acme.one', '/tmp/elsewhere')] })
    const after = new PluginDeveloperModeStore(root, integrity())
    expect(after.isEnabled()).toBe(true)
    expect(after.folders()).toEqual([])
    expect(after.untrustedFolders().map((f) => f.path)).toEqual(['/tmp/elsewhere'])
    expect(after.externalChange()).not.toBeNull()
  })

  it('is resolved by the user: turning the switch on and consenting again sign them, the notice goes', () => {
    const store = new PluginDeveloperModeStore(root, integrity())
    store.consent(folder('acme.one'))
    writeOutside({ enabled: true, folders: [folder('acme.one'), folder('evil.two')] })
    const after = new PluginDeveloperModeStore(root, integrity())
    expect(after.isEnabled()).toBe(false)
    after.setEnabled(true)
    expect(after.isEnabled()).toBe(true)
    expect(after.untrustedFolders().map((f) => f.pluginId)).toEqual(['evil.two'])
    expect(after.externalChange()).not.toBeNull()
    after.consent(folder('evil.two'))
    expect(after.untrustedFolders()).toEqual([])
    expect(after.folders().map((f) => f.pluginId).sort()).toEqual(['acme.one', 'evil.two'])
    expect(after.externalChange()).toBeNull()
  })

  it('is resolved by removing the folder too, and a consent of one folder does not sign another', () => {
    const store = new PluginDeveloperModeStore(root, integrity())
    store.setEnabled(true)
    writeOutside({ enabled: true, folders: [folder('evil.two'), folder('evil.three')] })
    const after = new PluginDeveloperModeStore(root, integrity())
    after.consent(folder('evil.two'))
    expect(after.untrustedFolders().map((f) => f.pluginId)).toEqual(['evil.three'])
    after.forget('evil.three')
    expect(after.untrustedFolders()).toEqual([])
    expect(after.externalChange()).toBeNull()
  })

  it('asks again, once, about a pre-0.2.28 file with no signature yet (HIGH-1)', () => {
    writeOutside({ enabled: true, folders: [folder('acme.one')] })
    const store = new PluginDeveloperModeStore(root, integrity())
    expect(store.isEnabled()).toBe(false)
    expect(store.folders()).toEqual([])
    expect(store.untrustedFolders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(store.externalChange()).toMatchObject({ reason: 'signature-missing' })
    expect(seen).toHaveLength(1)
    // The user turns it on and consents: signed, notice gone.
    store.setEnabled(true)
    store.consent(store.untrustedFolders()[0]!)
    expect(store.isEnabled()).toBe(true)
    expect(store.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(store.externalChange()).toBeNull()
  })

  it('does not trust entries once the signature file is deleted (HIGH-1)', () => {
    const store = new PluginDeveloperModeStore(root, integrity())
    store.setEnabled(true)
    store.consent(folder('acme.one'))
    writeOutside({ enabled: true, folders: [folder('acme.one'), folder('evil.two')] })
    rmSync(join(root, SIGNATURE))
    const after = new PluginDeveloperModeStore(root, integrity())
    expect(after.isEnabled()).toBe(false)
    expect(after.folders()).toEqual([])
    expect(after.untrustedFolders().map((f) => f.pluginId)).toEqual(['acme.one', 'evil.two'])
    expect(after.externalChange()).not.toBeNull()
  })

  it('asks again for everything when the key cannot be unwrapped (another machine or keychain)', () => {
    const store = new PluginDeveloperModeStore(root, integrity())
    store.setEnabled(true)
    store.consent(folder('acme.one'))
    const sig = JSON.parse(readFileSync(join(root, SIGNATURE), 'utf8')) as Record<string, unknown>
    writeFileSync(join(root, SIGNATURE), JSON.stringify({ ...sig, keyEnc: 'garbage' }))
    const after = new PluginDeveloperModeStore(root, integrity())
    expect(after.isEnabled()).toBe(false)
    expect(after.untrustedFolders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(after.externalChange()).not.toBeNull()
  })

  it('touches no crypto while Developer Mode was never used, and checks nothing without secure storage', () => {
    let calls = 0
    const counting = integrity({
      encrypt: (plain) => { calls += 1; return `enc:${Buffer.from(plain).toString('base64')}` },
      decrypt: (enc) => { calls += 1; return Buffer.from(enc.slice(4), 'base64').toString('utf8') },
    })
    const fresh = new PluginDeveloperModeStore(root, counting)
    expect(fresh.isEnabled()).toBe(false)
    expect(fresh.folders()).toEqual([])
    expect(calls).toBe(0)
    expect(existsSync(join(root, SIGNATURE))).toBe(false)

    writeOutside({ enabled: true, folders: [folder('acme.one')] })
    const unavailable = new PluginDeveloperModeStore(root, integrity({ available: false }))
    expect(unavailable.isEnabled()).toBe(true)
    expect(unavailable.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(unavailable.externalChange()).toBeNull()
  })

  it('never throws when secure storage refuses; the write is kept unsigned, asked about again and disclosed (MED-2)', () => {
    const refusing = integrity({ encrypt: () => { throw new Error('keychain access denied') } })
    const store = new PluginDeveloperModeStore(root, refusing)
    expect(() => store.setEnabled(true)).not.toThrow()
    expect(() => store.consent(folder('acme.one'))).not.toThrow()
    expect(store.isEnabled()).toBe(false)
    expect(store.folders()).toEqual([])
    expect(store.untrustedFolders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(store.externalChange()).toMatchObject({ reason: 'signing-unavailable' })
    expect(JSON.parse(readFileSync(join(root, STORE), 'utf8'))).toMatchObject({ enabled: true, folders: [{ pluginId: 'acme.one' }] })
    expect(seen).toHaveLength(1)

    // A legacy file and a key that cannot be unwrapped: same, no exception.
    rmSync(join(root, SIGNATURE))
    const legacy = new PluginDeveloperModeStore(root, refusing)
    expect(() => legacy.isEnabled()).not.toThrow()
    expect(legacy.isEnabled()).toBe(false)
    const throwingDecrypt = new PluginDeveloperModeStore(root, integrity({ decrypt: () => { throw new Error('locked') } }))
    expect(() => throwingDecrypt.folders()).not.toThrow()
  })

  it("the user's off replaces a switch another program turned on, and the notice goes (LOW-2)", () => {
    const store = new PluginDeveloperModeStore(root, integrity())
    store.setEnabled(true)
    store.setEnabled(false)
    writeOutside({ enabled: true, folders: [] })
    const after = new PluginDeveloperModeStore(root, integrity())
    expect(after.isEnabled()).toBe(false)
    expect(after.externalChange()).not.toBeNull()
    after.setEnabled(false)
    expect(JSON.parse(readFileSync(join(root, STORE), 'utf8'))).toMatchObject({ enabled: false })
    expect(after.externalChange()).toBeNull()
  })

  it('reports an outside change once across the two stores the app keeps (LOW-3)', () => {
    const store = new PluginDeveloperModeStore(root, integrity())
    store.setEnabled(true)
    writeOutside({ enabled: true, folders: [folder('evil.two')] })
    const fromIndex = new PluginDeveloperModeStore(root, integrity())
    const fromIpc = new PluginDeveloperModeStore(root, integrity())
    fromIndex.isEnabled()
    fromIpc.folders()
    fromIndex.untrustedFolders()
    fromIpc.externalChange()
    expect(seen).toHaveLength(1)
  })

  it('behaves exactly as before without an integrity provider', () => {
    writeOutside({ enabled: true, folders: [folder('acme.one')] })
    const plain = new PluginDeveloperModeStore(root)
    expect(plain.isEnabled()).toBe(true)
    expect(plain.folders().map((f) => f.pluginId)).toEqual(['acme.one'])
    expect(plain.untrustedFolders()).toEqual([])
    expect(plain.externalChange()).toBeNull()
    expect(existsSync(join(root, SIGNATURE))).toBe(false)
  })
})
