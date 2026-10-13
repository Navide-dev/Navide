// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { describe, expect, it } from 'vitest'
import StageTabBar, { type TabItem } from '../StageTabBar.vue'

const tabs: TabItem[] = [{ key: 'feature', label: 'Feature', count: 8, live: 3, type: 'stage', status: 'active' }]

function mountBar(props: {
  allFamiliesCollapsed?: boolean
  familyToggleDisabledReason?: 'grid' | 'empty'
} = {}) {
  return mount(StageTabBar, {
    props: { tabs, modelValue: 'feature', canRebuildAll: true, ...props },
    global: { plugins: [i18n] },
  })
}

describe('StageTabBar family toggle', () => {
  it('places the native button immediately after refresh and keeps existing actions working', async () => {
    const wrapper = mountBar()
    const refresh = wrapper.get('.tab-rebuild-all-btn')
    const toggle = wrapper.get('.tab-family-toggle-btn')
    expect(refresh.element.previousElementSibling).toBe(wrapper.get('.tab-add-btn').element)
    expect(refresh.element.nextElementSibling).toBe(toggle.element)
    expect(toggle.element.tagName).toBe('BUTTON')
    expect(toggle.attributes('type')).toBe('button')
    await wrapper.get('.tab-add-btn').trigger('click')
    await refresh.trigger('click')
    await toggle.trigger('click')
    expect(wrapper.emitted('add')).toEqual([[]])
    expect(wrapper.emitted('rebuild-all')).toEqual([[]])
    expect(wrapper.emitted('toggleFamilies')).toEqual([[]])
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  })

  it('shows the next family action and triangle without changing the tab count', async () => {
    const wrapper = mountBar()
    const toggle = wrapper.get('.tab-family-toggle-btn')
    expect(toggle.text()).toBe('▾')
    expect(toggle.attributes('title')).toBe(i18n.global.t('stageTab.collapse-families'))
    expect(toggle.attributes('aria-label')).toBe(toggle.attributes('title'))
    expect(toggle.attributes('aria-expanded')).toBe('true')
    await wrapper.setProps({ allFamiliesCollapsed: true })
    expect(toggle.text()).toBe('▸')
    expect(toggle.attributes('title')).toBe(i18n.global.t('stageTab.expand-families'))
    expect(toggle.attributes('aria-label')).toBe(toggle.attributes('title'))
    expect(toggle.attributes('aria-expanded')).toBe('false')
    // Live / total, the same tally the sidebar's workspace heading shows.
    expect(wrapper.get('.tab-count').text()).toBe('3 / 8')
  })

  it.each(['grid', 'empty'] as const)('disables unavailable %s folding with an accessible explanation', async reason => {
    const wrapper = mountBar({ familyToggleDisabledReason: reason })
    const toggle = wrapper.get('.tab-family-toggle-btn')
    expect(toggle.attributes('disabled')).toBeDefined()
    expect(toggle.attributes('title')).toBe(i18n.global.t(`stageTab.family-toggle-${reason}`))
    expect(toggle.attributes('aria-label')).toBe(toggle.attributes('title'))
    await toggle.trigger('click')
    expect(wrapper.emitted('toggleFamilies')).toBeUndefined()
    await wrapper.setProps({ familyToggleDisabledReason: undefined })
    expect(toggle.attributes('disabled')).toBeUndefined()
    await toggle.trigger('click')
    expect(wrapper.emitted('toggleFamilies')).toEqual([[]])
  })
})
