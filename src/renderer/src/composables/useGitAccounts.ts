import { ref } from 'vue'

// The gitAccounts IPC surface and its DTOs are declared on Window in env.d.ts,
// but those DTO interfaces are module-scoped there (not exported / not global),
// so they cannot be named across module boundaries. We re-declare the public
// shapes here; they are structurally identical to the IPC types.
type GitAccountsApi = NonNullable<NonNullable<Window['agentTeam']>['gitAccounts']>

/** Host-owned Git accounts: tokens stay in the Host vault; the renderer only
 *  ever sees the last four characters. */
export interface GitAccountPublic {
  id: string
  label: string
  host: string
  username: string
  tokenLast4: string
}

export interface GitAccountInput {
  label: string
  host: string
  username: string
  token: string
}

/**
 * Renderer-side wrapper around the safeStorage-backed git-accounts store
 * exposed on `window.agentTeam.gitAccounts`. Provides reactive `accounts`,
 * `available` (safeStorage usable), `loading`, `error`, plus CRUD + workspace
 * binding helpers. Mirrors the ref-returning composable style used elsewhere.
 */
export function useGitAccounts() {
  const accounts = ref<GitAccountPublic[]>([])
  const available = ref(true)
  const loading = ref(false)
  const error = ref('')

  function api(): GitAccountsApi | undefined {
    return window.agentTeam?.gitAccounts
  }

  async function refresh(): Promise<void> {
    const g = api()
    if (!g) {
      available.value = false
      error.value = 'git-accounts-unavailable'
      return
    }
    loading.value = true
    error.value = ''
    try {
      const avail = await g.isAvailable()
      available.value = avail.ok ? avail.available ?? false : false
      const resp = await g.list()
      if (!resp.ok) {
        error.value = resp.error ?? 'failed to list accounts'
        return
      }
      accounts.value = resp.accounts ?? []
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
    }
  }

  async function addAccount(input: GitAccountInput): Promise<boolean> {
    const g = api()
    if (!g) return false
    error.value = ''
    try {
      const resp = await g.add(input)
      if (!resp.ok) {
        error.value = resp.error ?? 'failed to add account'
        return false
      }
      await refresh()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  async function updateAccount(id: string, patch: Partial<GitAccountInput>): Promise<boolean> {
    const g = api()
    if (!g) return false
    error.value = ''
    try {
      const resp = await g.update(id, patch)
      if (!resp.ok) {
        error.value = resp.error ?? 'failed to update account'
        return false
      }
      await refresh()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  async function removeAccount(id: string): Promise<boolean> {
    const g = api()
    if (!g) return false
    error.value = ''
    try {
      const resp = await g.remove(id)
      if (!resp.ok) {
        error.value = resp.error ?? 'failed to remove account'
        return false
      }
      await refresh()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  async function bind(workspacePath: string, accountId: string): Promise<boolean> {
    const g = api()
    if (!g) return false
    error.value = ''
    try {
      const resp = await g.bind(workspacePath, accountId)
      if (!resp.ok) {
        error.value = resp.error ?? 'failed to bind account'
        return false
      }
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  async function unbind(workspacePath: string): Promise<boolean> {
    const g = api()
    if (!g) return false
    error.value = ''
    try {
      const resp = await g.unbind(workspacePath)
      if (!resp.ok) {
        error.value = resp.error ?? 'failed to unbind account'
        return false
      }
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  async function getBinding(workspacePath: string): Promise<string | null> {
    const g = api()
    if (!g) return null
    try {
      const resp = await g.getBinding(workspacePath)
      if (!resp.ok) {
        error.value = resp.error ?? 'failed to read binding'
        return null
      }
      return resp.accountId ?? null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return null
    }
  }

  return {
    accounts,
    available,
    loading,
    error,
    refresh,
    addAccount,
    updateAccount,
    removeAccount,
    bind,
    unbind,
    getBinding
  }
}
