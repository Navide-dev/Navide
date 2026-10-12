import { compile as compileHtmlToText, type DomNode } from 'html-to-text'
import type { UpdateActionResult, UpdateCheckFailure, UpdateSeverity, UpdateState } from '../shared/updater'

// How long quitAndInstall gets to actually take the process over. Squirrel.Mac
// normally hands off within a couple of seconds; if we are still running well
// past that, the install did not start and the user is staring at a dead
// "installing" state with no way back.
const DEFAULT_INSTALL_TIMEOUT_MS = 20_000

// Backoff for download retries. The length of the array is the retry count;
// callers that let the user pick a count build their own from this shape.
export const DEFAULT_DOWNLOAD_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000]

// Download failures that a retry cannot fix: the asset is missing or forbidden,
// or the payload failed integrity/signature verification. Everything else
// (timeouts, resets, DNS) is treated as transient and worth another attempt.
const PERMANENT_DOWNLOAD_ERROR = /\b(40[0134]|signature|checksum|sha512|integrity)\b/i

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

interface UpdateInfoLike {
  version: string
  releaseNotes?: string | Array<{ version?: string; note?: string | null }> | null
}

interface CheckResultLike {
  isUpdateAvailable?: boolean
  updateInfo?: UpdateInfoLike
}

export interface UpdaterClient {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'checking-for-update', listener: () => void): unknown
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: UpdateInfoLike) => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): Promise<CheckResultLike | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdaterService {
  getState(): UpdateState
  check(options?: { silent?: boolean }): Promise<UpdateActionResult>
  download(): Promise<UpdateActionResult>
  install(): UpdateActionResult
  /**
   * Let a downloaded update be applied when the app quits, instead of only on
   * an explicit restart. Downloading and installing are separate decisions:
   * this one owns the second half.
   */
  setAutoInstallOnQuit(enabled: boolean): void
}

/**
 * The slice of updater state that outlives a session. Deliberately excludes
 * availableVersion: a version carried over from a previous run may already be
 * installed, and claiming an update is waiting when it is not is worse than
 * showing nothing until the startup check answers.
 */
export interface RestoredUpdateState {
  checkedAt?: string
  lastCheckFailure?: UpdateCheckFailure
}

/**
 * Both tunables are user settings, so they may be passed as a getter to be read
 * at the moment they are used rather than captured when the service is built —
 * changing them in Settings must not require recreating the service.
 */
export interface UpdaterServiceOptions {
  installTimeoutMs?: number | (() => number)
  downloadRetryDelaysMs?: readonly number[] | (() => readonly number[])
  restored?: RestoredUpdateState
  /** Where the service reports what went wrong; console.warn when absent. */
  warn?: (line: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Only block-level markup marks a note as HTML. Plain or Markdown notes can
// mention inline tags (`<br>`, `Array<string>`) as text, and treating those as
// HTML would collapse their line breaks and drop the angle-bracketed words.
const RELEASE_NOTE_HTML_BLOCK_TAG = /<\/?(?:p|ul|ol|li|h[1-6]|pre|blockquote|table|div)(?:\s[^<>]*)?\s*\/?>/i

function htmlTextContent(node: DomNode): string {
  if (node.type === 'text') return node.data ?? ''
  // A comment node has no children; it contributes no text.
  return node.children?.map(htmlTextContent).join('') ?? ''
}

// Generic HTML layout belongs to html-to-text; these overrides define the
// release-notes presentation (heading case, link labels, bullets, and code).
const convertHtmlReleaseNote = compileHtmlToText({
  wordwrap: false,
  formatters: {
    codeWithWhitespace: (node, _walk, builder) => builder.addLiteral(htmlTextContent(node)),
  },
  selectors: [
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({ selector, options: { uppercase: false } })),
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'ul', options: { itemPrefix: '• ' } },
    { selector: 'code', format: 'codeWithWhitespace' },
    { selector: 'img', format: 'skip' },
  ],
})

function toReadableReleaseNote(note: string): string {
  return RELEASE_NOTE_HTML_BLOCK_TAG.test(note) ? convertHtmlReleaseNote(note).trim() : note
}

// electron-updater's UpdateInfo.releaseNotes may be a string, an array of
// { version, note } entries, or null. Normalize to readable text before it
// crosses IPC.
function normalizeReleaseNotes(notes: UpdateInfoLike['releaseNotes']): string | undefined {
  if (typeof notes === 'string') {
    const readable = toReadableReleaseNote(notes)
    return readable.trim() ? readable : undefined
  }
  if (Array.isArray(notes)) {
    const joined = notes
      .map((entry) => (typeof entry?.note === 'string' ? toReadableReleaseNote(entry.note) : ''))
      .filter((note) => note.trim().length > 0)
      .join('\n\n')
    return joined.length > 0 ? joined : undefined
  }
  return undefined
}

// Classify how far availableVersion is from currentVersion (semver X.Y.Z).
// Unparsable versions count as 'major' — the safest reading is to ask the user
// rather than silently auto-download an unknown jump.
export function computeUpdateSeverity(current: string, available: string): UpdateSeverity {
  const parse = (version: string): [number, number] | null => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
    return match ? [Number(match[1]), Number(match[2])] : null
  }
  const from = parse(current)
  const to = parse(available)
  if (!from || !to) return 'major'
  if (from[0] !== to[0]) return 'major'
  if (from[1] !== to[1]) return 'minor'
  return 'patch'
}

export function createUpdaterService(
  client: UpdaterClient,
  currentVersion: string,
  supported: boolean,
  onStateChanged: (state: UpdateState) => void,
  options: UpdaterServiceOptions = {},
): UpdaterService {
  const warn = options.warn ?? ((line: string) => console.warn(line))
  const resolveInstallTimeoutMs = (): number => {
    const value = options.installTimeoutMs
    if (typeof value === 'function') return value()
    return value ?? DEFAULT_INSTALL_TIMEOUT_MS
  }
  const resolveRetryDelays = (): readonly number[] => {
    const value = options.downloadRetryDelaysMs
    if (typeof value === 'function') return value()
    return value ?? DEFAULT_DOWNLOAD_RETRY_DELAYS_MS
  }

  // When a check last succeeded, carried across restarts. A failed check must
  // never advance it — that is what made a broken feed read as "up to date".
  let lastSuccessAt: string | undefined = options.restored?.checkedAt
  // The current run of failed checks, merged into every published state.
  let checkFailure: UpdateCheckFailure | null = options.restored?.lastCheckFailure ?? null

  let state: UpdateState = supported
    ? {
        status: 'idle',
        currentVersion,
        checkedAt: lastSuccessAt,
        // Built directly rather than through setState, so the restored failure
        // run has to be attached here too.
        ...(checkFailure ? { lastCheckFailure: checkFailure } : {}),
      }
    : {
        status: 'unsupported',
        currentVersion,
        message: 'Updates are not available for this build.',
      }
  let checkPromise: Promise<UpdateActionResult> | null = null
  let downloadPromise: Promise<UpdateActionResult> | null = null
  let installTimer: ReturnType<typeof setTimeout> | null = null
  // True while a silent (startup/periodic) check is in flight. When set,
  // provider errors are logged but never surfaced as an 'error' state.
  let silentActive = false
  // The error a silent check saw, if any. Kept so check() can count the cycle
  // as failed even when the provider promise still resolves.
  let silentErrorMessage: string | null = null

  const snapshot = (): UpdateState => ({ ...state })
  // checkFailure is merged here rather than at each call site: every setState
  // caller builds a fresh state object, so one place has to own the field.
  const setState = (next: UpdateState): void => {
    const merged: UpdateState = { ...next }
    if (checkFailure) merged.lastCheckFailure = checkFailure
    else delete merged.lastCheckFailure
    // Whether a quit will actually apply the update is a property of the
    // updater, not of any one transition — so it is merged here rather than
    // restated by every setState caller.
    if (quitInstallArmed) merged.quitInstallArmed = true
    else delete merged.quitInstallArmed
    state = merged
    onStateChanged(snapshot())
  }
  /** Stamp a successful check and end any failure run. */
  const markCheckSuccess = (): string => {
    const now = new Date().toISOString()
    lastSuccessAt = now
    checkFailure = null
    return now
  }
  const recordCheckFailure = (message: string): void => {
    checkFailure = {
      message,
      count: (checkFailure?.count ?? 0) + 1,
      at: new Date().toISOString(),
    }
    // Republish: the visible status often does not change on a failed silent
    // check, but the count the UI reads does.
    setState({ ...state })
  }
  /**
   * Hand an already-downloaded payload to Squirrel so quitting applies it.
   *
   * electron-updater consumes `autoInstallOnAppQuit` when a download FINISHES,
   * not when the app quits: MacUpdater only calls the native updater (which is
   * what actually fetches and stages the payload) if the flag is set at that
   * moment. Two consequences drive the shape of this function:
   *
   *  - Turning the setting on after a download completed does nothing on its
   *    own, so arming re-runs the download with the flag set. The payload is
   *    already in the cache, so that pass is a checksum check, not a transfer.
   *  - A download that runs with the flag set never resolves its promise (the
   *    handoff replaces the resolve), which is why the flag stays off for the
   *    normal download path and this call is deliberately fire-and-forget.
   */
  const armQuitInstall = (): void => {
    if (!supported || !wantQuitInstall || quitInstallArmed) return
    if (state.status !== 'downloaded') return
    quitInstallArmed = true
    client.autoInstallOnAppQuit = true
    setState({ ...state })
    void Promise.resolve(client.downloadUpdate()).catch((error) => {
      quitInstallArmed = false
      client.autoInstallOnAppQuit = false
      console.warn('[updater] could not arm the quit-time install:', errorMessage(error))
      setState({ ...state })
    })
  }

  const setAutoInstallOnQuit = (enabled: boolean): void => {
    wantQuitInstall = supported && enabled
    if (wantQuitInstall) {
      armQuitInstall()
      return
    }
    // Squirrel cannot un-stage a payload it has already fetched, so an armed
    // update still applies on the next quit. All switching off can do is stop
    // arming future ones — `quitInstallArmed` stays true so the UI can say so
    // instead of quietly promising something that will not hold.
    if (!quitInstallArmed) client.autoInstallOnAppQuit = false
  }

  const success = (): UpdateActionResult => ({ ok: true, state: snapshot() })
  const failure = (message: string): UpdateActionResult => ({ ok: false, state: snapshot(), error: message })

  // Both of electron-updater's automatic behaviours stay off here; each is
  // driven by its own user setting. autoDownload is decided per update by the
  // caller (patch only), autoInstallOnAppQuit by armQuitInstall() below.
  client.autoDownload = false
  client.autoInstallOnAppQuit = false

  /** The user wants downloaded updates applied on quit. */
  let wantQuitInstall = false
  /** The payload has actually been handed to Squirrel, so quitting applies it. */
  let quitInstallArmed = false

  if (supported) {
    client.on('checking-for-update', () => {
      setState({ status: 'checking', currentVersion, availableVersion: state.availableVersion })
    })
    client.on('update-available', (info) => {
      setState({
        status: 'available',
        currentVersion,
        availableVersion: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        severity: computeUpdateSeverity(currentVersion, info.version),
        checkedAt: markCheckSuccess(),
      })
    })
    client.on('update-not-available', () => {
      setState({ status: 'not-available', currentVersion, checkedAt: markCheckSuccess() })
    })
    client.on('download-progress', (progress) => {
      setState({
        status: 'downloading',
        currentVersion,
        availableVersion: state.availableVersion,
        releaseNotes: state.releaseNotes,
        severity: state.severity,
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
      })
    })
    client.on('update-downloaded', (info) => {
      setState({
        status: 'downloaded',
        currentVersion,
        availableVersion: info.version,
        releaseNotes: normalizeReleaseNotes(info.releaseNotes) ?? state.releaseNotes,
        severity: computeUpdateSeverity(currentVersion, info.version),
        percent: 100,
      })
      // A download that just finished is the moment the payload can be handed
      // to Squirrel — see armQuitInstall for why it cannot happen any earlier.
      armQuitInstall()
    })
    client.on('error', (error) => {
      const message = errorMessage(error)
      // Silent checks (startup/periodic) must not disrupt the visible state on
      // a transient network/feed error; log and leave the state as-is.
      if (silentActive) {
        console.warn('[updater] silent check error:', message)
        silentErrorMessage = message
        return
      }
      setState({
        status: 'error',
        currentVersion,
        availableVersion: state.availableVersion,
        message,
      })
    })
  }

  async function check({ silent = false }: { silent?: boolean } = {}): Promise<UpdateActionResult> {
    if (!supported) return failure(state.message ?? 'Updates are not supported in this build.')
    if (checkPromise) return checkPromise
    if (downloadPromise || state.status === 'installing') return success()
    // Re-checking while an update is already downloaded is allowed — a newer
    // release may have shipped since. Snapshot the ready-to-install state so
    // anything short of a strictly newer version restores it (the provider
    // re-emits 'update-available' even for the version we already hold).
    const downloadedBefore = state.status === 'downloaded' ? snapshot() : null
    const restoreDownloaded = (): void => {
      if (!downloadedBefore) return
      // Leave the state alone when the check surfaced a strictly newer version
      // or a download cycle is already running/complete.
      if (state.status === 'downloading' || state.status === 'downloaded') return
      if (state.status === 'available' && state.availableVersion !== downloadedBefore.availableVersion) return
      setState({ ...downloadedBefore })
    }

    checkPromise = (async () => {
      silentActive = silent
      silentErrorMessage = null
      let counted = false
      const noteSilentFailure = (message: string): void => {
        if (counted) return
        counted = true
        recordCheckFailure(message)
      }
      setState({ status: 'checking', currentVersion, availableVersion: state.availableVersion })
      try {
        const result = await client.checkForUpdates()
        // electron-updater normally emits an event before resolving. Keep a
        // deterministic fallback for providers/mocks that only return a result.
        if (state.status === 'checking') {
          const version = result?.updateInfo?.version
          if (silentErrorMessage) {
            // The provider reported an error yet still resolved. Settle out of
            // 'checking' without claiming the app is up to date.
            noteSilentFailure(silentErrorMessage)
            setState({ status: 'not-available', currentVersion, checkedAt: lastSuccessAt })
          } else if (result?.isUpdateAvailable && version) {
            setState({
              status: 'available',
              currentVersion,
              availableVersion: version,
              releaseNotes: normalizeReleaseNotes(result?.updateInfo?.releaseNotes),
              severity: computeUpdateSeverity(currentVersion, version),
              checkedAt: markCheckSuccess(),
            })
          } else {
            setState({ status: 'not-available', currentVersion, checkedAt: markCheckSuccess() })
          }
        }
        restoreDownloaded()
        if (state.status === 'error') return failure(state.message ?? 'Update check failed.')
        return success()
      } catch (error) {
        const message = errorMessage(error)
        // A silent check must never surface an error state; log only and settle
        // into not-available if we are still mid-check.
        if (silent) {
          console.warn('[updater] silent check failed:', message)
          noteSilentFailure(message)
          // checkedAt stays at the last *successful* check. Stamping it here is
          // what made a permanently broken feed read as "checked just now, you
          // are up to date".
          if (state.status === 'checking') {
            setState({ status: 'not-available', currentVersion, checkedAt: lastSuccessAt })
          }
          restoreDownloaded()
          return failure(message)
        }
        if (state.status !== 'error' || state.message !== message) {
          setState({ status: 'error', currentVersion, message })
        }
        restoreDownloaded()
        return failure(message)
      } finally {
        if (silent && silentErrorMessage) noteSilentFailure(silentErrorMessage)
        silentActive = false
        silentErrorMessage = null
        checkPromise = null
      }
    })()
    return checkPromise
  }

  async function download(): Promise<UpdateActionResult> {
    if (!supported) return failure(state.message ?? 'Updates are not supported in this build.')
    if (downloadPromise) return downloadPromise
    if (state.status === 'downloaded') return success()
    if (state.status !== 'available' && state.status !== 'error') {
      return failure('No update is ready to download.')
    }
    const availableVersion = state.availableVersion
    if (!availableVersion) return failure('No update is ready to download.')

    const releaseNotes = state.releaseNotes
    const severity = state.severity
    const retryDelays = resolveRetryDelays()
    downloadPromise = (async () => {
      try {
        // Transient transfer failures used to leave the user stranded at
        // 'error' with no automatic second attempt. Retry on a bounded backoff,
        // but never for a failure a retry cannot fix.
        for (let attempt = 0; ; attempt += 1) {
          setState({ status: 'downloading', currentVersion, availableVersion, releaseNotes, severity, percent: 0 })
          try {
            await client.downloadUpdate()
            if (state.status === 'error') return failure(state.message ?? 'Update download failed.')
            if (state.status === 'downloading') {
              setState({ status: 'downloaded', currentVersion, availableVersion, releaseNotes, severity, percent: 100 })
            }
            return success()
          } catch (error) {
            const message = errorMessage(error)
            const delay = retryDelays[attempt]
            if (delay === undefined || PERMANENT_DOWNLOAD_ERROR.test(message)) {
              if (state.status !== 'error' || state.message !== message) {
                setState({ status: 'error', currentVersion, availableVersion, message })
              }
              return failure(message)
            }
            console.warn(`[updater] download attempt ${attempt + 1} failed, retrying in ${delay}ms:`, message)
            await sleep(delay)
          }
        }
      } finally {
        downloadPromise = null
      }
    })()
    return downloadPromise
  }

  function install(): UpdateActionResult {
    if (state.status !== 'downloaded') return failure('No downloaded update is ready to install.')
    // Snapshot the ready-to-install state so the timeout below can hand it back
    // intact if the handoff never happens.
    const readyState = snapshot()
    if (installTimer) {
      clearTimeout(installTimer)
      installTimer = null
    }
    setState({
      status: 'installing',
      currentVersion,
      availableVersion: state.availableVersion,
      percent: 100,
    })
    const installTimeoutMs = resolveInstallTimeoutMs()
    try {
      client.quitAndInstall(false, true)
      // quitAndInstall can return without throwing and without the installer
      // ever taking over. Nothing else clears 'installing', and that status
      // blocks check() and the updater-cache cleanup indefinitely.
      installTimer = setTimeout(() => {
        installTimer = null
        if (state.status !== 'installing') return
        warn(`[updater] install did not start within ${installTimeoutMs} ms; returning to downloaded`)
        setState({ ...readyState, message: 'The update did not start installing. Try restarting again.' })
      }, installTimeoutMs)
      return success()
    } catch (error) {
      const message = errorMessage(error)
      if (installTimer) {
        clearTimeout(installTimer)
        installTimer = null
      }
      setState({
        status: 'error',
        currentVersion,
        availableVersion: state.availableVersion,
        message,
      })
      return failure(message)
    }
  }

  return { getState: snapshot, check, download, install, setAutoInstallOnQuit }
}
