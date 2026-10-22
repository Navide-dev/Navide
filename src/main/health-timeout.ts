import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isLinux, isWindows } from '../shared/osplat'

// Health-check timeout (seconds): how long startBackend() waits for /health
// before giving up. User-configurable (Settings UI), persisted in a small
// main-owned JSON file in userData rather than renderer localStorage, because
// main needs the value before any renderer window exists (see index.ts's
// app.whenReady() → startBackend() ordering).

export const DEFAULT_HEALTH_CHECK_TIMEOUT_SEC = 45
// Linux ships the backend as a PyInstaller onefile inside an AppImage: the
// first launch unpacks through the FUSE mount and imports cold, measured at up
// to 44s on an arm64 VM — right at the 45s default. Windows gets the same
// headroom: a fresh install's first launch unpacks the PyInstaller backend into
// _MEI while Defender scans every new file, measured at up to 58.75s on a
// Windows 11 arm64 VM, past the 45s default. macOS stays at 45s.
export const LINUX_DEFAULT_HEALTH_CHECK_TIMEOUT_SEC = 120

export function defaultHealthCheckTimeoutSec(): number {
  return isLinux() || isWindows() ? LINUX_DEFAULT_HEALTH_CHECK_TIMEOUT_SEC : DEFAULT_HEALTH_CHECK_TIMEOUT_SEC
}
export const MIN_HEALTH_CHECK_TIMEOUT_SEC = 15
// Ceiling on what the user may configure. Waiting longer costs nothing but
// patience, while too low a ceiling turns a slow first launch — building the
// Python venv, a cold disk, antivirus inspecting every file — into a reported
// failure of a backend that was starting fine.
export const MAX_HEALTH_CHECK_TIMEOUT_SEC = 600

export function clampHealthCheckTimeoutSec(raw: number): number {
  if (!Number.isFinite(raw)) return defaultHealthCheckTimeoutSec()
  return Math.min(MAX_HEALTH_CHECK_TIMEOUT_SEC, Math.max(MIN_HEALTH_CHECK_TIMEOUT_SEC, Math.round(raw)))
}

/** Parse a health-timeout file's text, tolerating missing/corrupt content. */
export function parseHealthCheckTimeoutDoc(text: string | null): number {
  if (!text) return defaultHealthCheckTimeoutSec()
  try {
    const data = JSON.parse(text)
    return clampHealthCheckTimeoutSec(Number(data?.timeoutSec))
  } catch (err) {
    // Content exists but is unreadable — the configured value is gone and the
    // user gets the default with no way to tell it apart from never having set
    // one. Say so: silently reverting a preference is the failure to avoid.
    console.warn('[health-timeout] corrupt document; falling back to the default', err)
    return defaultHealthCheckTimeoutSec()
  }
}

export function readHealthCheckTimeoutSec(filePath: string): number {
  let text: string | null = null
  try {
    text = readFileSync(filePath, 'utf-8')
  } catch (err) {
    // No file is the ordinary first-run case. Anything else — a permissions
    // problem, an I/O error — also silently became the default before, which
    // reads to the user as "my setting reverted itself".
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[health-timeout] read failed; falling back to the default', err)
    }
  }
  return parseHealthCheckTimeoutDoc(text)
}

export function writeHealthCheckTimeoutSec(filePath: string, sec: number): void {
  // Temp + rename, like the other main-owned stores: a bare writeFileSync
  // truncates first, so a crash mid-write leaves a partial file that parses to
  // the default — losing the value this call was saving.
  const doc = JSON.stringify({ timeoutSec: clampHealthCheckTimeoutSec(sec) })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, doc, 'utf-8')
  renameSync(tmp, filePath)
}
