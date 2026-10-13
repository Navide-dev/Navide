<script setup lang="ts">
// Read-only preview host for the right rail. Owns the header, footer and empty
// state; every body is an existing component:
//   file     -> editor/FilePreviewPane (11 PreviewKinds, unchanged)
//   diff     -> editor/DiffPane in readonly mode
//   markdown -> ./MarkdownPreview (shared markdownRender + mermaid)
//   snippet  -> ./SnippetPreview
//   html     -> ./InlineHtmlPreview (sandbox="")
// Monaco is intentionally never loaded here: the rail is 180-520px wide, the
// panel is read-only, and pulling Monaco into the main window would cost every
// workspace window. "Open in editor" is the escape hatch instead.
import { computed, ref, toRef } from 'vue'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'
import { createHostGitFileAccessPort } from '../composables/hostSurfacePorts'
import { createHostGitTransport } from '../composables/hostGitTransport'
import DiffPane from '../editor/DiffPane.vue'
import FilePreviewPane from '../editor/FilePreviewPane.vue'
import InlineHtmlPreview from './InlineHtmlPreview.vue'
import MarkdownPreview from './MarkdownPreview.vue'
import SnippetPreview from './SnippetPreview.vue'
import { previewSubtitle, previewTitle, type PreviewTarget } from './previewTarget'
import { usePreview } from './usePreview'
import { usePreviewLog, type PreviewLogEntry, type PreviewLogSource } from './usePreviewLog'

const props = defineProps<{
  backend: ReturnType<typeof useBackend>
  workspacePath: string
}>()

const notify = useNotify()
const gitTransport = createHostGitTransport(props.backend)
const fileAccess = createHostGitFileAccessPort(props.backend)
const { current, clear, show } = usePreview()

const target = computed<PreviewTarget | null>(() => current.value)
const title = computed(() => (target.value ? previewTitle(target.value) : ''))
const subtitle = computed(() => (target.value ? previewSubtitle(target.value) : ''))

// Inline kinds carry their payload in `content`; file-backed kinds do not.
const inlineContent = computed(() => {
  const t = target.value
  if (!t) return null
  return t.kind === 'snippet' || t.kind === 'html' || t.kind === 'markdown' ? t.content : null
})

const attribution = computed(() => {
  const t = target.value
  if (!t || !t.source || t.source === 'user') return ''
  return t.origin ? `${t.source} · ${t.origin}` : t.source
})

// A target can name any workspace — the payload comes from MCP and is not
// checked against the set of open projects. Anything that acts on that path
// (below: opening an editor window on it) must therefore refuse a target that
// does not belong to the workspace this panel is showing; otherwise a pushed
// target could aim a read-write editor at an arbitrary directory.
const isForeignWorkspace = computed(() => {
  const t = target.value
  if (!t || (t.kind !== 'file' && t.kind !== 'diff')) return false
  return t.workspacePath !== props.workspacePath
})

const canOpenInEditor = computed(() => {
  const t = target.value
  if (!t || (t.kind !== 'file' && t.kind !== 'diff')) return false
  return !isForeignWorkspace.value
})

const copied = ref(false)

async function copyContent(): Promise<void> {
  const text = inlineContent.value
  if (text === null) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    notify.toast('Copy failed', { type: 'error' })
  }
}

type AgentApi = {
  openEditorWindow?: (a: {
    workspace_path: string
    filepath?: string
    name?: string
  }) => Promise<unknown>
}

// Escape hatch for anything the narrow rail renders poorly. Only file-backed
// targets have somewhere to go.
function openInEditor(relPath?: string, name?: string): void {
  const t = target.value
  if (!t || (t.kind !== 'file' && t.kind !== 'diff')) return
  // Not only the button: DiffPane's open-file event lands here too.
  if (!canOpenInEditor.value) return
  const api = (window as Window & { agentTeam?: AgentApi }).agentTeam
  if (!api?.openEditorWindow) return
  const rel = relPath ?? t.relPath
  void api.openEditorWindow({
    workspace_path: t.workspacePath,
    filepath: rel,
    name: name ?? rel.split('/').pop() ?? rel,
  })
}

// ── Record track ────────────────────────────────────────────────────────────
// The lower half: what this workspace recently changed. Unlike the live target
// above it is persisted, so it is the panel's resting state — with nothing
// pushed it fills the whole panel and answers "what happened here lately".

const previewLog = usePreviewLog(props.backend, toRef(props, 'workspacePath'))

const SOURCE_FILTERS = ['all', 'user', 'agent', 'watcher'] as const
const sourceFilter = ref<(typeof SOURCE_FILTERS)[number]>('all')

const entries = computed(() => previewLog.entries.value)
const visibleEntries = computed(() =>
  sourceFilter.value === 'all'
    ? entries.value
    : entries.value.filter((e) => e.source === (sourceFilter.value as PreviewLogSource))
)

// The track has its own real estate only when it has something to say; with a
// live target above and an empty track the panel stays as it was.
const showTrack = computed(() => entries.value.length > 0 || !target.value)

const CHANGE_MARKS: Record<string, string> = {
  created: '+',
  modified: '~',
  deleted: '−',
  shown: '▸',
}

function changeMark(change: string): string {
  return CHANGE_MARKS[change] ?? '·'
}

// Returns a key plus params so the caller renders it through $t — the units
// belong in the locale files, not here.
function age(entry: PreviewLogEntry): { key: string; params: Record<string, number> } {
  const secs = Math.max(0, Math.floor((Date.now() - entry.created_at) / 1000))
  if (secs < 60) return { key: 'preview.age-now', params: {} }
  const mins = Math.floor(secs / 60)
  if (mins < 60) return { key: 'preview.age-minutes', params: { n: mins } }
  const hours = Math.floor(mins / 60)
  if (hours < 24) return { key: 'preview.age-hours', params: { n: hours } }
  return { key: 'preview.age-days', params: { n: Math.floor(hours / 24) } }
}

const PATH_HEAD = 12
const PATH_TAIL = 26

// Middle elision: the basename is what identifies the row, and the leading
// directory is what distinguishes two files with the same name — a plain
// text-overflow ellipsis would drop exactly the half that matters.
function shortPath(path: string): string {
  if (path.length <= PATH_HEAD + PATH_TAIL + 1) return path
  return `${path.slice(0, PATH_HEAD)}…${path.slice(-PATH_TAIL)}`
}

function rowLabel(entry: PreviewLogEntry): string {
  return shortPath(entry.rel_path ?? entry.title ?? entry.kind)
}

// Never guessed: a vendor with no hook records through the watcher and has no
// author to name, and pretending otherwise would make the track untrustworthy.
function rowAuthor(entry: PreviewLogEntry): string {
  return entry.agent ?? '—'
}

// Only file-backed rows have somewhere to replay to; a deleted file has
// nothing left to read.
function canReplay(entry: PreviewLogEntry): boolean {
  if (entry.change === 'deleted' || !entry.rel_path) return false
  return entry.kind === 'file' || entry.kind === 'diff'
}

function replay(entry: PreviewLogEntry): void {
  if (!canReplay(entry) || !entry.rel_path) return
  show(
    entry.kind === 'diff'
      ? { kind: 'diff', workspacePath: props.workspacePath, relPath: entry.rel_path }
      : { kind: 'file', workspacePath: props.workspacePath, relPath: entry.rel_path }
  )
}

function clearTrack(): void {
  void previewLog.clear()
}
</script>

<template>
  <div class="pv">
    <div v-if="target" class="pv-live">
      <header class="pv-hdr">
        <span class="pv-kind">{{ target.kind }}</span>
        <span class="pv-title" v-truncate :title="subtitle || title">{{ title }}</span>
        <span class="pv-acts">
          <button
            v-if="inlineContent !== null"
            class="pv-btn"
            :title="$t('preview.copy')"
            @click="copyContent"
          >
            {{ copied ? $t('preview.copied') : $t('preview.copy') }}
          </button>
          <button
            v-if="canOpenInEditor"
            class="pv-btn"
            :title="$t('preview.open-in-editor')"
            @click="openInEditor()"
          >
            {{ $t('preview.open') }}
          </button>
          <button class="pv-btn pv-x" :title="$t('preview.close')" @click="clear">✕</button>
        </span>
      </header>

      <div class="pv-body">
        <FilePreviewPane
          v-if="target.kind === 'file'"
          :key="target.workspacePath + ':' + target.relPath"
          :workspace-path="target.workspacePath"
          :rel-path="target.relPath"
          :name="title"
          :backend="props.backend"
        />
        <DiffPane
          v-else-if="target.kind === 'diff'"
          :key="target.workspacePath + ':' + target.relPath + ':' + String(target.staged)"
          :workspace-path="target.workspacePath"
          :filepath="target.relPath"
          :staged="target.staged === true"
          :commit="target.commit"
          :name="title"
          :git-transport="gitTransport"
          :file-access="fileAccess"
          readonly
          @open-file="(f) => openInEditor(f.filepath, f.name)"
        />
        <MarkdownPreview
          v-else-if="target.kind === 'markdown'"
          :content="target.content"
        />
        <InlineHtmlPreview
          v-else-if="target.kind === 'html'"
          :content="target.content"
          :title="title"
        />
        <SnippetPreview v-else :content="target.content" :lang="target.lang" />
      </div>

      <footer class="pv-foot">
        <span v-if="subtitle" class="pv-sub" v-truncate>{{ subtitle }}</span>
        <span v-if="target.kind === 'html'" class="pv-flag">{{ $t('preview.sandboxed') }}</span>
        <span v-if="isForeignWorkspace" class="pv-flag pv-warn">{{ $t('preview.foreign-workspace') }}</span>
        <span v-if="attribution" class="pv-flag">{{ attribution }}</span>
      </footer>
    </div>

    <section v-if="showTrack" class="pv-track" :class="{ 'pv-track-full': !target }">
      <header class="pv-track-hdr">
        <span class="pv-track-title">{{ $t('preview.track-title') }}</span>
        <span class="pv-acts">
          <button
            v-for="f in SOURCE_FILTERS"
            :key="f"
            class="pv-btn"
            :class="{ 'pv-btn-on': sourceFilter === f }"
            @click="sourceFilter = f"
          >
            {{ $t(`preview.filter-${f}`) }}
          </button>
          <button
            v-if="entries.length"
            class="pv-btn"
            :title="$t('preview.track-clear')"
            @click="clearTrack"
          >
            {{ $t('preview.track-clear') }}
          </button>
        </span>
      </header>

      <div v-if="visibleEntries.length" class="pv-track-list">
        <button
          v-for="e in visibleEntries"
          :key="e.uid"
          class="pv-row"
          :class="{ 'pv-row-dead': !canReplay(e) }"
          :disabled="!canReplay(e)"
          :title="e.rel_path ?? e.title ?? e.kind"
          @click="replay(e)"
        >
          <span class="pv-row-age">{{ $t(age(e).key, age(e).params) }}</span>
          <span class="pv-row-mark" :data-change="e.change" :title="$t(`preview.change-${e.change}`)">
            {{ changeMark(e.change) }}
          </span>
          <span class="pv-row-path">{{ rowLabel(e) }}</span>
          <span class="pv-row-who" v-truncate>{{ rowAuthor(e) }}</span>
        </button>
      </div>
      <div v-else-if="entries.length" class="pv-track-note">{{ $t('preview.track-no-match') }}</div>
      <div v-else class="pv-empty">
        <div class="pv-empty-icon" />
        <div class="pv-empty-title">{{ $t('preview.empty-title') }}</div>
        <div class="pv-empty-hint">{{ $t('preview.empty-hint') }}</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}
.pv-live {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}
.pv-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-default);
  flex: none;
}
.pv-kind {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--accent-soft, rgba(123, 148, 240, 0.16));
  color: var(--accent, #7b94f0);
}
.pv-title {
  font-size: 11.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}
.pv-acts {
  display: flex;
  gap: 4px;
  flex: none;
}
.pv-btn {
  font-size: var(--font-3xs);
  padding: 2px 7px;
  border-radius: 5px;
  border: 1px solid var(--border-default);
  background: transparent;
  color: inherit;
  opacity: 0.75;
  cursor: pointer;
}
.pv-btn:hover {
  opacity: 1;
}
.pv-x {
  padding: 2px 6px;
}
.pv-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pv-body > * {
  flex: 1;
  min-height: 0;
}
.pv-foot {
  flex: none;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 8px;
  border-top: 1px solid var(--border-default);
  font-size: var(--font-3xs);
  opacity: 0.7;
}
.pv-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
  direction: rtl;
  text-align: left;
}
.pv-flag {
  flex: none;
}
.pv-warn {
  color: var(--warning, #c77400);
  font-weight: 600;
}
.pv-btn-on {
  opacity: 1;
  border-color: var(--accent, #7b94f0);
  color: var(--accent, #7b94f0);
}
/* Sharing a border with the live half above; on its own it is just the panel. */
.pv-track {
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 45%;
  border-top: 1px solid var(--border-default);
}
.pv-track-full {
  flex: 1;
  max-height: none;
  border-top: none;
}
.pv-track-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  flex: none;
}
.pv-track-title {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.6;
  flex: 1;
  min-width: 0;
}
.pv-track-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.pv-track-note {
  padding: 8px;
  font-size: var(--font-3xs);
  opacity: 0.6;
}
.pv-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 3px 8px;
  border: none;
  background: transparent;
  color: inherit;
  font-size: var(--font-3xs);
  text-align: left;
  cursor: pointer;
}
.pv-row:hover:not(:disabled) {
  background: var(--accent-soft, rgba(123, 148, 240, 0.16));
}
.pv-row-dead {
  cursor: default;
  opacity: 0.55;
}
.pv-row-age {
  flex: none;
  width: 34px;
  opacity: 0.55;
  font-variant-numeric: tabular-nums;
}
.pv-row-mark {
  flex: none;
  width: 10px;
  font-weight: 700;
  text-align: center;
}
.pv-row-mark[data-change='created'] {
  color: var(--success-fg);
}
.pv-row-mark[data-change='modified'] {
  color: var(--warning-fg);
}
.pv-row-mark[data-change='deleted'] {
  color: var(--danger-fg);
}
.pv-row-mark[data-change='shown'] {
  color: var(--accent, #7b94f0);
}
.pv-row-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.pv-row-who {
  flex: none;
  opacity: 0.55;
  max-width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pv-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 20px;
  text-align: center;
}
.pv-empty-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  border: 1.5px dashed var(--border-default);
}
.pv-empty-title {
  font-size: var(--font-xs);
  font-weight: 600;
}
.pv-empty-hint {
  font-size: 10.5px;
  opacity: 0.65;
  line-height: 1.6;
}
</style>
