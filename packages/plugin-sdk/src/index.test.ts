import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_ERROR_CODES } from '@navide/plugin-contracts'
import {
  createPluginCapabilityClient,
  createPluginViewRuntimeClient,
  createPluginBackendClient,
  PluginBackendError,
  createPluginSettingsStore,
  createPluginViewState,
  hideView,
  onBackendStatus,
  onOpenTarget,
  openContributionWindow,
  viewReady,
  type PluginContext,
} from './index'

interface TestBackendBridge {
  callBackend: ReturnType<typeof vi.fn>
  cancelBackend: ReturnType<typeof vi.fn>
  subscribeBackend: ReturnType<typeof vi.fn>
}

interface TestCapabilityBridge {
  callCapability: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

function installBackendBridge(bridge: TestBackendBridge): void {
  ;(globalThis as unknown as { nav: TestBackendBridge }).nav = bridge
}

afterEach(() => {
  delete (globalThis as unknown as { nav?: TestBackendBridge }).nav
})

describe('public plugin SDK adapters', () => {
  it('keeps Host offer location private while mounting only by offerId and host id', async () => {
    type OfferListener = (offer: { offerId: string; contributionKey: string; title: string; location: 'left' | 'detail' }) => void
    let offerListener: OfferListener | undefined
    const getOfferListener = (): OfferListener => {
      if (!offerListener) throw new Error('offer listener was not registered')
      return offerListener
    }
    const removeOffers = vi.fn()
    const bridge = {
      registerReceiver: vi.fn(async () => ({ receiverId: 'receiver-1' })),
      mountReceiver: vi.fn(async () => ({ itemId: 'item-1' })),
      requestCloseReceiver: vi.fn(async () => ({ closed: true as const })),
      abortReceiverItem: vi.fn(async () => undefined),
      onReceiverOffer: vi.fn((_receiverId: string, listener: OfferListener) => {
        offerListener = listener
        return removeOffers
      }),
      onReceiverItemClosed: vi.fn(() => vi.fn()),
      disposeReceiver: vi.fn(async () => undefined),
      ready: vi.fn(),
      hideSelf: vi.fn(),
      onOpenTarget: vi.fn(() => vi.fn()),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge

    const receiver = await createPluginViewRuntimeClient().registerReceiver(
      { protocolVersion: 1, locations: ['detail'] },
      vi.fn(),
    )
    getOfferListener()({ offerId: 'offer-detail', contributionKey: 'provider.detail', title: 'Detail', location: 'detail' })

    await expect(receiver.mount('offer-detail', { mountHostId: 'host-detail' })).resolves.toEqual({ itemId: 'item-1' })
    expect(bridge.mountReceiver).toHaveBeenCalledWith(
      'receiver-1',
      'offer-detail',
      { mountHostId: 'host-detail' },
    )
    expect(bridge.mountReceiver.mock.calls[0]).toHaveLength(3)

    await receiver.dispose()
    expect(removeOffers).toHaveBeenCalledOnce()
    await expect(receiver.mount('unknown-offer', { mountHostId: 'host-detail' })).rejects.toMatchObject({ code: 'PLUGIN_STOPPING' })
  })

  it('forwards a receiver close transaction through the public runtime bridge', async () => {
    const bridge = {
      callCapability: vi.fn(() => Promise.resolve({ reqId: 'close-transaction', ok: true, result: null })),
      on: vi.fn(),
      registerReceiver: vi.fn(async () => ({ receiverId: 'receiver-transaction' })),
      requestCloseReceiverTransaction: vi.fn(async () => ({ closed: false as const, reason: 'busy' as const })),
      onReceiverOffer: vi.fn(() => vi.fn()),
      onReceiverEditorTarget: vi.fn(() => vi.fn()),
      onReceiverItemClosed: vi.fn(() => vi.fn()),
      disposeReceiver: vi.fn(async () => undefined),
      ready: vi.fn(),
      hideSelf: vi.fn(),
      onOpenTarget: vi.fn(() => vi.fn()),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    const receiver = await createPluginViewRuntimeClient().registerReceiver(
      { protocolVersion: 1, locations: ['detail'] }, vi.fn(),
    )
    await expect(receiver.requestCloseTransaction(['item-a', 'item-b']))
      .resolves.toEqual({ closed: false, reason: 'busy' })
    expect(bridge.requestCloseReceiverTransaction).toHaveBeenCalledWith(
      'receiver-transaction', ['item-a', 'item-b'],
    )
  })

  it('strips close-guard functions from the registration wire and scopes the callback to the receiver', async () => {
    let prepareListener: ((reason: string) => Promise<unknown>) | undefined
    const cancelListeners: Array<() => void> = []
    const removeGuard = vi.fn()
    const bridge = {
      registerReceiver: vi.fn(async () => ({ receiverId: 'receiver-guard' })),
      onReceiverOffer: vi.fn(() => vi.fn()),
      onReceiverCloseGuard: vi.fn((
        _receiverId: string,
        prepare: (reason: string) => Promise<unknown>,
        cancel: () => void,
      ) => {
        prepareListener = prepare
        cancelListeners.push(cancel)
        return removeGuard
      }),
      onReceiverItemClosed: vi.fn(() => vi.fn()),
      disposeReceiver: vi.fn(async () => undefined),
      ready: vi.fn(),
      hideSelf: vi.fn(),
      onOpenTarget: vi.fn(() => vi.fn()),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    const onPrepare = vi.fn(async () => ({ accepted: true as const, reason: 'accepted' as const }))
    const onCancelled = vi.fn()
    const receiver = await createPluginViewRuntimeClient().registerReceiver({
      protocolVersion: 1,
      locations: ['detail'],
      closeGuard: { protocolVersion: 1, onPrepare, onCancelled },
    }, vi.fn())

    expect(bridge.registerReceiver).toHaveBeenCalledWith({
      protocolVersion: 1, locations: ['detail'], closeGuard: { protocolVersion: 1 },
    })
    expect(bridge.onReceiverCloseGuard).toHaveBeenCalledWith('receiver-guard', expect.any(Function), expect.any(Function))
    await expect(prepareListener?.('native-window-close')).resolves.toEqual({ accepted: true, reason: 'accepted' })
    expect(onPrepare).toHaveBeenCalledWith('native-window-close')
    expect(onCancelled).not.toHaveBeenCalled()
    cancelListeners[0]?.()
    expect(onCancelled).toHaveBeenCalledOnce()

    await receiver.dispose()
    expect(removeGuard).toHaveBeenCalledOnce()
    onCancelled.mockClear()
    cancelListeners[0]?.()
    expect(onCancelled).not.toHaveBeenCalled()
    await expect(prepareListener?.('quit')).resolves.toEqual({ accepted: false, reason: 'refused' })
  })

  it('rejects a malformed close guard before registering the receiver', async () => {
    const bridge = { registerReceiver: vi.fn() }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    const runtime = createPluginViewRuntimeClient()
    for (const closeGuard of [
      { protocolVersion: 2, onPrepare: vi.fn(), onCancelled: vi.fn() },
      { protocolVersion: 1, onPrepare: vi.fn() },
      { protocolVersion: 1, onCancelled: vi.fn() },
    ]) {
      await expect(runtime.registerReceiver({
        protocolVersion: 1, locations: ['detail'], closeGuard,
      } as never, vi.fn())).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(bridge.registerReceiver).not.toHaveBeenCalled()
  })

  it('normalizes a throwing or malformed close-guard decision to refused', async () => {
    const prepareListeners: Array<(reason: string) => Promise<unknown>> = []
    const bridge = {
      registerReceiver: vi.fn(async () => ({ receiverId: 'receiver-guard' })),
      onReceiverOffer: vi.fn(() => vi.fn()),
      onReceiverCloseGuard: vi.fn((_receiverId: string, prepare: (reason: string) => Promise<unknown>) => {
        prepareListeners.push(prepare)
        return vi.fn()
      }),
      onReceiverItemClosed: vi.fn(() => vi.fn()),
      disposeReceiver: vi.fn(async () => undefined),
      ready: vi.fn(),
      hideSelf: vi.fn(),
      onOpenTarget: vi.fn(() => vi.fn()),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    const malformed = [
      () => { throw new Error('guard failed') },
      () => Promise.resolve({ accepted: true, reason: 'refused' }),
      () => Promise.resolve(null as never),
    ]
    const runtime = createPluginViewRuntimeClient()
    for (const onPrepare of malformed) {
      await runtime.registerReceiver({
        protocolVersion: 1, locations: ['detail'],
        closeGuard: { protocolVersion: 1, onPrepare: onPrepare as never, onCancelled: vi.fn() },
      }, vi.fn())
    }
    for (const prepare of prepareListeners) {
      await expect(prepare('reload')).resolves.toEqual({ accepted: false, reason: 'refused' })
    }
  })

  it('forwards paired editor targets with opaque source items and preserves legacy target isolation', async () => {
    type EditorTargetListener = (target: { path: string; line?: number; column?: number; sourceItem: string }) => Promise<{ opened: boolean }>
    let editorTargetListener: EditorTargetListener | undefined
    const getEditorTargetListener = (): EditorTargetListener => {
      if (!editorTargetListener) throw new Error('editor target listener was not registered')
      return editorTargetListener
    }
    const removeEditorTargets = vi.fn()
    const legacyTargetListener = vi.fn()
    const onOpen = vi.fn((target: { path: string; line?: number; column?: number; sourceItem: string }): Promise<{ opened: boolean }> => {
      expect(target.sourceItem).toBe('opaque-source-item')
      if (target.path === 'throw') throw new Error('editor failed')
      if (target.path === 'malformed') return Promise.resolve(null as never)
      return Promise.resolve({ opened: target.path === 'src/App.ts' })
    })
    const bridge = {
      registerReceiver: vi.fn(async () => ({ receiverId: 'receiver-1' })),
      listReceiverLeftContributions: vi.fn(async () => [{ contributionKey: 'provider.left', title: 'Provider' }]),
      openReceiverLeft: vi.fn(async () => undefined),
      mountReceiver: vi.fn(async () => ({ itemId: 'item-1' })),
      requestCloseReceiver: vi.fn(async () => ({ closed: true as const })),
      abortReceiverItem: vi.fn(async () => undefined),
      onReceiverOffer: vi.fn(() => vi.fn()),
      onReceiverEditorTarget: vi.fn((_receiverId: string, listener: EditorTargetListener) => {
        editorTargetListener = listener
        return removeEditorTargets
      }),
      onReceiverItemClosed: vi.fn(() => vi.fn()),
      disposeReceiver: vi.fn(async () => undefined),
      ready: vi.fn(),
      hideSelf: vi.fn(),
      on: vi.fn(),
      onOpenTarget: vi.fn((_listener: typeof legacyTargetListener) => vi.fn()),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge

    const client = createPluginViewRuntimeClient()
    const receiver = await client.registerReceiver({
      protocolVersion: 1,
      locations: ['left'],
      editorTargets: { protocolVersion: 1, onOpen },
    }, vi.fn())
    expect(bridge.registerReceiver).toHaveBeenCalledWith({
      protocolVersion: 1,
      locations: ['left'],
      editorTargets: { protocolVersion: 1 },
    })
    await expect(receiver.listLeftContributions()).resolves.toEqual([{ contributionKey: 'provider.left', title: 'Provider' }])
    await receiver.openLeft('provider.left')
    expect(bridge.listReceiverLeftContributions).toHaveBeenCalledWith('receiver-1')
    expect(bridge.openReceiverLeft).toHaveBeenCalledWith('receiver-1', 'provider.left')

    await expect(getEditorTargetListener()({ path: 'src/App.ts', line: 3, column: 4, sourceItem: 'opaque-source-item' })).resolves.toEqual({ opened: true })
    await expect(getEditorTargetListener()({ path: '', sourceItem: 'opaque-source-item' })).resolves.toEqual({ opened: false })
    await expect(getEditorTargetListener()({ path: 'malformed', sourceItem: 'opaque-source-item' })).resolves.toEqual({ opened: false })
    await expect(getEditorTargetListener()({ path: 'throw', sourceItem: 'opaque-source-item' })).resolves.toEqual({ opened: false })
    expect(onOpen).toHaveBeenCalledTimes(4)

    const legacy = client.onOpenTarget(legacyTargetListener)
    expect(legacyTargetListener).not.toHaveBeenCalled()
    legacy.dispose()
    await receiver.dispose()
    expect(removeEditorTargets).toHaveBeenCalledOnce()
  })

  it('suppresses detail-target callbacks and acknowledgements when disposed before the microtask', async () => {
    let targetListener: ((payload: unknown) => void) | undefined
    const callCapability = vi.fn(() => Promise.resolve(undefined))
    const bridge = {
      callCapability,
      on: vi.fn((_channel: string, listener: (payload: unknown) => void) => {
        targetListener = listener
        return vi.fn()
      }),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge

    const onTarget = vi.fn(async () => ({ applied: true as const }))
    const disposable = createPluginViewRuntimeClient().onDetailTarget(onTarget)
    targetListener?.({ targetId: 'target-1', revision: 1, target: { path: 'src/App.ts' } })
    disposable.dispose()
    await Promise.resolve()
    await Promise.resolve()

    expect(onTarget).not.toHaveBeenCalled()
    expect(callCapability).not.toHaveBeenCalled()
  })

  it('keeps target ids one-shot and separates highest-seen revisions from last-applied revisions', async () => {
    let targetListener: ((payload: unknown) => void) | undefined
    const resolveTarget = vi.fn(() => Promise.resolve(undefined))
    const bridge = {
      callCapability: resolveTarget,
      on: vi.fn((_channel: string, listener: (payload: unknown) => void) => {
        targetListener = listener
        return vi.fn()
      }),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge

    const onTarget = vi.fn(async (update: { revision: number }) =>
      update.revision === 2 ? { applied: false as const, reason: 'refused' as const } : { applied: true as const })
    const disposable = createPluginViewRuntimeClient().onDetailTarget(onTarget)

    targetListener?.({ targetId: 'target-1', revision: 2, target: { path: 'src/first.ts' } })
    await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalledOnce())
    targetListener?.({ targetId: 'target-1', revision: 2, target: { path: 'src/duplicate.ts' } })
    targetListener?.({ targetId: 'target-2', revision: 1, target: { path: 'src/stale.ts' } })
    targetListener?.({ targetId: 'target-3', revision: 3, target: { path: 'src/accepted.ts' } })
    await vi.waitFor(() => expect(resolveTarget).toHaveBeenCalledTimes(3))

    expect(onTarget).toHaveBeenCalledTimes(2)
    expect(onTarget).toHaveBeenNthCalledWith(1, { revision: 2, target: { path: 'src/first.ts' } })
    expect(onTarget).toHaveBeenNthCalledWith(2, { revision: 3, target: { path: 'src/accepted.ts' } })
    expect(resolveTarget).toHaveBeenCalledWith('ui', 'resolveDetailTarget', {
      targetId: 'target-1', revision: 2, decision: { applied: false, reason: 'refused' },
    })
    expect(resolveTarget).toHaveBeenCalledWith('ui', 'resolveDetailTarget', {
      targetId: 'target-2', revision: 1, decision: { applied: false, reason: 'refused' },
    })
    expect(resolveTarget).toHaveBeenCalledWith('ui', 'resolveDetailTarget', {
      targetId: 'target-3', revision: 3, decision: { applied: true },
    })
    expect(resolveTarget).toHaveBeenCalledTimes(3)
    disposable.dispose()
  })

  it('does not acknowledge a guarded close after its disposer cancels a pending decision', async () => {
    let closeListener: ((payload: unknown) => void) | undefined
    let release!: (decision: { accepted: true; reason: 'accepted' }) => void
    const callCapability = vi.fn(() => Promise.resolve({ reqId: 'close-1', ok: true, result: null }))
    const bridge = {
      callCapability,
      on: vi.fn((_channel: string, listener: (payload: unknown) => void) => {
        closeListener = listener
        return vi.fn()
      }),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    const pending = new Promise<{ accepted: true; reason: 'accepted' }>((resolve) => { release = resolve })
    const dispose = createPluginViewRuntimeClient().onPrepareClose(() => pending)
    closeListener?.({ closeId: 'close-1', itemId: 'item-1', reason: 'user', documentGeneration: 3 })
    dispose.dispose()
    release({ accepted: true, reason: 'accepted' })
    await Promise.resolve()
    await Promise.resolve()
    expect(callCapability).not.toHaveBeenCalled()
  })

  it('does not invoke or acknowledge a duplicate guarded-close correlation twice', async () => {
    let closeListener: ((payload: unknown) => void) | undefined
    let release!: (decision: { accepted: true; reason: 'accepted' }) => void
    const callCapability = vi.fn(() => Promise.resolve({ reqId: 'close-2', ok: true, result: null }))
    const bridge = {
      callCapability,
      on: vi.fn((_channel: string, listener: (payload: unknown) => void) => {
        closeListener = listener
        return vi.fn()
      }),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    const pending = new Promise<{ accepted: true; reason: 'accepted' }>((resolve) => { release = resolve })
    const listener = vi.fn(() => pending)
    createPluginViewRuntimeClient().onPrepareClose(listener)
    const request = { closeId: 'close-2', itemId: 'item-2', reason: 'user' as const, documentGeneration: 4 }
    closeListener?.(request)
    closeListener?.(request)
    expect(listener).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())
    release({ accepted: true, reason: 'accepted' })
    await vi.waitFor(() => expect(callCapability).toHaveBeenCalledOnce())
    expect(listener).toHaveBeenCalledOnce()
    expect(callCapability).toHaveBeenCalledWith('ui', 'resolveDetailClose', {
      closeId: 'close-2', itemId: 'item-2', decision: { accepted: true, reason: 'accepted' },
    })
  })

  it('turns an active synchronous close-listener throw into one refusal acknowledgement', async () => {
    let closeListener: ((payload: unknown) => void) | undefined
    const callCapability = vi.fn(() => Promise.resolve({ reqId: 'close-throw', ok: true, result: null }))
    const bridge = {
      callCapability,
      on: vi.fn((_channel: string, listener: (payload: unknown) => void) => {
        closeListener = listener
        return vi.fn()
      }),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    createPluginViewRuntimeClient().onPrepareClose(() => { throw new Error('provider failed') })
    closeListener?.({ closeId: 'close-throw', itemId: 'item-throw', reason: 'user', documentGeneration: 5 })
    await vi.waitFor(() => expect(callCapability).toHaveBeenCalledOnce())
    expect(callCapability).toHaveBeenCalledWith('ui', 'resolveDetailClose', {
      closeId: 'close-throw', itemId: 'item-throw', decision: { accepted: false, reason: 'refused' },
    })
  })

  it('releases a pending close twice on cancellation and late acceptance without acknowledging', async () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    const callCapability = vi.fn(() => Promise.resolve({ reqId: 'close-pending', ok: true, result: null }))
    const bridge = {
      callCapability,
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener)
        return vi.fn()
      }),
      ready: vi.fn(),
      onOpenTarget: vi.fn(() => vi.fn()),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    let release!: (decision: { accepted: true; reason: 'accepted' }) => void
    const pending = new Promise<{ accepted: true; reason: 'accepted' }>((resolve) => { release = resolve })
    const cancelled = vi.fn()
    const runtime = createPluginViewRuntimeClient()
    runtime.onCloseCancelled(cancelled)
    runtime.onPrepareClose(() => pending)
    listeners.get('plugin:view:close-request')?.({ closeId: 'close-pending', itemId: 'item-pending', reason: 'user', documentGeneration: 1 })
    await Promise.resolve()
    listeners.get('plugin:view:close-cancelled')?.({ closeId: 'close-pending' })
    expect(cancelled).toHaveBeenCalledOnce()
    release({ accepted: true, reason: 'accepted' })
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(2))
    expect(callCapability).not.toHaveBeenCalled()
  })

  it('releases an accepted close once and ignores duplicate cancellation', async () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    const callCapability = vi.fn(() => Promise.resolve({ reqId: 'close-accepted', ok: true, result: null }))
    const bridge = {
      callCapability,
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener)
        return vi.fn()
      }),
      ready: vi.fn(),
      onOpenTarget: vi.fn(() => vi.fn()),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    const cancelled = vi.fn()
    const runtime = createPluginViewRuntimeClient()
    runtime.onCloseCancelled(cancelled)
    runtime.onPrepareClose(() => ({ accepted: true, reason: 'accepted' }))
    listeners.get('plugin:view:close-request')?.({ closeId: 'close-accepted', itemId: 'item-accepted', reason: 'user', documentGeneration: 2 })
    await vi.waitFor(() => expect(callCapability).toHaveBeenCalledOnce())
    listeners.get('plugin:view:close-cancelled')?.({ closeId: 'close-accepted' })
    listeners.get('plugin:view:close-cancelled')?.({ closeId: 'close-accepted' })
    expect(cancelled).toHaveBeenCalledOnce()
    expect(callCapability).toHaveBeenCalledWith('ui', 'resolveDetailClose', {
      closeId: 'close-accepted', itemId: 'item-accepted', decision: { accepted: true, reason: 'accepted' },
    })
  })

  it('keeps one cancelled async prepare serialized until its late callback settles', async () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    const callCapability = vi.fn(() => Promise.resolve({ reqId: 'close-serialized', ok: true, result: null }))
    const bridge = {
      callCapability,
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener)
        return vi.fn()
      }),
      ready: vi.fn(),
      onOpenTarget: vi.fn(() => vi.fn()),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    let releaseA!: (decision: { accepted: true; reason: 'accepted' }) => void
    const pendingA = new Promise<{ accepted: true; reason: 'accepted' }>((resolve) => { releaseA = resolve })
    const cancelled = vi.fn()
    const listener = vi.fn((request: { closeId: string }) =>
      request.closeId === 'close-C'
        ? { accepted: true as const, reason: 'accepted' as const }
        : pendingA)
    const runtime = createPluginViewRuntimeClient()
    runtime.onCloseCancelled(cancelled)
    runtime.onPrepareClose(listener)

    listeners.get('plugin:view:close-request')?.({ closeId: 'close-A', itemId: 'item-A', reason: 'user', documentGeneration: 1 })
    await Promise.resolve()
    listeners.get('plugin:view:close-cancelled')?.({ closeId: 'close-A' })
    listeners.get('plugin:view:close-request')?.({ closeId: 'close-B', itemId: 'item-B', reason: 'user', documentGeneration: 1 })
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()

    releaseA({ accepted: true, reason: 'accepted' })
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(2))
    expect(callCapability).toHaveBeenCalledWith('ui', 'resolveDetailClose', {
      closeId: 'close-B', itemId: 'item-B', decision: { accepted: false, reason: 'busy' },
    })
    expect(callCapability).not.toHaveBeenCalledWith('ui', 'resolveDetailClose', expect.objectContaining({ closeId: 'close-A' }))

    listeners.get('plugin:view:close-request')?.({ closeId: 'close-C', itemId: 'item-C', reason: 'user', documentGeneration: 1 })
    await vi.waitFor(() => expect(callCapability).toHaveBeenCalledOnce())
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ closeId: 'close-C' }))
  })

  it('suppresses cancellation callback and acknowledgement after close disposer', async () => {
    const listeners = new Map<string, (payload: unknown) => void>()
    const callCapability = vi.fn(() => Promise.resolve({ reqId: 'close-disposed', ok: true, result: null }))
    const bridge = {
      callCapability,
      on: vi.fn((channel: string, listener: (payload: unknown) => void) => {
        listeners.set(channel, listener)
        return vi.fn()
      }),
      ready: vi.fn(),
      onOpenTarget: vi.fn(() => vi.fn()),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    let release!: (decision: { accepted: true; reason: 'accepted' }) => void
    const pending = new Promise<{ accepted: true; reason: 'accepted' }>((resolve) => { release = resolve })
    const cancelled = vi.fn()
    const runtime = createPluginViewRuntimeClient()
    runtime.onCloseCancelled(cancelled)
    const disposer = runtime.onPrepareClose(() => pending)
    listeners.get('plugin:view:close-request')?.({ closeId: 'close-disposed', itemId: 'item-disposed', reason: 'user', documentGeneration: 3 })
    disposer.dispose()
    listeners.get('plugin:view:close-cancelled')?.({ closeId: 'close-disposed' })
    release({ accepted: true, reason: 'accepted' })
    await Promise.resolve()
    await Promise.resolve()
    expect(cancelled).not.toHaveBeenCalled()
    expect(callCapability).not.toHaveBeenCalled()
  })

  it('routes contribution window requests through the fixed capability', async () => {
    const bridge: TestCapabilityBridge = {
      callCapability: vi.fn(() => Promise.resolve({ reqId: 'cap-window', ok: true, result: { ok: true } })),
      on: vi.fn(),
    }
    ;(globalThis as unknown as { nav: TestCapabilityBridge }).nav = bridge

    await expect(createPluginViewRuntimeClient().openContributionWindow({
      contributionKey: 'navide.git.left', path: 'src/main.ts', line: 4,
    })).resolves.toEqual({ ok: true })
    expect(bridge.callCapability).toHaveBeenCalledWith('ui', 'openPluginWindow', {
      contributionKey: 'navide.git.left', path: 'src/main.ts', line: 4,
    })
  })

  it('preserves unavailable contribution results from the Host', async () => {
    const bridge: TestCapabilityBridge = {
      callCapability: vi.fn(() => Promise.resolve({ reqId: 'cap-window-2', ok: true,
        result: { ok: false, error: 'PLUGIN_UNAVAILABLE', message: 'window unavailable' } })),
      on: vi.fn(),
    }
    ;(globalThis as unknown as { nav: TestCapabilityBridge }).nav = bridge

    await expect(createPluginViewRuntimeClient().openContributionWindow({ contributionKey: 'missing.window' }))
      .resolves.toEqual({ ok: false, error: 'PLUGIN_UNAVAILABLE', message: 'window unavailable' })
  })

  it('routes typed public capabilities and events through the SDK boundary', async () => {
    const unsubscribe = vi.fn()
    const bridge: TestCapabilityBridge = {
      callCapability: vi.fn((namespace: string, method: string) => Promise.resolve({
        reqId: 'cap-1',
        ok: true,
        result: namespace === 'storage' && method === 'get'
          ? { found: true, value: 'compact' }
          : null,
      })),
      on: vi.fn((_type: string, _listener: (payload: unknown) => void) => unsubscribe),
    }
    ;(globalThis as unknown as { nav: TestCapabilityBridge }).nav = bridge

    const client = createPluginCapabilityClient()
    await expect(client.capabilities.invoke('storage.get', { scope: 'workspace', key: 'density' }))
      .resolves.toEqual({ found: true, value: 'compact' })
    const listener = vi.fn()
    const subscription = client.events.subscribe('aiCli.exited', listener)
    subscription.dispose()

    expect(bridge.callCapability).toHaveBeenCalledWith(
      'storage',
      'get',
      { scope: 'workspace', key: 'density' },
    )
    expect(bridge.on).toHaveBeenCalledWith('aiCli.exited', listener)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('maps legacy broker errors to stable public PluginError codes', async () => {
    const bridge: TestCapabilityBridge = {
      callCapability: vi.fn(() => Promise.resolve({
        reqId: 'cap-2',
        ok: false,
        error: { code: 'CAP_DENIED', message: 'not granted' },
      })),
      on: vi.fn(),
    }
    ;(globalThis as unknown as { nav: TestCapabilityBridge }).nav = bridge

    await expect(createPluginCapabilityClient().capabilities.invoke('storage.get', {
      scope: 'workspace',
      key: 'density',
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED', message: 'not granted' })
  })

  it('models the Host RESOURCE_LIMIT code instead of flattening it to INTERNAL_ERROR', async () => {
    // The Host emits RESOURCE_LIMIT into the plugin-facing capability envelope
    // (backend round-trip limits). An unmodeled code is silently downgraded to
    // INTERNAL_ERROR, which no exhaustive switch on PluginErrorCode can see.
    expect(PLUGIN_ERROR_CODES).toContain('RESOURCE_LIMIT')

    const bridge: TestCapabilityBridge = {
      callCapability: vi.fn(() => Promise.resolve({
        reqId: 'cap-3',
        ok: false,
        error: { code: 'RESOURCE_LIMIT', message: 'backend call limit reached' },
      })),
      on: vi.fn(),
    }
    ;(globalThis as unknown as { nav: TestCapabilityBridge }).nav = bridge

    await expect(createPluginCapabilityClient().capabilities.invoke('storage.get', {
      scope: 'workspace',
      key: 'density',
    })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT', message: 'backend call limit reached' })
  })

  it('adapts view readiness and open targets through the public SDK', () => {
    const removeTargetListener = vi.fn()
    const bridge = {
      ready: vi.fn(),
      on: vi.fn(),
      onOpenTarget: vi.fn(() => removeTargetListener),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge

    const client = createPluginViewRuntimeClient()
    const listener = vi.fn()
    client.ready()
    const target = client.onOpenTarget(listener)
    target.dispose()

    expect(bridge.ready).toHaveBeenCalledOnce()
    expect(bridge.onOpenTarget).toHaveBeenCalledWith(listener)
    expect(removeTargetListener).toHaveBeenCalledOnce()
  })

  it('keeps the package-local stack for errors created in the renderer', () => {
    const error = new PluginBackendError('INVALID_ARGUMENT', 'bad arguments')

    expect(error.stack).toContain('PluginBackendError')
  })

  it('routes backend calls through the private Host bridge without exposing identity fields', async () => {
    const bridge: TestBackendBridge = {
      callBackend: vi.fn((reqId: string) =>
        Promise.resolve({ reqId, ok: true, result: { root: '/workspace' } })
      ),
      cancelBackend: vi.fn(),
      subscribeBackend: vi.fn(() => ({
        ready: Promise.resolve(),
        settled: Promise.resolve(),
        dispose: vi.fn(),
      })),
    }
    installBackendBridge(bridge)

    const client = createPluginBackendClient()
    await expect(client.call('plans.resolve_root', { workspace_path: '/workspace' }))
      .resolves.toEqual({ root: '/workspace' })

    expect(bridge.callBackend).toHaveBeenCalledWith(
      expect.any(String),
      'plans.resolve_root',
      { workspace_path: '/workspace' },
      undefined,
    )
  })

  it('cancels an in-flight backend call through its exact request id', async () => {
    const bridge: TestBackendBridge = {
      callBackend: vi.fn(() => new Promise(() => undefined)),
      cancelBackend: vi.fn(),
      subscribeBackend: vi.fn(() => ({
        ready: Promise.resolve(),
        settled: Promise.resolve(),
        dispose: vi.fn(),
      })),
    }
    installBackendBridge(bridge)
    const controller = new AbortController()
    const client = createPluginBackendClient()
    const pending = client.call('plans.resolve_root', null, { signal: controller.signal })

    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'USER_CANCELLED' })
    expect(bridge.cancelBackend).toHaveBeenCalledWith(bridge.callBackend.mock.calls[0][0])
  })

  it('preserves a Host resource-limit code through the public SDK', async () => {
    const bridge: TestBackendBridge = {
      callBackend: vi.fn((reqId: string) => Promise.resolve({
        reqId,
        ok: false,
        error: { code: 'RESOURCE_LIMIT', message: 'too many calls' },
      })),
      cancelBackend: vi.fn(),
      subscribeBackend: vi.fn(() => ({
        ready: Promise.resolve(),
        settled: Promise.resolve(),
        dispose: vi.fn(),
      })),
    }
    installBackendBridge(bridge)

    await expect(createPluginBackendClient().call('plans.resolve_root', null))
      .rejects.toMatchObject({ code: 'RESOURCE_LIMIT', message: 'too many calls' })
  })

  it('adapts a backend event disposer to the public Disposable contract', async () => {
    const dispose = vi.fn()
    const bridge: TestBackendBridge = {
      callBackend: vi.fn(),
      cancelBackend: vi.fn(),
      subscribeBackend: vi.fn(() => ({ ready: Promise.resolve(), settled: Promise.resolve(), dispose })),
    }
    installBackendBridge(bridge)
    const listener = vi.fn()
    const client = createPluginBackendClient()

    const subscription = client.subscribe('plans.changed', listener)
    await subscription.ready
    await subscription.settled
    subscription.dispose()

    expect(bridge.subscribeBackend).toHaveBeenCalledWith('plans.changed', listener)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('derives storage identity from PluginContext instead of plugin input', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ found: true, value: { density: 'compact' } })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(true)
    const context = { capabilities: { invoke } } as unknown as PluginContext
    const settings = createPluginSettingsStore(context, 'workspace')

    await expect(settings.get('view')).resolves.toEqual({ density: 'compact' })
    await expect(settings.set('view', { density: 'comfortable' })).resolves.toBeUndefined()
    await expect(settings.delete('view')).resolves.toBe(true)
    expect(invoke.mock.calls).toEqual([
      ['storage.get', { scope: 'workspace', key: 'view' }],
      ['storage.set', { scope: 'workspace', key: 'view', value: { density: 'comfortable' } }],
      ['storage.delete', { scope: 'workspace', key: 'view' }],
    ])
  })
})

describe('standalone view runtime functions', () => {
  it('leaves the view runtime client shape unchanged', () => {
    ;(globalThis as unknown as { nav: object }).nav = { ready: vi.fn(), onOpenTarget: vi.fn() }
    const client = createPluginViewRuntimeClient()
    expect(Object.isFrozen(client)).toBe(true)
    expect(Object.keys(client)).toEqual([
      'openDetail', 'onDetailTarget', 'onPrepareClose', 'onCloseCancelled', 'openContributionWindow',
      'ready', 'hide', 'registerReceiver', 'onOpenTarget', 'onBackendStatus',
    ])
  })

  it('makes the same bridge calls as the client methods', async () => {
    const removeTarget = vi.fn()
    const removeStatus = vi.fn()
    const bridge = {
      ready: vi.fn(),
      hideSelf: vi.fn(),
      onOpenTarget: vi.fn(() => removeTarget),
      callCapability: vi.fn(() => Promise.resolve({ reqId: 'cap-window', ok: true, result: { ok: true } })),
      on: vi.fn((_type: string, _listener: (payload: unknown) => void) => removeStatus),
    }
    ;(globalThis as unknown as { nav: typeof bridge }).nav = bridge
    const client = createPluginViewRuntimeClient()

    viewReady()
    client.ready()
    expect(bridge.ready).toHaveBeenCalledTimes(2)
    hideView()
    client.hide()
    expect(bridge.hideSelf).toHaveBeenCalledTimes(2)

    const params = { contributionKey: 'navide.git.left', path: 'src/main.ts', line: 4 }
    await expect(openContributionWindow(params)).resolves.toEqual(await client.openContributionWindow(params))
    expect(bridge.callCapability.mock.calls).toEqual([
      ['ui', 'openPluginWindow', params],
      ['ui', 'openPluginWindow', params],
    ])

    const targetListener = vi.fn()
    const target = onOpenTarget(targetListener)
    expect(Object.isFrozen(target)).toBe(true)
    expect(bridge.onOpenTarget).toHaveBeenCalledWith(targetListener)
    expect(target.dispose).toBe(removeTarget)
    expect(() => onOpenTarget(undefined as unknown as () => void)).toThrow('Plugin target listener is invalid.')
    expect(() => client.onOpenTarget(undefined as unknown as () => void)).toThrow('Plugin target listener is invalid.')

    const statuses: string[] = []
    const status = onBackendStatus(value => statuses.push(value))
    expect(Object.isFrozen(status)).toBe(true)
    expect(status.dispose).toBe(removeStatus)
    expect(bridge.on).toHaveBeenCalledWith('nav.backend_status', expect.any(Function))
    const deliver = bridge.on.mock.calls[0][1]
    deliver({ status: 'connected' })
    deliver({ status: 'bogus' })
    deliver(null)
    expect(statuses).toEqual(['connected'])
  })

  it('reports an unavailable runtime the same way as the client', () => {
    expect(() => viewReady()).toThrow('Plugin view runtime is unavailable.')
    expect(() => onBackendStatus(vi.fn())).toThrow('Plugin capability runtime is unavailable.')
  })
})

describe('createPluginViewState', () => {
  function storage() {
    const stored = new Map<string, unknown>()
    const invoke = vi.fn(async (method: string, params: { key: string; value?: unknown }) => {
      if (method === 'storage.set') { stored.set(params.key, params.value); return null }
      if (method === 'storage.get') {
        return stored.has(params.key) ? { found: true, value: stored.get(params.key) } : { found: false, value: null }
      }
      throw new Error(`unexpected ${method}`)
    })
    return { stored, invoke, context: { capabilities: { invoke } } as unknown as Pick<PluginContext, 'capabilities'> }
  }

  it('restores what the view saved before a reload, under view-state:<key>', async () => {
    const { invoke, context } = storage()
    const before = createPluginViewState<{ open: boolean }>('filters', { open: false }, { context })
    await expect(before.restore()).resolves.toEqual({ open: false })
    before.save({ open: true })
    await before.flush()
    const after = createPluginViewState<{ open: boolean }>('filters', { open: false }, { context })
    await expect(after.restore()).resolves.toEqual({ open: true })
    expect(invoke).toHaveBeenCalledWith('storage.set', { scope: 'plugin', key: 'view-state:filters', value: { open: true } })
  })

  it('writes one value at a time and only the newest pending one', async () => {
    const { invoke, context, stored } = storage()
    const state = createPluginViewState<number>('n', 0, { context, scope: 'workspace' })
    state.save(1)
    state.save(2)
    state.save(3)
    await state.flush()
    expect(invoke.mock.calls.map(([, params]) => params.value)).toEqual([1, 3])
    expect(stored.get('view-state:n')).toBe(3)
  })

  it('never rejects: unreadable or failed storage gives the fallback and keeps going', async () => {
    const invoke = vi.fn(async () => { throw new Error('CAPABILITY_DENIED') })
    const state = createPluginViewState<string>('x', 'fallback', { context: { capabilities: { invoke } } as unknown as Pick<PluginContext, 'capabilities'> })
    await expect(state.restore()).resolves.toBe('fallback')
    state.save('a')
    await expect(state.flush()).resolves.toBeUndefined()
    expect(() => createPluginViewState('', 0, { context: { capabilities: { invoke } } as unknown as Pick<PluginContext, 'capabilities'> })).toThrow(TypeError)
  })
})

const SDK_EXPORTS = [
  'PluginBackendError',
  'PluginError',
  'createPluginBackendClient',
  'createPluginCapabilityClient',
  'createPluginSettingsStore',
  'createPluginViewRuntimeClient',
  'createPluginViewState',
  'definePlugin',
  'hideView',
  'hostApiVersion',
  'onBackendStatus',
  'onOpenTarget',
  'openContributionWindow',
  'viewReady',
]

describe('public surface', () => {
  it('keeps its exports', async () => {
    expect(Object.keys(await import('./index')).sort()).toEqual(SDK_EXPORTS)
  })

  it('reads the Host API version, and null from a Host too old to say', async () => {
    const { hostApiVersion } = await import('./index')
    const nav = (globalThis as { nav?: unknown }).nav
    ;(globalThis as { nav?: unknown }).nav = { apiVersion: '1.0.0' }
    expect(hostApiVersion()).toBe('1.0.0')
    ;(globalThis as { nav?: unknown }).nav = {}
    expect(hostApiVersion()).toBeNull()
    ;(globalThis as { nav?: unknown }).nav = nav
  })
})
