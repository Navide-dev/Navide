import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { persistentBackendTmpDir, prepareBackendTmpDir } from './backend-tmpdir'

// The packaged backend gets a temp directory under the data dir, which no OS
// temp cleaner sweeps (2026-11-08: macOS purged the onefile extraction under a
// running backend and every new MCP session then failed to initialize).

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'navide-backend-tmpdir-'))
  made.push(d)
  return d
}

describe('persistentBackendTmpDir', () => {
  it('lives directly under the data dir', () => {
    expect(persistentBackendTmpDir('/data/Agent-Team')).toBe(join('/data/Agent-Team', 'backend-tmp'))
  })
})

describe('prepareBackendTmpDir', () => {
  it('creates the directory, parents included, and returns it', () => {
    const dir = join(scratch(), 'nested', 'backend-tmp')
    expect(prepareBackendTmpDir(dir)).toBe(dir)
    expect(existsSync(dir)).toBe(true)
  })

  it('removes extraction directories a crashed backend left behind and nothing else', () => {
    const dir = join(scratch(), 'backend-tmp')
    mkdirSync(join(dir, '_MEI0000abcd'), { recursive: true })
    writeFileSync(join(dir, '_MEI0000abcd', 'METADATA'), 'x')
    mkdirSync(join(dir, 'other-dir'))
    writeFileSync(join(dir, 'some-file.tmp'), 'x')

    expect(prepareBackendTmpDir(dir)).toBe(dir)

    expect(existsSync(join(dir, '_MEI0000abcd'))).toBe(false)
    expect(existsSync(join(dir, 'other-dir'))).toBe(true)
    expect(existsSync(join(dir, 'some-file.tmp'))).toBe(true)
  })

  it('answers null when the directory cannot be created', () => {
    const file = join(scratch(), 'not-a-dir')
    writeFileSync(file, 'x')
    expect(prepareBackendTmpDir(join(file, 'backend-tmp'))).toBeNull()
  })
})
