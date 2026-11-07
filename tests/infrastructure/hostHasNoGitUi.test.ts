import { readdirSync, readFileSync } from 'node:fs'
import path, { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Git's interface belongs to the navide.git plugin (plugins/navide-git). The
// Host keeps only the generic plugin host, the backend git.* service, the
// Explorer's status badges and the notice shown when the plugin fails to
// start. A second copy of the Git interface in the Host drifted from the
// plugin and was fixed on one side only, so it must not come back: no Host
// source may carry one of the Git surfaces by name or import the plugin's
// sources.

const ROOT = join(__dirname, '..', '..')
const SCAN = ['src/renderer/src', 'src/renderer/plugins', 'src/main', 'src/preload', 'src/shared']

// The plugin-side names of the Git surfaces that used to have a Host copy.
const GIT_UI_FILES = new Set([
  'GitPane.vue',
  'GitWindowApp.vue',
  'GitLeftApp.vue',
  'MultiRepoGit.vue',
  'GitHistoryModal.vue',
  'GitCredentialModal.vue',
  'BranchDiffPane.vue',
  'ConflictPane.vue',
  'ReviewPane.vue',
  'useGit.ts',
  'useRepoDiscovery.ts',
  'useIssues.ts',
  'gitSurface.ts',
])

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(rel)
    return /\.(ts|vue)$/.test(entry.name) ? [rel] : []
  })
}

const IMPORT_SPECIFIER = /(?:from|import\()\s*['"]([^'"]+)['"]/g

describe('the Host carries no Git interface of its own', () => {
  const files = SCAN.flatMap(sources)

  it('has no Host file named after a Git surface', () => {
    expect(files.filter((file) => GIT_UI_FILES.has(path.posix.basename(file)))).toEqual([])
  })

  it('never imports a Git surface or the Git plugin sources', () => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      for (const [, specifier] of source.matchAll(IMPORT_SPECIFIER)) {
        const target = path.posix.basename(specifier!)
        const named = GIT_UI_FILES.has(target) || GIT_UI_FILES.has(`${target}.ts`)
        if (named || specifier!.includes('plugins/navide-git/')) offenders.push(`${file} -> ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
