<script lang="ts">
// The checkout a local pane works in, as one compact chip on its network row:
// `⎇ branch · N dirty · ↑a ↓b`. The backend attaches `git` only to this
// machine's own panes inside a repository, so a row without it renders nothing.
export interface PaneGit {
  branch: string | null
  worktreeRoot: string | null
  isLinkedWorktree: boolean | null
  dirty: number | null
  ahead: number | null
  behind: number | null
  /** When FETCH_HEAD was last written, ISO-8601 — null when never fetched. */
  fetchedAt: string | null
}

/** ahead/behind are only as fresh as the last fetch; past this, say so. */
export const STALE_AFTER_MS = 60 * 60 * 1000
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{ git: PaneGit; now?: number }>()
const { t } = useI18n()

const hasDrift = computed(() => props.git.ahead !== null && props.git.behind !== null)

const stale = computed(() => {
  if (!hasDrift.value) return false
  const at = props.git.fetchedAt ? Date.parse(props.git.fetchedAt) : Number.NaN
  // Never fetched counts as stale: the origin/main it compares against is
  // whatever the clone started with.
  if (!Number.isFinite(at)) return true
  return (props.now ?? Date.now()) - at > STALE_AFTER_MS
})

const title = computed(() => {
  const lines = [props.git.worktreeRoot ?? '']
  if (props.git.isLinkedWorktree) lines.push(t('settings.p2p.network.git-linked'))
  const at = props.git.fetchedAt ? Date.parse(props.git.fetchedAt) : Number.NaN
  lines.push(
    Number.isFinite(at)
      ? t('settings.p2p.network.git-fetched', { at: new Date(at).toLocaleString() })
      : t('settings.p2p.network.git-never-fetched')
  )
  return lines.filter(Boolean).join('\n')
})
</script>

<template>
  <span v-if="git.worktreeRoot" class="pane-git" v-truncate :class="{ stale }" :title="title">
    <span class="pg-branch">⎇ {{ git.branch ?? '?' }}</span>
    <span v-if="git.dirty" class="pg-dirty">· {{ t('settings.p2p.network.git-dirty', { count: git.dirty }) }}</span>
    <span v-if="hasDrift" class="pg-drift">· ↑{{ git.ahead }} ↓{{ git.behind }}</span>
    <span v-if="stale" class="pg-stale">· {{ t('settings.p2p.network.git-stale') }}</span>
  </span>
</template>

<style scoped>
.pane-git {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  display: inline-flex;
  gap: 4px;
}
.pg-dirty { color: var(--attention-fg); }
.pane-git.stale .pg-drift,
.pg-stale { opacity: 0.7; font-style: italic; }
</style>
