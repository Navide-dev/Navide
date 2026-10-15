// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { createMockBackend, flush } from './mockBackend'
import { useGuard } from '../useGuard'

function seed(mock: ReturnType<typeof createMockBackend>): void {
  mock.setResponse('guard.status', {
    enabled: true,
    counts: { critical: 2, high: 5, asks: 1, denies_24h: 3 },
    hook_support: { claude: 'block', cursor: 'none' },
  })
  mock.setResponse('guard.taint.list', {
    panes: [{ pane_id: 'p1', sources: ['remote'], since: 1_700_000_000, detail: 'telegram:alice' }],
  })
  mock.setResponse('guard.rules.list', { rules: [{ id: 1, kind: 'deny', pattern: 'terraform apply', note: '' }] })
  mock.setResponse('guard.audit.list', { entries: [] })
}

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  const { toasts, dismissToast } = useNotify()
  for (const t of [...toasts.value]) dismissToast(t.id)
})

describe('useGuard', () => {
  it('reads status and taint on connect, without the Settings-only lists', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useGuard(mock.backend)
    await flush()
    expect(mock.sent.map((s) => s.type).sort()).toEqual(['guard.status', 'guard.taint.list'])
    expect(store.available.value).toBe(true)
    expect(store.counts.value.denies_24h).toBe(3)
    expect(store.hookSupportFor('cursor')).toBe('none')
    expect(store.hookSupportFor('claude')).toBe('block')
    expect(store.hookSupportFor('kimi')).toBeNull()
    expect(store.taintFor('p1')?.detail).toBe('telegram:alice')
    expect(store.taintFor('p2')).toBeNull()
  })

  it('stays unavailable when the backend has no Guard', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('guard.status', null, { ok: false, error: { code: 'unknown_type', message: 'unknown type' } })
    const store = useGuard(mock.backend)
    await flush()
    expect(store.available.value).toBe(false)
  })

  it('shares one store per backend', () => {
    const mock = createMockBackend('disconnected')
    expect(useGuard(mock.backend)).toBe(useGuard(mock.backend))
  })

  it('re-reads the taint set on guard.taint_changed', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useGuard(mock.backend)
    await flush()
    mock.setResponse('guard.taint.list', { panes: [] })
    mock.emit('guard.taint_changed', { pane_id: 'p1', tainted: false })
    await flush()
    expect(store.taintFor('p1')).toBeNull()
  })

  it('turns a non-allow guard.decision into a notice with the reason', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    useGuard(mock.backend)
    await flush()
    mock.emit('guard.decision', { pane_id: 'p1', action: 'deny', level: 'critical', reason: 'rm outside workspace', excerpt: 'rm -rf ~' })
    mock.emit('guard.decision', { pane_id: 'p1', action: 'allow', level: 'normal', reason: 'fine', excerpt: 'ls' })
    await flush()
    const messages = useNotify().toasts.value.map((t) => t.message)
    expect(messages).toEqual(['Navide Guard blocked an action: rm outside workspace'])
    expect(useNotify().toasts.value[0].type).toBe('error')
    expect(useNotify().toasts.value[0].variant).toBe('security')
  })

  it('announces a fail-open (action error) as an error notice', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    useGuard(mock.backend)
    await flush()
    mock.emit('guard.decision', { pane_id: 'p1', action: 'error', level: 'normal', reason: 'Navide Guard error, allowed: no decision within 5s', excerpt: '' })
    await flush()
    const toast = useNotify().toasts.value[0]
    expect(toast.message).toBe('Navide Guard could not check an action and let it run: Navide Guard error, allowed: no decision within 5s')
    expect(toast.type).toBe('error')
  })

  it('asks the main process to confirm only changes that loosen grading', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const builtin = {
      rules: [{ id: 'git-push', group: 'high', description: 'Pushes', example: 'git push', default_level: 'high', level: 'high', floor: false }],
      protected_branches: ['main', 'master'],
    }
    mock.setResponse('guard.builtin.get', builtin)
    mock.setResponse('guard.builtin.set_level', builtin)
    mock.setResponse('guard.branches.add', builtin)
    mock.setResponse('guard.branches.remove', builtin)
    const minted: string[] = []
    ;(window as unknown as { agentTeam: unknown }).agentTeam = {
      trustConfirm: async (action: string, _device: string, subject: string) => {
        minted.push(`${action} ${subject}`)
        return { nonce: 'n', expires: 'e', mac: 'm' }
      },
    }
    try {
      const store = useGuard(mock.backend)
      await store.refresh()
      expect(store.protectedBranches.value).toEqual(['main', 'master'])
      await store.setRuleLevel('git-push', 'critical')
      await store.setRuleLevel('git-push', 'normal')
      await store.addBranch(' release ')
      await store.removeBranch('main')
      await store.addRule('deny', 'docker system prune', '', 'high')
      const sent = (type: string) => mock.sent.filter((s) => s.type === type).map((s) => s.payload)
      expect(sent('guard.builtin.set_level')).toEqual([
        { id: 'git-push', level: 'critical' },
        { id: 'git-push', level: 'normal', confirm: { nonce: 'n', expires: 'e', mac: 'm' } },
      ])
      expect(sent('guard.branches.add')).toEqual([{ name: 'release' }])
      expect(sent('guard.branches.remove')).toEqual([{ name: 'main', confirm: { nonce: 'n', expires: 'e', mac: 'm' } }])
      expect(sent('guard.rules.add')).toEqual([{ kind: 'deny', pattern: 'docker system prune', note: '', level: 'high' }])
      expect(minted).toEqual(['guard.builtin.set_level git-push:normal', 'guard.branches.remove main'])
    } finally {
      delete (window as unknown as { agentTeam?: unknown }).agentTeam
    }
  })

  it('sends mutations with the contract payloads', async () => {
    const mock = createMockBackend('connected')
    seed(mock)
    const store = useGuard(mock.backend)
    await flush()
    await store.setEnabled(false)
    await store.addRule('allow', 'rm -rf dist', 'build output')
    await store.removeRule(1)
    await store.clearTaint('p1')
    await store.test('rm -rf ~', 'relay', true)
    const payload = (type: string) => mock.sent.find((s) => s.type === type)?.payload
    expect(payload('guard.set_enabled')).toEqual({ enabled: false })
    // Loosening changes carry the main process's confirmation (none in a test window).
    expect(payload('guard.rules.add')).toEqual({ kind: 'allow', pattern: 'rm -rf dist', note: 'build output', confirm: null })
    expect(payload('guard.rules.remove')).toEqual({ id: 1, confirm: null })
    expect(payload('guard.taint.clear')).toEqual({ pane_id: 'p1' })
    expect(payload('guard.test')).toEqual({ command: 'rm -rf ~', source: 'relay', tainted: true })
  })
})
