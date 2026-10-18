<script setup lang="ts">
// Plan B watchdog option C (contract 5.2): a third-party Navide plugin's
// backend went over a resource threshold. The backend keeps running until
// the user chooses Stop or Keep running; the notice stays here until then.
// The list is read from the Host when this mounts and whenever the Host says
// it changed, so a window that was still loading misses nothing.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatBytes } from '../lib/formatBytes'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'

const { t, locale } = useI18n()
const notices = ref<BackendResourceNoticeView[]>([])
const answering = ref(new Set<string>())
let stop: (() => void) | null = null

function api() {
  return window.agentTeam?.plugins?.nativeBackends
}

async function load(): Promise<void> {
  try {
    notices.value = (await api()?.resourceNotices?.()) ?? []
  } catch {
    // Keep what is shown; the next change reads again.
  }
}

async function answer(id: string, choice: 'terminate' | 'continue'): Promise<void> {
  answering.value = new Set([...answering.value, id])
  try {
    await api()?.answerResourceNotice?.(id, choice)
  } finally {
    const next = new Set(answering.value)
    next.delete(id)
    answering.value = next
    await load()
  }
}

function amount(item: BackendResourceNoticeView['item'], value: number): string {
  if (item === 'memory' || item === 'disk' || item === 'stdoutPending') return formatBytes(value)
  if (item === 'cpu') return t('backendResource.cores', { count: Number(value.toFixed(2)).toLocaleString(locale.value) })
  return String(value)
}

onMounted(() => {
  void load()
  stop = api()?.onResourceNoticesChanged?.(() => void load()) ?? null
})
onBeforeUnmount(() => {
  stop?.()
  stop = null
})
</script>

<template>
  <div v-if="notices.length" class="nv-resource-notices" role="region" :aria-label="$t('backendResource.title')">
    <article v-for="notice in notices" :key="notice.id" class="nv-resource-notice" role="status">
      <h4>{{ $t('backendResource.title') }}</h4>
      <p>
        {{ $t('backendResource.body', {
          name: reveal(notice.name), id: reveal(notice.pluginId), version: reveal(notice.packageVersion),
          item: $t(`backendResource.item.${notice.item}`),
          usage: amount(notice.item, notice.usage), threshold: amount(notice.item, notice.threshold),
        }) }}
      </p>
      <p class="nv-resource-note">{{ $t('backendResource.keepsRunning') }}</p>
      <p class="nv-resource-note">{{ $t('backendResource.again') }}</p>
      <div class="nv-resource-actions">
        <button type="button" class="nv-resource-stop nv-btn nv-btn--sm" :disabled="answering.has(notice.id)" @click="answer(notice.id, 'terminate')">
          {{ $t('backendResource.stop') }}
        </button>
        <button type="button" class="nv-resource-continue nv-btn nv-btn--sm" :disabled="answering.has(notice.id)" @click="answer(notice.id, 'continue')">
          {{ $t('backendResource.continue') }}
        </button>
      </div>
    </article>
  </div>
</template>

<style scoped>
.nv-resource-notices {
  position: fixed;
  right: var(--space-4);
  bottom: var(--space-4);
  z-index: 50;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 360px;
}
.nv-resource-notice {
  padding: var(--space-3);
  border: 1px solid var(--border-muted);
  border-left: 3px solid var(--attention-fg);
  border-radius: var(--radius-md);
  background: var(--bg-elevated, var(--bg-subtle));
  font-size: var(--font-xs);
}
.nv-resource-notice h4,
.nv-resource-notice p {
  margin: 0 0 var(--space-1);
}
.nv-resource-note {
  color: var(--text-secondary);
}
.nv-resource-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}
</style>
