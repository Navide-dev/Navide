import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validatePluginDetailTarget } from './pluginDetailTargetSchema'

const fsRace = vi.hoisted(() => ({
  onOpen: null as ((path: string) => void) | null,
  readChunkSize: null as number | null,
  opened: 0,
  closed: 0,
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const positionalReadSync = actual.readSync as unknown as (
    fd: number,
    buffer: NodeJS.TypedArray,
    offset: number,
    length: number,
    position: number | null,
  ) => number
  return {
    ...actual,
    openSync: (path: Parameters<typeof actual.openSync>[0], flags: Parameters<typeof actual.openSync>[1], mode?: Parameters<typeof actual.openSync>[2]) => {
      fsRace.opened += 1
      fsRace.onOpen?.(String(path))
      return actual.openSync(path, flags, mode)
    },
    readSync: (fd: number, buffer: NodeJS.TypedArray, offset: number, length: number, position?: number | null) =>
      positionalReadSync(fd, buffer, offset, fsRace.readChunkSize === null ? length : Math.min(length, fsRace.readChunkSize), position ?? null),
    closeSync: (fd: number) => {
      fsRace.closed += 1
      return actual.closeSync(fd)
    },
  }
})

// The pinned navide.git version's manifest and target schema.
const gitPackageDir = resolve(process.cwd(), 'tests/fixtures/navide-git')
const temporaryPackages: string[] = []

afterEach(() => {
  fsRace.onOpen = null
  fsRace.readChunkSize = null
  fsRace.opened = 0
  fsRace.closed = 0
  for (const packageDir of temporaryPackages.splice(0)) {
    rmSync(packageDir, { recursive: true, force: true })
  }
})

function temporaryPackage(schemaText: string): { packageDir: string; targetSchema: string } {
  const packageDir = mkdtempSync(join(tmpdir(), 'navide-detail-target-'))
  const schemasDir = join(packageDir, 'schemas')
  mkdirSync(schemasDir)
  writeFileSync(join(schemasDir, 'target.json'), schemaText)
  temporaryPackages.push(packageDir)
  return { packageDir, targetSchema: 'schemas/target.json' }
}

function validateGit(target: unknown) {
  return validatePluginDetailTarget({
    packageDir: gitPackageDir,
    targetSchema: 'schemas/branch-comparison.json',
    target,
  })
}

describe('validatePluginDetailTarget', () => {
  it('accepts the installed Git branch-comparison target', () => {
    const target = {
      resource: { kind: 'branch-comparison', repository: '.', base: 'main', compare: 'topic' },
      presentation: { mode: 'branch-diff' },
    }

    expect(validateGit(target)).toEqual({ ok: true, target })
  })

  it('accepts Git discriminated variants independently of property order', () => {
    const target = {
      presentation: { mode: 'diff' },
      resource: { commit: 'HEAD', staged: false, filepath: 'src/main.ts', repository: '.', kind: 'file-diff' },
    }

    expect(validateGit(target)).toEqual({ ok: true, target })
  })

  it('rejects unknown target fields as invalid-target', () => {
    expect(validateGit({
      resource: { kind: 'branch-comparison', repository: '.', base: 'main', compare: 'topic', extra: true },
      presentation: { mode: 'branch-diff' },
    })).toEqual({ ok: false, reason: 'invalid-target' })
  })

  it('rejects mismatched signed resource and presentation variants', () => {
    expect(validateGit({
      resource: { kind: 'merge-conflict', repository: '.', filepath: 'src/main.ts' },
      presentation: { mode: 'branch-diff' },
    })).toEqual({ ok: false, reason: 'invalid-target' })
  })

  it('rejects malformed and unsupported schemas as invalid-schema', () => {
    const malformed = temporaryPackage('{"type":"object",')
    expect(validatePluginDetailTarget({
      packageDir: malformed.packageDir,
      targetSchema: malformed.targetSchema,
      target: {},
    })).toEqual({ ok: false, reason: 'invalid-schema' })

    const unsupported = temporaryPackage(JSON.stringify({
      type: 'object',
      additionalProperties: false,
      patternProperties: { '^x-': { type: 'string' } },
    }))
    expect(validatePluginDetailTarget({
      packageDir: unsupported.packageDir,
      targetSchema: unsupported.targetSchema,
      target: { 'x-name': 'value' },
    })).toEqual({ ok: false, reason: 'invalid-schema' })
  })

  it('rejects duplicate JSON keys in a schema as invalid-schema', () => {
    const duplicate = temporaryPackage('{"type":"object","type":"string"}')

    expect(validatePluginDetailTarget({
      packageDir: duplicate.packageDir,
      targetSchema: duplicate.targetSchema,
      target: {},
    })).toEqual({ ok: false, reason: 'invalid-schema' })
  })

  it('rejects schema paths outside the package and symlinked assets', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'navide-detail-target-path-'))
    const schemasDir = join(packageDir, 'schemas')
    const outsideDir = mkdtempSync(join(tmpdir(), 'navide-detail-target-outside-'))
    mkdirSync(schemasDir)
    const outsideSchema = join(outsideDir, 'outside.json')
    writeFileSync(outsideSchema, JSON.stringify({ type: 'object', additionalProperties: false }))
    symlinkSync(outsideSchema, join(schemasDir, 'linked.json'))
    temporaryPackages.push(packageDir, outsideDir)

    expect(validatePluginDetailTarget({
      packageDir,
      targetSchema: '../outside.json',
      target: {},
    })).toEqual({ ok: false, reason: 'invalid-schema' })
    expect(validatePluginDetailTarget({
      packageDir,
      targetSchema: 'schemas/linked.json',
      target: {},
    })).toEqual({ ok: false, reason: 'invalid-schema' })
  })

  it('rejects schemas beyond the bounded size and depth limits', () => {
    const largeProperties: Record<string, { type: string }> = {}
    for (let index = 0; index < 20_000; index += 1) {
      largeProperties[`field${index}`] = { type: 'string' }
    }
    const large = temporaryPackage(JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: largeProperties,
    }))
    expect(validatePluginDetailTarget({
      packageDir: large.packageDir,
      targetSchema: large.targetSchema,
      target: {},
    })).toEqual({ ok: false, reason: 'invalid-schema' })

    let deep: Record<string, unknown> = { type: 'string' }
    for (let index = 0; index < 64; index += 1) {
      deep = { type: 'object', additionalProperties: false, properties: { child: deep } }
    }
    const deepSchema = temporaryPackage(JSON.stringify(deep))
    expect(validatePluginDetailTarget({
      packageDir: deepSchema.packageDir,
      targetSchema: deepSchema.targetSchema,
      target: {},
    })).toEqual({ ok: false, reason: 'invalid-schema' })
  })

  it('rejects a missing or unreadable target schema as invalid-schema', () => {
    expect(validatePluginDetailTarget({
      packageDir: gitPackageDir,
      targetSchema: undefined,
      target: {},
    })).toEqual({ ok: false, reason: 'invalid-schema' })

    expect(validatePluginDetailTarget({
      packageDir: gitPackageDir,
      targetSchema: 'schemas/missing.json',
      target: {},
    })).toEqual({ ok: false, reason: 'invalid-schema' })
  })

  it('rejects a final schema file replaced after initial stat and closes the opened descriptor', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'navide-detail-target-file-race-'))
    const schemasDir = join(packageDir, 'schemas')
    const schemaPath = join(schemasDir, 'target.json')
    const replacementPath = join(schemasDir, 'replacement.json')
    mkdirSync(schemasDir)
    writeFileSync(schemaPath, JSON.stringify({ type: 'object', additionalProperties: false, properties: {}, required: [] }))
    writeFileSync(replacementPath, JSON.stringify({ type: 'object', additionalProperties: false, properties: {}, required: [] }))
    temporaryPackages.push(packageDir)

    let replaced = false
    fsRace.onOpen = (path) => {
      if (!replaced && String(path).endsWith(`${sep}${join('schemas', 'target.json')}`)) {
        replaced = true
        renameSync(schemaPath, join(schemasDir, 'initial.json'))
        renameSync(replacementPath, schemaPath)
      }
    }
    try {
      expect(validatePluginDetailTarget({ packageDir, targetSchema: 'schemas/target.json', target: {} }))
        .toEqual({ ok: false, reason: 'invalid-schema' })
      expect(fsRace.opened).toBeLessThanOrEqual(2)
      expect(fsRace.closed).toBeGreaterThan(0)
    } finally {
      fsRace.onOpen = null
    }
  })

  it('rejects a schemas directory replaced after initial stat and closes descriptors on the invalid path', () => {
    const packageDir = mkdtempSync(join(tmpdir(), 'navide-detail-target-directory-race-'))
    const schemasDir = join(packageDir, 'schemas')
    const replacementDir = join(packageDir, 'schemas-replacement')
    const schemaText = JSON.stringify({ type: 'object', additionalProperties: false, properties: {}, required: [] })
    mkdirSync(schemasDir)
    mkdirSync(replacementDir)
    writeFileSync(join(schemasDir, 'target.json'), schemaText)
    writeFileSync(join(replacementDir, 'target.json'), schemaText)
    temporaryPackages.push(packageDir)

    let replaced = false
    fsRace.onOpen = (path) => {
      if (!replaced && String(path).endsWith(`${sep}${join('schemas', 'target.json')}`)) {
        replaced = true
        renameSync(schemasDir, join(packageDir, 'schemas-initial'))
        renameSync(replacementDir, schemasDir)
      }
    }
    try {
      expect(validatePluginDetailTarget({ packageDir, targetSchema: 'schemas/target.json', target: {} }))
        .toEqual({ ok: false, reason: 'invalid-schema' })
      expect(fsRace.closed).toBeGreaterThan(0)
    } finally {
      fsRace.onOpen = null
    }
  })

  it('reconstructs a valid schema across bounded positional short reads', () => {
    const schema = temporaryPackage(JSON.stringify({
      type: 'object', additionalProperties: false, properties: {}, required: [],
    }))
    fsRace.readChunkSize = 3

    expect(validatePluginDetailTarget({
      packageDir: schema.packageDir,
      targetSchema: schema.targetSchema,
      target: {},
    })).toEqual({ ok: true, target: {} })
  })

  it('rejects trailing bytes after a valid JSON prefix across short reads', () => {
    const schema = temporaryPackage(`${JSON.stringify({
      type: 'object', additionalProperties: false, properties: {}, required: [],
    })} trailing-bytes`)
    fsRace.readChunkSize = 3

    expect(validatePluginDetailTarget({
      packageDir: schema.packageDir,
      targetSchema: schema.targetSchema,
      target: {},
    })).toEqual({ ok: false, reason: 'invalid-schema' })
    expect(fsRace.closed).toBeGreaterThan(0)
  })
})
