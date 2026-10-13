<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import DiffPane from './editor/DiffPane.vue'
import type { GitTransport } from '#git-feature'
import type { GitFileAccessPort } from './ports/gitSurface'
import type { BlameEntry, DiffBlameHunk, GitCommit } from './composables/useGit'

type FileDetailTarget =
  | { resource: { kind: 'file-diff'; filepath: string; staged: boolean; commit: string }; presentation: { mode: 'diff' } }
  | { resource: { kind: 'file-history'; filepath: string }; presentation: { mode: 'history' } }
  | { resource: { kind: 'file-blame'; filepath: string; staged: boolean; changedOnly: boolean }; presentation: { mode: 'blame' } }

const props = defineProps<{
  target: FileDetailTarget
  workspacePath: string
  gitTransport: GitTransport
  fileAccess: GitFileAccessPort
  fileLog: (filepath: string, limit?: number) => Promise<GitCommit[]>
  commitFileDiff: (commit: string, filepath: string) => Promise<DiffBlameHunk[]>
  blameFile: (filepath: string) => Promise<BlameEntry[]>
  diffBlame: (filepath: string, staged: boolean) => Promise<DiffBlameHunk[]>
}>()

const emit = defineEmits<{ (e: 'open-file', filepath: string): void }>()

const name = computed(() => props.target.resource.filepath.split('/').at(-1) ?? props.target.resource.filepath)
const loading = ref(false)
const history = ref<GitCommit[]>([])
const blame = ref<BlameEntry[]>([])
const blameHunks = ref<DiffBlameHunk[]>([])
const selectedCommit = ref('')
const selectedHunks = ref<DiffBlameHunk[]>([])
const closePrepared = ref(false)
const diffBusy = ref(false)
const diffPane = ref<{
  getCloseState: () => 'accepted' | 'refused' | 'busy'
  setClosePrepared: (prepared: boolean) => void
} | null>(null)
const localMode = ref<'diff' | 'history' | 'blame'>(props.target.presentation.mode)
const showDiff = computed(() => localMode.value === 'diff' && props.target.resource.kind === 'file-diff')
const diffStaged = computed(() => props.target.resource.kind === 'file-diff' ? props.target.resource.staged : false)
const diffCommit = computed(() => props.target.resource.kind === 'file-diff' ? props.target.resource.commit : '')
const blameChangedOnly = computed(() => props.target.resource.kind === 'file-blame' ? props.target.resource.changedOnly : false)
const blameStaged = computed(() => props.target.resource.kind === 'file-diff' || props.target.resource.kind === 'file-blame' ? props.target.resource.staged : false)

async function loadAuxiliary(): Promise<void> {
  const target = props.target
  const sequence = ++loadSequence
  loading.value = true
  history.value = []
  blame.value = []
  blameHunks.value = []
  selectedCommit.value = ''
  selectedHunks.value = []
  try {
    if (localMode.value === 'history') {
      const entries = await props.fileLog(target.resource.filepath, 50)
      if (sequence === loadSequence) history.value = entries
    } else if (localMode.value === 'blame') {
      if (blameChangedOnly.value) {
        const hunks = await props.diffBlame(target.resource.filepath, blameStaged.value)
        if (sequence === loadSequence) blameHunks.value = hunks
      } else {
        const entries = await props.blameFile(target.resource.filepath)
        if (sequence === loadSequence) blame.value = entries
      }
    }
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

let loadSequence = 0
watch(() => props.target, () => { localMode.value = props.target.presentation.mode; void loadAuxiliary() }, { immediate: true })
function setLocalMode(mode: 'diff' | 'history' | 'blame'): void {
  if (closePrepared.value || diffBusy.value || diffPane.value?.getCloseState() === 'busy') return
  localMode.value = mode
  void loadAuxiliary()
}

function getCloseState(): 'accepted' | 'refused' | 'busy' {
  if (closePrepared.value || diffBusy.value) return 'busy'
  return diffPane.value?.getCloseState() ?? 'accepted'
}

function setClosePrepared(prepared: boolean): void {
  closePrepared.value = prepared
  diffPane.value?.setClosePrepared(prepared)
}

defineExpose({ getCloseState, setClosePrepared })

async function selectCommit(commit: string): Promise<void> {
  if (closePrepared.value || diffBusy.value) return
  if (selectedCommit.value === commit) {
    selectedCommit.value = ''
    selectedHunks.value = []
    return
  }
  const sequence = ++loadSequence
  selectedCommit.value = commit
  selectedHunks.value = []
  loading.value = true
  try {
    const hunks = await props.commitFileDiff(commit, props.target.resource.filepath)
    if (sequence === loadSequence && selectedCommit.value === commit) selectedHunks.value = hunks
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}
</script>

<template>
  <section class="git-file-detail">
    <header class="detail-header">
      <span class="detail-path" v-truncate>{{ target.resource.filepath }}</span>
      <button v-if="target.resource.kind === 'file-diff'" class="detail-open" :disabled="closePrepared || diffBusy" @click="setLocalMode('diff')">Diff</button>
      <button v-if="target.resource.kind === 'file-diff'" class="detail-open" :disabled="closePrepared || diffBusy" @click="setLocalMode('history')">History</button>
      <button v-if="target.resource.kind === 'file-diff'" class="detail-open" :disabled="closePrepared || diffBusy" @click="setLocalMode('blame')">Blame</button>
      <button class="detail-open" @click="emit('open-file', target.resource.filepath)">Open in editor</button>
    </header>

    <DiffPane
      v-if="showDiff"
      ref="diffPane"
      :workspace-path="workspacePath"
      :filepath="target.resource.filepath"
      :staged="diffStaged"
      :name="name"
      :git-transport="gitTransport"
      :file-access="fileAccess"
      :commit="diffCommit || undefined"
      @open-file="emit('open-file', $event.filepath)"
      @close-state="diffBusy = $event === 'busy'"
    />

    <div v-else class="detail-scroll">
      <p v-if="loading" class="detail-message">Loading…</p>
      <template v-else-if="localMode === 'history'">
        <p v-if="!history.length" class="detail-message">No file history.</p>
        <button
          v-for="commit in history"
          :key="commit.hash"
          class="history-row"
          :class="{ selected: selectedCommit === commit.hash }"
          :disabled="closePrepared || diffBusy"
          @click="selectCommit(commit.hash)"
        >
          <code>{{ commit.short_hash }}</code><span>{{ commit.message }}</span>
        </button>
        <template v-for="(hunk, index) in selectedHunks" :key="index">
          <pre class="hunk-header">{{ hunk.header }}</pre>
          <pre v-for="(line, lineIndex) in hunk.lines" :key="lineIndex" class="diff-line">{{ line.kind === ' ' ? '' : line.kind }}{{ line.text }}</pre>
        </template>
      </template>
      <template v-else-if="blameChangedOnly">
        <p v-if="!blameHunks.length" class="detail-message">No changed lines.</p>
        <template v-for="(hunk, index) in blameHunks" :key="index">
          <pre class="hunk-header">{{ hunk.header }}</pre>
          <pre v-for="(line, lineIndex) in hunk.lines" :key="lineIndex" class="diff-line">{{ line.author }} {{ line.text }}</pre>
        </template>
      </template>
      <template v-else>
        <p v-if="!blame.length" class="detail-message">No blame information.</p>
        <pre v-for="(line, index) in blame" :key="index" class="diff-line">{{ line.short_hash }} {{ line.author }} {{ line.content }}</pre>
      </template>
    </div>
  </section>
</template>

<style scoped>
.git-file-detail { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.detail-header { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border-muted); }
.detail-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); color: var(--text-muted); }
.detail-open { border: 0; background: transparent; color: var(--accent-fg); cursor: pointer; }
.detail-scroll { flex: 1; overflow: auto; padding: 8px; font-family: var(--font-mono); font-size: var(--font-2xs); }
.detail-message { color: var(--text-muted); }
.history-row { display: flex; gap: 8px; width: 100%; border: 0; background: transparent; color: var(--text-primary); padding: 5px; text-align: left; cursor: pointer; }
.history-row.selected, .history-row:hover { background: var(--bg-hover-faint); }
.hunk-header, .diff-line { margin: 0; padding: 2px 6px; white-space: pre-wrap; word-break: break-all; }
.hunk-header { color: var(--accent-fg); }
</style>
