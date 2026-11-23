#!/usr/bin/env node
// Rename CHANGELOG.md's `## [Unreleased]` heading to `## [X.Y.Z] — YYYY-MM-DD`.
// release.sh runs this on every release: scripts/export-whats-new.mjs reads
// each version's date from that heading, and the site's /news shows no date
// for a version without one (0.2.42 and 0.2.46 shipped that way). A changelog
// that already carries the dated heading is left alone.
import { readFileSync, writeFileSync } from 'node:fs'

const [version, date, file = 'CHANGELOG.md'] = process.argv.slice(2)
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  console.error('usage: stamp-changelog-release.mjs X.Y.Z YYYY-MM-DD [CHANGELOG.md]')
  process.exit(1)
}

const changelog = readFileSync(file, 'utf8')
const escaped = version.replaceAll('.', '\\.')
if (new RegExp(`^## \\[${escaped}\\] — \\d{4}-\\d{2}-\\d{2}`, 'm').test(changelog)) {
  console.log(`${file} already has the ${version} heading`)
  process.exit(0)
}
if (new RegExp(`^## \\[${escaped}\\]`, 'm').test(changelog)) {
  console.error(`${file}: the ${version} heading has no date; write it as "## [${version}] — ${date}"`)
  process.exit(1)
}
const unreleased = /^## \[Unreleased\][ \t]*$/m
if (!unreleased.test(changelog)) {
  console.error(`${file}: no "## [Unreleased]" section to release as ${version}; add the release notes first`)
  process.exit(1)
}
writeFileSync(file, changelog.replace(unreleased, `## [${version}] — ${date}`))
console.log(`${file}: ## [Unreleased] -> ## [${version}] — ${date}`)
