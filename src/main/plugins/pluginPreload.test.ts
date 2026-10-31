// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import capabilitiesV1 from '../../../packages/plugin-contracts/src/schemas/capabilities-v1.json'
import { PLUGIN_API_VERSION } from '../../../packages/plugin-contracts/src/apiVersion'
import { USER_GESTURE_CAPABILITY_ADDRESSES } from '../../../packages/plugin-contracts/src/userGesture'
import { PUBLIC_CAPABILITY_CATALOG } from './pluginCapabilityCatalog'

const NAV_SURFACE = [
  'abortReceiverItem',
  'acceptExistingReceiverOffer',
  'apiVersion',
  'callCapability',
  'callHostAction',
  'castCapability',
  'disposeReceiver',
  'hideSelf',
  'listReceiverLeftContributions',
  'mountReceiver',
  'on',
  'onOpenTarget',
  'onReceiverCloseGuard',
  'onReceiverEditorTarget',
  'onReceiverItemClosed',
  'onReceiverOffer',
  'openReceiverLeft',
  'ready',
  'registerReceiver',
  'requestCloseReceiver',
  'requestCloseReceiverTransaction',
]

const state = vi.hoisted(() => ({
  exposed: null as Record<string, unknown> | null,
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  invoke: vi.fn(),
  send: vi.fn(),
  getFrameForSelector: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((_name: string, value: Record<string, unknown>) => {
      state.exposed = value
    }),
  },
  ipcRenderer: {
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const listeners = state.listeners.get(channel) ?? new Set()
      listeners.add(listener)
      state.listeners.set(channel, listeners)
    }),
    removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      state.listeners.get(channel)?.delete(listener)
    }),
    invoke: state.invoke,
    send: state.send,
  },
  webFrame: {
    getFrameForSelector: state.getFrameForSelector,
  },
}))

function emit(channel: string, event: unknown, payload: unknown): void {
  state.listeners.get(channel)?.forEach((listener) => listener(event, payload))
}

function resetHarness(): void {
  state.exposed = null
  state.listeners.clear()
  state.invoke.mockReset()
  state.invoke.mockResolvedValue({ ok: false })
  state.send.mockReset()
  state.getFrameForSelector.mockReset()
}

async function loadPreload(isMainFrame: boolean): Promise<Record<string, unknown>> {
  resetHarness()
  vi.resetModules()
  Object.defineProperty(process, 'isMainFrame', {
    configurable: true,
    value: isMainFrame,
  })
  await import('../../preload/plugin-preload')
  if (!state.exposed) throw new Error('preload did not expose nav')
  return state.exposed
}

type Port = {
  close: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  onmessage: ((event: { data: unknown }) => void) | null
  onmessageerror: (() => void) | null
}

function port(): Port {
  return {
    close: vi.fn(),
    postMessage: vi.fn(),
    start: vi.fn(),
    onmessage: null,
    onmessageerror: null,
  }
}

describe('plugin preload frame admission', () => {
  it('does not bootstrap from a DOM message and requests trusted document-ready admission', async () => {
    const addEventListener = vi.fn()
    const original = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener')
    Object.defineProperty(globalThis, 'addEventListener', {
      configurable: true,
      value: addEventListener,
    })
    try {
      state.invoke.mockResolvedValue({ ok: false })
      await loadPreload(false)

      // The preload's only DOM subscription is the Host-observed gesture
      // listener pair; it never bootstraps from a DOM `message`.
      expect([...new Set(addEventListener.mock.calls.map(([type]) => type))].sort())
        .toEqual(['keydown', 'pointerdown'])
      expect(state.invoke).toHaveBeenCalledWith(
        'plugin:frame:document-ready',
        expect.objectContaining({ nonce: expect.any(String) }),
      )
    } finally {
      if (original) Object.defineProperty(globalThis, 'addEventListener', original)
      else Reflect.deleteProperty(globalThis, 'addEventListener')
    }
  })

  it('admits one Host IPC port for the exact nonce and rejects mismatched or replacement ports', async () => {
    await loadPreload(false)
    const documentReady = state.invoke.mock.calls.find(([channel]) => channel === 'plugin:frame:document-ready')
    const nonce = documentReady?.[1]?.nonce
    expect(nonce).toEqual(expect.any(String))
    const handler = [...(state.listeners.get('plugin:frame:port') ?? [])][0]
    expect(handler).toBeDefined()

    const wrong = port()
    handler?.({ ports: [wrong] }, { nonce: 'wrong', documentGeneration: 1 })
    expect(wrong.start).not.toHaveBeenCalled()

    const admitted = port()
    handler?.({ ports: [admitted] }, { nonce, documentGeneration: 1 })
    expect(admitted.start).toHaveBeenCalledTimes(1)

    const replacement = port()
    handler?.({ ports: [replacement] }, { nonce, documentGeneration: 2 })
    expect(replacement.start).not.toHaveBeenCalled()
    expect(admitted.close).not.toHaveBeenCalled()
  })
})

describe('plugin preload Host channels', () => {
  it('marks a capability call only with a trusted gesture inside the activation window', async () => {
    // `globalThis` is the window in a renderer, which is where the preload
    // subscribes; spy on it so the test drives the Host's own listener.
    const addEventListener = vi.spyOn(
      globalThis as unknown as {
        addEventListener: (type: string, listener: unknown, capture?: boolean) => void
      },
      'addEventListener',
    )
    const nav = await loadPreload(true)
    const call = (): Promise<unknown> =>
      (nav.callCapability as (ns: string, method: string, args?: unknown) => Promise<unknown>)(
        'ui',
        'openExternal',
        { url: 'https://example.com' },
      )
    const payload = (): Record<string, unknown> =>
      state.invoke.mock.calls.at(-1)?.[1] as Record<string, unknown>
    // Drive the Host's own listener: it only reads `isTrusted`, and page script
    // cannot produce a trusted event, which is the whole point of the signal.
    const gesture = (event: { isTrusted: boolean }): void => {
      const listener = addEventListener.mock.calls.filter(([type]) => type === 'pointerdown').at(-1)?.[1]
      if (typeof listener !== 'function') throw new Error('gesture listener not registered')
      ;(listener as unknown as (value: { isTrusted: boolean }) => void)(event)
    }
    const now = vi.spyOn(performance, 'now')
    try {
      state.invoke.mockResolvedValue({ ok: true })
      // Nothing has happened in this view: an agent-driven call must not look
      // like a user gesture.
      await call()
      expect(payload()).toMatchObject({ ns: 'ui', method: 'openExternal', userGesture: false })

      // A synthetic event cannot claim a gesture.
      gesture({ isTrusted: false })
      await call()
      expect(payload()).toMatchObject({ userGesture: false })

      now.mockReturnValue(1_000)
      gesture({ isTrusted: true })
      const first = call()
      const second = call()
      await Promise.all([first, second])
      expect(state.invoke.mock.calls.slice(-2).map(([, request]) => request.userGesture))
        .toEqual([true, false])

      // Unrelated capability calls do not consume the gesture; a new trusted
      // event grants exactly one new link-open request until its deadline.
      now.mockReturnValue(2_000)
      gesture({ isTrusted: true })
      await (nav.callCapability as (ns: string, method: string) => Promise<unknown>)('ui', 'notify')
      now.mockReturnValue(2_000 + 5_000)
      await call()
      expect(payload()).toMatchObject({ userGesture: true })
      now.mockReturnValue(3_000)
      gesture({ isTrusted: true })
      now.mockReturnValue(3_000 + 5_001)
      await call()
      expect(payload()).toMatchObject({ userGesture: false })
    } finally {
      now.mockRestore()
      addEventListener.mockRestore()
    }
  })
  it('keeps the bridge a plugin page can reach', async () => {
    const nav = await loadPreload(true)
    expect(Object.keys(nav).sort()).toEqual(NAV_SURFACE)
    expect(nav.apiVersion).toBe(PLUGIN_API_VERSION)
  })
  it('gates exactly the capability addresses the catalog declares as gesture-required', () => {
    const declared = (capabilitiesV1.methods as Array<{ address: string; requiresUserGesture?: boolean }>)
      .filter((entry) => entry.requiresUserGesture === true)
      .map((entry) => entry.address)
    const hostEnforced = Object.values(PUBLIC_CAPABILITY_CATALOG)
      .filter((entry) => entry.requiresUserGesture === true)
      .map((entry) => entry.address)
    expect([...USER_GESTURE_CAPABILITY_ADDRESSES].sort()).toEqual([...declared].sort())
    expect([...USER_GESTURE_CAPABILITY_ADDRESSES].sort()).toEqual([...hostEnforced].sort())
    expect(USER_GESTURE_CAPABILITY_ADDRESSES).toContain('ui.openExternal')
  })
  it('forwards an all-or-none receiver close transaction and preserves its result union', async () => {
    const nav = await loadPreload(true)
    state.invoke.mockResolvedValue({ closed: false, reason: 'busy' })
    await expect((nav.requestCloseReceiverTransaction as (receiverId: string, itemIds: readonly string[]) => Promise<unknown>)('receiver-1', ['item-a', 'item-b']))
      .resolves.toEqual({ closed: false, reason: 'busy' })
    expect(state.invoke).toHaveBeenCalledWith('plugin:receiver:request-close-transaction', {
      receiverId: 'receiver-1', itemIds: ['item-a', 'item-b'],
    })

    state.invoke.mockResolvedValue({ closed: true })
    await expect((nav.requestCloseReceiverTransaction as (receiverId: string, itemIds: readonly string[]) => Promise<unknown>)('receiver-1', ['item-a', 'item-b']))
      .resolves.toEqual({ closed: true })
  })

  it('forwards close-cancelled through the existing frame event transport without adding correlation', async () => {
    const nav = await loadPreload(false)
    const documentReady = state.invoke.mock.calls.find(([channel]) => channel === 'plugin:frame:document-ready')
    const frameHandler = [...(state.listeners.get('plugin:frame:port') ?? [])][0]
    const admitted = port()
    frameHandler?.({ ports: [admitted] }, { nonce: documentReady?.[1]?.nonce, documentGeneration: 4 })
    const listener = vi.fn()
    ;(nav.on as (type: string, listener: (payload: unknown) => void) => () => void)('plugin:view:close-cancelled', listener)
    admitted.onmessage?.({ data: {
      channel: 'plugin:cap:event', documentGeneration: 4,
      payload: { type: 'plugin:view:close-cancelled', data: { closeId: 'close-1' } },
    } })
    expect(listener).toHaveBeenCalledWith({ closeId: 'close-1' })
  })

  it('removes the exact closed host before notifying listeners and compensates a late mount failure', async () => {
    const slots = [0, 1].map((index) => {
      let child: { isConnected: boolean } | null = null
      const slot = {
        isConnected: true,
        mountHostId: `host-left-${index + 1}`,
        location: 'left' as const,
        remove: vi.fn(),
        getAttribute: vi.fn((name: string) => {
          if (name === 'data-plugin-receiver-mount-host') return slot.mountHostId
          if (name === 'data-plugin-receiver-location') return slot.location
          return null
        }),
        append: vi.fn((frame: { isConnected: boolean }) => {
          child = frame
          frame.isConnected = true
        }),
        replaceChildren: vi.fn((frame: { isConnected: boolean }) => {
          child = frame
          frame.isConnected = true
        }),
        hasChild: (): boolean => child !== null,
      }
      slot.remove.mockImplementation(() => {
        if (child) child.isConnected = false
        slot.isConnected = false
      })
      return slot
    })
    const frames = new Map<string, { isConnected: boolean; setAttribute: (name: string, value: string) => void; src: string; token: string }>()
    const document = {
      createElement: vi.fn(() => {
        const frame = {
          isConnected: false,
          token: '',
          src: '',
          setAttribute(name: string, value: string): void {
            if (name === 'data-plugin-receiver-frame') {
              this.token = value
              frames.set(value, this)
            }
          },
        }
        return frame
      }),
      querySelectorAll: vi.fn(() => slots),
      querySelector: vi.fn((selector: string) => {
        const slot = slots.find((candidate) => !candidate.hasChild() && candidate.isConnected)
        if (selector.startsWith('[data-plugin-receiver-slot=')) return slot ?? null
        const token = selector.match(/data-plugin-receiver-frame="([^"]+)"/)?.[1]
        return token ? frames.get(token) ?? null : null
      }),
    }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
    let releaseLate!: (value: { locator: string }) => void
    const lateReady = new Promise<{ locator: string }>((resolve) => { releaseLate = resolve })
    const mountItems = ['item-sibling', 'item-late']
    try {
      const nav = await loadPreload(true)
      state.invoke.mockImplementation(async (channel: string, payload: { itemId?: string }) => {
        if (channel === 'plugin:receiver:register') return { receiverId: 'receiver-1' }
        if (channel === 'plugin:receiver:mount') return { itemId: mountItems.shift() }
        if (channel === 'plugin:receiver:blank-ready') {
          return payload.itemId === 'item-late' ? lateReady : { locator: 'plugin-frame://sibling' }
        }
        return undefined
      })
      ;(nav.onReceiverOffer as (receiverId: string, listener: (offer: unknown) => void) => () => void)('receiver-1', vi.fn())
      emit('plugin:receiver:offer', {}, {
        receiverId: 'receiver-1',
        offer: { offerId: 'offer-sibling', contributionKey: 'provider.left', title: 'Sibling', location: 'left' },
      })
      emit('plugin:receiver:offer', {}, {
        receiverId: 'receiver-1',
        offer: { offerId: 'offer-late', contributionKey: 'provider.left', title: 'Late', location: 'left' },
      })
      state.getFrameForSelector.mockImplementation((selector: string) => ({
        frameToken: selector.match(/data-plugin-receiver-frame="([^"]+)"/)?.[1],
      }))
      const closedListener = vi.fn((item: { itemId: string; documentGeneration: number }) => {
        if (item.itemId === 'item-late') {
          expect(slots[1]!.isConnected).toBe(false)
          expect(slots[0]!.isConnected).toBe(true)
        }
      })
      ;(nav.onReceiverItemClosed as (receiverId: string, listener: typeof closedListener) => () => void)('receiver-1', closedListener)
      await (nav.mountReceiver as (receiverId: string, offerId: string, placement: { mountHostId: string }) => Promise<{ itemId: string }>)('receiver-1', 'offer-sibling', { mountHostId: 'host-left-1' })
      const lateMount = (nav.mountReceiver as (receiverId: string, offerId: string, placement: { mountHostId: string }) => Promise<{ itemId: string }>)('receiver-1', 'offer-late', { mountHostId: 'host-left-2' })
      await vi.waitFor(() => expect(state.invoke.mock.calls.some(([channel, payload]) => channel === 'plugin:receiver:blank-ready' && (payload as { itemId?: string }).itemId === 'item-late')).toBe(true))

      emit('plugin:receiver:item-closed', {}, { receiverId: 'receiver-1', itemId: 'item-late', documentGeneration: 5 })
      releaseLate({ locator: 'plugin-frame://late' })
      await expect(lateMount).rejects.toThrow('Receiver frame changed.')

      expect(closedListener).toHaveBeenCalledTimes(1)
      expect(state.invoke.mock.calls.filter(([channel, payload]) =>
        channel === 'plugin:receiver:abort' && (payload as { itemId?: string }).itemId === 'item-late'
      )).toHaveLength(1)
      emit('plugin:receiver:item-closed', {}, { receiverId: 'receiver-1', itemId: 'item-late', documentGeneration: 5 })
      expect(closedListener).toHaveBeenCalledTimes(1)
      expect(slots[0]!.isConnected).toBe(true)
      expect(slots[1]!.isConnected).toBe(false)
    } finally {
      delete (globalThis as { document?: unknown }).document
    }
  })

  it('authenticates offer location in preload and rejects foreign, reused, ambiguous, disconnected, and wrong-location hosts', async () => {
    const hosts = [
      { isConnected: true, id: 'host-left', location: 'left' as const, child: null as { isConnected: boolean } | null },
      { isConnected: true, id: 'host-detail', location: 'detail' as const, child: null as { isConnected: boolean } | null },
    ]
    const hostElements = hosts.map((host) => ({
      isConnected: host.isConnected,
      append(frame: { isConnected: boolean }): void {
        host.child = frame
        frame.isConnected = true
      },
      getAttribute(name: string): string | null {
        if (name === 'data-plugin-receiver-mount-host') return host.id
        if (name === 'data-plugin-receiver-location') return host.location
        return null
      },
      remove(): void {
        host.isConnected = false
        this.isConnected = false
        if (host.child) host.child.isConnected = false
      },
    }))
    const frames = new Map<string, { isConnected: boolean; setAttribute: (name: string, value: string) => void; src: string }>()
    const document = {
      createElement: vi.fn(() => {
        const frame = {
          isConnected: false,
          src: '',
          setAttribute(name: string, value: string): void {
            if (name === 'data-plugin-receiver-frame') frames.set(value, frame)
          },
        }
        return frame
      }),
      querySelectorAll: vi.fn(() => hostElements),
      querySelector: vi.fn((selector: string) => {
        const token = selector.match(/data-plugin-receiver-frame="([^"]+)"/)?.[1]
        return token ? frames.get(token) ?? null : null
      }),
    }
    Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
    try {
      const nav = await loadPreload(true)
      state.invoke.mockImplementation(async (channel: string, payload: { offerId?: string; receiverId?: string; itemId?: string }) => {
        if (channel === 'plugin:receiver:mount') {
          if (payload.offerId === 'offer-good') return { itemId: 'item-good' }
          return { itemId: payload.offerId === 'offer-foreign' ? 'item-foreign' : 'item-reused' }
        }
        if (channel === 'plugin:receiver:blank-ready') return { locator: 'plugin-frame://detail' }
        return undefined
      })
      state.getFrameForSelector.mockImplementation((selector: string) => ({
        frameToken: selector.match(/data-plugin-receiver-frame="([^"]+)"/)?.[1],
      }))
      ;(nav.onReceiverOffer as (receiverId: string, listener: (offer: unknown) => void) => () => void)('receiver-1', vi.fn())
      emit('plugin:receiver:offer', {}, {
        receiverId: 'receiver-2',
        offer: { offerId: 'offer-foreign', contributionKey: 'provider.detail', title: 'Foreign', location: 'detail', resourceKey: 'canonical:/workspace/foreign.ts' },
      })
      await expect((nav.mountReceiver as (receiverId: string, offerId: string, placement: { mountHostId: string }) => Promise<unknown>)('receiver-1', 'offer-foreign', { mountHostId: 'host-detail' })).rejects.toThrow('Receiver offer is unavailable.')

      hosts[0]!.id = 'host-detail'
      hosts[0]!.location = 'detail'
      emit('plugin:receiver:offer', {}, {
        receiverId: 'receiver-1',
        offer: { offerId: 'offer-multiple', contributionKey: 'provider.detail', title: 'Multiple', location: 'detail', resourceKey: 'canonical:/workspace/multiple.ts' },
      })
      await expect((nav.mountReceiver as (receiverId: string, offerId: string, placement: { mountHostId: string }) => Promise<unknown>)('receiver-1', 'offer-multiple', { mountHostId: 'host-detail' })).rejects.toThrow('Receiver mount host is unavailable.')
      hosts[0]!.id = 'host-left'
      hosts[0]!.location = 'left'

      emit('plugin:receiver:offer', {}, {
        receiverId: 'receiver-1',
        offer: { offerId: 'offer-wrong-location', contributionKey: 'provider.detail', title: 'Wrong location', location: 'detail', resourceKey: 'canonical:/workspace/wrong-location.ts' },
      })
      await expect((nav.mountReceiver as (receiverId: string, offerId: string, placement: { mountHostId: string }) => Promise<unknown>)('receiver-1', 'offer-wrong-location', { mountHostId: 'host-left' })).rejects.toThrow('Receiver mount host is unavailable.')

      emit('plugin:receiver:offer', {}, {
        receiverId: 'receiver-1',
        offer: { offerId: 'offer-good', contributionKey: 'provider.detail', title: 'Good', location: 'detail', resourceKey: 'canonical:/workspace/good.ts' },
      })
      await expect((nav.mountReceiver as (receiverId: string, offerId: string, placement: { mountHostId: string }) => Promise<unknown>)('receiver-1', 'offer-good', { mountHostId: 'host-detail' })).resolves.toEqual({ itemId: 'item-good' })
      expect(state.invoke.mock.calls.find(([channel, payload]) => channel === 'plugin:receiver:mount' && (payload as { offerId?: string }).offerId === 'offer-good')?.[1]).not.toHaveProperty('location')
      await expect((nav.mountReceiver as (receiverId: string, offerId: string, placement: { mountHostId: string }) => Promise<unknown>)('receiver-1', 'offer-good', { mountHostId: 'host-detail' })).rejects.toThrow('Receiver offer is unavailable.')

      hostElements[1]!.isConnected = false
      emit('plugin:receiver:offer', {}, {
        receiverId: 'receiver-1',
        offer: { offerId: 'offer-disconnected', contributionKey: 'provider.detail', title: 'Disconnected', location: 'detail', resourceKey: 'canonical:/workspace/disconnected.ts' },
      })
      await expect((nav.mountReceiver as (receiverId: string, offerId: string, placement: { mountHostId: string }) => Promise<unknown>)('receiver-1', 'offer-disconnected', { mountHostId: 'host-detail' })).rejects.toThrow('Receiver mount host is unavailable.')
    } finally {
      delete (globalThis as { document?: unknown }).document
    }
  })

  it('retains canonical detail resource identity and consumes accept-existing offers once', async () => {
    const nav = await loadPreload(true)
    const offers: unknown[] = []
    state.invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'plugin:receiver:register') return { receiverId: 'receiver-detail' }
      if (channel === 'plugin:receiver:accept-existing') return { accepted: true, itemId: 'item-existing' }
      return undefined
    })

    ;(nav.onReceiverOffer as (receiverId: string, listener: (offer: unknown) => void) => () => void)(
      'receiver-detail',
      (offer) => offers.push(offer),
    )
    const registration = { protocolVersion: 1 as const, locations: ['detail' as const] }
    await (nav.registerReceiver as (value: typeof registration) => Promise<{ receiverId: string }>)(registration)
    emit('plugin:receiver:offer', {}, {
      receiverId: 'receiver-detail',
      offer: {
        resourceKey: 'canonical:/workspace/src/App.ts',
        title: 'Detail',
        location: 'detail',
        offerId: 'offer-existing',
        contributionKey: 'provider.detail',
      },
    })

    expect(offers).toEqual([{
      offerId: 'offer-existing',
      contributionKey: 'provider.detail',
      title: 'Detail',
      location: 'detail',
      resourceKey: 'canonical:/workspace/src/App.ts',
    }])
    await expect((nav.acceptExistingReceiverOffer as (receiverId: string, offerId: string, itemId: string) => Promise<unknown>)(
      'receiver-detail', 'offer-existing', 'item-original',
    )).resolves.toEqual({ accepted: true, itemId: 'item-existing' })
    expect(state.invoke).toHaveBeenCalledWith('plugin:receiver:accept-existing', {
      receiverId: 'receiver-detail', offerId: 'offer-existing', itemId: 'item-original',
    })
    await expect((nav.acceptExistingReceiverOffer as (receiverId: string, offerId: string, itemId: string) => Promise<unknown>)(
      'receiver-detail', 'offer-existing', 'item-original',
    )).rejects.toThrow('Receiver offer is unavailable.')
  })

  it('routes openTarget and settles backend subscriptions from Host IPC', async () => {
    const originalArgs = process.argv
    process.argv = [...originalArgs, '--plugin-backend=1']
    try {
      const nav = await loadPreload(true)
      state.invoke.mockImplementation(async (channel: string, payload: { subscriptionId?: string }) =>
        channel === 'plugin:backend:subscribe'
          ? { reqId: payload.subscriptionId, ok: true }
          : { reqId: '', ok: false },
      )
      const target = vi.fn()
      const removeTarget = (nav.onOpenTarget as (cb: (params: Record<string, string>) => void) => () => void)(target)
      emit('plugin:openTarget', {}, { path: 'src/App.vue' })
      expect(target).toHaveBeenCalledWith({ path: 'src/App.vue' })
      removeTarget()

      const event = vi.fn()
      const subscription = (nav.subscribeBackend as (name: string, cb: (data: unknown) => void) => {
        ready: Promise<void>
        settled: Promise<void>
        dispose(): void
      })('git.status', event)
      await subscription.ready
      const subscriptionId = state.invoke.mock.calls.at(-1)?.[1]?.subscriptionId
      emit('plugin:backend:event', {}, {
        subscriptionId,
        event: 'git.status',
        payload: { branch: 'main' },
      })
      expect(event).toHaveBeenCalledWith({ branch: 'main' })
      emit('plugin:backend:status', {}, {
        subscriptionId,
        ok: false,
        error: { code: 'BACKEND_UNAVAILABLE', message: 'backend stopped' },
      })
      await expect(subscription.settled).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    } finally {
      process.argv = originalArgs
    }
  })

  it('scopes left catalog transport and correlates editor targets without leaking correlation', async () => {
    const nav = await loadPreload(true)
    const pendingResolve = vi.fn()
    let releasePending!: (result: { opened: boolean }) => void
    const pending = new Promise<{ opened: boolean }>((resolve) => { releasePending = resolve })
    const r1Listener = vi.fn((target: { path: string; sourceItem: string }) => {
      expect(target).not.toHaveProperty('correlation')
      if (target.path === 'pending') return pending
      if (target.path === 'throw') throw new Error('editor failed')
      return { opened: target.path === 'src/App.ts' }
    })
    const r2Listener = vi.fn(async () => ({ opened: true }))
    state.invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'plugin:receiver:register') return { receiverId: payload.editorTargets ? 'receiver-1' : 'receiver-2' }
      if (channel === 'plugin:receiver:list-left-contributions') return [{ contributionKey: 'provider.left', title: 'Provider', icon: 'data:image/png;base64,AA', iconMonochrome: true }]
      if (channel === 'plugin:receiver:open-left') return { offered: payload.receiverId === 'receiver-1' }
      if (channel === 'plugin:receiver:dispose') return undefined
      if (channel === 'plugin:receiver:resolve-editor-target') {
        pendingResolve(payload)
        return undefined
      }
      return undefined
    })

    type EditorTargetRegistration = {
      protocolVersion: 1
      locations: ['left']
      editorTargets: { protocolVersion: 1 }
    }
    const registration: EditorTargetRegistration = { protocolVersion: 1, locations: ['left'], editorTargets: { protocolVersion: 1 } }
    expect(await (nav.registerReceiver as (value: EditorTargetRegistration) => Promise<{ receiverId: string }>)(registration)).toEqual({ receiverId: 'receiver-1' })
    await expect((nav.listReceiverLeftContributions as (receiverId: string) => Promise<unknown>)('receiver-1'))
      .resolves.toEqual([{
        contributionKey: 'provider.left',
        title: 'Provider',
        // The Host resolves the manifest icon; the preload only validates and
        // forwards the display metadata.
        icon: 'data:image/png;base64,AA',
        iconMonochrome: true,
      }])
    await expect((nav.openReceiverLeft as (receiverId: string, contributionKey: string) => Promise<void>)('receiver-1', 'provider.left')).resolves.toBeUndefined()
    expect(state.invoke).toHaveBeenCalledWith('plugin:receiver:list-left-contributions', { receiverId: 'receiver-1' })
    expect(state.invoke).toHaveBeenCalledWith('plugin:receiver:open-left', { receiverId: 'receiver-1', contributionKey: 'provider.left' })

    ;(nav.onReceiverEditorTarget as (receiverId: string, listener: typeof r1Listener) => () => void)('receiver-1', r1Listener)
    emit('plugin:receiver:editor-target', {}, { receiverId: 'receiver-1', correlation: 'bad-shape', target: { path: 'src/App.ts' } })
    emit('plugin:receiver:editor-target', {}, { receiverId: 'receiver-1', correlation: 'false-result', target: { path: 'other.ts', sourceItem: 'opaque' } })
    emit('plugin:receiver:editor-target', {}, { receiverId: 'receiver-1', correlation: 'throw-result', target: { path: 'throw', sourceItem: 'opaque' } })
    await vi.waitFor(() => expect(pendingResolve).toHaveBeenCalledTimes(2))
    expect(pendingResolve).toHaveBeenCalledWith({ receiverId: 'receiver-1', correlation: 'false-result', result: { opened: false } })
    expect(pendingResolve).toHaveBeenCalledWith({ receiverId: 'receiver-1', correlation: 'throw-result', result: { opened: false } })
    expect(r1Listener).toHaveBeenCalledTimes(2)

    emit('plugin:receiver:editor-target', {}, { receiverId: 'receiver-1', correlation: 'pending-result', target: { path: 'pending', sourceItem: 'opaque' } })
    await vi.waitFor(() => expect(r1Listener).toHaveBeenCalledTimes(3))
    await (nav.disposeReceiver as (receiverId: string) => Promise<void>)('receiver-1')
    releasePending({ opened: true })
    await Promise.resolve()
    await Promise.resolve()
    expect(pendingResolve).not.toHaveBeenCalledWith({ correlation: 'pending-result', result: { opened: true } })

    expect(await (nav.registerReceiver as (registration: { protocolVersion: 1; locations: ['left'] }) => Promise<{ receiverId: string }>)({ protocolVersion: 1, locations: ['left'] })).toEqual({ receiverId: 'receiver-2' })
    ;(nav.onReceiverEditorTarget as (receiverId: string, listener: typeof r2Listener) => () => void)('receiver-2', r2Listener)
    emit('plugin:receiver:editor-target', {}, { receiverId: 'receiver-2', correlation: 'new-result', target: { path: 'src/App.ts', sourceItem: 'opaque' } })
    await vi.waitFor(() => expect(r2Listener).toHaveBeenCalledOnce())
    expect(r1Listener).toHaveBeenCalledTimes(3)
    expect(pendingResolve).toHaveBeenCalledWith({ receiverId: 'receiver-2', correlation: 'new-result', result: { opened: true } })
  })

  it('scopes editor-target delivery and acknowledgements to the receiver id across live registrations', async () => {
    const nav = await loadPreload(true)
    const resolveCalls: unknown[] = []
    let registrations = 0
    state.invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
      if (channel === 'plugin:receiver:resolve-editor-target') resolveCalls.push(payload)
      if (channel === 'plugin:receiver:register') {
        registrations += 1
        return { receiverId: registrations === 1 ? 'receiver-a' : 'receiver-b' }
      }
      return undefined
    })
    const receiverA = { protocolVersion: 1 as const, locations: ['left' as const], editorTargets: { protocolVersion: 1 as const } }
    const receiverB = { protocolVersion: 1 as const, locations: ['left' as const], editorTargets: { protocolVersion: 1 as const } }
    await (nav.registerReceiver as (value: typeof receiverA) => Promise<{ receiverId: string }>)(receiverA)
    const callbackA = vi.fn(async () => ({ opened: false }))
    const callbackB = vi.fn(async () => ({ opened: true }))
    ;(nav.onReceiverEditorTarget as (receiverId: string, listener: typeof callbackA) => () => void)('receiver-a', callbackA)
    await (nav.registerReceiver as (value: typeof receiverB) => Promise<{ receiverId: string }>)(receiverB)
    ;(nav.onReceiverEditorTarget as (receiverId: string, listener: typeof callbackB) => () => void)('receiver-b', callbackB)

    emit('plugin:receiver:editor-target', {}, {
      receiverId: 'receiver-b', correlation: 'b-target', target: { path: 'src/B.ts', sourceItem: 'opaque' },
    })
    await vi.waitFor(() => expect(callbackB).toHaveBeenCalledOnce())
    expect(callbackA).not.toHaveBeenCalled()
    expect(resolveCalls).toEqual([{ receiverId: 'receiver-b', correlation: 'b-target', result: { opened: true } }])
  })

  describe('receiver close guard', () => {
    type ClosePrepare = (reason: string) => Promise<unknown>
    type CloseGuardNav = Record<string, unknown>

    async function loadCloseGuard(
      receiverId: string,
      onPrepare: ClosePrepare,
      requestResult: unknown = { closed: true },
    ): Promise<{
      nav: CloseGuardNav
      onPrepare: ReturnType<typeof vi.fn>
      onCancelled: ReturnType<typeof vi.fn>
      resolveCalls: Array<Record<string, unknown>>
      requestCloseTransaction: () => Promise<unknown>
    }> {
      const nav = await loadPreload(true)
      const resolveCalls: Array<Record<string, unknown>> = []
      state.invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
        if (channel === 'plugin:receiver:register') return { receiverId }
        if (channel === 'plugin:receiver:resolve-close') {
          resolveCalls.push(payload)
          return undefined
        }
        if (channel === 'plugin:receiver:request-close-transaction') return requestResult
        return undefined
      })
      const prepare = vi.fn(onPrepare)
      const onCancelled = vi.fn()
      const registration = {
        protocolVersion: 1 as const,
        locations: ['detail' as const],
        closeGuard: { protocolVersion: 1 as const },
      }
      await (nav.registerReceiver as (value: typeof registration) => Promise<{ receiverId: string }>)(registration)
      ;(nav.onReceiverCloseGuard as (value: string, prepare: ClosePrepare, cancel: () => void) => () => void)(
        receiverId, prepare, onCancelled,
      )
      return {
        nav,
        onPrepare: prepare,
        onCancelled,
        resolveCalls,
        requestCloseTransaction: () => (nav.requestCloseReceiverTransaction as (
          value: string, itemIds: readonly string[],
        ) => Promise<unknown>)(receiverId, ['item-a']),
      }
    }

    const closeRequest = (receiverId: string, closeId: string, reason = 'receiver-item-batch'): void => {
      emit('plugin:receiver:close-request', {}, { receiverId, closeId, reason, documentGeneration: 3 })
    }

    it('registers the guard marker, hides correlation, and settles only the first accepted reply', async () => {
      const { onPrepare, resolveCalls, onCancelled } = await loadCloseGuard('receiver-close', async () => ({
        accepted: true, reason: 'accepted',
      }))
      expect(state.invoke).toHaveBeenCalledWith('plugin:receiver:register', {
        protocolVersion: 1, locations: ['detail'], closeGuard: { protocolVersion: 1 },
      })

      closeRequest('receiver-close', 'close-1')
      await vi.waitFor(() => expect(resolveCalls).toHaveLength(1))
      expect(onPrepare).toHaveBeenCalledOnce()
      expect(onPrepare).toHaveBeenCalledWith('receiver-item-batch')
      expect(resolveCalls[0]).toEqual({
        receiverId: 'receiver-close', closeId: 'close-1', decision: { accepted: true, reason: 'accepted' },
      })
      expect(onCancelled).not.toHaveBeenCalled()
      emit('plugin:receiver:close-cancelled', {}, { receiverId: 'receiver-close', closeId: 'close-1' })
      expect(onCancelled).toHaveBeenCalledOnce()
      emit('plugin:receiver:close-cancelled', {}, { receiverId: 'receiver-close', closeId: 'close-1' })
      expect(onCancelled).toHaveBeenCalledOnce()
      expect(resolveCalls).toHaveLength(1)
    })

    it('releases the settled preparation when the receiver-initiated transaction resolves', async () => {
      const { onPrepare, requestCloseTransaction } = await loadCloseGuard('receiver-close', async () => ({
        accepted: true, reason: 'accepted',
      }))
      closeRequest('receiver-close', 'close-1')
      await vi.waitFor(() => expect(onPrepare).toHaveBeenCalledOnce())
      await expect(requestCloseTransaction()).resolves.toEqual({ closed: true })

      closeRequest('receiver-close', 'close-2')
      await vi.waitFor(() => expect(onPrepare).toHaveBeenCalledTimes(2))
      expect(onPrepare.mock.calls[1]?.[0]).toBe('receiver-item-batch')
    })

    it('keeps the preparation while a concurrent request is answered busy', async () => {
      let settlePrepare!: (decision: unknown) => void
      const pending = new Promise((resolve) => { settlePrepare = resolve })
      const { onPrepare, resolveCalls } = await loadCloseGuard('receiver-close', () => pending)
      closeRequest('receiver-close', 'close-1')
      await vi.waitFor(() => expect(onPrepare).toHaveBeenCalledOnce())
      closeRequest('receiver-close', 'close-2')
      await vi.waitFor(() => expect(resolveCalls).toHaveLength(1))
      expect(resolveCalls[0]).toEqual({
        receiverId: 'receiver-close', closeId: 'close-2', decision: { accepted: false, reason: 'busy' },
      })
      expect(onPrepare).toHaveBeenCalledOnce()

      settlePrepare({ accepted: true, reason: 'accepted' })
      await vi.waitFor(() => expect(resolveCalls).toHaveLength(2))
      expect(resolveCalls[1]).toEqual({
        receiverId: 'receiver-close', closeId: 'close-1', decision: { accepted: true, reason: 'accepted' },
      })
    })

    it('releases a cancelled pending preparation and again on a late accepted decision', async () => {
      let settlePrepare!: (decision: unknown) => void
      const pending = new Promise((resolve) => { settlePrepare = resolve })
      const { onPrepare, onCancelled, resolveCalls } = await loadCloseGuard('receiver-close', () => pending)
      closeRequest('receiver-close', 'close-1')
      await vi.waitFor(() => expect(onPrepare).toHaveBeenCalledOnce())

      emit('plugin:receiver:close-cancelled', {}, { receiverId: 'receiver-close', closeId: 'close-1' })
      expect(onCancelled).toHaveBeenCalledOnce()
      settlePrepare({ accepted: true, reason: 'accepted' })
      await vi.waitFor(() => expect(onCancelled).toHaveBeenCalledTimes(2))
      expect(resolveCalls).toHaveLength(0)
      expect(onPrepare).toHaveBeenCalledOnce()
    })

    it('ignores foreign receivers, wrong reasons, and malformed generations without acknowledging', async () => {
      const { onPrepare, resolveCalls } = await loadCloseGuard('receiver-close', async () => ({
        accepted: true, reason: 'accepted',
      }))
      emit('plugin:receiver:close-request', {}, {
        receiverId: 'receiver-other', closeId: 'close-foreign', reason: 'receiver-item-batch', documentGeneration: 3,
      })
      emit('plugin:receiver:close-request', {}, {
        receiverId: 'receiver-close', closeId: 'close-bad-reason', reason: 'user', documentGeneration: 3,
      })
      emit('plugin:receiver:close-request', {}, {
        receiverId: 'receiver-close', closeId: 'close-bad-generation', reason: 'receiver-item-batch', documentGeneration: -1,
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(onPrepare).not.toHaveBeenCalled()
      expect(resolveCalls).toHaveLength(0)
    })

    it('disposes the guard and suppresses a late acceptance acknowledgement', async () => {
      let settlePrepare!: (decision: unknown) => void
      const pending = new Promise((resolve) => { settlePrepare = resolve })
      const nav = await loadPreload(true)
      const resolveCalls: Array<Record<string, unknown>> = []
      state.invoke.mockImplementation(async (channel: string, payload: Record<string, unknown>) => {
        if (channel === 'plugin:receiver:register') return { receiverId: 'receiver-close' }
        if (channel === 'plugin:receiver:resolve-close') resolveCalls.push(payload)
        return undefined
      })
      const registration = {
        protocolVersion: 1 as const,
        locations: ['detail' as const],
        closeGuard: { protocolVersion: 1 as const },
      }
      await (nav.registerReceiver as (value: typeof registration) => Promise<{ receiverId: string }>)(registration)
      const dispose = (nav.onReceiverCloseGuard as (
        value: string, prepare: ClosePrepare, cancel: () => void,
      ) => () => void)('receiver-close', () => pending, vi.fn())
      closeRequest('receiver-close', 'close-1')
      await vi.waitFor(() => expect(state.listeners.get('plugin:receiver:close-request')?.size ?? 0).toBeGreaterThan(0))
      dispose()
      settlePrepare({ accepted: true, reason: 'accepted' })
      await Promise.resolve()
      await Promise.resolve()
      expect(resolveCalls).toHaveLength(0)
    })
  })

  it.each(['messageerror', 'revoked'] as const)(
    'settles pending calls and subscriptions once on frame %s',
    async (failure) => {
      const nav = await loadPreload(false)
      const documentReady = state.invoke.mock.calls.find(([channel]) => channel === 'plugin:frame:document-ready')
      const handler = [...(state.listeners.get('plugin:frame:port') ?? [])][0]
      const admitted = port()
      handler?.({ ports: [admitted] }, {
        nonce: documentReady?.[1]?.nonce,
        documentGeneration: 1,
      })

      const pending = (nav.callCapability as (ns: string, method: string) => Promise<unknown>)('editor', 'open')
      const event = vi.fn()
      const subscription = (nav.subscribeBackend as (name: string, cb: (data: unknown) => void) => {
        ready: Promise<void>
        settled: Promise<void>
        dispose(): void
      })('git.status', event)
      const subscribeRequest = admitted.postMessage.mock.calls
        .map(([message]) => message as { channel?: string; requestId?: string; payload?: { subscriptionId?: string } })
        .find((message) => message.channel === 'plugin:backend:subscribe')
      expect(subscribeRequest?.requestId).toEqual(expect.any(String))
      admitted.onmessage?.({
        data: {
          channel: 'plugin:response',
          documentGeneration: 1,
          payload: {
            requestId: subscribeRequest?.requestId,
            response: { reqId: subscribeRequest?.requestId, ok: true },
          },
        },
      })
      await subscription.ready

      if (failure === 'messageerror') {
        admitted.onmessageerror?.()
      } else {
        admitted.onmessage?.({
          data: { channel: 'plugin:frame:revoked', documentGeneration: 1, payload: null },
        })
      }

      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'PLUGIN_STOPPING' } })
      await expect(subscription.settled).rejects.toThrow()
      await expect(subscription.settled).rejects.toThrow()
      expect(event).not.toHaveBeenCalled()
    },
  )
})
