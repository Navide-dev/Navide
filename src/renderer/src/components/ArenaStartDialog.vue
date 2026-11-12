<script setup lang="ts">
// Model arena (experimental): the "start a comparison" dialog. Collects the
// task, the lineup and the limits; App.vue does the starting (arena.start,
// then one pane per candidate) and hands back `busy` / `error`.
import { computed, ref, watch } from 'vue'
import type { AgentSpec } from '@navide/plugin-shell'
import { supportsModel } from '@navide/plugin-shell'
import { useDialogFocus } from '../composables/useDialogFocus'
import {
  ARENA_DEFAULT_BUDGET_USD,
  ARENA_DEFAULT_TIME_LIMIT_MIN,
  ARENA_MAX_CANDIDATES,
  ARENA_MIN_CANDIDATES,
  ARENA_MODEL_SUGGESTIONS,
  defaultArenaLineup,
  type ArenaCandidateInput,
} from '../lib/arena'

export interface ArenaStartRequest {
  workspace: string
  task: string
  base: string
  checkCommand: string
  timeLimitMin: number
  budgetUsd: number
  candidates: ArenaCandidateInput[]
}

export interface ArenaPrefill {
  task?: string
  agent?: string
  model?: string
}

const props = defineProps<{
  open: boolean
  workspace: string
  agentSpecs: readonly AgentSpec[]
  prefill?: ArenaPrefill | null
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{ start: [req: ArenaStartRequest]; cancel: [] }>()

const specs = computed(() => props.agentSpecs.filter((s) => s.agentKey !== 'terminal' && supportsModel(s)))

const task = ref('')
const base = ref('')
const checkCommand = ref('')
const timeLimitMin = ref(ARENA_DEFAULT_TIME_LIMIT_MIN)
const budgetUsd = ref(ARENA_DEFAULT_BUDGET_USD)
const lineup = ref<ArenaCandidateInput[]>([])

function reset(): void {
  task.value = props.prefill?.task ?? ''
  base.value = ''
  checkCommand.value = ''
  timeLimitMin.value = ARENA_DEFAULT_TIME_LIMIT_MIN
  budgetUsd.value = ARENA_DEFAULT_BUDGET_USD
  const rows = defaultArenaLineup(specs.value.map((s) => s.agentKey))
  const seed = props.prefill?.agent
  if (seed && rows.length) rows[0] = { agent: seed, model: props.prefill?.model ?? '' }
  lineup.value = rows
}

watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })

const root = ref<HTMLElement | null>(null)
const taskBox = ref<HTMLTextAreaElement | null>(null)
useDialogFocus(root, () => taskBox.value)

function addRow(): void {
  if (lineup.value.length >= ARENA_MAX_CANDIDATES) return
  const first = specs.value[0]?.agentKey ?? 'claude'
  lineup.value.push({ agent: first, model: '' })
}
function removeRow(i: number): void {
  if (lineup.value.length <= ARENA_MIN_CANDIDATES) return
  lineup.value.splice(i, 1)
}

const labelOf = (key: string): string => specs.value.find((s) => s.agentKey === key)?.label ?? key
const suggestions = (agent: string): readonly string[] => ARENA_MODEL_SUGGESTIONS[agent] ?? []

const canStart = computed(() =>
  !props.busy &&
  !!props.workspace &&
  task.value.trim().length > 0 &&
  lineup.value.length >= ARENA_MIN_CANDIDATES &&
  lineup.value.every((r) => !!r.agent)
)

function submit(): void {
  if (!canStart.value) return
  emit('start', {
    workspace: props.workspace,
    task: task.value.trim(),
    base: base.value.trim(),
    checkCommand: checkCommand.value.trim(),
    timeLimitMin: Number(timeLimitMin.value) || 0,
    budgetUsd: Number(budgetUsd.value) || 0,
    candidates: lineup.value.map((r) => ({ agent: r.agent, model: r.model.trim() })),
  })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="arena-start nv-modal-overlay" @click.self="emit('cancel')" @keydown.esc="emit('cancel')">
      <section
        ref="root"
        class="arena-start-card nv-modal-shell"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('arena.start.title')"
        data-testid="arena-start-dialog"
      >
        <header class="hdr">
          <h2>{{ $t('arena.start.title') }} <span class="exp">{{ $t('arena.experimental') }}</span></h2>
          <button class="x" :aria-label="$t('action.close')" @click="emit('cancel')">✕</button>
        </header>
        <p class="sub">{{ $t('arena.start.subtitle') }}</p>

        <label class="field">
          <span class="lb">{{ $t('arena.start.task') }}</span>
          <textarea ref="taskBox" v-model="task" rows="4" :placeholder="$t('arena.start.task-placeholder')" data-testid="arena-task"></textarea>
        </label>

        <div class="two">
          <label class="field">
            <span class="lb">{{ $t('arena.start.base') }}</span>
            <input v-model="base" type="text" spellcheck="false" placeholder="HEAD" />
          </label>
          <label class="field">
            <span class="lb">{{ $t('arena.start.check') }}</span>
            <input v-model="checkCommand" type="text" spellcheck="false" :placeholder="$t('arena.start.check-placeholder')" />
          </label>
        </div>

        <div class="field">
          <span class="lb">{{ $t('arena.start.models', { min: ARENA_MIN_CANDIDATES, max: ARENA_MAX_CANDIDATES }) }}</span>
          <div v-for="(row, i) in lineup" :key="i" class="cand" data-testid="arena-candidate-row">
            <span class="cid">{{ 'ABCD'[i] }}</span>
            <select v-model="row.agent" :aria-label="$t('arena.start.cli')">
              <option v-for="s in specs" :key="s.agentKey" :value="s.agentKey">{{ s.label }}</option>
            </select>
            <input
              v-model="row.model"
              type="text"
              spellcheck="false"
              :list="`arena-models-${i}`"
              :placeholder="$t('arena.start.model-default', { cli: labelOf(row.agent) })"
              :aria-label="$t('spawn.model.label')"
            />
            <datalist :id="`arena-models-${i}`">
              <option v-for="m in suggestions(row.agent)" :key="m" :value="m" />
            </datalist>
            <button class="ghost" :disabled="lineup.length <= ARENA_MIN_CANDIDATES" :aria-label="$t('arena.start.remove')" @click="removeRow(i)">−</button>
          </div>
          <button v-if="lineup.length < ARENA_MAX_CANDIDATES" class="ghost add" @click="addRow">＋ {{ $t('arena.start.add') }}</button>
        </div>

        <div class="two">
          <label class="field">
            <span class="lb">{{ $t('arena.start.time-limit') }}</span>
            <input v-model.number="timeLimitMin" type="number" min="0" step="5" />
          </label>
          <label class="field">
            <span class="lb">{{ $t('arena.start.budget') }}</span>
            <input v-model.number="budgetUsd" type="number" min="0" step="0.5" />
          </label>
        </div>

        <div class="estimate" data-testid="arena-estimate">
          <div>{{ $t('arena.start.estimate', { panes: lineup.length }) }}</div>
          <div class="muted">{{ $t('arena.start.estimate-branches') }}</div>
          <div class="muted">{{ $t('arena.start.estimate-budget', { total: (lineup.length * (Number(budgetUsd) || 0)).toFixed(2) }) }}</div>
        </div>

        <p v-if="error" class="err" role="alert">{{ error }}</p>

        <footer class="actions">
          <button class="ghost" @click="emit('cancel')">{{ $t('action.cancel') }}</button>
          <button class="primary" :disabled="!canStart" data-testid="arena-start" @click="submit">
            {{ busy ? $t('arena.start.starting') : $t('arena.start.go') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.arena-start {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 120);
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
}
.arena-start-card {
  width: min(640px, 94vw);
  max-height: 90vh;
  overflow: auto;
  padding: 18px 20px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-base);
  box-shadow: var(--shadow-modal);
  color: var(--text-primary);
}
.hdr { display: flex; align-items: center; justify-content: space-between; }
h2 { margin: 0; font-size: 16px; }
.exp { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--text-secondary); }
.sub { margin: 4px 0 14px; color: var(--text-secondary); font-size: 12px; }
.x { border: 0; background: none; color: var(--text-secondary); cursor: pointer; font-size: 14px; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; min-width: 0; }
.lb { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
textarea, input, select {
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
}
textarea { resize: vertical; }
.cand { display: grid; grid-template-columns: 18px 160px 1fr 28px; gap: 6px; align-items: center; margin-bottom: 6px; }
.cid { font-weight: 700; font-size: 12px; color: var(--text-secondary); text-align: center; }
button {
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-primary);
  cursor: pointer;
}
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--accent-emphasis, var(--accent-focus)); border-color: transparent; color: var(--text-on-emphasis); }
.add { align-self: flex-start; }
.estimate {
  padding: 8px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  font-size: 12px;
  margin-bottom: 12px;
}
.muted { color: var(--text-secondary); }
.err { color: var(--danger-fg, #cf222e); font-size: 12px; margin: 0 0 10px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 560px) {
  .two { grid-template-columns: 1fr; }
  .cand { grid-template-columns: 18px 1fr 28px; }
  .cand input { grid-column: 2 / 4; }
}
</style>
