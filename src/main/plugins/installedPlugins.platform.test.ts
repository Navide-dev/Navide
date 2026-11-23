import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWindows, platformId, setPlatformId } from '../../shared/osplat'
import { backendEntryOnDisk, loadPluginDir } from './installedPlugins'

// The platform to restore after a test that switched it: whatever this file
// saw when it loaded — the host, or an injection from a vitest setup file.
// Restoring to the host instead silently undid that injection for every
// later test in the file (see src/shared/platformBaseline.test.ts).
const BASELINE = platformId()

const FIXTURE = join(process.cwd(), 'docs/plugin-contracts/fixtures/valid/backend-only-skills.json')
const ELF_HEADER = Buffer.from([0x7f, 0x45, 0x4c, 0x46])

describe('backend entry executability by platform', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-plugin-exec-'))
    mkdirSync(join(root, 'backend'), { recursive: true })
  })
  afterEach(() => {
    setPlatformId(BASELINE)
    rmSync(root, { recursive: true, force: true })
  })

  function writeManifest(entry: string): void {
    const manifest = JSON.parse(readFileSync(FIXTURE, 'utf8'))
    manifest.backend.entry = entry
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
  }

  describe('on Windows', () => {
    beforeEach(() => setPlatformId('win32'))

    it('resolves a bare manifest entry to its .exe and accepts it without an exec bit', () => {
      writeManifest('backend/navide-skills')
      const backendPath = join(root, 'backend', 'navide-skills.exe')
      writeFileSync(backendPath, ELF_HEADER)
      chmodSync(backendPath, 0o600)

      expect(backendEntryOnDisk('backend/navide-skills')).toBe('backend/navide-skills.exe')
      const loaded = loadPluginDir(root)
      expect(loaded.error).toBeUndefined()
      expect(loaded.activation?.backend?.entryFile).toBe(backendPath)
    })

    it('keeps an explicit .exe entry as written', () => {
      writeManifest('backend/navide-skills.exe')
      const backendPath = join(root, 'backend', 'navide-skills.exe')
      writeFileSync(backendPath, ELF_HEADER)
      chmodSync(backendPath, 0o600)

      expect(backendEntryOnDisk('backend/navide-skills.exe')).toBe('backend/navide-skills.exe')
      expect(loadPluginDir(root).activation?.backend?.entryFile).toBe(backendPath)
    })

    it('rejects an entry whose extension Windows would not execute even with an exec bit', () => {
      writeManifest('backend/navide-skills.bin')
      const backendPath = join(root, 'backend', 'navide-skills.bin')
      writeFileSync(backendPath, ELF_HEADER)
      chmodSync(backendPath, 0o700)

      const loaded = loadPluginDir(root)
      expect(loaded.error).toMatch(/not executable/)
      expect(loaded.activation).toBeUndefined()
    })

    it('activates the factory Plans package with the .exe that Windows packaging ships', () => {
      // The production manifest as the build emits it on every platform.
      writeFileSync(
        join(root, 'manifest.json'),
        readFileSync(join(process.cwd(), 'tests/fixtures/navide-plans/manifest.json'), 'utf8')
      )
      for (const view of ['left', 'window']) {
        mkdirSync(join(root, 'frontend', view), { recursive: true })
        writeFileSync(join(root, 'frontend', view, 'index.html'), '<!doctype html>')
      }
      const backendPath = join(root, 'backend', 'navide-plans.exe')
      writeFileSync(backendPath, Buffer.from('MZ'))
      chmodSync(backendPath, 0o600)

      const loaded = loadPluginDir(root)
      expect(loaded.error).toBeUndefined()
      expect(loaded.activation?.pluginId).toBe('navide.plans')
      expect(loaded.activation?.backend?.entryFile).toBe(backendPath)
    })

    it('still refuses a shebang script that merely carries the .exe name', () => {
      writeManifest('backend/navide-skills')
      writeFileSync(join(root, 'backend', 'navide-skills.exe'), '#!/bin/sh\n')

      expect(loadPluginDir(root).error).toMatch(/must not be a script/)
    })
  })

  describe.skipIf(isWindows())('on POSIX', () => {
    it('keeps the entry name and the exec-bit rule', () => {
      setPlatformId('linux')
      writeManifest('backend/navide-skills')
      const backendPath = join(root, 'backend', 'navide-skills')
      writeFileSync(backendPath, ELF_HEADER)
      chmodSync(backendPath, 0o600)

      expect(backendEntryOnDisk('backend/navide-skills')).toBe('backend/navide-skills')
      expect(loadPluginDir(root).error).toMatch(/not executable/)
      chmodSync(backendPath, 0o700)
      expect(loadPluginDir(root).activation?.backend?.entryFile).toBe(backendPath)
    })
  })
})
