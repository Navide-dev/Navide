import { onScopeDispose, ref, shallowRef } from 'vue'
import type { useBackend } from './useBackend'
import type { RoleProperty } from '../lib/pipelineGraph'

/** One stage slot that still names a role, as reported by a ROLE_IN_USE
 *  rejection. Deleting the role is refused until every slot is repointed. */
export interface RoleUsage {
  pipeline_id: string
  pipeline_name: string
  stage_id: string
  stage_title: string
  slot_label: string
}

/** Outcome of roles.rename. The failure arm carries the backend code because
 *  ROLE_KEY_EXISTS needs different advice from every other rejection. */
export type RoleRenameOutcome =
  | { ok: true; role: Role; repointedPipelineIds: string[] }
  | { ok: false; code: string; message: string }

export interface Role {
  key: string
  label: string
  one_line: string
  system_prompt: string
  is_default?: boolean
  /** Declarative fields a pipeline step using this role can set (the node
   *  inspector's form). See RoleProperty in lib/pipelineGraph. */
  properties?: RoleProperty[]
  created_at?: string
  updated_at?: string
}

/**
 * Per-window roles cache. Loads from backend on mount and refreshes whenever
 * the backend broadcasts a `roles.changed` event (triggered by any window's
 * upsert / delete / reset). Reconnect-safe.
 */
/** ROLE_IN_USE carries the offending slots in error.details.usages. The wire
 *  shape is untyped, so keep only the entries that are objects and default the
 *  fields the UI reads. */
function readRoleUsages(details: Record<string, unknown> | undefined): RoleUsage[] {
  const raw = details?.usages
  if (!Array.isArray(raw)) return []
  return raw
    .filter((u): u is Record<string, unknown> => !!u && typeof u === 'object')
    .map((u) => ({
      pipeline_id: String(u.pipeline_id ?? ''),
      pipeline_name: String(u.pipeline_name ?? ''),
      stage_id: String(u.stage_id ?? ''),
      stage_title: String(u.stage_title ?? ''),
      slot_label: String(u.slot_label ?? ''),
    }))
}

export function useRoles(backend: ReturnType<typeof useBackend>) {
  const roles = ref<Role[]>([])
  const path = shallowRef<string>('')
  const loaded = ref<boolean>(false)
  const loading = ref<boolean>(false)
  const error = ref<string>('')
  /** Slots blocking the last rejected delete; empty unless it was ROLE_IN_USE. */
  const roleUsages = ref<RoleUsage[]>([])

  let unsubChanged: (() => void) | null = null
  let unsubBackend: (() => void) | null = null

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      const resp = await backend.send<{ roles: Role[]; path: string }>('roles.list', {})
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'failed to load roles'
        return
      }
      roles.value = resp.payload.roles
      path.value = resp.payload.path
      loaded.value = true
    } catch (err) {
      error.value = String((err as Error).message ?? err)
    } finally {
      loading.value = false
    }
  }

  async function upsert(input: {
    key: string
    label: string
    one_line: string
    system_prompt: string
    /** Declarative node-settings fields; omitted = leave the role's as is. */
    properties?: unknown[]
  }): Promise<Role | null> {
    try {
      const resp = await backend.send<{ role: Role; roles: Role[] }>('roles.upsert', {
        key: input.key,
        label: input.label,
        one_line: input.one_line,
        system_prompt: input.system_prompt,
        ...(input.properties ? { properties: input.properties } : {})
      })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'upsert failed'
        return null
      }
      roles.value = resp.payload.roles
      return resp.payload.role
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'upsert failed'
      return null
    }
  }

  /** Change a role's key. The backend repoints the stage slots naming it and
   *  drops the old key in one step; doing it here as upsert-then-delete stalls
   *  halfway, because roles.delete refuses while a slot still names the role. */
  async function rename(
    oldKey: string,
    input: { key: string; label: string; one_line: string; system_prompt: string; properties?: unknown[] }
  ): Promise<RoleRenameOutcome> {
    try {
      const resp = await backend.send<{
        role: Role
        roles: Role[]
        repointed_pipeline_ids: string[]
      }>('roles.rename', {
        old_key: oldKey,
        new_key: input.key,
        label: input.label,
        one_line: input.one_line,
        system_prompt: input.system_prompt,
        ...(input.properties ? { properties: input.properties } : {})
      })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'rename failed'
        return { ok: false, code: resp.error?.code ?? '', message: error.value }
      }
      roles.value = resp.payload.roles
      return {
        ok: true,
        role: resp.payload.role,
        repointedPipelineIds: resp.payload.repointed_pipeline_ids ?? []
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'rename failed'
      return { ok: false, code: '', message: error.value }
    }
  }

  async function remove(key: string): Promise<boolean> {
    roleUsages.value = []
    try {
      const resp = await backend.send<{ roles: Role[] }>('roles.delete', { key })
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'delete failed'
        roleUsages.value = readRoleUsages(resp.error?.details)
        return false
      }
      roles.value = resp.payload.roles
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'delete failed'
      return false
    }
  }

  async function reset(): Promise<boolean> {
    try {
      const resp = await backend.send<{ roles: Role[] }>('roles.reset', {})
      if (!resp.ok || !resp.payload) {
        error.value = resp.error?.message ?? 'reset failed'
        return false
      }
      roles.value = resp.payload.roles
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'reset failed'
      return false
    }
  }

  function find(key: string): Role | undefined {
    return roles.value.find((r) => r.key === key)
  }

  // Subscribe to backend broadcasts so the cache stays in sync across windows.
  unsubChanged = backend.on('roles.changed', (raw) => {
    const payload = raw as { roles: Role[] }
    if (payload?.roles) roles.value = payload.roles
  })

  // Initial load — wait until backend is connected then fetch. Also re-fetch
  // on reconnect.
  let lastStatus = backend.status.value
  function maybeLoad(): void {
    if (backend.status.value === 'connected') void refresh()
  }
  maybeLoad()
  unsubBackend = (() => {
    const id = window.setInterval(() => {
      if (backend.status.value !== lastStatus) {
        lastStatus = backend.status.value
        maybeLoad()
      }
    }, 500)
    return () => window.clearInterval(id)
  })()

  onScopeDispose(() => {
    unsubChanged?.()
    unsubBackend?.()
  })

  return {
    roles, path, loaded, loading, error, roleUsages,
    refresh, upsert, rename, remove, reset, find
  }
}
