import { app } from 'electron'
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Total retained diagnostic capacity: 4 MB active + 4 MB rotated.
 *
 * This log now also carries one line per stderr line of every plugin backend
 * child, so a crash-looping backend evicts history fast. The 256 KB this used
 * to be held roughly two thousand lines, which is less than one restart loop —
 * the Git v2 → legacy recovery reason this file exists to preserve would be
 * gone before the user ever looked. It also truncated any single entry over
 * 128 KB. 8 MB keeps a full session of diagnostics and never truncates a real
 * stack trace, and costs 8 MB of disk per user profile at worst — beside the
 * backend's own log in the same directory, which already rotates at 10 MB
 * across 5 generations.
 */
export const DEFAULT_MAX_DIAGNOSTIC_LOG_BYTES = 8 * 1024 * 1024

let configuredMaxLogBytes = DEFAULT_MAX_DIAGNOSTIC_LOG_BYTES
let customLogDir: string | null = null

/**
 * Size bookkeeping for the active log, tracked in memory so that an ordinary
 * line costs one append syscall and nothing else. `logMain` is called once per
 * stderr line of a plugin backend child, so anything it does per call runs on
 * the main thread once per line of a crash-looping backend's output.
 * `trackedLogPath` is null whenever the count cannot be trusted — before the
 * first write, after a configuration change, and after a failed write.
 */
let trackedLogPath: string | null = null
let trackedActiveBytes = 0

function invalidateSizeBookkeeping(): void {
  trackedLogPath = null
  trackedActiveBytes = 0
}

export function setMaxDiagnosticLogBytes(bytes: number): void {
  configuredMaxLogBytes = Math.max(256, bytes)
  invalidateSizeBookkeeping()
}

export function getMaxDiagnosticLogBytes(): number {
  return configuredMaxLogBytes
}

export function setLogDirectory(dir: string | null): void {
  customLogDir = dir
  invalidateSizeBookkeeping()
}

export function resetDiagnosticLogConfig(): void {
  configuredMaxLogBytes = DEFAULT_MAX_DIAGNOSTIC_LOG_BYTES
  customLogDir = null
  invalidateSizeBookkeeping()
}

export function getRetainedLogBytes(dir?: string): number {
  try {
    const targetDir = dir ?? customLogDir ?? join(app.getPath('userData'), 'logs')
    let total = 0
    try {
      total += statSync(join(targetDir, 'main.log')).size
    } catch {
      /* file not present */
    }
    try {
      total += statSync(join(targetDir, 'main.log.1')).size
    } catch {
      /* file not present */
    }
    return total
  } catch {
    return 0
  }
}

/**
 * Truncate a UTF-8 string to fit within `maxBytes` without cutting inside a
 * multi-byte character sequence.
 */
export function truncateUtf8Bytes(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buf = Buffer.from(str, 'utf8')
  if (buf.byteLength <= maxBytes) return str

  let end = maxBytes
  let i = end - 1
  while (i >= 0 && i >= end - 4) {
    const byte = buf[i]
    if ((byte & 0xc0) === 0xc0) {
      let seqLen = 1
      if ((byte & 0xe0) === 0xc0) seqLen = 2
      else if ((byte & 0xf0) === 0xe0) seqLen = 3
      else if ((byte & 0xf8) === 0xf0) seqLen = 4
      if (i + seqLen > end) {
        end = i
      }
      break
    } else if ((byte & 0x80) === 0) {
      break
    }
    i--
  }
  return buf.subarray(0, end).toString('utf8')
}

/**
 * Trim an oversized log file to keep at most `maxBytes` from its tail,
 * aligning to a newline boundary or valid UTF-8 lead byte.
 */
export function trimFileTail(filePath: string, maxBytes: number): void {
  try {
    const stat = statSync(filePath)
    if (stat.size <= maxBytes) return
    if (maxBytes <= 0) {
      writeFileSync(filePath, '', 'utf8')
      return
    }

    const start = stat.size - maxBytes
    const fd = openSync(filePath, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const bytesRead = readSync(fd, buffer, 0, maxBytes, start)
    closeSync(fd)

    let slice = buffer.subarray(0, bytesRead)
    const firstNewline = slice.indexOf(0x0a)
    if (firstNewline >= 0 && firstNewline < slice.length - 1) {
      slice = slice.subarray(firstNewline + 1)
    } else {
      let offset = 0
      while (offset < slice.length && (slice[offset] & 0xc0) === 0x80) {
        offset++
      }
      slice = slice.subarray(offset)
    }
    writeFileSync(filePath, slice)
  } catch {
    /* best effort */
  }
}

/**
 * Measure the log pair once per path and bring both files inside their bound.
 * A previous run, an older build with a different capacity, or an external
 * editor can all leave an oversized file behind; enforcing it here means the
 * per-line path can rely on the tracked count alone.
 *
 * Returns the size of the active log after any trimming.
 */
function initializeSizeBookkeeping(dir: string, logPath: string, rotatedPath: string, halfCapacity: number): number {
  mkdirSync(dir, { recursive: true })

  let rotatedSize = 0
  try {
    rotatedSize = statSync(rotatedPath).size
  } catch {
    rotatedSize = 0
  }
  if (rotatedSize > halfCapacity) {
    trimFileTail(rotatedPath, halfCapacity)
  }

  let activeSize = 0
  try {
    activeSize = statSync(logPath).size
  } catch {
    activeSize = 0
  }
  if (activeSize > halfCapacity) {
    trimFileTail(logPath, halfCapacity)
    try {
      activeSize = statSync(logPath).size
    } catch {
      activeSize = 0
    }
  }
  return activeSize
}

/**
 * Write one entry, recreating the log directory and retrying once if it was
 * removed mid-session — the per-line path no longer calls `mkdirSync` itself.
 */
function writeLogEntry(dir: string, logPath: string, entry: string, replace: boolean): void {
  try {
    if (replace) writeFileSync(logPath, entry, 'utf8')
    else appendFileSync(logPath, entry, 'utf8')
  } catch {
    mkdirSync(dir, { recursive: true })
    if (replace) writeFileSync(logPath, entry, 'utf8')
    else appendFileSync(logPath, entry, 'utf8')
  }
}

/**
 * Append one timestamped line to `<userData>/logs/main.log`, beside the
 * backend's own log, rotating to `main.log.1` when exceeding configured capacity.
 *
 * The main process only had stdout, which a packaged launch discards. A
 * degradation that merely `console.warn`ed — the Git v2 → legacy recovery
 * reason above all — therefore left no evidence at all once the app was
 * running, and the reason could not be recovered afterwards. Best-effort by
 * design: a logging failure must never take down the caller.
 */
export function logMain(line: string): void {
  try {
    const dir = customLogDir ?? join(app.getPath('userData'), 'logs')
    const logPath = join(dir, 'main.log')
    const rotatedPath = join(dir, 'main.log.1')

    const halfCapacity = Math.max(128, Math.floor(configuredMaxLogBytes / 2))
    const rawEntry = `${new Date().toISOString()} ${line}`
    const rawEntryBytes = Buffer.byteLength(rawEntry + '\n', 'utf8')
    let entry: string
    let entryBytes: number

    if (rawEntryBytes > halfCapacity) {
      const budget = Math.max(0, halfCapacity - Buffer.byteLength('... [entry truncated]\n', 'utf8'))
      const truncated = truncateUtf8Bytes(rawEntry, budget)
      entry = `${truncated}... [entry truncated]\n`
      entryBytes = Buffer.byteLength(entry, 'utf8')
    } else {
      entry = `${rawEntry}\n`
      entryBytes = rawEntryBytes
    }

    if (trackedLogPath !== logPath) {
      trackedActiveBytes = initializeSizeBookkeeping(dir, logPath, rotatedPath, halfCapacity)
      trackedLogPath = logPath
    }

    // Both files are held at or below `halfCapacity` by construction, so the
    // total stays within capacity without re-measuring anything per line.
    const rotate = trackedActiveBytes + entryBytes > halfCapacity
    if (rotate) {
      try {
        renameSync(logPath, rotatedPath)
      } catch {
        /* best effort */
      }
      trimFileTail(rotatedPath, halfCapacity)
    }

    writeLogEntry(dir, logPath, entry, rotate)
    trackedActiveBytes = rotate ? entryBytes : trackedActiveBytes + entryBytes
  } catch {
    /* observability is never worth a crash */
    invalidateSizeBookkeeping()
  }
}

/** `console.warn` for a live terminal, plus a durable line for a packaged run. */
export function warnMain(line: string): void {
  console.warn(line)
  logMain(line)
}

/** `console.log` plus a durable line — for lifecycle events worth keeping. */
export function infoMain(line: string): void {
  console.log(line)
  logMain(line)
}

/** `console.error` plus a durable line, with the error's text appended. */
export function errorMain(line: string, err?: unknown): void {
  if (err === undefined) console.error(line)
  else console.error(line, err)
  logMain(err === undefined ? line : `${line}: ${String(err)}`)
}
