import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PackageStagingStore } from './pluginStagingStore'

let root = ''
let clock = 0
const store = () => new PackageStagingStore<{ name: string }>(root, 1000, 'TEST_EXPIRED', () => clock)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'navide-staging-'))
  clock = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('PackageStagingStore (MED-5 / S8 Q3)', () => {
  it('has no count limit: every copy stays until it is discarded or expires', () => {
    const s = store()
    const ids = Array.from({ length: 20 }, (_, n) => s.stage(new Uint8Array([n]), { name: `p${n}` }).id)
    for (const [n, id] of ids.entries()) expect(s.take(id)).toMatchObject({ bytes: new Uint8Array([n]), meta: { name: `p${n}` } })
    expect(readdirSync(root)).toHaveLength(20)
  })

  it('removes an earlier run\'s leftovers, and only its own files', () => {
    writeFileSync(join(root, `${'a'.repeat(32)}.vsix`), 'old')
    writeFileSync(join(root, 'keep.txt'), 'not ours')
    store()
    expect(readdirSync(root)).toEqual(['keep.txt'])
  })

  it('says expired for an expired id, undefined for an unknown one, and keeps a bytes-free entry in memory only', () => {
    const s = store()
    const { id } = s.stage(new Uint8Array([1]), { name: 'x' })
    const folder = s.stage(null, { name: 'folder' })
    expect(folder.digest).toBeNull()
    expect(readdirSync(root)).toEqual([`${id}.vsix`])
    expect(s.take(folder.id)).toEqual({ bytes: null, digest: null, meta: { name: 'folder' } })
    clock = 1001
    expect(() => s.take(id)).toThrow(/^TEST_EXPIRED/)
    expect(s.take('f'.repeat(32))).toBeUndefined()
    expect(readdirSync(root)).toEqual([])
  })
})
