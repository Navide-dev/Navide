<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from 'vue'
import { createPluginViewRuntimeClient, type JsonValue, type PluginDetailCloseDecision, type PluginDetailCloseRequest } from '@navide/plugin-sdk'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import BranchDiffPane from './editor/BranchDiffPane.vue'
import ReviewPane from './components/ReviewPane.vue'
import ConflictPane from './editor/ConflictPane.vue'
import GitFileDetailPane from './GitFileDetailPane.vue'
import { useGit } from './composables/useGit'
import { GIT_BRANCH_DIFF_KEY, GIT_FILE_ACCESS_KEY, GIT_TRANSPORT_KEY, GIT_UI_KEY } from './ports/gitSurface'

type DetailTarget =
  | { resource: { kind: 'branch-comparison'; repository: string; base: string; compare: string }; presentation: { mode: 'branch-diff' } }
  | { resource: { kind: 'file-diff'; repository: string; filepath: string; staged: boolean; commit: string }; presentation: { mode: 'diff' } }
  | { resource: { kind: 'file-history'; repository: string; filepath: string }; presentation: { mode: 'history' } }
  | { resource: { kind: 'file-blame'; repository: string; filepath: string; staged: boolean; changedOnly: boolean }; presentation: { mode: 'blame' } }
  | { resource: { kind: 'merge-conflict'; repository: string; filepath: string }; presentation: { mode: 'conflict' } }

type RecordValue = Record<string, JsonValue>
function record(value: JsonValue): value is RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exact(value: RecordValue, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && actual.every((key) => keys.includes(key)) }
function safePath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..') }
function safeRepository(value: unknown): value is string { return value === '.' || safePath(value) }
function parseTarget(value: JsonValue): DetailTarget | null {
  if (!record(value) || !exact(value, ['resource', 'presentation']) || !record(value.resource) || !record(value.presentation)) return null
  const r = value.resource; const p = value.presentation
  if (!safeRepository(r.repository) || typeof r.kind !== 'string' || typeof p.mode !== 'string') return null
  if (r.kind === 'branch-comparison' && p.mode === 'branch-diff' && exact(r, ['kind', 'repository', 'base', 'compare']) && exact(p, ['mode']) && typeof r.base === 'string' && r.base.length > 0 && typeof r.compare === 'string') return { resource: { kind: r.kind, repository: r.repository, base: r.base, compare: r.compare }, presentation: { mode: p.mode } }
  if (r.kind === 'file-diff' && p.mode === 'diff' && exact(r, ['kind', 'repository', 'filepath', 'staged', 'commit']) && exact(p, ['mode']) && safePath(r.filepath) && typeof r.staged === 'boolean' && typeof r.commit === 'string') return { resource: { kind: r.kind, repository: r.repository, filepath: r.filepath, staged: r.staged, commit: r.commit }, presentation: { mode: p.mode } }
  if (r.kind === 'file-history' && p.mode === 'history' && exact(r, ['kind', 'repository', 'filepath']) && exact(p, ['mode']) && safePath(r.filepath)) return { resource: { kind: r.kind, repository: r.repository, filepath: r.filepath }, presentation: { mode: p.mode } }
  if (r.kind === 'file-blame' && p.mode === 'blame' && exact(r, ['kind', 'repository', 'filepath', 'staged', 'changedOnly']) && exact(p, ['mode']) && safePath(r.filepath) && typeof r.staged === 'boolean' && typeof r.changedOnly === 'boolean') return { resource: { kind: r.kind, repository: r.repository, filepath: r.filepath, staged: r.staged, changedOnly: r.changedOnly }, presentation: { mode: p.mode } }
  if (r.kind === 'merge-conflict' && p.mode === 'conflict' && exact(r, ['kind', 'repository', 'filepath']) && exact(p, ['mode']) && safePath(r.filepath)) return { resource: { kind: r.kind, repository: r.repository, filepath: r.filepath }, presentation: { mode: p.mode } }
  return null
}
function isFileTarget(target: DetailTarget | null): target is Exclude<DetailTarget, { resource: { kind: 'branch-comparison' } } | { resource: { kind: 'merge-conflict' } }> { return target?.resource.kind === 'file-diff' || target?.resource.kind === 'file-history' || target?.resource.kind === 'file-blame' }
function isSameResource(current: DetailTarget, next: DetailTarget): boolean {
  if (current.resource.kind !== next.resource.kind || current.resource.repository !== next.resource.repository) return false
  switch (current.resource.kind) {
    case 'branch-comparison': return next.resource.kind === current.resource.kind && current.resource.base === next.resource.base && current.resource.compare === next.resource.compare
    case 'file-diff': return next.resource.kind === current.resource.kind && current.resource.filepath === next.resource.filepath && current.resource.staged === next.resource.staged && current.resource.commit === next.resource.commit
    case 'file-history': return next.resource.kind === current.resource.kind && current.resource.filepath === next.resource.filepath
    case 'file-blame': return next.resource.kind === current.resource.kind && current.resource.filepath === next.resource.filepath && current.resource.staged === next.resource.staged && current.resource.changedOnly === next.resource.changedOnly
    case 'merge-conflict': return next.resource.kind === current.resource.kind && current.resource.filepath === next.resource.filepath
  }
}

const workspacePath = new URLSearchParams(window.location.search).get('workspace_path') ?? ''
function resolveRepository(repository: string): string { return repository === '.' ? workspacePath : `${workspacePath.replace(/\/+$/, '')}/${repository}` }
const gitTransport = inject(GIT_TRANSPORT_KEY); const branchDiff = inject(GIT_BRANCH_DIFF_KEY); const fileAccess = inject(GIT_FILE_ACCESS_KEY); const ui = inject(GIT_UI_KEY)
if (!gitTransport || !branchDiff || !fileAccess || !ui) {
  // Say which port is missing before throwing: a blank detail pane with no
  // message is impossible to diagnose from the outside.
  const missing = [
    !gitTransport ? 'gitTransport' : '',
    !branchDiff ? 'branchDiff' : '',
    !fileAccess ? 'fileAccess' : '',
    !ui ? 'ui' : '',
  ].filter(Boolean).join(', ')
  console.error(`[navide.git] detail ports missing: ${missing}`)
  throw new Error(`Git detail ports were not provided by the composition root: ${missing}`)
}
const gitUi = ui
const target = ref<DetailTarget | null>(null)
const targetRevision = ref<number | null>(null)
const detailWorkspacePath = computed(() => target.value ? resolveRepository(target.value.resource.repository) : workspacePath)
const { gitBranches, gitStatus, fileLog, commitFileDiff, blameFile, diffBlame, listConflicts } = useGit(() => detailWorkspacePath.value, gitTransport)
const notify = useNotify()
const fileTarget = computed(() => isFileTarget(target.value) ? target.value : null)
const conflictPane = ref<{
  getCloseState: () => 'accepted' | 'refused' | 'busy'
  setClosePrepared: (prepared: boolean) => void
} | null>(null)
const closePrepared = ref(false)
const filePane = ref<{
  getCloseState: () => 'accepted' | 'refused' | 'busy'
  setClosePrepared: (prepared: boolean) => void
} | null>(null)
const conflictLive = ref(false)
let conflictSequence = 0
watch(target, (next) => {
  if (!next || next.resource.kind !== 'merge-conflict') { conflictLive.value = false; return }
  const filepath = next.resource.filepath
  const sequence = conflictSequence
  void listConflicts().then((result) => { if (sequence === conflictSequence) conflictLive.value = result.ok && result.conflicts.some((entry) => entry.path === filepath) }).catch(() => { if (sequence === conflictSequence) conflictLive.value = false })
}, { immediate: true })
async function openInEditor(filepath: string): Promise<void> {
  try {
    const outcome = await gitUi.openInEditor({ workspacePath: detailWorkspacePath.value, filepath })
    if (!outcome.opened) notify.toast(outcome.error || i18n.global.t('git.editor-open-failed'), { type: 'error' })
  } catch (error) {
    notify.toast(error instanceof Error ? error.message : i18n.global.t('git.editor-open-failed'), { type: 'error' })
  }
}
const viewRuntime = createPluginViewRuntimeClient()
const targetSubscription = viewRuntime.onDetailTarget((update) => {
  if (closePrepared.value) return { applied: false, reason: 'busy' } as const
  const next = parseTarget(update.target)
  if (!next || (target.value && !isSameResource(target.value, next))) return { applied: false, reason: 'refused' } as const
  if (target.value?.resource.kind === 'merge-conflict') {
    const state = conflictPane.value?.getCloseState() ?? 'busy'
    if (state !== 'accepted') return { applied: false, reason: state } as const
  }
  target.value = next
  targetRevision.value = update.revision
  conflictSequence += 1
  return { applied: true } as const
})
const closeSubscription = viewRuntime.onPrepareClose((_request: PluginDetailCloseRequest): PluginDetailCloseDecision => {
  if (closePrepared.value) return { accepted: false, reason: 'busy' }
  const state = target.value?.resource.kind === 'merge-conflict'
    ? conflictPane.value?.getCloseState() ?? 'busy'
    : filePane.value?.getCloseState() ?? 'accepted'
  if (state !== 'accepted') return { accepted: false, reason: state }
  closePrepared.value = true
  conflictPane.value?.setClosePrepared(true)
  filePane.value?.setClosePrepared(true)
  return { accepted: true, reason: 'accepted' }
})
const closeCancelledSubscription = viewRuntime.onCloseCancelled(() => {
  closePrepared.value = false
  conflictPane.value?.setClosePrepared(false)
  filePane.value?.setClosePrepared(false)
})
onUnmounted(() => {
  targetSubscription.dispose()
  closeSubscription.dispose()
  closeCancelledSubscription.dispose()
})
</script>

<template>
  <main class="git-detail-root">
    <BranchDiffPane v-if="target?.resource.kind === 'branch-comparison'" :workspace-path="detailWorkspacePath" :base="target.resource.base" :compare="target.resource.compare" :git-transport="gitTransport" :branch-diff="branchDiff" :git-status="gitStatus" :git-branches="gitBranches" @open-file="(p) => openInEditor(p.filepath)">
      <template #review="{ workspacePath: reviewWorkspacePath, gitStatus: reviewGitStatus, gitBranches: reviewGitBranches, close, openFile: reviewOpenFile }">
        <ReviewPane :workspace-path="reviewWorkspacePath" :git-status="reviewGitStatus" :git-branches="reviewGitBranches" :hide-header="true" @close="close" @open-file="reviewOpenFile" />
      </template>
    </BranchDiffPane>
    <GitFileDetailPane v-else-if="fileTarget" ref="filePane" :target="fileTarget" :workspace-path="detailWorkspacePath" :git-transport="gitTransport" :file-access="fileAccess" :file-log="fileLog" :commit-file-diff="commitFileDiff" :blame-file="blameFile" :diff-blame="diffBlame" @open-file="openInEditor" />
    <ConflictPane v-else-if="target?.resource.kind === 'merge-conflict'" ref="conflictPane" :workspace-path="detailWorkspacePath" :filepath="target.resource.filepath" :name="target.resource.filepath.split('/').at(-1) ?? target.resource.filepath" :git-transport="gitTransport" :file-access="fileAccess" :merge-aborted="!conflictLive" />
    <p v-else class="git-detail-unavailable">{{ i18n.global.t('git.detail-unavailable') }}</p>
  </main>
</template>

<style scoped>.git-detail-root { width: 100%; height: 100%; overflow: hidden; background: var(--bg-base); color: var(--text-primary); }.git-detail-unavailable { margin: 0; padding: 24px; color: var(--text-muted); }</style>
