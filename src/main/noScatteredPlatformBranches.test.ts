import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The TS side of backend/tests/test_osplat.py::TestNoScatteredPlatformBranches.
//
// `src/shared/osplat.ts` is the one place the desktop side asks which
// operating system this is; everything else asks it for a capability
// (`isMac()`, `needsDrawnWindowControls()`, …). A module that compares
// `process.platform` itself re-derives a decision osplat already makes, and
// — the reason this is a test and not a style note — a test cannot drive
// that decision with `setPlatformId`, so its other arms are asserted only on
// the runner that happens to be that platform, or never. `menu.test.ts`
// asserted only the host's menu until menu.ts went through the seam.
//
// Not every read is a decision. Three shapes read the real value on purpose
// and are not matched here: a boundary that hands the host platform to
// osplat or to a function that takes it as a parameter
// (`platform: process.platform` into resolveBackendDataDir,
// `resolveOsCacheRoot(process.platform, …)`, preload's bridge value); a
// value that is not branched on (`${process.platform}-${process.arch}` as a
// plugin target); and the allowlisted comparisons below, which describe the
// kernel this process is actually running on and must never follow an
// injected platform id.

const REPO_ROOT = resolve(__dirname, '..', '..')
const PRODUCTION_DIRS = ['src', 'packages/plugin-contracts/src', 'packages/plugin-sdk/src', 'packages/plugin-ui/src', 'plugins/navide-git/src', 'plugins/navide-plans/src']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'dist-plugins', '.git', '__tests__'])
/** The one module allowed to ask. */
const SEAM = 'src/shared/osplat.ts'

function productionFiles(): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|vue)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name) && full !== __filename) found.push(full)
    }
  }
  for (const dir of PRODUCTION_DIRS) walk(join(REPO_ROOT, dir))
  return found.sort()
}

/**
 * A decision made on `process.platform` directly: a comparison either way
 * round, or a `switch` on it. A bare read that is passed along or
 * interpolated is not a decision and does not match.
 */
export const PLATFORM_BRANCH_RE =
  /process\.platform\s*(?:===|!==|==|!=)|(?:===|!==|==|!=)\s*process\.platform|switch\s*\(\s*process\.platform/

/**
 * Comparisons that must describe the host, not the injected platform, with
 * the reason each one stays. A ratchet: an entry that stops matching fails
 * the stale-entry test and has to be removed.
 */
export const PLATFORM_BRANCH_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'src/main/plugins/ownerOnlyJsonPersistence.ts',
    'O_NOFOLLOW and the 0o077 owner-only check are facts about the filesystem this ' +
      'process opens files on. Following an injected platform id would drop the ' +
      'no-follow flag on a real POSIX fs, or call a 0o644 file owner-only on Windows.',
  ],
  [
    'src/main/plugins/executionPolicySourceStore.ts',
    'Same O_NOFOLLOW flag as ownerOnlyJsonPersistence: a syscall flag for the real kernel.',
  ],
  [
    'src/main/plugins/workbenchSourceStore.ts',
    'The O_NOFOLLOW read copied from executionPolicySourceStore, and the same fact: a syscall flag for the real kernel.',
  ],
])

function offenders(files: string[]): Set<string> {
  const out = new Set<string>()
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).split('\\').join('/')
    if (rel === SEAM) continue
    if (PLATFORM_BRANCH_RE.test(readFileSync(file, 'utf8'))) out.add(rel)
  }
  return out
}

describe('no scattered platform branches (TS)', () => {
  it('only the seam and the allowlist decide on process.platform', () => {
    const fresh = [...offenders(productionFiles())].filter((f) => !PLATFORM_BRANCH_ALLOWLIST.has(f))
    expect(
      fresh,
      'these modules compare process.platform themselves; ask src/shared/osplat.ts ' +
        '(isMac() / isWindows() / isLinux() / platformId()) instead, so a test can drive ' +
        'every arm with setPlatformId. If the comparison genuinely describes the host ' +
        'kernel rather than a platform behaviour, allowlist it here with that reason'
    ).toEqual([])
  })

  it('has no stale allowlist entries', () => {
    const stale = [...PLATFORM_BRANCH_ALLOWLIST.keys()].filter((f) => {
      let text: string
      try {
        text = readFileSync(join(REPO_ROOT, f), 'utf8')
      } catch {
        return true
      }
      return !PLATFORM_BRANCH_RE.test(text)
    })
    expect(stale, 'already clean, drop from the allowlist').toEqual([])
  })

  it('still matches the shapes it guards, and not the three that read on purpose', () => {
    // Decisions — what the rule bans.
    expect(PLATFORM_BRANCH_RE.test("const isMac = process.platform === 'darwin'")).toBe(true)
    expect(PLATFORM_BRANCH_RE.test("if (process.platform !== 'darwin') return")).toBe(true)
    expect(PLATFORM_BRANCH_RE.test("const flag = process.platform === 'win32' ? 0 : O_NOFOLLOW")).toBe(true)
    expect(PLATFORM_BRANCH_RE.test("if ('win32' === process.platform) {")).toBe(true)
    expect(PLATFORM_BRANCH_RE.test('switch (process.platform) {')).toBe(true)
    // Boundary: the real value handed to something that takes the platform as input.
    expect(PLATFORM_BRANCH_RE.test('platform: process.platform,')).toBe(false)
    expect(PLATFORM_BRANCH_RE.test('resolveOsCacheRoot(process.platform, homedir())')).toBe(false)
    expect(PLATFORM_BRANCH_RE.test('platform: normalizePlatformId(process.platform),')).toBe(false)
    // Value: interpolated, never branched on.
    expect(PLATFORM_BRANCH_RE.test('return `${process.platform}-${process.arch}`')).toBe(false)
    // The seam's own answer.
    expect(PLATFORM_BRANCH_RE.test("if (!isMac() || win.isDestroyed()) return false")).toBe(false)
  })

  it('leaves the seam out of the scan', () => {
    // osplat.ts reads process.platform by design; if it ever compared it the
    // rule must still not fire on it.
    expect(offenders([join(REPO_ROOT, SEAM)])).toEqual(new Set())
  })
})
