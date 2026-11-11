<script setup lang="ts">
// Model arena (experimental): the run view. App.vue polls arena.status and
// hands the latest answer in; this component only draws it and asks.
import { computed, ref } from 'vue'
import { useDialogFocus } from '../composables/useDialogFocus'
import { formatElapsed, type ArenaRun, type ArenaStatus } from '../lib/arena'

const props = defineProps<{
  open: boolean
  runs: readonly ArenaRun[]
  runId: string
  status: ArenaStatus | null
  paneAlive: (paneId: string) => boolean
}>()
const emit = defineEmits<{
  close: []
  'select-run': [runId: string]
  'focus-pane': [paneId: string]
  stop: [runId: string, candidate: string]
  'stop-all': [runId: string]
}>()

const run = computed<ArenaRun | null>(() =>
  props.status?.run.id === props.runId ? props.status.run : (props.runs.find((r) => r.id === props.runId) ?? null)
)
const rows = computed(() => {
  const r = run.value
  if (!r) return []
  return r.candidates.map((cand) => ({
    cand,
    stat: props.status?.run.id === r.id ? props.status.candidates.find((s) => s.id === cand.id) : undefined,
    alive: !!cand.pane_id && props.paneAlive(cand.pane_id),
  }))
})

function stateLabel(row: (typeof rows.value)[number]): string {
  if (row.cand.stopped) return `arena.state.stopped-${row.cand.stopped}`
  if (!row.cand.pane_id) return 'arena.state.no-pane'
  return row.alive ? 'arena.state.running' : 'arena.state.pane-closed'
}

function budgetPct(usd: number): number {
  const budget = run.value?.budget_usd ?? 0
  return budget > 0 ? Math.min(100, Math.round((usd / budget) * 100)) : 0
}

const root = ref<HTMLElement | null>(null)
useDialogFocus(root)
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="arena-panel nv-modal-overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
      <section ref="root" class="arena-card nv-modal-shell" role="dialog" aria-modal="true" :aria-label="$t('arena.panel.title')" data-testid="arena-panel">
        <header class="hdr">
          <h2>{{ $t('arena.panel.title') }} <span class="exp">{{ $t('arena.experimental') }}</span></h2>
          <select v-if="runs.length > 1" :value="runId" :aria-label="$t('arena.panel.run')" @change="emit('select-run', ($event.target as HTMLSelectElement).value)">
            <option v-for="r in runs" :key="r.id" :value="r.id">{{ r.id }} · {{ r.task.slice(0, 40) }}</option>
          </select>
          <button class="x" :aria-label="$t('action.close')" @click="emit('close')">✕</button>
        </header>

        <template v-if="run">
          <div class="bar" data-testid="arena-run-bar">
            <div class="task" :title="run.task">{{ run.task }}</div>
            <div class="meta">
              <span>{{ $t('arena.panel.base', { branch: run.base_branch || 'HEAD', sha: run.base_sha.slice(0, 7) }) }}</span>
              <span>{{ $t('arena.panel.elapsed', { t: formatElapsed(status?.elapsed_s ?? 0) }) }}</span>
              <span>{{ $t('arena.panel.limits', { min: run.time_limit_min, usd: run.budget_usd }) }}</span>
              <span class="state">{{ $t(`arena.run-state.${run.state}`) }}</span>
            </div>
            <p v-if="run.dirty_base" class="warn">{{ $t('arena.panel.dirty-base') }}</p>
          </div>

          <table class="grid">
            <thead>
              <tr>
                <th></th>
                <th>{{ $t('arena.col.model') }}</th>
                <th>{{ $t('arena.col.state') }}</th>
                <th>{{ $t('arena.col.changes') }}</th>
                <th>{{ $t('arena.col.tokens') }}</th>
                <th>{{ $t('arena.col.cost') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.cand.id" data-testid="arena-row">
                <td class="cid">{{ row.cand.id }}</td>
                <td>
                  <div class="model">{{ row.cand.model || $t('arena.col.default-model', { cli: row.cand.agent }) }}</div>
                  <div class="muted mono">{{ row.cand.branch }}</div>
                </td>
                <td :class="{ stopped: !!row.cand.stopped }">{{ $t(stateLabel(row)) }}</td>
                <td>
                  <template v-if="row.stat">
                    {{ $t('arena.col.files', { n: row.stat.files }) }}
                    <span class="add">+{{ row.stat.added }}</span>
                    <span class="del">−{{ row.stat.deleted }}</span>
                    <div v-if="row.stat.protected.length" class="prot" :title="row.stat.protected.join('\n')">
                      {{ $t('arena.col.protected', { n: row.stat.protected.length }) }}
                    </div>
                  </template>
                  <span v-else class="muted">…</span>
                </td>
                <td>{{ row.stat ? row.stat.spend.tokens.toLocaleString() : '…' }}</td>
                <td>
                  <template v-if="row.stat?.spend.available">
                    US${{ row.stat.spend.usd.toFixed(2) }}
                    <div class="meter" :class="{ hot: budgetPct(row.stat.spend.usd) >= 80 }">
                      <i :style="{ width: `${budgetPct(row.stat.spend.usd)}%` }"></i>
                    </div>
                  </template>
                  <span v-else class="muted">{{ $t('arena.col.cost-unavailable') }}</span>
                </td>
                <td class="acts">
                  <button v-if="row.alive" class="ghost" @click="emit('focus-pane', row.cand.pane_id)">{{ $t('arena.action.show') }}</button>
                  <button v-if="row.alive && !row.cand.stopped" class="ghost" @click="emit('stop', run.id, row.cand.id)">{{ $t('arena.action.stop') }}</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p class="muted note">{{ $t('arena.panel.check-note', { cmd: run.check_command || '—' }) }}</p>

          <footer class="actions">
            <button v-if="run.state === 'running'" class="ghost" @click="emit('stop-all', run.id)">{{ $t('arena.action.stop-all') }}</button>
          </footer>
        </template>
        <p v-else class="muted">{{ $t('arena.panel.empty') }}</p>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.arena-panel {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 110);
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--modal-backdrop);
}
.arena-card {
  width: min(1100px, 96vw);
  max-height: 92vh;
  overflow: auto;
  padding: 16px 20px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-base);
  box-shadow: var(--shadow-modal);
  color: var(--text-primary);
  font-size: 13px;
}
.hdr { display: flex; align-items: center; gap: 10px; }
.hdr h2 { margin: 0; font-size: 16px; flex: 1; }
.exp { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--text-secondary); }
.x { border: 0; background: none; color: var(--text-secondary); cursor: pointer; font-size: 14px; }
.bar { margin: 12px 0; padding: 10px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-subtle); }
.task { font-weight: 600; white-space: pre-wrap; max-height: 4.5em; overflow: hidden; }
.meta { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; color: var(--text-secondary); font-size: 12px; }
.warn { margin: 6px 0 0; color: var(--attention-fg); font-size: 12px; }
.grid { width: 100%; border-collapse: collapse; }
.grid th { text-align: left; font-size: 11px; font-weight: 600; color: var(--text-secondary); padding: 4px 8px; border-bottom: 1px solid var(--border-default); }
.grid td { padding: 8px; border-bottom: 1px solid var(--border-muted, var(--border-default)); vertical-align: top; }
.cid { font-weight: 700; width: 20px; }
.model { font-weight: 600; }
.mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
.muted { color: var(--text-secondary); }
.add { color: var(--success-fg); margin-left: 6px; }
.del { color: var(--danger-fg); margin-left: 4px; }
.prot { color: var(--danger-fg); font-size: 11px; margin-top: 2px; }
.stopped { color: var(--attention-fg); }
.meter { height: 4px; margin-top: 4px; border-radius: 2px; background: var(--bg-muted, var(--border-default)); overflow: hidden; width: 90px; }
.meter i { display: block; height: 100%; background: var(--accent-fg); }
.meter.hot i { background: var(--attention-fg); }
.acts { white-space: nowrap; text-align: right; }
.note { font-size: 12px; margin: 10px 0 0; }
button {
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-primary);
  cursor: pointer;
}
.acts button + button { margin-left: 6px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
select { padding: 4px 6px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-subtle); color: var(--text-primary); }
</style>
