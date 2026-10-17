import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginInstallScanStore } from './pluginInstallScanStore'
import type { ScanReport } from '../../shared/pluginDisclosureScan'

const roots: string[] = []
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'navide-install-scans-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const scan = (marker: string) => ({ schemaVersion: 1, scanner: { id: 'navide-static-scan', version: marker } }) as unknown as ScanReport

describe('PluginInstallScanStore (D-f, record only)', () => {
  it('records the install-time scan per version and reads it back', () => {
    const dir = root()
    const store = new PluginInstallScanStore(dir)
    store.record('acme.demo', '1.0.0', scan('a'))
    expect(new PluginInstallScanStore(dir).get('acme.demo', '1.0.0')).toEqual(scan('a'))
    expect(store.get('acme.demo', '2.0.0')).toBeNull()
    expect(readFileSync(join(dir, '.navide-install-scans.json'), 'utf8')).toContain('acme.demo')
  })

  it('keeps only the versions it is told are still on disk', () => {
    const store = new PluginInstallScanStore(root())
    store.record('acme.demo', '1.0.0', scan('a'))
    store.record('acme.demo', '1.1.0', scan('b'))
    store.record('acme.demo', '1.2.0', scan('c'))
    store.keepVersions('acme.demo', ['1.1.0', '1.2.0'])
    expect(store.get('acme.demo', '1.0.0')).toBeNull()
    expect(store.get('acme.demo', '1.2.0')).toEqual(scan('c'))
  })

  it('remembers which rescan digest was already noticed, once', () => {
    const store = new PluginInstallScanStore(root())
    store.record('acme.demo', '1.0.0', scan('a'))
    expect(store.noticeOnce('acme.demo', '1.0.0', 'd1')).toBe(true)
    expect(store.noticeOnce('acme.demo', '1.0.0', 'd1')).toBe(false)
    expect(store.noticeOnce('acme.demo', '1.0.0', 'd2')).toBe(true)
  })

  it('leaves nothing behind when the plugin is removed', () => {
    const store = new PluginInstallScanStore(root())
    store.record('acme.demo', '1.0.0', scan('a'))
    store.record('acme.other', '1.0.0', scan('b'))
    store.removePlugin('acme.demo')
    expect(store.get('acme.demo', '1.0.0')).toBeNull()
    expect(store.get('acme.other', '1.0.0')).toEqual(scan('b'))
    expect(store.noticeOnce('acme.demo', '1.0.0', 'd1')).toBe(false)
  })

  it('treats an unreadable file as empty and never throws', () => {
    const dir = root()
    writeFileSync(join(dir, '.navide-install-scans.json'), '{not json')
    const store = new PluginInstallScanStore(dir)
    expect(store.get('acme.demo', '1.0.0')).toBeNull()
    store.record('acme.demo', '1.0.0', scan('a'))
    expect(store.get('acme.demo', '1.0.0')).toEqual(scan('a'))
  })
})
