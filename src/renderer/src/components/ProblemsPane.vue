<script setup lang="ts">
import { computed } from 'vue'
import { allDiagnosticsSorted, diagnosticsKey } from '../editor/diagnostics'
import type { Diagnostic } from '../editor/diagnostics'
import { vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{
  // The window's workspace — diagnostics from another root are labelled with
  // their absolute path so two same-named files stay distinguishable.
  workspacePath?: string
}>()

const emit = defineEmits<{
  (e: 'open-file', payload: { filepath: string; line: number; wsPath?: string }): void
  (e: 'fix-with-ai', payload: { diag: Diagnostic }): void
}>()

const all = computed(() => allDiagnosticsSorted())

const errorCount = computed(() => all.value.filter(d => d.severity === 'error').length)
const warnCount  = computed(() => all.value.filter(d => d.severity === 'warning').length)

// Group by (workspace, relPath), preserving sorted order
interface Group { key: string; label: string; items: Diagnostic[] }
const groups = computed((): Group[] => {
  const map = new Map<string, Group>()
  for (const d of all.value) {
    const key = diagnosticsKey(d.wsPath, d.relPath)
    const g = map.get(key) ?? { key, label: fileLabel(d), items: [] }
    g.items.push(d)
    map.set(key, g)
  }
  return Array.from(map.values())
})

function fileLabel(d: Diagnostic): string {
  if (!d.wsPath || d.wsPath === (props.workspacePath ?? '')) return d.relPath
  return `${d.wsPath.replace(/\/+$/, '')}/${d.relPath}`
}

function sevIcon(sev: Diagnostic['severity']): string {
  return sev === 'error' ? '●' : sev === 'warning' ? '▲' : '●'
}
function sevClass(sev: Diagnostic['severity']): string {
  return `sev-${sev}`
}

function openItem(d: Diagnostic): void {
  emit('open-file', { filepath: d.relPath, line: d.line, wsPath: d.wsPath })
}
</script>

<template>
  <div class="problems-pane">
    <div class="problems-header">
      <span class="problems-title">{{ $t('pane.problems.title') }}</span>
      <span v-if="errorCount" class="badge badge-err">{{ errorCount }} error{{ errorCount !== 1 ? 's' : '' }}</span>
      <span v-if="warnCount" class="badge badge-warn">{{ warnCount }} warning{{ warnCount !== 1 ? 's' : '' }}</span>
    </div>
    <div v-if="!all.length" class="problems-empty">{{ $t('label.no-problems-detected') }}</div>
    <div v-else class="problems-list">
      <div v-for="g in groups" :key="g.key" class="prob-group">
        <div class="prob-file" v-truncate>{{ g.label }}</div>
        <div
          v-for="(d, i) in g.items"
          :key="i"
          class="prob-item"
          :class="sevClass(d.severity)"
          @click="openItem(d)"
        >
          <span class="prob-icon" :class="sevClass(d.severity)">{{ sevIcon(d.severity) }}</span>
          <span class="prob-msg" v-truncate>{{ d.message }}</span>
          <span class="prob-loc">{{ d.line }}{{ d.col ? ':' + d.col : '' }}</span>
          <span v-if="d.source" class="prob-src">{{ d.source }}</span>
          <button
            class="prob-fix-btn"
            :title="$t('action.fix-with-ai')"
            @click.stop="emit('fix-with-ai', { diag: d })"
          >{{ $t('action.fix') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.problems-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-size: var(--font-xs);
  color: var(--text-primary);
}
.problems-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-muted);
  flex-shrink: 0;
}
.problems-title {
  font-weight: 600;
  font-size: var(--font-2xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.badge {
  font-size: var(--font-3xs);
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 600;
}
.badge-err  { background: color-mix(in srgb, var(--danger-fg) 20%, transparent); color: var(--danger-fg); }
.badge-warn { background: color-mix(in srgb, var(--attention-fg) 20%, transparent); color: var(--attention-fg); }

.problems-empty {
  padding: 24px 16px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  text-align: center;
}
.problems-list {
  flex: 1;
  overflow-y: auto;
}
.prob-group { margin-bottom: 2px; }
.prob-file {
  padding: 6px 12px 2px;
  font-size: var(--font-2xs);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.prob-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 12px 3px 20px;
  cursor: pointer;
  border-radius: 3px;
  margin: 0 4px;
}
.prob-item:hover { background: var(--bg-muted); }
.prob-icon { font-size: 9px; flex-shrink: 0; }
.prob-icon.sev-error   { color: var(--danger-fg); }
.prob-icon.sev-warning { color: var(--attention-fg); }
.prob-icon.sev-info    { color: var(--accent-fg); }
.prob-msg {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11.5px;
}
.prob-loc {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 10.5px;
}
.prob-src {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: var(--font-3xs);
  font-style: italic;
}
.prob-fix-btn {
  flex-shrink: 0;
  display: none;
  font-size: var(--font-3xs);
  padding: 1px 6px;
  border: 1px solid var(--border-muted);
  border-radius: 3px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  line-height: 1.4;
}
.prob-fix-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.prob-item:hover .prob-fix-btn { display: inline-block; }
</style>
