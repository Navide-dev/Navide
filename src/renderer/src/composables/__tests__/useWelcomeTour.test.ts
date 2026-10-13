// @vitest-environment happy-dom
// The first-run welcome tour: who gets it, where it resumes, and what ending
// it records.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) => (store.has(key) ? store.get(key) : fallback),
  settingsSet: (key: string, value: unknown) => {
    store.set(key, value)
  },
}))

async function load() {
  vi.resetModules()
  return import('../useWelcomeTour')
}

beforeEach(() => store.clear())

describe('useWelcomeTour', () => {
  it('stays off for an install that never ran the first-run wizard (an upgrade)', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    expect(welcome.pending()).toBe(false)
    expect(welcome.start()).toBe(false)
    expect(welcome.active.value).toBeNull()
  })

  it('starts once a first run marked it', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    expect(welcome.pending()).toBe(true)
    expect(welcome.start()).toBe(true)
    expect(welcome.active.value).toBe('first-run')
    // One at a time.
    expect(welcome.start()).toBe(false)
  })

  it('is off for good once it ends, finished or skipped', async () => {
    const { useWelcomeTour } = await load()
    for (const completed of [true, false]) {
      store.clear()
      const welcome = useWelcomeTour()
      welcome.markFirstRun()
      welcome.start()
      welcome.finish(completed)
      expect(welcome.active.value).toBeNull()
      expect(welcome.pending()).toBe(false)
      expect(welcome.start()).toBe(false)
    }
  })

  it('calls the whole tour off when this turns out not to be a first install', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    welcome.cancel()
    expect(welcome.pending()).toBe(false)
    expect(welcome.start()).toBe(false)
  })

  it('replays on request without recording anything, even over a pending tour', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    welcome.replay()
    expect(welcome.active.value).toBe('replay')
    welcome.finish(true)
    expect(store.size).toBe(0)

    welcome.markFirstRun()
    welcome.replay()
    welcome.finish(false)
    expect(welcome.pending()).toBe(true)
  })

  it('records a momentary action only while the tour is running', async () => {
    const { useWelcomeTour, welcomeActionTimes } = await load()
    const welcome = useWelcomeTour()
    welcome.notify('mention')
    expect(welcomeActionTimes.mentionAt).toBe(0)
    welcome.replay()
    welcome.notify('mention')
    welcome.notify('drop')
    welcome.notify('usage')
    expect(welcomeActionTimes.mentionAt).toBeGreaterThan(0)
    expect(welcomeActionTimes.dropAt).toBeGreaterThan(0)
    expect(welcomeActionTimes.usageAt).toBeGreaterThan(0)
  })

  it('keeps its "first install" answer, so a reload or another window does not ask again', async () => {
    const { useWelcomeTour } = await load()
    const welcome = useWelcomeTour()
    welcome.markFirstRun()
    expect(welcome.eligible()).toBe(false)
    welcome.markEligible()
    expect(welcome.eligible()).toBe(true)
    expect(useWelcomeTour().eligible()).toBe(true)
    // A new first run asks again.
    welcome.markFirstRun()
    expect(welcome.eligible()).toBe(false)
  })

  // M14: several main windows each ran a tour off the shared settings. One
  // window owns it; a window that closed mid-tour is taken over once its
  // heartbeat goes stale.
  describe('owner', () => {
    async function twoWindows() {
      vi.resetModules()
      const a = (await import('../useWelcomeTour')).useWelcomeTour()
      vi.resetModules()
      const b = (await import('../useWelcomeTour')).useWelcomeTour()
      return { a, b }
    }

    it('lets one window claim the tour and keeps the other out while it is alive', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000_000)
      const { a, b } = await twoWindows()
      a.markFirstRun()
      expect(a.claim()).toBe(true)
      expect(b.claim()).toBe(false)
      // The owner keeps its claim fresh.
      vi.setSystemTime(1_000_000 + 10_000)
      expect(a.claim()).toBe(true)
      vi.setSystemTime(1_000_000 + 20_000)
      expect(b.claim()).toBe(false)
      vi.useRealTimers()
    })

    it('hands a tour on once its window has gone quiet', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(2_000_000)
      const { a, b } = await twoWindows()
      a.markFirstRun()
      a.claim()
      vi.setSystemTime(2_000_000 + 60_000)
      expect(b.claim()).toBe(true)
      expect(a.claim()).toBe(false)
      vi.useRealTimers()
    })

    it('frees the claim when the tour ends or is called off', async () => {
      const { a, b } = await twoWindows()
      a.markFirstRun()
      a.claim()
      a.start()
      a.finish(true)
      a.markFirstRun()
      expect(b.claim()).toBe(true)
      b.cancel()
      expect(a.claim()).toBe(true)
    })

    it('takes down its own bubbles when the tour ended elsewhere, but not a replay', async () => {
      const { a } = await twoWindows()
      a.markFirstRun()
      a.start()
      a.release()
      expect(a.active.value).toBeNull()
      a.replay()
      a.release()
      expect(a.active.value).toBe('replay')
    })
  })
})
