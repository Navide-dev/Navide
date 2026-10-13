<script setup lang="ts">
import { computed, ref, watch, type Ref } from 'vue'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import { executeCommand, settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { useTokens, type TokenBucket, type ResetScope } from '../composables/useTokens'
import { buildTokenGroupRows } from '../lib/tokenGroups'
import { accountUsageFor, formatRemaining, isExhausted, remainingPercent } from '../composables/useUsage'
import type { useCliProfiles } from '../composables/useCliProfiles'
import { DEFAULT_PROFILE_ID, UNKNOWN_PROFILE_ID, accountLabel } from '../lib/accountLabel'
import { i18n, useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'
import HistoryPanel from './HistoryPanel.vue'
import TaskerPanel from './TaskerPanel.vue'
import AgentMessagesPanel from './AgentMessagesPanel.vue'
import DevTimePanel from './DevTimePanel.vue'
import PreviewPanel from '../preview/PreviewPanel.vue'
import { usePreview } from '../preview/usePreview'
import type { PipelineStatusView } from './ControlPane.vue'

interface Stage {
  id: string
  shortTitle?: string
  title?: string
}

interface ActivePane {
  id: string
  /** Vendor key; the TIME tab labels each pane's row with it. */
  agentKey?: string
  agentLabel: string
  roleLabel: string
  stageId?: string
  slotLabel?: string
  /** Present at runtime on ActivePaneView; keys this pane's live bucket. */
  sessionId?: string
}

interface Props {
  backend: ReturnType<typeof useBackend>
  workspacePath: string
  stages: Stage[]
  /** Sidebar run groups, in sidebar order. Rows come from the snapshot's
   *  by_group buckets, so a group that spent nothing still lists as zero. */
  runGroups?: readonly { id: string; name: string }[]
  panes: ActivePane[]
  /** The pane the user is looking at right now. The top block reports this
   *  pane's session alone — a workspace-wide tally answered a question nobody
   *  asked. Absent (or naming a pane that is not a CLI pane) means "nothing
   *  focused", which reports zero rather than somebody else's numbers. */
  activePaneId?: string | null
  pipeline: PipelineStatusView
  /** Owned by the parent: this panel renders it and asks for changes. */
  expanded: boolean
  /** View ids assigned to this slot, in tab order. Omitted means "all of
   *  them" — the layout store supplies the real list. A view moved to another
   *  slot disappears from here, which is what keeps it a singleton. */
  views?: string[]
  /** The accounts source the usage badge reads: names the BY ACCOUNT rows
   *  and finds each account's own quota. Optional — without it the rows show
   *  ids and no quota. */
  cliProfiles?: ReturnType<typeof useCliProfiles>
}

const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'update:expanded', v: boolean): void }>()

// We expose the workspace path as a ref so useTokens can watch() it.
const workspacePathRef: Ref<string> = computed(() => props.workspacePath) as unknown as Ref<string>
const { snapshot, loading, reset } = useTokens(props.backend, workspacePathRef)

// ─────────────────────── Sticky panel state ───────────────────────────────

// Controlled, not mirrored. This used to be a local ref seeded from the same
// settings key the parent reads, with `update:expanded` emitted one way — so
// `v-model:expanded` looked two-way but was not: the parent could never open or
// close the panel, and both sides persisted the key independently. The parent
// owns the value and the write; this component only asks.
const expanded = computed(() => props.expanded)
function setExpanded(v: boolean): void {
  emit('update:expanded', v)
}

// Active right-panel tab — the pipeline History timeline (default), token stats,
// Tasker (machine-level crontab / LaunchAgents), the inter-CLI message log, or
// the read-only preview panel.
// Unknown or legacy persisted values fall back to the default.
type RightTab = 'history' | 'tokens' | 'time' | 'tasker' | 'messages' | 'preview'

// Icon and label per tab, in the panel's own order. Which of them actually
// render is the layout's decision (`props.views`); this table only says how.
//
// Two icon forms, matching ControlPane's RAIL_TABS on the opposite side:
// `paths` are 16\u00d716 line-art glyphs for the expanded tab strip, `icon` is the
// emoji the collapsed rail shows beside its vertical label. Keeping both in
// one table is what lets the two slots stay visually symmetric \u2014 the left
// sidebar draws the same pair the same way.
const TABS: { id: RightTab; icon: string; labelKey: string; paths: string[] }[] = [
  {
    id: 'history', icon: '\u{1F4DC}', labelKey: 'label.history',
    paths: [
      'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM3 8a5 5 0 1 1 10 0A5 5 0 0 1 3 8Z',
      'M7.4 4.5h1.2v3.4h2.9v1.2H7.4Z',
    ],
  },
  {
    id: 'tokens', icon: '\u{1F4CA}', labelKey: 'label.tokens',
    paths: [
      'M2.5 7.5h2.25v6H2.5Z',
      'M6.9 3.5h2.25v10H6.9Z',
      'M11.3 6h2.25v7.5H11.3Z',
    ],
  },
  {
    id: 'time', icon: '\u23F1', labelKey: 'label.time',
    paths: [
      'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Z',
      'M7.4 4.75h1.2v3.1l2.2 1.3-.6 1.04L7.4 8.6Z',
    ],
  },
  {
    id: 'tasker', icon: '\u{1F5D3}', labelKey: 'label.tasker',
    paths: [
      'M3.75 3h8.5A1.75 1.75 0 0 1 14 4.75v8.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-8.5A1.75 1.75 0 0 1 3.75 3Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25Z',
      'M2.75 6.5h10.5V8H2.75Z',
      'M5 1a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 5 1Zm6 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 11 1Z',
    ],
  },
  {
    id: 'messages', icon: '\u2709', labelKey: 'label.messages',
    paths: [
      'M2.75 3h10.5A1.75 1.75 0 0 1 15 4.75v6.5A1.75 1.75 0 0 1 13.25 13H2.75A1.75 1.75 0 0 1 1 11.25v-6.5A1.75 1.75 0 0 1 2.75 3Zm0 1.5a.25.25 0 0 0-.25.25v6.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-6.5a.25.25 0 0 0-.25-.25Z',
      'M2.4 5.32a.75.75 0 0 1 1.04-.22L8 8.1l4.56-3a.75.75 0 1 1 .82 1.26l-4.97 3.26a.75.75 0 0 1-.82 0L2.62 6.36a.75.75 0 0 1-.22-1.04Z',
    ],
  },
  {
    id: 'preview', icon: '\u{1F441}', labelKey: 'label.preview',
    paths: [
      'M8 3.5c3.1 0 5.7 2.1 6.9 4.2a.6.6 0 0 1 0 .6C13.7 10.4 11.1 12.5 8 12.5S2.3 10.4 1.1 8.3a.6.6 0 0 1 0-.6C2.3 5.6 4.9 3.5 8 3.5Zm0 1.5C5.6 5 3.4 6.6 2.3 8c1.1 1.4 3.3 3 5.7 3s4.6-1.6 5.7-3C12.6 6.6 10.4 5 8 5Z',
      'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
    ],
  },
]

// Ordered by the slot, not by this table: moving a view also reorders it.
const visibleTabs = computed(() => {
  const assigned = props.views
  if (!assigned) return TABS
  return assigned.map((id) => TABS.find((t) => t.id === id)).filter((t): t is typeof TABS[number] => !!t)
})

const tab = ref<RightTab>('history')
{
  const t = settingsGet<string | null>('agentTeam.rightPanel.tab', null)
  if (TABS.some((x) => x.id === t)) tab.value = t as RightTab
}
watch(tab, (v) => {
  settingsSet('agentTeam.rightPanel.tab', v)
})

// The active tab can be moved out from under us — by this window's own
// Settings, or by another window, since the layout is shared. Falling back to
// the first remaining tab keeps the panel showing something; without this the
// body renders nothing and the panel looks broken rather than empty.
watch(visibleTabs, (tabs) => {
  if (!tabs.length || tabs.some((t) => t.id === tab.value)) return
  tab.value = tabs[0].id
}, { immediate: true })

/**
 * The tab whose body should render, or null when this slot holds nothing.
 *
 * Bodies key off this rather than off `tab` directly. The fallback above keeps
 * the two equal in every normal case, but it deliberately bails when the slot
 * has been emptied — and a body left mounted in a zero-width panel is a second
 * live copy of a view that is supposed to be a singleton, quietly holding a
 * backend subscription nobody can see.
 */
const activeTab = computed<RightTab | null>(() =>
  visibleTabs.value.some((t) => t.id === tab.value) ? tab.value : null
)

// Any show() from usePreview (user click, agent push, plugin call) surfaces
// the panel: switch to the Preview tab and expand the rail if collapsed.
// Guarded on the view still living here — once it has been taken off the
// layout, claiming the tab would leave this panel showing nothing at all.
const preview = usePreview()
watch(preview.focusRequest, () => {
  if (!visibleTabs.value.some((t) => t.id === 'preview')) return
  tab.value = 'preview'
  setExpanded(true)
})

// ─────────────────────── Derived view models ──────────────────────────────

const EMPTY: TokenBucket = { input: 0, output: 0, calls: 0 }

const currentRun = computed(() => snapshot.value?.workspace?.current_run ?? null)
const runTotals = computed<TokenBucket>(() => currentRun.value?.totals ?? EMPTY)

// Live tallies keyed by SESSION id — read straight from each vendor's session
// log, not accumulated from events. They exist whether or not a pipeline run
// is active, so a manually opened CLI pane still reports numbers. Keying on
// the session (not the pane) is what stops one CLI session from being counted
// once per pane id it has been through: a restored or respawned pane resumes
// the same session under a fresh ephemeral id.
const liveBySession = computed<Record<string, TokenBucket>>(
  () => snapshot.value?.workspace?.live_by_session ?? {}
)
// The pane in focus, or null when nothing focused resolves to a CLI pane.
const focusPane = computed<ActivePane | null>(
  () => (props.panes ?? []).find((p) => p.id === props.activePaneId) ?? null
)
// That pane's own live bucket. Null covers all three "no number to show"
// cases at once: no focus, a pane with no session bound, and a session the
// scanner has not reported yet.
const focusSession = computed<TokenBucket | null>(() => {
  const sid = focusPane.value?.sessionId
  return (sid && liveBySession.value[sid]) || null
})
// The top block shows the run when there is one and the FOCUSED pane's
// session otherwise — never a sum across the workspace's sessions, which is
// what made a single pane read as everybody's usage combined.
const topTotals = computed<TokenBucket>(() =>
  currentRun.value ? runTotals.value : focusSession.value ?? EMPTY
)
const cumulative = computed<TokenBucket>(() =>
  snapshot.value?.workspace?.cumulative?.totals ?? EMPTY
)
const allTime = computed<TokenBucket>(() => snapshot.value?.global?.all_time ?? EMPTY)

// Names come from the specs, which already carry each vendor's display label
// — a second table here drifted from them silently. The analyzer is the one
// pseudo-vendor with no spec: it exists in token accounting only, and is not
// a spawnable CLI. (Cursor CLI stores no token data locally, so its row shows
// a label with empty stats.)
const ANALYZER = 'analyzer'
const VENDOR_LABELS: Record<string, string> = {
  ...Object.fromEntries(CLI_AGENT_SPECS.map((s) => [s.agentKey, s.label])),
  [ANALYZER]: 'Local analyzer'
}
const KNOWN_VENDORS = [...CLI_AGENT_SPECS.map((s) => s.agentKey), ANALYZER]

// Vendor / Stage breakdowns come from workspace CUMULATIVE (not just current run)
// so they remain visible even when no pipeline is actively running. The current
// run's contribution is already surfaced in its own "Current run" section above.
const cumulativeByVendor = computed(
  () => snapshot.value?.workspace?.cumulative?.by_vendor ?? {}
)
const cumulativeByStage = computed(
  () => snapshot.value?.workspace?.cumulative?.by_stage ?? {}
)
const cumulativeByGroup = computed(
  () => snapshot.value?.workspace?.cumulative?.by_group ?? {}
)

const vendorRows = computed(() => {
  const map = cumulativeByVendor.value
  return KNOWN_VENDORS.map((v) => ({
    key: v,
    label: VENDOR_LABELS[v] ?? v,
    bucket: map[v] ?? EMPTY
  }))
})

const stageRows = computed(() => {
  const map = cumulativeByStage.value
  return (props.stages ?? []).map((s) => ({
    id: s.id,
    label: s.shortTitle ?? s.title ?? s.id,
    bucket: map[s.id] ?? EMPTY
  }))
})

const groupRows = computed(() =>
  buildTokenGroupRows(props.runGroups ?? [], cumulativeByGroup.value, {
    manual: i18n.global.t('label.manual'),
    orphan: i18n.global.t('label.orphan-group'),
  })
)

// BY ACCOUNT: one row per pinned account the workspace's cumulative ledger
// has a bucket for. Real accounts largest first, then the built-in Default,
// then the unknown bucket (records from before pinning existed, which must
// never be folded into an account). The quota column is the account's own
// slot reading — the same one the badge's switch list shows.
const cumulativeByAccount = computed(
  () => snapshot.value?.workspace?.cumulative?.by_account ?? {}
)
const accountRows = computed(() => {
  const map = cumulativeByAccount.value
  const t = (key: string): string => i18n.global.t(key)
  const rows = Object.entries(map).map(([id, bucket]) => {
    const agentKey = props.cliProfiles?.findProfile(id)?.agentKey ?? ''
    const reserved = id === DEFAULT_PROFILE_ID || id === UNKNOWN_PROFILE_ID
    const snap = agentKey ? accountUsageFor(agentKey, id) : undefined
    let quota = '—'
    if (isExhausted(snap)) quota = t('usage.exhausted-short')
    else {
      const remaining = remainingPercent(snap)
      if (remaining !== null) quota = formatRemaining(remaining)
    }
    return {
      key: id,
      label: accountLabel(props.cliProfiles, agentKey, id, t),
      unknown: id === UNKNOWN_PROFILE_ID,
      bucket,
      quota,
      rank: id === UNKNOWN_PROFILE_ID ? 2 : id === DEFAULT_PROFILE_ID ? 1 : 0,
      size: reserved ? 0 : bucket.input + bucket.output,
    }
  })
  return rows.sort((a, b) => a.rank - b.rank || b.size - a.size || a.label.localeCompare(b.label))
})

const paneRows = computed(() => {
  const run = currentRun.value
  const map = run ? run.by_pane : liveBySession.value
  // Without a run a bucket belongs to a session, and several panes can be
  // bound to the same one — credit it to the first row only, so the same
  // figure is never listed twice.
  const claimed = new Set<string>()
  return (props.panes ?? []).map((p) => {
    // Prefer stable key (stageId:slotLabel) so data survives frontend restarts.
    // Fall back to UUID for manual panes that have no stage/slot.
    const stableKey = p.stageId && p.slotLabel ? `${p.stageId}:${p.slotLabel}`
                    : p.stageId || p.id
    let live: TokenBucket | undefined
    if (!run && p.sessionId && !claimed.has(p.sessionId)) {
      live = map[p.sessionId]
      if (live) claimed.add(p.sessionId)
    }
    return {
      id: p.id,
      label: p.agentLabel,
      sub: p.roleLabel,
      bucket: live ?? (run ? map[stableKey] ?? map[p.id] : undefined) ?? EMPTY
    }
  })
})

// The collapsed rail badge stays tied to the pipeline run: a permanently
// visible session tally on the rail is noise, not a signal.
const collapsedTotal = computed(() => fmt(runTotals.value.input + runTotals.value.output))

// ─────────────────────── Formatting helpers ───────────────────────────────

// Every tier caps at six characters ("999.9M"), which is what the fixed-width
// cells fit. Stopping at M was the bug: a workspace past a billion tokens
// rendered "77059.4M" and the cell clipped it to "77059...." — the IN and
// TOTAL figures became unreadable exactly once they got interesting.
function fmt(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k'
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n < 1_000_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B'
  return (n / 1_000_000_000_000).toFixed(1) + 'T'
}

// ─────────────────────── Reset confirmations ──────────────────────────────

const { confirm: notifyConfirm } = useNotify()

async function confirmReset(scope: ResetScope): Promise<void> {
  const msg = {
    // Without a run the ⟲ next to it clears this session's live tally instead.
    run: currentRun.value
      ? 'Reset the current pipeline run’s token counters? Workspace cumulative and global totals stay intact.'
      : 'Reset this session’s token counters? Workspace cumulative and global totals stay intact.',
    workspace: 'Wipe all token data for this workspace (current run + runs history + cumulative)? Global totals stay intact.',
    global: 'Wipe global all-time token totals? This affects every workspace.'
  }[scope]
  if (!(await notifyConfirm(msg, { title: 'Reset tokens', confirmText: 'Reset' }))) return
  await reset(scope)
}

// Per-turn breakdown is App's Turn Stats modal; the command is the same one
// the Window menu and the palette run, so the three entries cannot drift.
function openTurnStats(): void {
  executeCommand('ui.window.openTurnStats')
}
</script>

<template>
  <aside class="token-panel" :class="{ 'is-expanded': expanded, 'is-collapsed': !expanded }">
    <!-- Collapsed rail: one icon per tab — click to expand + switch tab -->
    <div v-if="!expanded" class="rail">
      <button
        v-for="t in visibleTabs"
        :key="t.id"
        class="rail-btn"
        :class="{ active: tab === t.id }"
        :title="t.id === 'tokens' ? `${$t('layout.expand')} · ${collapsedTotal}` : $t('layout.expand')"
        @click="tab = t.id; setExpanded(true)"
      >
        <span class="rail-icon">{{ t.icon }}</span>
        <span class="rail-label">{{ $t(t.labelKey) }}</span>
        <span v-if="t.id === 'tokens' && runTotals.calls > 0" class="rail-badge">{{ collapsedTotal }}</span>
      </button>
    </div>

    <!-- Expanded panel -->
    <template v-else>
      <!-- Mirror of ControlPane's tab strip: icon-only buttons banked against
           the window edge, collapse chevron on the inner side pointing the way
           the panel folds. Left slot folds left ("‹") from its right edge, so
           this one folds right ("›") from its left edge. -->
      <header class="hdr">
        <button class="collapse" :title="$t('action.collapse')" @click="setExpanded(false)">›</button>
        <div class="tabs">
          <button
            v-for="t in visibleTabs"
            :key="t.id"
            class="tab"
            :class="{ active: tab === t.id }"
            :title="$t(t.labelKey)"
            :aria-label="$t(t.labelKey)"
            @click="tab = t.id"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path v-for="(d, i) in t.paths" :key="i" :d="d" />
            </svg>
          </button>
        </div>
      </header>

      <HistoryPanel v-if="activeTab === 'history'" :backend="backend" :workspace-path="workspacePath" :pipeline="pipeline" />
      <TaskerPanel v-else-if="activeTab === 'tasker'" :backend="backend" />
      <AgentMessagesPanel v-else-if="activeTab === 'messages'" />
      <DevTimePanel
        v-else-if="activeTab === 'time'"
        :backend="backend"
        :workspace-path="workspacePath"
        :panes="panes"
      />
      <PreviewPanel
        v-else-if="activeTab === 'preview'"
        :backend="backend"
        :workspace-path="workspacePath"
      />

      <!-- Named rather than a bare v-else: the fallthrough would render the
           token stats whenever no view is active, which is exactly the case
           the guard above exists to catch. -->
      <template v-else-if="activeTab === 'tokens'">
      <div v-if="loading && !snapshot" class="msg">{{ $t('label.loading') }}</div>

      <div class="body">
        <!-- Current run total -->
        <section class="block">
          <div class="block-hdr">
            <span class="block-title">{{ currentRun ? $t('label.current-run') : $t('label.current-session') }}</span>
            <!-- Per-turn breakdown is the Turn Stats modal (Window → Turn Stats);
                 this is the same entry, reachable from where the figures are. -->
            <button
              class="reset-btn open-turns-btn"
              data-act="open-turn-stats"
              :title="$t('turn-stats.open-window')"
              :aria-label="$t('turn-stats.open-window')"
              @click="openTurnStats"
            >≡</button>
            <button class="reset-btn" :title="$t('action.reset-run-counter')" @click="confirmReset('run')">⟲</button>
          </div>
          <div v-if="currentRun" class="run-meta" v-truncate :title="currentRun.task">
            <span class="run-id">{{ currentRun.run_id || '—' }}</span>
          </div>
          <!-- Whose session these figures belong to. A count was meaningless
               once the block stopped summing sessions — the reader needs to
               recognise the pane in front of them. -->
          <div v-else class="run-meta" v-truncate>
            <span v-if="!focusPane" class="run-id">{{ $t('label.no-focused-pane') }}</span>
            <span v-else-if="!focusSession" class="run-id">
              {{ $t('label.pane-no-session', { pane: focusPane.agentLabel }) }}
            </span>
            <span v-else class="run-id">{{ focusPane.agentLabel }}</span>
          </div>
          <div class="totals">
            <div class="cell"><div class="big" v-truncate>{{ fmt(topTotals.input) }}</div><div class="lbl">{{ $t('label.in') }}</div></div>
            <div class="cell"><div class="big" v-truncate>{{ fmt(topTotals.output) }}</div><div class="lbl">{{ $t('label.out') }}</div></div>
            <div class="cell"><div class="big" v-truncate>{{ fmt(topTotals.input + topTotals.output) }}</div><div class="lbl">{{ $t('label.total') }}</div></div>
            <div class="cell"><div class="big" v-truncate>{{ topTotals.calls }}</div><div class="lbl">{{ $t('label.calls') }}</div></div>
          </div>
        </section>

        <!-- Cumulative (workspace lifetime) -->
        <section class="block">
          <div class="block-hdr">
            <span class="block-title">{{ $t('label.workspace-cumulative') }}</span>
            <button class="reset-btn" :title="$t('action.wipe-workspace-history')" @click="confirmReset('workspace')">⟲</button>
          </div>
          <div class="totals">
            <div class="cell"><div class="big" v-truncate>{{ fmt(cumulative.input) }}</div><div class="lbl">{{ $t('label.in') }}</div></div>
            <div class="cell"><div class="big" v-truncate>{{ fmt(cumulative.output) }}</div><div class="lbl">{{ $t('label.out') }}</div></div>
            <div class="cell"><div class="big" v-truncate>{{ fmt(cumulative.input + cumulative.output) }}</div><div class="lbl">{{ $t('label.total') }}</div></div>
            <div class="cell"><div class="big" v-truncate>{{ cumulative.calls }}</div><div class="lbl">{{ $t('label.calls') }}</div></div>
          </div>
        </section>

        <!-- Global all-time -->
        <section class="block">
          <div class="block-hdr">
            <span class="block-title">{{ $t('label.all-time-global') }}</span>
            <button class="reset-btn" :title="$t('action.wipe-global-tally')" @click="confirmReset('global')">⟲</button>
          </div>
          <div class="totals">
            <div class="cell"><div class="big" v-truncate>{{ fmt(allTime.input) }}</div><div class="lbl">{{ $t('label.in') }}</div></div>
            <div class="cell"><div class="big" v-truncate>{{ fmt(allTime.output) }}</div><div class="lbl">{{ $t('label.out') }}</div></div>
            <div class="cell"><div class="big" v-truncate>{{ fmt(allTime.input + allTime.output) }}</div><div class="lbl">{{ $t('label.total') }}</div></div>
            <div class="cell"><div class="big" v-truncate>{{ allTime.calls }}</div><div class="lbl">{{ $t('label.calls') }}</div></div>
          </div>
        </section>

        <!-- By Vendor -->
        <section class="block">
          <div class="block-hdr"><span class="block-title">{{ $t('label.by-vendor') }}</span></div>
          <table class="grid">
            <tbody>
              <tr v-for="row in vendorRows" :key="row.key">
                <th v-truncate>{{ row.label }}</th>
                <td v-truncate>{{ fmt(row.bucket.input) }}</td>
                <td v-truncate>{{ fmt(row.bucket.output) }}</td>
                <td class="dim" v-truncate>{{ row.bucket.calls }}</td>
              </tr>
              <tr class="head">
                <th></th><td v-truncate>{{ $t('label.in') }}</td><td v-truncate>{{ $t('label.out') }}</td><td class="dim" v-truncate>{{ $t('label.calls') }}</td>
              </tr>

            </tbody>
          </table>
        </section>

        <!-- By Account -->
        <section class="block" data-block="by-account">
          <div class="block-hdr"><span class="block-title">{{ $t('label.by-account') }}</span></div>
          <div v-if="!accountRows.length" class="muted">{{ $t('label.no-accounts') }}</div>
          <table v-else class="grid grid-accounts">
            <tbody>
              <tr v-for="row in accountRows" :key="row.key" data-row="account" :data-account="row.key" :class="{ unknown: row.unknown }">
                <th :title="row.key" v-truncate>{{ row.label }}</th>
                <td v-truncate>{{ fmt(row.bucket.input) }}</td>
                <td v-truncate>{{ fmt(row.bucket.output) }}</td>
                <td class="dim" v-truncate>{{ row.bucket.calls }}</td>
                <td class="dim quota" data-part="quota" v-truncate>{{ row.quota }}</td>
              </tr>
              <tr class="head">
                <th></th><td v-truncate>{{ $t('label.in') }}</td><td v-truncate>{{ $t('label.out') }}</td><td class="dim" v-truncate>{{ $t('label.calls') }}</td><td class="dim" v-truncate>{{ $t('label.quota') }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- By Stage -->
        <section class="block">
          <div class="block-hdr"><span class="block-title">{{ $t('label.by-stage') }}</span></div>
          <div v-if="!stageRows.length" class="muted">{{ $t('label.no-stages') }}</div>
          <table v-else class="grid">
            <tbody>
              <tr v-for="row in stageRows" :key="row.id">
                <th v-truncate>{{ row.label }}</th>
                <td v-truncate>{{ fmt(row.bucket.input) }}</td>
                <td v-truncate>{{ fmt(row.bucket.output) }}</td>
                <td class="dim" v-truncate>{{ row.bucket.calls }}</td>
              </tr>

            </tbody>
          </table>
        </section>

        <!-- By Group -->
        <section class="block">
          <div class="block-hdr"><span class="block-title">{{ $t('label.by-group') }}</span></div>
          <div v-if="!groupRows.length" class="muted">{{ $t('label.no-groups') }}</div>
          <table v-else class="grid">
            <tbody>
              <tr v-for="row in groupRows" :key="row.key">
                <th v-truncate>{{ row.label }}</th>
                <td v-truncate>{{ fmt(row.bucket.input) }}</td>
                <td v-truncate>{{ fmt(row.bucket.output) }}</td>
                <td class="dim" v-truncate>{{ row.bucket.calls }}</td>
              </tr>

            </tbody>
          </table>
        </section>

        <!-- By Pane -->
        <section class="block">
          <div class="block-hdr"><span class="block-title">{{ $t('label.by-pane') }}</span></div>
          <div v-if="!paneRows.length" class="muted">{{ $t('label.no-active-panes') }}</div>
          <table v-else class="grid">
            <tbody>
              <tr v-for="row in paneRows" :key="row.id">
                <th :title="row.sub" v-truncate>{{ row.label }}</th>
                <td v-truncate>{{ fmt(row.bucket.input) }}</td>
                <td v-truncate>{{ fmt(row.bucket.output) }}</td>
                <td class="dim" v-truncate>{{ row.bucket.calls }}</td>
              </tr>

            </tbody>
          </table>
        </section>
      </div>
      </template>
    </template>
  </aside>
</template>

<style scoped>
.token-panel {
  height: 100%;
  background: var(--bg-base);
  border-left: 1px solid var(--border-muted);
  display: flex;
  flex-direction: column;
  color: var(--text-bright);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: var(--font-xs);
  min-height: 0;
  overflow: hidden;
}

/* ─────── collapsed rail ─────── */
.rail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  height: 100%;
  /* The vertical tab labels are tall and there are four of them; a short window
     would otherwise clip the last tab out of reach (.token-panel hides its
     overflow). Scrolling here keeps every tab reachable — the reasoning is
     unchanged by the extra button, only the height at which it starts to bite. */
  overflow-y: auto;
}
.rail-btn {
  appearance: none;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 14px 4px;
  width: 100%;
}
.rail-btn:hover {
  background: var(--bg-subtle);
  color: var(--text-bright);
}
.rail-btn.active {
  color: var(--accent-fg);
}
.rail-icon { font-size: var(--font-lg); }
.rail-label {
  /* No rotate(180deg) here: that bottom-up "book spine" trick flips CJK
     glyphs upside down. Plain vertical-rl keeps CJK upright (top-to-bottom)
     and rotates Latin text 90° clockwise — both readable. */
  writing-mode: vertical-rl;
  letter-spacing: 1px;
  font-size: var(--font-3xs);
  text-transform: uppercase;
}
.rail-badge {
  font-size: var(--font-3xs);
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  padding: 2px 6px;
  border-radius: 999px;
  margin-top: auto;
}

/* ─────── expanded panel ─────── */
/* Geometry copied from ControlPane's .sidebar-tabs — same padding, same gap,
   same hairline, and no tinted fill, so the two strips sit at one height and
   read as a single band across the window rather than two different headers. */
.hdr {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px 6px;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
/* Same silhouette as ControlPane's .tab-collapse — a borderless chevron that
   only paints on hover. The framed button it replaced read as a sixth control
   sitting in a row of five. */
.collapse {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 30px;
  flex-shrink: 0;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.collapse:hover { color: var(--text-primary); background: var(--bg-elevated); }
.title {
  font-weight: 600;
  flex: 1;
}
.tabs {
  display: flex;
  gap: 4px;
  flex: 1;
  /* Banked against the window edge, mirroring the left sidebar's strip, which
     hugs the opposite edge. */
  justify-content: flex-end;
  /* Icon-only buttons are 30px, so five of them plus the chevron clear the
     panel's 180px minimum — but a slot narrowed further still wraps to a second
     row rather than clipping a tab. The header is `flex-shrink: 0` and `.body`
     owns its own scrolling, so wrapping shortens the body instead of pushing it
     out of the panel. */
  flex-wrap: wrap;
  min-width: 0;
}
/* Matches ControlPane's .tab-btn so both slots read as one control surface. */
.tab {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out);
}
.tab:hover { color: var(--text-primary); background: var(--bg-elevated); }
.tab.active {
  color: var(--text-bright);
  background: var(--bg-muted);
}
.body {
  flex: 1;
  overflow-y: auto;
  overflow-x: auto;
  padding: 8px 0;
  min-height: 0;
}
.msg { padding: 12px; color: var(--text-secondary); }

.block {
  padding: 8px 12px;
  border-bottom: 1px solid var(--bg-subtle);
}
.block-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.block-title {
  font-size: var(--font-2xs);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  flex: 1;
}
.reset-btn {
  appearance: none;
  background: transparent;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
  border-radius: 3px;
  padding: 0 6px;
  line-height: 1.7;
}
.reset-btn:hover { color: var(--danger-fg); border-color: var(--danger-fg); }
.open-turns-btn:hover { color: var(--text-bright); border-color: var(--border-strong); }
.run-meta {
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-id {
  font-family: Menlo, Monaco, monospace;
}
.muted { color: var(--text-secondary); font-size: var(--font-2xs); margin: 4px 0; }

.totals {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}
.cell {
  text-align: center;
  background: var(--bg-subtle);
  border-radius: 3px;
  padding: 6px 2px;
  overflow: hidden;
}
.big {
  font-size: var(--font-md);
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lbl {
  font-size: 9px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.grid {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-2xs);
  table-layout: fixed;
}
.grid tr.head td, .grid tr.head th {
  font-size: 9px;
  color: var(--text-secondary);
  text-transform: uppercase;
  border-top: 1px solid var(--border-muted);
  padding-top: 4px;
}
.grid th {
  text-align: left;
  font-weight: 500;
  color: var(--text-primary);
  padding: 3px 4px 3px 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.grid td {
  text-align: right;
  padding: 3px 4px;
  font-variant-numeric: tabular-nums;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grid td.dim { color: var(--text-secondary); }
.grid-accounts tr.unknown th { color: var(--text-muted); font-style: italic; }
.grid-accounts td.quota { width: 5ch; }
</style>
