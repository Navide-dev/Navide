import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_FREE_BYTES, PackageStagingStore } from './pluginStagingStore'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

let root = ''
let clock = 0
let free = 100 * 1024 * 1024 * 1024
const store = () => new PackageStagingStore<{ name: string }>(root, 1000, 'TEST_EXPIRED', () => clock, () => free)
const digestOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'navide-staging-'))
  clock = 0
  free = 100 * 1024 * 1024 * 1024
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
    writeFileSync(join(root, `${'a'.repeat(64)}.vsix`), 'old')
    writeFileSync(join(root, `${'b'.repeat(64)}.vsix.${'c'.repeat(16)}.tmp`), 'half')
    writeFileSync(join(root, 'keep.txt'), 'not ours')
    store()
    expect(readdirSync(root)).toEqual(['keep.txt'])
  })

  it('says expired for an expired id, undefined for an unknown one, and keeps a bytes-free entry in memory only', () => {
    const s = store()
    const { id } = s.stage(new Uint8Array([1]), { name: 'x' })
    const folder = s.stage(null, { name: 'folder' })
    expect(folder.digest).toBeNull()
    expect(readdirSync(root)).toEqual([`${digestOf(new Uint8Array([1]))}.vsix`])
    expect(s.take(folder.id)).toEqual({ bytes: null, digest: null, meta: { name: 'folder' } })
    clock = 1001
    expect(() => s.take(id)).toThrow(/^TEST_EXPIRED/)
    expect(s.take('f'.repeat(32))).toBeUndefined()
    expect(readdirSync(root)).toEqual([])
  })

  it('keeps one file for the same bytes staged twice, until the last entry goes', () => {
    const s = store()
    const bytes = new Uint8Array([7, 7, 7])
    const first = s.stage(bytes, { name: 'a' })
    const second = s.stage(bytes, { name: 'b' })
    expect(first.id).not.toBe(second.id)
    expect(readdirSync(root)).toEqual([`${digestOf(bytes)}.vsix`])
    s.discard(first.id)
    expect(s.take(second.id)?.bytes).toEqual(bytes)
    s.discard(second.id)
    expect(readdirSync(root)).toEqual([])
  })

  it('refuses a copy that would leave less than 5 GiB free, naming both sizes; nothing staged before is touched', () => {
    const s = store()
    const kept = s.stage(new Uint8Array([1]), { name: 'kept' })
    free = MIN_FREE_BYTES + 2
    expect(() => s.stage(new Uint8Array([1, 2, 3]), { name: 'new' }))
      .toThrow(/^STAGING_DISK_LOW: 5\.00 GiB free .* this package is 0\.00 GiB/)
    expect(s.take(kept.id)?.meta).toEqual({ name: 'kept' })
    expect(readdirSync(root)).toEqual([`${digestOf(new Uint8Array([1]))}.vsix`])
    // Bytes already staged need no new file, so they still stage.
    expect(s.stage(new Uint8Array([1]), { name: 'same' }).digest).toBe(digestOf(new Uint8Array([1])))
  })

  it('removes half a copy and says STAGING_DISK_LOW when the disk fills during the write', () => {
    const s = store()
    const kept = s.stage(new Uint8Array([9]), { name: 'kept' })
    vi.mocked(fs.writeFileSync).mockImplementationOnce((path) => {
      fs.appendFileSync(path as string, 'half')
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    })
    expect(() => s.stage(new Uint8Array([4, 5]), { name: 'new' })).toThrow(/^STAGING_DISK_LOW/)
    expect(readdirSync(root)).toEqual([`${digestOf(new Uint8Array([9]))}.vsix`])
    expect(s.take(kept.id)?.meta).toEqual({ name: 'kept' })
  })

  it('LOW-1: after a digest mismatch the same bytes stage afresh, and every card that shared the bad file says why', () => {
    const s = store()
    const bytes = new Uint8Array([3, 1, 4])
    const a = s.stage(bytes, { name: 'a' })
    const b = s.stage(bytes, { name: 'b' })
    writeFileSync(join(root, `${digestOf(bytes)}.vsix`), 'tampered')
    expect(() => s.take(a.id)).toThrow(/^STAGING_DIGEST_MISMATCH/)
    expect(() => s.take(b.id)).toThrow(/^STAGING_DIGEST_MISMATCH/)
    expect(readdirSync(root)).toEqual([])
    const again = s.stage(bytes, { name: 'again' })
    expect(readdirSync(root)).toEqual([`${digestOf(bytes)}.vsix`])
    expect(s.take(again.id)?.bytes).toEqual(bytes)
  })

  it('LOW-3: removes expired copies every 60 seconds on an unref timer, without waiting for the next use', () => {
    vi.useFakeTimers()
    try {
      const unref = vi.spyOn(globalThis, 'setInterval')
      const s = store()
      const timer = unref.mock.results.at(-1)?.value as { hasRef?: () => boolean }
      expect(timer?.hasRef?.()).toBe(false)
      const { id } = s.stage(new Uint8Array([5]), { name: 'x' })
      clock = 1001
      vi.advanceTimersByTime(60_000)
      expect(readdirSync(root)).toEqual([])
      expect(() => s.take(id)).toThrow(/^TEST_EXPIRED/)
      s.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
