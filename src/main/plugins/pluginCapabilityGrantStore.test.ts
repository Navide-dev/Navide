import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginCapabilityGrantStore } from './pluginCapabilityGrantStore'

describe('PluginCapabilityGrantStore', () => {
  it('persists an exact package-version grant and reloads it', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-grants-'))
    try {
      const store = new PluginCapabilityGrantStore(root)
      store.set('acme.files', {
        packageVersion: '1.2.3',
        system: ['fs', 'ui'],
        shell: 'allowlist',
        storage: true,
      })

      expect(new PluginCapabilityGrantStore(root).get('acme.files', '1.2.3')).toEqual({
        packageVersion: '1.2.3',
        system: ['fs', 'ui'],
        shell: 'allowlist',
        storage: true,
      })
      expect(new PluginCapabilityGrantStore(root).get('acme.files', '1.2.4')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed for malformed persisted state and removes one plugin independently', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-grants-'))
    try {
      const store = new PluginCapabilityGrantStore(root)
      store.set('acme.one', { packageVersion: '1.0.0', system: ['fs'], storage: true })
      store.set('acme.two', { packageVersion: '2.0.0', system: ['ui'], storage: true })
      store.remove('acme.one')
      expect(store.get('acme.one', '1.0.0')).toBeNull()
      expect(store.get('acme.two', '2.0.0')).not.toBeNull()

      const file = join(root, '.navide-capability-grants.json')
      expect(readFileSync(file, 'utf8')).not.toContain('acme.one')
      writeFileSync(file, '{not-json', { mode: 0o600 })
      expect(new PluginCapabilityGrantStore(root).get('acme.two', '2.0.0')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('C2: declared executables in a grant', () => {
  it('persists the approved executables and refuses malformed ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-plugin-grants-'))
    try {
      const store = new PluginCapabilityGrantStore(root)
      store.set('acme.builder', { packageVersion: '1.0.0', system: ['fs'], shell: 'allowlist', shellExecutables: ['npm', 'terraform'], storage: true })
      expect(new PluginCapabilityGrantStore(root).get('acme.builder', '1.0.0')).toMatchObject({ shellExecutables: ['npm', 'terraform'] })

      const file = join(root, '.navide-capability-grants.json')
      for (const bad of [['/usr/bin/npm'], ['NPM'], ['npm', 'npm'], []]) {
        writeFileSync(file, JSON.stringify({
          schemaVersion: 1,
          grants: { 'acme.builder': { packageVersion: '1.0.0', system: ['fs'], shell: 'allowlist', shellExecutables: bad, storage: true } },
        }), { mode: 0o600 })
        expect(new PluginCapabilityGrantStore(root).get('acme.builder', '1.0.0'), JSON.stringify(bad)).toBeNull()
      }
      // Executables without allowlist mode are not a grant either.
      writeFileSync(file, JSON.stringify({
        schemaVersion: 1,
        grants: { 'acme.builder': { packageVersion: '1.0.0', system: ['fs'], shell: 'full', shellExecutables: ['npm'], storage: true } },
      }), { mode: 0o600 })
      expect(new PluginCapabilityGrantStore(root).get('acme.builder', '1.0.0')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
