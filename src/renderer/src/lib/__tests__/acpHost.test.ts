import { describe, expect, it, vi } from 'vitest'
import { createAcpHost, type AcpHostPane, type AcpPaneApi } from '../acpHost'

function setup(pane: AcpHostPane | undefined = { id: 'p1', agentKey: 'opencode', workspacePath: '/work' }) {
  const deps = {
    port: { send: vi.fn(), on: vi.fn(() => () => {}) },
    pane: vi.fn((id: string) => (pane && pane.id === id ? pane : undefined)),
    started: vi.fn(),
    stopLoop: vi.fn(),
    persistPaneStopped: vi.fn(),
  }
  const host = createAcpHost(deps as never)
  const api: AcpPaneApi = {
    spawn: vi.fn(async () => {}),
    kill: vi.fn(async () => {}),
    interrupt: vi.fn(async () => true),
    status: 'running',
    displayStatus: 'idle',
    setStopped: vi.fn(),
  }
  return { host, deps, api }
}

describe('createAcpHost', () => {
  it('owns only panes that asked for ACP and may have it', () => {
    const { host } = setup()

    expect(host.owns('p1')).toBe(false)
    expect(host.claim('p1', { agentKey: 'opencode' })).toBe(false) // no display: the TUI
    expect(host.claim('p1', { display: 'tui', agentKey: 'opencode' })).toBe(false)
    expect(host.claim('p1', { display: 'acp', agentKey: 'terminal' })).toBe(false)
    expect(host.claim('p1', { display: 'acp', agentKey: 'opencode', isLogin: true })).toBe(false)
    expect(host.claim('p1', { display: 'acp', agentKey: 'opencode', loginProfileId: 'x' })).toBe(false)
    expect(host.owns('p1')).toBe(false)

    expect(host.claim('p1', { display: 'acp', agentKey: 'opencode' })).toBe(true)
    expect(host.owns('p1')).toBe(true)
  })

  it('stops owning a pane once its record is gone', () => {
    let present = true
    const { host, deps } = setup()
    deps.pane.mockImplementation((id: string) => (present && id === 'p1' ? { id, agentKey: 'opencode' } : undefined))
    host.claim('p1', { display: 'acp', agentKey: 'opencode' })

    present = false
    expect(host.owns('p1')).toBe(false)
  })

  it('starts the agent in the pane folder and reports whether it came up', async () => {
    const { host, deps, api } = setup()
    host.claim('p1', { display: 'acp', agentKey: 'opencode' })
    host.setRef('p1', api)

    expect(await host.start('p1', { workspacePath: '/work', agentKey: 'opencode' })).toBe('p1')
    expect(api.spawn).toHaveBeenCalledWith({ cwd: '/work', agentKey: 'opencode' })
    expect(deps.started).toHaveBeenCalledWith('p1', true)
  })

  it('reports a failed start too', async () => {
    const { host, deps, api } = setup()
    host.setRef('p1', { ...api, status: 'error' })

    await host.start('p1', { agentKey: 'opencode' })
    expect(deps.started).toHaveBeenCalledWith('p1', false)
  })

  it('interrupts like a terminal pane: stops the loop unless kept, then marks the pane stopped', async () => {
    const { host, deps, api } = setup()
    host.setRef('p1', api)

    expect(await host.interrupt('p1')).toBe(true)
    expect(deps.stopLoop).toHaveBeenCalledWith('p1')
    expect(deps.persistPaneStopped).toHaveBeenCalledWith('p1', true)

    deps.stopLoop.mockClear()
    await host.interrupt('p1', { keepLoop: true })
    expect(deps.stopLoop).not.toHaveBeenCalled()
  })

  it('kills through the pane and never throws', async () => {
    const { host, api } = setup()
    host.setRef('p1', { ...api, kill: vi.fn(async () => { throw new Error('gone') }) })

    await expect(host.kill('p1', { force: true })).resolves.toBeUndefined()
    await expect(host.kill('nobody')).resolves.toBeUndefined()
  })

  it('answers the messaging gate from the pane state, and refuses delivery until the backend delivers', async () => {
    const { host, api } = setup()
    host.setRef('p1', api)

    expect(host.holdKey('p1')).toBeNull()
    host.setRef('p1', { ...api, displayStatus: 'running' })
    expect(host.holdKey('p1')).toBe('mid-turn')
    expect(host.holdKey('unknown')).toBe('starting')
    expect(await host.deliver('p1', 'hello')).toMatchObject({ failed: expect.anything() })
  })
})
