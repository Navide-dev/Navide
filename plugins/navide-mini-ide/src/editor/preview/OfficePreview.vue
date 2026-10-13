<script setup lang="ts">
// Office document preview (.docx/.xlsx) via the WS fs.convert_office handler.
// docx → backend-converted HTML rendered ONLY inside a fully sandboxed iframe
// via srcdoc (empty sandbox attribute — never v-html into the app origin);
// xlsx → per-sheet tables behind tabs, mirroring the CsvPreview table styling.
import { onMounted, ref } from 'vue'
import type { useBackend } from '../../composables/useBackend'
import { vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{
  workspacePath: string
  relPath: string
  name: string
  backend: ReturnType<typeof useBackend>
}>()

interface OfficeSheet {
  name: string
  rows: string[][]
  truncated?: boolean
}

interface ConvertOfficeResp {
  ok: boolean
  kind?: 'docx' | 'xlsx'
  html?: string
  sheets?: OfficeSheet[]
  error?: string
}

const loading = ref(true)
const error = ref('')
const docxHtml = ref('')
const sheets = ref<OfficeSheet[]>([])
const activeSheet = ref(0)

onMounted(async () => {
  try {
    const r = await props.backend.send<ConvertOfficeResp>('fs.convert_office', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
    })
    const p = r.payload
    if (!p?.ok) {
      error.value = p?.error || 'convert failed'
      return
    }
    if (p.kind === 'docx' && typeof p.html === 'string') {
      docxHtml.value = p.html
    } else if (p.kind === 'xlsx' && Array.isArray(p.sheets)) {
      sheets.value = p.sheets
    } else {
      error.value = 'unexpected response'
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="offp">
    <div v-if="loading" class="offp-status">{{ $t('preview.office-loading') }}</div>
    <div v-else-if="error" class="offp-card">
      <span class="offp-card-icon">⬛</span>
      <p class="offp-card-name">{{ name }}</p>
      <p class="offp-card-error">{{ $t('preview.office-error') }} ({{ error }})</p>
    </div>

    <!-- docx: sandboxed HTML document (opaque origin, scripts/forms blocked) -->
    <iframe
      v-else-if="docxHtml"
      class="offp-frame"
      :srcdoc="docxHtml"
      sandbox=""
      :title="name"
    />

    <!-- xlsx: sheet tabs + table -->
    <template v-else>
      <div class="offp-tabs">
        <button
          v-for="(sheet, si) in sheets"
          :key="si"
          class="offp-tab"
          :class="{ 'offp-tab--active': si === activeSheet }"
          @click="activeSheet = si"
        >{{ sheet.name }}</button>
      </div>
      <div v-if="sheets[activeSheet]?.truncated" class="offp-status">
        {{ $t('preview.office-truncated') }}
      </div>
      <div class="offp-scroll">
        <table class="offp-table">
          <tbody>
            <tr v-for="(row, ri) in sheets[activeSheet]?.rows ?? []" :key="ri">
              <td v-for="(cell, ci) in row" :key="ci" class="offp-td" v-truncate>{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.offp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.offp-status {
  padding: 8px 12px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  flex: none;
}
.offp-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 24px 16px;
  text-align: center;
}
.offp-card-icon {
  font-size: 28px;
  opacity: 0.5;
}
.offp-card-name {
  margin: 0;
  font-weight: 600;
}
.offp-card-error {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--danger-fg, #e5534b);
}
.offp-frame {
  flex: 1;
  width: 100%;
  border: 0;
  /* Sandboxed documents default to a transparent background; paint white so
     the converted document stays readable on dark themes. */
  background: #fff;
}
.offp-tabs {
  display: flex;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
  overflow-x: auto;
  flex: none;
}
.offp-tab {
  background: transparent;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.35));
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  padding: 2px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.offp-tab--active {
  color: var(--text-primary);
  background: var(--bg-subtle, rgba(128, 128, 128, 0.12));
}
.offp-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.offp-table {
  border-collapse: collapse;
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
}
.offp-td {
  padding: 3px 10px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
