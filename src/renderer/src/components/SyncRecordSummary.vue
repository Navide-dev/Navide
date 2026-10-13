<script setup lang="ts">
/**
 * One synced or imported record, shown whole: what a sync approval card and a
 * settings-bundle import preview both put in front of the user before it
 * lands. The backend builds the summary (sync_scopes); this renders it, with
 * every hidden character escaped (lib/syncVisible).
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { visible, visibleText } from '../lib/syncVisible'

interface SummaryFile {
  path: string
  size?: number
  sha256?: string
}

interface SummaryPreview {
  path: string
  preview?: string
  truncated?: boolean
  executable?: boolean
}

const props = defineProps<{ summary: Record<string, unknown> }>()
const { t } = useI18n()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function records<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter(isRecord).map((v) => v as unknown as T) : []
}

/** What an MCP record runs, whole: the transport and command, the args as a
 *  JSON array (so ["a b"] and ["a", "b"] look different), the url and cwd,
 *  and each header name. Env entries are rows of their own. */
const lines = computed(() => {
  const s = props.summary
  const out: string[] = []
  const transport = typeof s.transport === 'string' ? visible(s.transport) + ': ' : ''
  if (typeof s.command === 'string' && s.command) out.push(transport + visible(s.command))
  if (Array.isArray(s.args) && s.args.length) out.push(visible(JSON.stringify(s.args)))
  if (typeof s.url === 'string' && s.url) out.push(transport + visible(s.url))
  if (typeof s.cwd === 'string' && s.cwd) out.push(t('settings.sync.approval-cwd', { path: visible(s.cwd) }))
  const headers = isRecord(s.headers) ? Object.keys(s.headers) : []
  if (headers.length) out.push(t('settings.sync.approval-headers', { names: headers.map(visible).join(', ') }))
  return out
})

/** One row per env entry: NAME=value (secret-named values arrive masked). */
const env = computed(() =>
  isRecord(props.summary.env)
    ? Object.entries(props.summary.env).map(([k, v]) => visible(k) + '=' + visible(v))
    : [],
)

const files = computed(() => records<SummaryFile>(props.summary.files))
const previews = computed(() => records<SummaryPreview>(props.summary.previews))
const flags = computed(() =>
  Array.isArray(props.summary.frontmatterFlags) ? props.summary.frontmatterFlags.map(String) : [],
)

/** A skill whose files are unchanged but whose switch or CLIs would change. */
const decision = computed(() => {
  const s = props.summary
  const out: string[] = []
  if (s.deletes === true) {
    out.push(t('settings.sync.approval-deletes', { name: visible(s.name) }))
    if (typeof s.newLoopPrompt === 'string') out.push(t('settings.sync.approval-new-loop', { name: visible(s.newLoopPrompt) }))
    return out
  }
  if (!('previousEnabled' in s) && !('previousTargets' in s)) return []
  if (s.enabled === true && s.previousEnabled === false) out.push(t('settings.sync.approval-turn-on'))
  const show = (v: unknown) => (Array.isArray(v) ? v.map(visible).join(', ') : t('settings.sync.approval-all-clis'))
  if (JSON.stringify(s.targets) !== JSON.stringify(s.previousTargets)) {
    out.push(t('settings.sync.approval-targets', { to: show(s.targets), from: show(s.previousTargets) }))
  }
  return out
})

/** A unified diff, one line at a time, marked as added or removed. */
const diffLines = computed(() => {
  const diff = props.summary.diff
  if (typeof diff !== 'string' || !diff) return []
  return diff.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1).map((line) => ({
    text: visible(line),
    kind:
      line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : '',
  }))
})

/** Every field of a prompt record, as JSON values (so "true" and true differ). */
const fields = computed(() =>
  isRecord(props.summary.record)
    ? Object.entries(props.summary.record).map(([k, v]) => visible(k) + ': ' + visible(JSON.stringify(v)))
    : [],
)

const changes = computed(() =>
  records<{ field: string; from: unknown; to: unknown }>(props.summary.changes).map((c) =>
    t('settings.sync.approval-change', {
      field: visible(c.field),
      from: visible(JSON.stringify(c.from ?? null)),
      to: visible(JSON.stringify(c.to ?? null)),
    }),
  ),
)

function fileLine(f: SummaryFile): string {
  const parts = [visible(f.path)]
  if (typeof f.size === 'number') parts.push(t('settings.sync.approval-size', { bytes: f.size }))
  if (typeof f.sha256 === 'string') parts.push('sha256 ' + f.sha256.slice(0, 12))
  return parts.join(' · ')
}
</script>

<template>
  <div class="sync-record">
    <p v-for="(line, i) in decision" :key="'d:' + i" class="sync-note sync-result-error sync-approval-decision">
      {{ line }}
    </p>
    <code v-if="typeof summary.path === 'string'" class="sync-approval-line">{{ visible(summary.path) }}</code>
    <code v-for="(line, i) in lines" :key="i" class="sync-approval-line">{{ line }}</code>
    <ul v-if="fields.length" class="sync-approval-files">
      <li v-for="(row, i) in fields" :key="'f:' + i" class="sync-approval-field"><code>{{ row }}</code></li>
    </ul>
    <template v-if="changes.length">
      <span class="sync-hint">{{ t('settings.sync.approval-changes') }}</span>
      <ul class="sync-approval-files">
        <li v-for="(row, i) in changes" :key="'c:' + i" class="sync-approval-change"><code>{{ row }}</code></li>
      </ul>
    </template>
    <template v-if="diffLines.length">
      <span class="sync-hint">{{ t('settings.sync.approval-diff') }}</span>
      <pre class="sync-approval-preview sync-approval-diff"><span
        v-for="(line, i) in diffLines"
        :key="'d:' + i"
        :class="line.kind ? 'sync-diff-' + line.kind : ''"
        class="sync-diff-line"
      >{{ line.text }}</span></pre>
    </template>
    <template v-if="typeof summary.text === 'string'">
      <span class="sync-hint">{{ t('settings.sync.approval-text') }}</span>
      <pre class="sync-approval-preview sync-approval-text">{{ visibleText(summary.text) }}</pre>
    </template>
    <ul v-if="env.length" class="sync-approval-files">
      <li v-for="(row, i) in env" :key="'env:' + i" class="sync-approval-env">
        <code>{{ row }}</code>
      </li>
    </ul>
    <ul v-if="files.length" class="sync-approval-files">
      <li v-for="f in files" :key="f.path" class="sync-approval-file">
        <code>{{ fileLine(f) }}</code>
      </li>
    </ul>
    <template v-if="typeof summary.frontmatter === 'string' && summary.frontmatter">
      <span class="sync-hint">{{ t('settings.sync.approval-frontmatter') }}</span>
      <span v-for="flag in flags" :key="flag" class="sync-note sync-result-error sync-approval-flag">
        {{ t('settings.sync.approval-frontmatter-flag', { key: flag }) }}
      </span>
      <pre class="sync-approval-preview sync-approval-frontmatter">{{ visibleText(summary.frontmatter) }}</pre>
    </template>
    <template v-if="typeof summary.skillMd === 'string' && summary.skillMd">
      <span class="sync-hint">SKILL.md</span>
      <pre class="sync-approval-preview sync-approval-skillmd">{{ visibleText(summary.skillMd) }}</pre>
      <span v-if="summary.skillMdTruncated" class="sync-hint sync-approval-cut">{{ t('settings.sync.approval-cut') }}</span>
    </template>
    <template v-for="x in previews" :key="'p:' + x.path">
      <span class="sync-hint">{{
        x.executable ? t('settings.sync.approval-executable', { files: visible(x.path) }) : visible(x.path)
      }}</span>
      <pre class="sync-approval-preview sync-approval-script">{{ visibleText(x.preview) }}</pre>
      <span v-if="x.truncated" class="sync-hint sync-approval-cut">{{ t('settings.sync.approval-cut') }}</span>
    </template>
  </div>
</template>

<style scoped>
.sync-record {
  min-width: 0;
}
.sync-hint {
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  display: block;
  margin: 4px 0 0;
}
.sync-note {
  font-size: var(--font-row-desc);
  margin: 4px 0 0;
}
.sync-result-error {
  color: var(--text-danger, #e07060);
}
.sync-approval-flag {
  display: block;
}
.sync-approval-line {
  display: block;
  font-size: var(--font-row-desc);
  overflow-wrap: anywhere;
  padding: 1px 0;
}
.sync-approval-files {
  list-style: none;
  margin: 4px 0;
  padding: 0;
  font-size: var(--font-row-desc);
}
.sync-approval-file code,
.sync-approval-env code {
  overflow-wrap: anywhere;
}
.sync-diff-line {
  display: block;
}
.sync-diff-add {
  color: var(--text-success, #3fb950);
}
.sync-diff-del {
  color: var(--text-danger, #e07060);
}
.sync-approval-preview {
  max-height: 12em;
  overflow: auto;
  margin: 2px 0 6px;
  padding: 6px 8px;
  font-size: var(--font-row-desc);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
