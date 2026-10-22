import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformId, setPlatformId, type PlatformId } from '../shared/osplat'
import {
  clampHealthCheckTimeoutSec,
  defaultHealthCheckTimeoutSec,
  parseHealthCheckTimeoutDoc,
  readHealthCheckTimeoutSec,
  writeHealthCheckTimeoutSec,
  DEFAULT_HEALTH_CHECK_TIMEOUT_SEC,
  LINUX_DEFAULT_HEALTH_CHECK_TIMEOUT_SEC,
  MAX_HEALTH_CHECK_TIMEOUT_SEC,
} from './health-timeout'

describe('clampHealthCheckTimeoutSec', () => {
  it('clamps below the 15s floor', () => {
    expect(clampHealthCheckTimeoutSec(1)).toBe(15)
  })
  it('clamps above the ceiling', () => {
    expect(clampHealthCheckTimeoutSec(5_000)).toBe(MAX_HEALTH_CHECK_TIMEOUT_SEC)
  })
  it('leaves a long-but-allowed wait alone — a slow first launch is not a failure', () => {
    expect(clampHealthCheckTimeoutSec(300)).toBe(300)
  })
  it('rounds an in-range value', () => {
    expect(clampHealthCheckTimeoutSec(60.6)).toBe(61)
  })
  it('falls back to the default for non-finite input', () => {
    expect(clampHealthCheckTimeoutSec(NaN)).toBe(defaultHealthCheckTimeoutSec())
  })
})

describe('parseHealthCheckTimeoutDoc', () => {
  it('returns the default for missing or corrupt content', () => {
    for (const text of [null, '', 'not json', '{}']) {
      expect(parseHealthCheckTimeoutDoc(text)).toBe(defaultHealthCheckTimeoutSec())
    }
  })
  it('parses and clamps a valid doc', () => {
    expect(parseHealthCheckTimeoutDoc(JSON.stringify({ timeoutSec: 90 }))).toBe(90)
    expect(parseHealthCheckTimeoutDoc(JSON.stringify({ timeoutSec: 5 }))).toBe(15)
  })
})

describe('readHealthCheckTimeoutSec / writeHealthCheckTimeoutSec', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-timeout-'))
    file = join(dir, 'health-check-timeout.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the default when no file exists yet', () => {
    expect(readHealthCheckTimeoutSec(file)).toBe(defaultHealthCheckTimeoutSec())
  })

  it('round-trips a written value', () => {
    writeHealthCheckTimeoutSec(file, 75)
    expect(readHealthCheckTimeoutSec(file)).toBe(75)
  })

  it('clamps an out-of-range value on write', () => {
    writeHealthCheckTimeoutSec(file, 9_999)
    expect(readHealthCheckTimeoutSec(file)).toBe(MAX_HEALTH_CHECK_TIMEOUT_SEC)
  })

  it('survives a corrupt file on disk', () => {
    writeFileSync(file, '{truncated', 'utf-8')
    expect(readHealthCheckTimeoutSec(file)).toBe(defaultHealthCheckTimeoutSec())
  })
})

describe('platform default', () => {
  const original = platformId()
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'health-timeout-platform-'))
    file = join(dir, 'health-check-timeout.json')
  })
  afterEach(() => {
    setPlatformId(original)
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it.each<[PlatformId, number]>([
    ['linux', 120],
    ['darwin', 45],
    ['win32', 120],
  ])('%s defaults to %is when nothing is configured', (platform, expected) => {
    setPlatformId(platform)
    expect(defaultHealthCheckTimeoutSec()).toBe(expected)
    expect(readHealthCheckTimeoutSec(file)).toBe(expected)
    expect(clampHealthCheckTimeoutSec(NaN)).toBe(expected)
  })

  it('keeps macOS on the original 45s and gives Linux and Windows 120s', () => {
    expect(DEFAULT_HEALTH_CHECK_TIMEOUT_SEC).toBe(45)
    expect(LINUX_DEFAULT_HEALTH_CHECK_TIMEOUT_SEC).toBe(120)
  })

  it.each<PlatformId>(['linux', 'darwin', 'win32'])('a configured value wins over the %s default', (platform) => {
    setPlatformId(platform)
    writeHealthCheckTimeoutSec(file, 30)
    expect(readHealthCheckTimeoutSec(file)).toBe(30)
  })

  it.each<[PlatformId, number]>([
    ['linux', 120],
    ['darwin', 45],
    ['win32', 120],
  ])('a corrupt file on %s falls back to %is', (platform, expected) => {
    setPlatformId(platform)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    writeFileSync(file, '{truncated', 'utf-8')
    expect(readHealthCheckTimeoutSec(file)).toBe(expected)
  })
})
