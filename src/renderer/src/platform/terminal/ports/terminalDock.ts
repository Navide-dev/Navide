import type { TerminalExitDetails, TerminalStartupProbe } from '../lib/terminalLifecycle'
import type { PortResponse, ReactiveValue } from '@navide/plugin-ui/shared'
import type { ShellCommandOptions } from '../../../../../shared/osplat'
import type { InjectionKey } from 'vue'

export interface TerminalSpawnOptions {
  quotaTransactionId?: string
  quotaOriginalPaneId?: string
  command: string | string[]
  cwd: string
  env?: Record<string, string>
  agentKey?: string
  metadata?: Record<string, unknown>
  outputLogFile?: string
  resumeKey?: string
  isResume?: boolean
  restoreMode?: 'memory-resume' | 'fresh'
  skipReattach?: boolean
  /** Serialized scrollback (from another pane's `serializeScrollback()`) to
   *  write into this pane's xterm before its PTY starts — the handoff a
   *  quota-failover restart uses so the conversation's history stays in the
   *  replacement pane. Display only: never reaches the PTY. */
  replayScrollback?: string
  loginProfileId?: string
  /** The pane exists in order to sign in, so the backend runs the vendor's
   *  sign-in trigger instead of the plain REPL. Independent of
   *  `loginProfileId`, which only chooses an isolated home: a live login
   *  (signing in to the already-active account) sets this and not that. */
  isLogin?: boolean
  /** A claude sign-in inside the pane's account's own config dir (the
   *  account is the pane's `metadata.profile_id`). */
  accountDirLogin?: boolean
}

export interface TerminalCreateRequest {
  quotaTransactionId?: string
  quotaOriginalPaneId?: string
  paneId: string
  createGeneration: string
  agentKey: string | null
  command: string | string[]
  cwd: string
  env: Record<string, string> | null
  cols: number
  rows: number
  metadata: Record<string, unknown> | null
  outputLogFile: string | null
  loginProfileId: string | null
  isLogin: boolean
  accountDirLogin?: boolean
  replacesTerminalId: string | null
}

export interface TerminalCreateResult {
  terminal_session_id: string
  pid: number
  startup_probe?: TerminalStartupProbe | null
  /** Why this machine could not wire the pane's MCP, one line each; absent when it could. */
  wiring_warnings?: string[]
}

export interface TerminalOutputEvent {
  terminal_session_id: string
  data: string
}

export type TerminalExitEvent = TerminalExitDetails & { terminal_session_id: string }

export interface TerminalFileListResult {
  files?: string[]
}

export interface TerminalInputOptions {
  /** The bytes came from the person at the keyboard (xterm onData minus
   *  mouse/focus reports, or the mention picker) — never from paste helpers,
   *  which programmatic injection also rides. The backend counts development
   *  time off this flag; a port that sees it set forwards it as `human: true`
   *  and sends nothing at all otherwise. */
  human?: boolean
}

/** What an embedded AI panel tells the roster about itself (see
 *  TerminalDockPort.registerAgentPane). `surface` / `window_kind` name the
 *  window it lives in; the backend refuses it as a message target. */
export interface DockPaneRegistration {
  pane_id: string
  name: string
  workspace_path: string
  agent_key: string
  surface: string
  window_kind: string
  /** The panel's window delivers messages into it (its port has
   *  onAgentMessage), so the backend may accept it as a message target. Left
   *  out otherwise, and the backend keeps refusing it. */
  deliverable?: boolean
}

/** One message the backend routed to some pane, as a panel's port hands it
 *  over: `text` is already the envelope the main window would inject. */
export interface DockAgentMessage {
  msgKey: string
  targetPaneId: string
  text: string
  fromDisplay: string
  /** cli_send(kind="ack"): reported, never typed. */
  kind?: 'ack'
}

export interface TerminalDockPort {
  readonly status: ReactiveValue<'starting' | 'connecting' | 'connected' | 'disconnected' | 'error'>
  readonly shell: ReactiveValue<string>
  /** The command that runs `command` inside `shell` and keeps the shell open —
   *  the host's call, since only it knows the platform (PowerShell and
   *  cmd.exe take different flags from a POSIX login shell). A Windows agent
   *  pane (`opts.agentPane`) comes back as a plain string that runs directly,
   *  with no PowerShell wrapper. A port that omits it gets the POSIX form. */
  readonly spawnArgv?: (
    shell: string,
    command: string,
    opts?: ShellCommandOptions,
  ) => string | string[]
  readonly autoRestart: ReactiveValue<{ attempt: number; max: number; reason: string } | null>

  input(sessionId: string, data: string, timeoutMs?: number, opts?: TerminalInputOptions): Promise<PortResponse>
  create(request: TerminalCreateRequest, timeoutMs: number): Promise<PortResponse<TerminalCreateResult>>
  cancelCreate(paneId: string, createGeneration: string): Promise<PortResponse>
  /** `logs` maps a surviving session id to the transcript it is actually
   *  appending to — the file opened when that PTY was created, which a pane
   *  reattaching under a new id cannot derive from its own id. */
  reattach(sessionIds: string[], cols: number, rows: number): Promise<PortResponse<{ alive: string[]; dead: string[]; logs?: Record<string, string> }>>
  resize(sessionId: string, cols: number, rows: number): Promise<PortResponse>
  interrupt(sessionId: string): Promise<PortResponse>
  /** `retireRestore`: the user stopped this CLI (an embedded panel's Stop), so
   *  the backend retires the panel's restore record. Every other kill keeps it. */
  kill(sessionId: string, force: boolean, options?: { retireRestore?: boolean }): Promise<PortResponse>
  redraw(sessionId: string, cols: number, rows: number): Promise<PortResponse>

  onOutput(callback: (payload: TerminalOutputEvent) => void): () => void
  onExit(callback: (payload: TerminalExitEvent) => void): () => void

  listFiles(workspacePath: string, query: string, maxResults: number): Promise<PortResponse<TerminalFileListResult>>
  /** `workspace_label` / `qualified_name` are the `<folder>/<pane>` addressing
   *  protocol and are what gets inserted into a CLI. `workspace_path` is the
   *  unique section key for mention menus (a folder name is not unique), and
   *  `workspace_display_name` is the workspace's user-set alias — both
   *  optional, since a backend older than either field sends neither. */
  listAgentPanes(): Promise<PortResponse<{ panes?: Array<{ pane_id?: string; name?: string; qualified_name?: string; workspace_label?: string; workspace_path?: string; workspace_display_name?: string; surface?: string }> }>>
  /** Register an embedded AI panel in the messaging roster, so the CLI running
   *  in it can use Navide's MCP tools (they refuse a pane id the roster has
   *  never seen). Optional: a host that omits it leaves the panel unregistered,
   *  which is what every port did before. */
  registerAgentPane?(pane: DockPaneRegistration): Promise<PortResponse>
  /** Drop a panel registered with registerAgentPane. */
  unregisterAgentPane?(paneId: string): Promise<PortResponse>
  /** Every message the backend routes, for any pane — the panel picks out its
   *  own. Optional: without it the panel registers as not deliverable. */
  onAgentMessage?(callback: (message: DockAgentMessage) => void): () => void
  /** Report a delivery outcome; `reason` is a `msg.reason-*` key. */
  reportAgentDelivery?(msgKey: string, ok: boolean, reason?: string): Promise<PortResponse>
  /** The host's fresh-launch session pinning (lib/sessionHeal
   *  pinFreshSessionAtLaunch). Optional: without it the panel spawns unpinned. */
  pinFreshSessionAtLaunch?(
    agentKey: string,
    isResume: boolean,
    command: string,
    requestedId: string | undefined,
    generate: () => string,
  ): { command: string; explicitSessionId: string }
  /** The panel's restore record: the agent and session of its last CLI when
   *  the backend still holds that record as 'spawned' (an app quit keeps it,
   *  closing the panel's window retires it); null otherwise. Optional: without
   *  it the panel never resumes on its own and shows Start, as before. */
  readDockRestore?(workspacePath: string, paneId: string): Promise<{ agentKey: string; sessionId: string } | null>
  /** Retire the panel's restore record when no plugin provides its surface any
   *  more (a built-in panel whose plugin was removed), resolving true; false
   *  while one does. Optional: a plugin's own port never needs it — its window
   *  exists only while the plugin does. */
  dockSurfaceRetired?(workspacePath: string, paneId: string, surface: string): Promise<boolean>
  statPath(path: string, timeoutMs?: number): Promise<PortResponse<{ exists: boolean }>>
  getHomeDirectory?(): Promise<string>
  /** `false` means the host could not open the file; `void` (older ports)
   *  means unknown and is treated as success. */
  openFile(args: {
    workspacePath: string
    filepath: string
    fileWorkspace?: string
    line?: number
  }): Promise<boolean | void>
  openExternal(url: string): Promise<void>
  openPlan?(args: { workspacePath: string; relPath?: string }): Promise<void>
  reportSelection?(selection: string): void
  saveClipboardImage?(image: File): Promise<string | null>
  showContextMenu?(selection: string): void
  reportDragEnd?(paneId: string, screenX: number, screenY: number, paneIds: string[]): void
  diagnostic?(category: string, message: string, level: 'info' | 'warning'): void
}

export const TERMINAL_DOCK_KEY: InjectionKey<TerminalDockPort> = Symbol('terminal-dock')

export type TerminalStatusSource = ReactiveValue<TerminalDockPort['status']['value']>
