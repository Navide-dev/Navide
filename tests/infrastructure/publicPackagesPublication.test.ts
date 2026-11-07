import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The three public npm packages ship together through
// scripts/publish-public-packages.sh; these are the invariants the script
// relies on, checked without building or packing anything.
const names = ['plugin-contracts', 'plugin-sdk', 'plugin-ui'] as const
type Manifest = {
  name: string; version: string; license?: string; files?: string[]; keywords?: string[]
  publishConfig?: { access?: string }; repository?: { url?: string; directory?: string }
  peerDependencies?: Record<string, string>; dependencies?: Record<string, string>; engines?: { node?: string }
}
const manifests = Object.fromEntries(
  names.map((name) => [name, JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8')) as Manifest]),
) as Record<(typeof names)[number], Manifest>
const script = 'scripts/publish-public-packages.sh'

describe('public plugin packages', () => {
  it('share one 1.x version that their peer ranges accept', () => {
    const version = manifests['plugin-contracts'].version
    expect(version).toMatch(/^1\.\d+\.\d+$/)
    for (const name of names) expect(manifests[name].version, name).toBe(version)
    expect(manifests['plugin-sdk'].peerDependencies?.['@navide/plugin-contracts']).toMatch(/^\^1\./)
    expect(manifests['plugin-ui'].peerDependencies?.['@navide/plugin-sdk']).toMatch(/^\^1\./)
  })

  it('carry the publication metadata npm shows and ship only dist (and the CLI)', () => {
    for (const name of names) {
      const manifest = manifests[name]
      expect(manifest.name).toBe(`@navide/${name}`)
      expect(manifest.license).toBe('MIT')
      expect(manifest.publishConfig?.access).toBe('public')
      expect(manifest.repository?.url).toBe('https://github.com/Navide-dev/Navide.git')
      expect(manifest.repository?.directory).toBe(`packages/${name}`)
      expect(manifest.keywords).toContain('navide')
      expect(manifest.engines?.node).toBe('>=20')
      expect(manifest.files).toContain('dist')
      expect(manifest.files).not.toContain('src')
      for (const [dependency, range] of Object.entries({ ...manifest.dependencies, ...manifest.peerDependencies })) {
        expect(range, `${name} -> ${dependency}`).not.toMatch(/^(workspace|link):/)
      }
    }
    expect(manifests['plugin-sdk'].files).toContain('bin')
  })

  it('are published by an executable script that dry-runs by default and never takes a token', () => {
    // The index records the executable bit on every platform; Windows' file mode does not.
    expect(spawnSync('git', ['ls-files', '-s', script], { encoding: 'utf8' }).stdout).toMatch(/^100755 /)
    const source = readFileSync(script, 'utf8')
    expect(spawnSync('bash', ['-n', script]).status).toBe(0)
    expect(source).toContain('--dry-run')
    expect(source).toContain('npm whoami')
    expect(source).toContain('--publish')
    expect(source).not.toMatch(/--token|NPM_TOKEN|_authToken/)
    for (const name of names) expect(source).toContain(name)
    expect(readFileSync('docs/en-US/releases.md', 'utf8')).toContain(script)
  })
})
