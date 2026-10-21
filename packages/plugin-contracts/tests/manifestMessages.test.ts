import { describe, expect, it } from 'vitest'
import { parseManifestV2 } from '../src/index'

// DX-REPORT 7.4: a refusal names the value it refused and what would pass, so
// a developer does not have to read the schema to fix one field.

function manifest(): Record<string, any> {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.frontend',
    name: 'Frontend',
    version: '1.0.0',
    publisher: 'acme',
    permissions: {},
    marketplace: { description: 'A frontend fixture.', license: 'MIT' },
    contributes: { views: [{ id: 'main', kind: 'custom', location: 'main', title: 'Frontend', entry: 'frontend/main/index.html' }] },
  }
}

function refusal(change: (m: Record<string, any>) => void): string {
  const raw = manifest()
  change(raw)
  try {
    parseManifestV2(raw)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the manifest to be refused')
}

describe('manifest refusals name the value and the allowed values', () => {
  it.each([
    ['permissions.shell', (m: Record<string, any>) => { m.permissions.shell = 'sudo' }, ['"sudo"', 'allowed: allowlist, full']],
    ['permissions.scopes.fs.root', (m: Record<string, any>) => { m.permissions.scopes = { fs: { root: 'home', read: ['docs/*'] } } }, ['must be workspace or repository', '"home"']],
    ['marketplace.license', (m: Record<string, any>) => { m.marketplace.license = 'MIT/2' }, ['"MIT/2"']],
    ['marketplace.categories', (m: Record<string, any>) => { m.marketplace.categories = ['Dev Tools'] }, ['"Dev Tools"', 'a-z, 0-9']],
    ['views[].id', (m: Record<string, any>) => { m.contributes.views[0].id = 'Main' }, ['"Main"', 'a-z, 0-9']],
    ['views[].detailView', (m: Record<string, any>) => {
      m.contributes.views[0].location = 'left'
      m.contributes.views[0].detailView = 'Detail'
    }, ['"Detail"']],
    ['receives.locations', (m: Record<string, any>) => {
      m.contributes.views[0].location = 'window'
      m.contributes.views[0].receives = { protocolVersion: 1, locations: ['main'] }
    }, ['"main"', 'allowed: left, detail']],
    ['apiVersion', (m: Record<string, any>) => { m.apiVersion = 'latest' }, ['got "latest"']],
    ['publisher', (m: Record<string, any>) => {
      m.id = 'acme.frontend'
      m.publisher = 'Acme'
    }, ['"Acme"']],
    ['publisher vs id', (m: Record<string, any>) => { m.publisher = 'other' }, ['must match id namespace', '"other"', '"acme"']],
    ['extensionPack', (m: Record<string, any>) => {
      delete m.contributes
      m.extensionPack = ['Acme.Tool']
    }, ['"Acme.Tool"']],
    ['backend.methods', (m: Record<string, any>) => {
      delete m.contributes
      m.backend = { entry: 'backend/acme-backend', protocolVersion: 1, activation: 'startup', methods: ['Files.search'] }
    }, ['"Files.search"', 'for example files.search']],
  ])('%s', (_field, change, expected) => {
    const message = refusal(change)
    for (const text of expected) expect(message).toContain(text)
  })
})
