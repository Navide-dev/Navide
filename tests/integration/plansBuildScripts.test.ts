import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { isWindows } from '../../src/shared/osplat'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function file(root: string, relative: string, content: string): string {
  const path = join(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'navide-plans-build-'))
  roots.push(root)
  file(root, 'plugins/navide-plans/backend/plans_backend.py', '# production source\n')
  file(root, 'backend/agent_team_backend/__init__.py', '# package marker\n')
  file(root, 'backend/agent_team_backend/path_guard.py', '# shared path guard\n')
  file(root, 'backend/agent_team_backend/fs_write.py', '# shared write path\n')
  file(root, 'backend/agent_team_backend/git_security.py', '# shared Git guard\n')
  file(root, 'backend/pyproject.toml', '# build dependencies\n')
  file(root, 'backend/uv.lock', '# pinned toolchain\n')
  file(root, 'dist-plugins/navide-plans/manifest.json', JSON.stringify({ backend: { entry: 'backend/navide-plans' } }))
  file(root, 'dist-plugins/navide-plans/artifact-files.json', JSON.stringify({ files: ['manifest.json'] }))
  file(root, 'scripts/build-plans-v2-backend.mjs', readFileSync('scripts/build-plans-v2-backend.mjs', 'utf8'))
  const uv = file(root, 'bin/uv', `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync('build-calls', 'build\\n');
fs.writeFileSync('build-args', process.argv.slice(2).join('\\n'));
if (process.env.NAVIDE_TEST_FAIL_BUILD) process.exit(1);
const destination = process.argv[process.argv.indexOf('--distpath') + 1];
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, process.platform === 'win32' ? 'navide-plans.exe' : 'navide-plans'), 'MZproduction-binary');
`)
  chmodSync(uv, 0o755)
  return root
}

function build(root: string, conditional = true, environment: Record<string, string> = {}): void {
  execFileSync(process.execPath, [join(root, 'scripts/build-plans-v2-backend.mjs'), ...(conditional ? ['--if-needed'] : [])], {
    cwd: root,
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, ...environment },
    stdio: 'pipe',
  })
}

function buildCount(root: string): number {
  return readFileSync(join(root, 'build-calls'), 'utf8').trim().split('\n').length
}

// The stub `uv` is a shebang script found through PATH, which Windows'
// CreateProcess never resolves (only .com/.exe), so the real uv would run and
// parse the placeholder lock instead.
// Each build() starts the real build script and its stub uv as two Node
// processes, up to six times per test: the cost is process startup, which
// stretches with machine load, not a wait on anything that could race.
describe.skipIf(isWindows())('Plans backend build cache', { timeout: 30_000 }, () => {
  it('skips unchanged development builds and rebuilds changed inputs or missing output', () => {
    const root = fixture()
    build(root)
    build(root)
    expect(buildCount(root)).toBe(1)
    file(root, 'plugins/navide-plans/backend/plans_backend.py', '# changed production source\n')
    build(root)
    expect(buildCount(root)).toBe(2)
    file(root, 'backend/uv.lock', '# changed toolchain\n')
    build(root)
    expect(buildCount(root)).toBe(3)
    rmSync(join(root, 'dist-plugins/navide-plans/backend'), { recursive: true })
    build(root)
    expect(buildCount(root)).toBe(4)
  })

  it('rebuilds when a core module the backend bundles changes', () => {
    const root = fixture()
    build(root)
    build(root)
    expect(buildCount(root)).toBe(1)
    file(root, 'backend/agent_team_backend/path_guard.py', '# changed shared path guard\n')
    build(root)
    expect(buildCount(root)).toBe(2)
    file(root, 'backend/agent_team_backend/__init__.py', '# changed package marker\n')
    build(root)
    expect(buildCount(root)).toBe(3)
    file(root, 'backend/agent_team_backend/fs_write.py', '# changed shared write path\n')
    build(root)
    expect(buildCount(root)).toBe(4)
    file(root, 'backend/agent_team_backend/git_security.py', '# changed shared Git guard\n')
    build(root)
    expect(buildCount(root)).toBe(5)
  })

  it('lets PyInstaller import the shared path guard from the backend source tree', () => {
    const root = fixture()
    build(root)
    const args = readFileSync(join(root, 'build-args'), 'utf8').trim().split('\n')
    expect(args).toContain('--paths')
    expect(args[args.indexOf('--paths') + 1]).toBe(join(realpathSync(root), 'backend'))
  })

  it('rebuilds altered output and never caches a failed build; release builds remain unconditional', () => {
    const root = fixture()
    build(root)
    file(root, 'dist-plugins/navide-plans/backend/navide-plans', 'MZaltered-output')
    build(root)
    expect(buildCount(root)).toBe(2)
    build(root, false)
    expect(buildCount(root)).toBe(3)
    expect(() => build(root, false, { NAVIDE_TEST_FAIL_BUILD: '1' })).toThrow()
    build(root)
    expect(buildCount(root)).toBe(5)
  })
})

// The CI step under test is a /bin/sh script.
describe.skipIf(isWindows())('production Plans CI fixture exclusion', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
  const command = workflow.jobs['build-artifacts'].steps.find((step: { name?: string }) => step.name === 'Verify production Plans excludes fixtures').run as string

  function check(contamination?: 'extra' | 'replacement', fixtures = true): ReturnType<typeof spawnSync> {
    const root = fixture()
    file(root, 'dist-plugins/plans/index.html', '<html>Legacy</html>')
    file(root, 'dist-plugins/navide-plans/frontend/left/index.html', '<html>Plans</html>')
    file(root, 'dist-plugins/navide-plans/frontend/window/index.html', '<html>Plans window</html>')
    file(root, 'dist-plugins/navide-plans/manifest.json', JSON.stringify({ backend: { entry: 'backend/navide-plans' } }))
    const production = file(root, 'dist-plugins/navide-plans/backend/navide-plans', 'MZproduction-binary')
    chmodSync(production, 0o755)
    if (fixtures) {
      const packagedFixture = file(root, 'dist-test-fixtures/plans/backend/navide-plans', 'MZtest-only-fixture')
      file(root, 'dist-test-fixtures/plans/backend/navide-plans-go', 'MZtest-only-go-fixture')
      if (contamination) copyFileSync(packagedFixture, contamination === 'extra'
        ? join(root, 'dist-plugins/navide-plans/backend/copied-fixture')
        : production)
    }
    if (existsSync('scripts/verify-plans-production.mjs')) {
      copyFileSync('scripts/verify-plans-production.mjs', join(root, 'scripts/verify-plans-production.mjs'))
    }
    return spawnSync('/bin/sh', ['-ec', command], {
      cwd: root, env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }, encoding: 'utf8',
    })
  }

  it('accepts the production executable alongside separate test fixtures', () => {
    const result = check()
    expect(result.status, String(result.stderr)).toBe(0)
  })

  it.each(['extra', 'replacement'] as const)('rejects a fixture copied into the production backend (%s)', (contamination) => {
    const result = check(contamination)
    expect(result.status).not.toBe(0)
  })

  it('passes in a job that ships the artifact without building the test fixtures', () => {
    // The comparison is evidence when a fixture exists; its absence is not
    // evidence of a swap, and must not fail a job whose whole purpose is to
    // verify a shipped build.
    const result = check(undefined, false)
    expect(result.status, String(result.stderr)).toBe(0)
  })
})

// Windows packaging emits the same target-agnostic manifest entry as every
// other platform; the Host runs `<entry>.exe` there (backendEntryOnDisk). The
// verifier reads process.platform, so a preloaded module makes it see win32.
describe('production Plans verifier on a Windows build', () => {
  const windowsPlatformSource = "Object.defineProperty(process, 'platform', { value: 'win32' })"
  const asWindows = `data:text/javascript,${encodeURIComponent(windowsPlatformSource)}`

  // Bun accepts Node's `--import` flag but never applies the preload, so the
  // Windows simulation is handed to Bun as a real preload module; the payload
  // and the spawned verifier are unchanged. Node keeps the `--import` route.
  function windowsPlatformPreload(root: string): string[] {
    if (!process.versions.bun) return ['--import', asWindows]
    const preload = file(root, 'scripts/windows-platform.mjs', `${windowsPlatformSource}\n`)
    return ['--preload', preload]
  }

  function verifyWindowsBuild(entry: string, executable: string): ReturnType<typeof spawnSync> {
    const root = fixture()
    file(root, 'dist-plugins/plans/index.html', '<html>Legacy</html>')
    file(root, 'dist-plugins/navide-plans/frontend/left/index.html', '<html>Plans</html>')
    file(root, 'dist-plugins/navide-plans/frontend/window/index.html', '<html>Plans window</html>')
    file(root, 'dist-plugins/navide-plans/manifest.json', JSON.stringify({ backend: { entry } }))
    file(root, `dist-plugins/navide-plans/backend/${executable}`, 'MZproduction-binary')
    copyFileSync('scripts/verify-plans-production.mjs', join(root, 'scripts/verify-plans-production.mjs'))
    return spawnSync(process.execPath, [...windowsPlatformPreload(root), join(root, 'scripts/verify-plans-production.mjs')], {
      cwd: root, encoding: 'utf8',
    })
  }

  it('accepts the extension-less entry the build emits with its packaged .exe', () => {
    const result = verifyWindowsBuild('backend/navide-plans', 'navide-plans.exe')
    expect(result.status, String(result.stderr)).toBe(0)
  })

  it('rejects a Windows backend packaged without the .exe the Host would run', () => {
    const result = verifyWindowsBuild('backend/navide-plans', 'navide-plans')
    expect(result.status).not.toBe(0)
  })

  it('rejects a manifest that selects some other backend', () => {
    const result = verifyWindowsBuild('backend/other', 'navide-plans.exe')
    expect(result.status).not.toBe(0)
    expect(String(result.stderr)).toContain('must select its packaged backend')
  })
})

describe('release workflow verifies the Plans artifact it signs', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'))
  const macosSteps = workflow.jobs['release-macos-arm64'].steps as Array<{ name?: string; run?: string }>
  const linuxSteps = workflow.jobs['release-linux-x64'].steps as Array<{ name?: string; run?: string }>
  const buildStep = macosSteps.find((step) => step.name === 'Build, sign & notarize application')?.run ?? ''
  const verifyStep = macosSteps.find((step) => step.name === 'Verify signature & notarization')?.run ?? ''
  const linuxValidationStep = linuxSteps.find((step) => step.name === 'Validate release artifacts')?.run ?? ''

  it('runs the production Plans verifier before signing', () => {
    expect(buildStep).toContain('node scripts/verify-plans-production.mjs')
    expect(buildStep).toContain('bun run electron-builder')
    // Ahead of electron-builder: an empty backend must fail the release before
    // the notarization leg, not silently ship.
    expect(buildStep.indexOf('verify-plans-production.mjs'))
      .toBeLessThan(buildStep.indexOf('bun run electron-builder'))
  })

  it('asserts each release artifact carries its exact official Plans package backend', () => {
    expect(verifyStep).toContain('artifact_version="$(node -p "require(\'./package.json\').version")"')
    expect(verifyStep).toContain(
      'Contents/Resources/official-artifacts/navide.plans/${artifact_version}/darwin-arm64/package/backend/navide-plans',
    )
    expect(linuxValidationStep).toContain(
      'squashfs-root/resources/official-artifacts/navide.plans/${artifact_version}/linux-x64/package/backend/navide-plans',
    )
  })

  it('asserts each release artifact carries the bundled Navide Browser backend', () => {
    expect(verifyStep).toContain(
      'test -x "${app_path}/Contents/Resources/official-artifacts/navide.browser/${artifact_version}/darwin-arm64/package/backend/navide-browser"',
    )
    expect(linuxValidationStep).toContain(
      'test -x "${work}/squashfs-root/resources/official-artifacts/navide.browser/${artifact_version}/linux-x64/package/backend/navide-browser"',
    )
  })
})
