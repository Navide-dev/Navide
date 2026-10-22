#!/usr/bin/env node
// Export the in-app announcements (WHATS_NEW in src/renderer/src/lib/whatsNew.ts)
// as whats-new.json, the file the website's /news page reads from dl.navide.dev.
//
//   node --experimental-strip-types scripts/export-whats-new.mjs --version 0.2.29 --out whats-new.json
//
// Only entries at or below --version are exported, so the copy mirrored under
// releases/<tag>/ lists what that release shipped even when the source was
// checked out from a later commit. Each entry keeps its version, title,
// highlights and note in every language it carries, plus `major` and the
// release date from CHANGELOG.md when it has one. Tours, spotlights, feature
// cards and functions are left out. The format is documented in
// docs/en-US/release-announcements.md ("whats-new.json").
//
// whatsNew.ts is imported as TypeScript by Node's type stripping, with its one
// runtime import (@navide/plugin-ui/foundation) stubbed, so the mirror job
// needs no dependency install.

import { readFileSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const WHATS_NEW_SCHEMA_VERSION = 1

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function cmpSemver(a, b) {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < 3; i++) {
    const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/** `## [0.2.28] — 2026-10-21 — …` headings → { '0.2.28': '2026-10-21' }. */
export function changelogDates(changelog) {
  const dates = {}
  for (const match of changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] — (\d{4}-\d{2}-\d{2})/gm)) {
    dates[match[1]] = match[2]
  }
  return dates
}

export function buildWhatsNewJson(entries, { version, dates = {} }) {
  return {
    schemaVersion: WHATS_NEW_SCHEMA_VERSION,
    version,
    entries: entries
      .filter((entry) => cmpSemver(entry.version, version) <= 0)
      .sort((a, b) => cmpSemver(b.version, a.version))
      .map((entry) => ({
        version: entry.version,
        ...(dates[entry.version] ? { date: dates[entry.version] } : {}),
        ...(entry.major ? { major: true } : {}),
        title: { ...entry.title },
        highlights: entry.highlights.map((text) => ({ ...text })),
        ...(entry.note ? { note: { ...entry.note } } : {}),
      })),
  }
}

async function loadWhatsNew() {
  const stub = 'data:text/javascript,' + encodeURIComponent('export const isBetaUiLocale = () => false')
  register('data:text/javascript,' + encodeURIComponent(
    `export async function resolve(specifier, context, next) {
      if (specifier === '@navide/plugin-ui/foundation') return { url: ${JSON.stringify(stub)}, shortCircuit: true }
      return next(specifier, context)
    }`,
  ))
  const mod = await import(pathToFileURL(join(ROOT, 'src/renderer/src/lib/whatsNew.ts')).href)
  return mod.WHATS_NEW
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const version = arg('--version')?.replace(/^v/, '')
  const out = arg('--out')
  if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !out) {
    console.error('usage: node --experimental-strip-types scripts/export-whats-new.mjs --version X.Y.Z --out whats-new.json')
    process.exit(2)
  }
  const json = buildWhatsNewJson(await loadWhatsNew(), {
    version,
    dates: changelogDates(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')),
  })
  if (json.entries.length === 0) {
    console.error(`no What's New entry at or below ${version}`)
    process.exit(1)
  }
  writeFileSync(out, JSON.stringify(json, null, 2) + '\n')
  console.log(`${out}: ${json.entries.length} entries, newest ${json.entries[0].version}`)
}
