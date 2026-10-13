<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { defineAsyncComponent } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { Issue, IssueDetail, IssueProvider, IssueHandlerMode } from '../composables/useIssues'
import { useRepoDiscovery, type DiscoveredRepoWithBadge } from '../composables/useRepoDiscovery'
import type { GitSurfacePorts } from '../ports/gitSurface'
import type { useBackend } from '../composables/useBackend'
import { useI18n } from 'vue-i18n'

const GitPane = defineAsyncComponent(() => import('./GitPane.vue'))

const props = defineProps<{
  workspacePath: string
  analyzerModel?: string
  backend: ReturnType<typeof useBackend>
  embedded?: boolean
  dispatchTargets?: { id: string; label: string }[]
  availableAgents?: { key: string; label: string }[]
  issueHandoffs?: Record<string, { paneId: string; mode: string; state: string }>
  /** Callers inject their already-authenticated transport and UI ports. */
  surfacePorts: GitSurfacePorts
  /** Optional composition seam for an already-owned repository discovery source. */
  repositorySource?: { readonly value: DiscoveredRepoWithBadge[] }
}>()

const emit = defineEmits<{
  (e: 'changes-count', n: number): void
  (e: 'open-workspace', path: string): void
  (e: 'open-file', payload: { workspace_path: string; filepath: string; name: string }): void
  (e: 'open-conflict', payload: { workspace_path: string; filepath: string; name: string }): void
  (e: 'open-diff', payload: { workspace_path: string; filepath: string; staged: boolean; name: string; commit?: string }): void
  (e: 'open-branch-diff', payload: { workspace_path: string; base: string; compare: string }): void
  (e: 'dispatch-issue', payload: { paneId: string; issue: IssueDetail }): void
  (e: 'spawn-for-issue', payload: { agentKey: string; mode: IssueHandlerMode; issue: Issue; provider: IssueProvider }): void
  (e: 'focus-pane', paneId: string): void
  (e: 'open-git-accounts'): void
}>()

const { t } = useI18n()

const gitTransport = props.surfacePorts.gitTransport
const surfacePorts = props.surfacePorts
// `adopt` takes over the list GitPane's "scan anyway" button already fetched.
// Re-running refresh(true) here would walk the same cloud-synced tree a second
// time (minutes per walk), so the child's result is adopted instead.
const discovery = useRepoDiscovery(() => props.workspacePath, gitTransport)
const repositories = props.repositorySource ?? discovery.repositories
const { adopt } = discovery

// When root is not a git repo, inject it as the first tab so init/connect features remain accessible.
const allTabs = computed(() => {
  const repos = repositories.value
  const rootIncluded = repos.some((r) => r.rel_path === '.')
  if (rootIncluded || !props.workspacePath) return repos
  return [
    { rel_path: '.', abs_path: props.workspacePath, branch: '', badge: { branch: '', dirtyCount: 0 } },
    ...repos,
  ]
})

// Multi-repo mode when >=2 repos discovered.
const isMulti = computed(() => allTabs.value.length >= 2)

// --- Single-repo mode: forward changes-count directly ---
const singleChangesCount = ref(0)
watch(singleChangesCount, (n) => {
  if (!isMulti.value) emit('changes-count', n)
})

// --- Multi-repo mode ---
// The selected repo tab persists per workspace on the backend project
// (project.json ui_git_tab_repo, via project.set_ui_state). The legacy
// per-workspace localStorage key is migrated once (legacy copy deleted only
// after the backend ack, so a failed push retries on the next load).
const LEGACY_STORAGE_PREFIX = 'agentTeam.gitTabRepo.'

// Active tab: abs_path of the selected repo.
const activeRepo = ref<string>('')

// Saved selection restored from the backend (or the legacy localStorage copy).
const savedRepo = ref<string>('')
// Once the user picks a tab, a late-arriving restore must not override it.
let userSelected = false

async function restoreSavedRepo(ws: string): Promise<void> {
  if (!ws) return
  const legacyKey = LEGACY_STORAGE_PREFIX + ws
  let legacy: string | null = null
  try { legacy = localStorage.getItem(legacyKey) } catch { legacy = null }
  let backendSaved = ''
  try {
    const resp = await props.backend.send<{ project?: { ui_git_tab_repo?: string } | null }>(
      'project.peek', { workspace_path: ws },
    )
    const v = resp.payload?.project?.ui_git_tab_repo
    if (typeof v === 'string') backendSaved = v
  } catch { /* backend unavailable — fall back to the legacy copy below */ }
  if (ws !== props.workspacePath) return // workspace switched mid-flight
  if (backendSaved) {
    // Backend already owns the value — clear any leftover legacy copy.
    if (legacy !== null) { try { localStorage.removeItem(legacyKey) } catch { /* ignore */ } }
    savedRepo.value = backendSaved
  } else if (legacy) {
    savedRepo.value = legacy
    void props.backend.send<{ ok: boolean }>('project.set_ui_state', {
      workspace_path: ws,
      git_tab_repo: legacy,
    }).then((resp) => {
      if (resp.ok && resp.payload?.ok) {
        try { localStorage.removeItem(legacyKey) } catch { /* ignore */ }
      }
    }).catch(() => { /* keep the legacy copy — retried next load */ })
  }
}

watch(
  () => props.workspacePath,
  (ws) => {
    userSelected = false
    savedRepo.value = ''
    void restoreSavedRepo(ws)
  },
  { immediate: true },
)

// Track which tabs have been mounted at least once (lazy-mount).
const mounted = ref<Set<string>>(new Set())

// Per-repo changes count (keyed by abs_path).
const repoChangesCounts = ref<Record<string, number>>({})

const totalChangesCount = computed(() =>
  Object.values(repoChangesCounts.value).reduce((s, n) => s + n, 0),
)

watch(totalChangesCount, (n) => {
  if (isMulti.value) emit('changes-count', n)
})

// Prune per-repo bookkeeping when a tab leaves (workspace switch, repo removed,
// or a commit drops it from discovery). Without this, a departed repo's last
// non-zero count lingers in repoChangesCounts and totalChangesCount keeps
// summing a repo that no longer exists — a stale sidebar badge.
watch(allTabs, (tabs) => {
  const live = new Set(tabs.map((r) => r.abs_path))
  for (const key of Object.keys(repoChangesCounts.value)) {
    if (!live.has(key)) delete repoChangesCounts.value[key]
  }
  for (const key of [...mounted.value]) {
    if (!live.has(key)) mounted.value.delete(key)
  }
})

// On a mode flip (repo count crossing 2), re-emit the active mode's count. The
// totalChangesCount / singleChangesCount watchers only fire on value change, so
// a flip where the value happens to match would otherwise freeze the sidebar
// badge on the previous mode's number.
watch(isMulti, (multi) => {
  emit('changes-count', multi ? totalChangesCount.value : singleChangesCount.value)
})

// When the tab list or the restored selection changes, ensure activeRepo is valid.
watch(
  [allTabs, savedRepo],
  ([tabs, saved]) => {
    if (tabs.length === 0) return

    const validSaved = !userSelected && saved && tabs.some((r) => r.abs_path === saved)
    if (validSaved) {
      activeRepo.value = saved
    } else if (!tabs.some((r) => r.abs_path === activeRepo.value)) {
      activeRepo.value = tabs[0].abs_path
    }

    // Ensure active tab is mounted.
    if (activeRepo.value) mounted.value.add(activeRepo.value)
  },
  { immediate: true },
)

function selectTab(absPath: string): void {
  userSelected = true
  activeRepo.value = absPath
  mounted.value.add(absPath)
  if (!props.workspacePath) return
  void props.backend.send('project.set_ui_state', {
    workspace_path: props.workspacePath,
    git_tab_repo: absPath,
  }).catch(() => { /* best-effort persistence */ })
}

function repoLabel(relPath: string): string {
  if (relPath === '.') return t('label.git-repo-root')
  // Use the last path segment as the short name.
  return relPath.split('/').filter(Boolean).pop() ?? relPath
}
</script>

<template>
  <!-- Single-repo (or 0 repo): transparent passthrough to GitPane -->
  <GitPane
    v-if="!isMulti"
    :workspace-path="workspacePath"
    :analyzer-model="analyzerModel"
    :git-transport="gitTransport"
    :file-access="surfacePorts.fileAccess"
    :ui="surfacePorts.paneUi"
    :issue-port="surfacePorts.issues"
    :credentials="surfacePorts.credentials"
    :accounts="surfacePorts.accounts"
    :embedded="embedded"
    :dispatch-targets="dispatchTargets"
    :available-agents="availableAgents"
    :issue-handoffs="issueHandoffs"
    @changes-count="singleChangesCount = $event; $emit('changes-count', $event)"
    @open-workspace="$emit('open-workspace', $event)"
    @open-file="$emit('open-file', { ...$event, workspace_path: workspacePath })"
    @open-conflict="$emit('open-conflict', { ...$event, workspace_path: workspacePath })"
    @open-diff="$emit('open-diff', { ...$event, workspace_path: workspacePath })"
    @open-branch-diff="$emit('open-branch-diff', { ...$event, workspace_path: workspacePath })"
    @dispatch-issue="$emit('dispatch-issue', $event)"
    @spawn-for-issue="$emit('spawn-for-issue', $event)"
    @focus-pane="$emit('focus-pane', $event)"
    @open-git-accounts="$emit('open-git-accounts')"
    @force-discovered="void adopt($event)"
  />


  <!-- Multi-repo: tab bar + active GitPane -->
  <div v-else class="multi-repo-root">
    <!-- Tab bar -->
    <div class="repo-tab-bar">
      <button
        v-for="repo in allTabs"
        :key="repo.abs_path"
        :class="['repo-tab', { active: activeRepo === repo.abs_path }]"
        :title="repo.abs_path"
        @click="selectTab(repo.abs_path)"
      >
        <span class="repo-tab-name">{{ repoLabel(repo.rel_path) }}</span>
        <span v-if="repo.badge.branch || repo.badge.dirtyCount > 0 || repo.badge.error" class="repo-tab-row2">
          <span v-if="repo.badge.branch" class="repo-tab-branch" v-truncate>
            <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" style="flex-shrink:0;opacity:0.7">
              <path d="M11.75 2.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 2.728a2.25 2.25 0 1 1 0-4.456 2.25 2.25 0 0 1 0 4.456zM2.75 13.5a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0zm.75 2.25a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5zM3.5 7.25A2.25 2.25 0 0 1 5.728 5h4.544a2.25 2.25 0 0 1 2.228 1.952V9.5a.75.75 0 0 1-1.5 0V6.952A.75.75 0 0 0 10.272 6.5H5.728a.75.75 0 0 0-.728.75V9.5a.75.75 0 0 1-1.5 0V7.25z"/>
            </svg>
            {{ repo.badge.branch }}
          </span>
          <span v-if="repo.badge.dirtyCount > 0" class="repo-tab-badge">
            {{ repo.badge.dirtyCount > 99 ? '99+' : repo.badge.dirtyCount }}
          </span>
          <span v-else-if="repo.badge.error" class="repo-tab-badge repo-tab-badge-error" :title="repo.badge.error">!</span>
        </span>
      </button>
    </div>

    <!-- One GitPane per repo; lazy-mount on first visit, v-show after -->
    <div class="repo-pane-area">
      <template v-for="repo in allTabs" :key="repo.abs_path">
        <GitPane
          v-if="mounted.has(repo.abs_path)"
          v-show="activeRepo === repo.abs_path"
          :workspace-path="repo.abs_path"
          :analyzer-model="analyzerModel"
          :git-transport="gitTransport"
          :file-access="surfacePorts.fileAccess"
          :ui="surfacePorts.paneUi"
          :issue-port="surfacePorts.issues"
          :credentials="surfacePorts.credentials"
          :accounts="surfacePorts.accounts"
          :embedded="embedded"
          :dispatch-targets="dispatchTargets"
          :available-agents="availableAgents"
          :hide-discovered-repos="true"
          :issue-handoffs="issueHandoffs"
          @changes-count="repoChangesCounts[repo.abs_path] = $event"
          @open-workspace="$emit('open-workspace', $event)"
          @open-file="$emit('open-file', { ...$event, workspace_path: repo.abs_path })"
          @open-conflict="$emit('open-conflict', { ...$event, workspace_path: repo.abs_path })"
          @open-diff="$emit('open-diff', { ...$event, workspace_path: repo.abs_path })"
          @open-branch-diff="$emit('open-branch-diff', { ...$event, workspace_path: repo.abs_path })"
          @dispatch-issue="$emit('dispatch-issue', $event)"
          @spawn-for-issue="$emit('spawn-for-issue', $event)"
          @focus-pane="$emit('focus-pane', $event)"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.multi-repo-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* ── Tab bar ─────────────────────────────────────────── */
.repo-tab-bar {
  display: flex;
  align-items: stretch;
  gap: 1px;
  padding: 6px 8px 0;
  border-bottom: 1px solid var(--border-muted);
  overflow-x: auto;
  scrollbar-width: none;
  flex-shrink: 0;
  background: var(--bg-base);
}
.repo-tab-bar::-webkit-scrollbar { display: none; }

.repo-tab {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: flex-start;
  gap: 2px;
  padding: 5px 11px 6px;
  height: 42px;
  box-sizing: border-box;
  background: var(--bg-elevated);
  border: 1px solid var(--border-muted);
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.12s, background 0.12s, border-color 0.12s;
  margin-bottom: -1px;
  position: relative;
}
.repo-tab:hover {
  color: var(--text-primary);
  background: var(--bg-muted);
}
.repo-tab.active {
  color: var(--text-bright);
  background: var(--bg-base);
  border-color: var(--border-muted);
  border-bottom-color: var(--bg-base);
  z-index: 1;
}

.repo-tab-name {
  font-size: var(--font-xs);
  font-weight: 600;
  letter-spacing: 0.01em;
  line-height: 1.2;
}

/* Second row: branch left, badge right — both inline */
.repo-tab-row2 {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
}

.repo-tab-branch {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: var(--font-3xs);
  color: var(--text-muted);
  opacity: 0.85;
  line-height: 1;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.repo-tab.active .repo-tab-branch {
  opacity: 1;
  color: var(--text-secondary);
}

.repo-tab-badge {
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--attention-fg);
  color: var(--bg-base);
  font-size: 9px;
  font-weight: 700;
  border-radius: 999px;
  line-height: 1;
  flex-shrink: 0;
}
.repo-tab-badge-error {
  background: var(--danger-fg);
}

/* ── Pane area ───────────────────────────────────────── */
.repo-pane-area {
  flex: 1;
  overflow: hidden;
  position: relative;
}
.repo-pane-area > * {
  position: absolute;
  inset: 0;
}
</style>
