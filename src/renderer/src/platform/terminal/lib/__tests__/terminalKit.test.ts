// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebglAddon } from '@xterm/addon-webgl'
import { NVTERM_PANES_KEY, nvtermRequestedFor, terminalKit } from '../terminalKit'

afterEach(() => {
  localStorage.removeItem(NVTERM_PANES_KEY)
  vi.unstubAllEnvs()
})

describe('terminalKit', () => {
  it('hands out the xterm.js classes themselves when no flag is set', () => {
    const kit = terminalKit('pane-1')
    expect(kit.nvterm).toBe(false)
    expect(kit.Terminal).toBe(Terminal)
    expect(kit.FitAddon).toBe(FitAddon)
    expect(kit.Unicode11Addon).toBe(Unicode11Addon)
    expect(kit.SerializeAddon).toBe(SerializeAddon)
    expect(kit.WebglAddon).toBe(WebglAddon)
  })

  it('builds only the named panes from nvterm in a development build', () => {
    vi.stubEnv('DEV', true)
    localStorage.setItem(NVTERM_PANES_KEY, 'pane-2, install')
    expect(terminalKit('pane-2').nvterm).toBe(true)
    expect(terminalKit('install').nvterm).toBe(true)
    expect(terminalKit('pane-3').nvterm).toBe(false)
    expect(terminalKit('pane-3').Terminal).toBe(Terminal)
  })

  it('accepts * for every pane', () => {
    vi.stubEnv('DEV', true)
    localStorage.setItem(NVTERM_PANES_KEY, '*')
    expect(nvtermRequestedFor('anything')).toBe(true)
  })

  it('ignores the flag outside development builds', () => {
    vi.stubEnv('DEV', false)
    localStorage.setItem(NVTERM_PANES_KEY, '*')
    expect(nvtermRequestedFor('pane-1')).toBe(false)
    expect(terminalKit('pane-1').Terminal).toBe(Terminal)
  })
})
