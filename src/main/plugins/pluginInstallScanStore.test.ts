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

const cases = (JSON.parse(
  readFileSync(join(process.cwd(), 'docs/plugin-contracts/agent-tools-fixtures/scan-cases.json'), 'utf8')
) as { cases: Array<{ name: string; scan: ScanReport }> }).cases
const NAMES: Record<string, string> = { a: 'nothing-found', b: 'devmap-push-and-reads', c: 'ui-only-runs-git-push-undeclared' }
const scan = (marker: string): ScanReport => cases.find((entry) => entry.name === NAMES[marker])!.scan

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

  // Review L2 on #371: what is read back is a scan report, or no record.
  it('reads a record whose scan is not a valid report as no record', () => {
    const dir = root()
    const file = join(dir, '.navide-install-scans.json')
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      plugins: {
        'acme.bad': { '1.0.0': { scan: { schemaVersion: 1, injected: 'IGNORE' }, noticed: [] } },
        'acme.good': { '1.0.0': { scan: scan('a'), noticed: [] } },
      },
    }))
    const store = new PluginInstallScanStore(dir)
    expect(store.get('acme.bad', '1.0.0')).toBeNull()
    expect(store.noticeOnce('acme.bad', '1.0.0', 'd1')).toBe(false)
    expect(store.get('acme.good', '1.0.0')).toEqual(scan('a'))
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

// #373 follow-up: installedAt is when this id was installed since its last
// removal; recorded once, cleared on removal.
describe('PluginInstallScanStore installedAt', () => {
  it('records the first time only, and forgets it on removal', () => {
    const dir = root()
    const store = new PluginInstallScanStore(dir)
    expect(store.installedAt('acme.demo')).toBeNull()
    store.markInstalled('acme.demo', 1000)
    store.markInstalled('acme.demo', 2000)
    expect(new PluginInstallScanStore(dir).installedAt('acme.demo')).toBe(1000)
    store.record('acme.demo', '1.0.0', scan('a'))
    store.keepVersions('acme.demo', [])
    expect(store.installedAt('acme.demo')).toBe(1000)
    store.removePlugin('acme.demo')
    expect(store.installedAt('acme.demo')).toBeNull()
    store.markInstalled('acme.demo', 3000)
    expect(store.installedAt('acme.demo')).toBe(3000)
  })

  it('reads a malformed time as no record', () => {
    const dir = root()
    writeFileSync(join(dir, '.navide-install-scans.json'), JSON.stringify({ schemaVersion: 1, plugins: {}, installedAt: { 'acme.demo': 'soon', 'acme.ok': 5 } }))
    const store = new PluginInstallScanStore(dir)
    expect(store.installedAt('acme.demo')).toBeNull()
    expect(store.installedAt('acme.ok')).toBe(5)
  })
})
