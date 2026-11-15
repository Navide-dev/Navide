import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CACHE_CONTROL,
  DEFAULT_BUCKET,
  assertHelpKey,
  mergeManifest,
  planUploads,
  putObjectArgs,
} from '../../scripts/upload-help-screenshots.mjs'

const SCRIPT = join(__dirname, '../../scripts/upload-help-screenshots.mjs')
const MANIFEST = join(__dirname, '../../src/renderer/src/lib/helpScreenshots.json')

describe('upload-help-screenshots', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'help-shots-'))
    mkdirSync(join(dir, 'zh-TW'))
    mkdirSync(join(dir, 'en-US'))
    writeFileSync(join(dir, 'zh-TW', 'cliAgents.menu.png'), 'zh picture')
    writeFileSync(join(dir, 'en-US', 'cliAgents.menu.webp'), 'en picture')
    writeFileSync(join(dir, 'zh-TW', 'notes.txt'), 'ignored')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('plans content-hashed keys under help/ only', () => {
    const plans = planUploads(dir)
    expect(plans.map((p) => p.key)).toEqual([
      expect.stringMatching(/^help\/cliAgents\.menu\/en-US\/[0-9a-f]{12}\.webp$/),
      expect.stringMatching(/^help\/cliAgents\.menu\/zh-TW\/[0-9a-f]{12}\.png$/),
    ])
    writeFileSync(join(dir, 'zh-TW', 'cliAgents.menu.png'), 'new zh picture')
    expect(planUploads(dir)[1].key).not.toBe(plans[1].key)
  })

  it.each([
    'releases/latest/latest-mac.yml',
    'help/../releases/latest/x.png',
    'help/x.png',
    'help/a/zh-TW/notahash.png',
    'help/a/zh-TW/0123456789ab.yml',
    '/help/a/zh-TW/0123456789ab.png',
  ])('refuses the key %s', (key) => {
    expect(() => assertHelpKey(key)).toThrow(/outside help/)
  })

  it('rejects a screenshot id that would escape help/', () => {
    writeFileSync(join(dir, 'zh-TW', '..releases.png'), 'x')
    expect(() => planUploads(dir)).toThrow()
  })

  it('uploads with a single PutObject per file and an immutable cache header', () => {
    const [plan] = planUploads(dir)
    const args = putObjectArgs(plan)
    expect(args.slice(0, 2)).toEqual(['s3api', 'put-object'])
    expect(args).toContain(DEFAULT_BUCKET)
    expect(args[args.indexOf('--cache-control') + 1]).toBe(CACHE_CONTROL)
    expect(args.join(' ')).not.toMatch(/delete|sync|releases\//)
  })

  it('never issues sync or delete anywhere in the script', () => {
    const source = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n')
    expect(source).not.toMatch(/'sync'|'rm'|delete-object|--delete/)
  })

  it('merges uploads into the manifest without dropping other entries', () => {
    const merged = mergeManifest({ schemaVersion: 1, shots: { 'mcp.settings': { 'zh-TW': 'aaaaaaaaaaaa.png' } } }, planUploads(dir))
    expect(Object.keys(merged.shots)).toEqual(['cliAgents.menu', 'mcp.settings'])
    expect(Object.keys(merged.shots['cliAgents.menu']).sort()).toEqual(['en-US', 'zh-TW'])
  })

  it('dry-runs by default: prints the plan, uploads nothing, leaves the manifest alone', () => {
    const before = readFileSync(MANIFEST, 'utf8')
    // PATH without aws: a dry run must not need (or call) it.
    const out = execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', env: { ...process.env, PATH: '' } })
    expect(out).toMatch(/would upload zh-TW\/cliAgents\.menu\.png -> s3:\/\/navide-releases\/help\/cliAgents\.menu\/zh-TW\//)
    expect(out).toContain('dry run: 2 file(s), nothing uploaded')
    expect(readFileSync(MANIFEST, 'utf8')).toBe(before)
  })
})
