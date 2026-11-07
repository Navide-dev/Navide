import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = resolve(process.cwd(), 'src/renderer/src')
const v2GitHostCompositionSources = new Set(['components/ControlPane.vue', 'components/GitRecoveryPanel.vue'])

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

describe('Host Git composition', () => {
  it('routes ControlPane left contributions through the generic region host', () => {
    const controlPane = readFileSync(join(rendererRoot, 'components', 'ControlPane.vue'), 'utf8')
    expect(controlPane).toContain("import PluginRegionHost")
    expect(controlPane).toContain('<PluginRegionHost')
    expect(controlPane).toContain("import GitRecoveryPanel from './GitRecoveryPanel.vue'")
    expect(controlPane).toContain('v-if="gitPluginFailed && sidebarTab === \'git\'"')
    expect(controlPane).not.toContain('MultiRepoGit')
    expect(controlPane).not.toContain('<GitPane')
  })

  it('keeps the Git window out of the Host entry router', () => {
    const mainSource = readFileSync(join(rendererRoot, 'main.ts'), 'utf8')
    expect(mainSource).not.toMatch(/GitWindowApp/)
  })

  it('shows the recovery panel instead of any legacy Git implementation', () => {
    const directGitImplementationImport = /from ['"][^'"]*(?:GitPane|MultiRepoGit|GitHistoryModal|GitCredentialModal)\.vue['"]/
    const directImporters = collectProductionSources(rendererRoot)
      .filter((sourcePath) => v2GitHostCompositionSources.has(relative(rendererRoot, sourcePath)))
      .filter((sourcePath) => directGitImplementationImport.test(readFileSync(sourcePath, 'utf8')))
      .map((sourcePath) => relative(rendererRoot, sourcePath))

    expect(directImporters).toEqual([])
  })
})
