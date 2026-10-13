<script setup lang="ts">
// One pipeline node, drawn the same way in the swimlane and on the canvas —
// the shared shape is what lets a card glide from its column to its canvas
// position when the view switches, instead of the user re-finding it.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { GraphNode, NodeRunState } from '../../lib/pipelineGraph'
import type { LaneBadge } from '../../lib/pipelineGraphEdits'
import { elapsedOf, formatElapsed, formatTokens, nodeTitle } from './pipelineEditorModel'
import { vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{
  node: GraphNode
  /** Display name of the slot's role; '' when unassigned or not a slot. */
  roleLabel?: string
  agentLabel?: string
  run?: NodeRunState
  /** Clock for the running timer (ms since epoch); the parent ticks it. */
  now?: number
  selected?: boolean
  badges?: LaneBadge[]
}>()
const emit = defineEmits<{ (e: 'badge', badge: LaneBadge): void }>()
const { t } = useI18n()

const title = computed(() => nodeTitle(props.node))
const status = computed(() => props.run?.status ?? (props.node.pinned ? 'pinned' : 'idle'))
const elapsed = computed(() => formatElapsed(elapsedOf(props.run, props.now ?? Date.now())))
const tokens = computed(() => formatTokens(props.run?.tokens))
const subtitle = computed(() => {
  const n = props.node
  if (n.kind === 'trigger') return t('pipelineEditor.node.trigger-sub')
  if (n.kind === 'gate') return n.gate?.prompt || t('pipelineEditor.node.gate-sub')
  return props.roleLabel || t('label.unassigned')
})
/** The glyph is the role's initial — the same tile the palette shows, so a
 *  dragged role is recognisable once it lands. The CLI gets its own tag. */
const glyph = computed(() => (props.roleLabel || nodeTitle(props.node)).trim().charAt(0).toUpperCase() || '?')
const agentTag = computed(() => (props.node.kind === 'slot' ? props.node.slot?.agentKey ?? '' : ''))
const statusText = computed(() => {
  const s = status.value
  if (s === 'idle') return ''
  return t(`pipelineEditor.status.${s}`)
})
const aria = computed(() =>
  [title.value, subtitle.value, props.agentLabel, statusText.value, elapsed.value].filter(Boolean).join(', ')
)

function badgeText(b: LaneBadge): string {
  if (b.kind === 'reject') return t('pipelineEditor.badge.reject', { layer: b.targetLayer ?? '?', max: b.maxLoops ?? 2 })
  return t('pipelineEditor.badge.skip', { layer: b.targetLayer ?? '?' })
}
</script>

<template>
  <div
    class="pnc"
    :class="[`pnc--${node.kind}`, `is-${status}`, { 'is-selected': selected, 'is-pinned': node.pinned }]"
    :aria-label="aria"
  >
    <span class="pnc-rail" aria-hidden="true"></span>
    <span class="pnc-glyph" aria-hidden="true">
      <svg v-if="node.kind === 'trigger'" viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5z" /></svg>
      <svg v-else-if="node.kind === 'gate'" viewBox="0 0 16 16"><path d="M8 1.8 14.2 8 8 14.2 1.8 8z" /></svg>
      <template v-else>{{ glyph }}</template>
    </span>
    <span class="pnc-body">
      <span class="pnc-title">
        <span class="pnc-title-text" v-truncate>{{ title }}</span>
        <svg v-if="node.slot?.isCommander" class="pnc-mark" viewBox="0 0 16 16" :aria-label="t('pipelineEditor.node.commander')">
          <title>{{ t('pipelineEditor.node.commander') }}</title>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" />
          <circle cx="8" cy="8" r="2" />
        </svg>
        <svg v-if="node.pinned" class="pnc-mark pnc-mark--pin" viewBox="0 0 16 16" :aria-label="t('pipelineEditor.node.pinned')">
          <title>{{ t('pipelineEditor.node.pinned') }}</title>
          <path d="M6 1.5h4l-.6 4.2L12 8.5H8.7V14L8 15l-.7-1V8.5H4l2.6-2.8z" />
        </svg>
      </span>
      <!-- Title > role > CLI: when space runs out the role yields first, the
           title never does. -->
      <span class="pnc-meta">
        <span class="pnc-sub" v-truncate>{{ subtitle }}</span>
        <span v-if="agentTag" class="pnc-agent" :title="agentLabel">{{ agentTag }}</span>
      </span>
    </span>
    <span v-if="statusText" class="pnc-status">
      <span class="pnc-dot" aria-hidden="true"></span>
      <span>{{ statusText }}</span>
      <span class="pnc-nums">
        <span v-if="elapsed">{{ elapsed }}</span>
        <span v-if="tokens">{{ t('pipelineEditor.node.tokens', { n: tokens }) }}</span>
      </span>
    </span>
    <span v-if="badges?.length" class="pnc-badges">
      <button
        v-for="b in badges" :key="b.kind + b.edgeId"
        type="button" class="pnc-badge" :class="`pnc-badge--${b.kind}`"
        :title="t('pipelineEditor.badge.open-canvas')"
        @click.stop="emit('badge', b)" @pointerdown.stop
      >{{ badgeText(b) }}</button>
    </span>
  </div>
</template>

<style scoped>
.pnc {
  --pnc-tone: transparent;
  position: relative;
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr);
  grid-template-areas: 'glyph body' 'status status' 'badges badges';
  column-gap: var(--space-3);
  align-items: center;
  width: var(--pnc-w, 232px);
  min-height: 76px;
  box-sizing: border-box;
  padding: var(--space-3) var(--space-3) var(--space-3) calc(var(--space-3) + 3px);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  color: var(--text-primary);
  font-family: var(--font-ui);
  text-align: left;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-base) var(--ease-out),
    transform var(--motion-base) var(--ease-out);
}
.pnc:hover { border-color: var(--border-strong); }
.pnc.is-selected {
  border-color: var(--accent-emphasis);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-emphasis) 22%, transparent), var(--shadow-popover);
}

/* Status rail: the left edge carries run state so a column of cards can be
   read top to bottom without parsing text. */
.pnc-rail {
  position: absolute;
  left: -1px;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 0 var(--radius-pill) var(--radius-pill) 0;
  background: var(--pnc-tone);
  transition: background var(--motion-base) var(--ease-out);
}
.pnc.is-running { --pnc-tone: var(--accent-emphasis); }
.pnc.is-done { --pnc-tone: var(--success-emphasis); }
.pnc.is-awaiting { --pnc-tone: var(--attention-emphasis); }
.pnc.is-failed, .pnc.is-rejected, .pnc.is-aborted { --pnc-tone: var(--danger-emphasis); }
.pnc.is-skipped, .pnc.is-pinned { --pnc-tone: var(--done-emphasis); }
.pnc.is-pending { --pnc-tone: var(--border-muted); }

.pnc-glyph {
  grid-area: glyph;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--radius-md);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-sm);
  font-weight: 600;
}
.pnc-glyph svg { width: 14px; height: 14px; fill: currentColor; }
.pnc--trigger .pnc-glyph { background: color-mix(in srgb, var(--success-emphasis) 16%, transparent); color: var(--success-fg); }
.pnc--gate .pnc-glyph { background: color-mix(in srgb, var(--attention-emphasis) 18%, transparent); color: var(--attention-fg); }

.pnc-body { grid-area: body; display: grid; gap: 2px; min-width: 0; }
.pnc-title {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-row-title);
  font-weight: 600;
  line-height: var(--lh-tight);
  min-width: 0;
}
.pnc-title-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pnc-mark { flex: none; width: 12px; height: 12px; fill: var(--manager-fg); color: var(--manager-fg); }
.pnc-mark--pin { fill: var(--done-fg); }
.pnc-meta { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.pnc-sub {
  flex: 0 1 auto;
  min-width: 0;
  font-size: var(--font-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pnc--trigger .pnc-sub,
.pnc--gate .pnc-sub {
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  line-height: var(--lh-tight);
}
.pnc-agent {
  flex: none;
  padding: 0 var(--space-1);
  border-radius: var(--radius-xs);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--font-3xs);
  line-height: 16px;
}

.pnc-status {
  grid-area: status;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-muted);
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.pnc-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--pnc-tone);
}
.pnc.is-running .pnc-dot,
.pnc.is-awaiting .pnc-dot { animation: pnc-pulse 1.6s var(--ease-in-out) infinite; }
.pnc-nums {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.pnc-badges { grid-area: badges; display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-2); }
.pnc-badge {
  max-width: 100%;
  text-align: left;
  overflow-wrap: anywhere;
  border: 1px solid color-mix(in srgb, var(--done-emphasis) 45%, transparent);
  background: color-mix(in srgb, var(--done-emphasis) 10%, transparent);
  color: var(--done-fg);
  border-radius: var(--radius-pill);
  padding: 1px var(--space-2);
  font: inherit;
  font-size: var(--font-2xs);
  line-height: var(--lh-base);
  cursor: pointer;
}
.pnc-badge:hover { background: color-mix(in srgb, var(--done-emphasis) 18%, transparent); }
.pnc-badge:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 1px; }
.pnc-badge--skip {
  border-color: var(--border-default);
  background: var(--bg-muted);
  color: var(--text-secondary);
}

@keyframes pnc-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--pnc-tone) 55%, transparent); }
  50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--pnc-tone) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .pnc, .pnc-rail { transition: none; }
  .pnc.is-running .pnc-dot, .pnc.is-awaiting .pnc-dot { animation: none; }
}
</style>
