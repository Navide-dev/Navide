// Copies the desktop's pane status labels into the app, so a pane is called
// the same thing on the phone as in the desktop sidebar. Only the keys the
// app needs are copied; the desktop catalogs are far too large to bundle.
// Run after the desktop strings change: pnpm sync:locales
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '../../../src/renderer/src/i18n/locales')
const target = join(here, '../src/i18n/generated/paneStatus.json')

const out = {}
for (const file of readdirSync(source).filter((f) => f.endsWith('.json')).sort()) {
  const catalog = JSON.parse(readFileSync(join(source, file), 'utf8'))
  if (catalog.paneStatus) out[file.replace(/\.json$/, '')] = catalog.paneStatus
}
writeFileSync(target, JSON.stringify(out, null, 2) + '\n')
console.log(`wrote ${Object.keys(out).length} locales to ${target}`)
