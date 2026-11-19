#!/usr/bin/env node
// Checks that navide.git builds outside the Navide monorepo, as it will once
// it lives in a repository of its own: copy plugins/navide-git into a fresh
// directory outside the repository, install it with plain npm (no workspace,
// no repository node_modules), then typecheck, build, `navide-plugin validate`
// and package it.
//
//   node scripts/verify-git-plugin-standalone.mjs [--tarballs <dir>] [--registry] [--keep]
//
//   --tarballs <dir>  install @navide/plugin-{contracts,sdk,ui} from the
//                     tarballs in <dir> (default dist/npm, as written by
//                     scripts/publish-public-packages.sh). Everything else
//                     comes from the npm registry.
//   --registry        keep the plugin's own ^1.x ranges and install the
//                     published packages, once they are on npm.
//   --keep            leave the temporary checkout in place for inspection.
//
// Covers the build only. The plugin's tests still run in the monorepo
// (pnpm test:plugin:git); docs/en-US/navide-git-repository-move.md lists what
// they need before they can move too. Reads no token and writes nothing
// inside the repository.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const names = ['plugin-contracts', 'plugin-sdk', 'plugin-ui']
const args = process.argv.slice(2)
let tarballDir = join(root, 'dist', 'npm')
let fromRegistry = false
let keep = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tarballs') tarballDir = resolve(args[++i] ?? '')
  else if (args[i] === '--registry') fromRegistry = true
  else if (args[i] === '--keep') keep = true
  else {
    console.error(`unknown option: ${args[i]}`)
    process.exit(2)
  }
}

const version = JSON.parse(readFileSync(join(root, 'packages/plugin-contracts/package.json'), 'utf8')).version
const pluginVersion = JSON.parse(readFileSync(join(root, 'plugins/navide-git/manifest.json'), 'utf8')).version
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, commandArgs, cwd) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`)
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status ?? result.signal}`)
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'navide-git-standalone-'))
const project = join(temporaryRoot, 'navide-git')
let failed = false
try {
  cpSync(join(root, 'plugins', 'navide-git'), project, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|dist)$/.test(source),
  })
  const manifestPath = join(project, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const name of names) {
    const range = manifest.dependencies?.[`@navide/${name}`]
    if (!/^\^1\./.test(range ?? '')) throw new Error(`plugins/navide-git must depend on @navide/${name} with a ^1.x range (found '${range}')`)
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
  run(npm, ['run', 'check'], project)
  run(npm, ['run', 'package'], project)

  const built = JSON.parse(readFileSync(join(project, 'dist', 'manifest.json'), 'utf8'))
  if (built.id !== 'navide.git' || built.version !== pluginVersion) {
    throw new Error(`dist/manifest.json is ${built.id}@${built.version}, expected navide.git@${pluginVersion}`)
  }
  const archive = join(project, 'navide-git.vsix')
  if (!existsSync(archive) || statSync(archive).size === 0) throw new Error(`${archive} was not produced`)
  console.log(`PASS: navide.git@${pluginVersion} installed, typechecked, built, validated and packaged on its own (${statSync(archive).size} bytes)`)
} catch (error) {
  failed = true
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (keep) console.log(`Kept ${temporaryRoot}`)
  else rmSync(temporaryRoot, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
