import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(process.cwd(), 'src/renderer/src')
// GitWindowApp is bundled as the navide.git plugin, so Issue 12 owns that
// composition rather than the Host entry router.
const issue12OwnedSources = new Set(['GitWindowApp.vue'])
const v2GitHostCompositionSources = new Set(['components/GitPluginHostSlot.vue'])
// EditorWindowApp remains a separate legacy editor composition; Issue 19's
// ownership boundary covers only the v2 Git left/window contribution path.

function collectProductionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory() && entry.name === '__tests__') return []
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) return collectProductionSources(entryPath)
      return entry.isFile() && /\.(ts|vue)$/.test(entry.name) ? [entryPath] : []
    })
    .sort()
}

function collectHostOwnedSources(): string[] {
  return collectProductionSources(rendererRoot)
    .filter((sourcePath) => !issue12OwnedSources.has(relative(rendererRoot, sourcePath)))
}

function gitPaneMounts(source: string): string[] {
  return [...source.matchAll(/<(?:GitPane|git-pane)\b[\s\S]*?(?:\/>|<\/(?:GitPane|git-pane)>)/g)].map(([mount]) => mount)
}

describe('Host Git composition', () => {
  it('routes ControlPane left contributions through the generic region host', () => {
    const controlPane = readFileSync(join(rendererRoot, 'components', 'ControlPane.vue'), 'utf8')
    expect(controlPane).toContain("import PluginRegionHost")
    expect(controlPane).toContain('<PluginRegionHost')
    expect(controlPane).toContain("import GitPluginHostSlot from './GitPluginHostSlot.vue'")
    expect(controlPane).toContain('v-if="legacyGitRecovery && backend && sidebarTab === \'git\'"')
    expect(controlPane).not.toContain('MultiRepoGit')
    expect(controlPane).not.toContain('<GitPane')
  })

  it('keeps the plugin-owned GitWindowApp outside the Host entry router', () => {
    const mainSource = readFileSync(join(rendererRoot, 'main.ts'), 'utf8')
    expect(mainSource).not.toMatch(/GitWindowApp/)
  })

  it('injects a GitTransport into every Host-owned GitPane mount', () => {
    const mounts = collectHostOwnedSources()
      .filter((sourcePath) => sourcePath.endsWith('.vue'))
      .flatMap((sourcePath) => gitPaneMounts(readFileSync(sourcePath, 'utf8')))

    expect(mounts.length).toBeGreaterThan(0)
    for (const mount of mounts) {
      expect(mount).toContain(':git-transport=')
    }
  })

  it('requires explicit transport composition for Host-owned Git composables', () => {
    const rawGitCall = /useGit\(\(\) => (?:props\.)?workspacePath,\s*(?:props\.)?backend\)/

    for (const sourcePath of collectHostOwnedSources()) {
      const relativePath = relative(rendererRoot, sourcePath)
      const source = readFileSync(sourcePath, 'utf8')
      expect(source, relativePath).not.toMatch(rawGitCall)
    }
  })

  it('shows the recovery panel instead of any legacy Git implementation', () => {
    const directGitImplementationImport = /from ['"][^'"]*(?:GitPane|MultiRepoGit|GitHistoryModal|GitCredentialModal)\.vue['"]/
    const slot = readFileSync(join(rendererRoot, 'components', 'GitPluginHostSlot.vue'), 'utf8')
    const directImporters = collectProductionSources(rendererRoot)
      .filter((sourcePath) => v2GitHostCompositionSources.has(relative(rendererRoot, sourcePath)))
      .filter((sourcePath) => directGitImplementationImport.test(readFileSync(sourcePath, 'utf8')))
      .map((sourcePath) => relative(rendererRoot, sourcePath))

    expect(directImporters).toEqual([])
    expect(slot).toContain("import GitRecoveryPanel from './GitRecoveryPanel.vue'")
    expect(slot).not.toContain('GitLegacyLeftFallback')
  })
})
