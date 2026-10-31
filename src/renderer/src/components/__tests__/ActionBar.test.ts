// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { registerCommand } from '@navide/plugin-ui/shared'
import { _resetRegistry } from '@navide/plugin-ui/shared/testing'
import ActionBar from '../ActionBar.vue'
import ActionButtonsSection from '../../layout/ActionButtonsSection.vue'
import { pluginCommands } from '../../lib/pluginCommands'
import { isDestructiveButton, loadWorkbench, runWorkbenchButton, saveWorkbench, workbench } from '../../lib/workbench'
import { EMPTY_WORKBENCH } from '../../../../shared/workbench'

const confirm = vi.hoisted(() => vi.fn())
vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNotify: () => ({ confirm, toast: vi.fn() }),
}))

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
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
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
    expect(mine.attributes('title')).toContain('Added by you')
    expect(mine.find('.action-bar-mark').exists()).toBe(false)
    expect(plugin.attributes('title')).toBe('From Navide plugin Runner — Go')
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

describe('a button with several steps', () => {
  const group = (...actions: string[]) => ({ id: 'g', label: 'Group', steps: actions.map((action) => ({ action })) })

  it('runs them in order, waiting for each', async () => {
    const order: string[] = []
    registerCommand('a.one', async () => { await Promise.resolve(); order.push('one') })
    registerCommand('a.two', () => { order.push('two') })
    expect(await runWorkbenchButton(group('a.one', 'a.two'))).toBeNull()
    expect(order).toEqual(['one', 'two'])
  })

  it('stops at the step that fails', async () => {
    const later = vi.fn()
    registerCommand('a.one', () => { throw new Error('nope') })
    registerCommand('a.two', later)
    expect(await runWorkbenchButton(group('a.one', 'a.two'))).toEqual({ failedAt: 0, error: 'nope' })
    expect(later).not.toHaveBeenCalled()
  })

  it('stops at an action that is gone', async () => {
    expect((await runWorkbenchButton(group('gone.action')))?.failedAt).toBe(0)
  })

  it('counts as destructive if any step is', () => {
    expect(isDestructiveButton(group('a.one', 'ui.pane.close'))).toBe(true)
    expect(isDestructiveButton(group('a.one'))).toBe(false)
  })
})

describe('a button that closes something', () => {
  const pressWith = async (answer: boolean) => {
    confirm.mockReset().mockResolvedValue(answer)
    const run = vi.fn()
    registerCommand('ui.pane.close', run)
    set([button('ui.pane.close')])
    await bar().find('button').trigger('click')
    await vi.waitFor(() => expect(confirm).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve))
    return run
  }

  it('asks first and does nothing on no', async () => {
    expect(await pressWith(false)).not.toHaveBeenCalled()
  })

  it('runs on yes', async () => {
    expect(await pressWith(true)).toHaveBeenCalled()
  })
})

describe('a harmless button', () => {
  it('asks nothing', async () => {
    confirm.mockReset()
    const run = vi.fn()
    registerCommand('a.b', run)
    set([button('a.b')])
    await bar().find('button').trigger('click')
    await vi.waitFor(() => expect(run).toHaveBeenCalled())
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('building a group in Settings', () => {
  it('saves the steps in order, counting the one still in the picker', async () => {
    const write = vi.fn().mockResolvedValue({ ok: true })
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { writeWorkbench: write }
    registerCommand('workbench.action.quickOpen', () => {})
    registerCommand('ui.window.openPlans', () => {})
    const w = mount(ActionButtonsSection, { global })
    await w.find('input.abs-name').setValue('Morning')
    await w.find('select').setValue('workbench.action.quickOpen')
    await w.findAll('.abs-add button')[0].trigger('click')
    expect(w.findAll('.abs-step')).toHaveLength(1)
    await w.find('select').setValue('ui.window.openPlans')
    await w.find('form').trigger('submit')
    await vi.waitFor(() => expect(workbench.value.buttons).toHaveLength(1))
    expect(workbench.value.buttons[0].steps).toEqual([
      { action: 'workbench.action.quickOpen' },
      { action: 'ui.window.openPlans' },
    ])
  })
})

describe('a workbench.json edited outside Settings', () => {
  it.each(['ui.settings.yolo', 'ui.pane.sendKeys', 'ui.window.close', 'ui.pane.close', 'workbench.action.closeWindow'])(
    'cannot run %s from a button', async (action) => {
      const run = vi.fn()
      registerCommand(action, run)
      set([button(action, 'Open Plans')])
      const w = bar()
      expect(w.find('button').attributes('disabled')).toBeDefined()
      expect(await runWorkbenchButton(button(action))).toMatchObject({ failedAt: 0 })
      expect(run).not.toHaveBeenCalled()
    })

  it('stops a group before its first step when a later step is forbidden', async () => {
    const first = vi.fn()
    registerCommand('a.b', first)
    registerCommand('ui.settings.yolo', () => {})
    const group = { id: 'g', label: 'G', steps: [{ action: 'a.b' }, { action: 'ui.settings.yolo' }] }
    expect(await runWorkbenchButton(group)).toMatchObject({ failedAt: 1 })
    expect(first).not.toHaveBeenCalled()
  })

  it('shows the real action, whatever the label says', () => {
    registerCommand('workbench.action.quickOpen', () => {})
    set([button('workbench.action.quickOpen', 'Open Plans')])
    expect(bar().find('button').attributes('title')).toContain('Quick Open File')
  })
})
