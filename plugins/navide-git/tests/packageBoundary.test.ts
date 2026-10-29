import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPluginDir } from '../../../src/main/plugins/installedPlugins'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const packageRoot = join(repositoryRoot, 'plugins/navide-git')

function sourceText(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name)
      if (entry.isDirectory()) return sourceText(path)
      return /\.(?:ts|vue)$/.test(entry.name) ? readFileSync(path, 'utf8') : ''
    })
    .join('\n')
}

describe('navide.git production package boundary', () => {
  it('declares left, paired detail, and standalone window contributions under one package identity', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'manifest.json'), 'utf8')) as {
      schemaVersion: number
      id: string
      marketplace: { icon?: string }
      permissions: { system?: string[]; shell?: string }
      contributes?: { views?: Array<{ id: string; kind: string; location: string; entry: string; icon?: string }> }
    }

    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.id).toBe('navide.git')
    expect(manifest.permissions.system).toEqual(['fs', 'ui', 'aiCli'])
    expect(manifest.permissions.shell).toBe('allowlist')
    expect(manifest.marketplace.icon).toBe('assets/git.png')
    expect(manifest.contributes?.views).toEqual([
      {
        id: 'left', kind: 'custom', location: 'left', title: 'Git', icon: 'assets/git.png',
        entry: 'frontend/left/index.html', detailView: 'branch-detail',
      },
      {
        id: 'branch-detail', kind: 'custom', location: 'detail', title: 'Branch Comparison', icon: 'assets/git.png',
        entry: 'frontend/detail/index.html', targetSchema: 'schemas/branch-comparison.json',
      },
      {
        id: 'window', kind: 'custom', location: 'window', title: 'Git', icon: 'assets/git.png',
        entry: 'frontend/window/index.html',
      },
    ])
    expect(existsSync(join(packageRoot, 'assets/git.png'))).toBe(true)
  })

  it('loads through the same Manifest v2 directory loader as third-party packages', () => {
    const scanned = loadPluginDir(packageRoot)
    expect(scanned.error).toBeUndefined()
    expect(scanned.descriptor?.id).toBe('navide.git')
    expect(scanned.descriptor?.packageVersion).toBe('1.0.0')
    expect(scanned.descriptor?.views?.map((view) => view.contributionKey)).toEqual([
      'navide.git.left',
      'navide.git.branch-detail',
      'navide.git.window',
    ])
  })

  it('owns Git source locally without a private feature package mirror', () => {
    expect(existsSync(join(packageRoot, 'src/git-feature/index.ts'))).toBe(true)
    expect(existsSync(join(packageRoot, 'src/GitWindowApp.vue'))).toBe(true)
    expect(existsSync(join(repositoryRoot, 'packages/features'))).toBe(false)
    expect(existsSync(join(repositoryRoot, 'packages/internal'))).toBe(false)
  })

  it('keeps the pure Git history presentation aligned with the recovery surface', () => {
    expect(readFileSync(join(packageRoot, 'src/components/GitHistoryModal.vue'), 'utf8')).toBe(
      readFileSync(join(repositoryRoot, 'src/renderer/src/components/GitHistoryModal.vue'), 'utf8')
    )
  })

  it('does not concatenate numeric suffixes onto CSS custom-property values', () => {
    expect(sourceText(join(packageRoot, 'src'))).not.toMatch(/var\([^)]*\)\d/)
  })

  it('uses public UI and capability seams while confining askpass to the Git transport', () => {
    const source = sourceText(join(packageRoot, 'src'))
    const useGitSource = readFileSync(join(packageRoot, 'src/composables/useGit.ts'), 'utf8')
    const rendererSource = [
      'GitLeftApp.vue',
      'GitWindowApp.vue',
      'components/GitPane.vue',
      'components/MultiRepoGit.vue',
      'mount.ts',
      'pluginSurfacePorts.ts',
    ].map((path) => readFileSync(join(packageRoot, 'src', path), 'utf8')).join('\n')
    expect(source).toContain('@navide/plugin-ui')
    expect(source).not.toContain('@navide/terminal')
    expect(source).not.toContain('@navide/plugin-shell')
    expect(source).not.toMatch(/callCapability\(['"]terminal['"]/)
    expect(rendererSource).not.toContain('git.credential_request')
    expect(rendererSource).not.toContain('git.credential_submit')
    expect(rendererSource).not.toContain('git.credential_cancel')
    expect(useGitSource).toContain("on('git.credential_request'")
    expect(useGitSource).toContain("send('git.credential_submit'")
    expect(useGitSource).toContain("send('git.credential_cancel'")
  })
})
