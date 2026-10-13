<script setup lang="ts">
// Sortable table preview for .csv/.tsv files. Content comes over the WS
// fs.read_file handler (same source the raw editor uses); parsing is the
// local RFC-4180-style parser in ./csvParser (no npm dependency).
import { computed, onMounted, ref } from 'vue'
import type { useBackend } from '../../composables/useBackend'
import { delimiterFor, parseDelimited } from './csvParser'
import { vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{
  workspacePath: string
  relPath: string
  backend: ReturnType<typeof useBackend>
}>()

interface CsvReadResp {
  ok: boolean
  content?: string
  error?: string
}

const MAX_ROWS = 5000

const loading = ref(true)
const error = ref('')
const header = ref<string[]>([])
const rows = ref<string[][]>([])
const truncated = ref(false)

onMounted(async () => {
  try {
    const r = await props.backend.send<CsvReadResp>('fs.read_file', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
    })
    if (!r.payload?.ok || typeof r.payload.content !== 'string') {
      error.value = r.payload?.error || 'read failed'
      return
    }
    // +1: the header row does not count against the data-row cap.
    const parsed = parseDelimited(r.payload.content, delimiterFor(props.relPath), MAX_ROWS + 1)
    header.value = parsed.rows[0] ?? []
    rows.value = parsed.rows.slice(1)
    truncated.value = parsed.truncated
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})

// ── Column sort ───────────────────────────────────────────────────────────────
const sortCol = ref<number | null>(null)
const sortAsc = ref(true)

function toggleSort(col: number): void {
  if (sortCol.value === col) {
    sortAsc.value = !sortAsc.value
  } else {
    sortCol.value = col
    sortAsc.value = true
  }
}

// A column sorts numerically when every non-empty cell parses as a number.
function isNumericColumn(col: number): boolean {
  let sawValue = false
  for (const row of rows.value) {
    const v = (row[col] ?? '').trim()
    if (v === '') continue
    sawValue = true
    if (!Number.isFinite(Number(v))) return false
  }
  return sawValue
}

const sortedRows = computed(() => {
  const col = sortCol.value
  if (col === null) return rows.value
  const dir = sortAsc.value ? 1 : -1
  const numeric = isNumericColumn(col)
  return [...rows.value].sort((a, b) => {
    const va = a[col] ?? ''
    const vb = b[col] ?? ''
    if (numeric) return (Number(va.trim() || 'NaN') - Number(vb.trim() || 'NaN') || 0) * dir
    return va.localeCompare(vb) * dir
  })
})
</script>

<template>
  <div class="csvp">
    <div v-if="loading" class="csvp-status">{{ $t('preview.csv-loading') }}</div>
    <div v-else-if="error" class="csvp-status csvp-status--error">
      {{ $t('preview.csv-error') }} ({{ error }})
    </div>
    <template v-else>
      <div v-if="truncated" class="csvp-status">
        {{ $t('preview.csv-truncated', { max: MAX_ROWS }) }}
      </div>
      <div v-if="header.length === 0" class="csvp-status">{{ $t('preview.csv-empty') }}</div>
      <div v-else class="csvp-scroll">
        <table class="csvp-table">
          <thead>
            <tr>
              <th
                v-for="(cell, ci) in header"
                :key="ci"
                class="csvp-th" v-truncate
                @click="toggleSort(ci)"
              >
                {{ cell }}
                <span v-if="sortCol === ci" class="csvp-sort">{{ sortAsc ? '▲' : '▼' }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, ri) in sortedRows" :key="ri">
              <td v-for="(cell, ci) in header" :key="ci" class="csvp-td" v-truncate>{{ row[ci] ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.csvp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.csvp-status {
  padding: 8px 12px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  flex: none;
}
.csvp-status--error {
  color: var(--danger-fg, #e5534b);
}
.csvp-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.csvp-table {
  border-collapse: collapse;
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
.csvp-th {
  position: sticky;
  top: 0;
  background: var(--bg-subtle, rgba(128, 128, 128, 0.12));
  text-align: left;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.csvp-th,
.csvp-td {
  padding: 3px 10px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.csvp-sort {
  font-size: 9px;
  opacity: 0.7;
}
</style>
