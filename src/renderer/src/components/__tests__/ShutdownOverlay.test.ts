// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ShutdownOverlay from '../ShutdownOverlay.vue'

const mountOverlay = (stage: 'saving' | 'stopping' | 'closing' | null) =>
  mount(ShutdownOverlay, {
    props: { stage },
    global: { mocks: { $t: (key: string) => key } },
  })

describe('ShutdownOverlay', () => {
  it('renders nothing while the app is running', () => {
    const wrapper = mountOverlay(null)
    expect(wrapper.find('.shutdown-overlay').exists()).toBe(false)
    wrapper.unmount()
  })

  it('covers the window and names the stage once main starts quitting', () => {
    const wrapper = mountOverlay('stopping')

    const overlay = wrapper.get('.shutdown-overlay')
    // Announced, not silent: the stage line is the only thing telling the user
    // the app is busy rather than hung.
    expect(overlay.attributes('role')).toBe('status')
    expect(overlay.attributes('aria-live')).toBe('polite')
    expect(wrapper.get('.shutdown-title').text()).toBe('shutdown.title')
    expect(wrapper.get('.shutdown-stage').text()).toBe('shutdown.stopping')
    expect(wrapper.find('.shutdown-spinner').exists()).toBe(true)
    wrapper.unmount()
  })

  it('carries the same mark as the first-boot screen', () => {
    // Leaving is the other end of arriving, and arriving has the logo. A bare
    // spinner on a white field is any program's dialog.
    const wrapper = mountOverlay('stopping')

    const logo = wrapper.get('.shutdown-logo')
    expect(logo.attributes('src')).toContain('navide-mark')
    expect(logo.attributes('alt')).toBe('Navide')
    wrapper.unmount()
  })

  it('follows main through the stages', async () => {
    const wrapper = mountOverlay('saving')
    expect(wrapper.get('.shutdown-stage').text()).toBe('shutdown.saving')

    await wrapper.setProps({ stage: 'stopping' })
    expect(wrapper.get('.shutdown-stage').text()).toBe('shutdown.stopping')

    await wrapper.setProps({ stage: 'closing' })
    expect(wrapper.get('.shutdown-stage').text()).toBe('shutdown.closing')
    wrapper.unmount()
  })

  // The tests above mock $t, so a missing key would still render. Tie the keys
  // the component asks for to the ones that actually ship.
  it.each(['zh-TW', 'en-US'])('has copy for every stage in %s', (locale) => {
    const messages = JSON.parse(
      readFileSync(
        resolve(`src/renderer/src/i18n/locales/${locale}.json`),
        'utf8'
      )
    ) as { shutdown?: Record<string, string> }
    expect(Object.keys(messages.shutdown ?? {}).sort()).toEqual([
      'closing',
      'saving',
      'stopping',
      'title',
    ])
    for (const value of Object.values(messages.shutdown ?? {})) expect(value).not.toBe('')
  })
})
