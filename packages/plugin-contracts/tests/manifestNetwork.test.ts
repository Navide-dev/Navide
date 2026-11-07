import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_NETWORK_HOSTS, V2_NETWORK_HOST, parseManifestV2 } from '../src/index'

// PR C1: `permissions.network.hosts` names the hosts a package's views may
// connect to. The parser, the JSON Schema (validate-fixtures.py) and the
// Registry (manifest_v2.py) must agree, so the normative fixtures are read here too.

const FIXTURES = join(process.cwd(), 'docs/plugin-contracts/fixtures')
const read = (group: string, name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, group, name), 'utf8'))

function manifest(hosts: unknown): Record<string, any> {
  return {
    schemaVersion: 2,
    apiVersion: '^1.0.0',
    id: 'acme.status',
    name: 'Status',
    version: '1.0.0',
    publisher: 'acme',
    permissions: { system: ['ui'], network: { hosts } },
    marketplace: { description: 'A status fixture.', license: 'MIT' },
    contributes: { views: [{ id: 'main', kind: 'custom', location: 'right', title: 'Status', entry: 'frontend/main/index.html' }] },
  }
}

function refusal(raw: unknown): string {
  try {
    parseManifestV2(raw)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the manifest to be refused')
}

describe('permissions.network', () => {
  it('keeps the declared hosts as written, and is absent when not declared', () => {
    expect(parseManifestV2(manifest(['api.github.com', '*.example.com', 'localhost', '127.0.0.1'])).permissions.network)
      .toEqual({ hosts: ['api.github.com', '*.example.com', 'localhost', '127.0.0.1'] })
    const raw = manifest(['api.github.com'])
    delete raw.permissions.network
    expect(parseManifestV2(raw).permissions).not.toHaveProperty('network')
  })

  it('parses the normative valid fixture and refuses every invalid network fixture', () => {
    expect(parseManifestV2(read('valid', 'network-hosts.json')).permissions.network)
      .toEqual({ hosts: ['api.github.com', '*.example.com', 'localhost'] })
    const invalid = readdirSync(join(FIXTURES, 'invalid')).filter((name) => name.startsWith('network-') || name === 'extension-pack-with-network.json')
    expect(invalid.length).toBeGreaterThanOrEqual(5)
    for (const name of invalid) expect(() => parseManifestV2(read('invalid', name)), name).toThrow()
  })

  it.each([
    ['a scheme', ['https://api.github.com']],
    ['a port', ['api.github.com:443']],
    ['a path', ['api.github.com/v3']],
    ['upper case', ['Api.GitHub.com']],
    ['a bare wildcard', ['*']],
    ['a wildcard inside', ['api.*.com']],
    ['a leading hyphen', ['-a.com']],
    ['a trailing dot', ['a.com.']],
    ['user info', ['me@api.github.com']],
    ['an IPv6 literal', ['[::1]']],
  ])('refuses %s, naming the host and what would pass', (_label, hosts) => {
    const message = refusal(manifest(hosts))
    expect(message).toContain('permissions.network.hosts')
    expect(message).toContain(JSON.stringify(hosts[0]))
    expect(message).toContain('api.example.com')
  })

  it('refuses an empty list, a duplicate, a non-string, more than the maximum and unknown keys', () => {
    expect(refusal(manifest([]))).toContain('1-32 item(s)')
    expect(refusal(manifest(['a.com', 'a.com']))).toContain('duplicate')
    expect(refusal(manifest(['a.com', 7]))).toContain('permissions.network.hosts[1]')
    expect(refusal(manifest(Array.from({ length: MAX_NETWORK_HOSTS + 1 }, (_, i) => `h${i}.example.com`)))).toContain('1-32 item(s)')
    const raw = manifest(['a.com'])
    raw.permissions.network.ports = [443]
    expect(refusal(raw)).toContain('permissions.network')
    const missing = manifest(['a.com'])
    delete missing.permissions.network.hosts
    expect(refusal(missing)).toContain('hosts')
  })

  it('is a permission an extension pack may not request', () => {
    const raw = manifest(['a.com'])
    delete raw.contributes
    raw.permissions = { network: { hosts: ['a.com'] } }
    raw.extensionPack = ['acme.hello']
    expect(refusal(raw)).toContain('an extension pack must not request permissions')
  })

  it('exports the host spelling the schema copies use', () => {
    const schema = JSON.parse(readFileSync(join(process.cwd(), 'packages/plugin-contracts/src/schemas/plugin-manifest-v2.schema.json'), 'utf8'))
    const pattern = new RegExp(schema.properties.permissions.properties.network.properties.hosts.items.pattern)
    for (const host of ['api.github.com', '*.example.com', 'localhost', '127.0.0.1', 'Api.github.com', 'https://x.com', 'x.com:443', '*', '-a.com']) {
      expect(V2_NETWORK_HOST.test(host), host).toBe(pattern.test(host))
    }
    expect(schema.properties.permissions.properties.network.properties.hosts.maxItems).toBe(MAX_NETWORK_HOSTS)
  })
})
