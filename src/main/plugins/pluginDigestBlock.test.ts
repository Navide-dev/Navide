import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DigestBlockNoticeStore,
  digestBlockAction,
  digestBlockDialogText,
  recordDigestBlock,
  type LocalDigestBlock,
} from './pluginDigestBlock'
import { localTrustRecordPath, verifyLocalInstalledPackage } from './pluginLocalInstall'
import { writeLocalInstallTrust, type LocalInstallTrustMetadata } from './pluginLocalInstallTrust'
import { createLocalTrustRecord, readLocalTrustRecord, writeLocalTrustRecord, type PluginLocalTrustRecord } from './pluginLocalTrust'
import { canonicalTrustJson } from './pluginRegistryTrust'

const root = generateKeyPairSync('ed25519')
const rootPem = root.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const signRoot = (value: unknown): string =>
  sign(null, Buffer.from(canonicalTrustJson(value), 'utf8'), root.privateKey).toString('base64')
const vsix = createHash('sha256').update('the .vsix bytes').digest('hex')
const ID = 'acme.notes'

function trustDoc(blockedDigests: LocalInstallTrustMetadata['blockedDigests']): LocalInstallTrustMetadata {
  return {
    schemaVersion: 1,
    kind: 'local-install-trust',
    registryProfile: 'official',
    generatedAt: '2026-10-20T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    blockedDigests,
    publisherKeys: [],
  }
}

function record(overrides: Partial<PluginLocalTrustRecord> = {}): PluginLocalTrustRecord {
  return {
    schemaVersion: 1,
    id: ID,
    version: '1.0.0',
    contentDigest: '0'.repeat(64),
    fileDigests: {},
    consentedAt: '2026-10-20T00:00:00Z',
    source: 'file',
    signer: null,
    ...overrides,
  }
}

describe('decision d5: grading a blocked local install', () => {
  it('maps each reason to what Navide does', () => {
    expect(digestBlockAction('security')).toBe('disable')
    expect(digestBlockAction('admin')).toBe('warn')
    expect(digestBlockAction('qualification-revoked')).toBe('warn')
    expect(digestBlockAction(null)).toBe('warn')
    expect(digestBlockAction('developer-withdrawn')).toBe('label')
  })

  it('checks the recorded .vsix digest, falling back to A3 signer evidence', () => {
    const doc = trustDoc([{ digest: vsix, reason: 'admin' }])
    expect(recordDigestBlock(record({ artifactDigest: vsix }), doc)).toEqual({ digest: vsix, reason: 'admin', action: 'warn' })
    const signed = record({ signer: { publisherId: 'acme', keyId: 'sha256:' + 'a'.repeat(64), artifactDigest: vsix, signature: 'c2ln' } })
    expect(recordDigestBlock(signed, doc)?.action).toBe('warn')
    // A record written before d5, unsigned, names no file and cannot be checked.
    expect(recordDigestBlock(record(), doc)).toBeNull()
    expect(recordDigestBlock(record({ artifactDigest: vsix }), trustDoc([]))).toBeNull()
    expect(recordDigestBlock(record({ artifactDigest: vsix }), null)).toBeNull()
    // A bare string from an older Registry: blocked, no reason, warned about.
    expect(recordDigestBlock(record({ artifactDigest: vsix }), trustDoc([vsix]))).toEqual({ digest: vsix, reason: null, action: 'warn' })
  })
})

describe('the one-time notice', () => {
  let pluginsRoot: string
  beforeEach(() => {
    pluginsRoot = mkdtempSync(join(tmpdir(), 'digest-block-'))
  })
  afterEach(() => rmSync(pluginsRoot, { recursive: true, force: true }))

  it('is shown once per digest and again when the reason changes', () => {
    const admin: LocalDigestBlock = { digest: vsix, reason: 'admin', action: 'warn' }
    const store = new DigestBlockNoticeStore(pluginsRoot)
    expect(store.shown(ID, admin)).toBe(false)
    store.record(ID, admin)
    expect(new DigestBlockNoticeStore(pluginsRoot).shown(ID, admin)).toBe(true)
    expect(store.shown(ID, { digest: vsix, reason: 'security', action: 'disable' })).toBe(false)
    expect(store.shown('acme.other', admin)).toBe(false)
  })

  it('reads an unreadable store as nothing shown', () => {
    writeFileSync(join(pluginsRoot, '.navide-digest-block-notices.json'), '[1, 2')
    expect(new DigestBlockNoticeStore(pluginsRoot).shown(ID, { digest: vsix, reason: null, action: 'warn' })).toBe(false)
  })
})

describe('the dialog text', () => {
  it('offers keep, disable and remove for a warning, in all three languages', () => {
    for (const locale of ['zh-TW', 'en-US', 'ja-JP'] as const) {
      const text = digestBlockDialogText({ pluginId: ID, version: '1.0.0', reason: 'qualification-revoked', action: 'warn' }, locale)
      expect(text.buttons).toHaveLength(3)
      expect(text.choices).toEqual(['keep', 'disable', 'remove'])
      expect(text.message).toContain('acme.notes 1.0.0')
      expect(text.detail).toContain('acme')
    }
    expect(digestBlockDialogText({ pluginId: ID, version: '1.0.0', reason: null, action: 'warn' }, 'en-US').message)
      .toMatch(/^The Navide plugin acme\.notes 1\.0\.0/)
  })

  it('offers only remove for a security block, which stays disabled', () => {
    const text = digestBlockDialogText({ pluginId: ID, version: '1.0.0', reason: 'security', action: 'disable' }, 'zh-TW')
    expect(text.choices).toEqual(['keep', 'remove'])
    expect(text.buttons).toEqual(['確定', '移除'])
    expect(text.message).toContain('Navide 已停用')
    expect(text.detail).toContain('安全')
  })

  it('shows hidden characters in the package id instead of rendering them', () => {
    const text = digestBlockDialogText({ pluginId: 'acme.no‮tes', version: '1.0.0', reason: 'admin', action: 'warn' }, 'en-US')
    expect(text.message).not.toContain('‮')
  })
})

describe('the load-time check of an installed local copy', () => {
  let userData: string
  let pluginsRoot: string
  let packageDir: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'digest-block-load-'))
    pluginsRoot = join(userData, 'plugins')
    packageDir = join(pluginsRoot, ID, '1.0.0', 'universal', 'package')
    mkdirSync(join(packageDir, 'frontend'), { recursive: true })
    writeFileSync(join(packageDir, 'manifest.json'), JSON.stringify({
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: ID,
      name: 'Notes',
      version: '1.0.0',
      publisher: 'acme',
      permissions: {},
      marketplace: { description: 'Notes', license: 'MIT' },
      contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Notes', entry: 'frontend/index.html' }] },
    }))
    writeFileSync(join(packageDir, 'frontend', 'index.html'), '<!doctype html>')
  })
  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  const consent = (artifactDigest?: string): void => {
    writeLocalTrustRecord(
      localTrustRecordPath(pluginsRoot, ID),
      createLocalTrustRecord(packageDir, { source: 'file', consentedAt: '2026-10-20T00:00:00Z', artifactDigest }),
    )
  }
  const block = (reason: string): void => {
    const doc = trustDoc([{ digest: vsix, reason }])
    writeLocalInstallTrust(pluginsRoot, doc, signRoot(doc), rootPem)
  }
  const verify = () => verifyLocalInstalledPackage(pluginsRoot, packageDir, ID, { pinnedRootKey: rootPem, snapshot: null })

  it('records the .vsix digest in the trust record', () => {
    consent(vsix)
    expect(readLocalTrustRecord(localTrustRecordPath(pluginsRoot, ID)).artifactDigest).toBe(vsix)
    expect(JSON.parse(readFileSync(localTrustRecordPath(pluginsRoot, ID), 'utf8')).artifactDigest).toBe(vsix)
  })

  it('quarantines a copy whose file Navide blocked for a security reason', () => {
    consent(vsix)
    expect(verify()?.action).toBe('allow')
    block('security')
    const decision = verify()
    expect(decision?.action).toBe('quarantine')
    expect(decision?.action === 'quarantine' && decision.reason).toMatch(/^LOCAL_DIGEST_BLOCKED: .*security/)
  })

  it('keeps running a copy blocked for any other reason', () => {
    consent(vsix)
    for (const reason of ['admin', 'qualification-revoked', 'developer-withdrawn', 'court-order']) {
      block(reason)
      expect(verify()?.action).toBe('allow')
    }
  })

  it('reads a record written before d5, which names no file', () => {
    consent()
    block('security')
    expect(verify()?.action).toBe('allow')
  })
})
