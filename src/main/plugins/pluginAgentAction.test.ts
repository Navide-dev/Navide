import { describe, expect, it, vi } from 'vitest'
import { answerPluginAgentAction, parsePluginAgentActionRequest, type PluginAgentActionDeps } from './pluginAgentAction'

const requester = { paneId: 'p-41', paneName: 'dev', workspace: '/Users/me/project', callerKind: 'pane' as const }
const request = { request_id: 'pa:1', action: 'disable', plugin_id: 'nerdtechnic.devmap', requester }

function deps(overrides: Partial<PluginAgentActionDeps> = {}): PluginAgentActionDeps & {
  setDisabled: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
} {
  return {
    isBuiltin: (id: string) => id.startsWith('navide.'),
    installedVersion: (id: string) => (id === 'nerdtechnic.devmap' ? '0.2.0' : null),
    setDisabled: vi.fn(async () => ({ changed: true })),
    notify: vi.fn(),
    ...overrides,
  } as never
}

describe('plugins.agent_action request shape (contract 4.3.1)', () => {
  it('accepts exactly request_id, action, plugin_id and requester', () => {
    expect(parsePluginAgentActionRequest(request)).toEqual({ action: 'disable', pluginId: 'nerdtechnic.devmap', requester })
    expect(parsePluginAgentActionRequest({ ...request, action: 'enable' })?.action).toBe('enable')
    for (const bad of [
      { ...request, consent: true },
      { ...request, action: 'remove' },
      { ...request, plugin_id: 'Not An Id' },
      { ...request, requester: { ...requester, callerKind: 'user' } },
      { ...request, requester: { ...requester, extra: 'x' } },
      { ...request, requester: { ...requester, paneName: 3 } },
      { request_id: 'pa:1', action: 'disable', plugin_id: 'nerdtechnic.devmap' },
      null,
      [],
    ]) {
      expect(parsePluginAgentActionRequest(bad)).toBeNull()
    }
  })
})

describe('answerPluginAgentAction', () => {
  it('switches an installed Marketplace package and names the caller in the notice', async () => {
    const d = deps()
    await expect(answerPluginAgentAction(request, d)).resolves.toEqual({
      ok: true, pluginId: 'nerdtechnic.devmap', pluginVersion: '0.2.0', disabled: true, changed: true,
    })
    expect(d.setDisabled).toHaveBeenCalledWith('nerdtechnic.devmap', true)
    expect(d.notify).toHaveBeenCalledWith({ action: 'disable', pluginId: 'nerdtechnic.devmap', pluginVersion: '0.2.0', requester })
    await answerPluginAgentAction({ ...request, action: 'enable' }, d)
    expect(d.setDisabled).toHaveBeenLastCalledWith('nerdtechnic.devmap', false)
  })

  it('tells nobody and offers no undo when the package was already in that state', async () => {
    // The user had disabled it themselves: an undo would turn their own choice around.
    const d = deps({ setDisabled: vi.fn(async () => ({ changed: false })) })
    await expect(answerPluginAgentAction(request, d)).resolves.toEqual({
      ok: true, pluginId: 'nerdtechnic.devmap', pluginVersion: '0.2.0', disabled: true, changed: false,
    })
    await answerPluginAgentAction({ ...request, action: 'enable' }, d)
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('refuses the bundled Navide plugins without touching their switch', async () => {
    const d = deps({ installedVersion: () => '1.0.0' })
    for (const id of ['navide.plans', 'navide.git', 'navide.mini-ide']) {
      await expect(answerPluginAgentAction({ ...request, plugin_id: id }, d)).resolves.toMatchObject({
        ok: false, error_code: 'BUILTIN_PLUGIN',
      })
    }
    expect(d.setDisabled).not.toHaveBeenCalled()
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('refuses a package that is not an installed Marketplace package, and a malformed request', async () => {
    const d = deps()
    await expect(answerPluginAgentAction({ ...request, plugin_id: 'acme.other' }, d)).resolves.toMatchObject({
      ok: false, error_code: 'NOT_INSTALLED',
    })
    await expect(answerPluginAgentAction({ ...request, approved: true }, d)).resolves.toMatchObject({
      ok: false, error_code: 'BAD_REQUEST',
    })
    expect(d.setDisabled).not.toHaveBeenCalled()
  })

  it('reports a failed switch and tells nobody', async () => {
    const d = deps({ setDisabled: vi.fn(async () => { throw new Error('plugin transaction already in progress') }) })
    await expect(answerPluginAgentAction(request, d)).resolves.toEqual({
      ok: false, error: 'plugin transaction already in progress', error_code: 'ACTION_FAILED',
    })
    expect(d.notify).not.toHaveBeenCalled()
  })
})
