#!/usr/bin/env node
// Fails when a production build contains any part of the dev-only web mode
// (scripts/dev-web/, src/renderer/src/devWeb/). The web mode is wired in only
// by the dev server when NAVIDE_DEV_WEB=1, so none of these strings may ever
// reach out/. release.sh runs this on out/ right after `bun run dist`.
//
// Usage: node scripts/check-no-dev-web.mjs [buildDir=out]
// Exit codes: 0 clean, 1 marker found, 2 build dir missing.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Every dev web file carries at least one of these; the shim's URL prefix and
// global name are the first, the env flag the second, the notice id the third.
export const DEV_WEB_MARKERS = ['__navide_dev_web', 'NAVIDE_DEV_WEB', 'navide-dev-web']

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile()) yield path
  }
}

/** Every (file, marker) pair found under `dir`, in walk order. */
export function findDevWebMarkers(dir) {
  const hits = []
  for (const file of walk(dir)) {
    // latin1 maps every byte, so a marker is found in binary files too.
    const text = readFileSync(file, 'latin1')
    for (const marker of DEV_WEB_MARKERS) {
      if (text.includes(marker)) hits.push({ file, marker })
    }
  }
  return hits
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? 'out')
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`check-no-dev-web: build dir not found: ${dir}`)
    process.exit(2)
  }
  const hits = findDevWebMarkers(dir)
  if (hits.length > 0) {
    for (const { file, marker } of hits) console.error(`check-no-dev-web: "${marker}" in ${file}`)
    console.error('check-no-dev-web: the dev-only web mode leaked into the production build')
    process.exit(1)
  }
  console.log(`check-no-dev-web: ${dir} is clean`)
}
