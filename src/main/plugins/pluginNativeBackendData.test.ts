import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inspectNativeBackendData, removeNativeBackendData } from './pluginNativeBackendData'

// A third-party native backend keeps HOME/TMPDIR/XDG data in
// <dataRoot>/<pluginId>/. Removing a plugin may delete exactly that directory,
// never anything outside it and never through a symlink.

let base: string
let dataRoot: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'native-backend-data-'))
  dataRoot = join(base, 'plugin-native-backends', 'data')
  mkdirSync(dataRoot, { recursive: true })
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('inspectNativeBackendData', () => {
  it('reports no data when the plugin never ran a backend', () => {
    expect(inspectNativeBackendData(dataRoot, 'acme.demo')).toEqual({ exists: false, bytes: 0, path: join(dataRoot, 'acme.demo') })
  })

  it('reports the total size of files in the plugin data directory', () => {
    const dir = join(dataRoot, 'acme.demo')
    mkdirSync(join(dir, 'tmp'), { recursive: true })
    writeFileSync(join(dir, 'a.db'), 'x'.repeat(100))
    writeFileSync(join(dir, 'tmp', 'b'), 'y'.repeat(23))
    expect(inspectNativeBackendData(dataRoot, 'acme.demo')).toEqual({ exists: true, bytes: 123, path: dir })
  })

  it('does not count files reached through a symlink inside the directory', () => {
    const dir = join(dataRoot, 'acme.demo')
    mkdirSync(dir, { recursive: true })
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'big'), 'z'.repeat(1000))
    symlinkSync(outside, join(dir, 'link'))
    expect(inspectNativeBackendData(dataRoot, 'acme.demo').bytes).toBe(0)
  })

  it('treats a symlinked plugin data directory as no data', () => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(dataRoot, 'acme.demo'))
    expect(inspectNativeBackendData(dataRoot, 'acme.demo').exists).toBe(false)
  })
})

describe('removeNativeBackendData', () => {
  it('deletes only the data directory of that plugin', () => {
    mkdirSync(join(dataRoot, 'acme.demo', 'tmp'), { recursive: true })
    writeFileSync(join(dataRoot, 'acme.demo', 'state.json'), '{}')
    mkdirSync(join(dataRoot, 'acme.other'), { recursive: true })
    removeNativeBackendData(dataRoot, 'acme.demo')
    expect(existsSync(join(dataRoot, 'acme.demo'))).toBe(false)
    expect(existsSync(join(dataRoot, 'acme.other'))).toBe(true)
    expect(existsSync(dataRoot)).toBe(true)
  })

  it('is a no-op when there is no data directory', () => {
    expect(() => removeNativeBackendData(dataRoot, 'acme.demo')).not.toThrow()
  })

  it.each(['..', '.', '../outside', 'acme/../../outside', '', 'a/b', 'a\\b'])('refuses the unsafe id %j', (id) => {
    const outside = join(base, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'keep')
    expect(() => removeNativeBackendData(dataRoot, id)).toThrow(/invalid plugin id/)
    expect(existsSync(join(outside, 'keep'))).toBe(true)
    expect(existsSync(dataRoot)).toBe(true)
  })

  it('refuses a symlinked plugin data directory and leaves its target alone', () => {
    const outside = join(base, 'workspace')
    mkdirSync(outside)
    writeFileSync(join(outside, 'project.txt'), 'user file')
    symlinkSync(outside, join(dataRoot, 'acme.demo'))
    expect(() => removeNativeBackendData(dataRoot, 'acme.demo')).toThrow(/symbolic link/)
    expect(existsSync(join(outside, 'project.txt'))).toBe(true)
  })

  it('removes a symlink inside the directory without following it', () => {
    const outside = join(base, 'workspace')
    mkdirSync(outside)
    writeFileSync(join(outside, 'project.txt'), 'user file')
    mkdirSync(join(dataRoot, 'acme.demo'), { recursive: true })
    symlinkSync(outside, join(dataRoot, 'acme.demo', 'link'))
    removeNativeBackendData(dataRoot, 'acme.demo')
    expect(existsSync(join(dataRoot, 'acme.demo'))).toBe(false)
    expect(existsSync(join(outside, 'project.txt'))).toBe(true)
  })

  it('refuses when the data root itself is a symlink', () => {
    const realRoot = join(base, 'real-root')
    mkdirSync(join(realRoot, 'acme.demo'), { recursive: true })
    const linkedRoot = join(base, 'linked-root')
    symlinkSync(realRoot, linkedRoot)
    expect(() => removeNativeBackendData(linkedRoot, 'acme.demo')).toThrow(/symbolic link/)
    expect(existsSync(join(realRoot, 'acme.demo'))).toBe(true)
  })
})
