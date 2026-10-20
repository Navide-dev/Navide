<script setup lang="ts">
// Jupyter notebook preview (.ipynb): nbformat-4 JSON fetched over the WS
// fs.read_file handler. Markdown cells reuse the shared line-based markdown
// renderer; code cells render as monospace blocks with their outputs below.
// Security: text/html outputs go into a fully sandboxed iframe via srcdoc
// (empty sandbox attribute — same zero-permission policy as the HTML
// preview); base64 image outputs become data: URIs; error tracebacks are
// shown as plain text with ANSI escape codes stripped.
import { onMounted, ref } from 'vue'
import type { useBackend } from '../../composables/useBackend'
import { renderLines, InlineText } from '../markdownRender'
import type { RenderLine } from '../markdownRender'

const props = defineProps<{
  workspacePath: string
  relPath: string
  name: string
  backend: ReturnType<typeof useBackend>
}>()

interface ReadResp {
  ok: boolean
  content?: string
  error?: string
}

interface NotebookOutput {
  kind: 'text' | 'image' | 'html' | 'error'
  text?: string
  src?: string
  html?: string
}

interface NotebookCell {
  type: 'markdown' | 'code' | 'raw'
  source: string
  executionCount: number | null
  outputs: NotebookOutput[]
  md?: RenderLine[]
}

const MAX_CELLS = 500

const loading = ref(true)
const error = ref('')
const invalid = ref(false)
const cells = ref<NotebookCell[]>([])
const truncated = ref(false)

// nbformat sources/texts are either a string or a list of line strings.
function joinText(src: unknown): string {
  if (Array.isArray(src)) return src.join('')
  return typeof src === 'string' ? src : ''
}

// eslint-disable-next-line no-control-regex -- ANSI CSI sequences in tracebacks
const ANSI_RE = /\u001b\[[0-9;]*m/g

function parseOutput(raw: Record<string, unknown>): NotebookOutput | null {
  if (raw.output_type === 'stream') return { kind: 'text', text: joinText(raw.text) }
  if (raw.output_type === 'error') {
    const tb = Array.isArray(raw.traceback) ? raw.traceback.join('\n') : ''
    const text = tb || `${raw.ename ?? 'Error'}: ${raw.evalue ?? ''}`
    return { kind: 'error', text: text.replace(ANSI_RE, '') }
  }
  if (raw.output_type === 'execute_result' || raw.output_type === 'display_data') {
    const data = (raw.data ?? {}) as Record<string, unknown>
    for (const mime of ['image/png', 'image/jpeg'] as const) {
      if (data[mime]) {
        const b64 = joinText(data[mime]).replace(/\s+/g, '')
        return { kind: 'image', src: `data:${mime};base64,${b64}` }
      }
    }
    if (data['text/html']) return { kind: 'html', html: joinText(data['text/html']) }
    if (data['text/plain']) return { kind: 'text', text: joinText(data['text/plain']) }
  }
  return null
}

function parseCell(raw: Record<string, unknown>): NotebookCell {
  const type =
    raw.cell_type === 'markdown' ? 'markdown' : raw.cell_type === 'code' ? 'code' : 'raw'
  const source = joinText(raw.source)
  const outputs =
    type === 'code' && Array.isArray(raw.outputs)
      ? (raw.outputs as Record<string, unknown>[])
          .map(parseOutput)
          .filter((o): o is NotebookOutput => o !== null)
      : []
  return {
    type,
    source,
    executionCount: typeof raw.execution_count === 'number' ? raw.execution_count : null,
    outputs,
    md: type === 'markdown' ? renderLines(source) : undefined,
  }
}

onMounted(async () => {
  try {
    const r = await props.backend.send<ReadResp>('fs.read_file', {
      workspace_path: props.workspacePath,
      rel_path: props.relPath,
    })
    if (!r.payload?.ok || typeof r.payload.content !== 'string') {
      error.value = r.payload?.error || 'read failed'
      return
    }
    let doc: unknown
    try {
      doc = JSON.parse(r.payload.content)
    } catch {
      invalid.value = true
      return
    }
    const rawCells = (doc as { cells?: unknown } | null)?.cells
    if (!Array.isArray(rawCells)) {
      invalid.value = true
      return
    }
    truncated.value = rawCells.length > MAX_CELLS
    cells.value = (rawCells as Record<string, unknown>[]).slice(0, MAX_CELLS).map(parseCell)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="nbp">
    <div v-if="loading" class="nbp-status">{{ $t('preview.notebook-loading') }}</div>
    <div v-else-if="error || invalid" class="nbp-card">
      <span class="nbp-card-icon">⬛</span>
      <p class="nbp-card-name">{{ name }}</p>
      <p v-if="invalid" class="nbp-card-error">{{ $t('preview.notebook-invalid') }}</p>
      <p v-else class="nbp-card-error">{{ $t('preview.notebook-error') }} ({{ error }})</p>
    </div>
    <template v-else>
      <div v-if="truncated" class="nbp-status">
        {{ $t('preview.notebook-truncated', { max: MAX_CELLS }) }}
      </div>
      <div class="nbp-scroll">
        <div v-for="(cell, ci) in cells" :key="ci" class="nbp-cell">
          <!-- Markdown cell: shared line-based markdown renderer -->
          <div v-if="cell.type === 'markdown'" class="nbp-md">
            <template v-for="(line, li) in cell.md" :key="li">
              <div v-if="line.kind === 'blank'" class="nbp-line nbp-line--blank" />
              <div
                v-else-if="line.kind === 'heading'"
                :class="['nbp-line', 'nbp-line--heading', 'nbp-line--h' + line.level]"
              ><InlineText :text="line.text" /></div>
              <div v-else-if="line.kind === 'quote'" class="nbp-line nbp-line--quote">
                <InlineText :text="line.text" />
              </div>
              <div v-else-if="line.kind === 'bullet'" class="nbp-line nbp-line--bullet">
                <InlineText :text="line.text" />
              </div>
              <div v-else-if="line.kind === 'ordered'" class="nbp-line nbp-line--ordered">
                <span class="nbp-ordered-marker">{{ line.marker }}</span>
                <InlineText :text="line.text" />
              </div>
              <pre v-else-if="line.kind === 'codeblock'" class="nbp-line nbp-line--code">{{ line.text }}</pre>
              <div v-else class="nbp-line"><InlineText :text="line.text" /></div>
            </template>
          </div>

          <!-- Code cell: monospace source + outputs -->
          <template v-else-if="cell.type === 'code'">
            <div class="nbp-exec">In [{{ cell.executionCount ?? ' ' }}]:</div>
            <pre class="nbp-code">{{ cell.source }}</pre>
            <div v-for="(out, oi) in cell.outputs" :key="oi" class="nbp-output">
              <pre v-if="out.kind === 'text'" class="nbp-out-text">{{ out.text }}</pre>
              <pre v-else-if="out.kind === 'error'" class="nbp-out-error">{{ out.text }}</pre>
              <img v-else-if="out.kind === 'image'" class="nbp-out-img" :src="out.src" :alt="$t('editorWindow.notebook.cell-output')" />
              <!-- Sandboxed HTML output: opaque origin, scripts/forms blocked -->
              <iframe
                v-else-if="out.kind === 'html'"
                class="nbp-out-frame"
                :srcdoc="out.html"
                sandbox=""
                :title="`output ${oi}`"
              />
            </div>
          </template>

          <!-- Raw cell -->
          <pre v-else class="nbp-code nbp-code--raw">{{ cell.source }}</pre>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.nbp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.nbp-status {
  padding: 8px 12px;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  flex: none;
}
.nbp-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 24px 16px;
  text-align: center;
}
.nbp-card-icon {
  font-size: 28px;
  opacity: 0.5;
}
.nbp-card-name {
  margin: 0;
  font-weight: 600;
}
.nbp-card-error {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--danger-fg, #e5534b);
}
.nbp-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
}
.nbp-cell {
  margin: 0 auto 14px;
  max-width: 860px;
}
.nbp-md {
  font-size: var(--font-sm);
  line-height: 1.55;
}
.nbp-md :deep(code) {
  background: var(--bg-muted, rgba(128, 128, 128, 0.12));
  border-radius: 4px;
  padding: 1px 5px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-xs);
}
.nbp-md :deep(.pfv-link) {
  color: var(--accent-fg);
  cursor: pointer;
  text-decoration: none;
}
.nbp-md :deep(.pfv-link:hover) {
  text-decoration: underline;
}
.nbp-line {
  margin: 3px 0;
}
.nbp-line--blank {
  height: 8px;
}
.nbp-line--heading {
  color: var(--text-bright);
  font-weight: 650;
  margin-top: 10px;
}
.nbp-line--h1 {
  font-size: 19px;
}
.nbp-line--h2 {
  font-size: var(--font-lg);
}
.nbp-line--h3 {
  font-size: var(--font-md);
}
.nbp-line--h4 {
  font-size: var(--font-sm);
}
.nbp-line--quote {
  border-left: 3px solid var(--border-strong, rgba(128, 128, 128, 0.45));
  color: var(--text-secondary);
  padding-left: 10px;
}
.nbp-line--bullet {
  padding-left: 18px;
  position: relative;
}
.nbp-line--bullet::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 0.75em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-secondary);
}
.nbp-ordered-marker {
  color: var(--text-secondary);
  margin-right: 4px;
}
.nbp-exec {
  color: var(--text-secondary);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-2xs);
  margin-bottom: 2px;
}
.nbp-code,
.nbp-line--code {
  background: var(--bg-inset, rgba(128, 128, 128, 0.08));
  border-radius: 6px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  margin: 0;
  overflow-x: auto;
  padding: 8px 10px;
  white-space: pre;
}
.nbp-code--raw {
  opacity: 0.8;
}
.nbp-output {
  margin-top: 6px;
}
.nbp-out-text {
  margin: 0;
  padding: 6px 10px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  white-space: pre-wrap;
  word-break: break-word;
}
.nbp-out-error {
  margin: 0;
  padding: 6px 10px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: var(--font-xs);
  line-height: var(--lh-base);
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--danger-fg, #e5534b);
  background: rgba(229, 83, 75, 0.08);
  border-radius: 6px;
}
.nbp-out-img {
  max-width: 100%;
}
.nbp-out-frame {
  width: 100%;
  height: 320px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
  border-radius: 6px;
  /* Sandboxed documents default to a transparent background. */
  background: #fff;
}
</style>
