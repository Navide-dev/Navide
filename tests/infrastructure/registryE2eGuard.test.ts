import { readFileSync } from 'node:fs'
import { basename, relative, resolve } from 'node:path'
import { createVitest } from 'vitest/node'
import { describe, expect, it } from 'vitest'
import { repositoryTestFiles } from '../support/testInventory'

// A test that starts the real Marketplace Registry skips without its Python
// env (marketplace/registry/.venv). Of the Vitest jobs, only Frontend tests
// installs that env and sets NAVIDE_REGISTRY_E2E_REQUIRED=1 (ci.yml), and it
// runs the unit project. A Registry test elsewhere, or one that ignores the
// flag, would skip on CI and look green.

const SELF = resolve(__filename)
// Read from the environment, not only named in a comment.
const READS_FLAG = /process\.env(\.NAVIDE_REGISTRY_E2E_REQUIRED\b|\[\s*['"]NAVIDE_REGISTRY_E2E_REQUIRED['"]\s*\])/

/** Whether a test file starts the Registry or runs from its Python env. */
function startsRegistry(source: string): boolean {
  return source.includes('registry.app:app') || (source.includes('marketplace/registry') && source.includes('.venv'))
}

/** What is wrong with one Registry test: the flag it must read, the project it must be in. */
function registryTestProblems(file: string, source: string, project: string | undefined): string[] {
  const problems: string[] = []
  if (!READS_FLAG.test(source)) {
    problems.push(`${file}: starts the Registry but never reads NAVIDE_REGISTRY_E2E_REQUIRED, so a missing env skips it`)
  }
  if (project !== 'unit') {
    problems.push(`${file}: starts the Registry in the ${project ?? 'no'} project; only the unit project runs where the Registry env is installed`)
  }
  return problems
}

describe('tests that start the Marketplace Registry', () => {
  it('read NAVIDE_REGISTRY_E2E_REQUIRED and run in the unit project', async () => {
    const root = process.cwd()
    const registryTests = repositoryTestFiles(root)
      .filter((file) => resolve(file) !== SELF)
      .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
      .filter(({ source }) => startsRegistry(source))
    // Found the ones known today, wherever they live: a scanner that finds
    // nothing checks nothing.
    expect(registryTests.map(({ file }) => basename(file))).toEqual(expect.arrayContaining([
      'pluginRegistry.e2e.test.ts',
      'pluginB2Registry.e2e.test.ts',
    ]))

    const runner = await createVitest('test', { watch: false, config: 'vitest.config.ts' })
    try {
      const owner = new Map((await runner.globTestSpecifications())
        .map((specification) => [resolve(specification.moduleId), specification.project.name]))
      const problems = registryTests.flatMap(({ file, source }) =>
        registryTestProblems(relative(root, file), source, owner.get(resolve(file))))
      expect(problems).toEqual([])
    } finally {
      await runner.close()
    }
  }, 30_000)

  it('flag a Registry test outside the unit project or without the flag', () => {
    const launch = "spawn(python, ['-m', 'uvicorn', 'registry.app:app'])"
    const env = "join(resolve(__dirname, '../../marketplace/registry'), '.venv', 'bin', 'python')"
    expect(startsRegistry(launch)).toBe(true)
    expect(startsRegistry(env)).toBe(true)
    expect(startsRegistry("// marketplace/registry/tests/test_web_identity.py")).toBe(false)
    const guarded = `${launch}\nif (process.env.NAVIDE_REGISTRY_E2E_REQUIRED === '1') throw new Error()`
    expect(registryTestProblems('a.test.ts', guarded, 'unit')).toEqual([])
    expect(registryTestProblems('a.test.ts', launch, 'unit')).toHaveLength(1)
    expect(registryTestProblems('a.test.ts', `${launch}\n// NAVIDE_REGISTRY_E2E_REQUIRED=1 makes it fail`, 'unit')).toHaveLength(1)
    expect(registryTestProblems('a.test.ts', `${launch}\nprocess.env['NAVIDE_REGISTRY_E2E_REQUIRED']`, 'unit')).toEqual([])
    expect(registryTestProblems('a.test.ts', guarded, 'artifacts')).toHaveLength(1)
    expect(registryTestProblems('a.test.ts', launch, 'artifacts')).toHaveLength(2)
  })
})
