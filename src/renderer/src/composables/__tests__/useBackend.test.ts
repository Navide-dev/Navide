// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, type EffectScope } from 'vue'
import { useBackend } from '../useBackend'
import { platformId, setPlatformId, type PlatformId } from '../../../../shared/osplat'

// Minimal WebSocket stand-in: records instances, lets tests flip readyState
// and fire events. Installed on globalThis so useBackend's `new WebSocket()`
// and readyState constants resolve to it.
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []

  url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  closed = false
  private listeners = new Map<string, Set<(ev: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    set.add(cb)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    this.fire('close', {})
  }

  fire(type: string, ev: unknown): void {
    this.listeners.get(type)?.forEach((cb) => cb(ev))
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.fire('open', {})
  }
}

const READY_INFO = {
  status: 'ready' as const,
  wsUrl: 'ws://127.0.0.1:8765/ws',
  httpUrl: 'http://127.0.0.1:8765',
  shell: '/bin/zsh',
  port: 8765,
  pid: 4242
}

describe('useBackend applyBackendChanged', () => {
  let scope: EffectScope
  let backendChangedCb: ((info: unknown) => void) | undefined
  let systemResumedCb: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    backendChangedCb = undefined
    systemResumedCb = undefined
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('agentTeam', {
      getBackendInfo: vi.fn().mockResolvedValue(READY_INFO),
      onBackendChanged: (cb: (info: unknown) => void) => {
        backendChangedCb = cb
      },
      onSystemResumed: (cb: () => void) => {
        systemResumedCb = cb
        return () => { systemResumedCb = undefined }
      }
    })
  })

  afterEach(() => {
    scope?.stop()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function setupConnected() {
    let backend!: ReturnType<typeof useBackend>
    scope = effectScope()
    scope.run(() => {
      backend = useBackend()
    })
    // Let init()'s getBackendInfo poll resolve and connect().
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
    const socket = FakeWebSocket.instances[0]
    socket.open()
    return { backend, socket }
  }

  it('keeps the healthy socket and in-flight requests on a same-backend ready snapshot', async () => {
    const { backend, socket } = await setupConnected()

    // In-flight request (the CLI pane's terminal.create at launch).
    const inflight = backend.send('terminal.create', { pane_id: 'p1' })
    const settled = vi.fn()
    inflight.then(settled, settled)
    expect(socket.sent.length).toBeGreaterThan(0)

    // The queued startup broadcast flushed on window focus: same backend.
    backendChangedCb!(READY_INFO)
    await vi.advanceTimersByTimeAsync(0)

    expect(socket.closed).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(1) // no reconnect
    expect(settled).not.toHaveBeenCalled() // not rejected with 'backend changed'
    expect(backend.status.value).toBe('connected')

    // The snapshot's metadata still lands (init() doesn't set port/pid).
    expect(backend.port.value).toBe(8765)
    expect(backend.pid.value).toBe(4242)

    // Resolve the in-flight request normally to confirm it stayed alive.
    const req = JSON.parse(socket.sent[socket.sent.length - 1]) as { id: string }
    socket.fire('message', {
      data: JSON.stringify({ id: req.id, type: 'terminal.create', ok: true, payload: {}, error: null, timestamp: '' })
    })
    await expect(inflight).resolves.toMatchObject({ ok: true })
  })

  it('opens one socket when backend:changed lands before init()\'s poll resolves', async () => {
    scope = effectScope()
    scope.run(() => {
      useBackend()
    })
    // After an update restart main's ready broadcast reaches the window while
    // init() is still awaiting getBackendInfo: both paths call connect() for
    // the same wsUrl within milliseconds. Two sockets would double every
    // broadcast the window receives until the first one's TCP side dropped.
    backendChangedCb!(READY_INFO)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].closed).toBe(false)
  })

  it('still tears down and reconnects when the backend actually changed (new wsUrl)', async () => {
    const { backend, socket } = await setupConnected()

    // Catch immediately: the rejection fires synchronously inside the
    // backend:changed handler, before an `expect(...).rejects` could attach.
    const inflight = backend.send('terminal.create', { pane_id: 'p1' }).catch((err: Error) => err)

    backendChangedCb!({ ...READY_INFO, wsUrl: 'ws://127.0.0.1:9999/ws', port: 9999 })
    await vi.advanceTimersByTimeAsync(0)

    await expect(inflight).resolves.toMatchObject({ message: 'backend changed' })
    expect(socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1].url).toBe('ws://127.0.0.1:9999/ws')
  })

  it('reconnects when the snapshot matches but the socket is already dead', async () => {
    const { socket } = await setupConnected()

    socket.readyState = FakeWebSocket.CLOSED

    backendChangedCb!(READY_INFO)
    await vi.advanceTimersByTimeAsync(0)

    expect(FakeWebSocket.instances).toHaveLength(2) // tore down and reconnected
  })

  it('reaches the terminal error state when main reports a backend crash', async () => {
    const { backend, socket } = await setupConnected()

    // Main's crash watcher broadcasts an error snapshot when the backend
    // process dies after a successful start.
    backendChangedCb!({ status: 'error', error: 'backend exited unexpectedly (code 1)' })
    await vi.advanceTimersByTimeAsync(0)

    expect(backend.status.value).toBe('error')
    expect(backend.lastError.value).toBe('backend exited unexpectedly (code 1)')
    expect(socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(1) // no reconnect loop against the dead port

    // send() fail-fasts instead of queueing forever against a dead backend.
    await expect(backend.send('fs.write_file', {})).rejects.toThrow('ws not open')
  })

  it('rebuilds the socket when the machine wakes', async () => {
    const { backend, socket } = await setupConnected()

    // Sleep severs the TCP connection without touching readyState, so the
    // socket still looks alive — no close event, no status transition.
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)

    systemResumedCb!()
    await vi.advanceTimersByTimeAsync(0)

    expect(socket.closed).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(2) // reconnected without waiting for the watchdog
    FakeWebSocket.instances[1].open()
    expect(backend.status.value).toBe('connected')
  })

  it('stops listening for resumes once the scope is disposed', async () => {
    await setupConnected()
    scope.stop()
    expect(systemResumedCb).toBeUndefined()
  })

  // Drop the live socket, then fail `n - 1` reconnects to the same url: `n`
  // consecutive closes in all, each followed by its backoff.
  async function failReconnects(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const sock = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
      if (i > 0) sock.fire('error', {})
      sock.close()
      await vi.advanceTimersByTimeAsync(30_000)
    }
  }

  it('asks main again after repeated reconnect failures and follows a moved backend', async () => {
    // 2026-10-08: the backend stopped listening without exiting, so main never
    // broadcast a change; this window retried the dead port forever.
    const { backend } = await setupConnected()
    const moved = { ...READY_INFO, wsUrl: 'ws://127.0.0.1:9999/ws', httpUrl: 'http://127.0.0.1:9999', port: 9999, pid: 5151 }
    const getBackendInfo = (window as unknown as { agentTeam: { getBackendInfo: ReturnType<typeof vi.fn> } })
      .agentTeam.getBackendInfo
    getBackendInfo.mockResolvedValue(moved)

    await failReconnects(2)
    expect(getBackendInfo).toHaveBeenCalledTimes(1) // only init() so far
    expect(FakeWebSocket.instances.at(-1)!.url).toBe(READY_INFO.wsUrl)

    await failReconnects(1)
    expect(getBackendInfo).toHaveBeenCalledTimes(2)
    expect(FakeWebSocket.instances.at(-1)!.url).toBe(moved.wsUrl)
    FakeWebSocket.instances.at(-1)!.open()
    expect(backend.status.value).toBe('connected')
    expect(backend.port.value).toBe(9999)
    expect(backend.httpUrl.value).toBe(moved.httpUrl)
  })

  it('keeps retrying the same url when main still reports it', async () => {
    await setupConnected()
    await failReconnects(4)
    const urls = FakeWebSocket.instances.map((s) => s.url)
    expect(new Set(urls)).toEqual(new Set([READY_INFO.wsUrl]))
  })
})

describe('useBackend init() deadline', () => {
  let scope: EffectScope

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    scope?.stop()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function setup(agentTeam: Record<string, unknown>): ReturnType<typeof useBackend> {
    vi.stubGlobal('agentTeam', agentTeam)
    let backend!: ReturnType<typeof useBackend>
    scope = effectScope()
    scope.run(() => {
      backend = useBackend()
    })
    return backend
  }

  it('keeps polling past 50s when the configured health timeout is higher', async () => {
    const getBackendInfo = vi.fn().mockResolvedValue({ status: 'starting' })
    const backend = setup({
      getBackendInfo,
      readHealthCheckTimeout: vi.fn().mockResolvedValue({ ok: true, timeoutSec: 120 }),
      onBackendChanged: vi.fn()
    })

    // The old hardcoded deadline flipped to a false 'backend did not start'
    // error at 50s while main was still legitimately waiting on /health.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(backend.status.value).not.toBe('error')

    // Slow-but-successful start: init() is still polling and connects.
    getBackendInfo.mockResolvedValue(READY_INFO)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(backend.status.value).toBe('connecting')
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  it('gives up with an error once the configured deadline passes', async () => {
    const backend = setup({
      getBackendInfo: vi.fn().mockResolvedValue({ status: 'starting' }),
      readHealthCheckTimeout: vi.fn().mockResolvedValue({ ok: true, timeoutSec: 15 }),
      onBackendChanged: vi.fn()
    })

    // 15s configured + 5s margin → errors shortly after 20s.
    await vi.advanceTimersByTimeAsync(25_000)
    expect(backend.status.value).toBe('error')
    expect(backend.lastError.value).toBe('backend did not start')
  })

  it.each<[PlatformId, number]>([
    ['linux', 120_000],
    ['darwin', 45_000],
    ['win32', 120_000],
  ])('falls back to the %s default when the setting is unavailable', async (platform, defaultMs) => {
    const original = platformId()
    setPlatformId(platform)
    try {
      const backend = setup({
        getBackendInfo: vi.fn().mockResolvedValue({ status: 'starting' }),
        onBackendChanged: vi.fn()
      })

      // init() awaits the optional setting lookup before its deadline begins.
      await vi.advanceTimersByTimeAsync(0)

      await vi.advanceTimersByTimeAsync(defaultMs)
      expect(backend.status.value).not.toBe('error')

      await vi.advanceTimersByTimeAsync(10_000) // past the default + 5s margin
      expect(backend.status.value).toBe('error')
    } finally {
      setPlatformId(original)
    }
  })
})


describe('useBackend window challenge (R3-M2)', () => {
  let scope: EffectScope
  const proveWindow = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    proveWindow.mockReset()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('agentTeam', {
      getBackendInfo: vi.fn().mockResolvedValue(READY_INFO),
      proveWindow,
      onBackendChanged: () => {},
      onSystemResumed: () => () => {},
    })
  })

  afterEach(() => {
    scope?.stop()
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function welcome(socket: FakeWebSocket, nonce: string): void {
    socket.fire('message', {
      data: JSON.stringify({ id: 'w', type: 'ws.welcome', payload: { windowChallenge: nonce } }),
    })
  }

  function proves(socket: FakeWebSocket): unknown[] {
    return socket.sent.map((raw) => JSON.parse(raw)).filter((m) => m.type === 'window.prove').map((m) => m.payload)
  }

  async function connected(): Promise<FakeWebSocket> {
    scope = effectScope()
    scope.run(() => {
      useBackend()
    })
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeWebSocket.instances[0]
    socket.open()
    return socket
  }

  it('answers the welcome challenge with the proof main computes for it', async () => {
    proveWindow.mockResolvedValue('proof-for-n1')
    const socket = await connected()
    // Nothing in the URL any more: the proof is per connection.
    expect(socket.url).not.toContain('&w=')
    welcome(socket, 'n1')
    await vi.advanceTimersByTimeAsync(0)
    expect(proveWindow).toHaveBeenCalledWith('n1')
    expect(proves(socket)).toEqual([{ proof: 'proof-for-n1' }])
  })

  it('proves again with the fresh nonce after a reconnect', async () => {
    proveWindow.mockImplementation(async (nonce: string) => `proof-for-${nonce}`)
    const first = await connected()
    welcome(first, 'n1')
    await vi.advanceTimersByTimeAsync(0)
    first.close()
    await vi.advanceTimersByTimeAsync(30_000)
    const second = FakeWebSocket.instances.at(-1)!
    expect(second).not.toBe(first)
    second.open()
    welcome(second, 'n2')
    await vi.advanceTimersByTimeAsync(0)
    expect(proves(second)).toEqual([{ proof: 'proof-for-n2' }])
  })

  it('sends nothing when main refuses to prove this window', async () => {
    proveWindow.mockResolvedValue(null)
    const socket = await connected()
    welcome(socket, 'n1')
    await vi.advanceTimersByTimeAsync(0)
    expect(proves(socket)).toEqual([])
  })
})
