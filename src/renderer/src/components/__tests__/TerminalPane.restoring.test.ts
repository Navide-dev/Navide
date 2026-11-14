// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

const mockTerminal = vi.hoisted(() => ({
  displayStatus: null as unknown as Ref<string>,
  onFirstOutput: undefined as (() => void) | undefined,
}))

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  return {
    ...actual,
    useTerminal: (
      _paneId: string,
      _backend: unknown,
      options?: { onFirstOutput?: () => void },
    ) => {
      mockTerminal.displayStatus = ref('starting')
      mockTerminal.onFirstOutput = options?.onFirstOutput
      return {
        mount: vi.fn(),
        stopIneffective: { value: false },
        updateXtermTheme: vi.fn(),
        setDisableStdin: vi.fn(),
        displayStatus: mockTerminal.displayStatus,
        sessionId: ref(''),
        isAltBuffer: ref(false),
      }
    },
  }
})

function mountPane(): VueWrapper {
  return mount(TerminalPane, {
    props: {
      paneId: 'restored-pane',
      title: 'Claude',
      subtitle: 'Architect',
      terminalPort: createTerminalDockStub(),
      cliProfiles: {} as never,
      restoring: true,
    },
    global: {
      mocks: {
        $t: (key: string) => ({
          'pane.terminal.resuming': 'Resuming…',
          'pane.terminal.minimize-tooltip': 'Minimize',
        })[key] ?? key,
      },
    },
  })
}

describe('TerminalPane restored-session startup', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper?.unmount()
    mockTerminal.onFirstOutput = undefined
  })

  it('keeps the placeholder overlay until first output is reported', async () => {
    wrapper = mountPane()

    expect(wrapper.find('.restoring-overlay').exists()).toBe(true)
    expect(wrapper.text()).toContain('Resuming…')

    mockTerminal.onFirstOutput?.()
    expect(wrapper.emitted('first-output')).toHaveLength(1)

    await wrapper.setProps({ restoring: false })
    expect(wrapper.find('.restoring-overlay').exists()).toBe(false)
  })

  it('does not cover terminal errors while waiting for output', async () => {
    wrapper = mountPane()

    mockTerminal.displayStatus.value = 'error'
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.restoring-overlay').exists()).toBe(false)
  })
})
