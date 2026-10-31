// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import PaneAccountBar from '../accounts/PaneAccountBar.vue'

function mountBar(backAt: string | null, switchOffered = true) {
  return mount(PaneAccountBar, { props: { backAt, switchOffered }, global: { plugins: [i18n] } })
}

describe('PaneAccountBar', () => {
  it('says when the quota comes back', () => {
    expect(mountBar('14:30').text()).toContain('14:30')
  })

  it('says so when the reset time is unknown', () => {
    expect(mountBar(null).text()).toContain(i18n.global.t('settings.accounts.api-keys.pane.back-unknown'))
  })

  it('offers switching only when the app does', async () => {
    expect(mountBar('14:30', false).find('[data-testid="pane-account-bar-switch"]').exists()).toBe(false)
    const w = mountBar('14:30')
    await w.get('[data-testid="pane-account-bar-switch"]').trigger('click')
    expect(w.emitted('switch-account')).toHaveLength(1)
  })

  it('stays closed after waiting, and returns for a new reset time', async () => {
    const w = mountBar('14:30')
    await w.findAll('button').at(-1)!.trigger('click')
    expect(w.find('[data-testid="pane-account-bar"]').exists()).toBe(false)
    await w.setProps({ backAt: '19:30' })
    expect(w.find('[data-testid="pane-account-bar"]').exists()).toBe(true)
  })
})
