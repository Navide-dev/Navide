/**
 * The account switches parked behind busy panes, as this window shows them
 * (Settings ▸ Accounts "When quota runs out", the quota popover). App.vue owns
 * the queue (lib/accountSwitchQueue) and publishes it here.
 */
import { shallowRef } from 'vue'
import type { QueuedSwitchView } from '../lib/accountSwitchQueue'

const queued = shallowRef<QueuedSwitchView[]>([])
let cancelJob: ((key: string) => void) | null = null

export function publishQueuedAccountSwitches(jobs: QueuedSwitchView[]): void {
  queued.value = jobs
}

export function setQueuedAccountSwitchCanceller(fn: ((key: string) => void) | null): void {
  cancelJob = fn
}

export function useQueuedAccountSwitches() {
  return {
    queued,
    forAgent: (agentKey: string) => queued.value.filter((j) => j.agentKey === agentKey),
    cancel: (key: string) => cancelJob?.(key),
  }
}
