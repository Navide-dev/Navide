import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { acpOutputLogFile, createAcpHost, type AcpHostPane, type AcpPaneApi } from '../acpHost'

function setup(pane: AcpHostPane | undefined = { id: 'p1', agentKey: 'opencode', workspacePath: '/work' }) {
  const historyEntry: { outputLogFile?: string } = {}
  const deps = {
    runDir: vi.fn((): string | undefined => undefined),
    history: vi.fn((id: string) => (id === 'p1' ? historyEntry : undefined)),
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
    prompt: vi.fn(async () => 'sent' as const),
    status: 'running',
    displayStatus: 'idle',
    setStopped: vi.fn(),
  }
  return { host, deps, api, historyEntry }
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

  it('starts the agent in the pane folder with its output log, records it, and reports whether it came up', async () => {
    const pane: AcpHostPane = { id: 'p1abcdefgh', agentKey: 'opencode', workspacePath: '/work' }
    const { host, deps, api } = setup(pane)
    const entry: { outputLogFile?: string } = {}
    deps.history.mockImplementation(() => entry)
    host.claim('p1abcdefgh', { display: 'acp', agentKey: 'opencode' })
    host.setRef('p1abcdefgh', api)

    expect(await host.start('p1abcdefgh', { workspacePath: '/work', agentKey: 'opencode' })).toBe('p1abcdefgh')
    const log = (api.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0].outputLogFile as string
    expect(log).toMatch(/^\/work\/\.agent-team\/manual\/\d{8}\/opencode-p1abcdef\.log$/)
    expect(api.spawn).toHaveBeenCalledWith({ cwd: '/work', agentKey: 'opencode', outputLogFile: log })
    expect(pane.outputLogFile).toBe(log)
    expect(entry.outputLogFile).toBe(log)
    expect(deps.started).toHaveBeenCalledWith('p1abcdefgh', true)
  })

  it('writes a pipeline pane log into its run folder, and none for a sign-in pane', () => {
    const opts = { workspacePath: '/w', origin: 'pipeline', stageId: 2, agentKey: 'opencode' }
    expect(acpOutputLogFile('abcdefghij', {}, opts, 'runs/r1')).toBe('/w/.agent-team/runs/r1/stage-2-abcdefgh.log')
    expect(acpOutputLogFile('abcdefghij', {}, opts, undefined)).toBe('/w/.agent-team/stage-2-abcdefgh.log')
    expect(acpOutputLogFile('abcdefghij', { isLogin: true }, opts, undefined)).toBeUndefined()
  })

  it('uses the very rule App.vue uses for a terminal pane log (no drift)', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
    const host = readFileSync(resolve(process.cwd(), 'src/renderer/src/lib/acpHost.ts'), 'utf8')
    const templates = (src: string): string[] => (src.match(/`\$\{opts\.workspacePath\}\/\.agent-team\/[^`]*`/g) ?? [])
      .map((t) => t.replace('pipeline.runDir', 'runDir'))
    expect(templates(host)).toHaveLength(3)
    for (const t of templates(host)) expect(templates(app)).toContain(t)
    expect(app).toContain("const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')")
    expect(host).toContain("const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '')")
  })

  it('forgets a pane once it unmounts with its record gone, not while it stays listed', () => {
    let present = true
    const { host, deps, api } = setup()
    deps.pane.mockImplementation((id: string) => (present && id === 'p1' ? { id, agentKey: 'opencode' } : undefined))
    host.claim('p1', { display: 'acp', agentKey: 'opencode' })
    host.setRef('p1', api)

    host.setRef('p1', null) // unmounted while still listed (e.g. off screen and remounted)
    expect(host.owns('p1')).toBe(true)
    present = false
    host.setRef('p1', null)
    present = true // a record with the same id would not be an ACP pane by accident
    expect(host.owns('p1')).toBe(false)
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

  it('answers the messaging gate from the pane state', () => {
    const { host, api } = setup()
    host.setRef('p1', api)

    expect(host.holdKey('p1')).toBeNull()
    host.setRef('p1', { ...api, displayStatus: 'running' })
    expect(host.holdKey('p1')).toBe('mid-turn')
    expect(host.holdKey('unknown')).toBe('starting')
  })

  it('delivers a message as a prompt: accepted, refused, unconfirmed, or back to the queue', async () => {
    const { host, api } = setup()
    const prompt = api.prompt as ReturnType<typeof vi.fn>
    host.setRef('p1', api)

    for (const [result, expected] of [
      ['sent', true], ['queued', true], ['unsent', false], ['unconfirmed', { unconfirmed: true }], ['', null],
    ] as const) {
      prompt.mockResolvedValueOnce(result)
      expect(await host.deliver('p1', 'envelope')).toEqual(expected)
    }
    expect(prompt).toHaveBeenCalledWith('envelope')
    expect(await host.deliver('gone', 'envelope')).toBeNull()
  })
})
