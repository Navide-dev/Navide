import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const mainSource = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')

describe('titlebar button order', () => {
  // The titlebar's right cluster sits after a flex:1 spacer, so it is pinned to
  // the window's right edge and grows leftward from there. With the plugin
  // buttons appended AFTER the gear, installing or removing a plugin widened
  // the cluster and shifted ↻ and the gear — two built-in controls moving
  // because of something unrelated to them. Leading the cluster instead lets
  // plugins grow into the empty stretch and leaves the built-ins where they
  // are with no plugins at all.
  const at = (needle: string): number => {
    const i = appSource.indexOf(needle)
    expect(i, needle).toBeGreaterThan(-1)
    return i
  }

  it('renders plugin buttons before the built-in titlebar controls', () => {
    const plugins = at('class="titlebar-plugin-actions"')
    expect(plugins).toBeLessThan(at('class="titlebar-gear"'))
    expect(plugins).toBeLessThan(at('class="titlebar-account"'))
    // Reattach too. The workspace switcher is deliberately absent from this
    // list: it left the cluster for the centred identity block, where it reads
    // as Back — see the titlebar-id test below.
    expect(plugins).toBeLessThan(at('@click="reattachThisWindow"'))
  })

  it('keeps the workspace switcher out of the right-hand cluster', () => {
    // It leads .titlebar-id, ahead of the workspace name it takes you out of.
    const id = at('class="titlebar-id"')
    const name = at('class="titlebar-name titlebar-name--ws"')
    const back = at('@click="onSwitchWorkspace"')
    expect(back).toBeGreaterThan(id)
    expect(back).toBeLessThan(name)
    expect(back).toBeLessThan(at('class="titlebar-plugin-actions"'))
  })

  it('reveals the workspace switcher only while the identity block is hovered', () => {
    // Same rule .titlebar-reveal follows. It is what keeps the button
    // clickable: the hover that shows it also swaps the name for the longer
    // path, so a permanently visible button would slide as the row re-centres.
    expect(appSource).toContain('class="titlebar-ws-btn titlebar-back"')
    expect(appSource).toMatch(/\.titlebar-back \{ display: none; \}/)
    expect(appSource).toMatch(/\.titlebar-id:hover \.titlebar-back \{ display: flex; \}/)
    // display:none has to land after .titlebar-ws-btn's display:flex — equal
    // specificity, so the later rule is the only reason it wins.
    expect(appSource.indexOf('.titlebar-back { display: none; }')).toBeGreaterThan(
      appSource.indexOf('.titlebar-ws-btn {')
    )
  })

  it('keeps the spacer that pins the cluster right', () => {
    // Without flex:1 the cluster would not be right-aligned and the order
    // above would stop meaning anything.
    expect(appSource).toMatch(/\.titlebar-spacer \{\s*flex: 1/)
  })
})

describe('generic plugin placement boot wiring', () => {
  it('imports PluginRegionHost at runtime and passes the recovery mode to ControlPane', () => {
    expect(appSource).toMatch(
      /import PluginRegionHost,\s*\{ type PluginRegionContribution \} from ['"]\.\/components\/PluginRegionHost\.vue['"]/
    )
    expect(appSource).not.toMatch(
      /import type \{ PluginRegionContribution \} from ['"]\.\/components\/PluginRegionHost\.vue['"]/,
    )
    expect(appSource).toContain(':legacy-git-recovery="legacyGitRecovery"')
  })

  it('carries the internal legacy boot flag only when recovery is enabled', () => {
    expect(mainSource).toMatch(
      /const mainBootParams: Record<string, string> = \{[\s\S]*legacy_git_recovery: '1'[\s\S]*legacy_plans_recovery: '1'/
    )
    expect(mainSource).toContain("loadWindow(win, { window: 'main', ...params, ...mainBootParams })")
  })

  it('passes the Host Plans recovery mode to ControlPane and listens for failures', () => {
    expect(appSource).toContain('legacyPlansRecovery')
    expect(appSource).toContain('onPlansRecoveryChanged')
    expect(appSource).toContain(':legacy-plans-recovery="legacyPlansRecovery"')
    // The reason travels with the event: without it the recovery panel can
    // only show a bare label, and it is what decides whether the storage
    // repair applies at all.
    expect(mainSource).toContain(
      "hostWindow.webContents.send('plans:recoveryChanged', { legacy: true, reason })"
    )
    expect(appSource).toContain(':legacy-plans-recovery-reason="legacyPlansRecoveryReason"')
    // Leaving recovery has to reach the open window as well; before
    // plans:retryV2 nothing ever sent legacy: false.
    expect(mainSource).toContain(
      "hostWindow.webContents.send('plans:recoveryChanged', { legacy: false })"
    )
  })

  it('tracks the recovery notification in both directions', () => {
    expect(appSource).toMatch(
      /const legacyGitRecovery = ref\(new URLSearchParams\(window\.location\.search\)\.get\(['"]legacy_git_recovery['"]\) === ['"]1['"]\)/
    )
    expect(appSource).toContain('onGitRecoveryChanged')
    // Leaving recovery (Extensions restores the bundled v2 package) must reach
    // the open window too; latching on true stranded it on the legacy panel.
    expect(appSource).toContain('legacyGitRecovery.value = change.legacy')
    expect(appSource).not.toContain('if (change.legacy) legacyGitRecovery.value = true')
    expect(appSource).toContain('stopGitRecoveryChanged?.()')
    expect(appSource).toContain(':legacy-git-recovery="legacyGitRecovery"')
  })

  it('uses the typed recovery listener exposed by preload', () => {
    const preloadSource = readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8')
    expect(preloadSource).toContain('onGitRecoveryChanged')
    expect(preloadSource).toMatch(/typeof payload\.legacy === ['"]boolean['"]|payload\.legacy === true/)
    expect(preloadSource).toContain('removeListener')
  })
})

describe('window plugin contributions filtering', () => {
  it('filters only navide.plans window contributions from the titlebar launcher list', () => {
    // Legacy UX spec: Plans are opened from the Plans side list into a relevant
    // Plan content window; there must be no standalone Plans-list launcher icon
    // in the top-right titlebar.
    expect(appSource).toMatch(
      /const windowPluginContributions = computed\(\(\) =>\s*pluginContributionsByLocation\.value\.window\.filter\(/
    )
    expect(appSource).toContain("contribution.pluginId !== 'navide.plans'")
    expect(appSource).toContain("contribution.contributionKey !== 'navide.plans.window'")
  })

  it('keeps programmatic v2 registration usable by passing all plugin-contributions to ControlPane', () => {
    expect(appSource).toContain(':plugin-contributions="pluginContributions"')
  })

  it('excludes navide.plans window contributions while preserving all non-Plans actions', () => {
    type TestContribution = { pluginId: string; contributionKey: string; location: string }
    const sampleContributions: TestContribution[] = [
      { pluginId: 'navide.plans', contributionKey: 'navide.plans.window', location: 'window' },
      { pluginId: 'navide.git', contributionKey: 'navide.git.window', location: 'window' },
      { pluginId: 'custom.tool', contributionKey: 'custom.tool.window', location: 'window' },
    ]
    const filtered = sampleContributions.filter(
      (c) => c.pluginId !== 'navide.plans' && c.contributionKey !== 'navide.plans.window'
    )
    expect(filtered.map((c) => c.contributionKey)).toEqual([
      'navide.git.window',
      'custom.tool.window',
    ])
  })
})

describe('plugin contribution grouping by location', () => {
  // The catalog is the Host's list of every location a manifest may declare.
  // A location without a bucket here made the grouping computed throw
  // ("Cannot read properties of undefined (reading 'push')") the moment a
  // package used it — the built-in navide.git ships a `detail` view.
  const catalogSource = readFileSync(
    resolve(process.cwd(), 'src/main/plugins/pluginContributionCatalog.ts'),
    'utf8'
  )
  const unionMembers = (source: string, pattern: RegExp): string[] => {
    const match = source.match(pattern)
    expect(match, String(pattern)).not.toBeNull()
    return [...match![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()
  }
  const catalogLocations = unionMembers(
    catalogSource,
    /export type PluginContributionLocation =([\s\S]*?)\n\n/
  )

  it('has a bucket for every location the catalog can return', () => {
    const grouped = appSource.match(
      /const grouped: Record<PluginRegionLocation, PluginRegionContribution\[\]> = \{([\s\S]*?)\}/
    )
    expect(grouped).not.toBeNull()
    const buckets = [...grouped![1].matchAll(/(\w+): \[\]/g)].map((m) => m[1]).sort()
    expect(catalogLocations).toContain('detail')
    expect(buckets).toEqual(catalogLocations)
  })

  it('declares every catalog location in the renderer and preload types', () => {
    const hostSource = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/components/PluginRegionHost.vue'),
      'utf8'
    )
    const preloadSource = readFileSync(resolve(process.cwd(), 'src/preload/index.ts'), 'utf8')
    expect(unionMembers(hostSource, /export interface PluginRegionContribution \{[\s\S]*?location: ([^\n]*)/)).toEqual(
      catalogLocations
    )
    expect(unionMembers(preloadSource, /listContributions: \(\): Promise<Array<\{[\s\S]*?location: ([^\n]*)/)).toEqual(
      catalogLocations
    )
  })

  it('never renders a detail view as a main-window region', () => {
    // A detail view is mounted only by the receiver that owns it.
    expect(appSource).not.toContain("pluginContributionsAt('detail')")
    expect(appSource).toMatch(
      /function pluginContributionsAt\(location: Exclude<PluginRegionLocation, 'left' \| 'window' \| 'detail'>\)/
    )
  })
})
