// @vitest-environment happy-dom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'

type OfferListener = (offer:
  | { offerId: string; contributionKey: string; title: string; location: 'left' }
  | { offerId: string; contributionKey: string; title: string; location: 'detail'; resourceKey: string }
) => void
type ItemClosedListener = (item: { itemId: string; documentGeneration: number }) => void
type EditorTargetListener = (target: { path: string; line?: number; column?: number; sourceItem: string }) => Promise<{ opened: boolean }>
type ClosePrepareListener = (reason: 'receiver-item-batch' | 'native-window-close' | 'reload' | 'quit') => Promise<{ accepted: boolean; reason?: string }>
type MountPlacement = { mountHostId: string }
type CloseTransactionResult = { closed: true } | { closed: false; reason: 'refused' | 'busy' | 'unavailable' | 'timeout' }

const state = {
  offerListener: null as OfferListener | null,
  itemClosedListener: null as ItemClosedListener | null,
  editorTargetListener: null as EditorTargetListener | null,
  closePrepareListener: null as ClosePrepareListener | null,
  closeCancelledListener: null as (() => void) | null,
  registration: null as unknown,
  closeTransactionItems: null as string[] | null,
  closeTransactionResult: { closed: false, reason: 'refused' } as CloseTransactionResult,
  mountImplementation: null as (() => Promise<{ itemId: string }>) | null,
  existingOfferAcceptance: { accepted: true, itemId: 'item-1' } as { accepted: boolean; itemId?: string; reason?: 'refused' | 'busy' },
  nextItemId: 0,
}

const nav = {
  callCapability: vi.fn(async (_namespace: string, method: string): Promise<{
    reqId: string; ok: boolean; result: Record<string, unknown>
  }> => ({
    reqId: 'test',
    ok: true,
    result: method === 'readEditorPreferences' ? { preferences: {} } : { found: false },
  })),
  on: vi.fn(() => vi.fn()),
  ready: vi.fn(),
  hideSelf: vi.fn(),
  registerReceiver: vi.fn(async (registration: unknown) => {
    state.registration = registration
    return { receiverId: 'receiver-1' }
  }),
  listReceiverLeftContributions: vi.fn(async () => []),
  openReceiverLeft: vi.fn(async () => undefined),
  acceptExistingReceiverOffer: vi.fn(async () => state.existingOfferAcceptance),
  onReceiverOffer: vi.fn((_receiverId: string, listener: OfferListener) => {
    state.offerListener = listener
    return vi.fn()
  }),
  onReceiverEditorTarget: vi.fn((_receiverId: string, listener: EditorTargetListener) => {
    state.editorTargetListener = listener
    return vi.fn()
  }),
  onReceiverCloseGuard: vi.fn((_receiverId: string, onPrepare: ClosePrepareListener, onCancelled: () => void) => {
    state.closePrepareListener = onPrepare
    state.closeCancelledListener = onCancelled
    return vi.fn()
  }),
  mountReceiver: vi.fn(async (_receiverId: string, _offerId: string, _placement: MountPlacement) => {
    if (state.mountImplementation) return state.mountImplementation()
    state.nextItemId += 1
    return { itemId: `item-${state.nextItemId}` }
  }),
  requestCloseReceiver: vi.fn(async () => ({ closed: true as const })),
  requestCloseReceiverTransaction: vi.fn(async (_receiverId: string, itemIds: readonly string[]) => {
    state.closeTransactionItems = [...itemIds]
    return state.closeTransactionResult
  }),
  abortReceiverItem: vi.fn(async () => undefined),
  onReceiverItemClosed: vi.fn((_receiverId: string, listener: ItemClosedListener) => {
    state.itemClosedListener = listener
    return vi.fn()
  }),
  disposeReceiver: vi.fn(async () => undefined),
  onOpenTarget: vi.fn(() => vi.fn()),
}

;(globalThis as unknown as { nav: typeof nav }).nav = nav

let MiniIdeApp: typeof import('../MiniIdeApp.vue').default

// Importing the full MiniIdeApp is slow when the whole suite runs in parallel.
beforeAll(async () => {
  MiniIdeApp = (await import('../MiniIdeApp.vue')).default
}, 60_000)

beforeEach(() => {
  state.offerListener = null
  state.itemClosedListener = null
  state.editorTargetListener = null
  state.closePrepareListener = null
  state.closeCancelledListener = null
  state.registration = null
  state.closeTransactionItems = null
  state.closeTransactionResult = { closed: false, reason: 'refused' }
  state.mountImplementation = null
  state.existingOfferAcceptance = { accepted: true, itemId: 'item-1' }
  state.nextItemId = 0
  nav.callCapability.mockClear()
  nav.on.mockClear()
  nav.registerReceiver.mockClear()
  nav.listReceiverLeftContributions.mockClear()
  nav.openReceiverLeft.mockClear()
  nav.acceptExistingReceiverOffer.mockClear()
  nav.onReceiverOffer.mockClear()
  nav.onReceiverEditorTarget.mockClear()
  nav.onReceiverCloseGuard.mockClear()
  nav.mountReceiver.mockClear()
  nav.requestCloseReceiver.mockClear()
  nav.requestCloseReceiverTransaction.mockClear()
  nav.abortReceiverItem.mockClear()
  nav.onReceiverItemClosed.mockClear()
  nav.disposeReceiver.mockClear()
  nav.onOpenTarget.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function shallowMiniIde(): VueWrapper {
  return mount(MiniIdeApp, {
    shallow: true,
    attachTo: document.body,
    global: { mocks: { $t: (key: string) => key } },
  })
}

async function offer(offerId: string, contributionKey = 'acme.provider.left', location: 'left' | 'detail' = 'left'): Promise<void> {
  state.offerListener?.({
    offerId, contributionKey, title: offerId, location,
  } as Parameters<OfferListener>[0])
  await flushPromises()
  await flushPromises()
}

describe('MiniIdeApp receiver item lifecycle', { timeout: 30_000 }, () => {
  it('removes only the closed receiver item and preserves a sibling host', async () => {
    const wrapper = shallowMiniIde()
    await flushPromises()

    await offer('offer-left-1')
    await offer('offer-left-2')
    expect(wrapper.findAll('.ide-receiver-slot-item')).toHaveLength(2)
    const siblingHost = wrapper.findAll('.ide-receiver-slot-item')[1]!.element
    expect(siblingHost.isConnected).toBe(true)

    state.itemClosedListener?.({ itemId: 'item-1', documentGeneration: 4 })
    await flushPromises()

    expect(wrapper.findAll('.ide-receiver-slot-item')).toHaveLength(1)
    expect(siblingHost.isConnected).toBe(true)
    expect(nav.disposeReceiver).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('hides a mounted plugin sidebar when returning to Explorer', async () => {
    const contributionKey = 'acme.provider.left'
    nav.listReceiverLeftContributions.mockImplementationOnce(async () => [
      { contributionKey, title: 'Git', location: 'left' },
    ] as never[])
    const wrapper = shallowMiniIde()
    await flushPromises()

    const gitButton = wrapper.findAll('.ide-act-btn').find(button => button.attributes('title') === 'Git')
    expect(gitButton).toBeDefined()
    await gitButton!.trigger('click')
    await offer('offer-git', contributionKey)
    const host = wrapper.get('.ide-receiver-slot-item').element as HTMLElement
    expect(host.hidden).toBe(false)

    const explorer = wrapper.findAll('.ide-act-btn')[0]!
    await explorer.trigger('click')
    expect(explorer.classes()).toContain('active')
    expect(gitButton!.classes()).not.toContain('active')
    expect(host.hidden).toBe(true)
    expect(wrapper.get('.ide-receiver-items--left').attributes('hidden')).toBeDefined()

    await gitButton!.trigger('click')
    expect(host.hidden).toBe(false)
    expect(wrapper.get('.ide-receiver-items--left').attributes('hidden')).toBeUndefined()
    expect(nav.mountReceiver).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('reoffers the same detail resource through the public receiver and accepts the existing item without remounting', async () => {
    const wrapper = shallowMiniIde()
    await flushPromises()
    await offer('detail-offer-1', 'acme.provider.detail', 'detail')
    await vi.waitFor(() => expect(nav.mountReceiver).toHaveBeenCalledOnce())
    const host = wrapper.find('.ide-receiver-slot-item').element
    const tab = wrapper.find('.ide-tab').element
    const itemId = 'item-1'

    await offer('detail-offer-2', 'acme.provider.detail', 'detail')
    await vi.waitFor(() => expect(nav.acceptExistingReceiverOffer).toHaveBeenCalledWith('receiver-1', 'detail-offer-2', itemId))

    expect(nav.mountReceiver).toHaveBeenCalledOnce()
    expect(nav.abortReceiverItem).not.toHaveBeenCalled()
    expect(nav.requestCloseReceiver).not.toHaveBeenCalled()
    expect(wrapper.find('.ide-receiver-slot-item').element).toBe(host)
    expect(host.isConnected).toBe(true)
    expect(wrapper.findAll('.ide-tab')).toHaveLength(1)
    expect(wrapper.find('.ide-tab.active').element).toBe(tab)
    wrapper.unmount()
  })

  it('keeps the current detail tab when existing-item acceptance is refused without fallback mount or mutation', async () => {
    const wrapper = shallowMiniIde()
    await flushPromises()
    await offer('detail-refuse-1', 'acme.provider.detail', 'detail')
    await vi.waitFor(() => expect(nav.mountReceiver).toHaveBeenCalledOnce())
    const host = wrapper.find('.ide-receiver-slot-item').element
    const tab = wrapper.find('.ide-tab').element
    state.existingOfferAcceptance = { accepted: false, reason: 'refused' }

    await offer('detail-refuse-2', 'acme.provider.detail', 'detail')
    await vi.waitFor(() => expect(nav.acceptExistingReceiverOffer).toHaveBeenCalledWith('receiver-1', 'detail-refuse-2', 'item-1'))

    expect(nav.mountReceiver).toHaveBeenCalledOnce()
    expect(nav.abortReceiverItem).not.toHaveBeenCalled()
    expect(wrapper.find('.ide-receiver-slot-item').element).toBe(host)
    expect(wrapper.find('.ide-tab').element).toBe(tab)
    expect(host.isConnected).toBe(true)
    wrapper.unmount()
  })

  it('reproduces rendered provider move through the exact Teleport menu action', async () => {
    const originalMoveBefore = (Element.prototype as Element & { moveBefore?: unknown }).moveBefore
    Object.defineProperty(Element.prototype, 'moveBefore', {
      configurable: true,
      value(this: Element, moved: Node, reference: Node | null) {
        this.insertBefore(moved, reference)
        return moved
      },
    })
    try {
      const wrapper = mount(MiniIdeApp, {
        shallow: true,
        attachTo: document.body,
        global: { mocks: { $t: (key: string) => key }, plugins: [i18n], stubs: { teleport: false } },
      })
      await flushPromises()
      await offer('detail-move-reproduction', 'acme.provider.detail', 'detail')
      await vi.waitFor(() => expect(nav.mountReceiver).toHaveBeenCalledOnce())
      const host = wrapper.find('.ide-receiver-slot-item').element
      await wrapper.find('.ide-tab').trigger('contextmenu')
      await flushPromises()
      const moveItem = Array.from(document.querySelectorAll<HTMLElement>('.ide-tab-ctx-item'))
        .find((item) => item.textContent?.trim() === 'Move to Secondary Editor Group')
      expect(moveItem).toBeDefined()
      await moveItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await flushPromises()
      await vi.waitFor(() => expect(document.querySelector('.ide-main--secondary')).toBeTruthy())
      expect(host.isConnected).toBe(true)
      wrapper.unmount()
    } finally {
      if (originalMoveBefore === undefined) delete (Element.prototype as Element & { moveBefore?: unknown }).moveBefore
      else Object.defineProperty(Element.prototype, 'moveBefore', { configurable: true, value: originalMoveBefore })
    }
  })

  it('keeps a sibling connected when the preload closes a target before mount settles', async () => {
    const wrapper = shallowMiniIde()
    await flushPromises()
    await offer('offer-sibling')
    const siblingHost = wrapper.find('.ide-receiver-slot-item').element
    expect(siblingHost.isConnected).toBe(true)

    state.mountImplementation = () => new Promise((_resolve, reject) => {
      queueMicrotask(() => {
        state.itemClosedListener?.({ itemId: 'item-2', documentGeneration: 5 })
        reject(new Error('Receiver frame changed.'))
      })
    })
    await offer('offer-close-before-settle')

    expect(siblingHost.isConnected).toBe(true)
    expect(wrapper.findAll('.ide-receiver-slot-item')).toHaveLength(1)
    wrapper.unmount()
  })

  it('aborts a mount that settles after receiver disposal without resurrecting its host', async () => {
    let settleMount!: (result: { itemId: string }) => void
    state.mountImplementation = () => new Promise((resolve) => { settleMount = resolve })
    const wrapper = shallowMiniIde()
    await flushPromises()

    const pendingOffer = offer('offer-late')
    await vi.waitFor(() => expect(nav.mountReceiver).toHaveBeenCalledOnce())
    expect(settleMount).toBeTypeOf('function')
    const host = wrapper.find('.ide-receiver-slot-item').element as HTMLElement
    wrapper.unmount()
    await vi.waitFor(() => expect(nav.disposeReceiver).toHaveBeenCalledOnce())

    settleMount({ itemId: 'item-late' })
    await pendingOffer

    expect(nav.abortReceiverItem).not.toHaveBeenCalled()
    expect(host.isConnected).toBe(false)
  })

  it('registers the receiver close guard with the exact marker and callbacks', async () => {
    const wrapper = shallowMiniIde()
    await flushPromises()

    expect(state.registration).toEqual({
      protocolVersion: 1,
      locations: ['left', 'detail'],
      editorTargets: { protocolVersion: 1 },
      closeGuard: { protocolVersion: 1 },
    })
    expect(state.closePrepareListener).toBeTypeOf('function')
    expect(state.closeCancelledListener).toBeTypeOf('function')
    wrapper.unmount()
  })

  function editorPaneStub(leases: {
    prepare: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
    results?: Array<'lease' | 'busy'>
  }): ReturnType<typeof defineComponent> {
    const queue = [...(leases.results ?? [])]
    return defineComponent({
      name: 'EditorPane',
      setup(_, context) {
        context.expose({
          prepareClose: () => {
            leases.prepare()
            if ((queue.shift() ?? 'lease') === 'busy') return null
            return { isCurrent: () => true, release: leases.release }
          },
          save: vi.fn(async () => undefined),
          revealPositionWhenReady: vi.fn(async () => true),
        })
        return () => h('div', { class: 'test-editor-pane' })
      },
    })
  }

  function mountWithEditorStub(
    stub: ReturnType<typeof defineComponent>,
    options: { teleport?: boolean } = {},
  ): VueWrapper {
    return mount(MiniIdeApp, {
      shallow: true,
      attachTo: document.body,
      global: {
        mocks: { $t: (key: string) => key },
        plugins: [i18n],
        stubs: { EditorPane: stub, ...(options.teleport === false ? { teleport: false } : {}) },
      },
    })
  }

  it('freezes every mounted file pane through one guarded preparation and releases on cancellation', async () => {
    const leases = { prepare: vi.fn(), release: vi.fn() }
    const wrapper = mountWithEditorStub(editorPaneStub(leases))
    await flushPromises()
    await state.editorTargetListener?.({ path: 'src/App.ts', line: 1, column: 1, sourceItem: 'item-a' })
    await flushPromises()
    expect(wrapper.find('.test-editor-pane').exists()).toBe(true)

    const accepted = await state.closePrepareListener?.('receiver-item-batch')
    expect(accepted).toEqual({ accepted: true, reason: 'accepted' })
    expect(leases.prepare).toHaveBeenCalledOnce()
    expect(leases.release).not.toHaveBeenCalled()

    state.closeCancelledListener?.()
    expect(leases.release).toHaveBeenCalledOnce()
    await expect(state.closePrepareListener?.('receiver-item-batch')).resolves.toEqual({ accepted: true, reason: 'accepted' })
    expect(leases.prepare).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('fails busy when any mounted pane refuses a lease and releases the leases already acquired', async () => {
    const leases = { prepare: vi.fn(), release: vi.fn(), results: ['lease', 'busy'] as Array<'lease' | 'busy'> }
    const wrapper = mountWithEditorStub(editorPaneStub(leases))
    await flushPromises()
    await state.editorTargetListener?.({ path: 'src/A.ts', line: 1, column: 1, sourceItem: 'item-a' })
    await state.editorTargetListener?.({ path: 'src/B.ts', line: 1, column: 1, sourceItem: 'item-b' })
    await flushPromises()

    await expect(state.closePrepareListener?.('receiver-item-batch')).resolves.toEqual({ accepted: false, reason: 'busy' })
    expect(leases.prepare).toHaveBeenCalledTimes(2)
    expect(leases.release).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('requests one all-or-none transaction for provider tabs and keeps every tab when it is refused', async () => {
    const leases = { prepare: vi.fn(), release: vi.fn() }
    const wrapper = mountWithEditorStub(editorPaneStub(leases), { teleport: false })
    await flushPromises()
    await state.editorTargetListener?.({ path: 'src/App.ts', line: 1, column: 1, sourceItem: 'item-a' })
    await offer('detail-batch', 'acme.provider.detail', 'detail')
    await vi.waitFor(() => expect(nav.mountReceiver).toHaveBeenCalledOnce())
    expect(wrapper.findAll('.ide-tab')).toHaveLength(2)

    state.closeTransactionResult = { closed: false, reason: 'refused' }
    const tabs = wrapper.findAll('.ide-tab')
    await tabs[tabs.length - 1]!.trigger('contextmenu')
    await flushPromises()
    const closeAll = Array.from(document.querySelectorAll<HTMLElement>('.ide-tab-ctx-item'))
      .find((item) => /close-all|Close All/i.test(item.textContent ?? ''))
    expect(closeAll).toBeDefined()
    closeAll!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    await vi.waitFor(() => expect(nav.requestCloseReceiverTransaction).toHaveBeenCalledOnce())
    expect(state.closeTransactionItems).toEqual(['item-1'])
    expect(nav.requestCloseReceiver).not.toHaveBeenCalled()
    expect(wrapper.findAll('.ide-tab')).toHaveLength(2)
    expect(wrapper.find('.test-editor-pane').exists()).toBe(true)
    wrapper.unmount()
  })

  it('commits the batch only after authenticated item-closed and drops the file tabs with it', async () => {
    const leases = { prepare: vi.fn(), release: vi.fn() }
    const wrapper = mountWithEditorStub(editorPaneStub(leases), { teleport: false })
    await flushPromises()
    await state.editorTargetListener?.({ path: 'src/App.ts', line: 1, column: 1, sourceItem: 'item-a' })
    await offer('detail-commit', 'acme.provider.detail', 'detail')
    await vi.waitFor(() => expect(nav.mountReceiver).toHaveBeenCalledOnce())

    state.closeTransactionResult = { closed: true }
    const tabs = wrapper.findAll('.ide-tab')
    await tabs[tabs.length - 1]!.trigger('contextmenu')
    await flushPromises()
    const closeAll = Array.from(document.querySelectorAll<HTMLElement>('.ide-tab-ctx-item'))
      .find((item) => /close-all|Close All/i.test(item.textContent ?? ''))
    closeAll!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(nav.requestCloseReceiverTransaction).toHaveBeenCalledOnce())
    await flushPromises()
    expect(wrapper.findAll('.ide-tab')).toHaveLength(1)
    expect(wrapper.find('.test-editor-pane').exists()).toBe(false)

    state.itemClosedListener?.({ itemId: 'item-1', documentGeneration: 4 })
    await flushPromises()
    expect(wrapper.findAll('.ide-tab')).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('MiniIdeApp failure exits and Quick Open', { timeout: 30_000 }, () => {
  it('reports a detail view whose mount fails instead of swallowing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    state.mountImplementation = () => Promise.reject(new Error('mount refused'))
    const wrapper = shallowMiniIde()
    await flushPromises()
    await offer('offer-fail', 'acme.provider.detail', 'detail')
    expect(warn.mock.calls.some(call => String(call[0]).includes('plugin view failed') && String(call[1]).includes('mount refused'))).toBe(true)
    wrapper.unmount()
  })

  async function openQuickOpen(wrapper: VueWrapper): Promise<HTMLInputElement> {
    const { executeCommand } = await import('@navide/plugin-ui/shared')
    void executeCommand('workbench.action.quickOpen')
    await flushPromises()
    const input = document.querySelector<HTMLInputElement>('.ide-palette-input')
    expect(input).toBeTruthy()
    void wrapper
    return input!
  }

  it('opens the row that was clicked, not the row the highlight last stopped on', async () => {
    const wrapper = shallowMiniIde()
    await flushPromises()
    await state.editorTargetListener?.({ path: 'src/a.ts', sourceItem: 'x' })
    await state.editorTargetListener?.({ path: 'src/b.ts', sourceItem: 'x' })
    const input = await openQuickOpen(wrapper)
    expect(document.querySelectorAll('.ide-palette-item').length).toBe(2)
    const rows = [...document.querySelectorAll<HTMLElement>('.ide-palette-item')]
    // No mouseover fired: the highlight still sits on row 0.
    rows[1]!.click()
    await flushPromises()
    expect(document.querySelector('.ide-palette-input')).toBeNull()
    expect(document.querySelector('.ide-tab.active, .ide-tab--active, [class*="tab"][class*="active"]')?.textContent ?? '').toContain('b.ts')
    void input
    wrapper.unmount()
  })

  it('searches through fs.queryFiles and ranks the answer itself on a Host with the plugin API version', async () => {
    const files = [
      { path: 'a/order-notes.md', name: 'order-notes.md', matchSpans: [], size: 1, mtime: 1 },
      { path: 'z/order.md', name: 'order.md', matchSpans: [], size: 1, mtime: 1 },
    ]
    ;(nav as unknown as { apiVersion?: string }).apiVersion = '1.1.0'
    nav.callCapability.mockImplementation(async (_ns: string, method: string) => ({
      reqId: 'test', ok: true,
      result: method === 'readEditorPreferences' ? { preferences: {} }
        : method === 'queryFiles' ? { ok: true, files } : { found: false },
    }))
    try {
      const wrapper = shallowMiniIde()
      await flushPromises()
      const input = await openQuickOpen(wrapper)
      input.value = 'order.md:42'
      input.dispatchEvent(new Event('input'))
      await vi.waitFor(() => expect(document.body.textContent).toContain('order-notes.md'), { timeout: 2000 })
      expect(nav.callCapability.mock.calls.map(call => call as unknown[]).find(call => call[1] === 'queryFiles')?.[2])
        .toMatchObject({ query: 'order.md', matchOn: 'path', mode: 'substring' })
      const rows = [...document.querySelectorAll<HTMLElement>('.ide-palette-item')].map(row => row.textContent ?? '')
      expect(rows.findIndex(row => row.includes('z/order.md') || row.startsWith('order.md')))
        .toBeLessThan(rows.findIndex(row => row.includes('order-notes.md')))
      wrapper.unmount()
    } finally {
      delete (nav as unknown as { apiVersion?: string }).apiVersion
      nav.callCapability.mockImplementation(async (_ns: string, method: string) => ({
        reqId: 'test', ok: true,
        result: method === 'readEditorPreferences' ? { preferences: {} } : { found: false },
      }))
    }
  })

  it('offers workspace files that are not open, and opens one on click', async () => {
    nav.callCapability.mockImplementation(async (_ns: string, method: string) => ({
      reqId: 'test', ok: true,
      result: method === 'readEditorPreferences' ? { preferences: {} }
        : method === 'listFilesFlat' ? { files: ['docs/adding-a-chat-channel.md'] } : { found: false },
    }))
    try {
      const wrapper = shallowMiniIde()
      await flushPromises()
      const input = await openQuickOpen(wrapper)
      input.value = 'chat-channel'
      input.dispatchEvent(new Event('input'))
      await vi.waitFor(() => expect(document.body.textContent).toContain('adding-a-chat-channel.md'), { timeout: 2000 })
      const row = [...document.querySelectorAll<HTMLElement>('.ide-palette-item')].find(r => r.textContent?.includes('adding-a-chat-channel.md'))!
      row.click()
      await flushPromises()
      expect(document.body.textContent).toContain('adding-a-chat-channel.md')
      expect(document.querySelector('.ide-palette-input')).toBeNull()
      wrapper.unmount()
    } finally {
      nav.callCapability.mockImplementation(async (_ns: string, method: string) => ({
        reqId: 'test', ok: true,
        result: method === 'readEditorPreferences' ? { preferences: {} } : { found: false },
      }))
    }
  })
})
