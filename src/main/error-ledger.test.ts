import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_LEDGER_SKIP_BYTES, recordMainFault } from './error-ledger'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function entries(): Record<string, unknown>[] {
  return readFileSync(join(dir, 'logs', 'errors.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
}

describe('recordMainFault — the main process writes the shared on-disk error ledger', () => {
  it('appends one JSON line in the backend ledger format', () => {
    expect(recordMainFault('main.uncaught', 'TypeError: boom', dir)).toBe(true)
    recordMainFault('backend.crash', 'exit code 1', dir)
    const [first, second] = entries()
    expect(first).toMatchObject({ source: 'main', level: 'error', code: 'main.uncaught', message: 'TypeError: boom' })
    expect(typeof first.ts).toBe('string')
    expect(second.code).toBe('backend.crash')
  })

  it('cuts a long message', () => {
    recordMainFault('c', 'x'.repeat(10_000), dir)
    expect((entries()[0].message as string).length).toBe(2000)
  })

  it('stops writing once the file is far past the size the backend rotates at', () => {
    mkdirSync(join(dir, 'logs'))
    writeFileSync(join(dir, 'logs', 'errors.jsonl'), 'y'.repeat(MAIN_LEDGER_SKIP_BYTES + 1))
    expect(recordMainFault('c', 'm', dir)).toBe(false)
  })

  it('never throws when the directory cannot be created', () => {
    const blocker = join(dir, 'file')
    writeFileSync(blocker, '')
    expect(recordMainFault('c', 'm', blocker)).toBe(false)
  })
})
