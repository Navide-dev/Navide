import { generateKeyPairSync, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  canonicalTrustJson,
  TRUST_METADATA_CLOCK_SKEW_MS,
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
    expect(() =>
      verify(envelope(), trust({ generatedAt: '2026-08-14T00:00:00.000Z', expiresAt: '2026-08-15T00:00:00.000Z' }))
    ).toThrow(
      /^TRUST_METADATA_EXPIRED: registry trust metadata expired at .*check the computer's date and time$/
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

  // D3: the user kept an expired test build; only the expiry check is skipped.
  function verifyKept(envelopeValue: RegistryPackageEnvelope, trustValue = trust()) {
    return verifyRegistryPackageTrust({
      envelope: envelopeValue,
      envelopeSignature: signature(envelopeValue),
      trustMetadata: trustValue,
      trustMetadataSignature: signature(trustValue, root.privateKey),
      pinnedRootKey: rootPublicKey,
      expected: {
        artifactDigest: 'a'.repeat(64),
        packageId: 'acme.demo',
        version: '1.0.0',
        target: 'universal',
        publisherId: 'acme',
      },
      now: new Date(NOW),
      allowExpiredTestplace: true,
    })
  }

  it('allows a kept expired testplace envelope and says it is expired', () => {
    const expired = envelope({ channel: 'testplace', expiresAt: '2026-08-16T11:59:59Z' })
    expect(verifyKept(expired)).toEqual({ publisherId: 'acme', keyId: 'registry-2026', expired: true })
    // Not expired yet: nothing to mark.
    const live = envelope({ channel: 'testplace', expiresAt: '2026-11-14T11:00:00Z' })
    expect(verifyKept(live)).toEqual({ publisherId: 'acme', keyId: 'registry-2026' })
  })

  it('still refuses a kept expired testplace version that was taken down', () => {
    const expired = envelope({ channel: 'testplace', expiresAt: '2026-08-16T11:59:59Z' })
    const blocked = trust({ blockedPackages: [{ packageId: 'acme.demo', version: '1.0.0' }] })
    expect(codeOf(() => verifyKept(expired, blocked))).toBe('PACKAGE_BLOCKED')
    const tampered = { ...expired, expiresAt: '2099-01-01T00:00:00Z' }
    expect(codeOf(() => verifyRegistryPackageTrust({
      envelope: tampered,
      envelopeSignature: signature(expired),
      trustMetadata: trust(),
      trustMetadataSignature: signature(trust(), root.privateKey),
      pinnedRootKey: rootPublicKey,
      expected: { artifactDigest: 'a'.repeat(64), packageId: 'acme.demo', version: '1.0.0', target: 'universal', publisherId: 'acme' },
      now: new Date(NOW),
      allowExpiredTestplace: true,
    }))).toBe('REGISTRY_SIGNATURE_INVALID')
  })
})

describe('trust metadata time window (clock skew)', () => {
  // The Registry signs trust metadata per request, so generatedAt is "now" on
  // the server; NOW is this computer's clock.
  const generatedAfterNow = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString()
  const expiringAfter = (generatedAt: string) => new Date(Date.parse(generatedAt) + 24 * 3600_000).toISOString()
  const issued = (ms: number) => {
    const generatedAt = generatedAfterNow(ms)
    return trust({ generatedAt, expiresAt: expiringAfter(generatedAt) })
  }
  const signedEarlier = envelope({ signedAt: '2026-08-16T11:00:00.000Z' })

  it('allows five minutes, as a named constant', () => {
    expect(TRUST_METADATA_CLOCK_SKEW_MS).toBe(5 * 60 * 1000)
  })

  it('accepts metadata from a server one minute ahead of this clock', () => {
    expect(verify(signedEarlier, issued(60_000))).toEqual({ publisherId: 'acme', keyId: 'registry-2026' })
  })

  it('accepts metadata exactly at the allowance', () => {
    expect(verify(signedEarlier, issued(TRUST_METADATA_CLOCK_SKEW_MS))).toEqual({
      publisherId: 'acme',
      keyId: 'registry-2026',
    })
  })

  it('refuses metadata one second past the allowance (5:01)', () => {
    expect(() => verify(signedEarlier, issued(TRUST_METADATA_CLOCK_SKEW_MS + 1000))).toThrow(
      /^TRUST_METADATA_NOT_YET_VALID: /
    )
  })

  it('refuses metadata from a server ten minutes ahead as not valid yet, not as expired', () => {
    let error: unknown
    try {
      verify(signedEarlier, issued(10 * 60_000))
    } catch (caught) {
      error = caught
    }
    expect((error as { code?: string }).code).toBe('TRUST_METADATA_INVALID')
    expect((error as Error).message).toMatch(/^TRUST_METADATA_NOT_YET_VALID: .*check the computer's date and time$/)
    expect((error as Error).message).not.toMatch(/expired/)
  })

  it('does not widen the expiry side', () => {
    const expiresAt = new Date(Date.parse(NOW) - 1).toISOString()
    expect(() => verify(signedEarlier, trust({ generatedAt: '2026-08-15T12:00:00.000Z', expiresAt }))).toThrow(
      /^TRUST_METADATA_EXPIRED: /
    )
  })

  it('still refuses an empty validity window, whatever the clock', () => {
    expect(() =>
      verify(signedEarlier, trust({ generatedAt: '2026-08-16T10:00:00.000Z', expiresAt: '2026-08-16T10:00:00.000Z' }))
    ).toThrow(/empty validity window/)
  })
})

describe('registry envelope signedAt (clock skew, future side only)', () => {
  // A version published moments ago carries the server's clock in signedAt.
  const signedAfterNow = (ms: number) => envelope({ signedAt: new Date(Date.parse(NOW) + ms).toISOString() })

  it('accepts a signature 4:59 later than this clock', () => {
    expect(verify(signedAfterNow(4 * 60_000 + 59_000))).toEqual({ publisherId: 'acme', keyId: 'registry-2026' })
  })

  it('refuses a signature 5:01 later than this clock as not valid yet', () => {
    let error: unknown
    try {
      verify(signedAfterNow(5 * 60_000 + 1_000))
    } catch (caught) {
      error = caught
    }
    expect((error as { code?: string }).code).toBe('SIGNER_INVALID')
    expect((error as Error).message).toMatch(/^REGISTRY_SIGNATURE_NOT_YET_VALID: .*check the computer's date and time$/)
  })

  it("still refuses a signature outside the signer's own window, with no allowance", () => {
    const before = envelope({ signedAt: new Date(Date.parse('2026-08-01T00:00:00.000Z') - 1).toISOString() })
    expect(() => verify(before)).toThrow(/outside its validity window/)
  })
})
