import { createVitest } from 'vitest/node'
import { describe, expect, it } from 'vitest'
import { assertTestOwnership, repositoryTestFiles } from '../support/testInventory'

describe('test project ownership', () => {
  it('collects every repository test in exactly one required project', async () => {
    const runner = await createVitest('test', { watch: false, config: 'vitest.config.ts' })
    try {
      expect(runner.projects.map((project) => project.name).sort()).toEqual(['artifacts', 'artifacts-heavy', 'cli', 'unit'])
      const specifications = await runner.globTestSpecifications()
      const owned = specifications.map((specification) => ({
        file: specification.moduleId,
        project: specification.project.name,
      }))
      expect(() => assertTestOwnership(repositoryTestFiles(process.cwd()), owned)).not.toThrow()
      expect(owned.filter(({ file }) => file.endsWith('/plugins/navide-mini-ide/tests/manifest.test.ts')))
        .toEqual([{ file: expect.any(String), project: 'artifacts' }])
      expect(owned.find((entry) => entry.file.endsWith('/packages/plugin-sdk/bin/navide-plugin.test.ts'))?.project)
        .toBe('artifacts')
      for (const file of [
        'plugins/navide-mini-ide/tests/packageBoundary.test.ts',
        'plugins/navide-plans/tests/packageBoundary.test.ts',
        'plugins/navide-git/tests/compositionBoundary.test.ts',
        'src/main/plugins/pluginExternalWorkspace.test.ts',
      ]) {
        expect(owned.find((entry) => entry.file.endsWith(`/${file}`))?.project).toBe('artifacts-heavy')
      }
    } finally {
      await runner.close()
    }
  }, 30_000)

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
