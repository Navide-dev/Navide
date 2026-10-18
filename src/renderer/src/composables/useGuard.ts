import { computed, ref, watch, type InjectionKey } from 'vue'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import type { useBackend } from './useBackend'

/**
 * Renderer side of Navide Guard: status, built-in rule levels, protected
 * branches, custom rules, the audit list and the tainted-pane set, as thin
 * wrappers around the renderer-only `guard.*` WS requests. A change that
 * loosens grading (lowering a built-in rule, adding an allow, removing a deny
 * or a protected branch) carries a one-time confirmation minted by the main
 * process, like terminal command protection; tightening needs none. Re-fetches on reconnect, re-reads the taint set on
 * `guard.taint_changed`, and turns each `guard.decision` (sent for non-allow
 * decisions only) into a transient notice.
 */

export type GuardLevel = 'normal' | 'high' | 'critical'
export type GuardSource = 'local' | 'relay' | 'remote' | 'agent'
export type GuardAction = 'allow' | 'ask' | 'deny'
/** `error`: Guard failed and the call went through undecided (fail-open). */
export type GuardEventAction = GuardAction | 'error'
export type GuardHookSupport = 'block' | 'none'

export interface GuardCounts {
  critical: number
  high: number
  asks: number
  denies_24h: number
}

export interface GuardRule {
  id: number | string
  kind: 'allow' | 'deny'
  pattern: string
  note: string
  /** What a matching deny raises to; "normal" on allows. */
  level?: GuardLevel
  created?: number
}

export interface GuardBuiltinRule {
  id: string
  group: 'critical' | 'high' | 'unanalyzable'
  description: string
  example: string
  default_level: GuardLevel
  level: GuardLevel
  /** Never below high. */
  floor: boolean
}

/** One rule a tested command matched: a built-in id, or `user-deny:<id>` /
 *  `user-allow:<id>` (then `reason` is the pattern). */
export interface GuardMatchedRule {
  id: string
  reason: string
  default_level: GuardLevel
  level: GuardLevel
  user?: 'user-deny' | 'user-allow'
}

export interface GuardAuditEntry {
  id: number | string
  ts: number
  pane_id: string
  vendor: string
  source: GuardSource
  tool: string
  excerpt: string
  level: GuardLevel
  action: GuardAction
  rule_ids: string[] | string
  tainted: boolean
}

export interface GuardTaint {
  pane_id: string
  sources: string[]
  since: number
  detail: string
}

/** One delivery that marked a pane. `message` is the delivered text, looked up
 *  in the message log by `msg_key`; null when no key was minted or the log has
 *  pruned the row. */
export interface GuardTaintEvent {
  id: number
  pane_id: string
  ts: number
  source: string
  detail: string
  msg_key: string
  message: { sender: string; content: string; created_at: number } | null
}

export interface GuardVerdict {
  level: GuardLevel
  rule_ids: string[]
  reasons: string[]
  parseable: boolean
}

export interface GuardDecision {
  action: GuardAction
  level: GuardLevel
  rule_ids: string[]
  reason: string
  tainted: boolean
}

export interface GuardDecisionEvent {
  pane_id: string
  action: GuardEventAction
  level: GuardLevel
  reason: string
  excerpt: string
}

export interface GuardResult<T = Record<string, unknown>> {
  ok: boolean
  data?: T
  error?: string
}

type Backend = Pick<ReturnType<typeof useBackend>, 'send' | 'on' | 'status'>
type Confirm = { nonce: string; expires: string; mac: string } | null

const AUDIT_LIMIT = 50
const LEVEL_ORDER: Record<GuardLevel, number> = { normal: 0, high: 1, critical: 2 }

/** The main process's confirmation for one loosening change, or null when
 *  this window cannot get one (the backend then refuses the change). */
async function confirmFor(action: string, subject: string): Promise<Confirm> {
  try {
    return (await window.agentTeam?.trustConfirm(action, '', subject)) ?? null
  } catch {
    return null
  }
}

function createGuardStore(backend: Backend) {
  /** False until guard.status has answered once: a backend without Guard
   *  leaves every Guard surface hidden instead of showing defaults. */
  const available = ref(false)
  const enabled = ref(true)
  const counts = ref<GuardCounts>({ critical: 0, high: 0, asks: 0, denies_24h: 0 })
  const hookSupport = ref<Record<string, GuardHookSupport>>({})
  const rules = ref<GuardRule[]>([])
  const builtinRules = ref<GuardBuiltinRule[]>([])
  const protectedBranches = ref<string[]>([])
  const audit = ref<GuardAuditEntry[]>([])
  const taint = ref<GuardTaint[]>([])
  const error = ref('')

  async function call<T = Record<string, unknown>>(
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<GuardResult<T>> {
    try {
      const resp = await backend.send<T & { ok?: boolean; error?: string }>(type, payload)
      const body = resp.payload
      if (!resp.ok || !body) return { ok: false, error: resp.error?.message ?? `${type} failed` }
      if (body.ok === false) return { ok: false, error: body.error ?? `${type} failed` }
      return { ok: true, data: body }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function refreshStatus(): Promise<GuardResult> {
    const res = await call<{ enabled: boolean; counts?: GuardCounts; hook_support?: Record<string, GuardHookSupport> }>(
      'guard.status'
    )
    if (res.ok && res.data) {
      available.value = true
      enabled.value = res.data.enabled !== false
      if (res.data.counts) counts.value = { ...counts.value, ...res.data.counts }
      hookSupport.value = res.data.hook_support ?? {}
    }
    return res
  }

  async function refreshTaint(): Promise<GuardResult> {
    const res = await call<{ panes: GuardTaint[] }>('guard.taint.list')
    if (res.ok && res.data) taint.value = res.data.panes ?? []
    return res
  }

  async function refreshAudit(): Promise<GuardResult> {
    const res = await call<{ entries: GuardAuditEntry[] }>('guard.audit.list', { limit: AUDIT_LIMIT })
    if (res.ok && res.data) audit.value = res.data.entries ?? []
    return res
  }

  async function refreshRules(): Promise<GuardResult> {
    const res = await call<{ rules: GuardRule[] }>('guard.rules.list')
    if (res.ok && res.data) rules.value = res.data.rules ?? []
    return res
  }

  type BuiltinState = { rules: GuardBuiltinRule[]; protected_branches: string[] }

  function adoptBuiltin(state: BuiltinState | undefined): void {
    if (state?.rules) builtinRules.value = state.rules
    if (state?.protected_branches) protectedBranches.value = state.protected_branches
  }

  async function refreshBuiltin(): Promise<GuardResult> {
    const res = await call<BuiltinState>('guard.builtin.get')
    if (res.ok) adoptBuiltin(res.data)
    return res
  }

  async function mutateBuiltin(type: string, payload: Record<string, unknown>): Promise<GuardResult> {
    const res = await call<BuiltinState>(type, payload)
    if (res.ok) adoptBuiltin(res.data)
    return res
  }

  async function setRuleLevel(id: string, level: GuardLevel): Promise<GuardResult> {
    const current = builtinRules.value.find((r) => r.id === id)?.level ?? 'critical'
    const payload: Record<string, unknown> = { id, level }
    if (LEVEL_ORDER[level] < LEVEL_ORDER[current]) {
      payload.confirm = await confirmFor('guard.builtin.set_level', `${id}:${level}`)
    }
    return mutateBuiltin('guard.builtin.set_level', payload)
  }

  async function removeBranch(name: string): Promise<GuardResult> {
    const confirm = await confirmFor('guard.branches.remove', name)
    return mutateBuiltin('guard.branches.remove', { name, confirm })
  }

  async function addRule(kind: 'allow' | 'deny', pattern: string, note: string, level: 'critical' | 'high' = 'critical'): Promise<GuardResult> {
    const value = pattern.trim()
    const payload: Record<string, unknown> = { kind, pattern: value, note }
    if (kind === 'deny') payload.level = level
    else payload.confirm = await confirmFor('guard.rules.add', `allow:${value}`)
    return mutate('guard.rules.add', payload, refreshRules)
  }

  async function removeRule(id: GuardRule['id']): Promise<GuardResult> {
    const payload: Record<string, unknown> = { id }
    // Only removing a known allow tightens; anything else may loosen.
    if (rules.value.find((r) => r.id === id)?.kind !== 'allow') {
      payload.confirm = await confirmFor('guard.rules.remove', String(id))
    }
    return mutate('guard.rules.remove', payload, refreshRules)
  }

  /** Everything the Settings page shows. Pane headers only need status + taint. */
  async function refresh(): Promise<void> {
    const results = await Promise.all([refreshStatus(), refreshTaint(), refreshRules(), refreshAudit(), refreshBuiltin()])
    error.value = results.find((r) => !r.ok)?.error ?? ''
  }

  function notifyDecision(ev: GuardDecisionEvent): void {
    const t = i18n.global.t
    const key =
      ev.action === 'deny' ? 'guard.notice.denied' : ev.action === 'error' ? 'guard.notice.failedOpen' : 'guard.notice.asked'
    useNotify().toast(t(key, { reason: ev.reason || t(`guard.level.${ev.level}`) }), {
      type: ev.action === 'ask' ? 'info' : 'error',
      duration: 8000,
      variant: 'security',
    })
  }

  backend.on('guard.decision', (raw) => {
    const ev = raw as GuardDecisionEvent | null
    if (!ev || ev.action === 'allow') return
    notifyDecision(ev)
    void refreshAudit()
    void refreshStatus()
  })
  backend.on('guard.taint_changed', () => {
    void refreshTaint()
  })
  watch(
    () => backend.status.value,
    (s) => {
      if (s === 'connected') {
        void refreshStatus()
        void refreshTaint()
      }
    },
    { immediate: true }
  )

  const taintByPane = computed(() => new Map(taint.value.map((e) => [e.pane_id, e])))

  async function mutate(type: string, payload: Record<string, unknown>, after: () => Promise<GuardResult>): Promise<GuardResult> {
    const res = await call(type, payload)
    if (res.ok) await after()
    return res
  }

  return {
    available,
    enabled,
    counts,
    hookSupport,
    rules,
    builtinRules,
    protectedBranches,
    audit,
    taint,
    error,
    refresh,
    refreshAudit,
    taintFor: (paneId: string): GuardTaint | null => taintByPane.value.get(paneId) ?? null,
    /** 'none' only when the backend says so; unknown vendors stay unknown. */
    hookSupportFor: (vendor: string): GuardHookSupport | null => hookSupport.value[vendor] ?? null,
    setEnabled: (on: boolean) => mutate('guard.set_enabled', { enabled: on }, refreshStatus),
    addRule,
    removeRule,
    setRuleLevel,
    addBranch: (name: string) => mutateBuiltin('guard.branches.add', { name: name.trim() }),
    removeBranch,
    clearTaint: (paneId: string) => mutate('guard.taint.clear', { pane_id: paneId }, refreshTaint),
    taintEvents: (paneId: string) => call<{ events: GuardTaintEvent[] }>('guard.taint.events', { pane_id: paneId }),
    test: (command: string, source: GuardSource, tainted: boolean) =>
      call<{ verdict: GuardVerdict; decision: GuardDecision; matched?: GuardMatchedRule[]; graded_level?: GuardLevel }>(
        'guard.test', { command, source, tainted }),
  }
}

export type GuardStore = ReturnType<typeof createGuardStore>

// One store per backend connection: Settings, every pane header and every
// sidebar row share it, and each `guard.decision` is noticed exactly once.
const stores = new WeakMap<object, GuardStore>()

export function useGuard(backend: Backend): GuardStore {
  let store = stores.get(backend)
  if (!store) {
    store = createGuardStore(backend)
    stores.set(backend, store)
  }
  return store
}

export const guardKey: InjectionKey<GuardStore> = Symbol('guard')
