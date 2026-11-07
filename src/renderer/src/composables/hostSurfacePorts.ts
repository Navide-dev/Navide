import { shellCommandArgv } from '../../../shared/osplat'
import type { useBackend } from './useBackend'
import type { KeybindingsPort } from '@navide/plugin-ui/shared'
import { encodeReason } from './useAgentMessaging'
import { hasReplyRoute, isExternalDelivery, renderEnvelope } from '../lib/agentMessaging'
import { pinFreshSessionAtLaunch } from '../lib/sessionHeal'
import { dockRestoreFromResponse } from '../lib/dockWindow'
import type {
  DockAgentMessage,
  TerminalCreateRequest,
  TerminalDockPort,
  TerminalExitEvent,
  TerminalFileListResult,
  TerminalOutputEvent,
} from '@navide/terminal'

type HostBackend = ReturnType<typeof useBackend>

export function createHostKeybindingsPort(): KeybindingsPort {
  const agentTeam = window.agentTeam
  const port: KeybindingsPort = {}
  if (agentTeam?.readKeybindings) port.read = () => agentTeam.readKeybindings()
  if (agentTeam?.writeKeybindings) port.write = (content) => agentTeam.writeKeybindings(content)
  if (agentTeam?.onKeybindingsChanged) {
    port.onChanged = (callback) => {
      agentTeam.onKeybindingsChanged!(callback)
      return () => {}
    }
  }
  return port
}

export function createHostTerminalDockPort(backend: HostBackend): TerminalDockPort {
  const send = <T = unknown>(type: string, payload: Record<string, unknown> = {}, timeoutMs?: number) =>
    timeoutMs === undefined ? backend.send<T>(type, payload) : backend.send<T>(type, payload, timeoutMs)
  return {
    status: backend.status,
    shell: backend.shell,
    spawnArgv: shellCommandArgv,
    autoRestart: backend.autoRestart,
    input: (sessionId, data, timeoutMs, opts) => send('terminal.input', { terminal_session_id: sessionId, data, ...(opts?.human ? { human: true } : {}) }, timeoutMs),
    create: (request: TerminalCreateRequest, timeoutMs) => send('terminal.create', {
      pane_id: request.paneId,
      create_generation: request.createGeneration,
      agent_key: request.agentKey,
      command: request.command,
      cwd: request.cwd,
      env: request.env,
      cols: request.cols,
      rows: request.rows,
      metadata: request.metadata,
      output_log_file: request.outputLogFile,
      login_profile_id: request.loginProfileId,
      is_login: request.isLogin,
      ...(request.accountDirLogin ? { account_dir_login: true } : {}),
      replaces_terminal_id: request.replacesTerminalId,
      ...(request.quotaTransactionId ? { quota_transaction_id: request.quotaTransactionId } : {}),
      ...(request.quotaOriginalPaneId ? { quota_original_pane_id: request.quotaOriginalPaneId } : {}),
    }, timeoutMs),
    cancelCreate: (paneId, createGeneration) => send('terminal.create.cancel', {
      pane_id: paneId,
      create_generation: createGeneration,
    }),
    reattach: (sessionIds, cols, rows) => send('terminal.reattach', {
      terminal_session_ids: sessionIds,
      cols,
      rows,
    }),
    resize: (sessionId, cols, rows) => send('terminal.resize', {
      terminal_session_id: sessionId,
      cols,
      rows,
    }),
    interrupt: (sessionId) => send('terminal.interrupt', { terminal_session_id: sessionId }),
    kill: (sessionId, force, options) => send('terminal.kill', {
      terminal_session_id: sessionId,
      force,
      ...(options?.retireRestore ? { retire_restore: true } : {}),
    }),
    redraw: (sessionId, cols, rows) => send('terminal.redraw', {
      terminal_session_id: sessionId,
      cols,
      rows,
    }),
    onOutput: (callback: (payload: TerminalOutputEvent) => void) =>
      backend.on('terminal.output' as never, (payload) => callback(payload as TerminalOutputEvent)),
    onExit: (callback: (payload: TerminalExitEvent) => void) =>
      backend.on('terminal.exit' as never, (payload) => callback(payload as TerminalExitEvent)),
    listFiles: (workspacePath, query, maxResults) => send<TerminalFileListResult>('fs.list_files_flat', {
      workspace_path: workspacePath,
      query,
      max_results: maxResults,
    }),
    listAgentPanes: () => send('agent_msg.list', {}),
    registerAgentPane: (pane) => send('agent_msg.register_dock', { ...pane }),
    unregisterAgentPane: (paneId) => send('agent_msg.unregister_dock', { pane_id: paneId }),
    // An embedded panel takes messages the way a main-window pane does: the
    // same broadcast (App.vue's agent_msg.deliver handler), the same envelope
    // (useAgentMessaging.acceptRemoteMessage) and the same report. Only over a
    // backend that hears that broadcast: the Mini-IDE plugin's capability shim
    // says it does not, and its panel then registers as not deliverable.
    ...((backend as { forwardsAgentMessages?: boolean }).forwardsAgentMessages === false ? {} : {
      onAgentMessage: (callback: (message: DockAgentMessage) => void) => backend.on('agent_msg.deliver' as never, (raw) => {
        const ev = raw as {
          msg_key?: string
          target_pane_id?: string
          from_pane_id?: string
          from_display?: string
          content?: string
          kind?: string
          origin?: string
        }
        if (!ev?.msg_key || !ev.target_pane_id || !ev.content) return
        const fromDisplay = ev.from_display || 'unknown'
        callback({
          msgKey: ev.msg_key,
          targetPaneId: ev.target_pane_id,
          fromDisplay,
          text: renderEnvelope(fromDisplay, ev.content, {
            correlationId: ev.msg_key,
            external: isExternalDelivery(ev),
            noReplyRoute: !hasReplyRoute(ev),
          }),
          ...(ev.kind === 'ack' ? { kind: 'ack' as const } : {}),
        })
      }),
      reportAgentDelivery: (msgKey: string, ok: boolean, reason?: string) => send('agent_msg.delivered', {
        msg_key: msgKey,
        ok,
        reason: reason ? encodeReason({ key: reason }) : '',
      }),
    }),
    pinFreshSessionAtLaunch,
    async readDockRestore(workspacePath, paneId) {
      return dockRestoreFromResponse(await send<{ record?: { agent?: string; session_id?: string } | null }>(
        'terminal.dock_record', { workspace_path: workspacePath, pane_id: paneId },
      ))
    },
    async dockSurfaceRetired(workspacePath, paneId, surface) {
      const provided = await window.agentTeam?.dockSurfaceProvided?.(surface)
      if (provided !== false) return false
      await send('terminal.dock_retire', { workspace_path: workspacePath, pane_id: paneId, surface })
      return true
    },
    statPath: (path, timeoutMs) => send('fs.stat_path', { path }, timeoutMs),
    async getHomeDirectory(): Promise<string> {
      return (await window.agentTeam?.getHomeDir?.()) || ''
    },
    async openFile({ workspacePath, filepath, fileWorkspace, line }): Promise<boolean> {
      const res = await window.agentTeam?.openEditorWindow?.({
        workspace_path: workspacePath,
        filepath,
        ...(fileWorkspace ? { file_ws: fileWorkspace } : {}),
        ...(line === undefined ? {} : { line }),
      })
      return res?.ok === true
    },
    async openExternal(url: string): Promise<void> {
      await window.agentTeam?.openExternal?.(url)
    },
    async openPlan(args): Promise<void> {
      await window.agentTeam?.openPlansWindow?.({ workspace_path: args.workspacePath, rel_path: args.relPath })
    },
    reportSelection: (selection) => { window.agentTeam?.reportTerminalSelection?.(selection) },
    saveClipboardImage: async (image) => {
      const save = window.agentTeam?.saveClipboardImage
      if (!save) return null
      try {
        const bytes = new Uint8Array(await image.arrayBuffer())
        const result = await save({ bytes, mediaType: image.type })
        return result?.ok && result.path ? result.path : null
      } catch {
        return null
      }
    },
    showContextMenu: (selection) => { window.agentTeam?.showTerminalContextMenu?.(selection) },
    reportDragEnd: (paneId, screenX, screenY, paneIds) => {
      window.agentTeam?.cliPaneDragEnd?.(paneId, screenX, screenY, paneIds)
    },
    diagnostic: (category, message, level) => {
      try { void send('client.diagnostic', { category, message, level }).catch(() => {}) } catch { /* ignore */ }
    },
  }
}
