import { ref } from 'vue'
import type { GitTransport } from '../../../shared/gitCompatibility'
import type {
  GitAccountViewPort,
  GitAccountPublic,
  GitBranchDiffPort,
  GitCredentialPort,
  GitFileAccessPort,
  GitFileReadResult,
  GitFileWriteResult,
  GitSettingsPort,
  GitWindowUiPort,
  IssuePort,
} from '../../src/ports/gitSurface'
import type { PortResponse, KeybindingsPort } from '@navide/plugin-ui/shared'
import type {
  TerminalCreateRequest,
  TerminalDockPort,
  TerminalExitEvent,
  TerminalFileListResult,
  TerminalOutputEvent,
} from '@navide/terminal'
import type { Issue, IssueDetail, IssueProviderInfo } from '../../src/composables/useIssues'
import type { GitTransportStatusSource } from '../../../shared/gitCompatibility'
import { pinFreshSessionAtLaunch } from '../../src/lib/sessionHeal'
import { dockRestoreFromResponse } from '../../src/lib/dockWindow'

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
}

/** Bind the capability backend closure once at the plugin composition root. */
export function createPluginCapabilitySdk(backend: {
  status: GitTransportStatusSource
  shell: { readonly value: string }
  autoRestart: { readonly value: { attempt: number; max: number; reason: string } | null }
  send: <TPayload = unknown>(type: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<PortResponse<TPayload>>
  on: (type: string, callback: (payload: unknown) => void) => () => void
}): PluginCapabilitySdk {
  return {
    status: backend.status,
    shell: backend.shell,
    autoRestart: backend.autoRestart,
    request: backend.send,
    subscribe: backend.on,
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
    async openInEditor({ workspacePath, filepath, line }): Promise<void> {
      await requireOk(sdk.request('ui.open_in_editor', {
        workspace_path: workspacePath,
        filepath,
        ...(line === undefined ? {} : { line }),
      }))
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
    async openWorkspace(path: string): Promise<void> {
      await requireOk(sdk.request('ui.open_workspace', { workspace_path: path }))
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

export function createPluginGitCredentialPort(): GitCredentialPort {
  return {}
}

export function createPluginGitAccountPort(): GitAccountViewPort {
  const accounts = ref<GitAccountPublic[]>([])
  const available = ref(false)
  return { accounts, available }
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

export function createPluginGitSettingsPort(sdk: PluginCapabilitySdk): GitSettingsPort {
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

export function createPluginTerminalDockPort(sdk: PluginCapabilitySdk): TerminalDockPort {
  const request = <T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number) =>
    timeoutMs === undefined ? sdk.request<T>(type, payload) : sdk.request<T>(type, payload, timeoutMs)
  return {
    status: sdk.status,
    shell: sdk.shell,
    autoRestart: sdk.autoRestart,
    input: (sessionId, data, timeoutMs, opts) => request('terminal.input', { terminal_session_id: sessionId, data, ...(opts?.human ? { human: true } : {}) }, timeoutMs),
    create: (requestBody: TerminalCreateRequest, timeoutMs) => request('terminal.create', {
      pane_id: requestBody.paneId,
      create_generation: requestBody.createGeneration,
      agent_key: requestBody.agentKey,
      command: requestBody.command,
      cwd: requestBody.cwd,
      env: requestBody.env,
      cols: requestBody.cols,
      rows: requestBody.rows,
      metadata: requestBody.metadata,
      output_log_file: requestBody.outputLogFile,
      login_profile_id: requestBody.loginProfileId,
      is_login: requestBody.isLogin,
      ...(requestBody.accountDirLogin ? { account_dir_login: true } : {}),
      replaces_terminal_id: requestBody.replacesTerminalId,
      ...(requestBody.quotaTransactionId ? { quota_transaction_id: requestBody.quotaTransactionId } : {}),
      ...(requestBody.quotaOriginalPaneId ? { quota_original_pane_id: requestBody.quotaOriginalPaneId } : {}),
    }, timeoutMs),
    cancelCreate: (paneId, createGeneration) => request('terminal.create.cancel', {
      pane_id: paneId,
      create_generation: createGeneration,
    }),
    reattach: (sessionIds, cols, rows) => request('terminal.reattach', {
      terminal_session_ids: sessionIds,
      cols,
      rows,
    }),
    resize: (sessionId, cols, rows) => request('terminal.resize', {
      terminal_session_id: sessionId,
      cols,
      rows,
    }),
    interrupt: (sessionId) => request('terminal.interrupt', { terminal_session_id: sessionId }),
    kill: (sessionId, force, options) => request('terminal.kill', {
      terminal_session_id: sessionId,
      force,
      ...(options?.retireRestore ? { retire_restore: true } : {}),
    }),
    redraw: (sessionId, cols, rows) => request('terminal.redraw', {
      terminal_session_id: sessionId,
      cols,
      rows,
    }),
    onOutput: (callback: (payload: TerminalOutputEvent) => void) =>
      sdk.subscribe('terminal.output', (payload) => callback(payload as TerminalOutputEvent)),
    onExit: (callback: (payload: TerminalExitEvent) => void) =>
      sdk.subscribe('terminal.exit', (payload) => callback(payload as TerminalExitEvent)),
    listFiles: (workspacePath, query, maxResults) => request<TerminalFileListResult>('fs.list_files_flat', {
      workspace_path: workspacePath,
      query,
      max_results: maxResults,
    }),
    listAgentPanes: () => request('agent_msg.list', {}),
    registerAgentPane: (pane) => request('agent_msg.register_dock', { ...pane }),
    unregisterAgentPane: (paneId) => request('agent_msg.unregister_dock', { pane_id: paneId }),
    // No onAgentMessage / reportAgentDelivery: the broker does not forward
    // agent_msg.* events, so this panel registers as not deliverable.
    pinFreshSessionAtLaunch,
    // The panel's restore record, so it resumes after an app quit as the host
    // windows' panels do (read-only; panel records only — see capabilityMap).
    async readDockRestore(workspacePath, paneId) {
      return dockRestoreFromResponse(await request<{ record?: { agent?: string; session_id?: string } | null }>(
        'terminal.dock_record', { workspace_path: workspacePath, pane_id: paneId },
      ))
    },
    statPath: (path, timeoutMs) => request('fs.stat_path', { path }, timeoutMs),
    openFile: async ({ workspacePath, filepath, line }) => {
      await requireOk(sdk.request('ui.open_in_editor', {
        workspace_path: workspacePath,
        filepath,
        ...(line === undefined ? {} : { line }),
      }))
    },
    openExternal: async (url) => { await requireOk(sdk.request('ui.open_external', { url })) },
  }
}

export function createPluginGitSurfacePorts(sdk: PluginCapabilitySdk, gitTransport: GitTransport) {
  return {
    gitTransport,
    fileAccess: createPluginGitFileAccessPort(sdk),
    ui: createPluginGitUiPort(sdk),
    branchDiff: createPluginGitBranchDiffPort(sdk),
    credentials: createPluginGitCredentialPort(),
    accounts: createPluginGitAccountPort(),
    issues: createPluginIssuePort(sdk),
  }
}
