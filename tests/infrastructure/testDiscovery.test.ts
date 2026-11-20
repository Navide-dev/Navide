import { createVitest } from 'vitest/node'
import { describe, expect, it } from 'vitest'
import { assertTestOwnership, repositoryTestFiles } from '../support/testInventory'

/** Every spec a config collects, as { file, project } with the config's projects. */
async function collected(config: string): Promise<{ projects: string[]; owned: Array<{ file: string; project: string }> }> {
  const runner = await createVitest('test', { watch: false, config })
  try {
    const specifications = await runner.globTestSpecifications()
    return {
      projects: runner.projects.map((project) => project.name).sort(),
      owned: specifications.map((specification) => ({ file: specification.moduleId, project: specification.project.name })),
    }
  } finally {
    await runner.close()
  }
}

describe('test project ownership', () => {
  it('collects every repository test in exactly one required project', async () => {
    // The root config owns the Host and the workspace packages.
    const root = await collected('vitest.config.ts')
    expect(root.projects).toEqual(['artifacts', 'artifacts-heavy', 'cli', 'packages', 'unit'])
    const owned = root.owned
    expect(() => assertTestOwnership(repositoryTestFiles(process.cwd()), owned)).not.toThrow()
    expect(owned.find((entry) => entry.file.endsWith('/packages/plugin-sdk/bin/navide-plugin.test.ts'))?.project)
      .toBe('artifacts')
    expect(owned.find((entry) => entry.file.endsWith('/packages/plugin-ui/src/foundation/i18n/__tests__/locales.test.ts'))?.project)
      .toBe('packages')
    for (const [file, project] of [
      ['src/main/plugins/pluginExternalWorkspace.test.ts', 'artifacts-heavy'],
    ]) {
      expect(owned.find((entry) => entry.file.endsWith(`/${file}`))?.project).toBe(project)
    }
  }, 60_000)

  it('rejects missing, duplicated and unexpected ownership instead of silently dropping tests', () => {
    expect(() => assertTestOwnership(['/repo/a.test.ts'], [])).toThrow('Uncollected')
    expect(() => assertTestOwnership(['/repo/a.test.ts'], [
      { file: '/repo/a.test.ts', project: 'unit' },
      { file: '/repo/a.test.ts', project: 'cli' },
    ])).toThrow('Multiple projects')
    expect(() => assertTestOwnership([], [{ file: '/repo/a.test.ts', project: 'unit' }])).toThrow('Unexpected')
  })

  it('matches Windows filesystem paths with Vitest normalized module IDs', () => {
    expect(() => assertTestOwnership(['C:\\checkout\\tests\\a.test.ts'], [
      { file: 'C:/checkout/tests/a.test.ts', project: 'unit' },
    ])).not.toThrow()
    expect(() => assertTestOwnership(['C:\\checkout\\tests\\a.test.ts'], [
      { file: 'C:/checkout/tests/a.test.ts', project: 'unit' },
      { file: 'C:\\checkout\\tests\\a.test.ts', project: 'artifacts' },
    ])).toThrow('Multiple projects')
  })
})
