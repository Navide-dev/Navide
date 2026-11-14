import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { reclaimBlockedBy, namedReclaimBlockedBy, RECLAIM_NOW_THRESHOLD_MS, type ReclaimCandidate } from '../../lib/idleReclaim'
import { retroBeforeReclaim } from '../../composables/useEvolve'

const source = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function block(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start, startMarker).toBeGreaterThan(-1)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(end, endMarker).toBeGreaterThan(start)
  return source.slice(start, end)
}

function fn(name: string): string {
  const marker = source.includes(`async function ${name}(`)
    ? `async function ${name}(` : `function ${name}(`
  return `${block(marker, '\n}\n')}\n}`
}

type TestPane = ReclaimCandidate & { id: string }

function pane(id: string, overrides: Partial<ReclaimCandidate> = {}): TestPane {
  return {
    id, realized: true, restoring: false, focused: false, resumeSessionId: `session-${id}`,
    rebuilding: false, loopActive: false, preparationStatus: 'ready', injectionStatus: 'done',
    spawnReportPending: false, hasRef: true, displayStatus: 'idle', hasDraft: false,
    lastTouchedAt: Date.now() - 1_000, managerRouting: false, globalManagerRouting: false,
    stageWatched: false, hasQueuedMessages: false, ...overrides,
  }
}

// Execute App's actual handlers with fake process/persistence I/O, without
// mounting its terminal and workspace lifecycles. The real reclaim guards run.
function harness(initial: TestPane[], selected: string[], muted: string[] = []) {
  const panes = ref(initial)
  const selectedPaneIds = ref(new Set(selected))
  const paneCtxMenu = ref<{ paneId: string } | null>({ paneId: selected[0] })
  const mutedIds = ref(new Set(muted))
  const reclaimIdlePane = vi.fn(async (_id: string) => true)
  const toast = vi.fn()
  const persistPaneMuted = vi.fn()
  const syncViews = vi.fn()
  const setPaneMuted = vi.fn((id: string, next: boolean) => {
    if (next) mutedIds.value.add(id)
    else mutedIds.value.delete(id)
  })
  const deps = {
    computed, panes, selectedPaneIds, paneCtxMenu, reclaimIdlePane,
    reclaimBlockedBy, namedReclaimBlockedBy, RECLAIM_NOW_THRESHOLD_MS,
    reclaimCandidate: (p: TestPane) => p,
    // The real helper; a menu reclaim passes no source, so it never asks.
    retroBeforeReclaim,
    backend: { send: vi.fn() },
    closePaneCtxMenu: () => { paneCtxMenu.value = null },
    notifyRestore: { toast },
    i18n: { global: { t: (key: string, args?: unknown) => ({ key, args }) } },
    pipelineLog: vi.fn(),
    isPaneMuted: (id: string) => mutedIds.value.has(id),
    setPaneMuted, persistPaneMuted, syncViews,
  }
  const declarations = [
    block('const reclaimableNowIds = computed<string[]>', '/** Rough bytes'),
    block('const ctxTargetIds = computed<string[]>', '// Spawned descendants'),
    fn('namedReclaimable'),
    block('const ctxReclaimableIds = computed<string[]>', '// Greying the item'),
    fn('reclaimPanesNow'), fn('reclaimSelectedFromMenu'), fn('setSelectedPaneMutedFromMenu'),
  ].join('\n')
  const javascript = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const actions = new Function(...Object.keys(deps), `${javascript}; return {
    ctxReclaimableIds, ctxAllMuted, reclaimSelectedFromMenu, setSelectedPaneMutedFromMenu
  }`)(...Object.values(deps)) as {
    ctxReclaimableIds: { value: string[] }
    ctxAllMuted: { value: boolean }
    reclaimSelectedFromMenu: () => Promise<void>
    setSelectedPaneMutedFromMenu: () => void
  }
  return {
    ...actions, panes, selectedPaneIds, paneCtxMenu, mutedIds, reclaimIdlePane,
    toast, setPaneMuted, persistPaneMuted, syncViews,
  }
}

describe('selected-pane menu actions', () => {
  it('offers counted reclaim and deterministic mute in the batch branch', () => {
    const menu = block('<template v-if="ctxIsBatch">', '<template v-else>')
    expect(menu).toContain("$t('action.reclaim-selected', { count: ctxReclaimableIds.length })")
    expect(menu).toContain('disabled: !ctxReclaimableIds.length')
    expect(menu).toContain("$t('action.reclaim-selected-title')")
    expect(menu).toContain('reclaimSelectedFromMenu()')
    expect(menu).toContain("ctxAllMuted ? $t('action.unmute-selected') : $t('action.mute-selected')")
    expect(menu).toContain('setSelectedPaneMutedFromMenu()')
  })

  it('reclaims only eligible selected panes in a mixed selection', async () => {
    const h = harness([
      pane('idle'), pane('busy', { displayStatus: 'running' }), pane('outside'),
    ], ['idle', 'busy'])
    expect(h.ctxReclaimableIds.value).toEqual(['idle'])
    await h.reclaimSelectedFromMenu()
    expect(h.reclaimIdlePane.mock.calls).toEqual([['idle']])
    expect(h.paneCtxMenu.value).toBeNull()
    expect(h.toast).toHaveBeenCalledWith({
      key: 'pane.terminal.idle-reclaimed', args: { count: 1 },
    }, { type: 'info' })
  })

  // Multi-select hands focus to the last pane clicked, so a focus guard here
  // would always drop one of the panes the user picked.
  it('reclaims the focused pane when it is part of the selection', async () => {
    const h = harness([pane('first'), pane('focused', { focused: true })], ['first', 'focused'])
    expect(h.ctxReclaimableIds.value).toEqual(['first', 'focused'])
    await h.reclaimSelectedFromMenu()
    expect(h.reclaimIdlePane.mock.calls).toEqual([['first'], ['focused']])
  })

  it.each([
    ['awaiting', { displayStatus: 'awaiting' }],
    ['unsent input', { hasDraft: true }],
    ['no resume ID', { resumeSessionId: '' }],
    ['placeholder', { realized: false }],
    ['active loop', { loopActive: true }],
    ['watched', { stageWatched: true }],
    ['queued messages', { hasQueuedMessages: true }],
  ] satisfies [string, Partial<ReclaimCandidate>][])('skips a selected pane with %s', async (_label, override) => {
    const h = harness([pane('safe'), pane('protected', override)], ['safe', 'protected'])
    expect(h.ctxReclaimableIds.value).toEqual(['safe'])
    await h.reclaimSelectedFromMenu()
    expect(h.reclaimIdlePane.mock.calls).toEqual([['safe']])
  })

  it('has zero eligible count and reports refusal when all selected panes are blocked', async () => {
    const h = harness([pane('busy', { displayStatus: 'running' }), pane('draft', { hasDraft: true })], ['busy', 'draft'])
    expect(h.ctxReclaimableIds.value).toEqual([])
    await h.reclaimSelectedFromMenu()
    expect(h.reclaimIdlePane).not.toHaveBeenCalled()
    expect(h.toast).toHaveBeenCalledWith({ key: 'resource.reclaim-blocked', args: undefined }, { type: 'info' })
  })

  it('reports refusal when eligibility becomes stale before execution', async () => {
    const initial = [pane('first'), pane('second')]
    const h = harness(initial, ['first', 'second'])
    expect(h.ctxReclaimableIds.value).toEqual(['first', 'second'])
    // Mutate the raw input, like queued-message Maps which do not invalidate
    // the cached menu count. Execution must still consult the current guard.
    initial.forEach((p) => { p.hasQueuedMessages = true })
    expect(h.ctxReclaimableIds.value).toEqual(['first', 'second'])
    await h.reclaimSelectedFromMenu()
    expect(h.reclaimIdlePane).not.toHaveBeenCalled()
    expect(h.toast).toHaveBeenCalledWith({ key: 'resource.reclaim-blocked', args: undefined }, { type: 'info' })
  })

  it('rechecks each pane while preserving the clicked selection across awaits', async () => {
    const h = harness([pane('first'), pane('second'), pane('third'), pane('outside')], ['first', 'second', 'third'])
    h.reclaimIdlePane.mockImplementation(async (id) => {
      if (id === 'first') {
        h.selectedPaneIds.value = new Set(['outside'])
        h.panes.value.find((p) => p.id === 'second')!.hasDraft = true
      }
      return true
    })
    await h.reclaimSelectedFromMenu()
    expect(h.reclaimIdlePane.mock.calls).toEqual([['first'], ['third']])
  })

  it('ignores selected panes removed before the action', async () => {
    const h = harness([pane('remaining'), pane('removed'), pane('outside')], ['remaining', 'removed'])
    h.panes.value = h.panes.value.filter((p) => p.id !== 'removed')
    await h.reclaimSelectedFromMenu()
    expect(h.reclaimIdlePane.mock.calls).toEqual([['remaining']])
  })

  it('mutes every selected pane consistently when the selection is mixed', () => {
    const h = harness([pane('muted'), pane('unmuted'), pane('outside')], ['muted', 'unmuted'], ['muted'])
    expect(h.ctxAllMuted.value).toBe(false)
    h.setSelectedPaneMutedFromMenu()
    expect([...h.mutedIds.value]).toEqual(['muted', 'unmuted'])
    expect(h.persistPaneMuted.mock.calls).toEqual([['muted', true], ['unmuted', true]])
    expect(h.syncViews).toHaveBeenCalledTimes(1)
    expect(h.paneCtxMenu.value).toBeNull()
  })

  it('unmutes all selected panes while leaving nonselected mute state intact', () => {
    const h = harness([pane('first'), pane('second'), pane('outside')], ['first', 'second'], ['first', 'second', 'outside'])
    expect(h.ctxAllMuted.value).toBe(true)
    h.setSelectedPaneMutedFromMenu()
    expect([...h.mutedIds.value]).toEqual(['outside'])
    expect(h.persistPaneMuted.mock.calls).toEqual([['first', false], ['second', false]])
    expect(h.syncViews).toHaveBeenCalledTimes(1)
  })

  it('does not mute or persist selected panes that have been removed', () => {
    const h = harness([pane('remaining'), pane('removed'), pane('outside')], ['remaining', 'removed'])
    h.panes.value = h.panes.value.filter((p) => p.id !== 'removed')
    h.setSelectedPaneMutedFromMenu()
    expect(h.setPaneMuted.mock.calls).toEqual([['remaining', true]])
    expect(h.persistPaneMuted.mock.calls).toEqual([['remaining', true]])
  })
})
