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

function fake(root: string, name: string, body: string) {
  const file = join(root, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

// Loads only fail() and host_preflight() from release.sh and runs the latter
// with fake uname, ps, sysctl and sleep first on PATH. `psRows` is what ps
// prints (pcpu then comm), the same on every sample.
function check(opts: { os?: string; psRows: string; load?: string; samples?: number }) {
  const root = mkdtempSync(join(tmpdir(), 'navide-release-preflight-'))
  roots.push(root)
  fake(root, 'uname', `echo ${opts.os ?? 'Darwin'}`)
  fake(root, 'ps', `cat <<'ROWS'\n${opts.psRows}\nROWS`)
  fake(root, 'sysctl', `echo '{ ${opts.load ?? '3.10'} 2.00 1.00 }'`)
  fake(root, 'sleep', 'exit 0')
  const program = `set -Eeuo pipefail
IFS=$'\\n\\t'
eval "$(sed -n -e '/^fail() {/,/^}/p' -e '/^FSEVENTSD_BUSY_CPU=/p' -e '/^HIGH_LOAD1=/p' -e '/^host_preflight() {/,/^}/p' "$1")"
host_preflight
echo checked`
  const result = spawnSync('/bin/bash', ['-c', program, 'test', releaseScript], {
    encoding: 'utf8',
    env: { PATH: `${root}:/usr/bin:/bin`, NAVIDE_RELEASE_PREFLIGHT_SAMPLES: String(opts.samples ?? 3) },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const QUIET = ` 2.0 /usr/sbin/fseventsd
 5.5 /System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores
 1.0 /Applications/Google Drive.app/Contents/MacOS/Google Drive
 3.0 /Applications/Google Drive.app/Contents/MacOS/Google Drive Helper
40.0 /usr/bin/node`

describe.skipIf(isWindows())('release.sh host preflight', () => {
  it('stops and asks for a restart when fseventsd stays near 100%', () => {
    const result = check({ psRows: QUIET.replace(' 2.0 /usr/sbin/fseventsd', '98.7 /usr/sbin/fseventsd') })
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('checked')
    expect(result.stderr).toContain('fseventsd stayed at 99% CPU')
    expect(result.stderr).toContain('Restart the Mac first')
    expect(result.stderr).toContain('mds_stores 6%')
    expect(result.stderr).toContain('Google Drive 4%')
    expect(result.stderr).toContain('load1 3.10')
  })

  it('reports the readings and goes on when the host is quiet', () => {
    const result = check({ psRows: QUIET })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Host check: fseventsd 2% (busy in 0/3 samples), mds_stores 6%, Google Drive 4%, load1 3.10')
    expect(result.stdout).not.toContain('WARNING')
    expect(result.stdout).toContain('checked')
  })

  it('warns but goes on when only the load is high', () => {
    const result = check({ psRows: QUIET, load: '42.50' })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('WARNING: load1 is 42.50')
    expect(result.stdout).toContain('checked')
  })

  it('does nothing off macOS', () => {
    const result = check({ os: 'Linux', psRows: '99.0 /usr/sbin/fseventsd' })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('Host check')
    expect(result.stdout).toContain('checked')
  })

  it('runs before the release is confirmed and anything changes', () => {
    const script = readFileSync(releaseScript, 'utf8')
    const call = script.indexOf('\nhost_preflight\n')
    expect(call).toBeGreaterThan(0)
    expect(call).toBeLessThan(script.indexOf('read -r confirmed'))
    expect(call).toBeLessThan(script.indexOf('node scripts/set-release-version.mjs'))
  })
})
