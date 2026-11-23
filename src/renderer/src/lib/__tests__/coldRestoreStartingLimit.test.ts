import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COLD_RESTORE_SETTLE_TIMEOUT_MS,
  COLD_RESTORE_STARTING_LIMIT,
  runWithConcurrency,
  waitUntil,
} from '../resumeBehavior'

// 2026-11-12: two cold restores each brought 20+ claude panes back at once.
// The old ceiling only waited for the backend's spawn ack, so every CLI was
// still booting — and dialing /plan-mcp — at the same time; the backend answered
// in 20–57s and panes gave up on their MCP connection for good. A cold restore
// now holds each slot until the pane's prep settles.

afterEach(() => {
  vi.useRealTimers()
})

describe('cold restore starting limit', () => {
  it('starts at most four, and the fifth only after one is ready', async () => {
    expect(COLD_RESTORE_STARTING_LIMIT).toBe(4)
    const ready = new Map<string, () => void>()
    const started: string[] = []
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const run = runWithConcurrency(ids, COLD_RESTORE_STARTING_LIMIT, (id) => {
      started.push(id)
      return new Promise<void>((resolve) => ready.set(id, resolve))
    })
    await Promise.resolve()
    expect(started).toEqual(['a', 'b', 'c', 'd'])
    ready.get('b')!()
    await new Promise((r) => setTimeout(r, 0))
    expect(started).toEqual(['a', 'b', 'c', 'd', 'e'])
    for (const id of ids) ready.get(id)?.()
    await new Promise((r) => setTimeout(r, 0))
    for (const id of ids) ready.get(id)?.()
    await run
    expect(started).toEqual(ids)
  })
})

describe('waitUntil', () => {
  it('resolves true once the check passes', async () => {
    vi.useFakeTimers()
    let ok = false
    const done = waitUntil(() => ok, 10_000, 250)
    await vi.advanceTimersByTimeAsync(500)
    ok = true
    await vi.advanceTimersByTimeAsync(250)
    await expect(done).resolves.toBe(true)
  })

  it('resolves false at the timeout so one stuck pane cannot hold the batch', async () => {
    vi.useFakeTimers()
    const done = waitUntil(() => false, COLD_RESTORE_SETTLE_TIMEOUT_MS, 250)
    await vi.advanceTimersByTimeAsync(COLD_RESTORE_SETTLE_TIMEOUT_MS + 250)
    await expect(done).resolves.toBe(false)
  })

  it('does not wait when the check already passes', async () => {
    await expect(waitUntil(() => true, 1000)).resolves.toBe(true)
  })
})
