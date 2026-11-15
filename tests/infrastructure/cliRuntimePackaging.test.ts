// The Rust CLI runtime sidecar reaches a package the way the other native
// sidecars do: a build script stages it, electron-builder copies the staged
// file into <resources>/bin, the release jobs build it before they package,
// and the backend looks for it there under the same name. Each link is a
// string in a different file; this holds them together.
//
// Windows is deliberately absent everywhere: the runtime observes nothing off
// Unix, so no Windows package carries it and no Windows job builds it.
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

type Resource = { from: string; to: string; filter?: string[] }
type Step = { name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> }
type Job = { 'runs-on'?: string; needs?: string | string[]; if?: string; env?: Record<string, string>; steps: Step[] }

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
  scripts: Record<string, string>
  build: Record<'mac' | 'linux' | 'win', { extraResources: Resource[] }>
}
const script = readFileSync('scripts/build-cli-runtime.mjs', 'utf8')
const seam = readFileSync('backend/agent_team_backend/cli_runtime.py', 'utf8')
const release = (parse(readFileSync('.github/workflows/release.yml', 'utf8')) as { jobs: Record<string, Job> }).jobs
const ci = (parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as { jobs: Record<string, Job> }).jobs

const BINARY = 'navide-cli-runtime'
const STAGED = 'build/cli-runtime'
const sidecar = (resources: Resource[]) => resources.filter((entry) => entry.from === STAGED)
const builds = (job: Job) => job.steps.filter((step) => step.run?.includes('build:cli-runtime'))
const indexOf = (job: Job, wanted: (step: Step) => boolean) => job.steps.findIndex(wanted)

describe('Rust CLI runtime sidecar packaging', () => {
  it('is staged by its build script under the name the backend looks for', () => {
    expect(pkg.scripts['build:cli-runtime']).toBe('node scripts/build-cli-runtime.mjs')
    expect(script).toContain(`const outDir = join(root, 'build', 'cli-runtime')`)
    expect(script).toContain(`const binName = '${BINARY}'`)
    expect(seam).toContain(`_BIN_NAME = "${BINARY}"`)
    // A packaged app keeps it where its other sidecars are.
    expect(seam).toContain('frozen_env.packaged_bin_dir()')
    expect(readFileSync('.gitignore', 'utf8').split('\n')).toContain(`${STAGED}/`)
  })

  it('never fails a build unless it is required, and does nothing on Windows', () => {
    expect(script).toContain(`process.env.NAVIDE_CLI_RUNTIME_REQUIRED === '1'`)
    expect(script).toMatch(/if \(process\.platform === 'win32'\) \{[^}]*process\.exit\(0\)/)
  })

  it.each(['mac', 'linux'] as const)('is copied into <resources>/bin on %s', (platform) => {
    expect(sidecar(pkg.build[platform].extraResources)).toEqual([{ from: STAGED, to: 'bin', filter: [BINARY] }])
  })

  it('is in no Windows package', () => {
    expect(sidecar(pkg.build.win.extraResources)).toEqual([])
    expect(JSON.stringify(pkg.build.win)).not.toContain(BINARY)
  })

  it.each([
    ['release-macos-arm64', '1'],
    ['release-linux-x64', '1'],
    // A dry run on a best-effort runner, as for the speech sidecar.
    ['package-linux-arm64', '0'],
  ])('is built by %s before it packages', (name, required) => {
    const job = release[name]
    const [build] = builds(job)
    expect(builds(job)).toHaveLength(1)
    expect(build.env?.NAVIDE_CLI_RUNTIME_REQUIRED).toBe(required)
    const at = job.steps.indexOf(build)
    expect(at).toBeGreaterThan(indexOf(job, (step) => Boolean(step.uses?.startsWith('dtolnay/rust-toolchain@'))))
    expect(at).toBeLessThan(indexOf(job, (step) => Boolean(step.run?.includes('electron-builder --'))))
    const cache = job.steps.find((step) => step.uses?.startsWith('Swatinem/rust-cache@'))
    expect(cache?.with?.workspaces.split('\n').map((line) => line.trim())).toContain(`native/${BINARY}`)
  })

  it('is verified as signed with the hardened runtime in the macOS release', () => {
    const verify = release['release-macos-arm64'].steps.find((step) => step.name === 'Verify signature & notarization')!
    const run = verify.run!
    expect(run).toContain(`cli_runtime_bin="\${app_path}/Contents/Resources/bin/${BINARY}"`)
    expect(run).toContain('codesign --verify --strict --verbose=2 "${cli_runtime_bin}"')
    expect(run).toContain(`codesign --display --verbose=2 "\${cli_runtime_bin}" 2>&1 | grep -q 'flags=.*runtime'`)
  })

  it('is checked inside the Linux x64 package', () => {
    const validate = release['release-linux-x64'].steps.find((step) => step.name === 'Validate release artifacts')!
    expect(validate.run).toContain(`cli_runtime="\${work}/squashfs-root/resources/bin/${BINARY}"`)
    expect(validate.run).toContain('test -x "${cli_runtime}"')
  })

  it('is built by no Windows release job', () => {
    for (const name of ['release-windows-gates', 'release-windows-x64', 'release-windows-arm64']) {
      expect(builds(release[name]), name).toEqual([])
    }
  })
})

// The script is run from a copy in a scratch root (it stages under the root
// above its own directory), with a PATH that holds no cargo or a cargo that
// fails: the staged binary of an earlier build must be gone afterwards.
describe.skipIf(process.platform === 'win32')('a build that gives up leaves no older runtime staged', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function stagedBuild(cargo: string | null, env: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'cli-runtime-build-'))
    roots.push(root)
    mkdirSync(join(root, 'scripts'))
    copyFileSync('scripts/build-cli-runtime.mjs', join(root, 'scripts', 'build-cli-runtime.mjs'))
    const staged = join(root, 'build', 'cli-runtime', BINARY)
    mkdirSync(join(root, 'build', 'cli-runtime'), { recursive: true })
    writeFileSync(staged, 'an older build')
    mkdirSync(join(root, 'bin'))
    if (cargo !== null) {
      writeFileSync(join(root, 'bin', 'cargo'), cargo)
      chmodSync(join(root, 'bin', 'cargo'), 0o755)
    }
    const done = spawnSync(process.execPath, [join(root, 'scripts', 'build-cli-runtime.mjs')], {
      env: { PATH: join(root, 'bin'), ...env },
      encoding: 'utf8',
    })
    return { done, staged }
  }

  it('removes it when cargo is missing', () => {
    const { done, staged } = stagedBuild(null)
    expect(done.status).toBe(0)
    expect(done.stderr).toContain('cargo not found')
    expect(existsSync(staged)).toBe(false)
  })

  it('removes it when the build fails', () => {
    const { done, staged } = stagedBuild('#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nexit 1\n')
    expect(done.status).toBe(0)
    expect(done.stderr).toContain('cargo build failed')
    expect(existsSync(staged)).toBe(false)
  })

  it('removes it before a required build fails', () => {
    const { done, staged } = stagedBuild(null, { NAVIDE_CLI_RUNTIME_REQUIRED: '1' })
    expect(done.status).toBe(1)
    expect(existsSync(staged)).toBe(false)
  })
})

describe('Rust CLI runtime in CI', () => {
  const job = ci['cli-runtime']
  const runs = job.steps.map((step) => step.run ?? '')

  it('builds and tests the crate, then the backend against it, on Linux and macOS', () => {
    const platforms = (job as unknown as { strategy: { matrix: { include: Array<{ platform: string }> } } }).strategy.matrix
      .include.map((leg) => leg.platform)
    expect(platforms.sort()).toEqual(['Linux', 'macOS'])
    expect(runs).toContain('cargo test --locked --manifest-path native/navide-cli-runtime/Cargo.toml')
    expect(runs).toContain('node scripts/build-cli-runtime.mjs')
    const switchedOn = runs.find((run) => run.includes('-p tests.cli_runtime_on'))
    // (A pattern, not a path string: this test reads nothing under the backend's tests.)
    expect(switchedOn).toMatch(/\/tests\/vendors /)
    // Built before any backend test runs it.
    expect(runs.indexOf('node scripts/build-cli-runtime.mjs')).toBeLessThan(runs.indexOf(switchedOn!))
  })

  it('fails rather than skips when the runtime cannot be built', () => {
    // The variable the build script and the backend tests' build helper read.
    expect(job.env?.NAVIDE_CLI_RUNTIME_REQUIRED).toBe('1')
  })

  it('keeps the crate free of warnings', () => {
    const check = job.steps.find((step) => step.run?.startsWith('cargo check '))
    expect(check?.env?.RUSTFLAGS).toBe('-D warnings')
    expect(check?.run).toContain('--all-targets')
  })

  it('is part of the required gate', () => {
    const gate = ci['lint-and-test']
    expect([gate.needs ?? []].flat()).toContain('cli-runtime')
    expect(gate.steps[0].run).toContain('check cli-runtime "$CLI_RUNTIME_RESULT" "$RUN_BACKEND"')
  })

  it('leaves the backend jobs to compile no Rust', () => {
    const suite = ci.backend.steps.find((step) => step.name === 'Complete backend suite')
    expect(suite?.env?.NAVIDE_CLI_RUNTIME_REQUIRED).toBe('0')
  })
})
