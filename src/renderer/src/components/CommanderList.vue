<script setup lang="ts">
// The sidebar's Commanders tab (0.2.51): every commander with its dispatched
// panes and their detected states, plus the panes no commander owns. Clicking a
// commander opens its detail modal; clicking a pane focuses it.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { dispatchedNodes, useCommanders } from '../composables/useCommanders'
import type { CommanderState, CommanderSummary, CommanderTreeNode } from '../lib/commander'
import { commanderStateClass } from '../lib/commanderView'

export interface CommanderListPane {
  id: string
  name: string
}

const props = defineProps<{
  /** The window's panes, for the "unassigned" list. */
  panes: CommanderListPane[]
  /** agent_key → the CLI's display name. */
  agentLabel: (agentKey: string) => string
}>()

const emit = defineEmits<{ (e: 'focus-pane', paneId: string): void }>()

const { t } = useI18n()
const store = useCommanders()

/** Folded commanders; unfolded by default so the dispatch tree shows. */
const folded = ref(new Set<string>())
function toggleFold(id: string): void {
  const next = new Set(folded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  folded.value = next
}

interface Row { node: CommanderTreeNode; depth: number }

function rowsOf(c: CommanderSummary): Row[] {
  const out: Row[] = []
  const walk = (nodes: CommanderTreeNode[], depth: number): void => {
    for (const node of nodes) {
      if (node.closed_at) continue
      out.push({ node, depth })
      walk(node.children, depth + 1)
    }
  }
  const tree = store.trees.value[c.id]
  if (tree) walk(tree.root.children, 0)
  return out
}

function workingCount(c: CommanderSummary): number {
  return dispatchedNodes(store.trees.value[c.id]).filter((n) => !n.closed_at && n.state !== 'gone').length
}

function subLine(c: CommanderSummary): string {
  const agent = props.agentLabel(c.agent_key)
  const count = workingCount(c)
  if (count > 0) return t('commander.list.sub-working', { agent, count })
  return c.body_live ? t('commander.list.sub-standby', { agent }) : t('commander.list.sub-no-body', { agent })
}

/** The commander's own light: the most urgent state among its dispatches. */
const URGENCY: CommanderState[] = ['stalled', 'waiting', 'working', 'idle', 'reported']
function commanderDot(c: CommanderSummary): string {
  const counts = c.dispatch_counts ?? {}
  const live = dispatchedNodes(store.trees.value[c.id]).filter((n) => !n.closed_at)
  for (const s of URGENCY) if (live.some((n) => n.state === s) || (counts[s] ?? 0) > 0) return commanderStateClass(s)
  return c.body_live ? 'is-idle' : 'is-gone'
}

const unassigned = computed(() => {
  const owned = new Set<string>([...store.paneMarks.value.keys(), ...store.bodyPanes.value.keys()])
  return props.panes.filter((p) => !owned.has(p.id))
})
</script>

<template>
  <div class="cmd-list" data-testid="commander-list">
    <div class="cmd-list-head">
      <span class="cmd-list-title">{{ t('commander.list.title') }}</span>
      <button class="cmd-new" data-testid="commander-new" @click="store.openCreate()">{{ t('commander.list.new') }}</button>
    </div>
    <div v-if="store.listError.value" class="cmd-error">{{ t('commander.list.error', { error: store.listError.value }) }}</div>
    <div v-else-if="store.loaded.value && !store.commanders.value.length" class="cmd-empty">{{ t('commander.list.empty') }}</div>
    <ul class="cmd-items">
      <li
        v-for="c in store.commanders.value"
        :key="c.id"
        class="cmd-item"
        :class="{ active: store.detailId.value === c.id }"
        data-testid="commander-item"
      >
        <div class="cmd-row" role="button" :title="c.duty" @click="store.openDetail(c.id)">
          <span class="cmd-icon" :style="{ background: c.color || 'var(--accent-emphasis)' }" aria-hidden="true">{{ c.icon || '◎' }}</span>
          <span class="cmd-text">
            <span class="cmd-name" v-truncate>{{ c.name }}</span>
            <span class="cmd-sub" v-truncate>{{ subLine(c) }}</span>
          </span>
          <button
            v-if="rowsOf(c).length"
            class="cmd-fold"
            :title="folded.has(c.id) ? t('commander.list.expand') : t('commander.list.collapse')"
            :aria-expanded="!folded.has(c.id)"
            @click.stop="toggleFold(c.id)"
          >{{ folded.has(c.id) ? '▸' : '▾' }}</button>
          <span class="cmd-dot" :class="commanderDot(c)" aria-hidden="true"></span>
        </div>
        <ul v-if="!folded.has(c.id)" class="cmd-children">
          <li
            v-for="{ node, depth } in rowsOf(c)"
            :key="node.pane_id"
            class="cmd-child"
            :style="depth ? { paddingLeft: 28 + depth * 13 + 'px' } : undefined"
            role="button"
            data-testid="commander-child"
            :title="node.task"
            @click="emit('focus-pane', node.pane_id)"
          >
            <span class="cmd-dot" :class="commanderStateClass(node.state)" aria-hidden="true"></span>
            <span class="cmd-child-name" v-truncate>{{ node.name || node.pane_id }}</span>
            <span class="cmd-state-chip" :class="commanderStateClass(node.state)">{{ t(`commander.state.${node.state}`) }}</span>
          </li>
        </ul>
      </li>
    </ul>
    <template v-if="unassigned.length">
      <div class="cmd-section">{{ t('commander.list.unassigned') }}</div>
      <ul class="cmd-items">
        <li
          v-for="p in unassigned"
          :key="p.id"
          class="cmd-child cmd-unassigned"
          role="button"
          data-testid="commander-unassigned"
          @click="emit('focus-pane', p.id)"
        >
          <span class="cmd-dot is-gone" aria-hidden="true"></span>
          <span class="cmd-child-name" v-truncate>{{ p.name }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.cmd-list { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; overflow-y: auto; min-height: 0; flex: 1; }
.cmd-list-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 6px; }
.cmd-list-title { font-size: var(--font-xs); color: var(--text-secondary); }
.cmd-new { background: none; border: none; color: var(--accent-fg); font-size: var(--font-xs); cursor: pointer; padding: 2px 4px; }
.cmd-new:hover { text-decoration: underline; }
.cmd-error { color: var(--danger-fg); font-size: var(--font-xs); padding: 4px; }
.cmd-empty { color: var(--text-muted); font-size: var(--font-xs); padding: 4px; line-height: var(--lh-base); }
.cmd-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.cmd-row { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: var(--radius-md); cursor: pointer; }
.cmd-row:hover, .cmd-item.active .cmd-row { background: var(--bg-muted); }
.cmd-icon { width: 30px; height: 30px; border-radius: var(--radius-md); display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--text-on-emphasis); font-size: var(--font-md); }
.cmd-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.cmd-name { color: var(--text-bright); font-size: var(--font-sm); font-weight: 600; }
.cmd-sub { color: var(--text-muted); font-size: var(--font-2xs); }
.cmd-fold { background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 0 2px; font-size: var(--font-2xs); }
.cmd-children { list-style: none; margin: 0 0 4px; padding: 0; }
.cmd-child { display: flex; align-items: center; gap: 8px; padding: 4px 8px 4px 28px; border-radius: var(--radius-sm); cursor: pointer; font-size: var(--font-xs); color: var(--text-primary); min-width: 0; }
.cmd-child:hover { background: var(--bg-muted); }
.cmd-unassigned { padding-left: 8px; }
.cmd-child-name { flex: 1; min-width: 0; }
.cmd-section { font-size: var(--font-2xs); color: var(--text-muted); padding: 10px 4px 4px; }
</style>

<style>
/* Shared by the list, the detail modal, the sidebar rows and the pane header chips. */
.cmd-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); }
.cmd-state-chip { flex-shrink: 0; font-size: var(--font-2xs); padding: 0 6px; border-radius: 999px; border: 1px solid currentColor; line-height: 16px; white-space: nowrap; }
.cmd-dot.is-working, .cmd-state-chip.is-working { color: var(--success-fg); }
.cmd-dot.is-working { background: var(--success-fg); }
.cmd-state-chip.is-working { background: var(--success-subtle); }
.cmd-dot.is-waiting { background: var(--attention-fg); }
.cmd-state-chip.is-waiting { color: var(--attention-fg); background: var(--attention-subtle); }
.cmd-dot.is-reported { background: var(--done-fg); }
.cmd-state-chip.is-reported { color: var(--done-fg); background: color-mix(in srgb, var(--done-fg) 14%, transparent); }
.cmd-dot.is-idle { background: var(--accent-fg); }
.cmd-state-chip.is-idle { color: var(--accent-fg); background: var(--accent-subtle); }
.cmd-dot.is-stalled { background: var(--danger-fg); }
.cmd-state-chip.is-stalled { color: var(--danger-fg); background: var(--danger-subtle); }
.cmd-dot.is-gone { background: var(--text-muted); }
.cmd-state-chip.is-gone { color: var(--text-muted); background: transparent; }
</style>
