import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_IDS, executeCommand, listCommands, registerCommand, reviewImportedRules } from '@navide/plugin-ui/shared'
import { _resetRegistry } from '@navide/plugin-ui/shared/testing'
import {
  isPluginCommand,
  isPluginShapedCommand,
  pluginCommands,
  syncPluginCommands,
} from '../pluginCommands'

const entry = (commandId: string) => ({ commandId, title: 'Run', pluginId: 'acme.runner', pluginName: 'Runner' })

beforeEach(() => {
  _resetRegistry()
  pluginCommands.value = []
})

describe('syncPluginCommands', () => {
  it('registers nothing and lists nothing when no plugin declares a command', () => {
    registerCommand('ui.pane.close', () => {})
    syncPluginCommands([], () => {})
    expect(listCommands()).toEqual(['ui.pane.close'])
    expect(pluginCommands.value).toEqual([])
  })

  it('runs a command from the key path', () => {
    const run = vi.fn()
    syncPluginCommands([entry('acme.runner.go')], run)
    expect(executeCommand('acme.runner.go')).toBe(true)
    expect(run).toHaveBeenCalledWith('acme.runner.go')
  })

  it('drops a disabled plugin from ui_list_actions and leaves the built-in list alone', () => {
    registerCommand('ui.pane.close', () => {})
    registerCommand('workbench.action.quickOpen', () => {})
    const builtIn = listCommands()
    syncPluginCommands([entry('acme.runner.go')], () => {})
    expect(listCommands()).toEqual([...builtIn, 'acme.runner.go'])

    syncPluginCommands([], () => {})
    expect(listCommands()).toEqual(builtIn)
    expect(isPluginCommand('acme.runner.go')).toBe(false)
  })

  it('leaves out an id the Host owns, and the Host handler keeps running', () => {
    const host = vi.fn()
    registerCommand('acme.runner.go', host)
    syncPluginCommands([entry('acme.runner.go')], () => { throw new Error('the plugin must not run') })
    expect(pluginCommands.value).toEqual([])
    executeCommand('acme.runner.go')
    expect(host).toHaveBeenCalled()
  })
})

describe('isPluginShapedCommand', () => {
  it.each(['acme.runner.go', 'acme.a.b.go'])('accepts %s', (id) => expect(isPluginShapedCommand(id)).toBe(true))
  it.each(['nope', 'acme.go', 'workbench.action.quickOpen', 'ui.pane.close', 'navide.plans.open', 'controlPane.x.y'])(
    'refuses %s', (id) => expect(isPluginShapedCommand(id)).toBe(false))
})

// A difference from before plugin commands existed: with no plugin installed, an
// unknown id of this shape used to be rejected on import. It is kept now, so a
// file exported with a plugin installed survives a machine without it.
describe('importing shortcuts with no plugin installed', () => {
  const file = (command: string) => JSON.stringify([{ key: 'cmd+alt+t', command }])

  it('keeps an unknown id shaped like a plugin command, and names it', () => {
    const report = reviewImportedRules(file('gone.runner.go'), COMMAND_IDS, isPluginShapedCommand)
    expect(report.rules).toEqual([{ key: 'cmd+alt+t', command: 'gone.runner.go' }])
    expect(report.rejected).toEqual([])
    expect(report.deferred).toEqual(['gone.runner.go'])
  })

  it.each(['nope', 'gone.go', 'workbench.action.nope', 'ui.pane.nope', 'navide.plans.nope'])(
    'still rejects %s', (command) => {
      const report = reviewImportedRules(file(command), COMMAND_IDS, isPluginShapedCommand)
      expect(report.rules).toEqual([])
      expect(report.rejected).toEqual([`#1: unknown command "${command}"`])
    })
})
