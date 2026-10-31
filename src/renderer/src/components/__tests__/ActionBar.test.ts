// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { registerCommand } from '@navide/plugin-ui/shared'
import { _resetRegistry } from '@navide/plugin-ui/shared/testing'
import ActionBar from '../ActionBar.vue'
import ActionButtonsSection from '../../layout/ActionButtonsSection.vue'
import { pluginCommands } from '../../lib/pluginCommands'
import { loadWorkbench, saveWorkbench, workbench } from '../../lib/workbench'
import { EMPTY_WORKBENCH } from '../../../../shared/workbench'

const global = { plugins: [i18n] }
const bar = () => mount(ActionBar, { global })
const button = (action: string, label = 'Open') => ({ id: action, label, steps: [{ action }] })
const set = (buttons: ReturnType<typeof button>[], hidden = false) => {
  workbench.value = { schemaVersion: 1, hidden, buttons }
}

beforeEach(() => {
  _resetRegistry()
  workbench.value = EMPTY_WORKBENCH
  pluginCommands.value = []
})
afterEach(() => { delete (window as unknown as { agentTeam?: unknown }).agentTeam })

describe('with no buttons', () => {
  it('renders nothing at all', () => {
    expect(bar().find('*').exists()).toBe(false)
    expect(bar().html()).toBe('<!--v-if-->')
  })

  it('stays empty when no file exists', async () => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = {
      readWorkbench: vi.fn().mockResolvedValue({ ok: true, content: '' }),
      onWorkbenchChanged: vi.fn(),
    }
    await loadWorkbench()
    expect(workbench.value).toEqual(EMPTY_WORKBENCH)
    expect(bar().html()).toBe('<!--v-if-->')
  })

  it('renders nothing when the bar is hidden', () => {
    registerCommand('a.b', () => {})
    set([button('a.b')], true)
    expect(bar().html()).toBe('<!--v-if-->')
  })
})

describe('a button', () => {
  it('runs its action when pressed', async () => {
    const run = vi.fn()
    registerCommand('a.b', run)
    set([button('a.b')])
    await bar().find('button').trigger('click')
    expect(run).toHaveBeenCalled()
  })

  it('is disabled and does nothing when its action is gone', async () => {
    set([button('gone.action')])
    const w = bar()
    expect(w.find('button').attributes('disabled')).toBeDefined()
    expect(w.find('button').attributes('title')).toBe("This action isn't available right now")
  })

  it('names its source', () => {
    registerCommand('a.b', () => {})
    registerCommand('acme.runner.go', () => {})
    pluginCommands.value = [{ commandId: 'acme.runner.go', title: 'Go', pluginId: 'acme.runner', pluginName: 'Runner' }]
    set([button('a.b'), button('acme.runner.go')])
    const [mine, plugin] = bar().findAll('button')
    expect(mine.attributes('title')).toBe('Added by you')
    expect(mine.find('.action-bar-mark').exists()).toBe(false)
    expect(plugin.attributes('title')).toBe('From Navide plugin Runner')
    expect(plugin.find('.action-bar-mark').exists()).toBe(true)
  })
})

describe('saveWorkbench', () => {
  it('goes back to what it had when the write fails', async () => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = {
      writeWorkbench: vi.fn().mockResolvedValue({ ok: false, error: 'disk full' }),
    }
    const result = await saveWorkbench({ schemaVersion: 1, hidden: false, buttons: [button('a.b')] })
    expect(result).toEqual({ ok: false, error: 'disk full' })
    expect(workbench.value).toEqual(EMPTY_WORKBENCH)
  })
})

describe('Settings > Layout', () => {
  const write = vi.fn().mockResolvedValue({ ok: true })
  beforeEach(() => {
    write.mockClear()
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { writeWorkbench: write }
    registerCommand('workbench.action.quickOpen', () => {})
    registerCommand('ui.window.openPlans', () => {})
    registerCommand('ui.window.close', () => {})
    registerCommand('ui.pane.sendKeys', () => {})
  })

  it('writes nothing until the user adds a button', () => {
    const w = mount(ActionButtonsSection, { global })
    expect(w.text()).toContain('No action buttons yet.')
    expect(write).not.toHaveBeenCalled()
  })

  it('offers no action ui_invoke keeps to its own tool, and no human-only prompt key', () => {
    const offered = mount(ActionButtonsSection, { global }).findAll('option').map((o) => o.attributes('value'))
    expect(offered).toContain('workbench.action.quickOpen')
    expect(offered).toContain('ui.window.openPlans')
    expect(offered).not.toContain('ui.window.close')
    expect(offered).not.toContain('ui.pane.sendKeys')
  })

  it('adds and removes a button', async () => {
    const w = mount(ActionButtonsSection, { global })
    await w.find('input.abs-name').setValue('Open file')
    await w.find('select').setValue('workbench.action.quickOpen')
    await w.find('form').trigger('submit')
    await vi.waitFor(() => expect(workbench.value.buttons).toHaveLength(1))
    expect(JSON.parse(write.mock.calls[0][0]).buttons[0]).toMatchObject({
      label: 'Open file', steps: [{ action: 'workbench.action.quickOpen' }],
    })
    await w.vm.$nextTick()
    await w.find('.abs-row button').trigger('click')
    await vi.waitFor(() => expect(workbench.value.buttons).toEqual([]))
  })
})
