import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { persistentBackendTmpDir, pluginBackendTmpDir, prepareBackendTmpDir } from './backend-tmpdir'

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

describe('pluginBackendTmpDir', () => {
  it('gives each plugin its own directory under backend-tmp/plugins', () => {
    expect(pluginBackendTmpDir('/data/Agent-Team', 'navide.plans'))
      .toBe(join('/data/Agent-Team', 'backend-tmp', 'plugins', 'navide.plans'))
  })

  it('refuses an id that is not one plain path component', () => {
    for (const id of ['', '.', '..', 'a/b', 'a\\b', `a${String.fromCharCode(0)}b`]) {
      expect(pluginBackendTmpDir('/data/Agent-Team', id)).toBeNull()
    }
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

  it('never reaches into plugins/, where plugin backends may still be running', () => {
    const dir = join(scratch(), 'backend-tmp')
    const pluginMei = join(dir, 'plugins', 'navide.plans', '_MEI0000beef')
    mkdirSync(pluginMei, { recursive: true })
    writeFileSync(join(pluginMei, 'METADATA'), 'x')

    expect(prepareBackendTmpDir(dir)).toBe(dir)

    expect(existsSync(join(pluginMei, 'METADATA'))).toBe(true)
  })

  it('only creates the directory when told not to sweep', () => {
    const dir = join(scratch(), 'navide.plans')
    mkdirSync(join(dir, '_MEI0000abcd'), { recursive: true })

    expect(prepareBackendTmpDir(dir, false)).toBe(dir)

    expect(existsSync(join(dir, '_MEI0000abcd'))).toBe(true)
  })
})
