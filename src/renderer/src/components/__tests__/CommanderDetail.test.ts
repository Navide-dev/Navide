// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import CommanderDetail from '../CommanderDetail.vue'
import { resetCommandersForTest, useCommanders } from '../../composables/useCommanders'
import { commanderSummary, fakeBackend, node, tree } from '../../composables/__tests__/commanderFixtures'

const t = i18n.global.t

async function open(extra: Record<string, unknown> = {}, dispatches = true) {
  const summary = commanderSummary({
    bindings: [{ kind: 'telegram', ref_id: 'b1', label: '@navide_bot', target: 'DM', paused: false }],
  })
  const children = !dispatches ? [] : [node('dev', 'working', { task: 'queue overflow', children: [node('test', 'stalled', { opened_by: 'dev' })] }), node('old', 'gone', { closed_at: 300 })]
  const backend = fakeBackend({
    'commander.list': { commanders: [summary] },
    'commander.tree': tree('c1', children),
    'commander.get': { commander: summary, memory: 'line one\nline two\n', tree: tree('c1', children) },
    ...extra,
  })
  const store = useCommanders()
  store.bind(backend)
  await flushPromises()
  store.openDetail('c1')
  const wrapper = mount(CommanderDetail, {
    props: { agentLabel: () => 'Claude Code', paneName: (id: string) => (id === 'body-1' ? 'Navide指揮' : id) },
    global: { plugins: [i18n], stubs: { teleport: true } },
  })
  await flushPromises()
  return { wrapper, store, backend }
}

describe('CommanderDetail', () => {
  afterEach(() => resetCommandersForTest())

  it('shows the identity, bindings and detected dispatch counts on the overview', async () => {
    const { wrapper } = await open()
    const text = wrapper.text()
    expect(text).toContain('Navide指揮')
    expect(text).toContain(t('commander.detail.model-default'))
    expect(text).toContain('@navide_bot')
    expect(text).toContain(t('commander.detail.memory-size', { count: 2 }))
    expect(text).toContain(`${t('commander.state.working')} 1`)
    expect(text).toContain(`${t('commander.state.stalled')} 1`)
  })

  it('draws the open dispatches as a tree and raises a stall banner', async () => {
    const { wrapper } = await open()
    await wrapper.find('[data-tab="tree"]').trigger('click')
    const rows = wrapper.findAll('[data-testid="commander-tree-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[1].text()).toContain(t('commander.detail.dispatched-by', { name: 'dev' }))
    expect(wrapper.findAll('[data-testid="commander-stall"]')).toHaveLength(1)
    await rows[0].find('button').trigger('click')
    expect(wrapper.emitted('focus-pane')?.[0]).toEqual(['dev'])
  })

  it('keeps closed dispatches in the log', async () => {
    const { wrapper } = await open()
    await wrapper.find('[data-tab="log"]').trigger('click')
    expect(wrapper.text()).toContain('old')
  })

  it('saves an edited duty through commander.update', async () => {
    const { wrapper, backend } = await open({ 'commander.update': { commander: commanderSummary({ duty: 'Ship 0.2.51' }) } })
    await wrapper.find('[data-tab="duty"]').trigger('click')
    await wrapper.find('textarea').setValue('Ship 0.2.51')
    await wrapper.find('[data-testid="commander-save-duty"]').trigger('click')
    await flushPromises()
    expect(backend.sent.find((s) => s.type === 'commander.update')?.payload).toEqual({ id: 'c1', changes: { duty: 'Ship 0.2.51' } })
    expect(wrapper.text()).toContain(t('commander.detail.saved'))
  })

  it('asks twice before downgrading, then closes', async () => {
    const { wrapper, store, backend } = await open({ 'commander.downgrade': { id: 'c1' } })
    const button = () => wrapper.find('[data-testid="commander-downgrade"]')
    await button().trigger('click')
    await flushPromises()
    expect(backend.sent.some((s) => s.type === 'commander.downgrade')).toBe(false)
    expect(button().text()).toBe(t('commander.detail.confirm-again'))
    await button().trigger('click')
    await flushPromises()
    expect(backend.sent.some((s) => s.type === 'commander.downgrade')).toBe(true)
    expect(store.detailId.value).toBe('')
  })

  it('heads the page with the most urgent dispatch, or standing by when there is none', async () => {
    const busy = await open()
    expect(busy.wrapper.find('[data-testid="commander-head-state"]').text()).toBe(t('commander.state.stalled'))
    busy.wrapper.unmount()
    resetCommandersForTest()
    const quiet = await open({}, false)
    expect(quiet.wrapper.find('[data-testid="commander-head-state"]').text()).toBe(t('commander.detail.standby'))
  })

  it('opens the body pane and closes on Escape', async () => {
    const { wrapper, store } = await open()
    await wrapper.find('[data-testid="commander-open-pane"]').trigger('click')
    expect(wrapper.emitted('focus-pane')?.[0]).toEqual(['body-1'])
    await wrapper.find('[data-testid="commander-detail"]').trigger('keydown', { key: 'Escape' })
    expect(store.detailId.value).toBe('')
  })
})
