// The public plugin API as a contract. A method or event added or removed on
// one side only fails here, and an API change has to say which version it
// arrived in. `plugin-preload` and the SDK pin their own surfaces in their tests.

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { capabilitiesV1 } from '../../../packages/plugin-contracts/src/index'
import { PLUGIN_API_VERSION, isPluginApiSupported, pluginApiMajor } from '../../../packages/plugin-contracts/src/apiVersion'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'
import { deprecationNotice, warnDeprecatedCapability, type CapabilityDeprecation } from './pluginCapabilityDeprecation'
import { compareSemver } from './pluginManifestV2'

const repoRoot = resolve(__dirname, '../../..')
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

interface CatalogEntry {
  address: string
  since?: string
  eligibility?: string
  permission: { id: string; access?: string; scope?: string }
  deprecated?: CapabilityDeprecation
}

const methods = capabilitiesV1.methods as CatalogEntry[]
const events = capabilitiesV1.events as CatalogEntry[]
const executable = Object.values(PUBLIC_CAPABILITY_CATALOG)

describe('capability catalog', () => {
  it('lists the same methods and events as the executable Host catalog', () => {
    expect(methods.map((entry) => entry.address).sort())
      .toEqual(executable.filter((entry) => entry.kind === 'method').map((entry) => entry.address).sort())
    expect(events.map((entry) => entry.address).sort())
      .toEqual(executable.filter((entry) => entry.kind === 'event').map((entry) => entry.address).sort())
  })

  it('agrees with the Host on who may call an address, under which permission and scope', () => {
    const problems = [...methods, ...events].flatMap((entry) => {
      const host = PUBLIC_CAPABILITY_CATALOG[entry.address]
      if (!host) return []
      const eligibility = entry.eligibility ?? 'public'
      const namespace = entry.permission.access ?? entry.permission.id
      const hostScope = 'scope' in host ? host.scope : undefined
      return [
        ...(host.eligibility === eligibility ? [] : [`${entry.address}: eligibility ${eligibility} vs ${host.eligibility}`]),
        ...(host.namespace === namespace ? [] : [`${entry.address}: namespace ${namespace} vs ${host.namespace}`]),
        ...(hostScope === undefined || hostScope === entry.permission.scope ? [] : [`${entry.address}: scope ${entry.permission.scope} vs ${hostScope}`]),
      ]
    })
    expect(problems).toEqual([])
  })

  it('names the API version each entry arrived in, never a later one than this Host', () => {
    const problems = [...methods, ...events].flatMap((entry) => {
      if (typeof entry.since !== 'string' || compareSemver(entry.since, entry.since) !== 0) return [`${entry.address}: since`]
      return (compareSemver(entry.since, PLUGIN_API_VERSION) ?? 1) > 0 ? [`${entry.address}: ${entry.since} is ahead`] : []
    })
    expect(problems).toEqual([])
  })

  it('gives every deprecation a date, a version and an existing replacement', () => {
    const addresses = new Set([...methods, ...events].map((entry) => entry.address))
    const problems = [...methods, ...events].flatMap((entry) => {
      if (!entry.deprecated) return []
      const { since, removeAfter, replacement } = entry.deprecated
      return [
        ...(compareSemver(since, since) === 0 ? [] : [`${entry.address}: since`]),
        ...(/^\d{4}-\d{2}-\d{2}$/.test(removeAfter) ? [] : [`${entry.address}: removeAfter`]),
        ...(replacement === undefined || addresses.has(replacement) ? [] : [`${entry.address}: replacement ${replacement}`]),
      ]
    })
    expect(problems).toEqual([])
  })
})

describe('deprecation notices', () => {
  const deprecations = new Map<string, CapabilityDeprecation>([
    ['fs.old', { since: '1.1.0', removeAfter: '2027-05-01', replacement: 'fs.new' }],
  ])

  it('tells each plugin once per deprecated address', () => {
    expect(deprecationNotice('acme.a', 'fs.old', deprecations)).toBe(
      '[plugin] acme.a calls fs.old, deprecated since API 1.1.0 and removed after 2027-05-01; use fs.new',
    )
    expect(deprecationNotice('acme.a', 'fs.old', deprecations)).toBeNull()
    expect(deprecationNotice('acme.b', 'fs.old', deprecations)).not.toBeNull()
  })

  it('says nothing while no catalog entry is deprecated', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const entry of [...methods, ...events]) {
      if (!entry.deprecated) warnDeprecatedCapability('acme.quiet', entry.address)
    }
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('plugin API version', () => {
  it('shares its major with the public packages', () => {
    for (const name of ['plugin-contracts', 'plugin-sdk', 'plugin-ui']) {
      const { version } = readJson(join(repoRoot, 'packages', name, 'package.json'))
      expect(pluginApiMajor(version as string)).toBe(pluginApiMajor(PLUGIN_API_VERSION))
    }
  })

  it('accepts every first-party manifest', () => {
    const manifests = readdirSync(join(repoRoot, 'plugins'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(repoRoot, 'plugins', entry.name, 'manifest.json'))
      .flatMap((path) => {
        try { return [readJson(path)] } catch { return [] }
      })
    expect(manifests.length).toBeGreaterThanOrEqual(3)
    expect(manifests.filter((manifest) => !isPluginApiSupported(manifest.apiVersion as string))).toEqual([])
  })
})
