import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createdRecordPath, trashCreatedMemoryFile } from './memoryUndoCreate'

describe('trashCreatedMemoryFile', () => {
  let root: string
  let dataDir: string
  let file: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-memory-undo-'))
    dataDir = join(root, 'data')
    file = join(root, 'home', '.codex', 'AGENTS.md')
    mkdirSync(dirname(file), { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** What `native_memory.save` writes when it creates `path`. */
  function recordCreated(path: string, text: string): string {
    const record = createdRecordPath(dataDir, path)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(
      record,
      JSON.stringify({
        path,
        created_at: 1756339100,
        size: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
        text,
      }),
    )
    return record
  }

  it('uses the key native_memory._backup_paths uses', () => {
    // hashlib.sha256("/x".encode()).hexdigest()[:32], computed in Python.
    expect(createdRecordPath('/d', '/x')).toBe(
      join('/d', 'memory-backups', 'b3d1db318671a024a7e4b433389f8820.created.json'),
    )
  })

  it('trashes an unchanged file Navide created and drops the record', async () => {
    writeFileSync(file, '# new\n')
    const record = recordCreated(file, '# new\n')
    const trash = vi.fn(async () => {})

    expect(await trashCreatedMemoryFile(dataDir, file, false, trash)).toEqual({ ok: true })
    expect(trash).toHaveBeenCalledWith(file)
    expect(existsSync(record)).toBe(false)
  })

  it('returns both texts instead of trashing a file that changed since', async () => {
    writeFileSync(file, '# new\nclaude wrote\n')
    const record = recordCreated(file, '# new\n')
    const trash = vi.fn(async () => {})

    expect(await trashCreatedMemoryFile(dataDir, file, false, trash)).toEqual({
      ok: false,
      code: 'changed',
      created: '# new\n',
      current: '# new\nclaude wrote\n',
    })
    expect(trash).not.toHaveBeenCalled()
    expect(existsSync(record)).toBe(true)

    expect(await trashCreatedMemoryFile(dataDir, file, true, trash)).toEqual({ ok: true })
    expect(trash).toHaveBeenCalledWith(file)
  })

  it('refuses a file Navide has no create record for', async () => {
    writeFileSync(file, 'theirs\n')
    const trash = vi.fn(async () => {})

    const result = await trashCreatedMemoryFile(dataDir, file, true, trash)

    expect(result).toMatchObject({ ok: false, code: 'not-created' })
    expect(trash).not.toHaveBeenCalled()
  })

  it('refuses a record that names a different path', async () => {
    const other = join(root, 'home', '.ssh', 'id_rsa')
    mkdirSync(dirname(other), { recursive: true })
    writeFileSync(other, 'secret')
    // A record stored under other's key but describing another file.
    const record = createdRecordPath(dataDir, other)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, JSON.stringify({ path: file, sha256: 'x', text: '' }))
    const trash = vi.fn(async () => {})

    const result = await trashCreatedMemoryFile(dataDir, other, true, trash)

    expect(result).toMatchObject({ ok: false, code: 'not-created' })
    expect(trash).not.toHaveBeenCalled()
  })

  it('leaves the file in place when the Trash refuses', async () => {
    writeFileSync(file, '# new\n')
    const record = recordCreated(file, '# new\n')
    const trash = vi.fn(async () => {
      throw new Error('no trash here')
    })

    const result = await trashCreatedMemoryFile(dataDir, file, false, trash)

    expect(result).toMatchObject({ ok: false, code: 'trash-failed' })
    expect((result as { error: string }).error).toContain('no trash here')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(record)).toBe(true)
  })

  it('reports a file that is already gone', async () => {
    recordCreated(file, '# new\n')
    const trash = vi.fn(async () => {})

    expect(await trashCreatedMemoryFile(dataDir, file, false, trash)).toMatchObject({
      ok: false,
      code: 'missing',
    })
    expect(trash).not.toHaveBeenCalled()
  })
})
