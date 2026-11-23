// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hostCatalog } from '../../i18n/testing'

// Mounting App starts backend/terminal/settings lifecycles, so — like the other
// App.*.test.ts files — these assert against the source text. They lock in the
// wiring for CLI-pane multi-select (Cmd/Ctrl/Shift-click) + the batch
// right-click context menu, so a refactor can't silently drop it.
const appSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/App.vue'),
  'utf8'
)
const controlPaneSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/ControlPane.vue'),
  'utf8'
)
const agentListSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/AgentList.vue'),
  'utf8'
)

describe('App CLI-pane multi-select + batch context menu', () => {
  it('holds a selection set and prunes it as panes change', () => {
    expect(appSource).toContain('const selectedPaneIds = ref(new Set<string>())')
    // Pruned inside the panes watcher against the live id set.
    expect(appSource).toContain('[...selectedPaneIds.value].filter((id) => ids.has(id))')
  })

  it('toggles the set on modifier-click and clears it on a plain click', () => {
    expect(appSource).toContain('function onSetFocus(paneId: string, ev?: MouseEvent, orderedIds?: string[]): void')
    // Shift ranges, Cmd/Ctrl toggles — two distinct branches.
    expect(appSource).toContain('if (ev && ev.shiftKey)')
    expect(appSource).toContain('if (ev && (ev.metaKey || ev.ctrlKey))')
    // Plain click resets the selection.
    expect(appSource).toContain('selectedPaneIds.value = new Set()')
  })

  it('range-selects on Shift-click via the pure helper, over the clicked surface order', () => {
    expect(appSource).toContain('const lastClickPaneId = ref<string | null>(null)')
    expect(appSource).toContain('function rangeSelectPanes(toId: string, orderedIds?: string[]): void')
    // Range math lives in the behavior-tested pure helper; App resolves the
    // surface order and the anchor (last click, falling back to focus).
    expect(appSource).toContain('const ordered = orderedIds ?? panes.value.map((p) => p.id)')
    expect(appSource).toContain('const anchor = lastClickPaneId.value ?? focusPaneId.value')
    expect(appSource).toContain('selectedPaneIds.value = computeRangeSelection(ordered, anchor, toId)')
    // Each surface supplies its own render order so a range never sweeps in
    // panes that surface does not show (minimized, other tab, other grid page).
    expect(appSource).toContain('const stageSurfaceOrderedIds = computed<string[]>')
    expect(appSource).toContain('const auxiliaryListOrderedIds = computed<string[]>')
    // The anchor is invalidated when its pane disappears.
    expect(appSource).toContain(
      'if (lastClickPaneId.value && !ids.has(lastClickPaneId.value)) lastClickPaneId.value = null'
    )
  })

  it('targets the whole selection only when the clicked pane is in a set of >1', () => {
    expect(appSource).toContain('const ctxTargetIds = computed<string[]>')
    expect(appSource).toContain('selectedPaneIds.value.has(m.paneId) && selectedPaneIds.value.size > 1')
    expect(appSource).toContain('const ctxIsBatch = computed(() => ctxTargetIds.value.length > 1)')
  })

  it('defines the batch action helpers', () => {
    expect(appSource).toContain('async function batchInterrupt(ids: string[])')
    expect(appSource).toContain('function batchMinimize(ids: string[])')
    expect(appSource).toContain('function batchRestore(ids: string[])')
    expect(appSource).toContain('async function batchKill(ids: string[])')
    expect(appSource).toContain('async function batchRebuild(ids: string[])')
  })

  it('renders the batch menu branch wired to the batch helpers', () => {
    expect(appSource).toContain('<template v-if="ctxIsBatch">')
    expect(appSource).toContain('batchInterrupt(ctxTargetIds); closePaneCtxMenu()')
    expect(appSource).toContain('batchRebuild(ctxTargetIds); closePaneCtxMenu()')
    expect(appSource).toContain('batchMinimize(ctxTargetIds); closePaneCtxMenu()')
    expect(appSource).toContain('batchRestore(ctxTargetIds); closePaneCtxMenu()')
    expect(appSource).toContain('batchKill(ctxTargetIds); closePaneCtxMenu()')
  })

  it('passes selection state + the click event down to each pane surface', () => {
    expect(appSource).toContain(':is-selected="selectedPaneIds.has(p.id)"')
    expect(appSource).toContain('@set-focus="(ev) => onSetFocus(p.id, ev, stageSurfaceOrderedIds)"')
    // The main-window lists route through onAuxiliaryListClick, which hands
    // rows on the stage to onSetFocus with the list's own order.
    expect(appSource).toContain('@click="(ev) => onAuxiliaryListClick(p.id, ev)"')
    expect(appSource).toContain('onSetFocus(paneId, ev, auxiliaryListOrderedIds.value)')
  })

  it('wires the sidebar agent list into the same multi-select', () => {
    // App passes the selection down and routes sidebar clicks through the
    // modifier-aware handler (plain clicks keep the focus + scroll behavior).
    expect(appSource).toContain(':selected-pane-ids="selectedPaneIds"')
    expect(appSource).toContain('@focus-pane="onSidebarFocusPane"')
    // async since a plain click may first switch to the pane's workspace —
    // the sidebar lists panes the grid is filtering out.
    expect(appSource).toContain(
      'async function onSidebarFocusPane(paneId: string, ev?: MouseEvent): Promise<void>'
    )
    // Sidebar ranges over the order it actually renders: each workspace
    // section in turn, each one's lineage flattened. paneViews is the flat
    // spawn order, which stopped matching the moment the list gained
    // indentation and stopped matching further once it gained sections.
    expect(appSource).toContain('onSetFocus(paneId, ev, sidebarOrderedPaneIds.value)')
    // The flattening moved to lib/paneFocus, which is tested by running it —
    // including that rows from another window are skipped, since this window
    // has no terminal for their panes. Here: App feeds it the grouped rows.
    const start = appSource.indexOf('const sidebarOrderedPaneIds = computed')
    expect(start).toBeGreaterThan(-1)
    const body = appSource.slice(start, appSource.indexOf('\n)', start))
    expect(body).toContain('flattenSidebarOrder(workspaceGroups.value)')
    // ControlPane forwards the native MouseEvent and paints the selection,
    // without toggling the accordion on a modifier click.
    expect(controlPaneSource).toContain('@click="onAgentLineClick(p.id, $event)"')
    expect(controlPaneSource).toContain('function onAgentLineClick(paneId: string, ev?: MouseEvent): void')
    expect(controlPaneSource).toContain('if (ev && (ev.metaKey || ev.ctrlKey || ev.shiftKey)) return')
    expect(controlPaneSource).toContain("(e: 'focus-pane', paneId: string, ev?: MouseEvent): void")
    expect(controlPaneSource).toContain("'agent-item--selected': props.selectedPaneIds?.has(p.id)")
    // AgentList exposes the same contract.
    expect(agentListSource).toContain('@click="emit(\'focus-pane\', p.id, $event)"')
    expect(agentListSource).toContain("(e: 'focus-pane', paneId: string, ev?: MouseEvent): void")
    expect(agentListSource).toContain("'agent-item--selected': selectedPaneIds?.has(p.id)")
  })

  it('ships i18n keys for every batch menu label in both locales', () => {
    for (const locale of ['en-US', 'zh-TW']) {
      const json = hostCatalog(locale) as { action: Record<string, string> }
      expect(json.action['selected-count']).toContain('{count}')
      expect(json.action['interrupt-selected']).toBeTruthy()
      expect(json.action['rebuild-selected']).toBeTruthy()
      expect(json.action['minimize-selected']).toBeTruthy()
      expect(json.action['restore-selected']).toBeTruthy()
      expect(json.action['reclaim-selected']).toContain('{count}')
      expect(json.action['reclaim-selected-title']).toBeTruthy()
      expect(json.action['mute-selected']).toBeTruthy()
      expect(json.action['unmute-selected']).toBeTruthy()
      expect(json.action['remove-selected']).toBeTruthy()
    }
  })
})
