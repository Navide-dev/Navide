// A2-3 (DESIGN-A2 T-G2b): the content fingerprint of a developer folder.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folderFingerprint } from './pluginFolderFingerprint'

let root = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'navide-fingerprint-'))
  mkdirSync(join(root, 'frontend', 'left'), { recursive: true })
  writeFileSync(join(root, 'manifest.json'), '{"id":"acme.devtodo"}')
  writeFileSync(join(root, 'frontend', 'left', 'index.html'), '<!doctype html>')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('folderFingerprint', () => {
  it('is stable for the same content and counts the files', async () => {
    const first = await folderFingerprint(root)
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(first.fileCount).toBe(2)
    expect(await folderFingerprint(root)).toEqual(first)
  })

  it('changes with one byte, a rename or an added file', async () => {
    const before = (await folderFingerprint(root)).fingerprint
    writeFileSync(join(root, 'manifest.json'), '{"id":"acme.devtodO"}')
    const edited = (await folderFingerprint(root)).fingerprint
    expect(edited).not.toBe(before)
    renameSync(join(root, 'manifest.json'), join(root, 'manifest2.json'))
    const renamed = (await folderFingerprint(root)).fingerprint
    expect(renamed).not.toBe(edited)
    writeFileSync(join(root, 'extra.txt'), '')
    const added = await folderFingerprint(root)
    expect(added.fingerprint).not.toBe(renamed)
    expect(added.fileCount).toBe(3)
  })

  it('leaves out .git/ and records a symbolic link without following it', async () => {
    const before = await folderFingerprint(root)
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
    expect(await folderFingerprint(root)).toEqual(before)

    const outside = mkdtempSync(join(tmpdir(), 'navide-fingerprint-outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'one')
      symlinkSync(outside, join(root, 'linked'))
      const linked = await folderFingerprint(root)
      expect(linked.fileCount).toBe(3)
      writeFileSync(join(outside, 'secret.txt'), 'two')
      expect(await folderFingerprint(root)).toEqual(linked)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
