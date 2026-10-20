import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { missingArtifactInputs, prepareArtifactInputs } from '../support/publicPackagesSetup'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function cacheFixture() {
  const root = mkdtempSync(join(tmpdir(), 'navide-artifact-cache-'))
  roots.push(root)
  const file = (path: string, content = 'fixture') => {
    const destination = join(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
  }
  file('package.json', '{}')
  file('bun.lock')
  for (const name of ['plugin-contracts', 'plugin-sdk', 'plugin-ui']) file(`packages/${name}/src/index.ts`)
  file('plugins/navide-mini-ide/src/App.vue')
  const build = vi.fn(() => {
    for (const path of missingArtifactInputs(root)) file(path, 'built fixture')
    file('packages/plugin-ui/dist/assets/editor.worker.js', 'built worker')
  })
  return { root, file, build }
}

it('reuses an unchanged local artifact build', () => {
  const { root, build } = cacheFixture()
  prepareArtifactInputs(root, build)
  prepareArtifactInputs(root, build)
  expect(build).toHaveBeenCalledTimes(1)
})

it.each([
  'packages/plugin-contracts/src/index.ts', 'packages/plugin-sdk/tsconfig.build.json',
  'packages/plugin-ui/src/index.ts', 'plugins/navide-mini-ide/src/App.vue',
  'plugins/navide-mini-ide/vite.config.ts', 'plugins/navide-mini-ide/manifest.json',
  'package.json', 'bun.lock', 'bunfig.toml', 'tsconfig.web.json', '.env.production',
  'tests/support/publicPackagesSetup.ts', 'node_modules/vite/package.json',
])('rebuilds after changing build input %s', (path) => {
  const { root, file, build } = cacheFixture()
  prepareArtifactInputs(root, build)
  file(path, 'changed input')
  prepareArtifactInputs(root, build)
  prepareArtifactInputs(root, build)
  expect(build).toHaveBeenCalledTimes(2)
})

it.each(['NAVIDE_PLUGIN_ARTIFACT_VERSION', 'VITE_FEATURE', 'npm_config_user_agent', 'NODE_OPTIONS'])(
  'invalidates cached artifacts when %s changes', (name) => {
    const { root, build } = cacheFixture()
    prepareArtifactInputs(root, build)
    vi.stubEnv(name, 'changed build setting')
    prepareArtifactInputs(root, build)
    expect(build).toHaveBeenCalledTimes(2)
  },
)

it.each(['remove', 'modify'])('rebuilds when an output is damaged: %s', (damage) => {
  const { root, file, build } = cacheFixture()
  prepareArtifactInputs(root, build)
  if (damage === 'remove') rmSync(join(root, 'dist-plugins/navide-mini-ide/frontend/window/index.html'))
  else file('packages/plugin-ui/dist/assets/editor.worker.js', 'corrupted worker')
  prepareArtifactInputs(root, build)
  expect(build).toHaveBeenCalledTimes(2)
})

it('invalidates the old success marker before attempting a failing build', () => {
  const { root, file, build } = cacheFixture()
  prepareArtifactInputs(root, build)
  file('packages/plugin-ui/src/index.ts', 'changed input')
  expect(() => prepareArtifactInputs(root, () => { throw new Error('build failed') })).toThrow('build failed')
  file('packages/plugin-ui/src/index.ts') // Reverting the source must not revive the old stamp.
  prepareArtifactInputs(root, build)
  expect(build).toHaveBeenCalledTimes(2)
})

it('rebuilds after an interrupted stamp write', () => {
  const { root, file, build } = cacheFixture()
  prepareArtifactInputs(root, build)
  file('node_modules/.cache/navide-artifact-inputs.json', '{')
  prepareArtifactInputs(root, build)
  expect(build).toHaveBeenCalledTimes(2)
})

it('does not cache a build that omits required outputs', () => {
  const { root, build } = cacheFixture()
  expect(() => prepareArtifactInputs(root, () => {})).toThrow('Built artifact inputs missing')
  prepareArtifactInputs(root, build)
  expect(build).toHaveBeenCalledOnce()
})

it('uses prepared outputs without rebuilding or requiring a local stamp', () => {
  const { root, file, build } = cacheFixture()
  build()
  build.mockClear()
  file('package.json', 'changed after build')
  prepareArtifactInputs(root, build, true)
  expect(build).not.toHaveBeenCalled()
  rmSync(join(root, 'packages/plugin-sdk/dist/index.js'))
  expect(() => prepareArtifactInputs(root, build, true)).toThrow('Prepared artifact inputs missing')
  expect(build).not.toHaveBeenCalled()
})

it('requires real public entrypoints and the staged Mini IDE before reusing a build', () => {
  const root = mkdtempSync(join(tmpdir(), 'navide-artifact-inputs-'))
  try {
    mkdirSync(join(root, 'packages/plugin-ui/dist'), { recursive: true })
    writeFileSync(join(root, 'packages/plugin-ui/dist/stale.txt'), 'unrelated artifact')
    expect(missingArtifactInputs(root)).toContain('packages/plugin-ui/dist/index.js')
    const inputs = [
      'packages/plugin-contracts/dist/index.js', 'packages/plugin-sdk/dist/index.js',
      'packages/plugin-ui/dist/index.js', 'packages/plugin-ui/dist/editor/index.js',
      'dist-plugins/navide-mini-ide/manifest.json',
      'dist-plugins/navide-mini-ide/frontend/window/index.html',
    ]
    for (const input of inputs) {
      mkdirSync(dirname(join(root, input)), { recursive: true })
      writeFileSync(join(root, input), 'built fixture')
    }
    expect(missingArtifactInputs(root)).toEqual([])
    rmSync(join(root, inputs[5]))
    expect(missingArtifactInputs(root)).toEqual([inputs[5]])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
