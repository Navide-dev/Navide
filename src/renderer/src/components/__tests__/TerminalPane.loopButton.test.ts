// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { Ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { formatLoopTime } from '../../lib/loopPrompt'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

// Coverage for the loop launch button: the LOOP badge renders only while
// loopActive is set and is the only off-switch (while the loop runs the ∞
// button just hosts the picker for one-shot skills), clicking emits
// 'toggle-loop' (App.vue owns the injection/clear logic), and the button is
// hidden once the pane's CLI has exited. useTerminal is mocked out — no xterm instance, no backend traffic
// (same setup as TerminalPane.cliContextDrag.test.ts).

const mockTerminal = vi.hoisted(() => ({ displayStatus: null as unknown as Ref<string> }))

// Two castable skills: the default (loop) one and a one-shot one.
const mockSkills = vi.hoisted(() => ({ list: null as unknown as Ref<Array<Record<string, unknown>>> }))
vi.mock('../../composables/usePromptSkills', async () => {
  const { ref } = await import('vue')
  const skill = (id: string, isDefault: boolean) => ({
    id, name: id, icon: 'infinity', description: '', prompt: id, resumePrompt: '',
    maxTurns: 0, category: '', enabled: true, isDefault,
  })
  mockSkills.list = ref([skill('advance', true), skill('review', false)])
  return { usePromptSkills: () => ({ skills: mockSkills.list, save: vi.fn() }) }
})

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  const actual = await importOriginal<typeof import('@navide/terminal')>()
  mockTerminal.displayStatus = ref('idle')
  return {
    ...actual,
    useTerminal: () => ({
      mount: vi.fn(),
      pasteText: vi.fn(),
      updateXtermTheme: vi.fn(),
      setDisableStdin: vi.fn(),
      displayStatus: mockTerminal.displayStatus,
      sessionId: { value: '' },
      isAltBuffer: ref(false)
    })
  }
})

// Real locale messages for the badge-text keys so the time-rendering tests
// assert actual visible output (incl. the "~" estimate marker); other keys
// fall back to the key itself, matching the earlier tests' expectations.
const badgeMessages: Record<string, string> = {
  'pane.terminal.loop-badge-estimate': '∞ Loop · ~{time}',
  'pane.terminal.loop-badge-resume': '∞ resumes {time}'
}

function tMock(key: string, params?: Record<string, unknown>): string {
  let msg = badgeMessages[key] ?? key
  for (const [k, v] of Object.entries(params ?? {})) msg = msg.replace(`{${k}}`, String(v))
  return msg
}

/** Same formatter the component uses — computing the expectation from the
 *  epoch keeps assertions timezone-independent. */
const expectedTime = formatLoopTime

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

describe('TerminalPane – loop launch button', () => {
  let wrapper: VueWrapper

  afterEach(() => {
    wrapper.unmount()
    mockTerminal.displayStatus.value = 'idle'
  })

  it('renders the LOOP badge when loopActive is true and not when false', async () => {
    wrapper = mountPane({ loopActive: true })
    expect(wrapper.find('.loop-inline').exists()).toBe(true)

    await wrapper.setProps({ loopActive: false })
    expect(wrapper.find('.loop-inline').exists()).toBe(false)
  })

  it('emits toggle-loop when the loop button is clicked', async () => {
    wrapper = mountPane({})
    await wrapper.find('.loop-btn').trigger('click')
    expect(wrapper.emitted('toggle-loop')).toHaveLength(1)
  })

  it('hides the loop button when displayStatus is exited', () => {
    mockTerminal.displayStatus.value = 'exited'
    wrapper = mountPane({})
    expect(wrapper.find('.loop-btn').exists()).toBe(false)
  })

  it('keeps the loop button beside the badge while the loop is active', () => {
    wrapper = mountPane({ loopActive: true })
    expect(wrapper.find('.loop-btn').exists()).toBe(true)
    expect(wrapper.find('.loop-inline').exists()).toBe(true)
  })

  it('does not turn the loop off when the ∞ button is clicked while the loop runs', async () => {
    wrapper = mountPane({ loopActive: true })
    await wrapper.find('.loop-btn').trigger('click')
    expect(wrapper.emitted('toggle-loop')).toBeUndefined()
  })

  it('offers only the one-shot skills while the loop runs', async () => {
    wrapper = mountPane({ loopActive: true })
    const picker = wrapper.findComponent({ name: 'PromptSkillPicker' })
    expect((picker.props('skills') as Array<{ id: string }>).map((s) => s.id)).toEqual(['review'])

    await wrapper.setProps({ loopActive: false })
    expect((picker.props('skills') as Array<{ id: string }>).map((s) => s.id)).toEqual(['advance', 'review'])
  })

  it('hides the loop button while the loop runs when the default skill is the only one', async () => {
    const all = mockSkills.list.value
    mockSkills.list.value = all.filter((s) => s.isDefault)
    try {
      wrapper = mountPane({ loopActive: true })
      expect(wrapper.find('.loop-btn').exists()).toBe(false)
      await wrapper.setProps({ loopActive: false })
      expect(wrapper.find('.loop-btn').exists()).toBe(true)
    } finally {
      mockSkills.list.value = all
    }
  })

  it('shows the dimmed waiting badge variant while a session-limit auto-resume is pending', async () => {
    wrapper = mountPane({ loopActive: true, loopWaitUntil: Date.now() + 3600_000 })
    expect(wrapper.find('.loop-inline').classes()).toContain('waiting')

    await wrapper.setProps({ loopWaitUntil: null })
    expect(wrapper.find('.loop-inline').classes()).not.toContain('waiting')
  })

  it('says the estimate is the weekly reset when it is one', () => {
    wrapper = mountPane({ loopActive: true, loopEstimateResetAt: Date.now() + 3600_000, loopEstimateWeekly: true })
    expect(wrapper.find('.loop-inline').attributes('title')).toContain('pane.terminal.loop-estimate-weekly-tooltip')
  })

  it('renders the ~HH:mm estimate on the running badge when loopEstimateResetAt is set', () => {
    const estimateAt = 1_800_000_000_000 // fixed epoch; expectation derived via the same formatter
    wrapper = mountPane({ loopActive: true, loopEstimateResetAt: estimateAt })
    const badge = wrapper.find('.loop-inline')
    expect(badge.text()).toContain('~')
    expect(badge.text()).toContain(expectedTime(estimateAt))
  })

  it('renders the accurate resume time on the waiting badge and emits loop-resume-now on click', async () => {
    const waitUntil = 1_800_000_000_000
    wrapper = mountPane({ loopActive: true, loopWaitUntil: waitUntil })
    const badge = wrapper.find('.loop-inline')
    expect(badge.text()).toContain(expectedTime(waitUntil))
    expect(badge.attributes('role')).toBe('button')

    await badge.trigger('click')
    expect(wrapper.emitted('loop-resume-now')).toHaveLength(1)
    expect(wrapper.emitted('toggle-loop')).toBeUndefined()
  })

  it('emits toggle-loop (off) when the running (non-waiting) badge is clicked', async () => {
    wrapper = mountPane({ loopActive: true, loopEstimateResetAt: Date.now() + 3600_000 })
    await wrapper.find('.loop-inline').trigger('click')
    expect(wrapper.emitted('toggle-loop')).toHaveLength(1)
    expect(wrapper.emitted('loop-resume-now')).toBeUndefined()
  })
})
