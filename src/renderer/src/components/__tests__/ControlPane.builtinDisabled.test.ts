// @vitest-environment happy-dom
// A built-in Navide plugin the user disabled takes its sidebar tab and its
// shortcuts with it; Enable brings both back without a reload.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import ControlPane from '../ControlPane.vue'
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
  existingProject: null,
} as unknown as Record<string, unknown>

function tabIds(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.sidebar-tabs .tab-btn').map((button) => button.attributes('data-tab') ?? '')
}

describe('ControlPane – disabled built-in Navide plugins', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    delete (window as unknown as Record<string, unknown>).agentTeam
  })

  it('hides the Git and Plans tabs and declines their shortcuts until they are enabled', async () => {
    let disabled = ['navide.git', 'navide.plans']
    let contributionsChanged: (() => void) | undefined
    ;(window as unknown as Record<string, unknown>).agentTeam = {
      plugins: {
        disabledBuiltins: vi.fn(async () => disabled),
        onContributionsChanged: (handler: () => void) => {
          contributionsChanged = handler
          return () => undefined
        },
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wrapper = shallowMount(ControlPane as any, {
      props: minimalProps,
      global: { mocks: { $t: (key: string) => key } },
    })
    await flushPromises()

    expect(tabIds(wrapper)).not.toContain('git')
    expect(tabIds(wrapper)).not.toContain('plans')
    expect(tabIds(wrapper)).toContain('explorer')
    // Declined, so the key passes through instead of being swallowed.
    expect(executeCommand('controlPane.selectSidebarTab4')).toBe(false)
    expect(executeCommand('controlPane.selectSidebarTab5')).toBe(false)
    expect(executeCommand('workbench.action.focusSourceControl')).toBe(false)

    disabled = []
    contributionsChanged?.()
    await flushPromises()
    expect(tabIds(wrapper)).toContain('git')
    expect(tabIds(wrapper)).toContain('plans')
    expect(executeCommand('controlPane.selectSidebarTab5')).toBe(true)
  })
})
