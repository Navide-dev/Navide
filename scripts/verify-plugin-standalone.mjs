#!/usr/bin/env node
// Checks that a first-party plugin builds outside the Navide monorepo, as it
// will once it lives in a repository of its own: copy plugins/<dir> into a
// fresh directory outside the repository, install it with plain npm (no
// workspace, no repository node_modules), then typecheck, build,
// `navide-plugin validate` and package it.
//
//   node scripts/verify-plugin-standalone.mjs <dir> [--tarballs <dir>] [--registry] [--keep]
//
//   <dir>             the plugin directory under plugins/, e.g. navide-git
//
//   --tarballs <dir>  install @navide/plugin-{contracts,sdk,ui} from the
//                     tarballs in <dir> (default dist/npm, as written by
//                     scripts/publish-public-packages.sh). Everything else
//                     comes from the npm registry.
//   --registry        keep the plugin's own ^1.x ranges and install the
//                     published packages, once they are on npm.
//   --keep            leave the temporary checkout in place for inspection.
//
// A plugin with a native backend (Browser, Plans) is built for this host's
// target: its frontend from the copy, its backend by the repository's
// scripts/build-<name>-v2-backend.mjs pointed at the copy, with the
// repository's Python toolchain (uv, PyInstaller), which has no standalone
// replacement yet.
//
// Covers the build only. The plugin's tests still run in the monorepo
// (pnpm test:plugins); docs/en-US/plugin-repository-moves.md lists what they
// need before they can move too. Reads no token and writes nothing inside the
// repository.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const names = ['plugin-contracts', 'plugin-sdk', 'plugin-ui']
const args = process.argv.slice(2)
let pluginDir = null
let tarballDir = join(root, 'dist', 'npm')
let fromRegistry = false
let keep = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tarballs') tarballDir = resolve(args[++i] ?? '')
  else if (args[i] === '--registry') fromRegistry = true
  else if (args[i] === '--keep') keep = true
  else if (!args[i].startsWith('-') && pluginDir === null) pluginDir = args[i]
  else {
    console.error(`unknown option: ${args[i]}`)
    process.exit(2)
  }
}

if (pluginDir === null || !/^navide-[a-z-]+$/.test(pluginDir) || !existsSync(join(root, 'plugins', pluginDir, 'manifest.json'))) {
  console.error('usage: node scripts/verify-plugin-standalone.mjs <plugins/ directory, e.g. navide-git> [--tarballs <dir>] [--registry] [--keep]')
  process.exit(2)
}
const version = JSON.parse(readFileSync(join(root, 'packages/plugin-contracts/package.json'), 'utf8')).version
const source = JSON.parse(readFileSync(join(root, 'plugins', pluginDir, 'manifest.json'), 'utf8'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, commandArgs, cwd) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`)
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status ?? result.signal}`)
}

const temporaryRoot = mkdtempSync(join(tmpdir(), `${pluginDir}-standalone-`))
const project = join(temporaryRoot, pluginDir)
let failed = false
try {
  cpSync(join(root, 'plugins', pluginDir), project, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|dist)$/.test(source),
  })
  const manifestPath = join(project, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const name of names) {
    const range = manifest.dependencies?.[`@navide/${name}`]
    if (!/^\^1\./.test(range ?? '')) throw new Error(`plugins/${pluginDir} must depend on @navide/${name} with a ^1.x range (found '${range}')`)
    if (fromRegistry) continue
    const file = join(tarballDir, `navide-${name}-${version}.tgz`)
    if (!existsSync(file)) throw new Error(`${file} is missing; run scripts/publish-public-packages.sh first (it dry-runs by default)`)
    manifest.dependencies[`@navide/${name}`] = `file:${file}`
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Standalone checkout: ${project}`)
  console.log(`Public packages: ${fromRegistry ? 'npm registry (^1.x)' : tarballDir}`)

  run(npm, ['install', '--no-audit', '--no-fund', '--no-package-lock'], project)
  run(npm, ['run', 'typecheck'], project)
  run(npm, ['run', 'build'], project)
  // A backend package must name the build host's exact target.
  const targetArgs = source.backend ? ['--', '--target', `${process.platform}-${process.arch}`] : []
  if (source.backend) {
    const name = pluginDir.slice('navide-'.length)
    const builder = join(root, 'scripts', `build-${name}-v2-backend.mjs`)
    if (!existsSync(builder)) throw new Error(`${source.id} declares a backend but ${builder} does not exist`)
    const prefix = `NAVIDE_${name.toUpperCase().replace(/-/g, '_')}`
    console.log(`$ ${prefix}_SOURCE_DIR=… ${prefix}_DIST_DIR=… node ${builder}`)
    const built = spawnSync(process.execPath, [builder], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, [`${prefix}_SOURCE_DIR`]: project, [`${prefix}_DIST_DIR`]: join(project, 'dist') },
    })
    if (built.status !== 0) throw new Error(`${builder} exited with ${built.status ?? built.signal}`)
  }
  run(npm, ['run', 'check', ...targetArgs], project)
  run(npm, ['run', 'package', ...targetArgs], project)

  const built = JSON.parse(readFileSync(join(project, 'dist', 'manifest.json'), 'utf8'))
  if (built.id !== source.id || built.version !== source.version) {
    throw new Error(`dist/manifest.json is ${built.id}@${built.version}, expected ${source.id}@${source.version}`)
  }
  const archive = join(project, `${pluginDir}.vsix`)
  if (!existsSync(archive) || statSync(archive).size === 0) throw new Error(`${archive} was not produced`)
  console.log(`PASS: ${source.id}@${source.version} installed, typechecked, built, validated and packaged on its own (${statSync(archive).size} bytes)`)
} catch (error) {
  failed = true
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (keep) console.log(`Kept ${temporaryRoot}`)
  else rmSync(temporaryRoot, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
