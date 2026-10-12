import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { app, ipcMain, BrowserWindow } from 'electron'
import {
  createUpdaterService,
  DEFAULT_DOWNLOAD_RETRY_DELAYS_MS,
  type RestoredUpdateState,
  type UpdaterService,
} from './updater-service'
import { withMirrorFeed } from './updater-mirror-feed'
import { readUpdaterSettings, writeUpdaterSettings } from './updater-settings'
import { readUpdaterState, writeUpdaterState } from './updater-state-store'
import type { UpdateSettingsResult, UpdaterSettings, UpdateState, UpdateStatus } from '../shared/updater'
import { isLinux, isMac, isWindows } from '../shared/osplat'
import { warnMain } from './main-log'

/**
 * Whether this platform's install shape can update itself in place.
 *
 * macOS updates through Squirrel.Mac and Windows through the NSIS installer
 * electron-updater drives natively. Linux only when running as an AppImage —
 * the one shape electron-updater can rewrite; a .deb install updates through
 * the distribution's package manager, so offering in-app updates there would
 * fight the system that owns the file. Windows builds are not code-signed
 * yet, so until a certificate exists their updates install without signature
 * verification.
 */
export function inAppUpdateSupported(env: Record<string, string | undefined> = process.env): boolean {
  if (isMac() || isWindows()) return true
  return isLinux() && Boolean(env.APPIMAGE)
}

let service: UpdaterService | null = null
let settings: UpdaterSettings | null = null
let settingsFile = ''
let stateFile = ''
let persistedState = ''
let periodicTimer: ReturnType<typeof setInterval> | null = null
let lastPublishedStatus: UpdateStatus | null = null
let onInstallAbandoned: (() => void) | null = null
// Set when onInstallStarting waived the quit confirmation; the rollback fires
// once per waiver, whichever failure path (rejected precondition, error state,
// install timeout) reports the abandonment first.
let installWaived = false

function abandonInstall(): void {
  if (!installWaived) return
  installWaived = false
  onInstallAbandoned?.()
}

// Re-check for updates every 30 minutes in addition to the one-shot startup
// check, so a release published while the app is already running is picked up
// without waiting hours. Both are silent so a transient feed/network error
// never pops an error badge.
const PERIODIC_CHECK_MS = 30 * 60 * 1000

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

// Mirror the durable slice of the state to disk. Only the fields that outlive a
// session are written, and only when they actually change — download-progress
// alone publishes a new state several times a second.
function persistState(state: UpdateState): void {
  if (!stateFile) return
  const durable: RestoredUpdateState = {
    // checkedAt is absent from most statuses ('checking', 'downloading', …),
    // so carry the last known value forward rather than erasing it.
    checkedAt: state.checkedAt ?? readLastCheckedAt(),
    lastCheckFailure: state.lastCheckFailure,
  }
  const encoded = JSON.stringify(durable)
  if (encoded === persistedState) return
  persistedState = encoded
  writeUpdaterState(stateFile, durable)
}

function readLastCheckedAt(): string | undefined {
  if (!persistedState) return undefined
  try {
    return (JSON.parse(persistedState) as RestoredUpdateState).checkedAt
  } catch {
    return undefined
  }
}

function publishState(state: UpdateState): void {
  // An install that leaves 'installing' without the app going down (install
  // timeout, quitAndInstall error) must hand back whatever the host waived
  // when the install started — otherwise the quit-confirm dialog stays
  // disabled for the rest of the run.
  const wasInstalling = lastPublishedStatus === 'installing'
  lastPublishedStatus = state.status
  if (wasInstalling && state.status !== 'installing') abandonInstall()
  broadcast('updater:state-changed', state)
  persistState(state)
  if (state.status === 'error') console.error('[updater]', state.message)
  // Background auto-download: once an update is detected, kick off the download
  // without user action when enabled. download() is idempotent and only
  // proceeds from the 'available'/'error' states, so it self-guards against
  // double-download once it has moved the state to 'downloading'.
  // Only patch releases download silently; minor/major updates stay at
  // 'available' so the renderer can ask the user first.
  if (state.status === 'available' && state.severity === 'patch' && settings?.autoDownload) {
    queueMicrotask(() => {
      // Don't discard the result: a silent auto-download that fails otherwise
      // leaves no trace beyond the 'error' state. The service retries transient
      // failures itself; once it gives up, the next periodic check republishes
      // 'available' and this handler starts a fresh attempt.
      void service?.download().then((result) => {
        if (!result.ok) {
          console.warn('[updater] auto-download failed, will retry after the next check:', result.error)
        }
      })
    })
  }
}

// Turn the user's retry count into a backoff schedule. Retries disabled means
// an empty schedule; counts past the base schedule repeat its last delay.
function retryDelaysFor(current: UpdaterSettings | null): readonly number[] {
  if (!current?.retryDownload) return []
  const base = DEFAULT_DOWNLOAD_RETRY_DELAYS_MS
  return Array.from(
    { length: current.downloadRetryCount },
    (_, index) => base[Math.min(index, base.length - 1)],
  )
}

function applyChannel(next: UpdaterSettings): void {
  // NOTE: CI does not publish a beta feed yet; wiring the App side keeps it
  // ready. 'latest' is electron-updater's stable channel.
  autoUpdater.channel = next.channel === 'beta' ? 'beta' : 'latest'
  autoUpdater.allowPrerelease = next.channel === 'beta'
}

function startPeriodicCheck(): void {
  if (periodicTimer) return
  periodicTimer = setInterval(() => { void service?.check({ silent: true }) }, PERIODIC_CHECK_MS)
}

function stopPeriodicCheck(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
}

/**
 * Updater states in which the download cache still holds a payload the app
 * needs: the transfer in flight, the finished installer waiting for the user
 * to restart, and the install already running. Updater state is purely
 * in-memory in the updater service, so this is the single source of truth —
 * callers that delete the updater cache must check it first.
 */
const CACHE_BUSY_STATUSES: readonly UpdateStatus[] = ['downloading', 'downloaded', 'installing']

/**
 * The updater status that currently owns the download cache, or `null` when
 * the cache is free to delete.
 */
export function updaterCacheBusyStatus(): UpdateStatus | null {
  const status = service?.getState().status
  return status && CACHE_BUSY_STATUSES.includes(status) ? status : null
}

export function initUpdater(options: {
  enabled: boolean
  currentVersion: string
  checkDelayMs?: number
  /**
   * Called just before an install takes the app down, so the host can waive a
   * quit confirmation the user has effectively already given.
   */
  onInstallStarting?: () => void
  /**
   * Called when an install that started did not take the app down after all
   * (rejected precondition, quitAndInstall error, install timeout), so the
   * host can restore whatever onInstallStarting waived.
   */
  onInstallAbandoned?: () => void
}): void {
  if (service) return

  onInstallAbandoned = options.onInstallAbandoned ?? null
  settingsFile = join(app.getPath('userData'), 'updater-settings.json')
  settings = readUpdaterSettings(settingsFile)
  stateFile = join(app.getPath('userData'), 'updater-state.json')
  const restored = readUpdaterState(stateFile)
  persistedState = JSON.stringify(restored)

  service = createUpdaterService(
    // dl.navide.dev first, like the website; GitHub when the mirror cannot be reached.
    withMirrorFeed(autoUpdater),
    options.currentVersion,
    options.enabled,
    publishState,
    {
      // Read through to `settings` on use, so changing either preference takes
      // effect without rebuilding the service.
      installTimeoutMs: () => (settings?.installTimeoutSeconds ?? 20) * 1000,
      downloadRetryDelaysMs: () => retryDelaysFor(settings),
      restored,
      warn: warnMain,
    },
  )

  if (options.enabled) {
    applyChannel(settings)
    service.setAutoInstallOnQuit(settings.autoInstallOnQuit)
  }

  ipcMain.handle('updater:get-state', () => service!.getState())
  ipcMain.handle('updater:check', () => service!.check())
  ipcMain.handle('updater:download', () => service!.download())
  ipcMain.handle('updater:install', () => {
    // Before, not after: quitAndInstall can take the app down synchronously.
    options.onInstallStarting?.()
    installWaived = true
    const result = service!.install()
    // A rejected precondition never enters 'installing', so the state-change
    // rollback in publishState cannot fire — undo the waiver here. The throw
    // and timeout paths do transition, and publishState handles those.
    if (!result.ok) abandonInstall()
    return result
  })
  ipcMain.handle('updater:get-settings', (): UpdaterSettings => settings!)
  ipcMain.handle('updater:set-settings', (_event, patch: Partial<UpdaterSettings>): UpdateSettingsResult => {
    try {
      const wasAutoCheck = settings?.autoCheck ?? false
      settings = writeUpdaterSettings(settingsFile, patch ?? {})
      if (options.enabled) {
        applyChannel(settings)
        // Applies to the update already sitting in the cache too — turning the
        // switch on should not require re-downloading anything.
        service!.setAutoInstallOnQuit(settings.autoInstallOnQuit)
        if (settings.autoCheck) {
          startPeriodicCheck()
          // Turned on at runtime: check right away instead of waiting for the
          // next periodic tick, so ticking the box feels like it does something.
          if (!wasAutoCheck) void service!.check({ silent: true })
        } else {
          stopPeriodicCheck()
        }
        // If auto-download was just enabled and a patch update is already
        // waiting, start it now rather than waiting for the next check.
        // Minor/major updates always wait for the user's decision.
        const current = service!.getState()
        if (settings.autoDownload && current.status === 'available' && current.severity === 'patch') {
          queueMicrotask(() => { void service?.download() })
        }
      }
      return { ok: true, settings }
    } catch (error) {
      return {
        ok: false,
        settings: settings ?? readUpdaterSettings(settingsFile),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })

  app.on('will-quit', stopPeriodicCheck)

  if (options.enabled && settings.autoCheck) {
    setTimeout(() => { void service?.check({ silent: true }) }, options.checkDelayMs ?? 5000)
    startPeriodicCheck()
  }
}
