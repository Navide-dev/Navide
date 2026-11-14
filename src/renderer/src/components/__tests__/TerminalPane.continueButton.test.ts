// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// Coverage for the continue button: a pane brought back by --resume parks at its
// prompt with nothing telling it to carry on, so the button appears there and
// only there. It must stay hidden for every other quiet pane — a finished turn
// is not an interruption — and retire the moment the user takes over. Clicking
// emits 'continue-resume'; App.vue owns the injection and the flag.
// useTerminal is mocked out (same setup as TerminalPane.loginBadge.test.ts).

const mockTerminal = vi.hoisted(() => ({
  displayStatus: null as unknown as Ref<string>,
  awaitingKind: null as unknown as Ref<string | null>,
  lastUserKeyAt: null as unknown as Ref<number>,
  optionSelectHint: null as unknown as Ref<boolean>
}))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  mockTerminal.displayStatus = ref('idle')
  mockTerminal.awaitingKind = ref(null)
  mockTerminal.lastUserKeyAt = ref(0)
  mockTerminal.optionSelectHint = ref(false)
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      stopIneffective: { value: false },
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: mockTerminal.displayStatus,
      awaitingKind: mockTerminal.awaitingKind,
      lastUserKeyAt: mockTerminal.lastUserKeyAt,
      optionSelectHint: mockTerminal.optionSelectHint,
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

function tMock(key: string): string {
  return key
}

function mountPane(props: Record<string, unknown>): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(TerminalPane as any, {
    props: {
      paneId: 'pane-1',
      title: 'Claude',
      terminalPort: createTerminalDockStub(),
      cliProfiles: {},
      ...props,
    },
    global: { mocks: { $t: tMock } }
  })
}

describe('TerminalPane – continue button', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    mockTerminal.displayStatus.value = 'idle'
    mockTerminal.lastUserKeyAt.value = 0
    mockTerminal.optionSelectHint.value = false
  })

  it('stays hidden on an ordinary idle pane', () => {
    wrapper = mountPane({})
    expect(wrapper.find('.continue-btn').exists()).toBe(false)
  })

  it('appears on a pane restored via --resume', () => {
    wrapper = mountPane({ continueAvailable: true })
    expect(wrapper.find('.continue-btn').exists()).toBe(true)
  })

  it('emits continue-resume when clicked', async () => {
    wrapper = mountPane({ continueAvailable: true })
    await wrapper.find('.continue-btn').trigger('click')
    expect(wrapper.emitted('continue-resume')).toHaveLength(1)
  })

  it('disappears once the flag is cleared (the injection landed)', async () => {
    wrapper = mountPane({ continueAvailable: true })
    expect(wrapper.find('.continue-btn').exists()).toBe(true)
    await wrapper.setProps({ continueAvailable: false })
    expect(wrapper.find('.continue-btn').exists()).toBe(false)
  })

  it('retires for good once the user types into the pane', async () => {
    wrapper = mountPane({ continueAvailable: true })
    expect(wrapper.find('.continue-btn').exists()).toBe(true)
    mockTerminal.lastUserKeyAt.value = Date.now()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.continue-btn').exists()).toBe(false)
  })

  it('stays hidden while a loop is already driving the pane', () => {
    wrapper = mountPane({ continueAvailable: true, loopActive: true })
    expect(wrapper.find('.continue-btn').exists()).toBe(false)
  })

  it('stays hidden while the restore is still in flight', () => {
    wrapper = mountPane({ continueAvailable: true, restoring: true })
    expect(wrapper.find('.continue-btn').exists()).toBe(false)
  })

  it.each(['running', 'starting', 'exited', 'error', 'stopped', 'awaiting'])(
    'stays hidden while the pane is %s',
    async (status) => {
      wrapper = mountPane({ continueAvailable: true })
      mockTerminal.displayStatus.value = status
      await wrapper.vm.$nextTick()
      expect(wrapper.find('.continue-btn').exists()).toBe(false)
    }
  )

  it('lifts the select hint out of the corner it shares with the button', async () => {
    wrapper = mountPane({ continueAvailable: true })
    mockTerminal.optionSelectHint.value = true
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.select-hint').classes()).toContain('hint-raised')

    await wrapper.setProps({ continueAvailable: false })
    expect(wrapper.find('.select-hint').classes()).not.toContain('hint-raised')
  })
})
