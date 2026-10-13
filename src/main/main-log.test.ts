import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  logMain,
  warnMain,
  infoMain,
  errorMain,
  setMaxDiagnosticLogBytes,
  setLogDirectory,
  resetDiagnosticLogConfig,
  getRetainedLogBytes,
  truncateUtf8Bytes,
  trimFileTail,
} from './main-log'

describe('durable plugin diagnostic persistence in main-log', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'navide-main-log-test-'))
    setLogDirectory(tempDir)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetDiagnosticLogConfig()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('keeps backend lifecycle info and errors in main.log, not only on stdout', () => {
    // 2026-10-08: a packaged run's "backend failed to start" / auto-restart
    // lines went to console only, so the cause of a Retry screen was lost.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    infoMain('[main] backend ready at 127.0.0.1:58426')
    errorMain('[main] backend failed to start', new Error('backend did not become healthy within 45000ms'))
    errorMain('[main] backend exited (code 0)')

    const content = readFileSync(join(tempDir, 'main.log'), 'utf8')
    expect(content).toContain('[main] backend ready at 127.0.0.1:58426')
    expect(content).toContain('[main] backend failed to start: Error: backend did not become healthy within 45000ms')
    expect(content).toContain('[main] backend exited (code 0)\n')
    expect(log).toHaveBeenCalledWith('[main] backend ready at 127.0.0.1:58426')
    expect(error).toHaveBeenCalledWith('[main] backend failed to start', expect.any(Error))
  })

  it('bounds total retained diagnostic capacity across repeated backend generations and restarts', () => {
    const configuredCapacity = 1024
    setMaxDiagnosticLogBytes(configuredCapacity)

    // Simulate repeated diagnostic emissions from failing/restarting plugin child generations
    for (let gen = 1; gen <= 60; gen++) {
      warnMain(`[plugin-backend] Generation ${gen} child failure: spawn /custom/private/plans ENOENT`)
    }

    const retainedBytes = getRetainedLogBytes(tempDir)
    expect(retainedBytes).toBeGreaterThan(0)
    expect(retainedBytes).toBeLessThanOrEqual(configuredCapacity)

    // Verify main.log exists and contains recent diagnostics with trusted Host prefix
    const activeLogPath = join(tempDir, 'main.log')
    expect(existsSync(activeLogPath)).toBe(true)
    const activeContent = readFileSync(activeLogPath, 'utf8')
    expect(activeContent).toContain('[plugin-backend]')
    expect(activeContent).not.toContain('\x1b')

    // Verify rotation file exists
    const rotatedLogPath = join(tempDir, 'main.log.1')
    expect(existsSync(rotatedLogPath)).toBe(true)
    const rotatedContent = readFileSync(rotatedLogPath, 'utf8')
    expect(rotatedContent).toContain('[plugin-backend]')

    // Ensure sum of both files matches getRetainedLogBytes and stays within configuredCapacity
    const sum = Buffer.byteLength(activeContent, 'utf8') + Buffer.byteLength(rotatedContent, 'utf8')
    expect(sum).toBe(retainedBytes)
    expect(sum).toBeLessThanOrEqual(configuredCapacity)
  })

  it('truncates single oversized diagnostic entries to prevent exceeding half capacity', () => {
    const configuredCapacity = 500
    setMaxDiagnosticLogBytes(configuredCapacity)

    const massiveDiagnostic = '[plugin-backend] ' + 'x'.repeat(2000)
    logMain(massiveDiagnostic)

    const retainedBytes = getRetainedLogBytes(tempDir)
    expect(retainedBytes).toBeLessThanOrEqual(configuredCapacity)

    const content = readFileSync(join(tempDir, 'main.log'), 'utf8')
    expect(content).toContain('[entry truncated]')
  })

  it('truncates multi-byte unicode text strictly by UTF-8 bytes without broken encoding', () => {
    const multiByteString = '繁體中文測試💥🚀錯誤報告路徑：/private/internal/plans'
    for (let maxBytes = 0; maxBytes <= 50; maxBytes++) {
      const truncated = truncateUtf8Bytes(multiByteString, maxBytes)
      const byteLen = Buffer.byteLength(truncated, 'utf8')
      expect(byteLen).toBeLessThanOrEqual(maxBytes)
      // Must not contain broken unicode replacement character
      expect(truncated).not.toContain('\uFFFD')
    }

    // Now test through logMain with configured capacity
    const configuredCapacity = 300 // halfCapacity is 150 bytes
    setMaxDiagnosticLogBytes(configuredCapacity)

    const multiByteDiagnostic = '[plugin-backend] ' + '這是一個很長的錯誤訊息包含中文字元和表情符號💥'.repeat(10)
    logMain(multiByteDiagnostic)

    const activeLogPath = join(tempDir, 'main.log')
    const content = readFileSync(activeLogPath, 'utf8')
    const byteLen = Buffer.byteLength(content, 'utf8')
    expect(byteLen).toBeLessThanOrEqual(150)
    expect(content).not.toContain('\uFFFD')
    expect(content).toContain('[entry truncated]')
    expect(content).toContain('[plugin-backend]')
  })

  it('handles a pre-existing oversized main.log so rotation never leaves an oversized .1 file', () => {
    const configuredCapacity = 1000
    const halfCapacity = 500
    setMaxDiagnosticLogBytes(configuredCapacity)

    const activeLogPath = join(tempDir, 'main.log')
    const rotatedLogPath = join(tempDir, 'main.log.1')

    // Seed a pre-existing oversized main.log (e.g. 5000 bytes)
    const largeOldContent = Array.from({ length: 100 }, (_, i) => `2026-09-03T10:00:00.000Z [plugin-backend] pre-existing line ${i}\n`).join('')
    writeFileSync(activeLogPath, largeOldContent, 'utf8')
    expect(statSync(activeLogPath).size).toBeGreaterThan(configuredCapacity)

    // Append a new diagnostic entry, which triggers rotation
    logMain('[plugin-backend] new diagnostic line after restart')

    // Rotation occurred: main.log.1 was created from trimmed main.log
    expect(existsSync(rotatedLogPath)).toBe(true)
    const rotatedSize = statSync(rotatedLogPath).size
    expect(rotatedSize).toBeLessThanOrEqual(halfCapacity)
    expect(rotatedSize).toBeGreaterThan(0)

    // Active main.log has the new entry and is <= halfCapacity
    expect(existsSync(activeLogPath)).toBe(true)
    const activeSize = statSync(activeLogPath).size
    expect(activeSize).toBeLessThanOrEqual(halfCapacity)
    expect(activeSize).toBeGreaterThan(0)

    // Total active + rotated capacity is strictly enforced
    const totalBytes = getRetainedLogBytes(tempDir)
    expect(totalBytes).toBe(activeSize + rotatedSize)
    expect(totalBytes).toBeLessThanOrEqual(configuredCapacity)

    // Rotated log contains valid recent lines without broken characters
    const rotatedContent = readFileSync(rotatedLogPath, 'utf8')
    expect(rotatedContent).toContain('[plugin-backend]')
    expect(rotatedContent).not.toContain('\uFFFD')
  })

  it('enforces total active plus rotated capacity strictly after every write even when rotated log was oversized', () => {
    const configuredCapacity = 600
    setMaxDiagnosticLogBytes(configuredCapacity)

    const activeLogPath = join(tempDir, 'main.log')
    const rotatedLogPath = join(tempDir, 'main.log.1')

    // Seed both main.log and main.log.1 with large content
    writeFileSync(rotatedLogPath, 'x'.repeat(2000) + '\n', 'utf8')
    writeFileSync(activeLogPath, 'y'.repeat(200) + '\n', 'utf8')

    logMain('[plugin-backend] latest entry')

    const activeSize = statSync(activeLogPath).size
    const rotatedSize = statSync(rotatedLogPath).size
    expect(activeSize + rotatedSize).toBeLessThanOrEqual(configuredCapacity)
    expect(getRetainedLogBytes(tempDir)).toBeLessThanOrEqual(configuredCapacity)
  })
})
