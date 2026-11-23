import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { computeDisclosure, diffDisclosure, type DisclosureManifestInput } from '../../shared/pluginDisclosure'
import { isUpdateAvailable } from './pluginInstaller'
import {
  bundledUpdateNeedsApproval,
  refreshBundledOfficialPlugins,
  type BundledOfficialCandidate,
  type BundledOfficialRefreshDeps,
} from './bundledOfficialRefresh'

const gitManifest = JSON.parse(readFileSync('tests/fixtures/navide-git/manifest.json', 'utf8')) as DisclosureManifestInput & {
  version: string
  permissions: { system: string[] }
}
const disclosureOf = (manifest: DisclosureManifestInput) => computeDisclosure(manifest)
const bundled: BundledOfficialCandidate = {
  id: 'navide.git',
  version: gitManifest.version,
  disclosure: disclosureOf(gitManifest),
  hasViews: true,
}
const same = { ...gitManifest, version: '9.0.0' }
const wider = { ...gitManifest, version: '9.0.0', permissions: { ...gitManifest.permissions, system: [...gitManifest.permissions.system, 'net'] } }

function deps(overrides: Partial<BundledOfficialRefreshDeps> = {}): BundledOfficialRefreshDeps & {
  commit: ReturnType<typeof vi.fn>
  discard: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
} {
  return {
    candidates: () => [bundled],
    marketplaceIsOfficial: () => true,
    newestVersion: async () => '9.0.0',
    isNewer: isUpdateAvailable,
    prepare: async () => ({ official: true, disclosure: disclosureOf(same), hasViews: true }),
    diff: diffDisclosure,
    commit: vi.fn(async () => {}),
    discard: vi.fn(),
    warn: vi.fn(),
    ...overrides,
  } as never
}

describe('refreshBundledOfficialPlugins', () => {
  it('stages a newer official version that discloses exactly what the bundled copy does', async () => {
    const d = deps()
    await expect(refreshBundledOfficialPlugins(d)).resolves.toEqual([
      { id: 'navide.git', from: gitManifest.version, to: '9.0.0', result: 'staged' },
    ])
    expect(d.commit).toHaveBeenCalledWith('navide.git')
    expect(d.discard).not.toHaveBeenCalled()
  })

  it('leaves a version that discloses more for the user, and writes nothing', async () => {
    const d = deps({ prepare: async () => ({ official: true, disclosure: disclosureOf(wider), hasViews: true }) })
    const [outcome] = await refreshBundledOfficialPlugins(d)
    expect(outcome).toMatchObject({ id: 'navide.git', to: '9.0.0', result: 'needs-approval' })
    expect(d.commit).not.toHaveBeenCalled()
    expect(d.discard).toHaveBeenCalledWith('navide.git')
  })

  it('refuses a version that is not an official package', async () => {
    const d = deps({ prepare: async () => ({ official: false, disclosure: disclosureOf(same), hasViews: true }) })
    const [outcome] = await refreshBundledOfficialPlugins(d)
    expect(outcome).toMatchObject({ result: 'failed', reason: expect.stringContaining('not an official') })
    expect(d.commit).not.toHaveBeenCalled()
    expect(d.discard).toHaveBeenCalledWith('navide.git')
  })

  it('keeps the bundled copy when the Marketplace is unreachable', async () => {
    const d = deps({ newestVersion: async () => { throw new Error('fetch failed') } })
    const [outcome] = await refreshBundledOfficialPlugins(d)
    expect(outcome).toMatchObject({ result: 'failed', reason: 'fetch failed' })
    expect(d.commit).not.toHaveBeenCalled()
    expect(d.discard).not.toHaveBeenCalled()
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('keeping the bundled copy'))
  })

  it('keeps the bundled copy when verification fails', async () => {
    const d = deps({ prepare: async () => { throw new Error('package digest mismatch') } })
    const [outcome] = await refreshBundledOfficialPlugins(d)
    expect(outcome).toMatchObject({ result: 'failed', to: '9.0.0', reason: 'package digest mismatch' })
    expect(d.commit).not.toHaveBeenCalled()
  })

  it('does nothing when the bundled version is current, or the Marketplace is not the official one', async () => {
    const current = deps({ newestVersion: async () => gitManifest.version })
    await expect(refreshBundledOfficialPlugins(current)).resolves.toEqual([
      { id: 'navide.git', from: gitManifest.version, result: 'up-to-date' },
    ])
    const older = deps({ newestVersion: async () => '0.0.1' })
    await expect(refreshBundledOfficialPlugins(older)).resolves.toMatchObject([{ result: 'up-to-date' }])
    const selfHosted = deps({ marketplaceIsOfficial: () => false })
    const candidates = vi.spyOn(selfHosted, 'candidates')
    await expect(refreshBundledOfficialPlugins(selfHosted)).resolves.toEqual([])
    expect(candidates).not.toHaveBeenCalled()
    for (const d of [current, older, selfHosted]) expect(d.commit).not.toHaveBeenCalled()
  })

  it('carries on with the next plugin when one fails', async () => {
    const browser: BundledOfficialCandidate = { ...bundled, id: 'navide.browser' }
    const d = deps({
      candidates: () => [bundled, browser],
      newestVersion: async (id) => {
        if (id === 'navide.git') throw new Error('HTTP 503')
        return '9.0.0'
      },
    })
    const outcomes = await refreshBundledOfficialPlugins(d)
    expect(outcomes.map((outcome) => [outcome.id, outcome.result])).toEqual([
      ['navide.git', 'failed'],
      ['navide.browser', 'staged'],
    ])
    expect(d.commit).toHaveBeenCalledTimes(1)
  })
})

describe('bundledUpdateNeedsApproval', () => {
  it('asks when the disclosures or views cannot be compared', () => {
    expect(bundledUpdateNeedsApproval({ ...bundled, disclosure: null }, { official: true, disclosure: disclosureOf(same), hasViews: true }, diffDisclosure))
      .toMatch(/could not be compared/)
    expect(bundledUpdateNeedsApproval(bundled, { official: true, disclosure: disclosureOf(same), hasViews: false }, diffDisclosure))
      .toMatch(/views/)
    expect(bundledUpdateNeedsApproval({ ...bundled, hasViews: undefined }, { official: true, disclosure: disclosureOf(same), hasViews: true }, diffDisclosure))
      .toMatch(/views/)
  })

  it('asks when a permission is removed, not only when one is added', () => {
    const narrower = { ...gitManifest, version: '9.0.0', permissions: { ...gitManifest.permissions, system: ['fs'] } }
    expect(bundledUpdateNeedsApproval(bundled, { official: true, disclosure: disclosureOf(narrower), hasViews: true }, diffDisclosure))
      .toMatch(/discloses something different/)
  })
})
