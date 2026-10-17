import { describe, expect, it } from 'vitest'
import { createQueueTrend, pluginBackendUsage, type BackendResourceUsageView } from '../backendQueueTrend'

/** The shape #367 adds as plugins:backendResourceUsage (fixture until it merges). */
function usage(requestBytes: number, notificationBytes: number): BackendResourceUsageView {
  const queue = (bytes: number) => ({ frames: bytes > 0 ? 1 : 0, bytes, peakFrames: 1, peakBytes: bytes })
  return {
    children: { current: 2, peak: 3, retained: 0 },
    views: [
      {
        pluginId: 'acme.demo', instanceId: 'v1', subscriptions: { current: 1, peak: 1 },
        child: {
          subscriptions: { current: 1, peak: 2 }, bridgeRequests: { current: 0, peak: 4 },
          outputQueue: { requests: queue(requestBytes), notifications: queue(notificationBytes) }, droppedNotifications: 0,
        },
      },
      { pluginId: 'acme.other', instanceId: 'v2', subscriptions: { current: 0, peak: 0 }, child: null },
    ],
    plugins: [{ pluginId: 'acme.demo', current: 1, peak: 2, droppedNotifications: 0 }],
  }
}

describe('pluginBackendUsage', () => {
  it("sums one plugin's views, requests and events separately", () => {
    expect(pluginBackendUsage(usage(100, 40), 'acme.demo')).toEqual({
      boundViews: 1,
      requests: { frames: 1, bytes: 100 },
      events: { frames: 1, bytes: 40 },
    })
    expect(pluginBackendUsage(usage(100, 40), 'acme.none')).toBeNull()
  })
})

describe('createQueueTrend (#367 L2: notice only)', () => {
  it('flags a queue that keeps growing over three samples', () => {
    const trend = createQueueTrend()
    expect(trend.add('acme.demo', 100)).toBe(false)
    expect(trend.add('acme.demo', 200)).toBe(false)
    expect(trend.add('acme.demo', 300)).toBe(true)
    expect(trend.add('acme.demo', 300)).toBe(false)
  })

  it('does not flag a queue that drains or stays empty', () => {
    const trend = createQueueTrend()
    for (const bytes of [100, 50, 120, 0, 0]) expect(trend.add('acme.demo', bytes)).toBe(false)
  })
})
