// Build the macOS fn-key helper: build/fn-key/navide-fn-key.
//
// electron-builder packages it as Contents/Resources/bin/navide-fn-key and
// signs it with the rest of the app; the main process runs it only while
// hold-to-talk is bound to fn or a shortcut recorder listens for a new key
// (see native/fn-key/main.c). A no-op off macOS so `pnpm build` stays one
// command everywhere.
//
// `--test` also compiles and runs native/fn-key/fn_logic_test.c.
// `--if-needed` is how `pnpm dev` runs it: skipped when the binary is newer
// than its sources, and a failed compile only warns — dev still starts, and
// the voice settings say the helper is missing instead of fn doing nothing.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  console.log('[fn-key] not macOS; skipping')
  process.exit(0)
}

const sourceDir = join(root, 'native', 'fn-key')
const outDir = join(root, 'build', 'fn-key')
const binary = join(outDir, 'navide-fn-key')
const ifNeeded = process.argv.includes('--if-needed')

if (ifNeeded && existsSync(binary)) {
  const built = statSync(binary).mtimeMs
  const sources = readdirSync(sourceDir).map((name) => statSync(join(sourceDir, name)).mtimeMs)
  if (sources.every((m) => m <= built)) {
    console.log('[fn-key] up to date')
    process.exit(0)
  }
}

if (ifNeeded) {
  try {
    build()
  } catch (e) {
    console.warn(`[fn-key] could not build the helper (${e.message}); fn will not work in this dev run`)
    rmSync(outDir, { recursive: true, force: true })
  }
} else {
  build()
}

function build() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const common = ['-Wall', '-Wextra', '-O2', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=13.0']

  if (process.argv.includes('--test')) {
    const testBinary = join(outDir, 'fn_logic_test')
    execFileSync('cc', [...common, '-o', testBinary, join(sourceDir, 'fn_logic_test.c')], { stdio: 'inherit' })
    execFileSync(testBinary, [], { stdio: 'inherit' })
    rmSync(testBinary)
  }

  // Universal so the same binary serves an x64 build if one is ever cut; the
  // deployment target matches package.json's build.mac.minimumSystemVersion.
  execFileSync(
    'cc',
    [...common, '-framework', 'ApplicationServices', '-framework', 'CoreFoundation', '-o', binary, join(sourceDir, 'main.c')],
    { stdio: 'inherit' },
  )

  // Ad-hoc sign so a local (unsigned) build still runs; release builds are
  // re-signed by electron-builder.
  execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'inherit' })

  console.log(`[fn-key] built ${binary}`)
}
