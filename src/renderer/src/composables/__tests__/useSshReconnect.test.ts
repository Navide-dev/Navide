// @vitest-environment happy-dom
// SSH Remote terminal pane: ssh's exit 255 (link lost) reconnects on its own
// with backoff and names each failure; a refused key or host key stops the
// retries; any other exit (the user typed `exit`) waits for Reconnect.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { SSH_RECONNECT_DELAYS_S, useSshReconnect, type SshReconnectState } from '../useSshReconnect'

function harness(reconnect: () => Promise<string | null>) {
  const down = ref(false)
  const exitCode = ref<number | null>(null)
  let state!: SshReconnectState
  const wrapper = mount(defineComponent({
    setup() {
      state = useSshReconnect({ down: () => down.value, exitCode: () => exitCode.value, reconnect })
      return () => h('div')
    },
  }))
  return { down, exitCode, state: () => state, wrapper }
}

async function drop(down: { value: boolean }, exitCode: { value: number | null }, code: number): Promise<void> {
  exitCode.value = code
  down.value = true
  await nextTick()
}

async function advance(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000)
}

describe('useSshReconnect', () => {
  let wrapper: VueWrapper | undefined
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
  })

  it('a lost link retries on the backoff schedule and names each failure', async () => {
    const reconnect = vi.fn(async () => 'unreachable')
    const t = harness(reconnect)
    wrapper = t.wrapper
    await drop(t.down, t.exitCode, 255)
    expect(t.state().nextAt.value).not.toBeNull()
    for (const [i, delay] of SSH_RECONNECT_DELAYS_S.entries()) {
      await advance(delay)
      expect(reconnect).toHaveBeenCalledTimes(i + 1)
      expect(t.state().reason.value).toBe('unreachable')
    }
    // Out of tries: nothing more is queued.
    expect(t.state().nextAt.value).toBeNull()
    await advance(600)
    expect(reconnect).toHaveBeenCalledTimes(SSH_RECONNECT_DELAYS_S.length)
  })

  it.each(['auth', 'host-key'])('a %s refusal stops the retries', async (reason) => {
    const reconnect = vi.fn(async () => reason)
    const t = harness(reconnect)
    wrapper = t.wrapper
    await drop(t.down, t.exitCode, 255)
    await advance(SSH_RECONNECT_DELAYS_S[0])
    expect(t.state().reason.value).toBe(reason)
    expect(t.state().nextAt.value).toBeNull()
    await advance(600)
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('a host that answers again ends the retries', async () => {
    const reconnect = vi.fn().mockResolvedValueOnce('unreachable').mockResolvedValueOnce(null)
    const t = harness(reconnect)
    wrapper = t.wrapper
    await drop(t.down, t.exitCode, 255)
    await advance(SSH_RECONNECT_DELAYS_S[0])
    await advance(SSH_RECONNECT_DELAYS_S[1])
    expect(reconnect).toHaveBeenCalledTimes(2)
    expect(t.state().reason.value).toBeNull()
    expect(t.state().nextAt.value).toBeNull()
  })

  it('a shell the user exited does not reconnect by itself', async () => {
    const reconnect = vi.fn(async () => null)
    const t = harness(reconnect)
    wrapper = t.wrapper
    await drop(t.down, t.exitCode, 0)
    await advance(600)
    expect(reconnect).not.toHaveBeenCalled()
    await t.state().reconnectNow()
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('Reconnect tries at once and does not restart the schedule', async () => {
    const reconnect = vi.fn(async () => 'unreachable')
    const t = harness(reconnect)
    wrapper = t.wrapper
    await drop(t.down, t.exitCode, 255)
    await t.state().reconnectNow()
    expect(reconnect).toHaveBeenCalledTimes(1)
    expect(t.state().nextAt.value).toBeNull()
    await advance(600)
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('a closed pane leaves no timer behind', async () => {
    const reconnect = vi.fn(async () => 'unreachable')
    const t = harness(reconnect)
    await drop(t.down, t.exitCode, 255)
    t.wrapper.unmount()
    await advance(600)
    expect(reconnect).not.toHaveBeenCalled()
  })
})
