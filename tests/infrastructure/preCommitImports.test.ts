import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// pre-commit refuses a staged .ts/.vue file whose relative import is not in the
// index. Only real import statements count: a test asserting on source text
// (`toContain("import { x } from '../lib/y'")`) imports nothing.
const HOOK = resolve('.githooks', 'pre-commit')
const shellEnvironment = { ...process.env }
delete shellEnvironment.BASH_ENV
delete shellEnvironment.ENV
const bashAvailable = process.platform !== 'win32' && spawnSync('bash', ['--noprofile', '--norc', '-c', 'exit 0'], {
  env: shellEnvironment, encoding: 'utf8', timeout: 5000,
}).status === 0

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Stages `files` in a fresh repo and runs the hook; gitleaks is a no-op stub. */
function commit(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'import-hook-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  mkdirSync(repo)
  mkdirSync(bin)
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  git('init', '-q')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
    git('add', path)
  }
  copyFileSync(HOOK, join(root, 'pre-commit'))
  chmodSync(join(root, 'pre-commit'), 0o755)
  writeFileSync(join(bin, 'gitleaks'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(join(bin, 'gitleaks'), 0o755)
  return spawnSync('bash', ['--noprofile', '--norc', join(root, 'pre-commit')], {
    cwd: repo, env: { ...shellEnvironment, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8', timeout: 20_000,
  })
}

describe.skipIf(!bashAvailable)('pre-commit relative import check', () => {
  it('ignores import text inside string literals', () => {
    const r = commit({
      'src/components/__tests__/Modal.test.ts': [
        "import { expect, it } from 'vitest'",
        "it('wires the helper', () => {",
        "  expect(MODAL).toContain(\"import { dockWindowLabelKey } from '../lib/dockWindow'\")",
        "  expect(MODAL).toContain(`import { linkErrorKey } from '../lib/linkStatus'`)",
        "  expect(MODAL).toContain('await import(\"./lazy\")')",
        '})',
        '',
      ].join('\n'),
    })
    expect(r.stderr).not.toContain('not in the index')
    expect(r.status).toBe(0)
  })

  it('still refuses a real import of a module that is not staged', () => {
    const r = commit({ 'src/a.ts': "import { y } from './lib/y'\nexport const a = y\n" })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('src/a.ts -> ./lib/y')
  })

  it('catches multi-line, side-effect, re-export and dynamic imports', () => {
    const r = commit({
      'src/a.ts': [
        'import {',
        '  one,',
        '  two,',
        "} from './multi'",
        "import './side'",
        "export { three } from '../reexport'",
        "export const lazy = () => import('./dyn')",
        '',
      ].join('\n'),
    })
    expect(r.status).toBe(1)
    for (const spec of ['./multi', './side', '../reexport', './dyn']) expect(r.stderr).toContain(`src/a.ts -> ${spec}`)
  })

  it('reads a .vue file\'s script, not its template text', () => {
    const r = commit({
      'src/C.vue': [
        '<script setup lang="ts">',
        "import Child from './Child.vue'",
        '</script>',
        "<template><p>Copy it from './nowhere' and don't import './x' here</p></template>",
        '',
      ].join('\n'),
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('src/C.vue -> ./Child.vue')
    expect(r.stderr).not.toContain('./nowhere')
    expect(r.stderr).not.toContain("-> ./x")
  })

  it('passes when every imported module is staged', () => {
    const r = commit({
      'src/a.ts': "import { y } from './lib/y'\nimport type { T } from './types'\nexport const a: T = y\n",
      'src/lib/y.ts': 'export const y = 1\n',
      'src/types.d.ts': 'export type T = number\n',
    })
    expect(r.stderr).not.toContain('not in the index')
    expect(r.status).toBe(0)
  })
})
