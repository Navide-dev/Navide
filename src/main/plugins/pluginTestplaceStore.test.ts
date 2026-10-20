import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginTestplaceStore, testplaceJoinVia } from './pluginTestplaceStore'

describe('PluginTestplaceStore', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'navide-testplace-store-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('tells an invite from a public test code by its prefix only', () => {
    expect(testplaceJoinVia('tpi_abc')).toBe('invite')
    expect(testplaceJoinVia('tpc_abc')).toBe('code')
    expect(testplaceJoinVia('abc')).toBeNull()
    expect(testplaceJoinVia('TPI_abc')).toBeNull()
  })

  it('keeps joins and kept builds apart, for the exact digest only', () => {
    const store = new PluginTestplaceStore(root, () => new Date('2026-10-20T00:00:00Z'))
    store.recordJoin('acme.demo', 'invite')
    store.keepExpired('acme.demo', 'a'.repeat(64), '2026-10-01T00:00:00Z')
    expect(store.joinVia('acme.demo')).toBe('invite')
    expect(store.keepsExpired('acme.demo', 'a'.repeat(64))).toBe(true)
    expect(store.keepsExpired('acme.demo', 'b'.repeat(64))).toBe(false)
    expect(store.keepsExpired('acme.other', 'a'.repeat(64))).toBe(false)
    // Leaving a test keeps the kept build; removing the plugin forgets both.
    store.forgetJoin('acme.demo')
    expect(store.joinVia('acme.demo')).toBeNull()
    expect(store.keepsExpired('acme.demo', 'a'.repeat(64))).toBe(true)
    store.forget('acme.demo')
    expect(store.keepsExpired('acme.demo', 'a'.repeat(64))).toBe(false)
    if (process.platform !== 'win32') expect(statSync(join(root, '.navide-testplace.json')).mode & 0o777).toBe(0o600)
  })

  it('reads a malformed file as empty, so nothing is kept by accident', () => {
    writeFileSync(join(root, '.navide-testplace.json'), JSON.stringify({
      schemaVersion: 1, joins: {}, keptExpired: { 'acme.demo': { artifactDigest: 'a'.repeat(64) } },
    }))
    const store = new PluginTestplaceStore(root)
    expect(store.keepsExpired('acme.demo', 'a'.repeat(64))).toBe(false)
    store.recordJoin('acme.demo', 'code')
    expect(JSON.parse(readFileSync(join(root, '.navide-testplace.json'), 'utf8'))).toMatchObject({
      joins: { 'acme.demo': { via: 'code' } }, keptExpired: {},
    })
  })
})
