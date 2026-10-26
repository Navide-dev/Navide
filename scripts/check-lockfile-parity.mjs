#!/usr/bin/env node
// Fails when pnpm-lock.yaml and bun.lock resolve different registry packages.
//
// CI installs with Bun (bun.lock) while releases install with pnpm
// (pnpm-lock.yaml), so the two locks must record the same name@version and
// the same integrity hash for every registry package. Workspace links and
// git/tarball entries carry no registry integrity and are not compared.
//
// Usage: node scripts/check-lockfile-parity.mjs [pnpm-lock.yaml] [bun.lock]
// Exit codes: 0 same, 1 mismatch, 2 a lockfile is unreadable or has no packages.
// No dependencies; runs under Node and Bun.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// pnpm-lock.yaml v9: the top-level `packages:` section holds one
// `  'name@version':` entry per package with `    resolution: {integrity: …}`.
export function pnpmPackages(text) {
  const packages = new Map()
  let inPackages = false
  let key = null
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = line.trim() === 'packages:'
      key = null
      continue
    }
    if (!inPackages) continue
    const entry = /^ {2}(['"]?)(\S.*?)\1:\s*$/.exec(line)
    if (entry) {
      key = entry[2]
      continue
    }
    const resolution = key && /^ {4}resolution: \{(.*)\}\s*$/.exec(line)
    const integrity = resolution && /integrity: ([^\s,}]+)/.exec(resolution[1])
    if (integrity) packages.set(key, integrity[1])
  }
  return packages
}

// bun.lock is JSON with trailing commas: drop a comma that is followed only by
// whitespace and a closing bracket, ignoring commas inside strings.
export function parseBunLock(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      out += c
      if (c === '\\') out += text[++i]
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1, i + 64))) {
      continue
    } else {
      out += c
    }
  }
  return JSON.parse(out)
}

// Registry entries look like ["name@version", "", { …deps }, "sha512-…"].
export function bunPackages(text) {
  const packages = new Map()
  for (const entry of Object.values(parseBunLock(text).packages ?? {})) {
    const [identity, , , integrity] = entry
    if (typeof identity === 'string' && typeof integrity === 'string' && integrity.startsWith('sha')) {
      packages.set(identity, integrity)
    }
  }
  return packages
}

export function compareLockfiles(pnpmText, bunText) {
  const pnpm = pnpmPackages(pnpmText)
  const bun = bunPackages(bunText)
  return {
    pnpmCount: pnpm.size,
    bunCount: bun.size,
    onlyPnpm: [...pnpm.keys()].filter((id) => !bun.has(id)).sort(),
    onlyBun: [...bun.keys()].filter((id) => !pnpm.has(id)).sort(),
    mismatched: [...pnpm.keys()].filter((id) => bun.has(id) && bun.get(id) !== pnpm.get(id)).sort(),
  }
}

const LIST_LIMIT = 20

function listed(label, ids) {
  if (!ids.length) return []
  const shown = ids.slice(0, LIST_LIMIT).map((id) => `    ${id}`)
  if (ids.length > LIST_LIMIT) shown.push(`    … ${ids.length - LIST_LIMIT} more`)
  return [`  ${label} (${ids.length}):`, ...shown]
}

export function formatReport(result) {
  const { pnpmCount, bunCount, onlyPnpm, onlyBun, mismatched } = result
  if (!onlyPnpm.length && !onlyBun.length && !mismatched.length) {
    return `Lockfile parity OK: pnpm-lock.yaml and bun.lock resolve the same ${pnpmCount} registry packages.`
  }
  return [
    `Lockfile parity FAILED: pnpm-lock.yaml has ${pnpmCount} registry packages, bun.lock has ${bunCount}.`,
    ...listed('only in pnpm-lock.yaml', onlyPnpm),
    ...listed('only in bun.lock', onlyBun),
    ...listed('same name@version, different integrity', mismatched),
    'Run `pnpm install` and `bun install` after changing dependencies so both locks resolve the same versions.',
  ].join('\n')
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const [pnpmPath = join(root, 'pnpm-lock.yaml'), bunPath = join(root, 'bun.lock')] = process.argv.slice(2)
  let result
  try {
    result = compareLockfiles(readFileSync(pnpmPath, 'utf8'), readFileSync(bunPath, 'utf8'))
  } catch (error) {
    console.error(`Cannot read the lockfiles: ${error.message}`)
    process.exit(2)
  }
  if (!result.pnpmCount || !result.bunCount) {
    console.error(`A lockfile has no registry packages (pnpm ${result.pnpmCount}, bun ${result.bunCount}); refusing to pass.`)
    process.exit(2)
  }
  const failed = result.onlyPnpm.length || result.onlyBun.length || result.mismatched.length
  ;(failed ? console.error : console.log)(formatReport(result))
  process.exit(failed ? 1 : 0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
