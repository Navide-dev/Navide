// @vitest-environment happy-dom
// The pane header names the commander that dispatched the pane and Navide's
// detected state for it (0.2.51); either chip opens that commander's details.
// Same harness as TerminalPane.muteBadge.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'
import { resetCommandersForTest, useCommanders } from '../../composables/useCommanders'
import { commanderSummary, fakeBackend, node, tree } from '../../composables/__tests__/commanderFixtures'

const mockTerminal = vi.hoisted(() => ({ displayStatus: null as unknown as Ref<string> }))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  mockTerminal.displayStatus = ref('idle')
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      stopIneffective: { value: false },
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: mockTerminal.displayStatus,
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

function mountPane(paneId: string): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: { paneId, title: 'Test pane with a rather long name', terminalPort: createTerminalDockStub(), cliProfiles: {} },
    global: { mocks: { $t: (key: string) => key } }
  })
}

async function bindStore(): Promise<void> {
  useCommanders().bind(fakeBackend({
    'commander.list': { commanders: [commanderSummary()] },
    'commander.tree': tree('c1', [node('dev', 'waiting', { children: [node('test', 'stalled', { opened_by: 'dev' })] })]),
  }))
  await flushPromises()
}

describe('TerminalPane – commander chips', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    resetCommandersForTest()
  })

  it('shows nothing on a pane no commander dispatched', async () => {
    await bindStore()
    wrapper = mountPane('shell')
    expect(wrapper.find('[data-testid="commander-chip"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="commander-state-chip"]').exists()).toBe(false)
  })

  it('names the commander and the detected state, grandchildren included', async () => {
    await bindStore()
    wrapper = mountPane('test')
    expect(wrapper.find('[data-testid="commander-chip"]').text()).toBe('◎ Navide指揮')
    const state = wrapper.find('[data-testid="commander-state-chip"]')
    expect(state.text()).toBe('commander.state.stalled')
    expect(state.classes()).toContain('is-stalled')
  })

  it('sits right after the title, ahead of the header buttons', async () => {
    await bindStore()
    wrapper = mountPane('dev')
    const order = [...wrapper.find('.header-main').element.children].map((el) => el.className)
    const title = order.findIndex((c) => c.includes('title'))
    expect(order[title + 1]).toContain('commander-chip')
    expect(order[title + 2]).toContain('commander-state-chip')
  })

  it('opens the commander detail without focusing the pane', async () => {
    await bindStore()
    wrapper = mountPane('dev')
    await wrapper.find('[data-testid="commander-state-chip"]').trigger('click')
    expect(useCommanders().detailId.value).toBe('c1')
    expect(wrapper.emitted('set-focus')).toBeUndefined()
  })

  it('updates when the state changes', async () => {
    await bindStore()
    wrapper = mountPane('dev')
    const store = useCommanders()
    store.trees.value = { c1: tree('c1', [node('dev', 'reported')]) }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="commander-state-chip"]').text()).toBe('commander.state.reported')
  })
})
