import type { App, InjectionKey } from 'vue'
import { inject } from 'vue'
import type { PluginContext } from '@navide/plugin-sdk'

export { default as SafeAiCliPanel } from './SafeAiCliPanel.vue'
export * from './tokens'
export * from './terminalMentionModel'
export * from './terminalMentionMenu'
export { createResizeController } from './terminalResize'
export type { ResizeController } from './terminalResize'

const pluginContextKey: InjectionKey<PluginContext> = Symbol('navide-plugin-context')

export function installPluginContext(app: App, context: PluginContext): void {
  app.provide(pluginContextKey, context)
}

export function usePluginContext(): PluginContext {
  const context = inject(pluginContextKey)
  if (!context) throw new Error('Navide PluginContext is not installed')
  return context
}

export interface AiCliSessionController {
  readonly sessionId: string | null
  readonly profileId: string | null
  listProfiles(): Promise<AiCliProfile[]>
  resume(cols: number, rows: number): Promise<AiCliResumeResult | null>
  start(profileId: string, cols: number, rows: number, options?: { yolo?: boolean }): Promise<string>
  send(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  redraw?(cols: number, rows: number): Promise<void>
  interrupt(): Promise<void>
  stop(): Promise<void>
  cancelStart?(): Promise<void>
  dispose(): void
  onOutput(listener: (data: string) => void): () => void
  onExit(listener: () => void): () => void
}

export interface AiCliProfile {
  id: string
  label: string
  fullScreenTui?: boolean
  bracketedPaste?: boolean
  shiftEnterSequence?: string
}

export interface AiCliTerminalView {
  read(): Promise<{ fontSize: number; lastSize: { cols: number; rows: number } | null; snapshot: string | null }>
  save(snapshots: string[]): Promise<void>
  setFontSize(fontSize: number): Promise<void>
}

export interface AiCliTerminalResources {
  openFilePicker?(request: { query: string; candidates: string[]; line?: number }): Promise<void>
  /** Lets a plugin open a clicked terminal file itself. True means handled;
   * otherwise the Host picker opens as it would without this. */
  resolveFileLink?(request: { query: string; candidates: string[]; line?: number }): Promise<boolean>
  openExternal?(url: string): Promise<void>
  openPlan?(path: string): Promise<void>
  listMentionTargets(): Promise<Array<{ address: string; group?: string }>>
  saveClipboardImage(image: File): Promise<string | null>
  showContextMenu(selection: string): Promise<void>
  reportSelection(selection: string): Promise<void>
}

export function createAiCliTerminalResources(context: AiCliPluginContext, controller: AiCliSessionController): AiCliTerminalResources {
  const session = (): string => {
    if (!controller.sessionId) throw new Error('AI CLI session is not running')
    return controller.sessionId
  }
  return {
    async openFilePicker(request) {
      await context.capabilities.invoke('ui.openFilePicker', { ...request, ...(controller.sessionId ? { sessionId: controller.sessionId } : {}) })
    },
    async openExternal(url) { await context.capabilities.invoke('ui.openExternal', { url }) },
    async openPlan(path) { await context.capabilities.invoke('ui.openPlansWindow', { path }) },
    async listMentionTargets() {
      return (await context.capabilities.invoke('aiCli.listMentionTargets', { sessionId: session() })).targets
    },
    async saveClipboardImage(image) {
      const bytes = Array.from(new Uint8Array(await image.arrayBuffer()))
      return (await context.capabilities.invoke('aiCli.saveClipboardImage', { sessionId: session(), bytes, mediaType: image.type })).path
    },
    async showContextMenu(selection) {
      await context.capabilities.invoke('aiCli.showTerminalContextMenu', { ...(controller.sessionId ? { sessionId: controller.sessionId } : {}), selection })
    },
    async reportSelection(selection) {
      await context.capabilities.invoke('aiCli.reportTerminalSelection', { ...(controller.sessionId ? { sessionId: controller.sessionId } : {}), selection })
    },
  }
}

export function createAiCliTerminalView(context: AiCliPluginContext, controller: AiCliSessionController): AiCliTerminalView {
  return {
    read: () => context.capabilities.invoke('aiCli.readTerminalView', {}),
    async save(snapshots) {
      if (!controller.sessionId) return
      await context.capabilities.invoke('aiCli.saveTerminalView', { sessionId: controller.sessionId, snapshots })
    },
    async setFontSize(fontSize) { await context.capabilities.invoke('aiCli.setTerminalFontSize', { fontSize }) },
  }
}

export interface AiCliResumeResult {
  sessionId: string
  profileId: string
}

export interface SafeAiCliPanelHandle {
  readonly status: 'idle' | 'starting' | 'running'
  readonly profiles: readonly AiCliProfile[]
  readonly profileId: string
  readonly initializing: boolean
  selectProfile(profileId: string): void
  start(): Promise<void>
  focus(): void
  submitPrompt(prompt: string): Promise<boolean>
  stop(): Promise<void>
  interrupt(): Promise<void>
  pasteText(text: string): Promise<boolean>
  injectNow(): Promise<void>
}

export type AiCliPluginContext = Pick<PluginContext, 'capabilities' | 'events'>

export function createAiCliSessionController(context: AiCliPluginContext, configuration: { persistView?: boolean } = {}): AiCliSessionController {
  let sessionId: string | null = null
  let profileId: string | null = null
  let pendingStart: Promise<string> | null = null
  let pendingRequestId: string | null = null
  let pendingResume: Promise<AiCliResumeResult | null> | null = null
  const outputListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<() => void>()
  const earlyOutput = new Map<string, string[]>()
  const earlyExits = new Set<string>()
  const outputSubscription = context.events.subscribe('aiCli.output', (event) => {
    if (event.sessionId !== sessionId) {
      if (pendingRequestId || pendingResume) {
        const chunks = earlyOutput.get(event.sessionId) ?? []
        chunks.push(event.data)
        earlyOutput.set(event.sessionId, chunks)
      }
      return
    }
    for (const listener of outputListeners) listener(event.data)
  })
  const exitSubscription = context.events.subscribe('aiCli.exited', (event) => {
    if (event.sessionId !== sessionId) {
      if (pendingRequestId || pendingResume) earlyExits.add(event.sessionId)
      return
    }
    sessionId = null
    profileId = null
    for (const listener of exitListeners) listener()
  })

  const requireSession = (): string => {
    if (!sessionId) throw new Error('AI CLI session is not running')
    return sessionId
  }

  const deliverEarlyEvents = (active: string): void => {
    for (const data of earlyOutput.get(active) ?? []) {
      for (const listener of outputListeners) listener(data)
    }
    earlyOutput.clear()
    const exited = earlyExits.has(active)
    earlyExits.clear()
    if (exited) {
      sessionId = null
      profileId = null
      for (const listener of exitListeners) listener()
    }
  }

  return {
    get sessionId() {
      return sessionId
    },
    get profileId() {
      return profileId
    },
    async listProfiles() {
      const result = await context.capabilities.invoke('aiCli.listProfiles', configuration.persistView ? { terminalView: true } : {})
      return result.profiles
    },
    async resume(cols, rows) {
      if (sessionId && profileId) return { sessionId, profileId }
      if (pendingResume) return pendingResume
      pendingResume = context.capabilities.invoke('aiCli.resumeSession', {
        cols, rows, ...(configuration.persistView === undefined ? {} : { persistView: configuration.persistView }),
      })
        .then((result) => {
          if (result) {
            sessionId = result.sessionId
            profileId = result.profileId
            deliverEarlyEvents(result.sessionId)
          }
          return result
        })
        .finally(() => { pendingResume = null; earlyOutput.clear(); earlyExits.clear() })
      return pendingResume
    },
    async start(nextProfileId, cols, rows, options = {}) {
      if (sessionId) return sessionId
      if (pendingStart) return pendingStart
      const requestId = globalThis.crypto.randomUUID()
      pendingRequestId = requestId
      pendingStart = context.capabilities.invoke('aiCli.startSession', {
        requestId,
        profileId: nextProfileId,
        cols,
        rows,
        ...(options.yolo === undefined ? {} : { yolo: options.yolo }),
        ...(configuration.persistView === undefined ? {} : { persistView: configuration.persistView }),
      }).then((result) => {
        sessionId = result.sessionId
        profileId = nextProfileId
        deliverEarlyEvents(result.sessionId)
        return result.sessionId
      }).finally(() => { pendingStart = null; pendingRequestId = null; earlyOutput.clear(); earlyExits.clear() })
      return pendingStart
    },
    async cancelStart() {
      if (pendingRequestId) await context.capabilities.invoke('aiCli.cancelStart', { requestId: pendingRequestId })
    },
    async send(data) {
      await context.capabilities.invoke('aiCli.sendInput', { sessionId: requireSession(), data })
    },
    async resize(cols, rows) {
      await context.capabilities.invoke('aiCli.resizeSession', {
        sessionId: requireSession(),
        cols,
        rows,
      })
    },
    async redraw(cols, rows) {
      await context.capabilities.invoke('aiCli.redrawSession', { sessionId: requireSession(), cols, rows })
    },
    async interrupt() {
      await context.capabilities.invoke('aiCli.interruptSession', { sessionId: requireSession() })
    },
    async stop() {
      const active = requireSession()
      await context.capabilities.invoke('aiCli.stopSession', { sessionId: active, force: true })
      if (sessionId === active) {
        sessionId = null
        profileId = null
      }
    },
    dispose() {
      outputListeners.clear()
      exitListeners.clear()
      earlyOutput.clear()
      earlyExits.clear()
      outputSubscription.dispose()
      exitSubscription.dispose()
    },
    onOutput(listener) {
      outputListeners.add(listener)
      return () => outputListeners.delete(listener)
    },
    onExit(listener) {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
  }
}
export { createTerminalInputHandlers, encodeShiftEnter } from './terminalInput'
export type { TerminalAgentProfile, TerminalAgentProfileResolver, TerminalInputHandlersOptions, TerminalInputHandlers } from './terminalInput'
export { XTERM_THEMES, readXtermTheme } from './terminalTheme'
export { TERMINAL_MOUSE_MODE_RESET, TERMINAL_NEW_PROCESS_RESET, TERMINAL_RECONNECTED_DIVIDER } from './terminalSnapshots'
export {
  findFileLinkAt,
  findFileLinkMatches,
  findFileLinkMatchAt,
  findUrlLinkMatchAt,
  findUrlMatches,
  rootedTailCandidate,
  shedCjkPieces,
  shedCjkProse,
  splitMatchAtRowStarts,
  trimUrlTrailing,
} from './terminalLinks'
export type { UrlMatch, WrappedLineGroup } from './terminalLinks'
export {
  cellColToStrCol,
  getWrappedLineGroup,
  groupPosToRowCol,
  groupRowColToPos,
  extractPlanDocRelPath,
  htmlReportRoute,
  installTerminalLinks,
  isTerminalLinkModifier,
  isTerminalLinkModifierKey,
  strColToCellCol,
  splitTerminalLinkSuffix,
  visualWidth,
} from './terminalLinkInteraction'
export type {
  InstalledTerminalLinks,
  TerminalFileLinkRequest,
  TerminalLinkInteractionOptions,
  TerminalPlanLinkRequest,
} from './terminalLinkInteraction'
