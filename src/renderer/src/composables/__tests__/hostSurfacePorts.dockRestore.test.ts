// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockBackend } from './mockBackend'

// An embedded AI panel (AiCliDock) whose PTY did not survive an app quit asks
// the host port for its restore record, and resumes the session it names.
describe('Host terminal dock adapter — panel restore record', () => {
  it('asks the backend for the panel record and returns its agent and session', async () => {
    const { terminalPort, sent, setResponse } = createMockBackend()
    setResponse('terminal.dock_record', { record: { agent: 'codex', session_id: 's-1' } })
    await expect(terminalPort.readDockRestore!('/ws', 'pane-1')).resolves.toEqual({ agentKey: 'codex', sessionId: 's-1' })
    expect(sent).toEqual([{ type: 'terminal.dock_record', payload: { workspace_path: '/ws', pane_id: 'pane-1' }, timeoutMs: undefined }])
  })

  it('returns null when there is no record', async () => {
    const { terminalPort, setResponse } = createMockBackend()
    setResponse('terminal.dock_record', { record: null })
    await expect(terminalPort.readDockRestore!('/ws', 'pane-1')).resolves.toBeNull()
  })

  it('returns null when the backend refuses (an older backend has no such handler)', async () => {
    const { terminalPort, setResponse } = createMockBackend()
    setResponse('terminal.dock_record', null, { ok: false, error: { code: 'UNKNOWN_TYPE', message: 'no' } })
    await expect(terminalPort.readDockRestore!('/ws', 'pane-1')).resolves.toBeNull()
  })
})

// A restored panel whose surface's built-in plugin is gone (neither installed
// nor a built-in fallback) must not resume: the record is retired instead.
describe('Host terminal dock adapter — panel whose plugin is gone', () => {
  afterEach(() => {
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  function stubProvided(provided: boolean): ReturnType<typeof vi.fn> {
    const ask = vi.fn(async () => provided)
    ;(window as unknown as { agentTeam: unknown }).agentTeam = { dockSurfaceProvided: ask }
    return ask
  }

  it('retires the record when main says no plugin provides the surface', async () => {
    const ask = stubProvided(false)
    const { terminalPort, sent } = createMockBackend()
    await expect(terminalPort.dockSurfaceRetired!('/ws', 'pane-1', 'git')).resolves.toBe(true)
    expect(ask).toHaveBeenCalledWith('git')
    expect(sent).toEqual([{
      type: 'terminal.dock_retire',
      payload: { workspace_path: '/ws', pane_id: 'pane-1', surface: 'git' },
      timeoutMs: undefined,
    }])
  })

  it('keeps the record while the surface is provided', async () => {
    stubProvided(true)
    const { terminalPort, sent } = createMockBackend()
    await expect(terminalPort.dockSurfaceRetired!('/ws', 'pane-1', 'plans')).resolves.toBe(false)
    expect(sent).toEqual([])
  })

  it('keeps the record when main cannot answer (an older main)', async () => {
    ;(window as unknown as { agentTeam: unknown }).agentTeam = {}
    const { terminalPort, sent } = createMockBackend()
    await expect(terminalPort.dockSurfaceRetired!('/ws', 'pane-1', 'plans')).resolves.toBe(false)
    expect(sent).toEqual([])
  })
})
