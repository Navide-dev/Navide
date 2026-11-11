import { ref } from 'vue'
import type { useBackend } from './useBackend'

/**
 * Renderer side of terminal command protection (backend guard/terminal_policy):
 * which commands Navide refuses to type into a plain terminal pane. Thin
 * wrappers around the renderer-only `guard.terminal.*` WS requests.
 *
 * A change that LOOSENS protection — switching a category off, adding an allow
 * prefix, removing a block pattern, adding an exemption — carries a one-time confirmation minted by
 * the main process (window.agentTeam.trustConfirm), bound to exactly that
 * change. The backend refuses it without one, which is what keeps MCP and the
 * plugin broker (same socket, no main process) from loosening anything.
 * Tightening needs no confirmation.
 */

export interface TerminalCategory {
  id: string
  description: string
  example: string
  enabled: boolean
  default_enabled: boolean
}

export interface TerminalPattern {
  id: number
  kind: 'block' | 'allow'
  pattern: string
}

/** Lifts one exemptable pipeline rule (credential-pipe-upload) for a whole
 *  line matching `pattern`; a block pattern still outranks it. */
export interface TerminalExemption {
  id: number
  rule: string
  pattern: string
}

export interface TerminalRefusal {
  rule: string
  segment: string
  reason: string
  message: string
  pattern?: string
}

interface TerminalState {
  ok: boolean
  error?: string
  categories?: TerminalCategory[]
  patterns?: TerminalPattern[]
  exemptions?: TerminalExemption[]
  exemptable_rules?: string[]
}

type Backend = Pick<ReturnType<typeof useBackend>, 'send'>
type Confirm = { nonce: string; expires: string; mac: string } | null

export interface Result<T = undefined> {
  ok: boolean
  error?: string
  data?: T
}

export function useTerminalProtection(backend: Backend) {
  const categories = ref<TerminalCategory[]>([])
  const patterns = ref<TerminalPattern[]>([])
  const exemptions = ref<TerminalExemption[]>([])
  const exemptableRules = ref<string[]>([])
  const error = ref('')

  async function call(type: string, payload: Record<string, unknown>): Promise<Result<TerminalState>> {
    try {
      const res = await backend.send<TerminalState>(type, payload)
      if (!res.ok) return { ok: false, error: res.error?.message ?? 'request failed' }
      const body = res.payload
      if (!body?.ok) return { ok: false, error: body?.error ?? 'request failed' }
      return { ok: true, data: body }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  function adopt(state: TerminalState | undefined): void {
    if (state?.categories) categories.value = state.categories
    if (state?.patterns) patterns.value = state.patterns
    if (state?.exemptions) exemptions.value = state.exemptions
    if (state?.exemptable_rules) exemptableRules.value = state.exemptable_rules
  }

  async function mutate(type: string, payload: Record<string, unknown>): Promise<Result> {
    const res = await call(type, payload)
    if (res.ok) adopt(res.data)
    error.value = res.ok ? '' : (res.error ?? '')
    return { ok: res.ok, error: res.error }
  }

  /** The main process's confirmation for one loosening change, or null when
   *  this window cannot get one (the backend then refuses the change). */
  async function confirmFor(action: string, subject: string): Promise<Confirm> {
    try {
      return (await window.agentTeam?.trustConfirm(action, '', subject)) ?? null
    } catch {
      return null
    }
  }

  async function refresh(): Promise<Result> {
    const res = await call('guard.terminal.get', {})
    if (res.ok) adopt(res.data)
    error.value = res.ok ? '' : (res.error ?? '')
    return { ok: res.ok, error: res.error }
  }

  async function setCategory(id: string, enabled: boolean): Promise<Result> {
    const payload: Record<string, unknown> = { id, enabled }
    if (!enabled) payload.confirm = await confirmFor('guard.terminal.set_category', `${id}:off`)
    return mutate('guard.terminal.set_category', payload)
  }

  async function addPattern(kind: 'block' | 'allow', pattern: string): Promise<Result> {
    const value = pattern.trim()
    const payload: Record<string, unknown> = { kind, pattern: value }
    if (kind === 'allow') payload.confirm = await confirmFor('guard.terminal.add_pattern', `allow:${value}`)
    return mutate('guard.terminal.add_pattern', payload)
  }

  async function removePattern(p: TerminalPattern): Promise<Result> {
    const payload: Record<string, unknown> = { id: p.id }
    if (p.kind === 'block') payload.confirm = await confirmFor('guard.terminal.remove_pattern', String(p.id))
    return mutate('guard.terminal.remove_pattern', payload)
  }

  async function addExemption(rule: string, pattern: string): Promise<Result> {
    const value = pattern.trim()
    const confirm = await confirmFor('guard.terminal.add_exemption', `${rule}:${value}`)
    return mutate('guard.terminal.add_exemption', { rule, pattern: value, confirm })
  }

  async function removeExemption(e: TerminalExemption): Promise<Result> {
    return mutate('guard.terminal.remove_exemption', { id: e.id })
  }

  async function test(command: string): Promise<Result<{ refused: boolean; refusal: TerminalRefusal | null }>> {
    try {
      const res = await backend.send<{ ok: boolean; error?: string; refused: boolean; refusal: TerminalRefusal | null }>(
        'guard.terminal.test', { command },
      )
      if (!res.ok || !res.payload?.ok) {
        return { ok: false, error: res.payload?.error ?? res.error?.message ?? 'request failed' }
      }
      return { ok: true, data: { refused: res.payload.refused, refusal: res.payload.refusal } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    categories, patterns, exemptions, exemptableRules, error, refresh, setCategory, addPattern, removePattern,
    addExemption, removeExemption, test,
  }
}

/** Client-side mirror of the backend's validate_pattern, for an immediate
 *  message; the backend checks again and its answer is the one that counts. */
export function patternProblem(pattern: string): 'empty' | 'too-long' | 'control' | 'bracket' | 'match-all' | null {
  const p = pattern.trim()
  if (!p) return 'empty'
  if (p.length > 500) return 'too-long'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(p)) return 'control'
  if ((p.match(/\[/g)?.length ?? 0) !== (p.match(/\]/g)?.length ?? 0)) return 'bracket'
  if (/^[*? ]+$/.test(p)) return 'match-all'
  return null
}
