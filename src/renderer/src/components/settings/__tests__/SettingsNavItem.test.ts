// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsNavItem from '../SettingsNavItem.vue'

describe('SettingsNavItem', () => {
  it('shows no chevron on a row without pages', () => {
    const wrapper = mount(SettingsNavItem, { props: { label: 'General', active: true } })
    expect(wrapper.find('.settings-nav-item-chevron').exists()).toBe(false)
  })

  it('shows a folded chevron, and an open one with expanded state once its pages unfold', async () => {
    const wrapper = mount(SettingsNavItem, { props: { label: 'Navide Plugins', foldable: true } })
    expect(wrapper.get('.settings-nav-item-chevron').classes()).not.toContain('open')
    expect(wrapper.attributes('aria-expanded')).toBe('false')

    await wrapper.setProps({ active: true, expanded: true })
    expect(wrapper.get('.settings-nav-item-chevron').classes()).toContain('open')
    expect(wrapper.attributes('aria-expanded')).toBe('true')
    // The page row under it carries the selection, not this row.
    expect(wrapper.attributes('aria-current')).toBeUndefined()
  })
})
