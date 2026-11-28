// A fake backend speaking the commander.* contract (lib/commander.ts), for the
// commander store and component tests.
import { ref } from 'vue'
import type { CommanderBackend } from '../useCommanders'
import type { CommanderState, CommanderSummary, CommanderTree, CommanderTreeNode } from '../../lib/commander'

const ZERO_COUNTS: Record<CommanderState, number> = { working: 0, waiting: 0, reported: 0, idle: 0, stalled: 0, gone: 0 }

export function commanderSummary(over: Partial<CommanderSummary> = {}): CommanderSummary {
  return {
    id: 'c1', name: 'Navide指揮', icon: '◎', color: '#7c5cd6', duty: 'Navide App development and releases',
    workspaces: ['/work/Agent-Team'], agent_key: 'claude', account_id: '', model: '', skills: ['verify'], mcp: ['navide'],
    stall_minutes: 20, created_at: 1, updated_at: 1, archived_at: 0,
    body: { commander_id: 'c1', pane_id: 'body-1', workspace: '/work/Agent-Team', agent_key: 'claude', session_id: 's', attached_at: 1, detached_at: 0 },
    body_live: true, bindings: [], dispatch_counts: { ...ZERO_COUNTS },
    ...over,
  }
}

export function node(pane_id: string, state: CommanderState, over: Partial<CommanderTreeNode> = {}): CommanderTreeNode {
  return { pane_id, name: pane_id, opened_by: 'body-1', task: '', opened_at: 100, closed_at: 0, state, children: [], ...over }
}

export function tree(commander_id: string, children: CommanderTreeNode[]): CommanderTree {
  return { commander_id, root: { ...node('body-1', 'working'), children } }
}

export interface FakeBackend extends CommanderBackend {
  sent: { type: string; payload: Record<string, unknown> }[]
  emit(type: string, payload: unknown): void
}

/** `answers[type]` is the payload to answer with, or a function of the request. */
export function fakeBackend(answers: Record<string, unknown>): FakeBackend {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const sent: FakeBackend['sent'] = []
  return {
    status: ref('connected'),
    sent,
    async send<T>(type: string, payload: Record<string, unknown> = {}) {
      sent.push({ type, payload })
      const a = answers[type]
      const value = typeof a === 'function' ? (a as (p: Record<string, unknown>) => unknown)(payload) : a
      if (value instanceof Error) {
        return { id: '1', type, ok: false, payload: null, error: { code: (value as Error & { code?: string }).code ?? 'BAD_REQUEST', message: value.message }, timestamp: '' }
      }
      return { id: '1', type, ok: value !== undefined, payload: (value ?? null) as T | null, error: value === undefined ? { code: 'NOT_FOUND', message: 'unhandled' } : null, timestamp: '' }
    },
    on(type: string, cb: (p: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(cb)
      return () => listeners.get(type)?.delete(cb)
    },
    emit(type: string, payload: unknown) {
      for (const cb of listeners.get(type) ?? []) cb(payload)
    },
  }
}

/** An Error the fake answers with, carrying a backend error code. */
export function refusal(code: string, message = 'refused'): Error {
  return Object.assign(new Error(message), { code })
}
