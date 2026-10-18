// @vitest-environment happy-dom
// NotifyPanel — the status-bar notifications popover: two switches bound to
// the same settings as Settings → Notifications, the permission status, and a
// way into that Settings page.
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import NotifyPanel from '../NotifyPanel.vue'

function mountPanel(props: Partial<{
  systemNotify: boolean
  notifySound: boolean
  permissionStatus: string
}> = {}): VueWrapper {
  return mount(NotifyPanel, {
    props: { systemNotify: true, notifySound: true, permissionStatus: 'granted', ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
}

describe('NotifyPanel', () => {
  let wrapper: VueWrapper | undefined
  const previousLocale = i18n.global.locale.value
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    i18n.global.locale.value = previousLocale
  })

  it('shows both switches in their current state', () => {
    wrapper = mountPanel({ systemNotify: true, notifySound: false })
    const switches = wrapper.findAll('[role="switch"]')
    expect(switches).toHaveLength(2)
    expect(switches[0].attributes('aria-checked')).toBe('true')
    expect(switches[1].attributes('aria-checked')).toBe('false')
  })

  it('asks to flip each setting on its own', async () => {
    wrapper = mountPanel({ systemNotify: true, notifySound: false })
    const switches = wrapper.findAll('[role="switch"]')
    await switches[0].trigger('click')
    await switches[1].trigger('click')
    expect(wrapper.emitted('update:systemNotify')).toEqual([[false]])
    expect(wrapper.emitted('update:notifySound')).toEqual([[true]])
  })

  it('links to Settings → Notifications', async () => {
    wrapper = mountPanel()
    await wrapper.get('[data-act="open-settings"]').trigger('click')
    expect(wrapper.emitted('open-settings')).toHaveLength(1)
  })

  it('shows the permission status, flagged when the system denied it', () => {
    i18n.global.locale.value = 'en-US'
    wrapper = mountPanel({ permissionStatus: 'denied' })
    const perm = wrapper.get('[data-row="permission"]')
    expect(perm.classes()).toContain('nt-denied')
    expect(perm.text()).toContain(i18n.global.t('settings.general.notify-permission-status.denied'))
  })

  it('hides the permission status where there is none', () => {
    wrapper = mountPanel({ permissionStatus: 'not-applicable' })
    expect(wrapper.find('[data-row="permission"]').exists()).toBe(false)
  })

  it('closes on Escape and on the close button', async () => {
    wrapper = mountPanel()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.get('[data-act="close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(2)
  })
})
