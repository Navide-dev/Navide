// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createCommanderStore, dispatchedNodes, resetCommandersForTest, useCommanders } from '../useCommanders'
import { commanderSummary, fakeBackend, node, tree } from './commanderFixtures'

function listing() {
  return fakeBackend({
    'commander.list': { commanders: [commanderSummary()] },
    'commander.tree': tree('c1', [
      node('dev', 'working', { children: [node('test', 'stalled', { opened_by: 'dev' })] }),
      node('old', 'gone', { closed_at: 200 }),
    ]),
  })
}

describe('useCommanders', () => {
  afterEach(() => resetCommandersForTest())

  it('loads the list and every tree once bound', async () => {
    const store = createCommanderStore()
    const backend = listing()
    store.bind(backend)
    await flushPromises()
    expect(store.commanders.value.map((c) => c.id)).toEqual(['c1'])
    expect(dispatchedNodes(store.trees.value.c1).map((n) => n.pane_id)).toEqual(['dev', 'test', 'old'])
    expect(backend.sent.map((s) => s.type)).toEqual(['commander.list', 'commander.tree'])
    store.unbind()
  })

  it('marks dispatched open panes with their commander and state, and the body separately', async () => {
    const store = createCommanderStore()
    store.bind(listing())
    await flushPromises()
    expect(store.paneMarks.value.get('test')).toMatchObject({ commanderId: 'c1', commanderName: 'Navide指揮', state: 'stalled' })
    expect(store.paneMarks.value.get('dev')?.state).toBe('working')
    // A closed dispatch is history, not a live mark.
    expect(store.paneMarks.value.has('old')).toBe(false)
    expect(store.paneMarks.value.has('body-1')).toBe(false)
    expect(store.bodyPanes.value.get('body-1')).toBe('c1')
    store.unbind()
  })

  it('follows commander.changed: updates in place and drops an archived one', async () => {
    const store = createCommanderStore()
    const backend = listing()
    store.bind(backend)
    await flushPromises()
    store.openDetail('c1')
    backend.emit('commander.changed', { id: 'c1', commander: commanderSummary({ duty: 'new duty' }) })
    expect(store.byId('c1')?.duty).toBe('new duty')
    backend.emit('commander.changed', { id: 'c1', commander: null })
    expect(store.commanders.value).toEqual([])
    expect(store.trees.value.c1).toBeUndefined()
    expect(store.detailId.value).toBe('')
    store.unbind()
  })

  it('reloads a tree when a stall is broadcast', async () => {
    const store = createCommanderStore()
    const backend = listing()
    store.bind(backend)
    await flushPromises()
    backend.sent.length = 0
    backend.emit('commander.stall', { commander_id: 'c1', pane_id: 'test', state: 'stalled' })
    await flushPromises()
    expect(backend.sent).toEqual([{ type: 'commander.tree', payload: { id: 'c1' } }])
    store.unbind()
  })

  it('upgrades a pane with the contract payload and applies the answer', async () => {
    const store = createCommanderStore()
    const backend = fakeBackend({
      'commander.list': { commanders: [] },
      'commander.tree': tree('c2', []),
      'commander.upgrade_pane': { commander: commanderSummary({ id: 'c2', name: 'AWS指揮' }) },
    })
    store.bind(backend)
    await flushPromises()
    const made = await store.upgradePane('pane-9', { name: 'AWS指揮', agent_key: 'codex' })
    expect(made?.id).toBe('c2')
    expect(backend.sent.find((s) => s.type === 'commander.upgrade_pane')?.payload)
      .toEqual({ name: 'AWS指揮', agent_key: 'codex', pane_id: 'pane-9' })
    expect(store.byId('c2')?.name).toBe('AWS指揮')
    store.unbind()
  })

  it('reports a refused mutation in opError and leaves the list alone', async () => {
    const store = createCommanderStore()
    const backend = fakeBackend({
      'commander.list': { commanders: [commanderSummary()] },
      'commander.tree': tree('c1', []),
      'commander.archive': new Error('only a Navide main window may do this'),
    })
    store.bind(backend)
    await flushPromises()
    expect(await store.archive('c1')).toBe(false)
    expect(store.opError.value).toContain('main window')
    expect(store.commanders.value).toHaveLength(1)
    store.unbind()
  })

  it('downgrade removes the commander once the backend answers', async () => {
    const store = createCommanderStore()
    store.bind(fakeBackend({
      'commander.list': { commanders: [commanderSummary()] },
      'commander.tree': tree('c1', []),
      'commander.downgrade': { id: 'c1' },
    }))
    await flushPromises()
    expect(await store.downgrade('c1')).toBe(true)
    expect(store.commanders.value).toEqual([])
    store.unbind()
  })

  it('useCommanders shares one store per renderer', () => {
    expect(useCommanders()).toBe(useCommanders())
  })
})
