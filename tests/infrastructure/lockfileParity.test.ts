import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bunPackages, compareLockfiles, formatReport, pnpmPackages } from '../../scripts/check-lockfile-parity.mjs'

const script = resolve('scripts/check-lockfile-parity.mjs')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const A = 'sha512-aaaa'
const B = 'sha512-bbbb'
const C = 'sha512-cccc'

function pnpmLock(packages: Record<string, string>, eol = '\n'): string {
  return [
    "lockfileVersion: '9.0'", '', 'importers:', '', '  .:', '    dependencies:', "      '@scope/a':", '        specifier: ^1.0.0', '        version: 1.0.0', '',
    'packages:', '',
    ...Object.entries(packages).flatMap(([id, integrity]) => [`  '${id}':`, `    resolution: {integrity: ${integrity}}`, '    engines: {node: ">=18"}', '']),
    '  local-tarball@1.0.0:', '    resolution: {tarball: https://example.test/local-tarball-1.0.0.tgz}', '',
    'snapshots:', '', ...Object.keys(packages).flatMap((id) => [`  '${id}': {}`, '']),
  ].join(eol)
}

function bunLock(packages: Record<string, string>): string {
  const body = Object.entries(packages).map(([id, integrity]) => `    "${id}": ["${id}", "", { "dependencies": { "x": "1.0.0" } }, "${integrity}"],`)
  return [
    '{', '  "lockfileVersion": 1,', '  "workspaces": {', '    "": { "name": "root" },', '  },', '  "packages": {',
    '    "@navide/plugin-sdk": ["@navide/plugin-sdk@workspace:packages/plugin-sdk"],',
    ...body, '  }', '}', '',
  ].join('\n')
}

const base = { '@scope/a@1.0.0': A, 'b@2.1.0': B, 'b@1.0.0': C }

describe('lockfile parity', () => {
  it('reads registry name@version and integrity from both lock formats, skipping non-registry entries', () => {
    expect([...pnpmPackages(pnpmLock(base))]).toEqual(Object.entries(base))
    expect([...bunPackages(bunLock(base))]).toEqual(Object.entries(base))
    expect(pnpmPackages(pnpmLock(base, '\r\n')).size).toBe(3)
  })

  it('accepts trailing commas and commas inside strings in bun.lock', () => {
    const text = '{ "packages": { "a": ["a@1.0.0", "", { "note": "x,]" }, "sha512-1", ], }, }'
    expect([...bunPackages(text)]).toEqual([['a@1.0.0', 'sha512-1']])
  })

  it('reports no difference for locks that resolve the same packages', () => {
    const result = compareLockfiles(pnpmLock(base), bunLock({ 'b@1.0.0': C, '@scope/a@1.0.0': A, 'b@2.1.0': B }))
    expect(result).toMatchObject({ pnpmCount: 3, bunCount: 3, onlyPnpm: [], onlyBun: [], mismatched: [] })
    expect(formatReport(result)).toContain('same 3 registry packages')
  })

  it.each([
    ['a version only in pnpm-lock.yaml', { ...base, 'c@3.0.0': A }, base, { onlyPnpm: ['c@3.0.0'], onlyBun: [], mismatched: [] }],
    ['a version only in bun.lock', base, { ...base, 'c@3.0.0': A }, { onlyPnpm: [], onlyBun: ['c@3.0.0'], mismatched: [] }],
    ['a different resolved version', base, { ...base, 'b@2.1.0': undefined, 'b@2.2.0': B }, { onlyPnpm: ['b@2.1.0'], onlyBun: ['b@2.2.0'], mismatched: [] }],
    ['a different integrity', base, { ...base, 'b@2.1.0': A }, { onlyPnpm: [], onlyBun: [], mismatched: ['b@2.1.0'] }],
  ])('detects %s', (_name, pnpm, bun, expected) => {
    const clean = Object.fromEntries(Object.entries(bun).filter(([, value]) => value !== undefined)) as Record<string, string>
    const result = compareLockfiles(pnpmLock(pnpm as Record<string, string>), bunLock(clean))
    expect(result).toMatchObject(expected)
    expect(formatReport(result)).toContain('Lockfile parity FAILED')
  })

  it('exits 0 for matching files, 1 with a short diff for a mismatch, 2 for an unreadable or empty lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'navide-lock-parity-'))
    roots.push(root)
    const write = (name: string, text: string) => { writeFileSync(join(root, name), text); return join(root, name) }
    const pnpm = write('pnpm-lock.yaml', pnpmLock(base))
    const same = write('bun.same.lock', bunLock(base))
    const drift = write('bun.drift.lock', bunLock({ ...base, 'b@2.1.0': A }))
    const empty = write('bun.empty.lock', '{ "packages": {} }')
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

    expect(run(pnpm, same)).toMatchObject({ status: 0, stdout: expect.stringContaining('Lockfile parity OK') })
    const failed = run(pnpm, drift)
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('same name@version, different integrity (1):')
    expect(failed.stderr).toContain('b@2.1.0')
    expect(run(pnpm, empty).status).toBe(2)
    expect(run(pnpm, join(root, 'missing.lock')).status).toBe(2)
  })
})
