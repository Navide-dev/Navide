import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
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

// Loads only fail() and run_gates() from release.sh (running the script
// itself would start a release) and runs `background -- foreground`, each a
// bash snippet.
const program = `set -Eeuo pipefail
IFS=$'\\n\\t'
eval "$(sed -n -e '/^fail() {/,/^}/p' -e '/^run_gates() {/,/^}/p' "$1")"
run_gates bash -c "$2" -- bash -c "$3"
echo after`

// Whatever the release that runs these tests chose, start from the default
// (one after the other); `overlap` opts in.
const baseEnv = { ...process.env }
delete baseEnv.NAVIDE_RELEASE_OVERLAP_GATES
const overlap = { NAVIDE_RELEASE_OVERLAP_GATES: '1' }

function concurrently(background: string, foreground: string, cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('bash', ['-c', program, 'test', releaseScript, background, foreground], {
    cwd, encoding: 'utf8', timeout: 30_000, env: { ...baseEnv, ...env },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// Each side waits for the other's marker, so this only passes when both run at once.
const meet = (mine: string, theirs: string) =>
  `touch ${mine}; for i in $(seq 200); do [ -e ${theirs} ] && exit 0; sleep 0.05; done; exit 9`

describe.skipIf(isWindows())('release.sh gates', () => {
  it('runs both at once and passes when both pass', () => {
    const cwd = scratch()
    const result = concurrently(`${meet('bg', 'fg')}; echo typecheck-output`, meet('fg', 'bg'), cwd, overlap)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('typecheck-output')
    expect(result.stdout).toContain('(exit 0)')
    expect(result.stdout).toContain('after')
  })

  it('fails when only the background command fails, after the foreground finishes', () => {
    const cwd = scratch()
    const result = concurrently('exit 3', 'sleep 0.3; touch fg-done', cwd, overlap)
    expect(result.status).toBe(1)
    expect(existsSync(join(cwd, 'fg-done'))).toBe(true)
    expect(result.stdout).toContain('(exit 3)')
    expect(result.stderr).toContain('failed (exit 3)')
    expect(result.stdout).not.toContain('after')
  })

  it('fails when only the foreground command fails, and still waits for the background one', () => {
    const cwd = scratch()
    const result = concurrently('sleep 0.5; touch bg-done', 'exit 4', cwd, overlap)
    expect(result.status).toBe(1)
    expect(existsSync(join(cwd, 'bg-done'))).toBe(true)
    expect(result.stderr).toContain('failed (exit 4)')
    expect(result.stdout).not.toContain('after')
  })

  // The background command spawns a grandchild, as `pnpm typecheck` runs its
  // chain; stopping only the recorded pid would leave the grandchild running.
  it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('stops the whole background tree on %s', async (signal, code) => {
    const cwd = scratch()
    const child = spawn('bash', ['-c', program, 'test', releaseScript, 'sleep 30 & echo $! > grandchild; wait', 'sleep 1'], {
      cwd, stdio: 'ignore', env: { ...baseEnv, ...overlap },
    })
    while (!existsSync(join(cwd, 'grandchild'))) await new Promise((resolve) => setTimeout(resolve, 20))
    child.kill(signal)
    const exit = await new Promise((resolve) => child.on('exit', (status) => resolve(status)))
    expect(exit).toBe(code)
    const grandchild = Number(readFileSync(join(cwd, 'grandchild'), 'utf8'))
    let alive = true
    for (let i = 0; i < 50 && alive; i++) {
      try { process.kill(grandchild, 0); await new Promise((resolve) => setTimeout(resolve, 20)) } catch { alive = false }
    }
    if (alive) process.kill(grandchild)
    expect(alive).toBe(false)
  })

  it.each([['unset', {}], ['0', { NAVIDE_RELEASE_OVERLAP_GATES: '0' }]] as const)('runs one after the other when the switch is %s', (_, serial) => {
    const cwd = scratch()
    // The foreground side finds the background side's marker: they did not overlap.
    const passed = concurrently('sleep 0.3; touch bg; echo typecheck-output', '[ -e bg ] && touch fg', cwd, serial)
    expect(passed.status, passed.stderr).toBe(0)
    expect(passed.stdout).toContain('typecheck-output')
    expect(existsSync(join(cwd, 'fg'))).toBe(true)
    expect(concurrently('exit 3', 'true', cwd, serial).status).not.toBe(0)
    expect(concurrently('true', 'exit 4', cwd, serial).status).not.toBe(0)
  })

  it('reports both exit codes when both fail', () => {
    const cwd = scratch()
    const result = concurrently('exit 5', 'exit 6', cwd, overlap)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('failed (exit 5)')
    expect(result.stderr).toContain('failed (exit 6)')
  })
})
