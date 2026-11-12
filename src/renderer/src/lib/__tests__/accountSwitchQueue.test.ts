import { describe, it, expect, vi } from 'vitest'
import { createAccountSwitchQueue, type QueuedSwitch } from '../accountSwitchQueue'

// Plan agent-0-2-42_3f728e: switches nobody clicked wait here for busy panes;
// one job per key, the newest request wins.
function job(key: string, over: Partial<QueuedSwitch> = {}): QueuedSwitch {
  return {
    key,
    waiting: () => 0,
    run: vi.fn(async () => ({ status: 'switched' })),
    settle: vi.fn(),
    ...over,
  }
}

describe('createAccountSwitchQueue', () => {
  const quiet = { setTimer: () => 0, clearTimer: () => undefined }

  it('runs a job only once nothing is waiting, then settles it', async () => {
    let waiting = 1
    const q = createAccountSwitchQueue(quiet)
    const j = job('agent:codex', { waiting: () => waiting })
    q.enqueue(j)
    await q.tick()
    expect(j.run).not.toHaveBeenCalled()
    waiting = 0
    await q.tick()
    expect(j.settle).toHaveBeenCalledWith({ status: 'switched' })
    expect(q.size).toBe(0)
  })

  it('settles the older job as superseded when a newer one takes its key', async () => {
    const q = createAccountSwitchQueue(quiet)
    const first = job('agent:codex', { waiting: () => 1 })
    const second = job('agent:codex', { waiting: () => 1 })
    q.enqueue(first)
    q.enqueue(second)
    expect(first.settle).toHaveBeenCalledWith({ status: 'superseded' })
    expect(q.size).toBe(1)
    q.supersede('agent:codex')
    expect(second.settle).toHaveBeenCalledWith({ status: 'superseded' })
    expect(q.size).toBe(0)
  })

  it('keeps independent keys apart', async () => {
    const q = createAccountSwitchQueue(quiet)
    q.enqueue(job('agent:codex', { waiting: () => 1 }))
    q.enqueue(job('pane:p1', { waiting: () => 1 }))
    expect(q.size).toBe(2)
  })

  it('keeps a job parked when its run answers queued again', async () => {
    const q = createAccountSwitchQueue(quiet)
    const j = job('pane:p1', { run: vi.fn(async () => ({ status: 'queued' })) })
    q.enqueue(j)
    await q.tick()
    expect(j.settle).not.toHaveBeenCalled()
    expect(q.has('pane:p1')).toBe(true)
  })

  it('settles a job whose run threw as refused', async () => {
    const q = createAccountSwitchQueue(quiet)
    const j = job('pane:p1', { run: vi.fn(async () => { throw new Error('boom') }) })
    q.enqueue(j)
    await q.tick()
    expect(j.settle).toHaveBeenCalledWith({ status: 'refused', code: 'unknown' })
  })

  it('polls on its timer while jobs wait', async () => {
    vi.useFakeTimers()
    try {
      let waiting = 1
      const q = createAccountSwitchQueue({ intervalMs: 100 })
      const j = job('agent:codex', { waiting: () => waiting })
      q.enqueue(j)
      await vi.advanceTimersByTimeAsync(250)
      expect(j.run).not.toHaveBeenCalled()
      waiting = 0
      await vi.advanceTimersByTimeAsync(150)
      expect(j.settle).toHaveBeenCalledTimes(1)
      q.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
