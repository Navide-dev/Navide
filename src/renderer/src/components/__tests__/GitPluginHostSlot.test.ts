// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, shallowMount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import GitPluginHostSlot from '../GitPluginHostSlot.vue'

type Rect = { x: number; y: number; width: number; height: number }

let currentRect: Rect
let resizeCallback: (() => void) | undefined
let originalAgentTeam: typeof window.agentTeam
let originalRectDescriptor: PropertyDescriptor | undefined
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined

class FakeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = () => callback([], this as unknown as ResizeObserver)
  }

  observe = vi.fn()
  disconnect = vi.fn()
}

beforeEach(() => {
  currentRect = { x: 100, y: 200, width: 400, height: 300 }
  resizeCallback = undefined
  originalAgentTeam = window.agentTeam
  originalRectDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
  originalResizeObserver = globalThis.ResizeObserver

  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ ...currentRect, top: currentRect.y, left: currentRect.x }),
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  })
})

afterEach(() => {
  window.agentTeam = originalAgentTeam
  if (originalRectDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', originalRectDescriptor)
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).getBoundingClientRect
  }
  if (originalResizeObserver) {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: originalResizeObserver,
    })
  } else {
    delete (globalThis as Partial<typeof globalThis>).ResizeObserver
  }
})

describe('GitPluginHostSlot lifecycle', () => {
  it('localizes the empty workspace prompt', async () => {
    const wrapper = mount(GitPluginHostSlot, {
      props: { workspacePath: '', visible: true },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(wrapper.find('.git-plugin-host-slot__empty').text()).toBe(i18n.global.t('git.open-workspace'))
    wrapper.unmount()
  })

  it('opens once, scales bounds, updates visibility and closes on unmount', async () => {
    const openGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    const updateGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    const closeGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    const getZoomFactor = vi.fn().mockResolvedValue(2)
    window.agentTeam = {
      getZoomFactor,
      openGitLeftView,
      updateGitLeftView,
      closeGitLeftView,
    } as unknown as typeof window.agentTeam

    const wrapper = mount(GitPluginHostSlot, {
      props: { workspacePath: '/workspace', visible: true },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(openGitLeftView).toHaveBeenCalledTimes(1)
    expect(openGitLeftView).toHaveBeenCalledWith({
      workspace_path: '/workspace',
      bounds: { x: 50, y: 100, width: 200, height: 150 },
    })
    expect(getZoomFactor).toHaveBeenCalledTimes(1)

    resizeCallback?.()
    await flushPromises()
    expect(openGitLeftView).toHaveBeenCalledTimes(1)
    expect(updateGitLeftView).not.toHaveBeenCalled()

    await wrapper.setProps({ visible: false })
    await flushPromises()
    expect(updateGitLeftView).toHaveBeenCalledTimes(1)
    expect(updateGitLeftView).toHaveBeenCalledWith({
      bounds: { x: 50, y: 100, width: 200, height: 150 },
      visible: false,
    })

    currentRect = { x: 120, y: 220, width: 500, height: 350 }
    await wrapper.setProps({ visible: true })
    resizeCallback?.()
    await flushPromises()
    expect(updateGitLeftView).toHaveBeenLastCalledWith({
      bounds: { x: 60, y: 110, width: 250, height: 175 },
      visible: true,
    })
    expect(getZoomFactor).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    await flushPromises()
    expect(closeGitLeftView).toHaveBeenCalledTimes(1)
  })

  it('shows the recovery panel with the Host reason when Host reports rollback', async () => {
    const openGitLeftView = vi.fn().mockResolvedValue({ ok: true, fallback: 'legacy', reason: 'activation timed out' })
    const closeGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = {
      getZoomFactor: vi.fn().mockResolvedValue(1),
      openGitLeftView,
      updateGitLeftView: vi.fn().mockResolvedValue({ ok: true }),
      closeGitLeftView,
    } as unknown as typeof window.agentTeam

    const wrapper = shallowMount(GitPluginHostSlot, {
      props: { workspacePath: '/workspace', visible: true },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(openGitLeftView).toHaveBeenCalledTimes(1)
    const panel = wrapper.findComponent({ name: 'GitRecoveryPanel' })
    expect(panel.exists()).toBe(true)
    expect(panel.props('reason')).toBe('activation timed out')
    expect(wrapper.find('.git-plugin-host-slot__empty').exists()).toBe(false)
  })

  it('closes the old workspace before opening its replacement', async () => {
    const openGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    const closeGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = {
      getZoomFactor: vi.fn().mockResolvedValue(1),
      openGitLeftView,
      updateGitLeftView: vi.fn().mockResolvedValue({ ok: true }),
      closeGitLeftView,
    } as unknown as typeof window.agentTeam

    const wrapper = mount(GitPluginHostSlot, {
      props: { workspacePath: '/first', visible: true },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    await wrapper.setProps({ workspacePath: '/second' })
    await flushPromises()

    expect(closeGitLeftView).toHaveBeenCalledTimes(1)
    expect(openGitLeftView).toHaveBeenCalledTimes(2)
    expect(openGitLeftView).toHaveBeenLastCalledWith({
      workspace_path: '/second',
      bounds: { x: 100, y: 200, width: 400, height: 300 },
    })

    wrapper.unmount()
    await flushPromises()
    expect(closeGitLeftView).toHaveBeenCalledTimes(2)
  })

  it('hides the native view when the slot is display:none', async () => {
    const openGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    const updateGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = {
      getZoomFactor: vi.fn().mockResolvedValue(1),
      openGitLeftView,
      updateGitLeftView,
      closeGitLeftView: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as typeof window.agentTeam

    const wrapper = mount(GitPluginHostSlot, {
      props: { workspacePath: '/workspace', visible: true },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    currentRect = { x: 100, y: 200, width: 0, height: 0 }
    await wrapper.setProps({ visible: false })
    await flushPromises()

    expect(updateGitLeftView).toHaveBeenCalledWith({
      bounds: { x: 100, y: 200, width: 400, height: 300 },
      visible: false,
    })
  })

  it('enters a manual retry state for a failed open without geometry retry storms', async () => {
    let zoomChanged: (() => void) | undefined
    const openGitLeftView = vi.fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true })
    const getZoomFactor = vi.fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
    const closeGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    const onZoomChanged = vi.fn((callback: () => void) => {
      zoomChanged = callback
      return () => { zoomChanged = undefined }
    })
    window.agentTeam = {
      getZoomFactor,
      openGitLeftView,
      updateGitLeftView: vi.fn().mockResolvedValue({ ok: true }),
      closeGitLeftView,
      onZoomChanged,
    } as unknown as typeof window.agentTeam

    const wrapper = mount(GitPluginHostSlot, {
      props: { workspacePath: '/workspace', visible: true },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    expect(wrapper.find('.git-plugin-host-slot__error').exists()).toBe(true)
    expect(openGitLeftView).toHaveBeenCalledTimes(1)
    expect(getZoomFactor).toHaveBeenCalledTimes(1)

    currentRect = { x: 120, y: 220, width: 500, height: 350 }
    resizeCallback?.()
    window.dispatchEvent(new Event('scroll'))
    zoomChanged?.()
    await flushPromises()
    expect(openGitLeftView).toHaveBeenCalledTimes(1)
    expect(getZoomFactor).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ visible: false })
    await flushPromises()
    expect(openGitLeftView).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ visible: true })
    await flushPromises()
    expect(openGitLeftView).toHaveBeenCalledTimes(1)

    await wrapper.find('.git-plugin-host-slot__error button').trigger('click')
    await flushPromises()
    expect(getZoomFactor).toHaveBeenCalledTimes(2)
    expect(openGitLeftView).toHaveBeenCalledTimes(2)
    expect(openGitLeftView).toHaveBeenLastCalledWith({
      workspace_path: '/workspace',
      bounds: { x: 120, y: 220, width: 500, height: 350 },
    })
    expect(wrapper.find('.git-plugin-host-slot__error').exists()).toBe(false)

    wrapper.unmount()
    await flushPromises()
    expect(closeGitLeftView).toHaveBeenCalledTimes(1)
  })

  it('offers a way out when a zero-sized slot never opens a view', async () => {
    currentRect = { x: 0, y: 0, width: 0, height: 0 }
    const openGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = {
      getZoomFactor: vi.fn().mockResolvedValue(1),
      openGitLeftView,
      updateGitLeftView: vi.fn().mockResolvedValue({ ok: true }),
      closeGitLeftView: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as typeof window.agentTeam

    const wrapper = mount(GitPluginHostSlot, {
      props: { workspacePath: '/workspace', visible: true },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    // Geometry of zero makes `sync` return without opening anything and
    // without an error, so the panel would otherwise be blank under the bare
    // "Legacy recovery" label with nothing to click.
    expect(openGitLeftView).not.toHaveBeenCalled()
    expect(wrapper.find('.git-plugin-host-slot__error').text()).toContain(
      i18n.global.t('git.left-view-unavailable')
    )

    currentRect = { x: 120, y: 220, width: 500, height: 350 }
    await wrapper.find('.git-plugin-host-slot__error button').trigger('click')
    await flushPromises()

    expect(openGitLeftView).toHaveBeenCalledWith({
      workspace_path: '/workspace',
      bounds: { x: 120, y: 220, width: 500, height: 350 },
    })
    expect(wrapper.find('.git-plugin-host-slot__error').exists()).toBe(false)
    wrapper.unmount()
  })

  it('treats an update rejection as the same recoverable error state', async () => {
    const openGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    const updateGitLeftView = vi.fn().mockRejectedValue(new Error('view closed'))
    const closeGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = {
      getZoomFactor: vi.fn().mockResolvedValue(1),
      openGitLeftView,
      updateGitLeftView,
      closeGitLeftView,
    } as unknown as typeof window.agentTeam

    const wrapper = mount(GitPluginHostSlot, {
      props: { workspacePath: '/workspace', visible: true },
      global: { plugins: [i18n] },
    })
    await flushPromises()

    currentRect = { x: 120, y: 220, width: 500, height: 350 }
    resizeCallback?.()
    await flushPromises()

    expect(wrapper.find('.git-plugin-host-slot__error').exists()).toBe(true)
    expect(updateGitLeftView).toHaveBeenCalledTimes(1)
    expect(closeGitLeftView).toHaveBeenCalledTimes(1)

    resizeCallback?.()
    await wrapper.setProps({ visible: false })
    await flushPromises()
    expect(updateGitLeftView).toHaveBeenCalledTimes(1)

    wrapper.unmount()
    await flushPromises()
  })

  it('ignores a stale open completion when the workspace changes', async () => {
    let resolveFirst: ((result: { ok: boolean }) => void) | undefined
    const firstOpen = new Promise<{ ok: boolean }>((resolve) => { resolveFirst = resolve })
    const openGitLeftView = vi.fn()
      .mockReturnValueOnce(firstOpen)
      .mockResolvedValue({ ok: true })
    const closeGitLeftView = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = {
      getZoomFactor: vi.fn().mockResolvedValue(1),
      openGitLeftView,
      updateGitLeftView: vi.fn().mockResolvedValue({ ok: true }),
      closeGitLeftView,
    } as unknown as typeof window.agentTeam

    const wrapper = mount(GitPluginHostSlot, {
      props: { workspacePath: '/first', visible: true },
      global: { plugins: [i18n] },
    })
    await vi.waitFor(() => expect(openGitLeftView).toHaveBeenCalledTimes(1))

    await wrapper.setProps({ workspacePath: '/second' })
    resolveFirst?.({ ok: true })
    await vi.waitFor(() => expect(openGitLeftView).toHaveBeenLastCalledWith({
      workspace_path: '/second',
      bounds: { x: 100, y: 200, width: 400, height: 300 },
    }))

    expect(wrapper.find('.git-plugin-host-slot__error').exists()).toBe(false)

    wrapper.unmount()
    await flushPromises()
  })
})
