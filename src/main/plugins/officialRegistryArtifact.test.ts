import { describe, expect, it } from 'vitest'
import {
  OfficialArtifactMissingError,
  selectOfficialVersion,
  verifyOfficialArtifact,
  type RegistryExtensionDetail,
} from './officialRegistryArtifact'

const registryUrl = 'https://registry.example.invalid'

function row(version: string, extra: Partial<RegistryExtensionDetail['versions'][number]> = {}) {
  return {
    version,
    target: 'universal',
    package_digest: '0'.repeat(64),
    registry_envelope: {} as RegistryExtensionDetail['versions'][number]['registry_envelope'],
    registry_signature: '',
    yanked: false,
    ...extra,
  }
}

function detail(...versions: RegistryExtensionDetail['versions']): RegistryExtensionDetail {
  return {
    trust_metadata: {} as RegistryExtensionDetail['trust_metadata'],
    trust_metadata_signature: '',
    versions,
  }
}

describe('selectOfficialVersion', () => {
  it('returns the pinned version for the target', () => {
    expect(selectOfficialVersion(detail(row('1.0.7'), row('1.0.10')), 'navide.git', '1.0.10', 'universal', registryUrl).version)
      .toBe('1.0.10')
  })

  it('names the missing version and the versions the Registry lists', () => {
    const select = () => selectOfficialVersion(detail(row('1.0.7'), row('1.0.6')), 'navide.git', '1.0.10', 'universal', registryUrl)
    expect(select).toThrow(OfficialArtifactMissingError)
    expect(select).toThrow(
      'navide.git 1.0.10 (universal) is not on the Registry at https://registry.example.invalid; it lists 1.0.7, 1.0.6. ' +
        'Publish navide.git 1.0.10 to the Marketplace before building the App installer.',
    )
  })

  it('does not take a yanked version or another target', () => {
    const select = () => selectOfficialVersion(
      detail(row('1.0.10', { yanked: true }), row('1.0.10', { target: 'darwin-arm64' })),
      'navide.git', '1.0.10', 'universal', registryUrl,
    )
    expect(select).toThrow(/navide\.git 1\.0\.10 \(universal\) is not on the Registry/)
  })
})

describe('verifyOfficialArtifact', () => {
  it('refuses bytes whose digest differs from the Registry listing', () => {
    expect(() => verifyOfficialArtifact({
      id: 'navide.git', version: '1.0.10', target: 'universal', registryUrl,
      detail: detail(row('1.0.10')), bytes: new Uint8Array([1, 2, 3]),
      rootKeyPem: '', hostTarget: 'darwin-arm64',
    })).toThrow(/package digest [0-9a-f]{64} does not match the Registry's 0{64}/)
  })
})
