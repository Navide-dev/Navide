// Plan W1 (S1, S1b): plugins_validate_package and plugins_package in the Host.
// The packager must build the same bytes as `navide-plugin package`, and a
// check must refuse what a local install refuses.

import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign as edSign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildFolderPackage } from './pluginLocalPackager'
import { packageLocalFolder, validateLocalPackage, type LocalPackageToolDeps } from './pluginLocalPackageTools'
import { publisherKeyId, type LocalInstallTrustMetadata } from './pluginLocalInstallTrust'
import { sha256Hex } from './pluginVerify'

const cli = join(process.cwd(), 'packages/plugin-sdk/bin/navide-plugin.mjs')
const vetted = generateKeyPairSync('ed25519')
const vettedPem = vetted.publicKey.export({ type: 'spki', format: 'pem' }).toString()

function manifest(id = 'acme.todo'): Record<string, unknown> {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id,
    name: 'Todo Scout',
    version: '1.2.0',
    publisher: id.split('.')[0],
    permissions: { system: ['ui'] },
    marketplace: { description: 'Local test package', license: 'MIT' },
    contributes: { views: [{ id: 'left', kind: 'custom', location: 'left', title: 'Todo', entry: 'frontend/left/index.html' }] },
  }
}

let base = ''
let folder = ''
let dataRoot = ''

function writeFolder(dir = folder, data: Record<string, unknown> = manifest(), files = ['manifest.json', 'frontend/left/index.html']): void {
  mkdirSync(join(dir, 'frontend', 'left'), { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(data))
  writeFileSync(join(dir, 'frontend', 'left', 'index.html'), '<!doctype html><title>todo</title>')
  writeFileSync(join(dir, 'artifact-files.json'), JSON.stringify({ files }))
}

function deps(localInstallTrust: LocalInstallTrustMetadata | null = null): LocalPackageToolDeps {
  return {
    trust: () => ({ pinnedRegistryRootKey: null, trustSnapshot: null, localInstallTrust }),
    readSignature: (path) => (existsSync(`${path}.sig`) ? readFileSync(`${path}.sig`, 'utf8').trim() : null),
    protectedRoots: [dataRoot],
  }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'navide-local-package-')))
  folder = join(base, 'todo-scout')
  dataRoot = join(base, 'navide-data')
  mkdirSync(dataRoot)
  writeFolder()
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('plugins_package', () => {
  it('builds the same bytes as navide-plugin package', () => {
    const out = join(base, 'sdk.vsix')
    const sdk = spawnSync(process.execPath, [cli, 'package', folder, '--out', out], { encoding: 'utf8' })
    expect(sdk.status, sdk.stderr).toBe(0)
    expect(sha256Hex(buildFolderPackage(folder).bytes)).toBe(sha256Hex(readFileSync(out)))
  })

  it('writes the SDK file name beside the folder and reports what a local install would show', async () => {
    const report = await packageLocalFolder(folder, {}, deps())
    expect(report).toMatchObject({
      path: join(base, 'acme.todo-1.2.0-universal.vsix'),
      packageKind: 'file',
      valid: true,
      errors: [],
      id: 'acme.todo',
      version: '1.2.0',
      target: 'universal',
      signature: 'none',
    })
    expect(report.digest).toBe(sha256Hex(readFileSync(report.path)))
    expect(report.disclosure).not.toBeNull()
  })

  it('writes nothing for a folder the SDK rules refuse, and says why', async () => {
    writeFileSync(join(folder, 'frontend', 'left', 'secret.pem'), 'x')
    writeFolder(folder, manifest(), ['manifest.json', 'frontend/left/index.html', 'frontend/left/secret.pem'])
    const report = await packageLocalFolder(folder, {}, deps())
    expect(report.valid).toBe(false)
    expect(report.errors.join()).toMatch(/source-only or secret material/)
    expect(existsSync(join(base, 'acme.todo-1.2.0-universal.vsix'))).toBe(false)
  })

  it('never writes into Navide\'s data folder, through a symlink, or to a non-.vsix name', async () => {
    await expect(packageLocalFolder(folder, { out: join(dataRoot, 'x.vsix') }, deps())).rejects.toThrow(/own data folder/)
    symlinkSync(dataRoot, join(base, 'link'))
    await expect(packageLocalFolder(folder, { out: join(base, 'link', 'x.vsix') }, deps())).rejects.toThrow(/own data folder/)
    await expect(packageLocalFolder(folder, { out: join(base, 'x.zip') }, deps())).rejects.toThrow(/\.vsix/)
    await expect(packageLocalFolder(folder, { out: 'x.vsix' }, deps())).rejects.toThrow(/absolute/)
    mkdirSync(join(base, 'dir.vsix'))
    await expect(packageLocalFolder(folder, { out: join(base, 'dir.vsix') }, deps())).rejects.toThrow(/already exists/)
  })

  it('never replaces an existing file, its own earlier build included', async () => {
    const existing = join(base, 'keep.vsix')
    writeFileSync(existing, 'mine')
    await expect(packageLocalFolder(folder, { out: existing }, deps())).rejects.toThrow(/already exists/)
    expect(readFileSync(existing, 'utf8')).toBe('mine')
    await packageLocalFolder(folder, {}, deps())
    await expect(packageLocalFolder(folder, {}, deps())).rejects.toThrow(/already exists/)
  })

  it('never reads a folder inside Navide\'s data folder', async () => {
    const inside = join(dataRoot, 'plugins', 'acme.todo')
    writeFolder(inside)
    await expect(packageLocalFolder(inside, { out: join(base, 'x.vsix') }, deps())).rejects.toThrow(/own data folder/)
  })
})

describe('plugins_validate_package', () => {
  it('checks a .vsix with the local install rules, signature included, and installs nothing', async () => {
    const { path } = await packageLocalFolder(folder, {}, deps())
    writeFileSync(`${path}.sig`, edSign(null, Buffer.from(sha256Hex(readFileSync(path)), 'ascii'), vetted.privateKey).toString('base64'))
    const trust: LocalInstallTrustMetadata = {
      schemaVersion: 1, kind: 'local-install-trust', registryProfile: 'official',
      generatedAt: '2026-10-20T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', blockedDigests: [],
      publisherKeys: [{ publisherId: 'acme', keyId: publisherKeyId(vettedPem), publicKey: vettedPem, status: 'active', revokedAt: null }],
    }
    expect(await validateLocalPackage(path, deps(trust))).toMatchObject({ valid: true, packageKind: 'file', signature: 'verified', id: 'acme.todo' })
    const blocked = { ...trust, blockedDigests: [sha256Hex(readFileSync(path))] }
    const refused = await validateLocalPackage(path, deps(blocked))
    expect(refused.valid).toBe(false)
    expect(refused.errors.join()).toMatch(/DIGEST_BLOCKED/)
  })

  it('checks a folder with the SDK rules and then the local install rules', async () => {
    expect(await validateLocalPackage(folder, deps())).toMatchObject({ valid: true, packageKind: 'folder', id: 'acme.todo' })
    writeFolder(folder, manifest('navide.todo'))
    const reserved = await validateLocalPackage(folder, deps())
    expect(reserved.valid).toBe(false)
    expect(reserved.errors.join()).toMatch(/navide\./)
  })

  it('never reads Navide\'s own data, directly or through a symlink', async () => {
    const record = join(dataRoot, 'plugin-local-trust', 'acme.todo.json')
    mkdirSync(join(dataRoot, 'plugin-local-trust'))
    writeFileSync(record, '{}')
    await expect(validateLocalPackage(record, deps())).rejects.toThrow(/own data folder/)
    symlinkSync(record, join(base, 'record.vsix'))
    await expect(validateLocalPackage(join(base, 'record.vsix'), deps())).rejects.toThrow(/own data folder/)
    await expect(validateLocalPackage('relative.vsix', deps())).rejects.toThrow(/absolute/)
  })

  it('reports a broken archive as an error, not a throw', async () => {
    const path = join(base, 'broken.vsix')
    writeFileSync(path, 'not a zip')
    const report = await validateLocalPackage(path, deps())
    expect(report).toMatchObject({ valid: false, packageKind: 'file', digest: sha256Hex(Buffer.from('not a zip')) })
    expect(report.errors).toHaveLength(1)
  })
})
