// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import {
  RECLAIM_NOW_THRESHOLD_MS,
  focusedForReclaim,
  idleReclaimThresholdMs,
  namedReclaimBlockedBy,
  reclaimBlockedBy,
} from '../../lib/idleReclaim'
import { linearPipelineDag } from './pipelineDagTestStub'

// A finished stage used to keep its CLIs alive until the whole run ended or the
// idle sweep caught them 30 minutes later, so a long pipeline went on paying
// the ~190MB-per-claude floor for stages nobody was reading. The hand-off now
// turns them into cold-restore placeholders: the process goes, the conversation
// stays one click away.
//
// App.vue cannot be mounted here (see App.idleReclaim.test.ts), and the claims
// below — "the pane became a placeholder", "spawn history did NOT record a
// removal" — are about what ran, so the functions are lifted out of App.vue,
// compiled, and executed against stubs. The reclaim DECISION is the real
// lib/idleReclaim.ts, passed in unmodified.
const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = appSource.indexOf(startMarker)
  expect(start, `${startMarker} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf(endMarker, start + startMarker.length)
  expect(end, `${endMarker} should exist after ${startMarker}`).toBeGreaterThan(-1)
  return appSource.slice(start, end)
}

const managerIdSource = block(
  'function globalManagerPaneId(): string | null {',
  '\n/** The Manager pane can still receive',
)

const nextSource = block(
  'async function onPipelineNext(): Promise<void> {',
  '\n/** Everything an abort does',
)

// reclaimCandidate → paneHeldByStageRouter → paneReclaimable →
// projectPaneFromActive → reclaimIdlePane → reclaimCompletedStagePanes, in one
// contiguous run.
const reclaimSource = block(
  'function reclaimCandidate(pane: ActivePane): ReclaimCandidate {',
  '\nlet _idleReclaimTimer',
)

interface TestPane {
  id: string
  stageId: string
  slotLabel: string
  origin: string
  realized: boolean
  restoring?: boolean
  pinnedSessionId?: string
  preparationStatus?: string
  injectionStatus?: string
  agentKey?: string
  roleKey?: string
  workspacePath?: string
  deferredRestore?: unknown
  skipRoleInjection?: boolean
}

interface RefStub {
  displayStatus: string
  lastActivityAt: number
  lastUserKeyAt: number
  hasDraft: boolean
}

interface HistEntry {
  paneId: string
  removedAt?: string
  sessionId?: string
}

interface Options {
  /** Which pane the user is looking at. */
  focusPaneId?: string | null
  /** Panes whose CLI input line holds unsent text. */
  draftPaneIds?: string[]
  /** The cross-stage Manager slot, as deriveGlobalManager reports it. */
  globalManager?: { stageId: string; slotLabel: string } | null
  stageIndex?: number
}

/** Three stages of two slots each, plus a Manager slot in stage 01. */
function stageList() {
  return [
    { id: 'S1', title: 'Stage 1', slots: [{ label: 'mgr' }, { label: 'w1' }] },
    { id: 'S2', title: 'Stage 2', slots: [{ label: 'w1' }, { label: 'w2' }] },
    { id: 'S3', title: 'Stage 3', slots: [{ label: 'w1' }, { label: 'w2' }] },
  ]
}

async function load(opts: Options = {}) {
  const { code } = await transformWithEsbuild(
    `${managerIdSource}\n${nextSource}\n${reclaimSource}\n` +
      'return { onPipelineNext, reclaimCompletedStagePanes, reclaimIdlePane, globalManagerPaneId }',
    'AppPipelineStageReclaim.ts',
    { loader: 'ts' },
  )
  const stages = stageList()
  // Every pipeline pane is live, idle and resumable — the state a stage is in
  // the moment it hands off, so the only reason any of them is kept is a
  // reason the guards actually found.
  const panes = {
    value: stages.flatMap((stage) =>
      stage.slots.map((slot): TestPane => ({
        id: `${stage.id}-${slot.label}`,
        stageId: stage.id,
        slotLabel: slot.label,
        origin: 'pipeline',
        realized: true,
        restoring: false,
        pinnedSessionId: `sess-${stage.id}-${slot.label}`,
        preparationStatus: 'ready',
        injectionStatus: 'sent',
        agentKey: 'claude',
        roleKey: 'dev',
        workspacePath: '/tmp/ws',
      })),
    ),
  }
  // A manual pane in no stage at all: nothing here may touch it.
  panes.value.push({
    id: 'manual-1',
    stageId: '',
    slotLabel: '',
    origin: 'manual',
    realized: true,
    restoring: false,
    pinnedSessionId: 'sess-manual',
    preparationStatus: 'ready',
    injectionStatus: 'sent',
    agentKey: 'claude',
    roleKey: 'dev',
    workspacePath: '/tmp/ws',
  })
  const drafts = new Set(opts.draftPaneIds ?? [])
  const paneRefs: Record<string, RefStub> = {}
  for (const p of panes.value) {
    paneRefs[p.id] = {
      displayStatus: 'idle',
      lastActivityAt: Date.now() - 60_000,
      lastUserKeyAt: 0,
      hasDraft: drafts.has(p.id),
    }
  }
  const spawnHistory = {
    value: panes.value.map((p): HistEntry => ({ paneId: p.id, sessionId: p.pinnedSessionId })),
  }
  const pipeline = {
    state: 'running' as string,
    workspacePath: '/tmp/ws',
    task: 'ship it',
    stageIndex: opts.stageIndex ?? 0,
    globalManager: opts.globalManager ?? null,
    log: [] as string[],
  }
  const killed: { paneId: string; opts: Record<string, unknown> }[] = []
  const activateStage = vi.fn(async (_index: number) => {})
  const factory = new Function(
    'pipeline',
    'stagesApi',
    'panes',
    'paneRefs',
    'spawnHistory',
    'watchers',
    'stageRouters',
    'messaging',
    'issueHandoffs',
    'minimizedPanes',
    'collapsedPanes',
    'focusPaneId',
    'effectiveFocusPaneId',
    'globalRouterHandle',
    'currentMode',
    'idleReclaimMinutes',
    'focusedForReclaim',
    'reclaimBlockedBy',
    'namedReclaimBlockedBy',
    'idleReclaimThresholdMs',
    'RECLAIM_NOW_THRESHOLD_MS',
    'paneResumeSessionId',
    'paneRebuilding',
    'isPaneMuted',
    'persistedMessagingName',
    'registerPaneMessaging',
    'syncViews',
    'pipelineLog',
    'cancelWatcher',
    'disposeStageRouter',
    'waitForStagePanesSettled',
    'stopGlobalManagerRouter',
    'sendQuiet',
    'applyProjectPaths',
    'activateStage',
    'onKill',
    'pipelineDag',
    code,
  )
  const api = factory(
    pipeline,
    { stages: { value: stages } },
    panes,
    paneRefs,
    spawnHistory,
    new Map(),
    new Map(),
    { queuedCountFor: () => 0 },
    { value: new Map() },
    { value: new Set<string>() },
    { value: new Set<string>() },
    { value: opts.focusPaneId ?? null },
    { value: opts.focusPaneId ?? null },
    null,
    { value: 'running' },
    { value: '30' },
    focusedForReclaim,
    reclaimBlockedBy,
    namedReclaimBlockedBy,
    idleReclaimThresholdMs,
    RECLAIM_NOW_THRESHOLD_MS,
    (pane: TestPane) => pane.pinnedSessionId ?? '',
    () => false,
    () => false,
    () => undefined,
    vi.fn(),
    vi.fn(),
    (line: string) => pipeline.log.push(line),
    vi.fn(),
    vi.fn(),
    vi.fn(async () => {}),
    vi.fn(),
    vi.fn(async () => null),
    vi.fn(),
    activateStage,
    // Mirrors the part of onKill this path depends on: it stamps the spawn
    // history entry as removed (unconditionally, for every caller) and, with
    // keepInList, leaves the pane in the list. If reclaimIdlePane stops taking
    // that stamp back, test "keeps the pane out of spawn history's removals"
    // is what notices.
    vi.fn(async (paneId: string, killOpts: Record<string, unknown> = {}) => {
      killed.push({ paneId, opts: killOpts })
      const hist = spawnHistory.value.find((e) => e.paneId === paneId)
      if (hist && !hist.removedAt) hist.removedAt = new Date().toISOString()
      if (killOpts.keepInList !== true) {
        panes.value = panes.value.filter((p) => p.id !== paneId)
      }
    }),
    linearPipelineDag().dag,
  )
  const paneById = (id: string): TestPane | undefined => panes.value.find((p) => p.id === id)
  const histFor = (id: string): HistEntry | undefined =>
    spawnHistory.value.find((e) => e.paneId === id)
  return { api, pipeline, panes, paneById, histFor, killed, activateStage, spawnHistory }
}

describe('advancing a stage reclaims the stage it just finished', () => {
  it('turns the finished stage\'s panes into placeholders', async () => {
    const { api, pipeline, paneById, activateStage } = await load()
    await api.onPipelineNext()
    expect(pipeline.stageIndex).toBe(1)
    expect(activateStage.mock.calls).toEqual([[1]])
    for (const id of ['S1-mgr', 'S1-w1']) {
      const pane = paneById(id)
      // Still in the list, in its seat — a reclaim is not a close.
      expect(pane, `${id} should keep its seat`).toBeDefined()
      expect(pane?.realized, `${id} should be a placeholder`).toBe(false)
      // …and with the metadata the realize path needs, or the seat is dead.
      expect(pane?.deferredRestore, `${id} should be resumable`).toBeDefined()
    }
  })

  it('keeps the reclaimed panes out of spawn history\'s removals', async () => {
    // onKill stamps removedAt for every caller, and reclaimIdlePane takes that
    // stamp back because the pane has not been removed. A regression here is
    // silent until the next restart, when the pane really does not come back.
    const { api, histFor } = await load()
    await api.onPipelineNext()
    expect(histFor('S1-mgr')?.removedAt).toBeUndefined()
    expect(histFor('S1-w1')?.removedAt).toBeUndefined()
  })

  it('ends each CLI gracefully and keeps its backend record', async () => {
    const { api, killed } = await load()
    await api.onPipelineNext()
    expect(killed.map((k) => k.paneId).sort()).toEqual(['S1-mgr', 'S1-w1'])
    for (const k of killed) {
      expect(k.opts).toMatchObject({ markRemoved: false, keepInList: true, force: false })
    }
  })

  it('leaves the stage it is advancing INTO alone, and every manual pane', async () => {
    const { api, paneById } = await load()
    await api.onPipelineNext()
    for (const id of ['S2-w1', 'S2-w2', 'S3-w1', 'S3-w2', 'manual-1']) {
      expect(paneById(id)?.realized, `${id} should still be live`).toBe(true)
    }
  })
})

describe('the cross-stage Manager survives the hand-off', () => {
  it('keeps the global Manager pane live when its stage ends', async () => {
    // It listens for every later stage's ASK/REPORT. Reclaiming it makes
    // globalManagerPaneId() return null (it requires `realized`) and the
    // cross-stage router bails on its first line, with nothing logged.
    const { api, paneById, killed } = await load({
      globalManager: { stageId: 'S1', slotLabel: 'mgr' },
    })
    await api.onPipelineNext()
    expect(paneById('S1-mgr')?.realized).toBe(true)
    // Its stage-mate is still reclaimed — the exemption is the Manager, not
    // the stage.
    expect(paneById('S1-w1')?.realized).toBe(false)
    expect(killed.map((k) => k.paneId)).toEqual(['S1-w1'])
  })
})

describe('a pane the user is using is not the run\'s to take', () => {
  it('keeps the focused pane', async () => {
    const { api, paneById, pipeline } = await load({ focusPaneId: 'S1-w1' })
    await api.onPipelineNext()
    expect(paneById('S1-w1')?.realized).toBe(true)
    expect(pipeline.log.some((l) => l.includes('kept') && l.includes('focused'))).toBe(true)
    // The stage's other pane, which nobody is looking at, still goes.
    expect(paneById('S1-mgr')?.realized).toBe(false)
  })

  it('keeps a pane with unsent text in its input line', async () => {
    // The draft lives only in the CLI's input line; ending the process is the
    // one way to lose it for good.
    const { api, paneById, pipeline } = await load({ draftPaneIds: ['S1-w1'] })
    await api.onPipelineNext()
    expect(paneById('S1-w1')?.realized).toBe(true)
    expect(pipeline.log.some((l) => l.includes('kept') && l.includes('has-draft'))).toBe(true)
    expect(paneById('S1-mgr')?.realized).toBe(false)
  })
})

describe('the final stage is left running', () => {
  it('does not reclaim the last stage when the run completes', async () => {
    // The user is about to read its result. onPipelineNext returns from the
    // completion branch before reclaimCompletedStagePanes is reached.
    const { api, pipeline, paneById, killed } = await load({ stageIndex: 2 })
    await api.onPipelineNext()
    expect(pipeline.state).toBe('completed')
    expect(paneById('S3-w1')?.realized).toBe(true)
    expect(paneById('S3-w2')?.realized).toBe(true)
    expect(killed).toEqual([])
  })
})
