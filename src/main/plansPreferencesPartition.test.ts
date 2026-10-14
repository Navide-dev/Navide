// The legacy Plans preference migration must write into the storage partition
// the v2 Plans view reads. The view's partition is
// runtimeBinding.workspaceId = workspaceIdForPath(<registered workspace>)
// (frontendPluginManager.plansCapabilityContext), with no git-root or realpath
// step. The migration used to hash resolvePlansRootPath(realpath(workspace)),
// so for a workspace nested in a repository, or reached through a symlink, the
// seven preferences landed in a partition nothing reads and the user's filter,
// sort, grouping and pins silently reset.
//
// index.ts cannot be imported in a unit test (it boots Electron), so the
// wiring is pinned by source assertions; the premise that the two ids really
// differ for a nested workspace is checked against the real resolver.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePlansRootPath } from './plugins/plansRoot'

const indexSource = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')

function bodyOf(signature: string): string {
  const at = indexSource.indexOf(signature)
  if (at < 0) throw new Error(`${signature} not found`)
  return indexSource.slice(at, indexSource.indexOf('\n}\n', at))
}

describe('legacy Plans preference migration partition', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('a nested workspace resolves to a different root than the view binds to', () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'plans-pref-')))
    mkdirSync(join(dir, '.git'))
    const nested = join(dir, 'packages', 'app')
    mkdirSync(nested, { recursive: true })
    expect(resolvePlansRootPath(nested)).toBe(dir)
  })

  it('hashes the workspace it was given, as plansCapabilityContext does', () => {
    const body = bodyOf('async function projectPlansLegacyPreferences(')
    expect(body).toContain('frontendPluginManager.workspaceIdForPath(workspacePath)')
    expect(body).not.toContain('resolvePlansRootPath(')
  })

  it('is handed the registered workspace, not its realpath', () => {
    expect(indexSource).toContain('return projectPlansLegacyPreferences(workspacePath, projection)')
    expect(indexSource).not.toContain('projectPlansLegacyPreferences(normalizeWorkspacePath(')
  })
})
