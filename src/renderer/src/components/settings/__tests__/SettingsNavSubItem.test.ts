// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsNavSubItem from '../SettingsNavSubItem.vue'

describe('SettingsNavSubItem', () => {
  it('shows no marker without one', () => {
    const wrapper = mount(SettingsNavSubItem, { props: { label: 'Execution Policy' } })
    expect(wrapper.find('.settings-nav-subitem-marker').exists()).toBe(false)
  })

  it("shows the page's marker with what it stands for as its accessible name", () => {
    const wrapper = mount(SettingsNavSubItem, {
      props: { label: 'Execution Policy', marker: { text: '⚠', tone: 'risk', label: 'Effective policy: Stale' } },
    })
    const marker = wrapper.get('.settings-nav-subitem-marker')
    expect(marker.text()).toBe('⚠')
    expect(marker.classes()).toContain('settings-nav-subitem-marker--risk')
    expect(marker.attributes('role')).toBe('img')
    expect(marker.attributes('aria-label')).toBe('Effective policy: Stale')
    expect(marker.attributes('title')).toBe('Effective policy: Stale')
  })
})
