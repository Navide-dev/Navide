import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OFFICIAL_PUBLISHER_KEY_PEM } from './pluginVerify'
import { OFFICIAL_REGISTRY_API_URL } from '../../shared/marketplaceDeveloper'
import {
  loadOfficialRegistryRootKey,
  registryRootFingerprint,
  resolveMarketplaceRegistryRoot,
} from './pluginRegistryRootApproval'

const official = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
const custom = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()

describe('loadOfficialRegistryRootKey', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function packagedRoot(contents?: string): string {
    const root = mkdtempSync(join(tmpdir(), 'navide-official-root-'))
    roots.push(root)
    const resources = join(root, 'resources')
    mkdirSync(resources, { recursive: true })
    if (contents !== undefined) {
      writeFileSync(join(resources, 'official-registry-root.pem'), contents)
    }
    return root
  }

  it('loads an independent Ed25519 root from the fixed packaged resource path', () => {
    const independent = generateKeyPairSync('ed25519').publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString()
    expect(loadOfficialRegistryRootKey(packagedRoot(independent))).toBe(independent)
  })

  it('fails closed when the packaged root resource is missing or malformed', () => {
    expect(loadOfficialRegistryRootKey(packagedRoot())).toBeNull()
    expect(loadOfficialRegistryRootKey(packagedRoot('not-a-public-key'))).toBeNull()
  })

  it('rejects the publisher pin as the Official Registry root', () => {
    expect(loadOfficialRegistryRootKey(packagedRoot(OFFICIAL_PUBLISHER_KEY_PEM))).toBeNull()
  })
})

describe('resolveMarketplaceRegistryRoot', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function approval(fingerprint = registryRootFingerprint(custom)): string {
    const root = mkdtempSync(join(tmpdir(), 'navide-registry-root-'))
    roots.push(root)
    const path = join(root, 'approval.json')
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'https://registry.acme.test',
        rootPublicKeyPem: custom,
        confirmedFingerprint: fingerprint,
      })
    )
    return path
  }

  function localApproval(fingerprint = registryRootFingerprint(custom)): string {
    const root = mkdtempSync(join(tmpdir(), 'navide-registry-root-'))
    roots.push(root)
    const path = join(root, 'approval.json')
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        registryUrl: 'http://localhost:8787',
        rootPublicKeyPem: custom,
        confirmedFingerprint: fingerprint,
      })
    )
    return path
  }

  it('rejects an unknown custom Registry root before network trust', () => {
    expect(() =>
      resolveMarketplaceRegistryRoot({
        registryUrlOverride: 'https://registry.acme.test',
        defaultRegistryUrl: 'https://official.navide.test',
        officialRootPublicKey: official,
      })
    ).toThrow(/explicit root approval/)
  })

  it('fails closed when the Official Registry root has not been provisioned', () => {
    expect(() =>
      resolveMarketplaceRegistryRoot({
        defaultRegistryUrl: 'http://localhost:8787',
        officialRegistryUrl: 'https://official.navide.test',
        officialRootPublicKey: null,
        registryUrlOverride: 'https://official.navide.test',
      })
    ).toThrow(/not provisioned/)
  })

  it('matches the Official Registry by host and path prefix only', () => {
    const resolve = (registryUrlOverride: string) =>
      resolveMarketplaceRegistryRoot({
        registryUrlOverride,
        defaultRegistryUrl: 'http://localhost:8787',
        officialRegistryUrl: 'https://server.navide.dev/registry',
        officialRootPublicKey: official,
      })
    for (const url of [
      'https://server.navide.dev/registry',
      'https://server.navide.dev/registry/',
      'https://SERVER.navide.dev:443/registry',
    ]) {
      expect(resolve(url)).toMatchObject({
        registryUrl: 'https://server.navide.dev/registry',
        authority: 'official',
        source: 'app',
      })
    }
    for (const url of [
      'https://server.navide.dev/',
      'https://server.navide.dev',
      'https://server.navide.dev/registry-evil',
      'https://server.navide.dev/registry/evil',
      'https://server.navide.dev/Registry',
      'http://server.navide.dev/registry',
      'https://server.navide.dev.evil.test/registry',
    ]) {
      expect(() => resolve(url)).toThrow(/explicit root approval/)
    }
  })

  it('keeps the Official Registry identity after the website moved to new hosts', () => {
    // Installed plugins and their receipts were trusted under this exact URL
    // and the packaged root key; the move must not change either.
    expect(OFFICIAL_REGISTRY_API_URL).toBe('https://server.navide.dev/registry')
    const resolve = (registryUrlOverride: string) =>
      resolveMarketplaceRegistryRoot({
        registryUrlOverride,
        defaultRegistryUrl: OFFICIAL_REGISTRY_API_URL,
        officialRegistryUrl: OFFICIAL_REGISTRY_API_URL,
        officialRootPublicKey: official,
      })
    expect(resolve(OFFICIAL_REGISTRY_API_URL)).toMatchObject({
      registryUrl: OFFICIAL_REGISTRY_API_URL,
      rootPublicKey: official,
      authority: 'official',
      source: 'app',
    })
    // The storefront and the console serve no API and get no root key of
    // their own: a Host pointed at them needs an explicit approval.
    for (const url of [
      'https://marketplace.navide.dev',
      'https://marketplace.navide.dev/registry',
      'https://developers.navide.dev',
      'https://developers.navide.dev/registry',
    ]) {
      expect(() => resolve(url)).toThrow(/explicit root approval/)
    }
  })

  it('rejects a mismatched confirmed fingerprint', () => {
    expect(() =>
      resolveMarketplaceRegistryRoot({
        registryUrlOverride: 'https://registry.acme.test',
        defaultRegistryUrl: 'https://official.navide.test',
        officialRootPublicKey: official,
        approvalFile: approval(`sha256:${'0'.repeat(64)}`),
      })
    ).toThrow(/fingerprint confirmation does not match/)
  })

  it('accepts only the separately approved custom root PEM', () => {
    expect(
      resolveMarketplaceRegistryRoot({
        registryUrlOverride: 'https://registry.acme.test/',
        defaultRegistryUrl: 'https://official.navide.test',
        officialRootPublicKey: official,
        approvalFile: approval(),
      })
    ).toMatchObject({
      registryUrl: 'https://registry.acme.test',
      rootPublicKey: custom,
      fingerprint: registryRootFingerprint(custom),
      source: 'user',
    })
  })

  it('does not let a custom approval downgrade the normal App Registry pin', () => {
    expect(
      resolveMarketplaceRegistryRoot({
        defaultRegistryUrl: 'https://official.navide.test',
        officialRootPublicKey: official,
        approvalFile: approval(),
      })
    ).toMatchObject({ rootPublicKey: official, source: 'app' })
  })

  it('does not let an override spelling of the official URL replace the App pin', () => {
    expect(
      resolveMarketplaceRegistryRoot({
        registryUrlOverride: 'https://official.navide.test/',
        defaultRegistryUrl: 'https://official.navide.test',
        officialRootPublicKey: official,
        approvalFile: approval(),
      })
    ).toMatchObject({ rootPublicKey: official, source: 'app' })
  })

  it('allows the local development default only with an explicit approval', () => {
    expect(
      resolveMarketplaceRegistryRoot({
        defaultRegistryUrl: 'http://localhost:8787',
        officialRegistryUrl: 'https://official.navide.test',
        officialRootPublicKey: official,
        approvalFile: localApproval(),
      })
    ).toMatchObject({
      registryUrl: 'http://localhost:8787',
      rootPublicKey: custom,
      source: 'user',
    })
  })

  it('keeps the normalized official URL on the App pin when the local default differs', () => {
    expect(
      resolveMarketplaceRegistryRoot({
        registryUrlOverride: 'https://official.navide.test/',
        defaultRegistryUrl: 'http://localhost:8787',
        officialRegistryUrl: 'https://official.navide.test',
        officialRootPublicKey: official,
        approvalFile: localApproval(),
      })
    ).toMatchObject({
      registryUrl: 'https://official.navide.test',
      rootPublicKey: official,
      source: 'app',
    })
  })

  it('rejects duplicate root approval fields before selecting a root', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-registry-root-'))
    roots.push(root)
    const path = join(root, 'approval.json')
    writeFileSync(
      path,
      `{"schemaVersion":1,"registryUrl":"http://localhost:8787","rootPublicKeyPem":${JSON.stringify(custom)},"rootPublicKeyPem":${JSON.stringify(official)},"confirmedFingerprint":${JSON.stringify(registryRootFingerprint(custom))}}`
    )

    expect(() =>
      resolveMarketplaceRegistryRoot({
        defaultRegistryUrl: 'http://localhost:8787',
        officialRegistryUrl: 'https://official.navide.test',
        officialRootPublicKey: official,
        approvalFile: path,
      })
    ).toThrow(/unreadable/)
  })
})
