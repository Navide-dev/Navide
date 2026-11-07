import { describe, expect, it } from 'vitest'
import { PluginError } from '@navide/plugin-contracts'
import { createTestHost } from './testing'

describe('createTestHost', () => {
  it('answers a declared capability from its handler and records the call', async () => {
    const host = createTestHost({
      permissions: { system: ['fs'] },
      handlers: { 'fs.readFile': (params) => ({ content: `read ${(params as { path: string }).path}` }) },
    })
    await expect(host.context.capabilities.invoke('fs.readFile', { path: 'a.md' })).resolves.toEqual({ content: 'read a.md' })
    expect(host.calls).toEqual([{ address: 'fs.readFile', params: { path: 'a.md' }, outcome: 'ok' }])
  })

  it('refuses an undeclared namespace with CAPABILITY_DENIED, as the Host does', async () => {
    const host = createTestHost({ permissions: { system: ['fs'] }, handlers: { 'shell.run': () => ({}) } })
    const call = host.context.capabilities.invoke('shell.run', { command: 'git status' })
    await expect(call).rejects.toBeInstanceOf(PluginError)
    await expect(call).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(host.calls[0]).toMatchObject({ address: 'shell.run', outcome: 'CAPABILITY_DENIED' })
  })

  it('answers METHOD_NOT_FOUND for a declared address with no handler', async () => {
    const host = createTestHost({ permissions: { system: ['fs'] } })
    await expect(host.context.capabilities.invoke('fs.readFile', { path: 'a' })).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' })
  })

  it('delivers emitted events to subscribers until disposed', () => {
    const host = createTestHost({ permissions: { system: ['fs'] } })
    const seen: unknown[] = []
    const sub = host.context.events.subscribe('workspace.filesChanged', (payload) => seen.push(payload))
    expect(host.emit('workspace.filesChanged', { changes: [{ path: 'a', kind: 'changed' }] })).toBe(true)
    sub.dispose()
    host.emit('workspace.filesChanged', { changes: [] })
    expect(seen).toEqual([{ changes: [{ path: 'a', kind: 'changed' }] }])
  })

  it('delivers an agents.* event only when it is declared', () => {
    const host = createTestHost({ permissions: { system: ['agents'], agentEvents: ['agents.turnEnded'] } })
    const seen: string[] = []
    host.context.events.subscribe('agents.turnEnded', (payload) => seen.push(payload.paneId))
    host.context.events.subscribe('agents.paneIdle', (payload) => seen.push(`idle ${payload.paneId}`))
    expect(host.emit('agents.turnEnded', { paneId: 'p1', name: 'worker' })).toBe(true)
    expect(host.emit('agents.paneIdle', { paneId: 'p1', name: 'worker' })).toBe(false)
    expect(seen).toEqual(['p1'])
  })

  it('records view effects and pushes appearance and target changes', async () => {
    const host = createTestHost()
    const themes: string[] = []
    host.context.appearance.subscribe((snapshot) => themes.push(snapshot.themeId))
    host.setAppearance({ ...host.context.appearance.current(), themeId: 'light' })
    await host.context.view.setBadge(3)
    host.context.lifecycle.reportProgress('loading')
    expect(themes).toEqual(['light'])
    expect(host.effects).toEqual([{ kind: 'badge', value: 3 }, { kind: 'progress', value: 'loading' }])
  })
})
