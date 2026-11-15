// Build the Rust CLI runtime sidecar: build/cli-runtime/navide-cli-runtime.
//
// electron-builder packages build/cli-runtime/ into <resources>/bin/ on macOS
// and Linux; the backend starts it when the `rustCliRuntime` setting is on
// (backend/agent_team_backend/cli_runtime.py, which looks there in a packaged
// app). The setting is off by default and every reader falls back to Python
// without the binary, so by default this script never fails: without cargo,
// or when the build breaks, it warns, leaves build/cli-runtime/ in place
// (possibly empty) and exits 0. Set NAVIDE_CLI_RUNTIME_REQUIRED=1 to make any
// failure fatal (release jobs that must ship the sidecar, and CI).
//
// A build that gives up removes the binary an earlier build staged: a package
// made after it must carry no runtime at all (the backend then stays on
// Python) rather than an older runtime beside newer readers and declarations.
//
// Windows is not supported: the runtime has no file identity and no PTY off
// Unix, so it observes nothing there, and no Windows package carries it. On
// Windows this script does nothing, whatever the variable says.
//
// cargo decides what is stale, so the build always runs; with nothing changed
// it returns in well under a second.

import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(root, 'native', 'navide-cli-runtime')
const outDir = join(root, 'build', 'cli-runtime')
const binName = 'navide-cli-runtime'
const staged = join(outDir, binName)
const required = process.env.NAVIDE_CLI_RUNTIME_REQUIRED === '1'

if (process.platform === 'win32') {
  console.log('[cli-runtime] not built on Windows (the runtime observes nothing off Unix)')
  process.exit(0)
}

function giveUp(message) {
  rmSync(staged, { force: true })
  if (required) {
    console.error(`[cli-runtime] ${message} (NAVIDE_CLI_RUNTIME_REQUIRED=1)`)
    process.exit(1)
  }
  console.warn(`[cli-runtime] WARNING: ${message}; the rustCliRuntime setting will find no binary in this build`)
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })

const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' })
if (probe.error || probe.status !== 0) giveUp('cargo not found')

const args = ['build', '--release', '--manifest-path', join(crate, 'Cargo.toml')]
if (existsSync(join(crate, 'Cargo.lock'))) args.push('--locked')
const build = spawnSync('cargo', args, { stdio: 'inherit' })
if (build.error || build.status !== 0) giveUp('cargo build failed')

copyFileSync(join(crate, 'target', 'release', binName), staged)
chmodSync(staged, 0o755)
console.log(`[cli-runtime] built ${staged}`)
