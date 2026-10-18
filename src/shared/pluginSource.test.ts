import { describe, expect, it } from 'vitest'
import { PLUGIN_SOURCES, pluginSourceFromLegacyProvenance } from './pluginSource'

describe('pluginSourceFromLegacyProvenance', () => {
  it('reads a legacy Registry install as marketplace, or prerelease for a SemVer pre-release', () => {
    expect(pluginSourceFromLegacyProvenance('official-registry', false)).toBe('marketplace')
    expect(pluginSourceFromLegacyProvenance('official-registry', true)).toBe('prerelease')
  })

  it('maps the other legacy values one to one', () => {
    expect(pluginSourceFromLegacyProvenance('developer-local-unpacked', false)).toBe('developer-unpacked')
    expect(pluginSourceFromLegacyProvenance('factory-bundled', false)).toBe('factory-bundled')
    // A pre-release version number does not turn a non-Registry package into a review state.
    expect(pluginSourceFromLegacyProvenance('factory-bundled', true)).toBe('factory-bundled')
  })

  it('takes a Registry install\'s source from its signed envelope channel when it has one', () => {
    expect(pluginSourceFromLegacyProvenance('official-registry', false, 'testplace')).toBe('testplace')
    // The version number never overrides the signed channel.
    expect(pluginSourceFromLegacyProvenance('official-registry', true, 'testplace')).toBe('testplace')
    expect(pluginSourceFromLegacyProvenance('official-registry', false, 'pre-release')).toBe('prerelease')
    expect(pluginSourceFromLegacyProvenance('official-registry', true, 'stable')).toBe('marketplace')
    // An unknown channel is not labelled as reviewed.
    expect(pluginSourceFromLegacyProvenance('official-registry', false, 'nightly')).toBeUndefined()
    // No channel: the version number decides, as before.
    expect(pluginSourceFromLegacyProvenance('official-registry', true, undefined)).toBe('prerelease')
    expect(pluginSourceFromLegacyProvenance('official-registry', false, undefined)).toBe('marketplace')
  })

  it('has no source for a package without provenance', () => {
    expect(pluginSourceFromLegacyProvenance(undefined, false)).toBeUndefined()
  })

  it('lists exactly the seven sources', () => {
    expect(PLUGIN_SOURCES).toEqual([
      'marketplace',
      'prerelease',
      'testplace',
      'local-signed',
      'local-unsigned',
      'developer-unpacked',
      'factory-bundled',
    ])
  })
})
