import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import type { TestProject } from 'vitest/node'

// Vitest globalSetup. The tests that consume the public packages — as packed
// tarballs, or as dists a real Vite build resolves — used to run
// `build:public-packages` themselves. Its plugin-ui step empties
// packages/plugin-ui/dist (emptyOutDir), so in a parallel run one file's
// rebuild broke another file's build. Build and pack once here, before any
// worker starts; the tests only read the result.

declare module 'vitest' {
  export interface ProvidedContext {
    // Package name -> absolute path of its packed tarball. Read-only: shared by
    // every test file in the run.
    publicPackageTarballs: Record<string, string>
  }
}

const repositoryRoot = resolve(import.meta.dirname, '../..')
const builtPackages = ['packages/plugin-contracts', 'packages/plugin-sdk', 'packages/plugin-ui']
const packedPackages = [...builtPackages, 'plugins/navide-git']

// The build scripts and `pm pack` run through Bun itself. On Windows
// process.execPath can be Bun's generated `node` shim, which parses argv with
// Node semantics; resolve the real Bun CLI.
function bunExecutable(): string {
  if (!process.versions.bun) throw new Error('Run Vitest through Bun (`bun run test:run`)')
  const bunGlobal = (globalThis as { Bun?: { which(command: string): string | null } }).Bun
  return bunGlobal?.which('bun') ?? process.execPath
}

function bun(args: string[], cwd: string): string {
  const executable = bunExecutable()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    PATH: `${dirname(executable)}${delimiter}${process.env.PATH ?? ''}`,
  }
  // Vitest sets NODE_ENV=test in this process. Inherited, it makes Vite and
  // @vitejs/plugin-vue emit a development build of plugin-ui that differs from
  // what `bun run build:public-packages` produces — and the Plans build ID
  // hashes these dists, so an artifact built before the run no longer matched.
  delete env.NODE_ENV
  return execFileSync(executable, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 16 * 1024 * 1024,
    env,
  })
}

export function missingArtifactInputs(root: string): string[] {
  return [
    ...builtPackages.map((directory) => `${directory}/dist/index.js`),
    'packages/plugin-ui/dist/editor/index.js',
    'dist-plugins/navide-mini-ide/manifest.json',
    'dist-plugins/navide-mini-ide/frontend/window/index.html',
  ].filter((file) => !existsSync(join(root, file)))
}

function artifactDigest(root: string, paths: string[], source = false): string {
  const hash = createHash('sha256')
  const visit = (path: string): void => {
    hash.update(`${relative(root, path)}\0`)
    if (!existsSync(path)) { hash.update('missing\0'); return }
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (source && ['node_modules', 'dist', 'out', 'coverage', '.git'].includes(entry)) continue
        visit(join(path, entry))
      }
    } else hash.update(readFileSync(path)).update('\0')
  }
  for (const path of paths.sort()) visit(join(root, path))
  if (source) {
    // NODE_ENV is deliberately removed by bun() above. Include the toolchain
    // and build overrides that can otherwise change output without a source edit.
    const windows = process.platform === 'win32'
    const relevantEnvironmentKeys = new Set([
      'NAVIDE_PLUGIN_ARTIFACT_VERSION', 'NAVIDE_MINI_IDE_DIST_DIR',
      'npm_execpath', 'npm_config_user_agent', 'NODE_OPTIONS', 'SOURCE_DATE_EPOCH',
      'LANG', 'LC_ALL', 'TZ',
    ].map((key) => windows ? key.toUpperCase() : key))
    const environment = Object.entries(process.env)
      .map(([key, value]) => [windows ? key.toUpperCase() : key, value] as const)
      .filter(([key]) => key.startsWith('VITE_') || relevantEnvironmentKeys.has(key))
      .sort()
    hash.update(JSON.stringify({
      node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
      environment,
    }))
  }
  return hash.digest('hex')
}

export function prepareArtifactInputs(root: string, build: () => void, prepared = false): void {
  // CI has just run the unconditional application build in this same job.
  // Reuse those outputs without trusting a cache or rebuilding under Vitest's
  // NODE_ENV. A standalone artifact test prepares only the inputs it needs.
  if (prepared) {
    const missing = missingArtifactInputs(root)
    if (missing.length) throw new Error(`Prepared artifact inputs missing: ${missing.join(', ')}`)
    return
  }

  const stamp = join(root, 'node_modules/.cache/navide-artifact-inputs.json')
  const inputs = artifactDigest(root, [
    ...builtPackages, 'plugins/navide-mini-ide', 'tests/support/publicPackagesSetup.ts',
    'package.json', 'bun.lock', 'bunfig.toml', 'scripts/bun/vue-tsc.cjs',
    ...readdirSync(root).filter((file) => /^tsconfig.*\.json$/.test(file) || /^\.env(?:\.|$)/.test(file)),
    ...['typescript', 'vue-tsc', 'vite', '@vitejs/plugin-vue'].map((name) => `node_modules/${name}/package.json`),
  ], true)
  const outputs = () => artifactDigest(root, [
    ...builtPackages.map((directory) => `${directory}/dist`), 'dist-plugins/navide-mini-ide',
  ])
  let cached: { inputs?: string; outputs?: string } | null = null
  if (existsSync(stamp)) {
    try { cached = JSON.parse(readFileSync(stamp, 'utf8')) }
    catch { /* An interrupted stamp write must rebuild. */ }
  }
  if (cached?.inputs === inputs && missingArtifactInputs(root).length === 0 && cached.outputs === outputs()) return

  // Never leave a previous success marker behind a partial or failed build.
  rmSync(stamp, { force: true })
  build()
  const missing = missingArtifactInputs(root)
  if (missing.length) throw new Error(`Built artifact inputs missing: ${missing.join(', ')}`)
  mkdirSync(dirname(stamp), { recursive: true })
  writeFileSync(stamp, JSON.stringify({ inputs, outputs: outputs() }))
}

export default function setup(project: TestProject): () => void {
  prepareArtifactInputs(repositoryRoot, () => {
    bun(['run', 'build:public-packages'], repositoryRoot)
    bun(['run', 'build:mini-ide:v2'], repositoryRoot)
  }, process.env.NAVIDE_TEST_ARTIFACTS_PREBUILT === '1')

  // The runner's TEMP can be an 8.3 short path (C:\Users\RUNNER~1); tools
  // downstream resolve to the long form.
  const artifacts = realpathSync.native(mkdtempSync(join(tmpdir(), 'navide-public-packages-')))
  const tarballs: Record<string, string> = {}
  for (const packageDirectory of packedPackages) {
    const source = join(repositoryRoot, packageDirectory)
    const name = (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string }).name
    // One directory per package, so the tarball is found by listing it rather
    // than by parsing pack output.
    const destination = join(artifacts, packageDirectory.replaceAll('/', '_'))
    mkdirSync(destination)
    bun(['pm', 'pack', '--destination', destination], source)
    const packed = readdirSync(destination).filter((file) => file.endsWith('.tgz'))
    if (packed.length !== 1) throw new Error(`bun pm pack wrote ${packed.length} tarballs for ${name}`)
    tarballs[name] = join(destination, packed[0])
  }
  project.provide('publicPackageTarballs', tarballs)

  return () => rmSync(artifacts, { recursive: true, force: true })
}
