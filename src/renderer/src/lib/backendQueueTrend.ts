/**
 * Plan B D-f, review L2 on #367: a backend child that never reads makes the
 * Host's queue to it grow, and Navide's memory with it. The activity page and
 * the disclosure overview read `plugins:backendResourceUsage` (#367) and only
 * say so; nothing is stopped or capped.
 *
 * `BackendResourceUsageView` mirrors #367's `BackendResourceUsage`; until #367
 * merges the call is absent and nothing is shown.
 */

interface UsageCount {
  current: number
  peak: number
}

interface QueueUsage {
  frames: number
  bytes: number
  peakFrames: number
  peakBytes: number
}

export interface BackendResourceUsageView {
  /** `current` counts views bound to a child, not live processes. */
  children: UsageCount & { retained: number }
  views: Array<{
    pluginId: string
    instanceId: string
    subscriptions: UsageCount
    child: {
      subscriptions: UsageCount
      bridgeRequests: UsageCount
      outputQueue: { requests: QueueUsage; notifications: QueueUsage }
      droppedNotifications: number
    } | null
  }>
  plugins: Array<{ pluginId: string; current: number; peak: number; droppedNotifications: number }>
}

/** One plugin's bound views and Host→child backlog, requests and events apart. */
export interface PluginBackendUsage {
  boundViews: number
  requests: { frames: number; bytes: number }
  events: { frames: number; bytes: number }
}

export function pluginBackendUsage(usage: BackendResourceUsageView, pluginId: string): PluginBackendUsage | null {
  const views = usage.views.filter((view) => view.pluginId === pluginId)
  if (views.length === 0) return null
  const out: PluginBackendUsage = { boundViews: 0, requests: { frames: 0, bytes: 0 }, events: { frames: 0, bytes: 0 } }
  for (const view of views) {
    if (!view.child) continue
    out.boundViews += 1
    out.requests.frames += view.child.outputQueue.requests.frames
    out.requests.bytes += view.child.outputQueue.requests.bytes
    out.events.frames += view.child.outputQueue.notifications.frames
    out.events.bytes += view.child.outputQueue.notifications.bytes
  }
  return out
}

/** Samples a plugin's total queued bytes; `add` is true while the queue has
 *  grown on each of the last three samples ("keeps growing"). */
export function createQueueTrend(samples = 3) {
  const history = new Map<string, number[]>()
  return {
    add(pluginId: string, bytes: number): boolean {
      const kept = [...(history.get(pluginId) ?? []), bytes].slice(-samples)
      history.set(pluginId, kept)
      return kept.length === samples && kept.every((value, index) => index === 0 || value > kept[index - 1])
    },
  }
}
