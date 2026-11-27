import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQuitDeadline, describeWindowUrl } from './quit-deadline'

// A quit the user confirmed must end even when Electron's own quit stalls
// (Windows 0.2.50 VM: the app stayed running with no window and the backend
// never told to stop). Time the user spends answering something does not count.
describe('createQuitDeadline', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function make(timeoutMs = 1000) {
    const expired: string[] = []
    const deadline = createQuitDeadline({ timeoutMs, onExpired: (stage) => { expired.push(stage) } })
    return { deadline, expired }
  }

  it('fires with the last stage reached when the quit never finishes', () => {
    const { deadline, expired } = make()
    deadline.arm('confirmed')
    deadline.stage('before-quit')
    vi.advanceTimersByTime(999)
    expect(expired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(expired).toEqual(['before-quit'])
  })

  it('does not fire once the quit finished', () => {
    const { deadline, expired } = make()
    deadline.arm('confirmed')
    deadline.disarm()
    vi.advanceTimersByTime(5000)
    expect(expired).toEqual([])
  })

  it('does not fire when it was never armed (the user cancelled the prompt)', () => {
    const { deadline, expired } = make()
    deadline.stage('before-quit')
    vi.advanceTimersByTime(5000)
    expect(expired).toEqual([])
  })

  it('does not fire for a quit that was cancelled after confirming', () => {
    const { deadline, expired } = make()
    deadline.arm('confirmed')
    vi.advanceTimersByTime(500)
    deadline.disarm()
    vi.advanceTimersByTime(5000)
    expect(expired).toEqual([])
  })

  it('stops counting while the user is being asked, and restarts the full budget after', () => {
    const { deadline, expired } = make()
    deadline.arm('confirmed')
    vi.advanceTimersByTime(900)
    const release = deadline.hold()
    vi.advanceTimersByTime(60_000)
    expect(expired).toEqual([])
    release()
    vi.advanceTimersByTime(999)
    expect(expired).toEqual([])
    vi.advanceTimersByTime(1)
    expect(expired).toEqual(['confirmed'])
  })

  it('keeps waiting until every hold is released; a release is idempotent', () => {
    const { deadline, expired } = make()
    deadline.arm('confirmed')
    const a = deadline.hold()
    const b = deadline.hold()
    a()
    a()
    vi.advanceTimersByTime(5000)
    expect(expired).toEqual([])
    b()
    vi.advanceTimersByTime(1000)
    expect(expired).toEqual(['confirmed'])
  })

  it('a hold taken before arming still defers the timer', () => {
    const { deadline, expired } = make()
    const release = deadline.hold()
    deadline.arm('confirmed')
    vi.advanceTimersByTime(5000)
    expect(expired).toEqual([])
    release()
    vi.advanceTimersByTime(1000)
    expect(expired).toEqual(['confirmed'])
  })

  it('fires at most once and re-arming does not restart a running timer', () => {
    const { deadline, expired } = make()
    deadline.arm('confirmed')
    vi.advanceTimersByTime(600)
    deadline.arm('again')
    vi.advanceTimersByTime(400)
    expect(expired).toEqual(['again'])
    vi.advanceTimersByTime(5000)
    expect(expired).toEqual(['again'])
  })
})

describe('describeWindowUrl', () => {
  it('keeps the path tail and query keys, never the values', () => {
    expect(describeWindowUrl('file:///C:/Users/x/app.asar/out/renderer/index.html?window=main&workspace_path=C%3A%5Csecret'))
      .toBe('index.html?window,workspace_path')
    expect(describeWindowUrl('http://127.0.0.1:5274/?token=abc')).toBe('/?token')
    expect(describeWindowUrl('file:///x/index.html')).toBe('index.html')
  })

  it('does not throw on an unparseable or empty URL', () => {
    expect(describeWindowUrl('')).toBe('(none)')
    expect(describeWindowUrl('not a url')).toBe('(unparsed)')
  })
})
