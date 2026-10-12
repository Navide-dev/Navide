import { describe, expect, it, vi } from 'vitest'
import { computeUpdateSeverity, createUpdaterService, type UpdaterClient } from './updater-service'
import type { UpdateState } from '../shared/updater'

type Listener = (...args: never[]) => void

function fakeClient() {
  const listeners = new Map<string, Listener[]>()
  const client = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    checkForUpdates: vi.fn().mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } }),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
  }
  const emit = (event: string, value?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(value as never)
  }
  return { client: client as unknown as UpdaterClient, raw: client, emit }
}

describe('computeUpdateSeverity', () => {
  it('classifies patch, minor, and major version jumps', () => {
    expect(computeUpdateSeverity('1.2.3', '1.2.4')).toBe('patch')
    expect(computeUpdateSeverity('1.2.3', '1.3.0')).toBe('minor')
    expect(computeUpdateSeverity('1.2.3', '2.0.0')).toBe('major')
  })

  it('tolerates a leading v prefix', () => {
    expect(computeUpdateSeverity('v1.2.3', 'v1.2.9')).toBe('patch')
  })

  it('treats unparsable versions as major so the user is asked', () => {
    expect(computeUpdateSeverity('garbage', '1.2.4')).toBe('major')
    expect(computeUpdateSeverity('1.2.3', 'nightly')).toBe('major')
    expect(computeUpdateSeverity('', '')).toBe('major')
  })
})

describe('createUpdaterService', () => {
  it('reports dev builds as unsupported without contacting a provider', async () => {
    const { client, raw } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', false, vi.fn())

    expect(service.getState().status).toBe('unsupported')
    expect((await service.check()).ok).toBe(false)
    expect(raw.checkForUpdates).not.toHaveBeenCalled()
  })

  it('checks and falls back to a deterministic not-available state', async () => {
    const { client } = fakeClient()
    const states: UpdateState[] = []
    const service = createUpdaterService(client, '1.0.0', true, (state) => states.push(state))

    expect((await service.check()).ok).toBe(true)
    expect(service.getState().status).toBe('not-available')
    expect(states.map((state) => state.status)).toEqual(['checking', 'not-available'])
  })

  it('serializes checks and preserves the available version through download', async () => {
    const { client, raw, emit } = fakeClient()
    let resolveCheck!: (value: { isUpdateAvailable: boolean; updateInfo: { version: string } }) => void
    let resolveDownload!: (value: string[]) => void
    raw.checkForUpdates.mockReturnValue(new Promise((resolve) => { resolveCheck = resolve }))
    raw.downloadUpdate.mockReturnValue(new Promise((resolve) => { resolveDownload = resolve }))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const first = service.check()
    const second = service.check()
    expect(raw.checkForUpdates).toHaveBeenCalledTimes(1)
    emit('update-available', { version: '1.1.0' })
    resolveCheck({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } })
    await Promise.all([first, second])

    const download = service.download()
    expect(raw.downloadUpdate).toHaveBeenCalledOnce()
    emit('download-progress', { percent: 42.4 })
    expect(service.getState()).toMatchObject({
      status: 'downloading', availableVersion: '1.1.0', percent: 42, severity: 'minor',
    })
    emit('update-downloaded', { version: '1.1.0' })
    resolveDownload([])
    expect((await download).ok).toBe(true)
    expect(service.getState()).toMatchObject({ status: 'downloaded', severity: 'minor' })
  })

  it('only installs a downloaded update', () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    expect(service.install().ok).toBe(false)
    emit('update-downloaded', { version: '1.1.0' })
    expect(service.install().ok).toBe(true)
    expect(raw.quitAndInstall).toHaveBeenCalledWith(false, true)
    expect(service.getState().status).toBe('installing')
  })

  it('turns provider failures into a retryable error state', async () => {
    const { client, raw } = fakeClient()
    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const result = await service.check()
    expect(result).toMatchObject({ ok: false, error: 'feed unavailable' })
    expect(service.getState()).toMatchObject({ status: 'error', message: 'feed unavailable' })
  })

  it('returns failure when the provider emits an error but resolves the operation', async () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const check = service.check()
    emit('error', new Error('bad metadata'))
    await expect(check).resolves.toMatchObject({ ok: false, error: 'bad metadata' })
  })

  it('finishes downloading when a provider resolves without a downloaded event', async () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    emit('update-available', { version: '1.1.0' })

    await expect(service.download()).resolves.toMatchObject({ ok: true })
    expect(service.getState()).toMatchObject({
      status: 'downloaded', availableVersion: '1.1.0', percent: 100,
    })
  })

  it('captures and normalizes release notes from string and array shapes', () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    emit('update-available', { version: '1.1.0', releaseNotes: '  Fixes  ' })
    expect(service.getState().releaseNotes).toBe('  Fixes  ')

    emit('update-downloaded', {
      version: '1.1.0',
      releaseNotes: [{ version: '1.1.0', note: 'Line A' }, { version: '1.0.9', note: 'Line B' }],
    })
    expect(service.getState().releaseNotes).toBe('Line A\n\nLine B')
  })

  it('converts provider HTML release notes to readable text before publishing state', () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    const htmlNotes = [
      '<h2>What&#39;s Changed</h2>',
      '<ul>',
      '<li>feat(plugins): compose Mini-IDE surfaces by <a class="user-mention notranslate" data-hovercard-url="/users/example" href="https://github.com/example">@example</a> in <a class="issue-link" data-id="133" href="https://github.com/nt-nerdtechnic/Navide/pull/133">#133</a></li>',
      '<li>Run <code>pnpm  --filter</code>.</li>',
      '</ul>',
      '<pre><code>pnpm test:run\n  pnpm typecheck</code></pre>',
      '<p><strong>Full Changelog:</strong> <a href="https://github.com/nt-nerdtechnic/Navide/compare/v0.2.9...v0.2.10">v0.2.9...v0.2.10</a></p>',
    ].join('')

    emit('update-available', { version: '1.1.0', releaseNotes: htmlNotes })
    expect(service.getState().releaseNotes).toBe([
      "What's Changed",
      '',
      '• feat(plugins): compose Mini-IDE surfaces by @example in #133',
      '• Run pnpm  --filter.',
      '',
      'pnpm test:run\n  pnpm typecheck',
      '',
      'Full Changelog: v0.2.9...v0.2.10',
    ].join('\n'))

    emit('update-downloaded', {
      version: '1.1.0',
      releaseNotes: [
        { version: '1.1.0', note: '<h3>First version</h3><p>Fixed issue.</p>' },
        { version: '1.0.9', note: '<ul><li>Older fix</li></ul>' },
      ],
    })
    expect(service.getState().releaseNotes).toBe('First version\n\nFixed issue.\n\n• Older fix')
  })

  it('passes plain or Markdown notes that mention inline tags through unchanged', () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    const markdownNotes = '## Fixes\n- Paste of <br> tags no longer breaks\n\nUse Array<string>'

    emit('update-available', { version: '1.1.0', releaseNotes: markdownNotes })

    expect(service.getState().releaseNotes).toBe(markdownNotes)
  })

  it('still finishes the download when a code span in the notes holds a comment', () => {
    const { client, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    emit('update-downloaded', { version: '1.1.0', releaseNotes: '<p>Run <code>a<!-- c -->b</code></p>' })

    expect(service.getState().status).toBe('downloaded')
    expect(service.getState().releaseNotes).toBe('Run ab')
  })

  it('does not surface a provider error during a silent check', async () => {
    const { client, raw } = fakeClient()
    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const result = await service.check({ silent: true })
    expect(result.ok).toBe(false)
    // Silent: state settles to not-available, never 'error'.
    expect(service.getState().status).toBe('not-available')
  })

  it('ignores an emitted error event while a silent check is in flight', async () => {
    const { client, raw, emit } = fakeClient()
    let resolveCheck!: (value: { isUpdateAvailable: boolean }) => void
    raw.checkForUpdates.mockReturnValue(new Promise((resolve) => { resolveCheck = resolve }))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const check = service.check({ silent: true })
    emit('error', new Error('transient'))
    expect(service.getState().status).not.toBe('error')
    resolveCheck({ isUpdateAvailable: false })
    await check
    expect(service.getState().status).toBe('not-available')
  })

  it('still reports errors for a manual (non-silent) check', async () => {
    const { client, raw } = fakeClient()
    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    const result = await service.check({ silent: false })
    expect(result).toMatchObject({ ok: false, error: 'feed unavailable' })
    expect(service.getState()).toMatchObject({ status: 'error', message: 'feed unavailable' })
  })

  it('re-checks while downloaded and moves to a strictly newer version', async () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    emit('update-downloaded', { version: '1.0.1' })

    raw.checkForUpdates.mockImplementation(async () => {
      emit('update-available', { version: '1.0.2' })
      return { isUpdateAvailable: true, updateInfo: { version: '1.0.2' } }
    })
    expect((await service.check({ silent: true })).ok).toBe(true)
    expect(raw.checkForUpdates).toHaveBeenCalledOnce()
    expect(service.getState()).toMatchObject({ status: 'available', availableVersion: '1.0.2' })
  })

  it('keeps the downloaded state when a re-check finds the same version', async () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    emit('update-downloaded', { version: '1.0.1' })

    raw.checkForUpdates.mockImplementation(async () => {
      // The provider re-announces the version we already hold.
      emit('update-available', { version: '1.0.1' })
      return { isUpdateAvailable: true, updateInfo: { version: '1.0.1' } }
    })
    expect((await service.check({ silent: true })).ok).toBe(true)
    expect(service.getState()).toMatchObject({ status: 'downloaded', availableVersion: '1.0.1', percent: 100 })
  })

  it('does not let a failed background check pass as a successful one', async () => {
    const { client, raw } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())

    // A real check first, so there is a genuine "last succeeded" timestamp.
    expect((await service.check({ silent: true })).ok).toBe(true)
    const checkedAt = service.getState().checkedAt
    expect(checkedAt).toBeTruthy()

    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    expect((await service.check({ silent: true })).ok).toBe(false)

    const state = service.getState()
    expect(state.status).toBe('not-available')
    // The failure must not read as "checked just now, you are up to date".
    expect(state.checkedAt).toBe(checkedAt)
    expect(state.lastCheckFailure).toMatchObject({ count: 1, message: 'feed unavailable' })
  })

  it('counts consecutive background failures and clears the run on the next success', async () => {
    const { client, raw } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))

    await service.check({ silent: true })
    await service.check({ silent: true })
    await service.check({ silent: true })
    expect(service.getState().lastCheckFailure).toMatchObject({ count: 3 })

    raw.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } })
    await service.check({ silent: true })
    expect(service.getState().lastCheckFailure).toBeUndefined()
    expect(service.getState().checkedAt).toBeTruthy()
  })

  it('counts an error event and a rejected check as one failure, not two', async () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    raw.checkForUpdates.mockImplementation(async () => {
      emit('error', new Error('feed unavailable'))
      throw new Error('feed unavailable')
    })

    await service.check({ silent: true })
    expect(service.getState().lastCheckFailure).toMatchObject({ count: 1 })
  })

  it('counts a silent check that errors but still resolves as a failure', async () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    raw.checkForUpdates.mockImplementation(async () => {
      emit('error', new Error('bad metadata'))
      return { isUpdateAvailable: false }
    })

    await service.check({ silent: true })
    const state = service.getState()
    expect(state.status).toBe('not-available')
    expect(state.checkedAt).toBeUndefined()
    expect(state.lastCheckFailure).toMatchObject({ count: 1, message: 'bad metadata' })
  })

  it('carries a check history restored from a previous run', () => {
    const { client } = fakeClient()
    const restored = {
      checkedAt: '2026-01-01T00:00:00.000Z',
      lastCheckFailure: { message: 'feed unavailable', count: 2, at: '2026-01-02T00:00:00.000Z' },
    }
    const service = createUpdaterService(client, '1.0.0', true, vi.fn(), { restored })

    expect(service.getState()).toMatchObject({
      status: 'idle',
      checkedAt: restored.checkedAt,
      lastCheckFailure: restored.lastCheckFailure,
    })
  })

  it('retries a transient download failure and settles once it succeeds', async () => {
    vi.useFakeTimers()
    try {
      const { client, raw, emit } = fakeClient()
      const service = createUpdaterService(client, '1.0.0', true, vi.fn(), {
        downloadRetryDelaysMs: [10, 20],
      })
      emit('update-available', { version: '1.1.0' })
      raw.downloadUpdate.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce([])

      const download = service.download()
      await vi.advanceTimersByTimeAsync(10)
      await expect(download).resolves.toMatchObject({ ok: true })
      expect(raw.downloadUpdate).toHaveBeenCalledTimes(2)
      expect(service.getState().status).toBe('downloaded')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after the configured number of download retries', async () => {
    vi.useFakeTimers()
    try {
      const { client, raw, emit } = fakeClient()
      const service = createUpdaterService(client, '1.0.0', true, vi.fn(), {
        downloadRetryDelaysMs: [10, 20],
      })
      emit('update-available', { version: '1.1.0' })
      raw.downloadUpdate.mockRejectedValue(new Error('ECONNRESET'))

      const download = service.download()
      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(20)
      await expect(download).resolves.toMatchObject({ ok: false, error: 'ECONNRESET' })
      expect(raw.downloadUpdate).toHaveBeenCalledTimes(3)
      expect(service.getState()).toMatchObject({ status: 'error', message: 'ECONNRESET' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a download failure a retry cannot fix', async () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn(), {
      downloadRetryDelaysMs: [10, 20],
    })
    emit('update-available', { version: '1.1.0' })
    raw.downloadUpdate.mockRejectedValue(new Error('404 Not Found'))

    await expect(service.download()).resolves.toMatchObject({ ok: false })
    expect(raw.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('does not retry at all when the retry schedule is empty', async () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn(), {
      downloadRetryDelaysMs: [],
    })
    emit('update-available', { version: '1.1.0' })
    raw.downloadUpdate.mockRejectedValue(new Error('ECONNRESET'))

    await expect(service.download()).resolves.toMatchObject({ ok: false })
    expect(raw.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('hands a stuck install back as downloaded once the timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const { client, raw, emit } = fakeClient()
      const service = createUpdaterService(client, '1.0.0', true, vi.fn(), { installTimeoutMs: 50 })
      emit('update-downloaded', { version: '1.1.0' })

      expect(service.install().ok).toBe(true)
      expect(service.getState().status).toBe('installing')

      await vi.advanceTimersByTimeAsync(50)
      expect(service.getState()).toMatchObject({
        status: 'downloaded', availableVersion: '1.1.0', percent: 100,
      })
      // ...and the user can try again rather than being stuck forever.
      expect(service.install().ok).toBe(true)
      expect(raw.quitAndInstall).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a stuck install through the warn option', async () => {
    vi.useFakeTimers()
    try {
      const { client, emit } = fakeClient()
      const warn = vi.fn()
      const service = createUpdaterService(client, '1.0.0', true, vi.fn(), { installTimeoutMs: 50, warn })
      emit('update-downloaded', { version: '1.1.0' })
      service.install()

      await vi.advanceTimersByTimeAsync(50)
      expect(warn).toHaveBeenCalledWith('[updater] install did not start within 50 ms; returning to downloaded')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops blocking checks once a stuck install times out', async () => {
    vi.useFakeTimers()
    try {
      const { client, raw, emit } = fakeClient()
      const service = createUpdaterService(client, '1.0.0', true, vi.fn(), { installTimeoutMs: 50 })
      emit('update-downloaded', { version: '1.1.0' })
      service.install()

      await service.check()
      expect(raw.checkForUpdates).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(50)
      await service.check()
      expect(raw.checkForUpdates).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the install timeout at install time, not at construction', async () => {
    vi.useFakeTimers()
    try {
      const { client, emit } = fakeClient()
      let timeout = 1000
      const service = createUpdaterService(client, '1.0.0', true, vi.fn(), {
        installTimeoutMs: () => timeout,
      })
      emit('update-downloaded', { version: '1.1.0' })

      timeout = 50
      service.install()
      await vi.advanceTimersByTimeAsync(50)
      expect(service.getState().status).toBe('downloaded')
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores the downloaded state when a re-check fails', async () => {
    const { client, raw, emit } = fakeClient()
    const service = createUpdaterService(client, '1.0.0', true, vi.fn())
    emit('update-downloaded', { version: '1.0.1' })

    raw.checkForUpdates.mockRejectedValue(new Error('feed unavailable'))
    expect((await service.check({ silent: true })).ok).toBe(false)
    expect(service.getState()).toMatchObject({ status: 'downloaded', availableVersion: '1.0.1' })

    expect((await service.check({ silent: false })).ok).toBe(false)
    expect(service.getState()).toMatchObject({ status: 'downloaded', availableVersion: '1.0.1' })
  })
})

/**
 * electron-updater consumes autoInstallOnAppQuit when a download FINISHES, not
 * when the app quits (MacUpdater only hands the payload to Squirrel if the flag
 * is set at that moment). These tests pin that timing down: without them the
 * flag looks like a plain mirror of the user's setting, which is exactly the
 * misreading that made the feature silently do nothing.
 */
describe('createUpdaterService — quit-time install', () => {
  async function downloaded(supported = true) {
    const parts = fakeClient()
    const service = createUpdaterService(parts.client, '1.0.0', supported, vi.fn())
    await service.check()
    parts.emit('update-available', { version: '1.0.1' })
    return { ...parts, service }
  }

  it('keeps the flag off during the download itself', async () => {
    // A download that runs with the flag set never resolves its promise, so
    // download() would hang and downloadPromise would never clear.
    const { raw, service, emit } = await downloaded()
    service.setAutoInstallOnQuit(true)
    const inFlight = service.download()
    expect(raw.autoInstallOnAppQuit).toBe(false)
    emit('update-downloaded', { version: '1.0.1' })
    await inFlight
    // Only the arming pass turns it on, and only after the transfer is done.
    expect(raw.autoInstallOnAppQuit).toBe(true)
  })

  it('arms the install once the download finishes', async () => {
    const { raw, service, emit } = await downloaded()
    service.setAutoInstallOnQuit(true)
    await service.download()
    raw.downloadUpdate.mockClear()

    emit('update-downloaded', { version: '1.0.1' })

    expect(raw.autoInstallOnAppQuit).toBe(true)
    // Re-run with the flag on is what actually hands the payload over; the file
    // is already cached, so this is a checksum pass rather than a transfer.
    expect(raw.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(service.getState().quitInstallArmed).toBe(true)
  })

  it('arms an update that had already finished downloading', async () => {
    // The common case: the user sees "update ready" and only then turns the
    // switch on. Setting the flag alone would do nothing at all.
    const { raw, service, emit } = await downloaded()
    emit('update-downloaded', { version: '1.0.1' })
    expect(raw.autoInstallOnAppQuit).toBe(false)
    raw.downloadUpdate.mockClear()

    service.setAutoInstallOnQuit(true)

    expect(raw.autoInstallOnAppQuit).toBe(true)
    expect(raw.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(service.getState().quitInstallArmed).toBe(true)
  })

  it('does not arm before anything has been downloaded', async () => {
    const { raw, service } = await downloaded()
    service.setAutoInstallOnQuit(true)
    expect(raw.autoInstallOnAppQuit).toBe(false)
    expect(raw.downloadUpdate).not.toHaveBeenCalled()
    expect(service.getState().quitInstallArmed).toBeUndefined()
  })

  it('arms at most once', async () => {
    const { raw, service, emit } = await downloaded()
    service.setAutoInstallOnQuit(true)
    emit('update-downloaded', { version: '1.0.1' })
    raw.downloadUpdate.mockClear()

    service.setAutoInstallOnQuit(true)
    emit('update-downloaded', { version: '1.0.1' })

    expect(raw.downloadUpdate).not.toHaveBeenCalled()
  })

  it('keeps reporting an armed update after the switch goes back off', async () => {
    // The handoff is one-way: Squirrel cannot un-stage a payload it has taken.
    // Claiming otherwise would tell the user an update was cancelled when it
    // will still be applied on the next quit.
    const { raw, service, emit } = await downloaded()
    service.setAutoInstallOnQuit(true)
    emit('update-downloaded', { version: '1.0.1' })

    service.setAutoInstallOnQuit(false)

    expect(raw.autoInstallOnAppQuit).toBe(true)
    expect(service.getState().quitInstallArmed).toBe(true)
  })

  it('clears the flag when switched off before anything was armed', async () => {
    const { raw, service } = await downloaded()
    service.setAutoInstallOnQuit(true)
    service.setAutoInstallOnQuit(false)
    expect(raw.autoInstallOnAppQuit).toBe(false)
    expect(service.getState().quitInstallArmed).toBeUndefined()
  })

  it('never arms on an unsupported build', async () => {
    const { raw, service } = await downloaded(false)
    service.setAutoInstallOnQuit(true)
    expect(raw.autoInstallOnAppQuit).toBe(false)
    expect(service.getState().quitInstallArmed).toBeUndefined()
  })

  it('backs the arming out when the handoff fails', async () => {
    // Otherwise the UI would keep promising a quit-time install that the OS
    // updater never accepted.
    const { raw, service, emit } = await downloaded()
    emit('update-downloaded', { version: '1.0.1' })
    raw.downloadUpdate.mockRejectedValueOnce(new Error('squirrel refused'))

    service.setAutoInstallOnQuit(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(service.getState().quitInstallArmed).toBeUndefined()
    expect(raw.autoInstallOnAppQuit).toBe(false)
  })
})
