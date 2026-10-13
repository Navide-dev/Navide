<script setup lang="ts">
// Dispatch host for all file previews: classifies the file via previewKind,
// renders the shared toolbar, and mounts the per-kind body. Simple kinds
// (image/video/audio/pdf/html/binary) are inline branches below; richer kinds
// live as standalone components under ./preview/ — to add one, define the
// kind in previewTypes.ts, create preview/<Kind>Preview.vue taking the
// common props (workspacePath, relPath, name, backend), and add a v-else-if
// branch in the template before the binary fallback.
import { computed, onMounted, ref, watch } from 'vue'
import type { useBackend } from '../composables/useBackend'
import { buildPageUrl, buildRawUrl, fileExt, previewKind, wsTokenFromUrl } from './previewTypes'
import ArchivePreview from './preview/ArchivePreview.vue'
import CsvPreview from './preview/CsvPreview.vue'
import FontPreview from './preview/FontPreview.vue'
import NotebookPreview from './preview/NotebookPreview.vue'
import OfficePreview from './preview/OfficePreview.vue'
import { vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{
  workspacePath: string
  relPath: string
  name: string
  backend: ReturnType<typeof useBackend>
  // Optional metadata known at open time (e.g. from fs.read_file); when absent
  // the size is derived from the /fs/raw response headers.
  size?: number
  ext?: string
}>()

const kind = computed(() => previewKind(props.relPath) ?? 'binary')
const ext = computed(() => (props.ext ?? fileExt(props.relPath)) || 'bin')
const wsToken = computed(() => wsTokenFromUrl(props.backend.wsUrl?.value ?? ''))
const rawUrl = computed(() =>
  buildRawUrl(props.backend.httpUrl.value, props.workspacePath, props.relPath, wsToken.value),
)
// HTML preview loads through the path-addressed /fs/page route so relative
// subresources (./style.css, images) resolve. The route wants a per-workspace
// capability in the path (not the ws token — the previewed page is untrusted
// and can leak its URL), which only the socket hands out; so the URL is
// filled in once that answer arrives, and the frame stays blank until then.
const pageUrl = ref('')
async function loadPageUrl(): Promise<void> {
  pageUrl.value = ''
  if (kind.value !== 'html') return
  const resp = (await props.backend.send('fs.page_capability', {
    workspace_path: props.workspacePath,
  })) as { payload?: { cap?: string; ws_b64?: string } } | null
  const cap = String(resp?.payload?.cap ?? '')
  const wsB64 = String(resp?.payload?.ws_b64 ?? '')
  if (!cap || !wsB64) return
  pageUrl.value = buildPageUrl(props.backend.httpUrl.value, cap, wsB64, props.relPath)
}
watch(() => [props.workspacePath, props.relPath, kind.value], () => void loadPageUrl(), { immediate: true })

// ── File size ─────────────────────────────────────────────────────────────────
const fileSize = ref<number | null>(props.size ?? null)

function formatBytes(bytes: number): string {
  if (bytes > 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

// Total size from a Range response: Content-Range "bytes 0-65535/123456",
// falling back to Content-Length for servers that answered 200.
function sizeFromHeaders(resp: Response): number | null {
  const range = resp.headers.get('content-range')
  const m = range?.match(/\/(\d+)\s*$/)
  if (m) return Number(m[1])
  const len = resp.headers.get('content-length')
  return len !== null && len !== '' ? Number(len) : null
}

async function loadSize(): Promise<void> {
  if (fileSize.value !== null) return
  try {
    const resp = await fetch(rawUrl.value, { headers: { Range: 'bytes=0-0' } })
    if (resp.ok) fileSize.value = sizeFromHeaders(resp)
  } catch {
    /* size stays unknown — the preview itself still works */
  }
}

// ── Image zoom ────────────────────────────────────────────────────────────────
const fitToWindow = ref(true)
const imgDims = ref('')

function onImgLoad(e: Event): void {
  const img = e.target as HTMLImageElement
  if (img.naturalWidth) imgDims.value = `${img.naturalWidth} × ${img.naturalHeight}`
}

const metaText = computed(() => {
  const parts: string[] = []
  if (imgDims.value) parts.push(imgDims.value)
  parts.push(ext.value.toUpperCase())
  if (fileSize.value !== null) parts.push(formatBytes(fileSize.value))
  return parts.join(' · ')
})

// ── PDF ───────────────────────────────────────────────────────────────────────
// Chromium exposes the embedded PDF viewer's availability via
// navigator.pdfViewerEnabled; when it is disabled (e.g. plugins are off for
// this window) fall back to an info card instead of a broken iframe.
const pdfSupported =
  typeof navigator !== 'undefined' && 'pdfViewerEnabled' in navigator
    ? navigator.pdfViewerEnabled
    : true
const pdfLoaded = ref(false)

// ── Raw load failure ──────────────────────────────────────────────────────────
// null = no failure seen; '' = failed without detail; otherwise the detail.
// <img>/<video>/<audio> report failures through their error event, but an
// iframe fires load even for a 403 page, so the PDF branch probes /fs/raw.
const rawError = ref<string | null>(null)

function onRawError(): void {
  rawError.value ??= ''
}

async function probePdf(url: string): Promise<void> {
  let detail: string | null = null
  try {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-0' } })
    // 416: the file exists but is empty, so no byte range can be satisfied.
    if (!resp.ok && resp.status !== 416) detail = `HTTP ${resp.status}`
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err)
  }
  // Ignore answers for a file that is no longer shown.
  if (detail !== null && url === rawUrl.value) rawError.value = detail
}

function loadRaw(url: string): void {
  rawError.value = null
  if (kind.value === 'pdf' && pdfSupported) void probePdf(url)
}

watch(rawUrl, loadRaw, { immediate: true })

// Clearing the error remounts <img>/<video>/<audio>, which loads again; the
// PDF branch re-probes.
function retryRaw(): void {
  loadRaw(rawUrl.value)
}

// ── Hex dump (unknown binary) ─────────────────────────────────────────────────
const HEX_LIMIT = 65536
const hexLoading = ref(false)
const hexError = ref('')
const hexText = ref('')
const hexTruncated = ref(false)

function buildHexDump(bytes: Uint8Array): string {
  const lines: string[] = []
  for (let off = 0; off < bytes.length; off += 16) {
    const row = bytes.subarray(off, off + 16)
    let hex = ''
    let ascii = ''
    for (let i = 0; i < 16; i++) {
      if (i === 8) hex += ' '
      if (i < row.length) {
        hex += row[i].toString(16).padStart(2, '0') + ' '
        ascii += row[i] >= 0x20 && row[i] <= 0x7e ? String.fromCharCode(row[i]) : '.'
      } else {
        hex += '   '
      }
    }
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex} |${ascii}|`)
  }
  return lines.join('\n')
}

async function loadHex(): Promise<void> {
  hexLoading.value = true
  hexError.value = ''
  try {
    const resp = await fetch(rawUrl.value, {
      headers: { Range: `bytes=0-${HEX_LIMIT - 1}` },
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    if (fileSize.value === null) fileSize.value = sizeFromHeaders(resp)
    const buf = await resp.arrayBuffer()
    // Slice defensively in case the server ignored the Range header.
    const bytes = new Uint8Array(buf).subarray(0, HEX_LIMIT)
    hexTruncated.value = (fileSize.value ?? bytes.length) > bytes.length
    hexText.value = buildHexDump(bytes)
  } catch (err) {
    hexError.value = err instanceof Error ? err.message : String(err)
  } finally {
    hexLoading.value = false
  }
}

// ── Open externally ───────────────────────────────────────────────────────────
async function openExternally(): Promise<void> {
  const abs = `${props.workspacePath.replace(/\/+$/, '')}/${props.relPath}`
  await window.agentTeam?.openPath(abs)
}

onMounted(() => {
  if (kind.value === 'binary') void loadHex()
  else if (kind.value === 'image') void loadSize()
})
</script>

<template>
  <div class="fpv">
    <div class="fpv-toolbar">
      <span class="fpv-name" v-truncate :title="relPath">{{ name }}</span>
      <span v-if="metaText" class="fpv-meta">{{ metaText }}</span>
      <span v-if="kind === 'html'" class="fpv-hint">{{ $t('preview.html-scripts-disabled') }}</span>
      <span class="fpv-spacer" />
      <button
        v-if="kind === 'image'"
        class="fpv-btn fpv-zoom-btn"
        @click="fitToWindow = !fitToWindow"
      >{{ fitToWindow ? $t('preview.actual-size') : $t('preview.fit-window') }}</button>
      <button class="fpv-btn fpv-open-btn" @click="openExternally">
        {{ $t('preview.open-externally') }}
      </button>
    </div>

    <!-- Image -->
    <div v-if="kind === 'image'" class="fpv-body fpv-image-body">
      <div v-if="rawError !== null" class="fpv-raw-error">
        {{ $t('preview.raw-error') }}<template v-if="rawError"> ({{ rawError }})</template>
        <button class="fpv-btn fpv-retry-btn" @click="retryRaw">{{ $t('preview.retry') }}</button>
      </div>
      <img
        v-else
        :src="rawUrl"
        class="fpv-img"
        :class="fitToWindow ? 'fpv-img--fit' : 'fpv-img--full'"
        :alt="name"
        @load="onImgLoad"
        @error="onRawError"
      />
    </div>

    <!-- Video -->
    <div v-else-if="kind === 'video'" class="fpv-body fpv-media-body">
      <div v-if="rawError !== null" class="fpv-raw-error">
        {{ $t('preview.raw-error') }}<template v-if="rawError"> ({{ rawError }})</template>
        <button class="fpv-btn fpv-retry-btn" @click="retryRaw">{{ $t('preview.retry') }}</button>
      </div>
      <video v-else class="fpv-video" controls :src="rawUrl" @error="onRawError" />
    </div>

    <!-- Audio -->
    <div v-else-if="kind === 'audio'" class="fpv-body fpv-media-body">
      <div v-if="rawError !== null" class="fpv-raw-error">
        {{ $t('preview.raw-error') }}<template v-if="rawError"> ({{ rawError }})</template>
        <button class="fpv-btn fpv-retry-btn" @click="retryRaw">{{ $t('preview.retry') }}</button>
      </div>
      <audio v-else class="fpv-audio" controls :src="rawUrl" @error="onRawError" />
    </div>

    <!-- PDF -->
    <template v-else-if="kind === 'pdf'">
      <div v-if="pdfSupported && rawError !== null" class="fpv-body fpv-media-body">
        <div class="fpv-raw-error">
          {{ $t('preview.raw-error') }}<template v-if="rawError"> ({{ rawError }})</template>
        <button class="fpv-btn fpv-retry-btn" @click="retryRaw">{{ $t('preview.retry') }}</button>
        </div>
      </div>
      <div v-else-if="pdfSupported" class="fpv-body fpv-pdf-body">
        <div v-if="!pdfLoaded" class="fpv-pdf-loading">{{ $t('label.loading') }}</div>
        <iframe
          class="fpv-pdf-frame"
          :src="rawUrl"
          :title="name"
          @load="pdfLoaded = true"
        />
      </div>
      <div v-else class="fpv-body fpv-card-body">
        <div class="fpv-card">
          <span class="fpv-card-icon">⬛</span>
          <p class="fpv-card-name">{{ name }}</p>
          <p class="fpv-card-meta">{{ metaText }}</p>
          <p class="fpv-card-hint">{{ $t('preview.pdf-unavailable') }}</p>
        </div>
      </div>
    </template>

    <!-- HTML: sandboxed iframe. The empty sandbox attribute (no allow-*) is
         the second layer on top of the backend's CSP sandbox header — the
         document is an opaque origin with scripts/forms/plugins blocked. -->
    <div v-else-if="kind === 'html'" class="fpv-body fpv-html-body">
      <iframe class="fpv-html-frame" :src="pageUrl" :title="name" sandbox="" />
    </div>

    <!-- CSV/TSV: sortable table -->
    <div v-else-if="kind === 'csv'" class="fpv-body fpv-component-body">
      <CsvPreview :workspace-path="workspacePath" :rel-path="relPath" :backend="backend" />
    </div>

    <!-- Font: @font-face specimen -->
    <div v-else-if="kind === 'font'" class="fpv-body fpv-component-body">
      <FontPreview
        :workspace-path="workspacePath"
        :rel-path="relPath"
        :name="name"
        :backend="backend"
      />
    </div>

    <!-- Archive: entry listing via fs.list_archive -->
    <div v-else-if="kind === 'archive'" class="fpv-body fpv-component-body">
      <ArchivePreview
        :workspace-path="workspacePath"
        :rel-path="relPath"
        :name="name"
        :backend="backend"
      />
    </div>

    <!-- Jupyter notebook: cells + outputs -->
    <div v-else-if="kind === 'notebook'" class="fpv-body fpv-component-body">
      <NotebookPreview
        :workspace-path="workspacePath"
        :rel-path="relPath"
        :name="name"
        :backend="backend"
      />
    </div>

    <!-- Office document: backend fs.convert_office -->
    <div v-else-if="kind === 'office'" class="fpv-body fpv-component-body">
      <OfficePreview
        :workspace-path="workspacePath"
        :rel-path="relPath"
        :name="name"
        :backend="backend"
      />
    </div>

    <!-- Unknown binary: info card + hex dump -->
    <div v-else class="fpv-body fpv-card-body">
      <div class="fpv-card">
        <span class="fpv-card-icon">⬛</span>
        <p class="fpv-card-name">{{ name }}</p>
        <p class="fpv-card-meta">{{ metaText }}</p>
      </div>
      <div v-if="hexLoading" class="fpv-hex-status">{{ $t('preview.hex-loading') }}</div>
      <div v-else-if="hexError" class="fpv-hex-status fpv-hex-status--error">
        {{ $t('preview.hex-error') }} ({{ hexError }})
      </div>
      <template v-else-if="hexText">
        <div v-if="hexTruncated && fileSize !== null" class="fpv-hex-status">
          {{ $t('preview.hex-truncated', { total: formatBytes(fileSize) }) }}
        </div>
        <pre class="fpv-hex">{{ hexText }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.fpv {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-base);
  color: var(--text-primary);
}
.fpv-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
  font-size: var(--font-xs);
  flex: none;
}
.fpv-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fpv-meta {
  color: var(--text-secondary);
  white-space: nowrap;
}
.fpv-hint {
  color: var(--text-secondary);
  white-space: nowrap;
}
.fpv-spacer {
  flex: 1;
}
.fpv-btn {
  background: transparent;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.35));
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.fpv-btn:hover {
  color: var(--text-primary);
}
.fpv-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.fpv-image-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
}
.fpv-img--fit {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.fpv-img--full {
  max-width: none;
  max-height: none;
  align-self: flex-start;
  margin: auto;
}
.fpv-media-body {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
}
.fpv-video {
  max-width: 100%;
  max-height: 100%;
}
.fpv-audio {
  width: 80%;
  max-width: 560px;
}
.fpv-pdf-body {
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}
.fpv-pdf-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  pointer-events: none;
}
.fpv-pdf-frame {
  flex: 1;
  width: 100%;
  border: 0;
}
.fpv-html-body {
  display: flex;
  overflow: hidden;
}
.fpv-component-body {
  overflow: hidden;
}
.fpv-html-frame {
  flex: 1;
  width: 100%;
  border: 0;
  /* Sandboxed documents default to a transparent background; paint white so
     unstyled pages stay readable on dark themes. */
  background: #fff;
}
.fpv-card-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 16px;
  gap: 12px;
}
.fpv-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}
.fpv-card-icon {
  font-size: 28px;
  opacity: 0.5;
}
.fpv-card-name {
  margin: 0;
  font-weight: 600;
}
.fpv-card-meta,
.fpv-card-hint {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.fpv-raw-error {
  color: var(--danger-fg, #e5534b);
  font-size: var(--font-xs);
  text-align: center;
}
.fpv-retry-btn {
  margin-left: 8px;
}
.fpv-hex-status {
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.fpv-hex-status--error {
  color: var(--danger-fg, #e5534b);
}
.fpv-hex {
  align-self: stretch;
  margin: 0;
  padding: 8px 12px;
  overflow: auto;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-2xs);
  line-height: var(--lh-base);
  white-space: pre;
  background: var(--bg-subtle, rgba(128, 128, 128, 0.08));
  border-radius: 6px;
}
</style>
