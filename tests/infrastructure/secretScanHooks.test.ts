import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// The pre-commit and pre-push hooks run gitleaks; a gitleaks that fails to run
// (an old version without `gitleaks git`, a bad config) must not be reported
// as a found secret, and pre-push must scan every pushed ref.
const HOOKS = resolve('.githooks')
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

/** A git repo with the hooks, and a fake gitleaks on PATH that logs each call
 *  and then runs `body`. */
function setup(body: string): { repo: string; log: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'hook-test-'))
  dirs.push(root)
  const repo = join(root, 'repo')
  const bin = join(root, 'bin')
  const log = join(root, 'calls.log')
  mkdirSync(repo)
  mkdirSync(bin)
  const git = (...args: string[]): void => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  git('init', '-q')
  for (const hook of ['pre-commit', 'pre-push']) {
    copyFileSync(join(HOOKS, hook), join(repo, hook))
    chmodSync(join(repo, hook), 0o755)
  }
  writeFileSync(join(bin, 'gitleaks'), `#!/usr/bin/env bash\necho "$*" >> "${log}"\n${body}\n`)
  chmodSync(join(bin, 'gitleaks'), 0o755)
  writeFileSync(log, '')
  return { repo, log, env: { ...shellEnvironment, PATH: `${bin}:${process.env.PATH}` } }
}

function run(repo: string, env: NodeJS.ProcessEnv, hook: string, input = '') {
  return spawnSync('bash', ['--noprofile', '--norc', join(repo, hook)], {
    cwd: repo, env, input, encoding: 'utf8', timeout: 20_000,
  })
}

// What a gitleaks too old for the `git` subcommand does: an error, exit 1.
const BROKEN = 'echo "Error: unknown command \\"git\\" for \\"gitleaks\\"" >&2; exit 1'
// A found secret: exit with the code asked for by --exit-code (default 1).
const LEAK = 'code=1; prev=""; for a in "$@"; do [ "$prev" = "--exit-code" ] && code=$a; case "$a" in --exit-code=*) code=${a#--exit-code=};; esac; prev=$a; done; exit $code'
const ZERO = '0000000000000000000000000000000000000000'

describe.skipIf(!bashAvailable)('secret scan hooks', () => {
  it('pre-commit says the scan could not run, not that it found a secret', () => {
    const { repo, env } = setup(BROKEN)
    const r = run(repo, env, 'pre-commit')
    expect(r.stderr).not.toContain('found a possible secret')
    expect(r.stderr).toContain('could not run')
  })

  it('pre-commit still stops a commit with a found secret', () => {
    const { repo, env } = setup(LEAK)
    const r = run(repo, env, 'pre-commit')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('found a possible secret')
  })

  it('pre-push says the scan could not run, not that it found a secret', () => {
    const { repo, env } = setup(BROKEN)
    const r = run(repo, env, 'pre-push', `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${ZERO}\n`)
    expect(r.stderr).not.toContain('found a possible secret')
    expect(r.stderr).toContain('could not run')
  })

  it('pre-push stops a push with a found secret', () => {
    const { repo, env } = setup(LEAK)
    const r = run(repo, env, 'pre-push', `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${ZERO}\n`)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('found a possible secret')
  })

  it('pre-push scans every ref even when gitleaks reads its stdin', () => {
    const { repo, log, env } = setup('cat > /dev/null; exit 0')
    const refs = [
      `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${ZERO}`,
      `refs/heads/b ${'2'.repeat(40)} refs/heads/b ${ZERO}`,
    ].join('\n') + '\n'
    const r = run(repo, env, 'pre-push', refs)
    expect(r.status).toBe(0)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})
