#!/usr/bin/env node
// Acceptance check for the three public npm packages, run the way a third
// party would: copy examples/third-party-files into a fresh directory outside
// the Navide repository, install it with plain npm (no workspace, no repo
// node_modules), then typecheck, build, `navide-plugin validate` and package.
//
//   node scripts/verify-public-packages-external.mjs [--tarballs <dir>] [--registry] [--keep]
//
//   --tarballs <dir>  install @navide/plugin-{contracts,sdk,ui} from the
//                     tarballs in <dir> (default dist/npm, as written by
//                     scripts/publish-public-packages.sh). Everything else
//                     (vue, vite, typescript) comes from the npm registry.
//   --registry        install the three packages from the npm registry at the
//                     version in packages/plugin-contracts/package.json, to
//                     confirm a publication after the fact.
//   --keep            leave the temporary project in place for inspection.
//
// Needs network access to the npm registry. Reads no token and writes nothing
// inside the repository.
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, commandArgs, cwd) {
  console.log(`$ ${command} ${commandArgs.join(' ')}`)
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status ?? result.signal}`)
}

const specs = {}
for (const name of names) {
  if (fromRegistry) {
    specs[`@navide/${name}`] = version
    continue
  }
  const file = join(tarballDir, `navide-${name}-${version}.tgz`)
  if (!existsSync(file)) {
    console.error(`${file} is missing; run scripts/publish-public-packages.sh first (it dry-runs by default)`)
    process.exit(1)
  }
  specs[`@navide/${name}`] = `file:${file}`
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'navide-public-packages-'))
const project = join(temporaryRoot, 'third-party-files')
let failed = false
try {
  cpSync(join(root, 'examples', 'third-party-files'), project, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|dist)$/.test(source),
  })
  const manifestPath = join(project, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const [name, spec] of Object.entries(specs)) {
    if (!manifest.dependencies?.[name]) throw new Error(`the example no longer depends on ${name}`)
    manifest.dependencies[name] = spec
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`External project: ${project}`)
  console.log(`Public packages: ${fromRegistry ? `npm registry @ ${version}` : tarballDir}`)

  run(npm, ['install', '--no-audit', '--no-fund', '--no-package-lock'], project)
  for (const name of names) {
    const installed = join(project, 'node_modules', '@navide', name)
    const installedVersion = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version
    if (installedVersion !== version) throw new Error(`@navide/${name} installed ${installedVersion}, expected ${version}`)
    if (existsSync(join(installed, 'src'))) throw new Error(`@navide/${name} was installed with its src/ tree`)
  }
  run(npm, ['run', 'typecheck'], project)
  run(npm, ['run', 'build'], project)
  run(npm, ['run', 'check'], project)
  run(npm, ['run', 'package'], project)

  const archive = join(project, 'dist', 'acme-files.vsix')
  if (!existsSync(archive) || statSync(archive).size === 0) throw new Error(`${archive} was not produced`)
  const frontend = readdirSync(join(project, 'dist', 'package', 'frontend')).sort()
  for (const required of ['index.html', 'main.js']) {
    if (!frontend.includes(required)) throw new Error(`dist/package/frontend lacks ${required}`)
  }
  console.log(`PASS: installed, typechecked, built, validated and packaged (${statSync(archive).size} bytes)`)
} catch (error) {
  failed = true
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (keep) console.log(`Kept ${temporaryRoot}`)
  else rmSync(temporaryRoot, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
