import { ref } from 'vue'
import type { GitTransport } from '#git-feature'
import {
  GIT_HOST_READ_ONLY_KEYS,
  GIT_USER_PREFERENCE_KEYS,
  GIT_WORKSPACE_REPOSITORY_KEY,
} from '#git-feature'
import type {
  GitAccountPort,
  GitAccountPublic,
  GitBranchDiffPort,
  GitFileAccessPort,
  GitFileReadResult,
  GitFileWriteResult,
  GitWindowUiPort,
  GitPaneUiPort,
  GitReviewPort,
  GitReviewResult,
  IssuePort,
  LegacyRepoSelectionPort,
} from './ports/gitSurface'
import type { PortResponse } from '@navide/plugin-ui/shared'
import type { KeybindingsPort } from '@navide/plugin-ui/shared'
import type { SettingsBackend } from '@navide/plugin-ui/shared'
import type { Issue, IssueDetail, IssueProviderInfo } from './composables/useIssues'
import type { GitTransportStatusSource } from '#git-feature'
import type { GitContributionAction, GitContributionState } from './ports/gitContribution'
import type { GitWorkspaceGrantPort } from './ports/gitSurface'
import { navBridge } from './capabilityBackend'

export interface PluginCapabilitySdk {
  readonly status: GitTransportStatusSource
  readonly shell: { readonly value: string }
  readonly autoRestart: { readonly value: { attempt: number; max: number; reason: string } | null }
  request<TPayload = unknown>(
    type: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<PortResponse<TPayload>>
  subscribe(type: string, callback: (payload: unknown) => void): () => void
  hostRequest<TPayload = unknown>(
    action: string,
    payload?: Record<string, unknown>,
  ): Promise<PortResponse<TPayload>>
}

export interface PluginGitContributionHostPort {
  getState(): Promise<GitContributionState | null>
  dispatch(action: GitContributionAction): Promise<void>
  onStateChanged(callback: (state: GitContributionState) => void): () => void
}

function isManifestV2Runtime(): boolean {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('v2') === '1'
}

/** Bind the capability backend closure once at the plugin composition root. */
export function createPluginCapabilitySdk(backend: {
  status: GitTransportStatusSource
  shell: { readonly value: string }
  autoRestart: { readonly value: { attempt: number; max: number; reason: string } | null }
  send: <TPayload = unknown>(type: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<PortResponse<TPayload>>
  on: (type: string, callback: (payload: unknown) => void) => () => void
}): PluginCapabilitySdk {
  async function hostRequest<TPayload = unknown>(
    action: string,
    payload: Record<string, unknown> = {},
  ): Promise<PortResponse<TPayload>> {
    const call = navBridge().callHostAction
    if (!call) {
      return { ok: false, payload: null, error: { code: 'CAPABILITY_DENIED', message: 'Host action is unavailable' } }
    }
    let response: Awaited<ReturnType<typeof call>>
    try {
      response = await call(action, payload)
    } catch (error) {
      // An IPC rejection must reach callers as a failed response, like every other failure.
      return { ok: false, payload: null, error: { code: 'BROKER_ERROR', message: error instanceof Error ? error.message : 'Host action failed' } }
    }
    return {
      ok: response.ok,
      payload: response.ok ? (response.result as TPayload ?? null) : null,
      error: response.error ? { code: response.error.code, message: response.error.message ?? '' } : null,
    }
  }
  return {
    status: backend.status,
    shell: backend.shell,
    autoRestart: backend.autoRestart,
    request: backend.send,
    subscribe: backend.on,
    hostRequest,
  }
}

function capabilityError(response: { error: { message: string } | null }): Error {
  return new Error(response.error?.message || 'Plugin capability failed')
}

async function requireOk<T>(promise: Promise<PortResponse<T>>): Promise<T | null> {
  const response = await promise
  if (!response.ok) throw capabilityError(response)
  return response.payload
}

export function createPluginGitFileAccessPort(sdk: PluginCapabilitySdk): GitFileAccessPort {
  return {
    async readFile(workspacePath: string, relPath: string): Promise<GitFileReadResult> {
      const response = await sdk.request<{ ok: boolean; content: string; error?: string }>('fs.read_file', {
        workspace_path: workspacePath,
        rel_path: relPath,
      })
      return {
        ok: response.ok && response.payload?.ok === true,
        content: response.payload?.content ?? '',
        error: response.payload?.error || response.error?.message,
      }
    },
    async writeFile(workspacePath: string, relPath: string, content: string): Promise<GitFileWriteResult> {
      const response = await sdk.request<{ ok: boolean; error?: string }>('fs.write_file', {
        workspace_path: workspacePath,
        rel_path: relPath,
        content,
      })
      return {
        ok: response.ok && response.payload?.ok === true,
        error: response.payload?.error || response.error?.message,
      }
    },
    async readImage(workspacePath: string, relPath: string): Promise<string> {
      const response = await sdk.request<{ ok: boolean; data_url?: string }>('fs.read_image', {
        workspace_path: workspacePath,
        rel_path: relPath,
      })
      return response.ok && response.payload?.ok ? (response.payload.data_url ?? '') : ''
    },
  }
}

export function createPluginGitUiPort(sdk: PluginCapabilitySdk): GitWindowUiPort {
  return {
    async openInEditor({ workspacePath, filepath, line }) {
      const outcome = await requireOk<{ opened?: boolean; error?: string }>(sdk.request('ui.open_in_editor', {
        workspace_path: workspacePath,
        filepath,
        ...(line === undefined ? {} : { line }),
      }))
      return { opened: outcome?.opened !== false, ...(outcome?.error ? { error: outcome.error } : {}) }
    },
    async openExternal(url: string): Promise<void> {
      await requireOk(sdk.request('ui.open_external', { url }))
    },
    async revealPath(path: string): Promise<void> {
      await requireOk(sdk.request('ui.reveal_path', { path }))
    },
    async pickFolder(defaultPath?: string): Promise<string | null> {
      const payload = await requireOk<{ ok: boolean; path: string | null }>(sdk.request('ui.pick_folder', {
        ...(defaultPath ? { default_path: defaultPath } : {}),
      }))
      return payload?.path ?? null
    },
  }
}

export function createPluginGitBranchDiffPort(sdk: PluginCapabilitySdk): GitBranchDiffPort {
  return {
    async load(workspacePath: string, base: string, compare: string) {
      const response = await sdk.request<{ ok: boolean; diff: string; error?: string }>('git.diff_branches', {
        workspace_path: workspacePath,
        base,
        compare: compare || '',
      })
      return {
        ok: response.ok && response.payload?.ok === true,
        diff: response.payload?.diff ?? '',
        error: response.payload?.error || response.error?.message,
      }
    },
  }
}

function hostPayload<T>(sdk: PluginCapabilitySdk, operation: string, payload: Record<string, unknown> = {}) {
  return sdk.hostRequest<T>('git.account', { operation, payload })
}

export function createPluginGitAccountPort(sdk: PluginCapabilitySdk): GitAccountPort {
  const accounts = ref<GitAccountPublic[]>([])
  const available = ref(false)
  const refresh = async (): Promise<void> => {
    const payload = await requireOk<{ accounts: Array<Record<string, unknown>>; available: boolean }>(
      hostPayload(sdk, 'list'),
    )
    accounts.value = (payload?.accounts ?? []).flatMap((account) => {
      if (
        typeof account.id !== 'string' ||
        typeof account.label !== 'string' ||
        typeof account.host !== 'string' ||
        typeof account.username !== 'string' ||
        typeof account.tokenLast4 !== 'string'
      ) return []
      return [{
        id: account.id,
        label: account.label,
        host: account.host,
        username: account.username,
        tokenLast4: account.tokenLast4,
      }]
    })
    available.value = payload?.available === true
  }
  return {
    accounts,
    available,
    refresh,
    async addAccount(input): Promise<boolean> {
      try {
        const payload = await requireOk<{ ok?: boolean }>(hostPayload(sdk, 'add', { ...input }))
        if (payload?.ok === false) return false
        await refresh()
        return true
      } catch { return false }
    },
    async bind(accountId): Promise<boolean> {
      try {
        const payload = await requireOk<{ ok?: boolean }>(hostPayload(sdk, 'bind', { accountId }))
        return payload?.ok !== false
      } catch { return false }
    },
    async unbind(): Promise<boolean> {
      try {
        const payload = await requireOk<{ ok?: boolean }>(hostPayload(sdk, 'unbind'))
        return payload?.ok !== false
      } catch { return false }
    },
    async getBinding(): Promise<string | null> {
      try {
        const payload = await requireOk<{ accountId?: string | null }>(hostPayload(sdk, 'get_binding'))
        return payload?.accountId ?? null
      } catch { return null }
    },
  }
}

export function createPluginGitPaneUiPort(sdk: PluginCapabilitySdk): GitPaneUiPort {
  const windowUi = createPluginGitUiPort(sdk)
  const request = <TPayload = unknown>(operation: string, payload: Record<string, unknown> = {}) =>
    requireOk<TPayload>(sdk.hostRequest('git.contribution', { operation, payload }))
  return {
    async openInEditor(args) { await windowUi.openInEditor(args) },
    openExternal: windowUi.openExternal,
    revealPath: windowUi.revealPath,
    async openPath(path) { await request('open_path', { path }) },
    async openTempFile(name, content) { await request('open_temp_file', { name, content }) },
    async pickWorkspace(defaultPath) {
      const payload = await request<{ path: string | null; grant: string | null }>('pick_workspace', {
        ...(defaultPath ? { default_path: defaultPath } : {}),
      })
      return typeof payload?.path === 'string' && typeof payload.grant === 'string'
        ? { path: payload.path, grant: payload.grant }
        : null
    },
    async openMainWindow(workspacePath) { await request('open_main_window', { workspace_path: workspacePath }) },
    async openBranchDiffWindow(workspacePath, base) {
      await request('open_branch_diff_window', { workspace_path: workspacePath, base })
    },
    async openGitWindow(args) {
      await request('open_git_window', {
        workspace_path: args.workspacePath,
        ...(args.filepath === undefined ? {} : { filepath: args.filepath }),
        ...(args.staged === undefined ? {} : { staged: args.staged }),
        ...(args.commit === undefined ? {} : { commit: args.commit }),
        ...(args.base === undefined ? {} : { base: args.base }),
        ...(args.compare === undefined ? {} : { compare: args.compare }),
      })
    },
    async openGitHistoryWindow(workspacePath) {
      await request('open_git_history_window', { workspace_path: workspacePath })
    },
  }
}

/** The standalone Git window needs picker provenance without gaining the
 * generic workspace-opening UI port. */
export function createPluginGitWorkspaceGrantPort(sdk: PluginCapabilitySdk): GitWorkspaceGrantPort {
  const request = <TPayload = unknown>(operation: string, payload: Record<string, unknown> = {}) =>
    requireOk<TPayload>(sdk.hostRequest('git.contribution', { operation, payload }))
  return {
    async pickWorkspace(defaultPath) {
      const payload = await request<{ path: string | null; grant: string | null }>('pick_workspace', {
        ...(defaultPath ? { default_path: defaultPath } : {}),
      })
      return typeof payload?.path === 'string' && typeof payload.grant === 'string'
        ? { path: payload.path, grant: payload.grant }
        : null
    },
    async openWorkspace(selection) {
      await request('open_workspace', { path: selection.path, grant: selection.grant })
    },
    async openKnownWorktree(path) {
      await request('open_worktree', { path })
    },
  }
}

export function createPluginLegacyRepoSelectionPort(sdk: PluginCapabilitySdk): LegacyRepoSelectionPort {
  return {
    async readLegacyRepoSelection() {
      try {
        const payload = await requireOk<{ selection?: string | null }>(
          sdk.hostRequest('git.legacyRepoSelection', {}),
        )
        return typeof payload?.selection === 'string' ? payload.selection : null
      } catch {
        return null
      }
    },
  }
}

export function createPluginGitContributionHostPort(sdk: PluginCapabilitySdk): PluginGitContributionHostPort {
  return {
    async getState(): Promise<GitContributionState | null> {
      return requireOk<GitContributionState | null>(sdk.hostRequest('git.contribution', { operation: 'get_state' }))
    },
    async dispatch(action: GitContributionAction): Promise<void> {
      const payload = 'payload' in action ? action.payload : (() => {
        switch (action.operation) {
          case 'changes_count': return { count: action.count }
          case 'open_workspace': return { path: action.path, grant: action.grant }
          case 'focus_pane': return { paneId: action.paneId }
          case 'open_path': return { path: action.path }
          case 'open_temp_file': return { name: action.name, content: action.content }
          case 'open_main_window': return { workspace_path: action.workspace_path }
          case 'open_branch_diff_window': return { workspace_path: action.workspace_path, base: action.base }
          case 'open_git_window': return {
            workspace_path: action.workspace_path,
            ...(action.filepath === undefined ? {} : { filepath: action.filepath }),
            ...(action.staged === undefined ? {} : { staged: action.staged }),
            ...(action.commit === undefined ? {} : { commit: action.commit }),
            ...(action.base === undefined ? {} : { base: action.base }),
            ...(action.compare === undefined ? {} : { compare: action.compare }),
          }
          case 'open_git_history_window': return { workspace_path: action.workspace_path }
          case 'open_git_accounts': return {}
          case 'execute_host_command': return { command: action.command }
        }
      })()
      await requireOk(sdk.hostRequest('git.contribution', {
        operation: action.operation,
        payload,
      }))
    },
    onStateChanged(callback) {
      return sdk.subscribe('git.contribution.state', (payload) => {
        if (payload && typeof payload === 'object') callback(payload as GitContributionState)
      })
    },
  }
}

export function createPluginKeybindingsPort(): KeybindingsPort {
  return {}
}

export function createPluginIssuePort(sdk: PluginCapabilitySdk): IssuePort {
  return {
    provider: (workspacePath) => sdk.request<IssueProviderInfo>('issues.provider', { workspace_path: workspacePath }),
    list: (workspacePath, limit) => sdk.request<{ ok: boolean; provider: string; issues: Issue[]; error?: string }>(
      'issues.list', { workspace_path: workspacePath, limit }, 30_000,
    ),
    get: (workspacePath, number) => sdk.request<{ ok: boolean; issue: IssueDetail; error?: string }>(
      'issues.get', { workspace_path: workspacePath, number }, 30_000,
    ),
    create: (workspacePath, title, body) => sdk.request<{ ok: boolean; url?: string; error?: string }>(
      'issues.create', { workspace_path: workspacePath, title, body }, 30_000,
    ),
    comment: (workspacePath, number, body) => sdk.request<{ ok: boolean; error?: string }>(
      'issues.comment', { workspace_path: workspacePath, number, body }, 30_000,
    ),
    setState: (workspacePath, number, state) => sdk.request<{ ok: boolean; error?: string }>(
      'issues.set_state', { workspace_path: workspacePath, number, state }, 30_000,
    ),
  }
}

export function createPluginGitReviewPort(sdk: PluginCapabilitySdk): GitReviewPort {
  async function call<TPayload>(type: string, payload: Record<string, unknown> = {}): Promise<TPayload> {
    const response = await sdk.request<TPayload>(type, payload)
    if (!response.ok || response.payload === null) {
      throw new Error(response.error?.message || `${type} failed`)
    }
    return response.payload
  }
  function onReview(event: string, callback: (payload: Record<string, unknown> & { reviewId: string }) => void): () => void {
    return sdk.subscribe(event, (payload) => {
      const record = payload as Record<string, unknown> | null
      if (record && typeof record.reviewId === 'string') {
        callback(record as Record<string, unknown> & { reviewId: string })
      }
    })
  }
  return {
    async start({ mode, base, compare }) {
      const started = await call<{ reviewId: string }>('aiCli.reviewStart', {
        mode,
        ...(base === undefined ? {} : { base }),
        ...(compare === undefined ? {} : { compare }),
      })
      return started.reviewId
    },
    async stop(reviewId) {
      await call('aiCli.reviewStop', { reviewId })
    },
    onResult: (callback) => onReview('aiCli.reviewResult', (p) => callback(p.reviewId, p.result as GitReviewResult)),
    onEnd: (callback) => onReview('aiCli.reviewEnd', (p) => callback(p.reviewId)),
    onError: (callback) => onReview('aiCli.reviewError', (p) => callback(p.reviewId, String(p.message ?? ''))),
    getModelPreferences: () => call<{ provider: string; model: string }>('aiCli.getModelPreferences'),
    async setModelPreferences(provider, model) {
      await call('aiCli.setModelPreferences', { provider, model })
    },
    async listModels() {
      const listed = await call<{ ok: boolean; models?: Array<{ name: string }> }>('aiCli.listModels')
      return (listed.models ?? []).map((m) => m.name).filter(Boolean)
    },
  }
}

export function createPluginGitSettingsPort(sdk: PluginCapabilitySdk): SettingsBackend {
  if (isManifestV2Runtime()) {
    const keys = [...GIT_USER_PREFERENCE_KEYS, GIT_WORKSPACE_REPOSITORY_KEY] as const
    const warnedKeys = new Set<string>()
    const scopeFor = (key: string): 'plugin' | 'workspace' =>
      key === GIT_WORKSPACE_REPOSITORY_KEY ? 'workspace' : 'plugin'
    const warnUnsupportedKey = (key: string): void => {
      const dev = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true
      if (!dev || warnedKeys.has(key)) return
      warnedKeys.add(key)
      console.warn(`[git-settings] ignored non-owned key '${key}'`)
    }
    return {
      status: sdk.status,
      ownedKeys: keys,
      readOnlyKeys: GIT_HOST_READ_ONLY_KEYS,
      async getAll(): Promise<Record<string, unknown> | null> {
        const entries: Array<[string, unknown]> = []
        await Promise.all(keys.map(async (key) => {
          const response = await sdk.request<{ found: boolean; value: unknown }>('storage.get', {
            scope: scopeFor(key),
            key,
          })
          if (!response.ok) throw capabilityError(response)
          if (response.payload?.found) entries.push([key, response.payload.value])
        }))
        return Object.fromEntries(entries)
      },
      async setMany(updates: Record<string, unknown>): Promise<void> {
        for (const key of Object.keys(updates)) {
          if (!keys.includes(key as typeof keys[number])) warnUnsupportedKey(key)
        }
        for (const key of keys) {
          if (!(key in updates)) continue
          const scope = scopeFor(key)
          const response = updates[key] === null
            ? await sdk.request('storage.delete', { scope, key })
            : await sdk.request('storage.set', { scope, key, value: updates[key] })
          if (!response.ok) throw capabilityError(response)
        }
      },
      onChanged: (callback) => sdk.subscribe('ui.settings_changed', callback),
    }
  }
  return {
    status: sdk.status,
    async getAll(): Promise<Record<string, unknown> | null> {
      const payload = await requireOk<{ settings?: Record<string, unknown> }>(sdk.request('ui.settings.get', {}))
      return payload?.settings ?? null
    },
    async setMany(updates: Record<string, unknown>): Promise<void> {
      await requireOk(sdk.request('ui.settings.set', { updates }))
    },
    onChanged: (callback) => sdk.subscribe('ui.settings_changed', callback),
  }
}

export function createPluginGitSurfacePorts(sdk: PluginCapabilitySdk, gitTransport: GitTransport) {
  return {
    gitTransport,
    fileAccess: createPluginGitFileAccessPort(sdk),
    ui: createPluginGitUiPort(sdk),
    paneUi: createPluginGitPaneUiPort(sdk),
    branchDiff: createPluginGitBranchDiffPort(sdk),
    accounts: createPluginGitAccountPort(sdk),
    issues: createPluginIssuePort(sdk),
  }
}
