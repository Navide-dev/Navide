<script setup lang="ts">
// Model arena (experimental): the run view. App.vue polls arena.status and
// hands the latest answer in; this component only draws it and asks.
import { computed, ref, watch } from 'vue'
import { useDialogFocus } from '../composables/useDialogFocus'
import {
  arenaDiffLines,
  defaultMixPicks,
  formatElapsed,
  type ArenaCompareFile,
  type ArenaRun,
  type ArenaStatus,
} from '../lib/arena'

/** sendQuiet: the answer's payload, or null when the request failed. */
type ArenaRequest = <T = Record<string, unknown>>(type: string, payload: Record<string, unknown>) => Promise<T | null>

const props = defineProps<{
  open: boolean
  runs: readonly ArenaRun[]
  runId: string
  status: ArenaStatus | null
  /** A live pane whose folder is this worktree (lib/arena ArenaPaneCheck). */
  paneAlive: (paneId: string, worktree: string) => boolean
  request: ArenaRequest
}>()
const emit = defineEmits<{
  close: []
  'select-run': [runId: string]
  'focus-pane': [paneId: string]
  stop: [runId: string, candidate: string]
  'stop-all': [runId: string]
  /** The run record changed here (rating, adopt): reload the list. */
  changed: []
  /** Close these candidate panes (before cleanup removes their folders). */
  'close-panes': [paneIds: string[]]
}>()

type Tab = 'run' | 'compare' | 'merge'
const tab = ref<Tab>('run')

const run = computed<ArenaRun | null>(() =>
  props.status?.run.id === props.runId ? props.status.run : (props.runs.find((r) => r.id === props.runId) ?? null)
)
const rows = computed(() => {
  const r = run.value
  if (!r) return []
  return r.candidates.map((cand) => ({
    cand,
    stat: props.status?.run.id === r.id ? props.status.candidates.find((s) => s.id === cand.id) : undefined,
    alive: !!cand.pane_id && props.paneAlive(cand.pane_id, cand.worktree),
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

// ── Compare ──────────────────────────────────────────────────────────────
const files = ref<ArenaCompareFile[]>([])
const filesError = ref('')
const pickedFile = ref('')
const diffs = ref<Record<string, { text: string; truncated: boolean } | null>>({})

async function loadCompare(): Promise<void> {
  const r = run.value
  if (!r) return
  filesError.value = ''
  const resp = await props.request<{ ok: boolean; files?: ArenaCompareFile[]; error?: string }>('arena.compare', { workspace_path: r.workspace, run_id: r.id })
  if (!resp?.ok) {
    filesError.value = resp?.error || 'arena.compare failed'
    return
  }
  files.value = resp.files ?? []
  if (!files.value.some((f) => f.path === pickedFile.value)) pickedFile.value = files.value[0]?.path ?? ''
  void loadDiffs()
}

async function loadDiffs(): Promise<void> {
  const r = run.value
  const path = pickedFile.value
  if (!r || !path) {
    diffs.value = {}
    return
  }
  const row = files.value.find((f) => f.path === path)
  const next: Record<string, { text: string; truncated: boolean } | null> = {}
  await Promise.all(r.candidates.map(async (cand) => {
    if (!row?.by[cand.id]) {
      next[cand.id] = null
      return
    }
    const resp = await props.request<{ ok: boolean; diff?: string; truncated?: boolean }>('arena.file_diff', {
      workspace_path: r.workspace, run_id: r.id, candidate: cand.id, path,
    })
    next[cand.id] = resp?.ok ? { text: resp.diff ?? '', truncated: !!resp.truncated } : { text: '', truncated: false }
  }))
  if (pickedFile.value === path) diffs.value = next
}

watch(pickedFile, () => { void loadDiffs() })
watch([tab, () => props.runId], ([t]) => {
  files.value = []
  diffs.value = {}
  if (t === 'compare') void loadCompare()
  if (t === 'merge') void loadMerge()
})

// ── Merge ────────────────────────────────────────────────────────────────
type MergeMode = 'whole' | 'mix' | 'branch'
interface MergePreview { branch: string; expected_branch: string; dirty: boolean; new_commits: string[] }
interface MergeResult { ok: boolean; error?: string; branch?: string; commit?: string; mode?: string; conflict_files?: string[] }

const mergeMode = ref<MergeMode>('whole')
const squash = ref(true)
const mergeCandidate = ref('')
const picks = ref<Record<string, string>>({})
const preview = ref<MergePreview | null>(null)
const checkConfirmed = ref(false)
const confirming = ref(false)
const merging = ref(false)
const mergeResult = ref<MergeResult | null>(null)
const cleanWorktrees = ref(true)
const cleanBranches = ref(true)
const cleanPanes = ref(true)
const cleaning = ref(false)
const cleanResult = ref<{ ok: boolean; removed?: string[]; errors?: string[]; error?: string } | null>(null)

async function loadMerge(): Promise<void> {
  const r = run.value
  if (!r) return
  mergeResult.value = null
  cleanResult.value = null
  confirming.value = false
  checkConfirmed.value = false
  mergeCandidate.value = r.candidates.find((c) => c.adopted)?.id ?? r.candidates[0]?.id ?? ''
  const [cmp, prev] = await Promise.all([
    props.request<{ ok: boolean; files?: ArenaCompareFile[] }>('arena.compare', { workspace_path: r.workspace, run_id: r.id }),
    props.request<MergePreview & { ok: boolean }>('arena.merge_preview', { workspace_path: r.workspace, run_id: r.id }),
  ])
  files.value = cmp?.ok ? (cmp.files ?? []) : []
  preview.value = prev?.ok ? prev : null
  picks.value = defaultMixPicks(files.value, r.candidates.map((c) => c.id), mergeCandidate.value)
}

const mergeBlocked = computed<string>(() => {
  const r = run.value
  if (!r || merging.value) return 'busy'
  if (r.state === 'merged') return 'arena.merge.already'
  if (mergeMode.value !== 'branch' && preview.value?.dirty) return 'arena.merge.dirty'
  if (mergeMode.value !== 'branch' && preview.value && r.base_branch && preview.value.branch !== r.base_branch) return 'arena.merge.wrong-branch'
  if (mergeMode.value === 'mix' && !Object.values(picks.value).some(Boolean)) return 'arena.merge.empty-mix'
  if (mergeMode.value !== 'branch' && r.check_command && !checkConfirmed.value) return 'arena.merge.confirm-check'
  return ''
})

async function doMerge(): Promise<void> {
  const r = run.value
  if (!r || mergeBlocked.value) return
  if (!confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  merging.value = true
  try {
    const resp = await props.request<MergeResult>('arena.merge', {
      workspace_path: r.workspace,
      run_id: r.id,
      candidate: mergeMode.value === 'mix' ? 'mix' : mergeCandidate.value,
      mode: mergeMode.value === 'branch' ? 'branch' : squash.value ? 'squash' : 'merge',
      ...(mergeMode.value === 'mix' ? { picks: picks.value } : {}),
    })
    mergeResult.value = resp ?? { ok: false, error: 'arena.merge failed' }
    emit('changed')
  } finally {
    merging.value = false
  }
}

async function doCleanup(): Promise<void> {
  const r = run.value
  if (!r) return
  cleaning.value = true
  try {
    if (cleanPanes.value) emit('close-panes', r.candidates.filter((c) => c.pane_id && props.paneAlive(c.pane_id, c.worktree)).map((c) => c.pane_id))
    const keep = r.merge?.mode === 'branch' && r.merge.ok ? r.merge.branch : ''
    const resp = await props.request<{ ok: boolean; removed?: string[]; errors?: string[]; error?: string }>('arena.cleanup', {
      workspace_path: r.workspace,
      run_id: r.id,
      worktrees: cleanWorktrees.value,
      branches: cleanBranches.value,
      keep_branch: keep,
    })
    cleanResult.value = resp ?? { ok: false, error: 'arena.cleanup failed' }
    emit('changed')
  } finally {
    cleaning.value = false
  }
}

/** One line for the record: what was compared and what was taken. */
const summaryLine = computed(() => {
  const r = run.value
  if (!r) return ''
  const lineup = r.candidates.map((c) => `${c.id}=${c.model || c.agent}${c.rating ? ` ${c.rating}★` : ''}`).join(', ')
  const taken = r.merge ? `${r.merge.mode} ${r.merge.candidate}${r.merge.commit ? ` @ ${r.merge.commit.slice(0, 9)}` : ''}` : '—'
  return `arena ${r.id} · ${r.base_branch || 'HEAD'}@${r.base_sha.slice(0, 7)} · ${lineup} · ${taken}`
})

async function updateCandidate(cid: string, fields: Record<string, unknown>): Promise<void> {
  const r = run.value
  if (!r) return
  await props.request('arena.update', { workspace_path: r.workspace, run_id: r.id, candidate: cid, ...fields })
  emit('changed')
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
          <nav class="tabs" role="tablist">
            <button role="tab" :aria-selected="tab === 'run'" :class="{ on: tab === 'run' }" @click="tab = 'run'">{{ $t('arena.tab.run') }}</button>
            <button role="tab" :aria-selected="tab === 'compare'" :class="{ on: tab === 'compare' }" data-testid="arena-tab-compare" @click="tab = 'compare'">{{ $t('arena.tab.compare') }}</button>
            <button role="tab" :aria-selected="tab === 'merge'" :class="{ on: tab === 'merge' }" data-testid="arena-tab-merge" @click="tab = 'merge'">{{ $t('arena.tab.merge') }}</button>
          </nav>
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

          <table v-if="tab === 'run'" class="grid">
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
          <section v-if="tab === 'compare'" class="compare" data-testid="arena-compare">
            <table class="grid summary">
              <thead>
                <tr>
                  <th></th>
                  <th>{{ $t('arena.col.model') }}</th>
                  <th>{{ $t('arena.col.changes') }}</th>
                  <th>{{ $t('arena.col.cost') }}</th>
                  <th>{{ $t('arena.col.rating') }}</th>
                  <th>{{ $t('arena.col.adopt') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.cand.id">
                  <td class="cid">{{ row.cand.id }}</td>
                  <td class="model">{{ row.cand.model || $t('arena.col.default-model', { cli: row.cand.agent }) }}</td>
                  <td>
                    <template v-if="row.stat">
                      {{ $t('arena.col.files', { n: row.stat.files }) }}
                      <span class="add">+{{ row.stat.added }}</span><span class="del">−{{ row.stat.deleted }}</span>
                      <span v-if="row.stat.protected.length" class="prot inline">{{ $t('arena.col.protected', { n: row.stat.protected.length }) }}</span>
                    </template>
                  </td>
                  <td>{{ row.stat?.spend.available ? `US$${row.stat.spend.usd.toFixed(2)}` : '—' }}</td>
                  <td class="stars" :aria-label="$t('arena.col.rating')">
                    <button
                      v-for="n in 5"
                      :key="n"
                      class="star"
                      :class="{ lit: n <= row.cand.rating }"
                      :aria-label="$t('arena.compare.rate', { n })"
                      @click="updateCandidate(row.cand.id, { rating: row.cand.rating === n ? 0 : n })"
                    >★</button>
                  </td>
                  <td>
                    <label class="adopt">
                      <input type="radio" name="arena-adopt" :checked="row.cand.adopted" data-testid="arena-adopt" @change="updateCandidate(row.cand.id, { adopted: true })" />
                      {{ $t('arena.compare.adopt') }}
                    </label>
                  </td>
                </tr>
              </tbody>
            </table>

            <p v-if="filesError" class="err">{{ filesError }}</p>
            <p v-else-if="!files.length" class="muted">{{ $t('arena.compare.no-changes') }}</p>
            <div v-else class="split">
              <ul class="files" data-testid="arena-files">
                <li
                  v-for="f in files"
                  :key="f.path"
                  :class="{ on: f.path === pickedFile, prot: f.protected }"
                  :title="f.protected ? $t('arena.compare.protected-hint') : f.path"
                  @click="pickedFile = f.path"
                >
                  <span v-truncate class="fpath">{{ f.path }}</span>
                  <span class="dots">
                    <i v-for="c in run.candidates" :key="c.id" :class="{ hit: !!f.by[c.id] }">{{ c.id }}</i>
                  </span>
                </li>
              </ul>
              <div class="cols" :style="{ gridTemplateColumns: `repeat(${run.candidates.length}, minmax(0, 1fr))` }">
                <div v-for="c in run.candidates" :key="c.id" class="col" data-testid="arena-diff-col">
                  <div class="col-hdr">{{ c.id }} · {{ c.model || c.agent }}</div>
                  <div v-if="diffs[c.id] === null" class="muted pad">{{ $t('arena.compare.unchanged') }}</div>
                  <pre v-else-if="diffs[c.id]" class="diff"><span v-for="(l, i) in arenaDiffLines(diffs[c.id]!.text)" :key="i" :class="l.kind">{{ l.text }}
</span><span v-if="diffs[c.id]!.truncated" class="meta">{{ $t('arena.compare.truncated') }}</span></pre>
                  <div v-else class="muted pad">…</div>
                </div>
              </div>
            </div>
            <div class="actions left">
              <button class="ghost" @click="loadCompare">{{ $t('arena.compare.refresh') }}</button>
            </div>
          </section>

          <section v-if="tab === 'merge'" class="merge" data-testid="arena-merge">
            <div class="modes" role="radiogroup">
              <label><input v-model="mergeMode" type="radio" value="whole" /> {{ $t('arena.merge.mode-whole') }}</label>
              <label><input v-model="mergeMode" type="radio" value="mix" data-testid="arena-mode-mix" /> {{ $t('arena.merge.mode-mix') }}</label>
              <label><input v-model="mergeMode" type="radio" value="branch" /> {{ $t('arena.merge.mode-branch') }}</label>
            </div>

            <div v-if="mergeMode !== 'mix'" class="pick">
              <span class="lb">{{ $t('arena.merge.candidate') }}</span>
              <select v-model="mergeCandidate" data-testid="arena-merge-candidate">
                <option v-for="c in run.candidates" :key="c.id" :value="c.id">{{ c.id }} · {{ c.model || c.agent }}{{ c.adopted ? ` (${$t('arena.col.adopt')})` : '' }}</option>
              </select>
              <label v-if="mergeMode === 'whole'" class="squash"><input v-model="squash" type="checkbox" /> {{ $t('arena.merge.squash') }}</label>
            </div>

            <table v-else class="grid mix" data-testid="arena-mix">
              <thead><tr><th>{{ $t('arena.merge.file') }}</th><th>{{ $t('arena.merge.take-from') }}</th></tr></thead>
              <tbody>
                <tr v-for="f in files" :key="f.path">
                  <td :class="{ prot: f.protected }"><span v-truncate class="fpath">{{ f.path }}</span></td>
                  <td>
                    <select v-model="picks[f.path]">
                      <option value="">{{ $t('arena.merge.skip') }}</option>
                      <option v-for="c in run.candidates" :key="c.id" :value="c.id" :disabled="!f.by[c.id]">{{ c.id }} · {{ c.model || c.agent }}</option>
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
            <p v-if="mergeMode === 'mix'" class="muted small">{{ $t('arena.merge.mix-hint') }}</p>

            <div v-if="mergeMode !== 'branch' && preview" class="preview" data-testid="arena-merge-preview">
              <div>{{ $t('arena.merge.into', { branch: preview.branch || 'HEAD' }) }}</div>
              <div v-if="preview.new_commits.length" class="warn">{{ $t('arena.merge.new-commits', { n: preview.new_commits.length }) }}</div>
              <div v-if="mergeBlocked && mergeBlocked !== 'busy' && mergeBlocked !== 'arena.merge.confirm-check'" class="warn">{{ $t(mergeBlocked, { branch: run.base_branch }) }}</div>
              <label v-if="run.check_command" class="check"><input v-model="checkConfirmed" type="checkbox" data-testid="arena-check-confirm" /> {{ $t('arena.merge.check-confirm', { cmd: run.check_command }) }}</label>
            </div>
            <p v-else-if="mergeMode === 'branch'" class="muted small">{{ $t('arena.merge.branch-hint') }}</p>

            <div class="actions left">
              <button class="primary" :class="{ danger: confirming }" :disabled="!!mergeBlocked" data-testid="arena-merge-go" @click="doMerge">
                {{ merging ? $t('arena.merge.merging') : confirming ? $t('arena.merge.confirm', { branch: preview?.branch || 'HEAD' }) : $t('arena.merge.go') }}
              </button>
              <button v-if="confirming" class="ghost" @click="confirming = false">{{ $t('action.cancel') }}</button>
            </div>

            <div v-if="mergeResult" class="result" :class="{ bad: !mergeResult.ok }" data-testid="arena-merge-result">
              <template v-if="mergeResult.ok">
                {{ mergeResult.commit ? $t('arena.merge.done', { sha: mergeResult.commit.slice(0, 9) }) : $t('arena.merge.kept', { branch: mergeResult.branch }) }}
              </template>
              <template v-else>
                <div>{{ $t('arena.merge.failed') }} {{ mergeResult.error }}</div>
                <div v-if="mergeResult.conflict_files?.length">
                  {{ $t('arena.merge.conflicts') }}
                  <ul><li v-for="p in mergeResult.conflict_files" :key="p" class="mono">{{ p }}</li></ul>
                </div>
              </template>
            </div>

            <fieldset class="cleanup" data-testid="arena-cleanup">
              <legend>{{ $t('arena.cleanup.title') }}</legend>
              <label><input v-model="cleanPanes" type="checkbox" /> {{ $t('arena.cleanup.panes') }}</label>
              <label><input v-model="cleanWorktrees" type="checkbox" /> {{ $t('arena.cleanup.worktrees') }}</label>
              <label><input v-model="cleanBranches" type="checkbox" /> {{ $t('arena.cleanup.branches') }}</label>
              <p class="muted small">{{ $t('arena.cleanup.remote') }}</p>
              <button class="ghost" :disabled="cleaning" data-testid="arena-cleanup-go" @click="doCleanup">{{ $t('arena.cleanup.go') }}</button>
              <p v-if="cleanResult" :class="cleanResult.ok ? 'muted small' : 'err'">
                {{ cleanResult.ok ? $t('arena.cleanup.done', { n: cleanResult.removed?.length ?? 0 }) : (cleanResult.errors?.join('; ') || cleanResult.error) }}
              </p>
            </fieldset>

            <p v-truncate class="summary-line mono">{{ summaryLine }}</p>
          </section>

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
.tabs { display: flex; gap: 4px; margin-top: 10px; border-bottom: 1px solid var(--border-default); }
.tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; color: var(--text-secondary); }
.tabs button.on { color: var(--text-primary); border-bottom-color: var(--accent-fg); font-weight: 600; }
.summary { margin-bottom: 12px; }
.prot.inline { display: inline; margin-left: 8px; }
.stars { white-space: nowrap; }
.star { min-height: 0; padding: 0 1px; border: 0; background: none; color: var(--text-secondary); font-size: 14px; }
.star.lit { color: var(--attention-fg); }
.adopt { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
.err { color: var(--danger-fg); }
.split { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 10px; min-height: 280px; }
.files { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-default); border-radius: var(--radius-sm); overflow: auto; max-height: 52vh; }
.files li { display: flex; gap: 6px; align-items: center; padding: 5px 8px; cursor: pointer; border-bottom: 1px solid var(--border-muted, var(--border-default)); }
.files li.on { background: var(--accent-subtle); }
.files li.prot .fpath { color: var(--danger-fg); }
.fpath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; }
.dots { display: flex; gap: 2px; }
.dots i { font-style: normal; font-size: 10px; width: 14px; text-align: center; border-radius: 7px; color: var(--text-secondary); opacity: 0.35; }
.dots i.hit { opacity: 1; background: var(--accent-subtle); color: var(--accent-fg); font-weight: 700; }
.cols { display: grid; gap: 8px; min-width: 0; }
.col { min-width: 0; border: 1px solid var(--border-default); border-radius: var(--radius-sm); overflow: hidden; display: flex; flex-direction: column; }
.col-hdr { padding: 5px 8px; background: var(--bg-subtle); font-weight: 600; font-size: 12px; border-bottom: 1px solid var(--border-default); }
.pad { padding: 8px; }
.diff { margin: 0; padding: 6px 0; overflow: auto; max-height: 52vh; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; line-height: 1.45; }
.diff span { display: block; padding: 0 8px; white-space: pre; }
.diff .add { background: var(--success-subtle); color: var(--text-primary); margin: 0; }
.diff .del { background: var(--danger-subtle); color: var(--text-primary); margin: 0; }
.diff .hunk { color: var(--accent-fg); }
.diff .meta { color: var(--text-secondary); }
.actions.left { justify-content: flex-start; }
.merge { margin-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.modes { display: flex; gap: 18px; flex-wrap: wrap; }
.modes label, .squash, .check, .cleanup label { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
.pick { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.lb { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.mix td.prot .fpath { color: var(--danger-fg); }
.mix .fpath { display: block; max-width: 520px; }
.small { font-size: 12px; margin: 0; }
.preview { padding: 8px 10px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-subtle); display: flex; flex-direction: column; gap: 4px; }
button.primary { background: var(--accent-emphasis); border-color: transparent; color: var(--text-on-emphasis); }
button.primary.danger { background: var(--danger-emphasis); }
button:disabled { opacity: 0.5; cursor: default; }
.result { padding: 8px 10px; border-radius: var(--radius-sm); background: var(--success-subtle); }
.result.bad { background: var(--danger-subtle); }
.result ul { margin: 4px 0 0 18px; padding: 0; }
.cleanup { border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.cleanup legend { font-size: 12px; font-weight: 600; color: var(--text-secondary); padding: 0 4px; }
.cleanup p { flex-basis: 100%; }
.summary-line { margin: 0; color: var(--text-secondary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 760px) { .split { grid-template-columns: 1fr; } }
select { padding: 4px 6px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-subtle); color: var(--text-primary); }
</style>
