import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_SPECS, RESTORE_PIN_AGENTS } from '../../platform/plugin-shell/agents'
import {
  buildResumeCommand, normalizeResumeSessionId, sessionHomeIdFor,
  shouldPreserveMissingSessionOnRestore, shouldWarnMissingResume,
} from '../../platform/plugin-shell/lib/resume-command'
import { pinFreshSessionAtLaunch, shouldAttemptResume } from '../../lib/sessionHeal'
import { accountSpawnPin } from '../../lib/accountFollowPanes'
import { sessionHeldElsewhere } from '../../lib/paneOpenAnswer'

const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const marker = source.includes(`async function ${name}(`)
    ? `async function ${name}(` : `function ${name}(`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`Missing App function: ${name}`)
  return source.slice(start, source.indexOf('\n}\n', start) + 2)
}

const markerSetsStart = source.indexOf('const SESSION_MARKER_AGENTS =')
const markerSetsEnd = source.indexOf('/** Trailing line', markerSetsStart)
const declarations = [source.slice(markerSetsStart, markerSetsEnd), ...[
  'sessionMarkerLine', 'sendSessionMarkerBootstrap', 'spawnPane', 'onManualSpawn',
  'rebuildPaneClean', 'spawnRestoredPane', 'performRealizeRestoredPane',
  'looksLikeResumeCommand', 'paneWaitingForSessionId',
].map(fn)].join('\n')
const javascript = ts.transpileModule(declarations, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

interface Pane {
  id: string
  agentKey: string
  sessionMarker?: string
  markerReplyPending?: boolean
  pinnedSessionId?: string
  sessionHomeId?: string
  kickoffPrompt?: string
  [key: string]: unknown
}

// Execute the real orchestration with fake terminal/persistence I/O. Mounting
// App would start unrelated services; copying its marker decisions here would
// let the tests pass while the actual startup paths still submitted a prompt.
function harness() {
  const panes = { value: [] as Pane[] }
  const terminalSpawn = vi.fn(async () => {})
  const send = vi.fn(async () => ({}))
  const sendQuiet = vi.fn(async () => ({}))
  const paneRefs: Record<string, unknown> = {}
  const timers = vi.fn()
  let nextId = 0
  const deps = {
    agentSpecs: AGENT_SPECS, RESTORE_PIN_AGENTS,
    pinFreshSessionAtLaunch, sessionHomeIdFor, buildResumeCommand,
    normalizeResumeSessionId, shouldPreserveMissingSessionOnRestore,
    shouldWarnMissingResume, shouldAttemptResume,
    panes, paneRefs, backend: { shell: { value: 'bash' }, send }, sendQuiet,
    crypto: { randomUUID: () => `pane-${++nextId}` },
    resolveCommand: (agent: string, override: string) => ({
      command: override || AGENT_SPECS.find((spec) => spec.agentKey === agent)?.defaultCommand,
      source: 'default',
    }),
    focusPaneId: { value: '' }, currentWorkspace: { value: '/workspace' },
    spawnHistory: { value: [] }, runGroups: { value: [] },
    activeTab: { value: '' }, runGroupsReady: { value: true },
    registerPaneMessaging: vi.fn(), unregisterPaneMessaging: vi.fn(),
    messaging: { handOverQueue: vi.fn() },
    selectPane: vi.fn(), setPaneAutoName: vi.fn(), requestLlmPaneName: vi.fn(),
    deriveAutoName: (text: string) => text, roleLabel: (role: string) => role,
    entryBelongsToWorkspace: () => true,
    spawnHistoryWorkspaceIdentity: (path: string) => path,
    window: { setTimeout: timers }, SESSION_OVERLAY_GRACE_MS: 12_000,
    nextTick: async () => {
      for (const pane of panes.value) {
        paneRefs[pane.id] ??= { spawn: terminalSpawn, status: 'running', sessionId: `pty-${pane.id}` }
      }
    },
    shellCommandArgv: (_shell: string, command: string) => ['bash', '-ilc', command],
    spawnEnvOverride: () => undefined, settingsGet: () => null, cliEnvKey: () => '',
    startPaneHealthWatcher: vi.fn(), scheduleInjection: vi.fn(), syncViews: vi.fn(),
    setPrepStatus: (pane: Pane, status: string) => { pane.preparationStatus = status },
    normWs: (path: string) => path, resolveReadySpawnGroupId: () => '',
    dismissStartupDialog: vi.fn(async () => false), DISMISS_TIMEOUT_MS: 1,
    waitForStartupActivity: vi.fn(async () => true), waitForQuiet: vi.fn(async () => {}),
    paneAlive: (id: string) => panes.value.some((pane) => pane.id === id),
    paneScreenBlocked: () => false, hasDetectedCodexSession: () => false,
    pipelineLog: vi.fn(), sleep: async () => {},
    BRACKETED_PASTE_START: '\x1b[200~', BRACKETED_PASTE_END: '\x1b[201~',
    paneResumeSessionId: (pane: Pane) => pane.pinnedSessionId || '',
    rebuildingPanes: new Set<string>(), stagesApi: { stages: { value: [] } },
    isPaneMuted: () => false, setPaneMuted: vi.fn(), persistPaneMuted: vi.fn(),
    onKill: vi.fn(async () => {}), rekeyLineage: vi.fn(),
    autoNameSourceOf: () => undefined, persistedMessagingName: () => '',
    dropPersistedMessagingName: vi.fn(), isLocalWorkspace: () => true,
    workspaceRestoreSession: () => ({}), explicitRestoreDecision: () => 'fresh',
    // The one-CLI-per-conversation guard (a chat's wake): no other pane holds a session here.
    sessionHeldElsewhere, sessionHolders: () => [],
    scheduledRestoreIds: new Set<string>(), wakeHeldSessions: new Set<string>(),
    deferredPaneStillCurrent: () => true, skipFlagFor: () => '',
    canResumeSession: async () => false, savedHistoryFile: async () => '',
    stripPinnedSessionId: (command: string) => command,
    stripDeadOpencodeAutoFlag: (_agent: string, command: string) => command,
    minimizedPanes: { value: new Set<string>() },
    useChannels: () => ({ paneReplaced: vi.fn(), paneClosed: vi.fn() }),
    // Scheme A's follow flag (plan claude_f1bf4b): no account dir here.
    FOLLOW_SWITCH_AGENT: 'claude', followDirSignedIn: () => false, accountSpawnPin,
    accountFollow: { add: vi.fn(), remove: vi.fn(), has: () => false },
  }
  const actions = new Function(...Object.keys(deps), `${javascript}; return {
    spawnPane, onManualSpawn, rebuildPaneClean, performRealizeRestoredPane,
    sendSessionMarkerBootstrap, sessionMarkerLine, paneWaitingForSessionId
  }`)(...Object.values(deps)) as {
    spawnPane: (opts: Record<string, unknown>) => Promise<string>
    onManualSpawn: (payload: Record<string, unknown>) => Promise<string>
    rebuildPaneClean: (id: string) => Promise<void>
    performRealizeRestoredPane: (id: string, aggregate: boolean, opts: { explicit: boolean }) => Promise<string>
    sendSessionMarkerBootstrap: (pane: Pane, tag: string) => Promise<boolean>
    sessionMarkerLine: (marker?: string) => string
    paneWaitingForSessionId: (pane: Pane) => boolean
  }
  return { ...actions, ...deps, terminalSpawn, timers }
}

const manual = { agentKey: 'codex', roleKey: '', stageId: '', workspacePath: '/workspace' }

describe('Codex session identity without a bootstrap turn', () => {
  it('opens a manual pane without writing input, logging a marker, or waiting for an ID', async () => {
    const h = harness()
    const id = await h.onManualSpawn(manual)
    const pane = h.panes.value.find((item) => item.id === id)!
    expect(h.terminalSpawn).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ session_marker: '', session_home_id: id }),
    }))
    expect(pane.sessionMarker).toBeUndefined()
    expect(pane.markerReplyPending).toBeUndefined()
    expect(pane.preparationStatus).toBe('ready')
    expect(h.paneWaitingForSessionId(pane)).toBe(false)
    expect(await h.sendSessionMarkerBootstrap(pane, 'codex')).toBe(false)
    expect(h.backend.send).not.toHaveBeenCalled()
    expect(h.timers).not.toHaveBeenCalled()
  })

  it('rebuilds a fresh pane without reviving an old marker or sending a bootstrap turn', async () => {
    const h = harness()
    h.panes.value.push({
      ...manual, id: 'old-pane', realized: true, origin: 'manual',
      sessionMarker: 'at-pane:old-pane', pinnedSessionId: 'previous-session',
    })
    await h.rebuildPaneClean('old-pane')
    expect(h.panes.value).toHaveLength(1)
    const pane = h.panes.value[0]
    expect(pane.id).not.toBe('old-pane')
    expect(pane.sessionMarker).toBeUndefined()
    expect(h.paneWaitingForSessionId(pane)).toBe(false)
    expect(await h.sendSessionMarkerBootstrap(pane, 'codex')).toBe(false)
    expect(h.backend.send).not.toHaveBeenCalled()
  })

  it('restores a fresh placeholder without a marker or an identity-wait overlay', async () => {
    const h = harness()
    h.panes.value.push({
      id: 'saved-pane', agentKey: 'codex', realized: false,
      sessionMarker: 'at-pane:saved-pane',
      sessionHomeId: 'original-home', deferredRestore: {
        workspacePath: '/workspace',
        batch: { workspacePath: '/workspace' },
        saved: { pane_id: 'saved-pane', agent: 'codex', role: '', origin: 'manual' },
      },
    })
    expect(await h.performRealizeRestoredPane('saved-pane', false, { explicit: true })).toBe('fresh')
    const pane = h.panes.value[0]
    expect(pane.id).not.toBe('saved-pane')
    expect(pane.sessionHomeId).toBe('original-home')
    expect(pane.sessionMarker).toBeUndefined()
    expect(h.paneWaitingForSessionId(pane)).toBe(false)
    expect(await h.sendSessionMarkerBootstrap(pane, 'codex')).toBe(false)
    expect(h.backend.send).not.toHaveBeenCalled()
  })

  it('preserves intentional kickoff text and leaves role/pipeline marker suffixes empty', async () => {
    const h = harness()
    await h.spawnPane({ ...manual, roleKey: 'developer', kickoffPrompt: 'Implement the requested fix.', origin: 'manual' })
    const pane = h.panes.value[0]
    expect(pane.kickoffPrompt).toBe('Implement the requested fix.')
    expect(h.sessionMarkerLine(pane.sessionMarker)).toBe('')
    expect(h.scheduleInjection).toHaveBeenCalledWith(pane)
    expect(h.backend.send).not.toHaveBeenCalled()
  })

  it('does not show an ID-wait overlay for a legacy Codex marker', () => {
    const h = harness()
    expect(h.paneWaitingForSessionId({
      id: 'old-pane', agentKey: 'codex', sessionMarker: 'at-pane:old-pane',
    })).toBe(false)
  })

  it('keeps explicit resume identity and the original session home', async () => {
    const h = harness()
    const sessionId = '019a4321-1234-7890-abcd-0123456789ab'
    await h.spawnPane({
      ...manual, origin: 'manual', isResume: true, resumeSessionId: sessionId,
      sessionHomeId: 'original-home', commandOverride: buildResumeCommand('codex', sessionId),
    })
    expect(h.terminalSpawn).toHaveBeenCalledWith(expect.objectContaining({
      command: ['bash', '-ilc', `codex resume ${sessionId}`], resumeKey: sessionId,
      metadata: expect.objectContaining({ explicit_session_id: sessionId, session_home_id: 'original-home', session_marker: '' }),
    }))
    expect(h.backend.send).not.toHaveBeenCalled()
  })

  it('retains marker bootstrap, reply gating, and the waiting overlay for other marker vendors', async () => {
    const h = harness()
    await h.onManualSpawn({ ...manual, agentKey: 'grok' })
    const pane = h.panes.value[0]
    await vi.waitFor(() => expect(pane.markerReplyPending).toBe(true))
    expect(pane.sessionMarker).toBe(`at-pane:${pane.id}`)
    expect(h.paneWaitingForSessionId(pane)).toBe(true)
    expect(h.backend.send).toHaveBeenCalledWith('terminal.input', expect.objectContaining({ data: '\r' }))
    expect(h.backend.send).toHaveBeenCalledWith('terminal.input', expect.objectContaining({
      data: `\x1b[200~<!-- agent-team-session: at-pane:${pane.id} -->\x1b[201~`,
    }))
  })
})
