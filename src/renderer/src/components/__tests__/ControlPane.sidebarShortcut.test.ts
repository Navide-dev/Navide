// @vitest-environment happy-dom
// Cmd+1..4 core sidebar-tab switching.
//
// These used to be a bare `document.addEventListener('keydown')` inside
// ControlPane, outside the keybinding system — which meant Settings could
// neither list nor rebind them, and unbinding Cmd+1 there still left the
// listener switching tabs. They are ordinary commands now
// (`controlPane.selectSidebarTab1..3`, bound in defaults.ts under
// `paneStage && !editorOpen`), so this drives them through the real
// capture-phase dispatcher instead of dispatching on `document`.
//
// Every behavioural guarantee from the old listener is still asserted here:
// bare Cmd must not blank the panel, out-of-range digits and Cmd+Shift+<n> must
// be ignored, and the shortcut must not fire while a text field has focus.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { shallowMount, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import ControlPane from '../ControlPane.vue'
import { useKeybindings, setContext } from '@navide/plugin-ui/shared'
import { _resetKeybindingsState, _resetRegistry } from '@navide/plugin-ui/shared/testing'
import { executeCommand } from '@navide/plugin-ui/shared'

const minimalProps = {
  backendStatus: 'connected',
  backendUrl: '',
  agentSpecs: [],
  roles: [],
  stages: [],
  panes: [],
  pipeline: { state: 'idle' },
  yoloEnabled: false,
  analyzerModel: '',
  analyzerStatus: {},
  autoAnswerEnabled: false,
  existingProject: null
} as unknown as Record<string, unknown>

/** Hosts the shared capture-phase dispatcher the real app installs in App.vue. */
const Dispatcher = defineComponent({
  setup() {
    useKeybindings()
    return () => h('div')
  },
})

function keydown(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

// The tab id, not the title: the title is composed from a locale key and this
// file stubs $t to echo keys, so asserting on its text would assert against the
// stub rather than against which tab the shortcut actually selected.
function activeTabId(wrapper: VueWrapper): string | null {
  const active = wrapper.findAll('.sidebar-tabs .tab-btn')
    .find((button) => button.classes().includes('active'))
  return active?.attributes('data-tab') ?? null
}

describe('ControlPane – Cmd+number sidebar shortcut', () => {
  let wrapper: VueWrapper
  let dispatcher: VueWrapper

  beforeEach(() => {
    _resetRegistry()
    _resetKeybindingsState()
    sessionStorage.setItem('agentTeam.sidebarTab', 'explorer')
    dispatcher = mount(Dispatcher)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: minimalProps,
      global: { mocks: { $t: (key: string) => key } }
    })
    // The main window is the only one that sets this; the rules are scoped to it.
    setContext('paneStage', true)
    setContext('editorOpen', false)
  })

  afterEach(() => {
    wrapper.unmount()
    dispatcher.unmount()
    sessionStorage.clear()
  })

  it('starts on the explorer tab', () => {
    expect(activeTabId(wrapper)).toBe('explorer')
  })

  it('bare Cmd (key=Meta) does NOT change or blank the tab', async () => {
    keydown({ key: 'Meta', metaKey: true })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('explorer')
  })

  it('Cmd+4 is ignored when no plugin contribution owns that slot', async () => {
    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('explorer')
  })

  it('Cmd+4 selects navide.git rather than the first left contribution', async () => {
    wrapper.unmount()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: {
        ...minimalProps,
        pluginContributions: [
          {
            pluginId: 'acme.files', packageVersion: '1.0.0', contributionKey: 'acme.files.left',
            title: 'Files', icon: null, kind: 'custom', location: 'left', manifestOrder: 0,
          },
          {
            pluginId: 'navide.git', packageVersion: '1.0.0', contributionKey: 'navide.git.left',
            title: 'Git', icon: null, kind: 'custom', location: 'left', manifestOrder: 0,
          },
        ],
      },
      global: { mocks: { $t: (key: string) => key } },
    })

    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('git')
  })

  it('Cmd+5 opens the retained Plans tab', async () => {
    keydown({ key: '5', metaKey: true, code: 'Digit5' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('plans')
  })

  it('Cmd+1 switches to the agents tab', async () => {
    keydown({ key: '1', metaKey: true, code: 'Digit1' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('agents')
  })

  it('Cmd+3 switches back to the explorer tab', async () => {
    keydown({ key: '3', metaKey: true, code: 'Digit3' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('explorer')
  })

  it('Cmd+6 opens the Commanders tab', async () => {
    keydown({ key: '6', metaKey: true, code: 'Digit6' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('commanders')
  })

  it('out-of-range Cmd+7 is ignored', async () => {
    keydown({ key: '7', metaKey: true, code: 'Digit7' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('explorer')
  })

  it('Cmd+Shift+3 is ignored (modifier guard keeps the OS screenshot binding free)', async () => {
    keydown({ key: '3', metaKey: true, shiftKey: true, code: 'Digit3' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('explorer')
  })

  it('does not fire while a text field has focus', async () => {
    // The central dispatcher does not look at e.target, so this guard lives in
    // the command handler. Losing it would hijack Cmd+4 while typing.
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('explorer')

    input.remove()
  })

  it('still fires from the xterm helper textarea, which is not real text entry', async () => {
    const ta = document.createElement('textarea')
    ta.className = 'xterm-helper-textarea'
    document.body.appendChild(ta)
    ta.focus()

    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('explorer')

    ta.remove()
  })

  it('is scoped to the main window: no paneStage, no tab switch', async () => {
    setContext('paneStage', false)
    keydown({ key: '4', metaKey: true, code: 'Digit4' })
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('explorer')
  })

  it('Cmd+Shift+G selects navide.git rather than the first left contribution', async () => {
    wrapper.unmount()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: {
        ...minimalProps,
        pluginContributions: [
          {
            pluginId: 'acme.files', packageVersion: '1.0.0', contributionKey: 'acme.files.left',
            title: 'Files', icon: null, kind: 'custom', location: 'left', manifestOrder: 0,
          },
          {
            pluginId: 'navide.git', packageVersion: '1.0.0', contributionKey: 'navide.git.left',
            title: 'Git', icon: null, kind: 'custom', location: 'left', manifestOrder: 0,
          },
        ],
      },
      global: { mocks: { $t: (key: string) => key } },
    })

    executeCommand('workbench.action.focusSourceControl')
    await wrapper.vm.$nextTick()
    expect(activeTabId(wrapper)).toBe('git')
  })
})
