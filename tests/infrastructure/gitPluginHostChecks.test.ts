import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import contract from '../../src/shared/gitBridgeContract.json'
import { HOST_GIT_EVENT_TYPES, HOST_GIT_REQUEST_TYPES } from '../../src/shared/gitCompatibility'
import { OFFICIAL_PLUGIN_VERSIONS } from '../../src/main/plugins/officialPluginVersions'
import { parseManifestV2 } from '../../src/main/plugins/pluginManifestV2'

// The Host half of checks that ran inside navide.git while it lived in this
// repository (its packageBoundary, optionalPackageBoundary,
// sharedOwnershipBoundary, gitTransport.inventory and themeCallSites tests).
// The plugin half runs in Navide-dev/navide-git.

const read = (path: string): string => readFileSync(path, 'utf8')

function sourceFiles(root: string, skipTests = false): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' && skipTests ? [] : sourceFiles(path, skipTests)
    if (!/\.(?:ts|vue)$/.test(entry.name)) return []
    return skipTests && /\.(?:test|spec)\.ts$/.test(entry.name) ? [] : [path]
  })
}

describe('navide.git, Host side', () => {
  it.each([['navide-git', 'navide.git'], ['navide-mini-ide', 'navide.mini-ide'], ['navide-browser', 'navide.browser']])(
    'keeps the %s fixture at the pinned version', (dir, id) => {
      // Host tests read the pinned version's manifest (and Git's target schema)
      // from tests/fixtures/<dir>: update them with the pin.
      const manifest = JSON.parse(read(`tests/fixtures/${dir}/manifest.json`)) as { id: string; version: string }
      expect(manifest.id).toBe(id)
      expect(manifest.version).toBe(OFFICIAL_PLUGIN_VERSIONS[id])
    },
  )

  it('accepts the pinned navide.browser manifest, agent tools included', () => {
    // The Host's own parser carries the agent-tool rules navide-browser's
    // manifest test cannot run against the published plugin-contracts.
    const parsed = parseManifestV2(JSON.parse(read('tests/fixtures/navide-browser/manifest.json')) as Record<string, unknown>)
    expect(parsed.id).toBe('navide.browser')
    const backend = parsed.backend!
    expect([...new Set(backend.agentTools!.map((tool) => tool.method))].sort()).toEqual([...backend.methods].sort())
  })

  it('keeps no private feature package system', () => {
    expect(existsSync('packages/features')).toBe(false)
    expect(existsSync('packages/internal')).toBe(false)
  })

  it('keeps the Git package out of the Host build configuration', () => {
    const configs = [
      'electron.vite.config.ts',
      'vite.mini-ide.config.ts',
      'vite.plans.config.ts',
      'vitest.config.ts',
      'tsconfig.node.json',
      'tsconfig.web.json',
    ].map(read).join('\n')
    expect(configs).not.toContain('@navide/git-feature')
    expect(configs).not.toContain('navide-git')
  })

  it('ships the factory artifacts and no legacy Git bundle', () => {
    const manifest = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>
      build: { extraResources?: Array<{ from?: string }> }
    }
    const resourceSources = (manifest.build.extraResources ?? []).map((entry) => entry.from ?? '')
    expect(manifest.scripts.build).toContain('build:official-plugins')
    expect(manifest.scripts.build).not.toContain('build:git:legacy')
    expect(resourceSources).toContain('dist-plugins/mini-ide')
    expect(resourceSources).toContain('dist-plugins/plans')
    expect(resourceSources).not.toContain('dist-plugins/git')
    expect(resourceSources).toContain('dist-plugins/official-artifacts/factory-resources')
  })

  it('keeps the Host recovery inventory inside the bridge contract', () => {
    expect(HOST_GIT_REQUEST_TYPES.filter((type) => !contract.requests.includes(type))).toEqual([])
    expect([...HOST_GIT_EVENT_TYPES].sort()).toEqual(contract.events)
  })

  it('issues only contract requests and subscribes only to contract events', () => {
    // The pattern stops a type argument at a parenthesis so one call's generic
    // cannot run on into a later call.
    const requests = /\b(?:send|runWrite)\s*(?:<[^()]*?>\s*)?\(\s*['"](git\.[a-z_]+)['"]/g
    const events = /\bon\s*\(\s*['"](git\.[a-z_]+)['"]/g
    const source = sourceFiles('src/renderer/src', true).map(read).join('\n')
    const found = (pattern: RegExp) => [...new Set([...source.matchAll(pattern)].map((match) => match[1]))].sort()
    expect(found(requests).filter((type) => !contract.requests.includes(type))).toEqual([])
    expect(found(events).filter((type) => !contract.events.includes(type))).toEqual([])
  })

  it('keeps the public Vue package independent from Host implementation paths', () => {
    const offenders = sourceFiles('packages/plugin-ui/src').flatMap((path) => {
      const specifiers = [...read(path).matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
      return specifiers
        .filter((specifier) => specifier === '@navide/plugin-ui/shared' || specifier.includes('src/renderer') || specifier === 'electron')
        .map((specifier) => `${path}: ${specifier}`)
    })
    expect(offenders).toEqual([])
  })

  it('has the Plans window call loadTheme with no backend fallback', () => {
    // App.vue owns the theme and is the one legitimate caller with a fallback;
    // a plugin surface passing one would write the theme back to the Host.
    const source = read('src/renderer/src/PlanWindowApp.vue')
    expect(source).toMatch(/\bloadTheme\(/)
    expect(source.split('\n').filter((line) => /\bloadTheme\(\s*[^)\s]/.test(line))).toEqual([])
  })
})
