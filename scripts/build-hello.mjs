// Build the Windows Hello helper for App Lock: build/hello/navide-hello.exe.
//
// Windows only: electron-builder packages build/hello/ into <resources>/bin/
// on Windows, and main spawns it to check for and run Windows Hello (see
// native/navide-hello/ and src/main/windowsHello.ts). Elsewhere this script
// does nothing. Without the helper App Lock unlocks with the PIN only, so by
// default a missing cargo or a broken build warns and exits 0. Set
// NAVIDE_HELLO_REQUIRED=1 to make any failure fatal (release jobs that must
// ship it).

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.log('[hello] not Windows; skipping')
  process.exit(0)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crate = join(root, 'native', 'navide-hello')
const outDir = join(root, 'build', 'hello')
const required = process.env.NAVIDE_HELLO_REQUIRED === '1'

function giveUp(message) {
  if (required) {
    console.error(`[hello] ${message} (NAVIDE_HELLO_REQUIRED=1)`)
    process.exit(1)
  }
  console.warn(`[hello] WARNING: ${message}; App Lock will unlock with the PIN only in this build`)
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })

const probe = spawnSync('cargo', ['--version'], { stdio: 'ignore' })
if (probe.error || probe.status !== 0) giveUp('cargo not found')

const build = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', join(crate, 'Cargo.toml')], {
  stdio: 'inherit',
})
if (build.error || build.status !== 0) giveUp('cargo build failed')

const binary = join(crate, 'target', 'release', 'navide-hello.exe')
if (!existsSync(binary)) giveUp(`${binary} missing after the build`)
copyFileSync(binary, join(outDir, 'navide-hello.exe'))
console.log(`[hello] built ${join(outDir, 'navide-hello.exe')}`)
