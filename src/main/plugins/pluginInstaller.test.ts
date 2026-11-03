import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { platformId, setPlatformId } from '../../shared/osplat'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  prepareInstall,
  commitInstall,
  stageInstallCandidate,
  defaultInstallerDeps,
  removePlugin,
  isUpdateAvailable,
  type InstallerDeps,
  type InstallRequest,
  type InstallerTrustConfig,
} from './pluginInstaller'
import { sha256Hex } from './pluginVerify'
import {
  canonicalTrustJson,
  type RegistryPackageEnvelope,
  type RegistryTrustMetadata,
} from './pluginRegistryTrust'
import { REGISTRY_TRUST_SNAPSHOT_NAME } from './pluginInstalledTrust'
import { PLUGIN_QUARANTINE_DIR } from './pluginInstallPaths'
import { PluginActivationSelector, immutablePluginPackageDir } from './pluginActivationSelector'
import { makeZip, type ZipFile } from './zipFixture'

// Many real fsyncs per test that no assertion can observe; see tests/support/noFsync.ts.
vi.mock('node:fs', async (importOriginal) =>
  (await import('../../../tests/support/noFsync')).withoutFsyncSync(await importOriginal()))
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../../../tests/support/noFsync')).withoutHandleSync(await importOriginal()))

// The platform to restore after a test that switched it: whatever this file
// saw when it loaded — the host, or an injection from a vitest setup file.
// Restoring to the host instead silently undid that injection for every
// later test in the file (see src/shared/platformBaseline.test.ts).
const BASELINE = platformId()

const REQ_BASE = {
  registryUrl: 'http://localhost:8787',
  namespace: 'acme',
  name: 'demo',
  version: '1.0.0',
  provenance: 'developer-local-unpacked' as const,
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'acme.demo',
    name: 'Demo',
    version: '1.0.0',
    publisher: 'acme',
    engines: { navide: '^0.1.0' },
    entry: 'dist/main.js',
    requires: ['git'],
    ...overrides,
  })
}

function pkg(files?: ZipFile[]): { bytes: Uint8Array; digest: string } {
  const zip = makeZip(
    files ?? [
      { name: 'manifest.json', data: manifest() },
      { name: 'dist/main.js', data: 'console.log("demo")' },
    ]
  )
  return { bytes: new Uint8Array(zip), digest: sha256Hex(new Uint8Array(zip)) }
}

function manifestV2(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.demo',
    name: 'Demo',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'Demo view', license: 'MIT' },
    contributes: {
      views: [
        {
          id: 'left',
          kind: 'custom',
          location: 'left',
          title: 'Demo',
          entry: 'frontend/left/index.html',
        },
      ],
    },
    ...overrides,
  })
}

function v2Pkg(
  files: ZipFile[] = [
    { name: 'manifest.json', data: manifestV2() },
    { name: 'frontend/left/index.html', data: '<!doctype html>' },
  ]
): { bytes: Uint8Array; digest: string } {
  const zip = makeZip(files)
  return { bytes: new Uint8Array(zip), digest: sha256Hex(new Uint8Array(zip)) }
}

const v2RegistryRoot = generateKeyPairSync('ed25519')
const v2RegistrySigner = generateKeyPairSync('ed25519')
const V2_NOW = new Date('2026-08-16T12:00:00.000Z')
const V2_TRUST_CONFIG: InstallerTrustConfig = {
  pinnedRegistryRootKey: v2RegistryRoot.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString(),
  now: V2_NOW,
}

function signCanonical(value: unknown, privateKey: KeyObject): string {
  return edSign(null, Buffer.from(canonicalTrustJson(value)), privateKey).toString('base64')
}

function signedV2Request(
  digest: string,
  envelopeOverrides: Partial<RegistryPackageEnvelope> = {}
) {
  const envelope: RegistryPackageEnvelope = {
    schemaVersion: 1,
    artifactDigest: digest,
    packageId: 'acme.demo',
    version: '1.0.0',
    target: 'universal',
    publisherId: 'acme',
    keyId: 'registry-2026',
    signedAt: '2026-08-16T11:00:00.000Z',
    ...envelopeOverrides,
  }
  const trustMetadata: RegistryTrustMetadata = {
    schemaVersion: 1,
    registryProfile: 'official',
    rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [
      {
        keyId: 'registry-2026',
        publicKey: v2RegistrySigner.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
        status: 'active',
        notBefore: '2026-08-01T00:00:00.000Z',
        notAfter: '2026-09-01T00:00:00.000Z',
      },
    ],
    blockedPublishers: [],
    blockedPackages: [],
  }
  return {
    ...REQ_BASE,
    provenance: 'official-registry' as const,
    expectedDigest: digest,
    target: envelope.target,
    registryEnvelope: envelope,
    registrySignature: signCanonical(envelope, v2RegistrySigner.privateKey),
    trustMetadata,
    trustMetadataSignature: signCanonical(trustMetadata, v2RegistryRoot.privateKey),
  }
}

/** Deps that serve a fixed package and capture filesystem writes in a map. */
function fakeDeps(bytes: Uint8Array, digestHeader: string | null = 'from-header') {
  const writes = new Map<string, Uint8Array>()
  const removed: string[] = []
  const dirs: string[] = []
  const modes = new Map<string, number>()
  const deps: InstallerDeps = {
    async download() {
      return { bytes, digestHeader }
    },
    mkdirp(dir) {
      dirs.push(dir)
    },
    writeFile(path, data) {
      writes.set(path, data)
    },
    readFile(path) {
      return writes.get(path) ?? null
    },
    writeRegistryTrustSnapshot(root, snapshot) {
      writes.set(
        join(root, REGISTRY_TRUST_SNAPSHOT_NAME),
        new TextEncoder().encode(JSON.stringify(snapshot, null, 2))
      )
    },
    chmod(path, mode) {
      modes.set(path, mode)
    },
    rmrf(dir) {
      removed.push(dir)
    },
  }
  return { deps, writes, removed, dirs, modes }
}

describe('prepareInstall', () => {
  // The archive fixtures are the POSIX package shape (a bare `backend/entry`
  // carrying an exec bit); pinned so the Windows runner checks the same
  // contract, and the `on Windows` block opts into the .exe rule explicitly.
  beforeEach(() => setPlatformId('linux'))
  afterEach(() => setPlatformId(BASELINE))

  it('rejects an install request without explicit provenance', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, digest)
    const request = {
      ...REQ_BASE,
      expectedDigest: digest,
      provenance: undefined,
    } as unknown as InstallRequest

    await expect(prepareInstall(request, deps)).rejects.toThrow(/explicit install provenance/)
  })

  it('verifies and returns manifest + entries for a good package', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(prepared.id).toBe('acme.demo')
    expect(prepared.trustTier).toBe('unsigned')
    expect(prepared.requiresConfirmation).toBe(false)
  })

  it('flags sensitive capabilities for confirmation', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest({ requires: ['fs', 'terminal'] }) },
      { name: 'dist/main.js', data: 'x' },
    ])
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(prepared.sensitive).toEqual(['fs', 'terminal'])
    expect(prepared.requiresConfirmation).toBe(true)
  })

  it('rejects a forged digest (bytes do not match expected)', async () => {
    const { bytes } = pkg()
    const { deps } = fakeDeps(bytes, null)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: 'f'.repeat(64) }, deps)
    ).rejects.toThrow(/digest/)
  })

  it('checks the digest before the zip parser ever reads the bytes', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4])
    const { deps } = fakeDeps(garbage, null)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: 'f'.repeat(64) }, deps)
    ).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
  })

  it('stops reading a Registry download past the size cap instead of buffering it whole', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1
        if (pulled > 300) controller.close()
        else controller.enqueue(chunk)
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200 })))
    try {
      await expect(defaultInstallerDeps.download('https://registry.example.test/x')).rejects.toThrow(/larger than/)
      expect(pulled).toBeLessThan(300)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects when the download header disagrees with expected digest', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, 'a'.repeat(64))
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/header/)
  })

  it('rejects an identity mismatch (manifest id != requested)', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, name: 'other', expectedDigest: digest }, deps)
    ).rejects.toThrow(/identity/)
  })

  it('verifies a valid Ed25519 signature → signed-verified', async () => {
    const { bytes, digest } = pkg()
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const signature = edSign(null, Buffer.from(digest, 'ascii'), privateKey).toString('base64')
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(
      { ...REQ_BASE, expectedDigest: digest, signature, publicKey: pubPem },
      deps
    )
    expect(prepared.trustTier).toBe('signed-verified')
  })

  it('blocks a signed package whose signature does not verify', async () => {
    const { bytes, digest } = pkg()
    const { publicKey } = generateKeyPairSync('ed25519') // key A
    const other = generateKeyPairSync('ed25519') // sign with key B
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const badSig = edSign(null, Buffer.from(digest, 'ascii'), other.privateKey).toString('base64')
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall(
        { ...REQ_BASE, expectedDigest: digest, signature: badSig, publicKey: pubPem },
        deps
      )
    ).rejects.toThrow(/signature/i)
  })

  it('rejects an unknown capability in the package manifest', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest({ requires: ['fs', 'network'] }) },
      { name: 'dist/main.js', data: 'x' },
    ])
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/network/)
  })

  it('accepts a v2 frontend contribution and verifies its entry file', async () => {
    const { bytes, digest } = v2Pkg()
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)
    expect(prepared.manifest.schemaVersion).toBe(2)
    if (prepared.manifest.schemaVersion !== 2) throw new Error('expected Manifest v2')
    expect(prepared.manifest.permissions).toEqual({})
    expect(prepared.requiresConfirmation).toBe(false)
  })

  it('fails closed for a Registry v1 package without central trust evidence', async () => {
    const { bytes, digest } = pkg()
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall(
        { ...REQ_BASE, provenance: 'official-registry', expectedDigest: digest },
        deps,
        V2_TRUST_CONFIG
      )
    ).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' })
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('keeps Registry v1 compatibility only with valid central trust evidence', async () => {
    const { bytes, digest } = pkg()
    const { deps } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)
    expect(prepared.manifest).not.toHaveProperty('schemaVersion')
    expect(prepared.provenance).toBe('official-registry')
    expect(prepared.registryEvidence).toBeDefined()
    expect(prepared.trustTier).toBe('signed-verified')
  })

  it.each([
    ['matching host', 'darwin-arm64', true],
    ['wrong OS', 'linux-arm64', false],
    ['wrong architecture', 'darwin-x64', false],
  ])('checks exact Registry target compatibility: %s', async (_label, target, compatible) => {
    const { bytes, digest } = v2Pkg()
    const { deps } = fakeDeps(bytes, digest)
    const request = signedV2Request(digest, { target })
    const promise = prepareInstall(request, deps, {
      ...V2_TRUST_CONFIG,
      expectedTarget: 'darwin-arm64',
    })
    if (compatible) {
      await expect(promise).resolves.toBeDefined()
    } else {
      await expect(promise).rejects.toThrow(/not compatible with host target/)
    }
  })

  it('rejects an unsigned v2 marketplace package before installation', async () => {
    const { bytes, digest } = v2Pkg()
    const { deps, removed, writes } = fakeDeps(bytes, digest)

    await expect(
      prepareInstall({ ...REQ_BASE, provenance: 'official-registry', expectedDigest: digest }, deps)
    ).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' })
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rejects a signed v2 package whose publisher does not own its id namespace', async () => {
    const { bytes, digest } = v2Pkg([
      { name: 'manifest.json', data: manifestV2({ publisher: 'other' }) },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)

    await expect(prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)).rejects.toThrow(
      /publisher.*namespace/
    )
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rejects a v2 archive whose signed marketplace metadata was modified', async () => {
    const original = v2Pkg()
    const changed = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({ marketplace: { description: 'Changed listing', license: 'MIT' } }),
      },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ])
    const { deps, removed, writes } = fakeDeps(changed.bytes, changed.digest)
    const signedOriginal = signedV2Request(original.digest)
    const changedEnvelope = {
      ...signedOriginal.registryEnvelope,
      artifactDigest: changed.digest,
    }

    await expect(
      prepareInstall(
        {
          ...signedOriginal,
          expectedDigest: changed.digest,
          registryEnvelope: changedEnvelope,
        },
        deps,
        V2_TRUST_CONFIG
      )
    ).rejects.toMatchObject({ code: 'REGISTRY_SIGNATURE_INVALID' })
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rejects a v2 storage permission before installation', async () => {
    const storageBytes = new Uint8Array(
      makeZip([
        { name: 'manifest.json', data: manifestV2({ permissions: { storage: ['write'] } }) },
        { name: 'frontend/left/index.html', data: '<!doctype html>' },
      ])
    )
    const storageDigest = sha256Hex(storageBytes)
    const { deps, removed, writes } = fakeDeps(storageBytes, storageDigest)
    await expect(
      prepareInstall({ ...REQ_BASE, provenance: 'official-registry', expectedDigest: storageDigest }, deps)
    ).rejects.toThrow(/storage/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('requires confirmation for a backend-only v2 package with empty permissions', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)
    expect(prepared.manifest.schemaVersion).toBe(2)
    if (prepared.manifest.schemaVersion !== 2) throw new Error('expected Manifest v2')
    expect(prepared.manifest.permissions).toEqual({})
    expect(prepared.containsBackendExecutable).toBe(true)
    expect(prepared.requiresConfirmation).toBe(true)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('refuses a reserved namespace from an approved self-hosted Registry', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({ id: 'navide.spoof', publisher: 'navide' }),
      },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ])
    const request = signedV2Request(digest, {
      packageId: 'navide.spoof',
      publisherId: 'navide',
    })
    const { deps, removed, writes } = fakeDeps(bytes, digest)

    await expect(
      prepareInstall(
        {
          ...request,
          registryUrl: 'https://registry.acme.test',
          namespace: 'navide',
          name: 'spoof',
        },
        deps,
        {
          ...V2_TRUST_CONFIG,
          registryAuthority: 'self-hosted',
          officialRegistryUrl: 'https://server.navide.dev/registry',
        }
      )
    ).rejects.toThrow(/Official Registry|navide.*namespace/i)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('authorizes a reserved namespace only at the exact Official Registry path', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({ id: 'navide.spoof', publisher: 'navide' }),
      },
      { name: 'frontend/left/index.html', data: '<!doctype html>' },
    ])
    const request = signedV2Request(digest, {
      packageId: 'navide.spoof',
      publisherId: 'navide',
    })
    const officialTrust = {
      ...V2_TRUST_CONFIG,
      registryAuthority: 'official' as const,
      officialRegistryUrl: 'https://server.navide.dev/registry',
    }
    const install = (registryUrl: string) =>
      prepareInstall(
        { ...request, registryUrl, namespace: 'navide', name: 'spoof' },
        fakeDeps(bytes, digest).deps,
        officialTrust
      )

    await expect(install('https://server.navide.dev/registry/')).resolves.toMatchObject({
      id: 'navide.spoof',
    })
    for (const url of [
      'https://server.navide.dev',
      'https://server.navide.dev/registry-evil',
      'https://server.navide.dev/registry/evil',
    ]) {
      await expect(install(url)).rejects.toThrow(/Official Registry/)
    }
  })

  it('rejects a backend entry without archive executable metadata', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)

    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/not marked executable/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  describe('on Windows', () => {
    beforeEach(() => setPlatformId('win32'))
    afterEach(() => setPlatformId(BASELINE))

    it('resolves a bare backend entry to the packaged .exe, exec bit or not', async () => {
      const { bytes, digest } = v2Pkg([
        {
          name: 'manifest.json',
          data: manifestV2({
            contributes: undefined,
            backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
          }),
        },
        { name: 'backend/entry.exe', data: Buffer.from('MZ\0\0') },
      ])
      const { deps } = fakeDeps(bytes, digest)

      const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
      expect(prepared.containsBackendExecutable).toBe(true)
    })

    it('installs a Registry win32-x64 artifact whose backend is the packaged .exe', async () => {
      // The shape `navide-plugin pack --target win32-x64` produces on Windows:
      // a bare manifest entry and an .exe with no POSIX mode.
      const { bytes, digest } = v2Pkg([
        {
          name: 'manifest.json',
          data: manifestV2({
            contributes: undefined,
            backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
          }),
        },
        { name: 'backend/entry.exe', data: Buffer.from('MZ\0\0') },
      ])
      const { deps, writes, modes } = fakeDeps(bytes, digest)

      const prepared = await prepareInstall(signedV2Request(digest, { target: 'win32-x64' }), deps, {
        ...V2_TRUST_CONFIG,
        expectedTarget: 'win32-x64',
      })
      expect(prepared.provenance).toBe('official-registry')
      expect(prepared.containsBackendExecutable).toBe(true)

      commitInstall(prepared, '/plugins', deps)
      const backend = join('/plugins', 'acme.demo', 'backend', 'entry.exe')
      expect(writes.has(backend)).toBe(true)
      expect(modes.get(backend)).toBe(0o700)
    })

    it('rejects a package that ships only the extensionless POSIX binary', async () => {
      const { bytes, digest } = v2Pkg([
        {
          name: 'manifest.json',
          data: manifestV2({
            contributes: undefined,
            backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
          }),
        },
        { name: 'backend/entry', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 },
      ])
      const { deps } = fakeDeps(bytes, digest)

      await expect(
        prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
      ).rejects.toThrow(/referenced file is missing: backend\/entry\.exe/)
    })
  })

  it.each([
    { label: 'shebang', data: Buffer.from('#!/bin/sh\nexit 0\n') },
    { label: 'BOM-prefixed shebang', data: Buffer.from('\ufeff#!/bin/sh\nexit 0\n') },
  ])('rejects an executable extensionless $label script', async ({ data }) => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data, unixMode: 0o100755 },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)

    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/raw script/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rejects an empty executable backend entry', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data: '', unixMode: 0o100755 },
    ])
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/backend entry is empty/)
  })

  it('rejects a v2 package whose contribution entry is absent', async () => {
    const { bytes, digest } = v2Pkg([{ name: 'manifest.json', data: manifestV2() }])
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/referenced file is missing/)
  })

  it('rejects duplicate archive entries before any install side effect', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name: 'dist/main.js', data: 'first' },
      { name: 'dist/main.js', data: 'second' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/duplicate archive entry path/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rejects a non-canonical manifest alias before any install side effect', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      {
        name: './manifest.json',
        data: manifest({ entry: 'evil.html', requires: ['terminal'] }),
      },
      { name: 'dist/main.js', data: 'x' },
      { name: 'evil.html', data: 'blocked' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/unsafe archive entry/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it.each([
    { name: '../escape/', kind: 'directory' as const, message: 'unsafe archive entry' },
    { name: 'link', kind: 'symlink' as const, message: 'regular file or directory' },
    { name: 'device', kind: 'special' as const, message: 'regular file or directory' },
  ])('rejects unsafe $kind entries before any install side effect', async ({ name, kind, message }) => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name, kind, data: '' },
      { name: 'dist/main.js', data: 'x' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(new RegExp(message))
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })
})

describe('commitInstall', () => {
  // The archive fixtures are the POSIX package shape (a bare `backend/entry`
  // carrying an exec bit); pinned so the Windows runner checks the same
  // contract.
  beforeEach(() => setPlatformId('linux'))
  afterEach(() => setPlatformId(BASELINE))

  // Whether a directory can be flushed is a fact about the kernel these tests
  // run on, not about the pinned package platform: a Windows runner refuses a
  // directory fsync, so real-filesystem writes flush under the host's own id.
  function onHostKernel<T>(write: () => T): T {
    const pinned = platformId()
    setPlatformId(BASELINE)
    try {
      return write()
    } finally {
      setPlatformId(pinned)
    }
  }
  const hostInstallerDeps: InstallerDeps = {
    ...defaultInstallerDeps,
    syncDirectory: (path) => onHostKernel(() => defaultInstallerDeps.syncDirectory!(path)),
  }

  it('stages a Registry package into its immutable target directory without replacing the active install', async () => {
    const { bytes, digest } = v2Pkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-candidate-'))
    try {
      const deps: InstallerDeps = {
        ...hostInstallerDeps,
        async download() {
          return { bytes, digestHeader: digest }
        },
      }
      const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)
      const staged = stageInstallCandidate(prepared, root, deps)

      expect(staged.candidateDir).toBe(join(root, 'acme.demo', '1.0.0', 'universal', 'package'))
      expect(staged.descriptor?.packageDir).toBe(staged.candidateDir)
      expect(existsSync(join(root, 'acme.demo', 'manifest.json'))).toBe(false)
      expect(readFileSync(join(staged.candidateDir, 'manifest.json'), 'utf8')).toContain('acme.demo')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('quarantines an unreferenced interrupted candidate before staging a fresh verified candidate', async () => {
    const { bytes, digest } = v2Pkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-candidate-existing-'))
    try {
      const deps: InstallerDeps = {
        ...hostInstallerDeps,
        async download() {
          return { bytes, digestHeader: digest }
        },
      }
      const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)
      stageInstallCandidate(prepared, root, deps)
      const restaged = stageInstallCandidate(prepared, root, deps)
      expect(existsSync(restaged.candidateDir)).toBe(true)
      expect(
        readdirSync(join(root, PLUGIN_QUARANTINE_DIR)).some((entry) => entry.startsWith('acme.demo.unreferenced.'))
      ).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves the retained active package and selector untouched when the staging durability boundary fails', async () => {
    const { bytes, digest } = v2Pkg()
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-stage-fsync-'))
    try {
      const active = {
        packageVersion: '0.9.0',
        target: 'universal',
        artifactDigest: 'a'.repeat(64),
      }
      const activeDir = immutablePluginPackageDir(root, 'acme.demo', active.packageVersion, active.target)
      mkdirSync(activeDir, { recursive: true })
      writeFileSync(join(activeDir, 'retained.txt'), 'keep')
      const selector = new PluginActivationSelector(root)
      onHostKernel(() => {
        selector.stageCandidate('acme.demo', active)
        selector.activateCandidate('acme.demo')
        selector.completeActivation('acme.demo')
      })
      const deps: InstallerDeps = {
        ...hostInstallerDeps,
        async download() {
          return { bytes, digestHeader: digest }
        },
        syncDirectory() {
          throw new Error('injected staging fsync failure')
        },
      }
      const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)

      expect(() => stageInstallCandidate(prepared, root, deps)).toThrow(/injected staging fsync failure/)
      expect(readFileSync(join(activeDir, 'retained.txt'), 'utf8')).toBe('keep')
      expect(selector.read('acme.demo')).toMatchObject({ active })
      expect(existsSync(immutablePluginPackageDir(root, 'acme.demo', prepared.version, 'universal'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes a backend-only package without creating a frontend descriptor', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 },
    ])
    const { deps, writes, modes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)

    expect(commitInstall(prepared, '/plugins', deps)).toBeUndefined()
    expect(writes.has(join('/plugins', 'acme.demo', 'backend', 'entry'))).toBe(true)
    expect(modes.get(join('/plugins', 'acme.demo', 'backend', 'entry'))).toBe(0o700)
  })

  if (process.platform === 'darwin' || process.platform === 'linux') {
    it('installs a backend entry that can be spawned directly', async () => {
      const executablePath = process.platform === 'darwin' ? '/usr/bin/true' : '/bin/true'
      const { bytes, digest } = v2Pkg([
        {
          name: 'manifest.json',
          data: manifestV2({
            contributes: undefined,
            backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
          }),
        },
        {
          name: 'backend/entry',
          data: readFileSync(executablePath),
          unixMode: 0o100755,
        },
      ])
      const deps: InstallerDeps = {
        ...defaultInstallerDeps,
        async download() {
          return { bytes, digestHeader: digest }
        },
      }
      const root = mkdtempSync(join(tmpdir(), 'navide-plugin-install-'))
      try {
        const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)
        commitInstall(prepared, root, deps)
        const installed = join(root, 'acme.demo', 'backend', 'entry')
        expect(statSync(installed).mode & 0o777).toBe(0o700)
        const spawned = spawnSync(installed)
        expect(spawned.error).toBeUndefined()
        expect(spawned.status).toBe(0)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it('creates directory entries without writing directory bytes', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name: 'dist/', kind: 'directory', data: '' },
      { name: 'dist/main.js', data: 'x' },
    ])
    const { deps, dirs, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    commitInstall(prepared, '/plugins', deps)
    expect(dirs).toContain(join('/plugins', 'acme.demo', 'dist'))
    expect(writes.has(join('/plugins', 'acme.demo', 'dist', ''))).toBe(false)
  })

  it('writes verified entries under <root>/<id> and returns a descriptor', async () => {
    const { bytes, digest } = pkg()
    const { deps, writes, removed } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    const desc = commitInstall(prepared, '/plugins', deps)
    if (!desc) throw new Error('expected frontend descriptor')
    expect(removed).toContain(join('/plugins', 'acme.demo'))
    expect([...writes.keys()].sort()).toEqual([
      join('/plugins', 'acme.demo', 'dist', 'main.js'),
      join('/plugins', 'acme.demo', 'manifest.json'),
    ])
    expect(desc.entryFile).toBe(join('/plugins', 'acme.demo', 'dist', 'main.js'))
  })

  it('returns all v2 view contributions from a committed package', async () => {
    const { bytes, digest } = v2Pkg()
    const { deps, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)
    const desc = commitInstall(prepared, '/plugins', deps)
    if (!desc) throw new Error('expected frontend descriptor')
    expect(desc.views).toEqual([
      expect.objectContaining({
        contributionKey: 'acme.demo.left',
        location: 'left',
        entryFile: join('/plugins', 'acme.demo', 'frontend', 'left', 'index.html'),
      }),
    ])
    expect(writes.has(join('/plugins', 'acme.demo', 'frontend', 'left', 'index.html'))).toBe(true)
    expect(writes.has(join('/plugins', 'acme.demo', '.navide-package.zip'))).toBe(true)
    expect(writes.has(join('/plugins', 'acme.demo', '.navide-registry-receipt.json'))).toBe(true)
    expect(writes.has(join('/plugins', '.navide-registry-trust.json'))).toBe(true)
    expect(writes.has(join('/plugins', 'acme.demo', '.navide-receipt.json'))).toBe(false)
  })

  it('persists a valid Registry trust snapshot through the atomic writer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-install-trust-'))
    try {
      const { bytes, digest } = v2Pkg()
      const deps: InstallerDeps = {
        ...defaultInstallerDeps,
        async download() {
          return { bytes, digestHeader: digest }
        },
      }
      const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)

      commitInstall(prepared, root, deps)

      const snapshotPath = join(root, REGISTRY_TRUST_SNAPSHOT_NAME)
      expect(JSON.parse(readFileSync(snapshotPath, 'utf8'))).toEqual(
        prepared.registryEvidence?.trustSnapshot
      )
      expect(existsSync(`${snapshotPath}.tmp`)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps only one explicit previous package after successful updates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-previous-retention-'))
    const install = async (content: string): Promise<void> => {
      const { bytes, digest } = pkg([
        { name: 'manifest.json', data: manifest() },
        { name: 'dist/main.js', data: content },
      ])
      const deps: InstallerDeps = {
        ...defaultInstallerDeps,
        async download() {
          return { bytes, digestHeader: digest }
        },
      }
      const prepared = await prepareInstall(
        { ...REQ_BASE, expectedDigest: digest },
        deps
      )
      commitInstall(prepared, root, deps)
    }

    try {
      await install('first')
      await install('second')
      await install('third')

      expect(readFileSync(join(root, 'acme.demo', 'dist/main.js'), 'utf8')).toBe('third')
      expect(readdirSync(join(root, PLUGIN_QUARANTINE_DIR))).toEqual([
        'acme.demo.previous',
      ])
      expect(
        readFileSync(
          join(root, PLUGIN_QUARANTINE_DIR, 'acme.demo.previous', 'dist/main.js'),
          'utf8'
        )
      ).toBe('second')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps rejected package evidence separate from the normal previous package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-rejected-evidence-'))
    const { bytes, digest } = v2Pkg()
    const initialDeps: InstallerDeps = {
      ...defaultInstallerDeps,
      async download() {
        return { bytes, digestHeader: digest }
      },
    }

    try {
      const initial = await prepareInstall(
        signedV2Request(digest),
        initialDeps,
        V2_TRUST_CONFIG
      )
      commitInstall(initial, root, initialDeps)

      const rejectedDeps: InstallerDeps = {
        ...initialDeps,
        writeRegistryTrustSnapshot() {
          throw new Error('test rejected package')
        },
      }
      const replacement = await prepareInstall(
        signedV2Request(digest),
        rejectedDeps,
        V2_TRUST_CONFIG
      )
      expect(() => commitInstall(replacement, root, rejectedDeps)).toThrow(
        'test rejected package'
      )

      const quarantineEntries = readdirSync(join(root, PLUGIN_QUARANTINE_DIR))
      expect(quarantineEntries.some((entry) => entry.startsWith('acme.demo.failed.'))).toBe(true)
      expect(quarantineEntries).not.toContain('acme.demo.previous')
      expect(existsSync(join(root, 'acme.demo', 'manifest.json'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a replayed older trust snapshot before replacing an install', async () => {
    const { bytes, digest } = v2Pkg()
    const { deps, writes, removed } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)
    writes.set(
      join('/plugins', '.navide-registry-trust.json'),
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          metadata: {
            ...prepared.registryEvidence!.trustSnapshot.metadata,
            generatedAt: '2026-08-16T11:00:00.000Z',
          },
          metadataSignature: 'previously-verified',
        })
      )
    )

    expect(() => commitInstall(prepared, '/plugins', deps)).toThrow(/older snapshot/)
    expect(removed).toEqual([])
  })

  it('refuses a zip-slip entry before any install side effect', async () => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name: '../evil.js', data: 'pwned' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    ).rejects.toThrow(/unsafe archive entry/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rechecks archive paths before removing an existing install', async () => {
    const { bytes, digest } = pkg()
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    prepared.entries.push({
      path: './manifest.json',
      data: Buffer.from('blocked'),
      kind: 'file',
      type: 'regular',
      executable: false,
    })

    expect(() => commitInstall(prepared, '/plugins', deps)).toThrow(/unsafe archive entry/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })

  it('rechecks backend executable metadata before replacing an install', async () => {
    const { bytes, digest } = v2Pkg([
      {
        name: 'manifest.json',
        data: manifestV2({
          contributes: undefined,
          backend: { entry: 'backend/entry', protocolVersion: 1, activation: 'startup' },
        }),
      },
      { name: 'backend/entry', data: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), unixMode: 0o100755 },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(signedV2Request(digest), deps, V2_TRUST_CONFIG)
    const backend = prepared.entries.find((entry) => entry.path === 'backend/entry')
    if (!backend) throw new Error('expected backend entry')
    backend.executable = false

    expect(() => commitInstall(prepared, '/plugins', deps)).toThrow(/not marked executable/)
    expect(removed).toEqual([])
    expect(writes.size).toBe(0)
  })
})

describe('official (navide.) install policy', () => {
  const REQ_OFFICIAL = {
    registryUrl: 'http://localhost:8787',
    namespace: 'navide',
    name: 'mini-ide',
    version: '1.0.0',
    provenance: 'developer-local-unpacked' as const,
  }

  function officialPkg(): { bytes: Uint8Array; digest: string } {
    return pkg([
      {
        name: 'manifest.json',
        data: manifest({ id: 'navide.mini-ide', name: 'Mini IDE', publisher: 'navide', entry: 'index.html' }),
      },
      { name: 'index.html', data: '<!doctype html>' },
    ])
  }

  function pem(key: KeyObject): string {
    return key.export({ type: 'spki', format: 'pem' }).toString()
  }

  function signWith(privateKey: KeyObject, digest: string): string {
    return edSign(null, Buffer.from(digest, 'ascii'), privateKey).toString('base64')
  }

  const official = generateKeyPairSync('ed25519')
  const rogue = generateKeyPairSync('ed25519')
  let envBefore: string | undefined

  beforeEach(() => {
    envBefore = process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY'] = pem(official.publicKey)
  })

  afterEach(() => {
    if (envBefore === undefined) delete process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    else process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY'] = envBefore
  })

  it('allows a navide. package signed by the pinned official key and writes a receipt', async () => {
    const { bytes, digest } = officialPkg()
    const { deps, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall(
      {
        ...REQ_OFFICIAL,
        expectedDigest: digest,
        signature: signWith(official.privateKey, digest),
        publicKey: pem(official.publicKey),
      },
      deps
    )
    expect(prepared.official).toBe(true)
    expect(prepared.trustTier).toBe('signed-verified')

    commitInstall(prepared, '/plugins', deps)
    const receiptRaw = writes.get(join('/plugins', 'navide.mini-ide', '.navide-receipt.json'))
    expect(receiptRaw).toBeDefined()
    const receipt = JSON.parse(Buffer.from(receiptRaw!).toString('utf8'))
    expect(receipt).toMatchObject({ id: 'navide.mini-ide', version: '1.0.0', digest })
    expect(typeof receipt.signature).toBe('string')
  })

  it('rejects a navide. package signed by a non-official key', async () => {
    const { bytes, digest } = officialPkg()
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall(
        {
          ...REQ_OFFICIAL,
          expectedDigest: digest,
          signature: signWith(rogue.privateKey, digest),
          publicKey: pem(rogue.publicKey),
        },
        deps
      )
    ).rejects.toThrow(/official/)
  })

  it('rejects an unsigned navide. package', async () => {
    const { bytes, digest } = officialPkg()
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall({ ...REQ_OFFICIAL, expectedDigest: digest }, deps)
    ).rejects.toThrow(/official/)
  })

  // Without an override the pin is the shipped constant, so this test key is
  // rejected for mismatching it rather than for there being no pin at all —
  // which is what proves the constant is actually in force.
  it('rejects a navide. package signed by anything but the shipped pin', async () => {
    delete process.env['AGENT_TEAM_OFFICIAL_PLUGIN_KEY']
    const { bytes, digest } = officialPkg()
    const { deps } = fakeDeps(bytes, digest)
    await expect(
      prepareInstall(
        {
          ...REQ_OFFICIAL,
          expectedDigest: digest,
          signature: signWith(official.privateKey, digest),
          publicKey: pem(official.publicKey),
        },
        deps
      )
    ).rejects.toThrow(/not signed by the pinned official publisher key/)
  })

  it('does not write a receipt for a third-party install', async () => {
    const { bytes, digest } = pkg()
    const { deps, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(prepared.official).toBe(false)
    commitInstall(prepared, '/plugins', deps)
    expect([...writes.keys()].some((p) => p.endsWith('.navide-receipt.json'))).toBe(false)
  })

  it.each([
    '.navide-receipt.json',
    '.navide-registry-receipt.json',
    '.navide-package.zip',
    '.navide-registry-trust.json',
    '.navide-backend-activation.json',
  ])('refuses a package that smuggles Host-owned %s', async (hostOwnedName) => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name: 'dist/main.js', data: 'x' },
      { name: hostOwnedName, data: '{}' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(() => commitInstall(prepared, '/plugins', deps)).toThrow(/must not contain/)
    expect(removed).toEqual([])
    expect(writes).toEqual(new Map())
  })

  it.each([
    '.NAVIDE-RECEIPT.JSON',
    '.NAVIDE-REGISTRY-RECEIPT.JSON',
    '.NAVIDE-PACKAGE.ZIP',
    '.NAVIDE-REGISTRY-TRUST.JSON',
    '.NAVIDE-BACKEND-ACTIVATION.JSON',
  ])('refuses a case-folded Host-owned filename %s', async (hostOwnedName) => {
    const { bytes, digest } = pkg([
      { name: 'manifest.json', data: manifest() },
      { name: 'dist/main.js', data: 'x' },
      { name: hostOwnedName, data: '{}' },
    ])
    const { deps, removed, writes } = fakeDeps(bytes, digest)
    const prepared = await prepareInstall({ ...REQ_BASE, expectedDigest: digest }, deps)
    expect(() => commitInstall(prepared, '/plugins', deps)).toThrow(/must not contain/)
    expect(removed).toEqual([])
    expect(writes).toEqual(new Map())
  })
})

describe('removePlugin', () => {
  it('removes the plugin directory', () => {
    const { deps, removed } = fakeDeps(new Uint8Array())
    removePlugin('/plugins', 'acme.demo', deps)
    expect(removed).toContain(join('/plugins', 'acme.demo'))
  })
})

describe('isUpdateAvailable', () => {
  it('detects a strictly-newer latest version', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.1')).toBe(true)
    expect(isUpdateAvailable('1.0.0', '2.0.0')).toBe(true)
    expect(isUpdateAvailable('1.2.0', '1.10.0')).toBe(true)
    expect(isUpdateAvailable('1.2.3-alpha.1', '1.2.3')).toBe(true)
  })

  it('is false for same or older or missing versions', () => {
    expect(isUpdateAvailable('1.0.0', '1.0.0')).toBe(false)
    expect(isUpdateAvailable('2.0.0', '1.9.9')).toBe(false)
    expect(isUpdateAvailable('1.2.3', '1.2.3+build.4')).toBe(false)
    expect(isUpdateAvailable('1.2.3-alpha+build.1', '1.2.3-alpha+build.2')).toBe(false)
    expect(isUpdateAvailable('1.0.0', null)).toBe(false)
    expect(isUpdateAvailable('1.0.0', 'not-semver')).toBe(false)
  })
})
