// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import TerminalPane from '../TerminalPane.vue'
import { cliRiskKey, type CliRiskContext } from '../../composables/useResourceUsage'
import { riskState } from '../../composables/__tests__/fixtures/cliRisk'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'

vi.mock('@navide/terminal', async (importOriginal) => {
  const { ref } = await import('vue')
  return {
    ...await importOriginal<typeof import('@navide/terminal')>(),
    useTerminal: () => ({
      mount: vi.fn(), updateXtermTheme: vi.fn(), setDisableStdin: vi.fn(),
      displayStatus: ref('idle'), sessionId: ref('session-a'), isAltBuffer: ref(false), stopIneffective: ref(false),
    }),
  }
})

const wrappers: VueWrapper[] = []
afterEach(() => {
  wrappers.forEach((wrapper) => wrapper.unmount())
  wrappers.length = 0
})

function mountPane(context?: CliRiskContext, props = {}): VueWrapper {
  const wrapper = mount(TerminalPane, {
    props: { paneId: 'pane-a', title: 'CLI', terminalPort: createTerminalDockStub(), cliProfiles: {} as never, onScreen: true, ...props },
    global: {
      mocks: { $t: (key: string) => key },
      provide: context ? { [cliRiskKey as symbol]: context } : {},
      stubs: { PromptSkillPicker: true },
    },
  })
  wrappers.push(wrapper)
  return wrapper
}

function context(): CliRiskContext {
  return {
    cliRisksByPaneId: ref(new Map([['pane-a', riskState()], ['pane-b', riskState()]])),
    cliRisksAvailable: ref(true),
    paneIdByKey: ref(new Map()),
    actOnCliRisk: vi.fn().mockResolvedValue({ ok: true, payload: { cliRisks: {} }, error: null }),
  }
}

describe('TerminalPane CLI risk integration', () => {
  it('keeps the existing header empty of risk UI without a provided projection', () => {
    expect(mountPane().find('.cli-risk-inline').exists()).toBe(false)
  })

  it('places one compact risk pill after login/quota pills and before status', () => {
    const wrapper = mountPane(context(), { loginExpired: true, usageLimitHit: true })
    const pills = [...wrapper.get('.header-main').element.children]
    const risk = wrapper.get('.cli-risk-inline')
    expect(pills.indexOf(risk.element)).toBe(pills.indexOf(wrapper.get('.usage-limit-inline').element) + 1)
    expect(pills.indexOf(risk.element)).toBeLessThan(pills.indexOf(wrapper.get('.status').element))
    expect(risk.classes()).toContain('compact')
  })

  it('updates all affected mounted panes from the shared projection', async () => {
    const shared = context()
    const a = mountPane(shared)
    const b = mountPane(shared, { paneId: 'pane-b' })
    expect(a.find('.cli-risk-inline').exists()).toBe(true)
    expect(b.find('.cli-risk-inline').exists()).toBe(true)
    shared.cliRisksByPaneId.value = new Map([['pane-a', riskState([])], ['pane-b', riskState([])]])
    await nextTick()
    expect(a.find('.cli-risk-inline').exists()).toBe(false)
    expect(b.find('.cli-risk-inline').exists()).toBe(false)
  })

  it('does not show risks while a restored pane is still a placeholder', async () => {
    const wrapper = mountPane(context(), { restoring: true })
    expect(wrapper.find('.cli-risk-inline').exists()).toBe(false)
    await wrapper.setProps({ restoring: false })
    expect(wrapper.find('.cli-risk-inline').exists()).toBe(true)
  })

  it('uses the backend pane identity after a terminal reattaches under a new renderer id', async () => {
    const shared = context()
    shared.paneIdByKey.value.set('session-a', 'pane-a')
    const wrapper = mountPane(shared, { paneId: 'new-renderer-pane' })
    await wrapper.get('.cli-risk-inline').trigger('click')
    await flushPromises()
    const buttons = document.querySelectorAll<HTMLButtonElement>('.cli-risk-actions button')
    buttons[0].click()
    await flushPromises()
    expect(shared.actOnCliRisk).toHaveBeenCalledExactlyOnceWith('pane-a', riskState().signals[0].id, 'ignore')
  })

  it('removes an open popover when its pane leaves the visible page', async () => {
    const wrapper = mountPane(context())
    await wrapper.get('.cli-risk-inline').trigger('click')
    await flushPromises()
    expect(document.querySelector('.cli-risk-pop')).not.toBeNull()
    await wrapper.setProps({ onScreen: false })
    expect(document.querySelector('.cli-risk-pop')).toBeNull()
  })
})
