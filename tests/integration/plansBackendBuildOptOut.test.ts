import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { backendEntryOnDisk, loadPluginDir } from '../../src/main/plugins/installedPlugins'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const buildScript = join(repositoryRoot, 'scripts/build-plans-v2-backend.mjs')
const packagedBackend = join(repositoryRoot, 'dist-plugins/navide-plans/backend/navide-plans')

const temporaryDirectories: string[] = []

function temporaryDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirectories.push(dir)
  return dir
}

/** A minimal but complete Manifest v2 Plans package on disk. */
function writePlansPackage(dir: string, options: { backend: boolean }): void {
  for (const view of ['left', 'window']) {
    mkdirSync(join(dir, 'frontend', view), { recursive: true })
    writeFileSync(join(dir, 'frontend', view, 'index.html'), '<!doctype html><title>Plans</title>')
  }
  if (options.backend) {
    const backendDir = join(dir, 'backend')
    mkdirSync(backendDir, { recursive: true })
    const entry = join(dir, backendEntryOnDisk('backend/navide-plans'))
    // Not a script: the loader rejects a shebang as a packaged executable.
    writeFileSync(entry, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))
    chmodSync(entry, 0o755)
  }
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      apiVersion: '^1.0.0',
      id: 'navide.plans',
      name: 'Plans',
      version: '0.1.0',
      publisher: 'navide',
      engines: { navide: '^0.1.0' },
      permissions: { system: ['fs', 'ui', 'aiCli'] },
      marketplace: {
        description: 'Review and update workspace plans.',
        license: 'MIT',
        repository: 'https://github.com/Navide-dev/Navide',
        categories: ['productivity', 'project-management'],
      },
      contributes: {
        views: [
          { id: 'left', kind: 'custom', location: 'left', title: 'Plans', entry: 'frontend/left/index.html' },
          { id: 'window', kind: 'custom', location: 'window', title: 'Plans', entry: 'frontend/window/index.html' },
        ],
      },
      backend: { entry: 'backend/navide-plans', protocolVersion: 1, activation: 'startup' },
    }),
  )
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    try {
      rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

describe('packaged Plans backend build opt-out', () => {
  it('skips the PyInstaller build entirely when the opt-out is set', () => {
    const alreadyBuilt = existsSync(packagedBackend)

    const result = spawnSync(process.execPath, [buildScript, '--if-needed'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NAVIDE_SKIP_PLANS_BACKEND_BUILD: '1',
        // A contributor without uv is the whole point: nothing may be spawned.
        PATH: join(tmpdir(), 'navide-no-such-bin'),
      },
    })

    expect(result.error).toBeUndefined()
    expect(`${result.stdout}${result.stderr}`).toContain('NAVIDE_SKIP_PLANS_BACKEND_BUILD=1')
    expect(result.status).toBe(0)
    // The skip must not produce, or destroy, build output.
    expect(existsSync(packagedBackend)).toBe(alreadyBuilt)
  })

  it('refuses the opt-out on the production build path', () => {
    // `pnpm dev` passes --if-needed; build:plans:backend — reached by
    // build:plans ← build:official-plugins ← build ← dist, and by the CI gates —
    // does not. Honouring the variable there ships a signed release with an
    // empty dist-plugins/navide-plans/backend, i.e. Plans legacy recovery for
    // every user, with nothing in the build output to say so.
    const alreadyBuilt = existsSync(packagedBackend)

    const result = spawnSync(process.execPath, [buildScript], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        NAVIDE_SKIP_PLANS_BACKEND_BUILD: '1',
        PATH: join(tmpdir(), 'navide-no-such-bin'),
      },
    })

    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('production or CI build')
    expect(result.stderr).toContain('NAVIDE_SKIP_PLANS_BACKEND_BUILD=1')
    // Refused up front, not by failing somewhere inside PyInstaller: the
    // maintainer has to see which knob caused it.
    expect(result.stderr).not.toContain('Packaging the Plans backend failed')
    expect(existsSync(packagedBackend)).toBe(alreadyBuilt)
  })

  it('names the opt-out in the failure a contributor without uv actually hits', () => {
    const result = spawnSync(process.execPath, [buildScript, '--if-needed'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: join(tmpdir(), 'navide-no-such-bin') },
    })

    // With a valid cached build this exits 0 before ever needing uv; only the
    // failing path has to advertise the escape hatch.
    if (result.status !== 0) {
      expect(result.stderr).toContain('NAVIDE_SKIP_PLANS_BACKEND_BUILD=1')
    }
  })

  it('leaves the Plans v2 package unregistrable when the packaged backend is absent', () => {
    // The documented fallback: loadPluginDir refuses the package before it can
    // become a descriptor or an activation, so registerBundledPlans falls back
    // to the legacy bundle and the Host enters Plans legacy recovery.
    const withBackend = temporaryDirectory('navide-plans-pkg-ok-')
    writePlansPackage(withBackend, { backend: true })
    const ok = loadPluginDir(withBackend)
    expect(ok.error).toBeUndefined()
    expect(ok.descriptor?.id).toBe('navide.plans')
    expect(ok.activation?.backend?.entryFile).toBe(join(withBackend, backendEntryOnDisk('backend/navide-plans')))

    const withoutBackend = temporaryDirectory('navide-plans-pkg-missing-')
    writePlansPackage(withoutBackend, { backend: false })
    const missing = loadPluginDir(withoutBackend)
    expect(missing.error).toContain('backend/navide-plans')
    expect(missing.error).toContain('is missing')
    expect(missing.descriptor).toBeUndefined()
    expect(missing.activation).toBeUndefined()
  })
})
