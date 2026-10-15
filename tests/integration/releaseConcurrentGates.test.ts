import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isWindows } from '../../src/shared/osplat'

const releaseScript = resolve('release.sh')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'navide-release-gates-'))
  roots.push(root)
  return root
}

// Loads only fail() and run_concurrently() from release.sh (running the script
// itself would start a release) and runs `background -- foreground`, each a
// bash snippet.
function concurrently(background: string, foreground: string, cwd: string) {
  const program = `set -Eeuo pipefail
IFS=$'\\n\\t'
eval "$(sed -n -e '/^fail() {/,/^}/p' -e '/^run_concurrently() {/,/^}/p' "$1")"
run_concurrently bash -c "$2" -- bash -c "$3"
echo after`
  const result = spawnSync('bash', ['-c', program, 'test', releaseScript, background, foreground], {
    cwd, encoding: 'utf8', timeout: 30_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// Each side waits for the other's marker, so this only passes when both run at once.
const meet = (mine: string, theirs: string) =>
  `touch ${mine}; for i in $(seq 200); do [ -e ${theirs} ] && exit 0; sleep 0.05; done; exit 9`

describe.skipIf(isWindows())('release.sh concurrent gates', () => {
  it('runs both at once and passes when both pass', () => {
    const cwd = scratch()
    const result = concurrently(`${meet('bg', 'fg')}; echo typecheck-output`, meet('fg', 'bg'), cwd)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('typecheck-output')
    expect(result.stdout).toContain('(exit 0)')
    expect(result.stdout).toContain('after')
  })

  it('fails when only the background command fails, after the foreground finishes', () => {
    const cwd = scratch()
    const result = concurrently('exit 3', 'sleep 0.3; touch fg-done', cwd)
    expect(result.status).toBe(1)
    expect(existsSync(join(cwd, 'fg-done'))).toBe(true)
    expect(result.stdout).toContain('(exit 3)')
    expect(result.stderr).toContain('failed (exit 3)')
    expect(result.stdout).not.toContain('after')
  })

  it('fails when only the foreground command fails, and still waits for the background one', () => {
    const cwd = scratch()
    const result = concurrently('sleep 0.5; touch bg-done', 'exit 4', cwd)
    expect(result.status).toBe(1)
    expect(existsSync(join(cwd, 'bg-done'))).toBe(true)
    expect(result.stderr).toContain('failed (exit 4)')
    expect(result.stdout).not.toContain('after')
  })

  it('reports both exit codes when both fail', () => {
    const cwd = scratch()
    const result = concurrently('exit 5', 'exit 6', cwd)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('failed (exit 5)')
    expect(result.stderr).toContain('failed (exit 6)')
  })
})
