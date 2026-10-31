import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  apiVersionProblem,
  assertEngineCompatible,
  engineRequirement,
  isEngineCompatible,
  minNavideVersion,
} from './pluginEngineCompat'

describe('pluginEngineCompat', () => {
  it.each([
    ['^0.2.9', '0.2.9'],
    ['~0.2.9', '0.2.9'],
    ['>=0.3.0', '0.3.0'],
    ['>= 0.3.0', '0.3.0'],
    ['0.2.9', '0.2.9'],
    ['*', '0.0.0'],
    ['^1.0.0-beta.1', '1.0.0-beta.1'],
    ['latest', null],
    ['^0.2', null],
    ['<1.0.0', null],
    [undefined, null],
    [42, null],
  ])('reads %s as the floor %s', (requirement, floor) => {
    expect(minNavideVersion(requirement)).toBe(floor)
  })

  it('treats a 0.x caret as a floor so the official ^0.1.0 packages stay installable', () => {
    expect(isEngineCompatible('^0.1.0', '0.2.13')).toBe(true)
  })

  it('reports the three states', () => {
    expect(isEngineCompatible('>=0.3.0', '0.2.13')).toBe(false)
    expect(isEngineCompatible('^0.2.13', '0.2.13')).toBe(true)
    expect(isEngineCompatible('^0.3.0', '0.3.0-beta.1')).toBe(false)
    expect(isEngineCompatible(null, '0.2.13')).toBeNull()
    expect(isEngineCompatible('garbage', '0.2.13')).toBeNull()
  })

  it('reads engines.navide from a manifest-shaped value', () => {
    expect(engineRequirement({ engines: { navide: '^0.2.0' } })).toBe('^0.2.0')
    expect(engineRequirement({ engines: {} })).toBeNull()
    expect(engineRequirement({})).toBeNull()
    expect(engineRequirement(null)).toBeNull()
  })

  it('refuses only a known-incompatible requirement', () => {
    expect(() =>
      assertEngineCompatible('acme.demo', '2.0.0', { engines: { navide: '>=0.3.0' } }, '0.2.13')
    ).toThrow('acme.demo 2.0.0 requires Navide 0.3.0 or newer; this is Navide 0.2.13')
    expect(() => assertEngineCompatible('acme.demo', '1.0.0', { engines: { navide: '^0.1.0' } }, '0.2.13')).not.toThrow()
    expect(() => assertEngineCompatible('acme.demo', '1.0.0', {}, '0.2.13')).not.toThrow()
  })
})

describe('the first-party manifests', () => {
  // The bundled copies and the Registry builds come from these files. The
  // floor is the oldest Navide the build runs on (0.2.30: Git is the same
  // source as its bundled build, Mini-IDE adds only a view icon, which Hosts
  // read since 0.2.9; 0.2.35 for Plans, the App its 1.1 line first shipped
  // with), with no upper bound, so 0.3.0 keeps them.
  const appVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version as string
  const readManifest = (dir: string) =>
    JSON.parse(readFileSync(join(process.cwd(), 'plugins', dir, 'manifest.json'), 'utf8')) as {
      id: string
      version: string
      engines?: { navide?: string }
    }
  const manifests = ['navide-git', 'navide-mini-ide'].map(readManifest)

  it('navide.plans passes on this build, on 0.2.35 and on 0.3.0, and is refused below 0.2.35', () => {
    const manifest = readManifest('navide-plans')
    expect(engineRequirement(manifest)).toBe('>=0.2.35')
    for (const version of [appVersion, '0.2.35', '0.3.0']) {
      expect(() => assertEngineCompatible(manifest.id, manifest.version, manifest, version)).not.toThrow()
    }
    expect(() => assertEngineCompatible(manifest.id, manifest.version, manifest, '0.2.34'))
      .toThrow(`${manifest.id} ${manifest.version} requires Navide 0.2.35 or newer; this is Navide 0.2.34`)
  })

  it.each(manifests.map((m) => [m.id, m] as const))('%s passes on this build, on 0.2.31 and on 0.3.0', (_id, manifest) => {
    expect(engineRequirement(manifest)).toBe('>=0.2.30')
    for (const version of [appVersion, '0.2.30', '0.2.31', '0.3.0']) {
      expect(() => assertEngineCompatible(manifest.id, manifest.version, manifest, version)).not.toThrow()
    }
  })

  it.each(manifests.map((m) => [m.id, m] as const))('%s is refused, with the reason, on a Navide older than the floor', (_id, manifest) => {
    expect(isEngineCompatible(engineRequirement(manifest), '0.2.29')).toBe(false)
    expect(() => assertEngineCompatible(manifest.id, '0.2.31', manifest, '0.2.29'))
      .toThrow(`${manifest.id} 0.2.31 requires Navide 0.2.30 or newer; this is Navide 0.2.29`)
  })

  it('passes every apiVersion on the current major or an older one', () => {
    for (const apiVersion of ['^1.0.0', '~1.0.0', '1.0.0', '^1.9.0', '^0.1.0', 'not-a-range', undefined]) {
      expect(apiVersionProblem('acme.files', '1.0.0', apiVersion)).toBeNull()
      expect(() => assertEngineCompatible('acme.files', '1.0.0', { apiVersion }, '0.2.36')).not.toThrow()
    }
  })

  it('refuses a package on a newer API major', () => {
    expect(apiVersionProblem('acme.files', '2.0.0', '^2.0.0')).toBe(
      'acme.files 2.0.0 requires plugin API ^2.0.0; this Navide provides 1.0.0',
    )
    expect(() => assertEngineCompatible('acme.files', '2.0.0', { apiVersion: '~2.1.0' }, '0.2.36')).toThrow(/plugin API ~2\.1\.0/)
  })
})
