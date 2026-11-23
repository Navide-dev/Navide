import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
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

// navide.plans is built in its own repository; the build stages the pinned
// version for this host's target under official-artifacts, where the
// production verifier reads it.
const pinnedPlans = /'navide\.plans': '([^']+)'/.exec(readFileSync('src/main/plugins/officialPluginVersions.ts', 'utf8'))![1]

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'navide-plans-build-'))
  roots.push(root)
  file(root, 'src/main/plugins/officialPluginVersions.ts', readFileSync('src/main/plugins/officialPluginVersions.ts', 'utf8'))
  mkdirSync(join(root, 'scripts'), { recursive: true })
  return root
}

function stagedPlans(target = `${process.platform}-${process.arch}`): string {
  return `dist-plugins/official-artifacts/factory-resources/navide.plans/${pinnedPlans}/${target}/package`
}

// The CI step under test is a /bin/sh script.
describe.skipIf(isWindows())('production Plans CI fixture exclusion', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
  const command = workflow.jobs['build-artifacts'].steps.find((step: { name?: string }) => step.name === 'Verify production Plans excludes fixtures').run as string

  function check(contamination?: 'extra' | 'replacement', fixtures = true): ReturnType<typeof spawnSync> {
    const root = fixture()
    file(root, 'dist-plugins/plans/index.html', '<html>Legacy</html>')
    const staged = stagedPlans()
    file(root, `${staged}/frontend/left/index.html`, '<html>Plans</html>')
    file(root, `${staged}/frontend/window/index.html`, '<html>Plans window</html>')
    file(root, `${staged}/manifest.json`, JSON.stringify({ backend: { entry: 'backend/navide-plans' } }))
    const production = file(root, `${staged}/backend/navide-plans`, 'MZproduction-binary')
    chmodSync(production, 0o755)
    if (fixtures) {
      const packagedFixture = file(root, 'dist-test-fixtures/plans/backend/navide-plans', 'MZtest-only-fixture')
      file(root, 'dist-test-fixtures/plans/backend/navide-plans-go', 'MZtest-only-go-fixture')
      if (contamination) copyFileSync(packagedFixture, contamination === 'extra'
        ? join(root, `${staged}/backend/copied-fixture`)
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
    // The preloaded platform makes the verifier read a win32 target.
    const staged = stagedPlans(`win32-${process.arch}`)
    file(root, `${staged}/frontend/left/index.html`, '<html>Plans</html>')
    file(root, `${staged}/frontend/window/index.html`, '<html>Plans window</html>')
    file(root, `${staged}/manifest.json`, JSON.stringify({ backend: { entry } }))
    file(root, `${staged}/backend/${executable}`, 'MZproduction-binary')
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
    // navide.plans lives in Navide-dev/navide-plans: its version is the pin.
    const pinned = 'artifact_version="$(node -p "/\'navide\\\\.plans\': \'([^\']+)\'/.exec(require(\'fs\').readFileSync(\'src/main/plugins/officialPluginVersions.ts\', \'utf8\'))[1]")"'
    expect(verifyStep).toContain(pinned)
    expect(linuxValidationStep).toContain(pinned)
    expect(verifyStep).toContain(
      'Contents/Resources/official-artifacts/navide.plans/${artifact_version}/darwin-arm64/package/backend/navide-plans',
    )
    expect(linuxValidationStep).toContain(
      'squashfs-root/resources/official-artifacts/navide.plans/${artifact_version}/linux-x64/package/backend/navide-plans',
    )
  })

  it('asserts each release artifact carries the bundled Navide Browser backend at its pinned version', () => {
    // navide.browser lives in Navide-dev/navide-browser: its version is the pin.
    const pinned = 'browser_version="$(node -p "/\'navide\\\\.browser\': \'([^\']+)\'/.exec(require(\'fs\').readFileSync(\'src/main/plugins/officialPluginVersions.ts\', \'utf8\'))[1]")"'
    expect(verifyStep).toContain(pinned)
    expect(linuxValidationStep).toContain(pinned)
    expect(verifyStep).toContain(
      'test -x "${app_path}/Contents/Resources/official-artifacts/navide.browser/${browser_version}/darwin-arm64/package/backend/navide-browser"',
    )
    expect(linuxValidationStep).toContain(
      'test -x "${work}/squashfs-root/resources/official-artifacts/navide.browser/${browser_version}/linux-x64/package/backend/navide-browser"',
    )
  })
})

describe('the standalone packaged-Plans gate stages every official package from the Registry', () => {
  // release.yml's macOS gate runs `test:packaged-plans` without `--prepared`,
  // so run-artifact-tests.mjs builds the staged packages itself; CI only runs
  // the `--prepared` path after `bun run build` and never reaches this list.
  const runner = readFileSync('scripts/run-artifact-tests.mjs', 'utf8')
  const stage = readFileSync('scripts/stage-official-plugin-artifacts.mjs', 'utf8')
  const standalone = runner.slice(runner.indexOf('if (!prepared)'), runner.indexOf('stage-official-plugin-artifacts.mjs'))
  const staged = [...stage.matchAll(/directory: 'dist-plugins\/navide-([a-z-]+)'/g)].map((match) => match[1])

  it('stages no package built here', () => {
    expect(staged).toEqual([])
  })

  it('takes every official plugin from the Registry instead of building it', () => {
    expect(stage).toContain("{ id: 'navide.git', target: 'universal' }")
    expect(stage).toContain("{ id: 'navide.mini-ide', target: 'universal' }")
    expect(stage).toContain("{ id: 'navide.browser', target: hostTarget }")
    expect(stage).toContain("{ id: 'navide.plans', target: hostTarget }")
    // A platform package is downloaded by target, as the App's installer asks.
    expect(stage).toContain('/download?target=${encodeURIComponent(target)}')
    for (const build of ['build:git:v2', 'build:mini-ide:v2', 'build:browser:v2', 'build:browser:backend', 'build:plans:v2', 'build:plans:backend']) {
      expect(standalone).not.toContain(`'${build}'`)
    }
  })
})
