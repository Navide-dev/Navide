import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DISABLE_SOURCES_FILE, PluginDisableSourceStore, UNKNOWN_DISABLE_SOURCE } from './pluginDisableSource'
import { PluginDisabledStore } from './pluginDisabledStore'
import { normalizePlatformId } from '../../shared/osplat'

// NTFS reports 0o666 for every file: the owner-only mode cannot be observed there.
const hostIsWindows = normalizePlatformId(process.platform) === 'win32'
const roots: string[] = []
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'navide-disable-source-'))
  roots.push(dir)
  return dir
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('PluginDisableSourceStore', () => {
  it('keeps who disabled a package, owner-only, and forgets it on enable', () => {
    const dir = root()
    const store = new PluginDisableSourceStore(dir)
    const agent = { by: 'agent' as const, at: 1_792_108_800_000, agent: { callerKind: 'pane' as const, paneId: 'p-41', paneName: 'dev' } }
    store.set('acme.a', agent)
    store.set('acme.b', { by: 'user', at: 5, agent: null })
    expect(new PluginDisableSourceStore(dir).get('acme.a')).toEqual(agent)
    if (!hostIsWindows) expect(statSync(join(dir, DISABLE_SOURCES_FILE)).mode & 0o777).toBe(0o600)
    store.remove('acme.a')
    expect(store.get('acme.a')).toEqual(UNKNOWN_DISABLE_SOURCE)
    expect(store.get('acme.b')).toEqual({ by: 'user', at: 5, agent: null })
  })

  it('reads a missing, unreadable or malformed entry as the user, with no time', () => {
    const dir = root()
    expect(new PluginDisableSourceStore(dir).get('acme.a')).toEqual({ by: 'user', at: null, agent: null })
    writeFileSync(join(dir, DISABLE_SOURCES_FILE), '{not json')
    expect(new PluginDisableSourceStore(dir).get('acme.a')).toEqual(UNKNOWN_DISABLE_SOURCE)
    writeFileSync(join(dir, DISABLE_SOURCES_FILE), JSON.stringify({
      schemaVersion: 1,
      sources: {
        'acme.a': { by: 'agent', at: 1, agent: { callerKind: 'model', paneId: null, paneName: null } },
        'acme.b': { by: 'agent', at: 'yesterday', agent: null },
      },
    }))
    const store = new PluginDisableSourceStore(dir)
    expect(store.get('acme.a')).toEqual(UNKNOWN_DISABLE_SOURCE)
    expect(store.get('acme.b')).toEqual(UNKNOWN_DISABLE_SOURCE)
    // A malformed file is replaced whole on the next write.
    store.set('acme.c', { by: 'user', at: 1, agent: null })
    expect(JSON.parse(readFileSync(join(dir, DISABLE_SOURCES_FILE), 'utf8')).sources).toEqual({
      'acme.c': { by: 'user', at: 1, agent: null, list: 'absent' },
    })
  })

  it('reads an agent entry as the user once the Disabled list changed after it was written', () => {
    const dir = root()
    const list = new PluginDisabledStore(dir)
    list.add('acme.a')
    const store = new PluginDisableSourceStore(dir)
    const agent = { by: 'agent' as const, at: 1, agent: { callerKind: 'pane' as const, paneId: 'p-41', paneName: 'dev' } }
    store.set('acme.a', agent)
    store.set('acme.b', { by: 'user', at: 2, agent: null })
    expect(store.get('acme.a')).toEqual(agent)
    // Any later write of the list (here: off and on again, as an older Navide would).
    list.remove('acme.a')
    list.add('acme.a')
    expect(store.get('acme.a')).toEqual(UNKNOWN_DISABLE_SOURCE)
    expect(store.get('acme.b')).toEqual({ by: 'user', at: 2, agent: null })
    // An agent entry written before the list state was kept reads as the user too.
    writeFileSync(join(dir, DISABLE_SOURCES_FILE), JSON.stringify({ schemaVersion: 1, sources: { 'acme.a': agent } }))
    expect(store.get('acme.a')).toEqual(UNKNOWN_DISABLE_SOURCE)
  })
})
