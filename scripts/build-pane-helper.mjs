// Build the macOS pane helper bundle: build/pane-helper/Navide Pane.app.
//
// electron-builder packages it as Contents/Resources/bin/Navide Pane.app and
// signs it with the rest of the app; the backend runs every pane's shell
// under it (see resources/pane-helper/main.c for why). A no-op off macOS so
// `pnpm build` stays one command everywhere.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  console.log('[pane-helper] not macOS; skipping')
  process.exit(0)
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = join(root, 'resources', 'pane-helper', 'main.c')
const bundle = join(root, 'build', 'pane-helper', 'Navide Pane.app')
const contents = join(bundle, 'Contents')
const macos = join(contents, 'MacOS')

rmSync(bundle, { recursive: true, force: true })
mkdirSync(macos, { recursive: true })

// Universal so the same bundle serves an x64 build if one is ever cut; the
// deployment target matches package.json's build.mac.minimumSystemVersion.
execFileSync(
  'cc',
  [
    '-Wall',
    '-Wextra',
    '-O2',
    '-arch',
    'arm64',
    '-arch',
    'x86_64',
    '-mmacosx-version-min=13.0',
    '-o',
    join(macos, 'navide-pane'),
    source,
  ],
  { stdio: 'inherit' },
)

// LSUIElement is the whole point: processes attributed to this bundle get no
// Dock tile. The identifier must differ from the app's so LaunchServices
// treats it as its own application rather than another Navide.
// TCC attributes anything launched from a pane to this bundle, and without a
// microphone usage string it denies mic access silently, with no prompt.
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>com.nerdtechnic.agent-team.pane</string>
  <key>CFBundleName</key>
  <string>Navide Pane</string>
  <key>CFBundleDisplayName</key>
  <string>Navide Pane</string>
  <key>CFBundleExecutable</key>
  <string>navide-pane</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>A program running in a Navide terminal pane wants to use the microphone.</string>
</dict>
</plist>
`
writeFileSync(join(contents, 'Info.plist'), plist)
writeFileSync(join(contents, 'PkgInfo'), 'APPL????')

// Ad-hoc sign so a local (unsigned) build still launches under Gatekeeper's
// library validation; release builds are re-signed by electron-builder.
execFileSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'inherit' })

console.log(`[pane-helper] built ${bundle}`)
