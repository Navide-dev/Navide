import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GLOBAL_STOP_FILE, PluginGlobalStopStore } from './pluginGlobalStopStore'
import { normalizePlatformId } from '../../shared/osplat'

const hostIsWindows = normalizePlatformId(process.platform) === 'win32'
const roots: string[] = []
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'navide-global-stop-'))
  roots.push(dir)
  return dir
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const record = {
  at: 7, via: 'telegram' as const, by: 'user' as const, stopped: ['acme.a', 'acme.b'],
  previous: { nativeBackends: true, agentTools: true, externalCallers: false },
}

describe('PluginGlobalStopStore (plan P3)', () => {
  it('keeps the global stop across a restart, owner-only, until it is cleared', () => {
    const dir = root()
    new PluginGlobalStopStore(dir).set(record)
    expect(new PluginGlobalStopStore(dir).get()).toEqual(record)
    if (!hostIsWindows) expect(statSync(join(dir, GLOBAL_STOP_FILE)).mode & 0o777).toBe(0o600)
    new PluginGlobalStopStore(dir).clear()
    expect(new PluginGlobalStopStore(dir).get()).toBeNull()
  })

  it('reads a missing, unreadable or malformed file as no global stop', () => {
    const dir = root()
    expect(new PluginGlobalStopStore(dir).get()).toBeNull()
    writeFileSync(join(dir, GLOBAL_STOP_FILE), '{not json')
    expect(new PluginGlobalStopStore(dir).get()).toBeNull()
    writeFileSync(join(dir, GLOBAL_STOP_FILE), JSON.stringify({ ...record, via: 'web' }))
    expect(new PluginGlobalStopStore(dir).get()).toBeNull()
  })
})
