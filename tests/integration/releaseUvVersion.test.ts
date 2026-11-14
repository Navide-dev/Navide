import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isWindows } from '../../src/shared/osplat'

const releaseScript = resolve('release.sh')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Loads only fail() and require_uv_version() from release.sh (running the
// script itself would start a release) and calls the latter with a fake `uv`
// first on PATH, or with no uv at all when `uvVersionLine` is null.
function check(uvVersionLine: string | null, minimum = '0.11.16') {
  const root = mkdtempSync(join(tmpdir(), 'navide-release-uv-'))
  roots.push(root)
  if (uvVersionLine !== null) {
    const fake = join(root, 'uv')
    writeFileSync(fake, `#!/bin/sh\necho '${uvVersionLine}'\n`)
    chmodSync(fake, 0o755)
  }
  const program = `set -Eeuo pipefail
IFS=$'\\n\\t'
eval "$(sed -n -e '/^fail() {/,/^}/p' -e '/^require_uv_version() {/,/^}/p' "$1")"
require_uv_version "$2"
echo checked`
  const result = spawnSync('/bin/bash', ['-c', program, 'test', releaseScript, minimum], {
    encoding: 'utf8',
    env: { PATH: `${root}:/usr/bin:/bin` },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe.skipIf(isWindows())('release.sh uv version check', () => {
  it('stops before the lock is rewritten when uv is older than the minimum', () => {
    const result = check('uv 0.5.9 (0652800cb 2024-12-13)')
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('checked')
    expect(result.stderr).toContain('ERROR: uv 0.5.9')
    expect(result.stderr).toContain('older than 0.11.16')
    expect(result.stderr).toContain('backend/uv.lock')
  })

  it('compares each part as a number, not as text', () => {
    expect(check('uv 0.9.30').status).toBe(1)
    expect(check('uv 0.11.2').status).toBe(1)
    expect(check('uv 0.11.100').status).toBe(0)
  })

  it('accepts the minimum itself and anything newer', () => {
    for (const line of ['uv 0.11.16 (Homebrew 2026-05-21 aarch64-apple-darwin)', 'uv 0.12.0', 'uv 1.0.0']) {
      const result = check(line)
      expect(result.status, line).toBe(0)
      expect(result.stdout).toContain('checked')
    }
  })

  it('fails clearly when uv is missing or its version cannot be read', () => {
    const missing = check(null)
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('uv not found on PATH')
    const garbled = check('something else')
    expect(garbled.status).toBe(1)
    expect(garbled.stderr).toContain('cannot read the uv version')
  })

  it('runs before the version files change and before uv lock', () => {
    const script = readFileSync(releaseScript, 'utf8')
    const checkAt = script.indexOf('require_uv_version "$MIN_UV_VERSION"')
    expect(checkAt).toBeGreaterThan(0)
    expect(checkAt).toBeLessThan(script.indexOf('node scripts/set-release-version.mjs'))
    expect(checkAt).toBeLessThan(script.indexOf('uv --project backend lock'))
  })
})
