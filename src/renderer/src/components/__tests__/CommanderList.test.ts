// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import CommanderList from '../CommanderList.vue'
import { resetCommandersForTest, useCommanders } from '../../composables/useCommanders'
import { commanderSummary, fakeBackend, node, tree } from '../../composables/__tests__/commanderFixtures'

const t = i18n.global.t

async function mountList(panes = [{ id: 'dev', name: 'dev' }, { id: 'body-1', name: 'Navide指揮' }, { id: 'shell', name: 'shell' }]) {
  const store = useCommanders()
  store.bind(fakeBackend({
    'commander.list': { commanders: [commanderSummary(), commanderSummary({ id: 'c2', name: 'AWS指揮', body: null, body_live: false })] },
    'commander.tree': (p: Record<string, unknown>) => p.id === 'c1'
      ? tree('c1', [node('dev', 'working', { children: [node('test', 'stalled', { opened_by: 'dev' })] })])
      : tree('c2', []),
  }))
  await flushPromises()
  const wrapper = mount(CommanderList, {
    props: { panes, agentLabel: (k: string) => (k === 'claude' ? 'Claude Code' : k) },
    global: { plugins: [i18n] },
  })
  return { wrapper, store }
}

describe('CommanderList', () => {
  afterEach(() => resetCommandersForTest())

  it('lists each commander with its CLI and how many dispatched panes are open', async () => {
    const { wrapper } = await mountList()
    const items = wrapper.findAll('[data-testid="commander-item"]')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('Navide指揮')
    expect(items[0].text()).toContain(t('commander.list.sub-working', { agent: 'Claude Code', count: 2 }))
    expect(items[1].text()).toContain(t('commander.list.sub-no-body', { agent: 'Claude Code' }))
  })

  it('shows the dispatch tree with detected state chips, nested panes included', async () => {
    const { wrapper } = await mountList()
    const children = wrapper.findAll('[data-testid="commander-child"]')
    expect(children.map((c) => c.find('.cmd-child-name').text())).toEqual(['dev', 'test'])
    expect(children[0].find('.cmd-state-chip').text()).toBe(t('commander.state.working'))
    expect(children[1].find('.cmd-state-chip').classes()).toContain('is-stalled')
  })

  it('lists panes no commander owns, leaving out bodies and dispatched panes', async () => {
    const { wrapper } = await mountList()
    expect(wrapper.findAll('[data-testid="commander-unassigned"]').map((r) => r.text())).toEqual(['shell'])
  })

  it('opens the detail on a commander and focuses a pane on a child', async () => {
    const { wrapper, store } = await mountList()
    await wrapper.find('[data-testid="commander-item"] .cmd-row').trigger('click')
    expect(store.detailId.value).toBe('c1')
    await wrapper.find('[data-testid="commander-child"]').trigger('click')
    expect(wrapper.emitted('focus-pane')?.[0]).toEqual(['dev'])
  })

  it('opens the create dialog from the new button', async () => {
    const { wrapper, store } = await mountList()
    await wrapper.find('[data-testid="commander-new"]').trigger('click')
    expect(store.createOpen.value).toBe(true)
    expect(store.createPaneId.value).toBe('')
  })
})
