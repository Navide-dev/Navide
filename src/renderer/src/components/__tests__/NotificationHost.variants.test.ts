// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { useNotify } from '@navide/plugin-ui/foundation'
import NotificationHost from '../NotificationHost.vue'

function clear(): void {
  const { toasts, dismissToast } = useNotify()
  for (const t of [...toasts.value]) dismissToast(t.id)
}

describe('NotificationHost toast variants', () => {
  afterEach(() => {
    clear()
    document.body.innerHTML = ''
  })

  it('renders plain info / success / error toasts exactly as before', async () => {
    const wrapper = mount(NotificationHost, { attachTo: document.body })
    useNotify().toast('a', { type: 'info' })
    useNotify().toast('b', { type: 'success' })
    useNotify().toast('c', { type: 'error' })
    await flushPromises()
    const toasts = Array.from(document.querySelectorAll('.toast'))
    expect(toasts.map((el) => el.className)).toEqual(['toast info', 'toast success', 'toast error'])
    expect(toasts.map((el) => el.querySelector('.toast-icon')?.textContent)).toEqual(['ℹ', '✓', '✕'])
    expect(toasts.map((el) => el.children.length)).toEqual([2, 2, 2])
    expect(document.querySelector('.toast-band')).toBeNull()
    wrapper.unmount()
  })

  it('renders an external toast as a solid band with its title and icon', async () => {
    const wrapper = mount(NotificationHost, { attachTo: document.body })
    useNotify().toast('Message from telegram:alice delivered to “notify”', {
      variant: 'external', title: 'Telegram · alice', icon: '✉', duration: 8000,
    })
    await flushPromises()
    const el = document.querySelector('.toast')!
    expect(el.classList.contains('external')).toBe(true)
    expect(el.querySelector('.toast-band')?.textContent?.trim()).toBe('✉ Telegram · alice')
    expect(el.querySelector('.toast-icon')?.textContent).toBe('✉')
    expect(el.querySelector('.toast-msg')?.textContent).toBe('Message from telegram:alice delivered to “notify”')
    wrapper.unmount()
  })

  it('renders a channel toast with its header band, framed but without the external fill', async () => {
    const wrapper = mount(NotificationHost, { attachTo: document.body })
    useNotify().toast('Message from telegram:alice delivered to “notify”', {
      variant: 'channel', title: 'External channel · Telegram · alice', icon: '✉', duration: 8000,
    })
    await flushPromises()
    const el = document.querySelector('.toast')!
    expect(el.className).toBe('toast info channel titled')
    expect(el.querySelector('.toast-band')?.textContent?.trim()).toBe('✉ External channel · Telegram · alice')
    expect(el.querySelector('.toast-icon')?.textContent).toBe('✉')
    expect(el.querySelector('.toast-msg')?.textContent).toBe('Message from telegram:alice delivered to “notify”')
    wrapper.unmount()
  })

  it('renders a workspace toast with its source header', async () => {
    const wrapper = mount(NotificationHost, { attachTo: document.body })
    useNotify().toast('Instruction from another workspace', { variant: 'workspace', title: 'Other workspace · navide-web', icon: '⇆' })
    await flushPromises()
    const el = document.querySelector('.toast')!
    expect(el.className).toBe('toast info workspace titled')
    expect(el.querySelector('.toast-band')?.textContent?.trim()).toBe('⇆ Other workspace · navide-web')
    wrapper.unmount()
  })

  it('renders a security toast with the shield icon and no header', async () => {
    const wrapper = mount(NotificationHost, { attachTo: document.body })
    useNotify().toast('Navide Guard blocked an action', { type: 'error', variant: 'security', duration: 8000 })
    await flushPromises()
    const el = document.querySelector('.toast')!
    expect(el.className).toBe('toast error security')
    expect(el.querySelector('.toast-icon svg')).not.toBeNull()
    expect(el.querySelector('.toast-band')).toBeNull()
    wrapper.unmount()
  })
})
