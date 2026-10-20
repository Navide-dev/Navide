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
    isDisabled: () => false,
    disableSource: () => ({ by: 'user' as const, at: null, agent: null }),
    now: () => 1_792_108_800_000,
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
      // S8-M1: tainted is optional, and only ever true.
      { ...request, requester: { ...requester, tainted: false } },
      { ...request, requester: { ...requester, tainted: 'yes' } },
      { request_id: 'pa:1', action: 'disable', plugin_id: 'nerdtechnic.devmap' },
      null,
      [],
    ]) {
      expect(parsePluginAgentActionRequest(bad)).toBeNull()
    }
  })

  it("accepts a tainted pane's request and keeps the flag (S8-M1)", () => {
    const tainted = { ...requester, tainted: true as const }
    expect(parsePluginAgentActionRequest({ ...request, requester: tainted })).toEqual({
      action: 'disable', pluginId: 'nerdtechnic.devmap', requester: tainted,
    })
  })
})

describe('answerPluginAgentAction', () => {
  it('switches an installed Marketplace package and names the caller in the notice', async () => {
    const d = deps()
    await expect(answerPluginAgentAction(request, d)).resolves.toEqual({
      ok: true, pluginId: 'nerdtechnic.devmap', pluginVersion: '0.2.0', disabled: true, changed: true,
    })
    expect(d.setDisabled).toHaveBeenCalledWith('nerdtechnic.devmap', true, expect.objectContaining({ by: 'agent' }))
    expect(d.notify).toHaveBeenCalledWith({ action: 'disable', pluginId: 'nerdtechnic.devmap', pluginVersion: '0.2.0', requester })
    await answerPluginAgentAction({ ...request, action: 'enable' }, d)
    expect(d.setDisabled).toHaveBeenLastCalledWith('nerdtechnic.devmap', false, undefined)
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

describe('enable depends on who disabled the package (B2-c option B)', () => {
  const enable = { ...request, action: 'enable' }

  it('records the agent as the one who disabled it', async () => {
    const d = deps()
    await answerPluginAgentAction(request, d)
    expect(d.setDisabled).toHaveBeenCalledWith('nerdtechnic.devmap', true, {
      by: 'agent', at: 1_792_108_800_000, agent: { callerKind: 'pane', paneId: 'p-41', paneName: 'dev' },
    })
  })

  it('sends a package the user disabled to the user\'s approval, changing nothing', async () => {
    const d = deps({ isDisabled: () => true, disableSource: () => ({ by: 'user', at: 1_792_000_000_000, agent: null }) })
    await expect(answerPluginAgentAction(enable, d)).resolves.toEqual({
      ok: false,
      error: "the user disabled nerdtechnic.devmap; enabling it needs the user's approval in Navide",
      error_code: 'APPROVAL_REQUIRED',
      pluginId: 'nerdtechnic.devmap',
      pluginVersion: '0.2.0',
      disabled: { by: 'user', at: 1_792_000_000_000, agent: null },
    })
    expect(d.setDisabled).not.toHaveBeenCalled()
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('treats a package disabled before sources were recorded as disabled by the user', async () => {
    const d = deps({ isDisabled: () => true })
    await expect(answerPluginAgentAction(enable, d)).resolves.toMatchObject({ ok: false, error_code: 'APPROVAL_REQUIRED' })
    expect(d.setDisabled).not.toHaveBeenCalled()
  })

  it('re-enables at once what an agent disabled, and tells the user', async () => {
    const agent = { callerKind: 'pane' as const, paneId: 'p-9', paneName: 'other' }
    const d = deps({ isDisabled: () => true, disableSource: () => ({ by: 'agent', at: 1, agent }) })
    await expect(answerPluginAgentAction(enable, d)).resolves.toMatchObject({ ok: true, disabled: false, changed: true })
    expect(d.setDisabled).toHaveBeenCalledWith('nerdtechnic.devmap', false, undefined)
    expect(d.notify).toHaveBeenCalledTimes(1)
  })
})


describe('O1: an agent update whose disclosure is unchanged', () => {
  const update = { request_id: 'pa:9', action: 'update', plugin_id: 'nerdtechnic.devmap', version: '0.3.0', requester }
  const diff = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    from: { id: 'nerdtechnic.devmap', version: '0.2.0', risk: 'medium' },
    to: { id: 'nerdtechnic.devmap', version: '0.3.0', risk: 'medium' },
    added: [], removed: [], unchanged: [{ kind: 'system', key: 'workspace.read', detail: null }], widened: false,
    ...overrides,
  })
  const check = (prepared: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    installedSource: 'marketplace', installedHasViews: true, candidatePending: false,
    prepared: { source: 'marketplace', hasViews: true, requiresPublisherTrust: false, disclosureDiff: diff(), ...prepared },
    ...extra,
  })
  function updateDeps(result: unknown = check()) {
    const commitUpdate = vi.fn(async () => {})
    const discardUpdate = vi.fn()
    const prepareUpdate = vi.fn(async () => result)
    return { d: deps({ prepareUpdate, commitUpdate, discardUpdate } as never), prepareUpdate, commitUpdate, discardUpdate }
  }

  it('parses the version an update names, and only for an update', () => {
    expect(parsePluginAgentActionRequest(update)).toEqual({ action: 'update', pluginId: 'nerdtechnic.devmap', requester, version: '0.3.0' })
    expect(parsePluginAgentActionRequest({ ...update, version: 'latest' })).toBeNull()
    expect(parsePluginAgentActionRequest({ request_id: 'pa:9', action: 'update', plugin_id: 'nerdtechnic.devmap', requester })).toBeNull()
    expect(parsePluginAgentActionRequest({ ...request, version: '0.3.0' })).toBeNull()
  })

  it('updates at once, tells the user who did it from which version, and offers the way back', async () => {
    const { d, prepareUpdate, commitUpdate, discardUpdate } = updateDeps()
    await expect(answerPluginAgentAction(update, d)).resolves.toEqual({
      ok: true, updated: true, pluginId: 'nerdtechnic.devmap', fromVersion: '0.2.0', pluginVersion: '0.3.0',
    })
    expect(prepareUpdate).toHaveBeenCalledWith('nerdtechnic.devmap', '0.3.0')
    // The switch record names the agent (user decision A, 2026-10-21).
    expect(commitUpdate).toHaveBeenCalledWith('nerdtechnic.devmap', requester)
    expect(discardUpdate).not.toHaveBeenCalled()
    expect(d.notify).toHaveBeenCalledWith({
      action: 'update', pluginId: 'nerdtechnic.devmap', pluginVersion: '0.3.0', fromVersion: '0.2.0', requester,
    })
  })

  it.each([
    ['a permission added', check({ disclosureDiff: diff({ added: [{ kind: 'network', key: 'shell', detail: null }], widened: true }) })],
    ['a permission removed', check({ disclosureDiff: diff({ removed: [{ kind: 'system', key: 'workspace.read', detail: null }] }) })],
    ['the risk level changed', check({ disclosureDiff: diff({ to: { id: 'nerdtechnic.devmap', version: '0.3.0', risk: 'low' } }) })],
    ['no diff to compare', check({ disclosureDiff: null })],
    ['the source changed', check({ source: 'prerelease' })],
    ['views added', check({ hasViews: false })],
    ['views unknown', check({}, { installedHasViews: undefined })],
    ['an untrusted publisher', check({ requiresPublisherTrust: true })],
    ['a local install replaced', check({ replacesLocal: { version: '0.2.0' } })],
    ['a staged version waiting', check({}, { candidatePending: true })],
  ])('asks the user when anything differs: %s', async (_name, result) => {
    const { d, commitUpdate, discardUpdate } = updateDeps(result)
    const answer = await answerPluginAgentAction(update, d)
    expect(answer).toMatchObject({ ok: false, error_code: 'APPROVAL_REQUIRED', pluginId: 'nerdtechnic.devmap', pluginVersion: '0.2.0' })
    expect(commitUpdate).not.toHaveBeenCalled()
    expect(discardUpdate).toHaveBeenCalledWith('nerdtechnic.devmap')
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('fails closed when the update cannot be prepared, is not newer, or the Host cannot compare', async () => {
    const failing = updateDeps()
    failing.prepareUpdate.mockRejectedValueOnce(new Error('signature invalid'))
    await expect(answerPluginAgentAction(update, failing.d)).resolves.toMatchObject({ ok: false, error_code: 'APPROVAL_REQUIRED' })
    const older = updateDeps()
    await expect(answerPluginAgentAction({ ...update, version: '0.2.0' }, older.d)).resolves.toMatchObject({ error_code: 'APPROVAL_REQUIRED' })
    expect(older.prepareUpdate).not.toHaveBeenCalled()
    await expect(answerPluginAgentAction(update, deps())).resolves.toMatchObject({ error_code: 'APPROVAL_REQUIRED' })
    expect(failing.commitUpdate).not.toHaveBeenCalled()
  })

  it('reports a failed commit and tells nobody', async () => {
    const { d, commitUpdate, discardUpdate } = updateDeps()
    commitUpdate.mockRejectedValueOnce(new Error('disk full'))
    await expect(answerPluginAgentAction(update, d)).resolves.toEqual({ ok: false, error: 'disk full', error_code: 'ACTION_FAILED' })
    expect(discardUpdate).toHaveBeenCalled()
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('never updates a bundled Navide plugin or a package that is not from the Navide Marketplace', async () => {
    const { d, prepareUpdate } = updateDeps()
    await expect(answerPluginAgentAction({ ...update, plugin_id: 'navide.plans' }, d)).resolves.toMatchObject({ error_code: 'BUILTIN_PLUGIN' })
    await expect(answerPluginAgentAction({ ...update, plugin_id: 'acme.local' }, d)).resolves.toMatchObject({ error_code: 'NOT_INSTALLED' })
    expect(prepareUpdate).not.toHaveBeenCalled()
  })
})
