import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalTrustJson,
  verifyRegistryPackageTrust,
  type RegistryPackageEnvelope,
  type RegistryTrustMetadata,
} from './pluginRegistryTrust'

const root = generateKeyPairSync('ed25519')
const signer = generateKeyPairSync('ed25519')
const rogue = generateKeyPairSync('ed25519')
const rootPublicKey = root.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const signerPublicKey = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const NOW = '2026-08-16T12:00:00.000Z'

function signature(value: unknown, privateKey = signer.privateKey): string {
  return sign(null, Buffer.from(canonicalTrustJson(value)), privateKey).toString('base64')
}

function envelope(overrides: Partial<RegistryPackageEnvelope> = {}): RegistryPackageEnvelope {
  return {
    schemaVersion: 1,
    artifactDigest: 'a'.repeat(64),
    packageId: 'acme.demo',
    version: '1.0.0',
    target: 'universal',
    publisherId: 'acme',
    keyId: 'registry-2026',
    signedAt: '2026-08-16T11:00:00.000Z',
    ...overrides,
  }
}

function trust(overrides: Partial<RegistryTrustMetadata> = {}): RegistryTrustMetadata {
  return {
    schemaVersion: 1,
    registryProfile: 'official',
    rootFingerprint: `sha256:${'1'.repeat(64)}`,
    generatedAt: '2026-08-16T10:00:00.000Z',
    expiresAt: '2026-08-17T10:00:00.000Z',
    signers: [
      {
        keyId: 'registry-2026',
        publicKey: signerPublicKey,
        status: 'active',
        notBefore: '2026-08-01T00:00:00.000Z',
        notAfter: '2026-09-01T00:00:00.000Z',
      },
    ],
    blockedPublishers: [],
    blockedPackages: [],
    ...overrides,
  }
}

function verify(
  envelopeValue = envelope(),
  trustValue = trust(),
  envelopeSignature = signature(envelopeValue),
  expectedHostTarget?: string,
  expectedPackageId = 'acme.demo'
) {
  return verifyRegistryPackageTrust({
    envelope: envelopeValue,
    envelopeSignature,
    trustMetadata: trustValue,
    trustMetadataSignature: signature(trustValue, root.privateKey),
    pinnedRootKey: rootPublicKey,
    expected: {
      artifactDigest: 'a'.repeat(64),
      packageId: expectedPackageId,
      version: '1.0.0',
      target: envelopeValue.target,
      publisherId: 'acme',
    },
    ...(expectedHostTarget ? { expectedHostTarget } : {}),
    now: new Date(NOW),
  })
}

describe('verifyRegistryPackageTrust', () => {
  it('accepts a complete envelope signed by an active registry signer authorized by the pinned root', () => {
    expect(verify()).toEqual({ publisherId: 'acme', keyId: 'registry-2026' })
  })

  it('rejects unsigned and self-supplied-key packages', () => {
    expect(() => verify(envelope(), trust(), '')).toThrow(/signature is required/)
    const value = envelope()
    expect(() => verify(value, trust(), signature(value, rogue.privateKey))).toThrow(
      /registry signature/
    )
  })

  it('rejects modified archives and mismatched signed identities', () => {
    expect(() => verify(envelope({ artifactDigest: 'b'.repeat(64) }))).toThrow(/artifactDigest/)
    expect(() => verify(envelope({ publisherId: 'other' }))).toThrow(/publisherId/)
    expect(() => verify(envelope({ packageId: 'acme.other' }))).toThrow(/packageId/)
  })

  it('rejects unknown and revoked registry signers', () => {
    expect(() => verify(envelope({ keyId: 'missing' }))).toThrow(/unknown registry signer/)
    const revoked = trust({
      signers: [{ ...trust().signers[0], status: 'revoked' }],
    })
    expect(() => verify(envelope(), revoked)).toThrow(/revoked/)
  })

  it('accepts a rotating signer only inside its validity window', () => {
    const rotating = trust({
      signers: [{ ...trust().signers[0], status: 'rotating' }],
    })
    expect(verify(envelope(), rotating)).toEqual({ publisherId: 'acme', keyId: 'registry-2026' })
    expect(() =>
      verify(envelope({ signedAt: '2026-09-02T00:00:00.000Z' }), rotating)
    ).toThrow(/validity/)
  })

  it('accepts an expired signer only for artifacts signed before expiry', () => {
    const expired = trust({
      signers: [{ ...trust().signers[0], status: 'expired' }],
    })
    expect(verify(envelope(), expired)).toEqual({ publisherId: 'acme', keyId: 'registry-2026' })
    expect(() =>
      verify(envelope({ signedAt: '2026-09-02T00:00:00.000Z' }), expired)
    ).toThrow(/expired signer.*new artifact/)
  })

  it('rejects root-signed publisher and package blocklist entries', () => {
    expect(() => verify(envelope(), trust({ blockedPublishers: ['acme'] }))).toThrow(
      /publisher.*blocked/
    )
    expect(() =>
      verify(
        envelope(),
        trust({ blockedPackages: [{ packageId: 'acme.demo', version: '1.0.0' }] })
      )
    ).toThrow(/package.*blocked/)
  })

  it('binds universal and exact targets to the Host runtime', () => {
    expect(verify(envelope({ target: 'universal' }), trust(), undefined, 'darwin-arm64')).toBeDefined()
    expect(verify(envelope({ target: 'darwin-arm64' }), trust(), undefined, 'darwin-arm64')).toBeDefined()
    expect(() => verify(envelope({ target: 'linux-x64' }), trust(), undefined, 'darwin-arm64')).toThrow(
      /not compatible with host target/
    )
    expect(() => verify(envelope({ target: 'darwin-x64' }), trust(), undefined, 'darwin-arm64')).toThrow(
      /not compatible with host target/
    )
  })

  it('rejects invalid multi-segment blocklist and envelope package ids', () => {
    expect(() => verify(
      envelope({ packageId: 'acme.tools.linter' }),
      trust(),
      undefined,
      undefined,
      'acme.tools.linter'
    )).not.toThrow()
    expect(() => verify(
      envelope(),
      trust({ blockedPackages: [{ packageId: 'acme..linter' }] })
    )).toThrow(/packageId is invalid/)
    expect(() => verify(envelope({ packageId: 'acme..linter' }))).toThrow(/packageId is invalid/)
  })

  it('rejects expired or forged root-signed trust metadata', () => {
    expect(() => verify(envelope(), trust({ expiresAt: '2026-08-15T00:00:00.000Z' }))).toThrow(
      /trust metadata.*expired/
    )
    const value = trust()
    expect(() =>
      verifyRegistryPackageTrust({
        envelope: envelope(),
        envelopeSignature: signature(envelope()),
        trustMetadata: value,
        trustMetadataSignature: signature(value, rogue.privateKey),
        pinnedRootKey: rootPublicKey,
        expected: {
          artifactDigest: 'a'.repeat(64),
          packageId: 'acme.demo',
          version: '1.0.0',
          target: 'universal',
          publisherId: 'acme',
        },
        now: new Date(NOW),
      })
    ).toThrow(/trust metadata signature/)
  })

  it('does not accept trust metadata signed by a publisher key', () => {
    const publisher = generateKeyPairSync('ed25519')
    const value = trust()
    expect(() =>
      verifyRegistryPackageTrust({
        envelope: envelope(),
        envelopeSignature: signature(envelope()),
        trustMetadata: value,
        trustMetadataSignature: signature(value, publisher.privateKey),
        pinnedRootKey: rootPublicKey,
        expected: {
          artifactDigest: 'a'.repeat(64),
          packageId: 'acme.demo',
          version: '1.0.0',
          target: 'universal',
          publisherId: 'acme',
        },
        now: new Date(NOW),
      })
    ).toThrow(/trust metadata signature/)
  })
})

describe('canonical registry trust JSON', () => {
  it('uses code-point key ordering shared with the Registry signer', () => {
    const value = JSON.parse(
      readFileSync(join(process.cwd(), 'docs/plugin-contracts/canonical-json-parity.json'), 'utf8')
    )

    expect(Buffer.from(canonicalTrustJson(value), 'utf8')).toEqual(
      Buffer.from(
        '{"a":"first","nested":{"a":"inner","z":"last","Ω":"omega"},"z":"last","ä":"umlaut","":"private-use","😀":"emoji"}',
        'utf8'
      )
    )
  })
})

describe('verifyRegistryPackageTrust release channel', () => {
  function codeOf(run: () => unknown): string | undefined {
    try {
      run()
    } catch (error) {
      return (error as { code?: string }).code
    }
    return undefined
  }

  it('verifies an envelope without channel fields exactly as before', () => {
    const plain = envelope()
    expect(Object.keys(plain)).toHaveLength(8)
    expect(verify(plain)).toEqual({ publisherId: 'acme', keyId: 'registry-2026' })
  })

  it('accepts a testplace envelope before its signed expiry', () => {
    const testplace = envelope({ channel: 'testplace', expiresAt: '2026-11-14T11:00:00Z' })
    expect(verify(testplace)).toEqual({ publisherId: 'acme', keyId: 'registry-2026' })
  })

  it('refuses an expired testplace envelope with TESTPLACE_EXPIRED', () => {
    const testplace = envelope({ channel: 'testplace', expiresAt: '2026-08-16T11:59:59Z' })
    expect(codeOf(() => verify(testplace))).toBe('TESTPLACE_EXPIRED')
  })

  it('refuses a channel it does not know (fail closed)', () => {
    for (const channel of ['nightly', 'Testplace', '']) {
      expect(codeOf(() => verify(envelope({ channel })))).toBe('CHANNEL_UNSUPPORTED')
    }
  })

  it('refuses a testplace envelope without an expiry and an expiry without testplace', () => {
    expect(codeOf(() => verify(envelope({ channel: 'testplace' })))).toBe('CHANNEL_UNSUPPORTED')
    expect(codeOf(() => verify(envelope({ expiresAt: '2026-11-14T11:00:00Z' })))).toBe(
      'CHANNEL_UNSUPPORTED'
    )
    expect(
      codeOf(() => verify(envelope({ channel: 'testplace', expiresAt: 'not-a-time' })))
    ).toBe('TRUST_METADATA_INVALID')
  })

  it('does not let a changed expiry pass the registry signature', () => {
    const signed = envelope({ channel: 'testplace', expiresAt: '2026-08-16T11:59:59Z' })
    const extended = { ...signed, expiresAt: '2099-01-01T00:00:00Z' }
    expect(codeOf(() => verify(extended, trust(), signature(signed)))).toBe(
      'REGISTRY_SIGNATURE_INVALID'
    )
  })
})
