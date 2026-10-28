// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import StaleConfigNotice from '../StaleConfigNotice.vue'
import { staleConfigKey, type StaleConfigActions, type StaleConfigPane } from '../../lib/staleConfigPanes'

function mountNotice(part: 'mcp' | 'skills', panes: StaleConfigPane[]) {
  const actions: StaleConfigActions = { panes: () => panes, rebuild: vi.fn(), rebuildAllIdle: vi.fn() }
  const wrapper = mount(StaleConfigNotice, {
    props: { part },
    global: { plugins: [i18n], provide: { [staleConfigKey as symbol]: actions } },
  })
  return { wrapper, actions }
}

const pane = (id: string, parts: StaleConfigPane['parts'], busy = false, canRebuild = true): StaleConfigPane =>
  ({ id, name: `name-${id}`, parts, busy, canRebuild })

describe('StaleConfigNotice', () => {
  it('lists only the panes stale for its own part', () => {
    const { wrapper } = mountNotice('mcp', [pane('a', ['mcp']), pane('b', ['skills']), pane('c', ['mcp', 'skills'])])
    expect(wrapper.findAll('li').map((li) => li.attributes('data-pane-id'))).toEqual(['a', 'c'])
  })

  it('renders nothing when no pane is stale, or outside a window that provides the list', () => {
    expect(mountNotice('skills', [pane('a', ['mcp'])]).wrapper.find('[data-testid="stale-config-notice"]').exists()).toBe(false)
    const bare = mount(StaleConfigNotice, { props: { part: 'mcp' }, global: { plugins: [i18n] } })
    expect(bare.find('[data-testid="stale-config-notice"]').exists()).toBe(false)
  })

  it('rebuilds one pane on its own button and leaves the choice of running panes to the user', async () => {
    const { wrapper, actions } = mountNotice('mcp', [pane('idle', ['mcp']), pane('running', ['mcp'], true)])
    const buttons = wrapper.findAll('[data-testid="stale-config-rebuild"]')
    await buttons[1].trigger('click')
    expect(actions.rebuild).toHaveBeenCalledWith('running')
    expect(wrapper.find('[data-testid="stale-config-rebuild-idle"]').text()).toContain('1')
    await wrapper.find('[data-testid="stale-config-rebuild-idle"]').trigger('click')
    expect(actions.rebuildAllIdle).toHaveBeenCalledTimes(1)
  })

  it('disables "rebuild all idle" when every stale pane is running', () => {
    const { wrapper } = mountNotice('skills', [pane('running', ['skills'], true)])
    expect(wrapper.find('[data-testid="stale-config-rebuild-idle"]').attributes('disabled')).toBeDefined()
  })
})
