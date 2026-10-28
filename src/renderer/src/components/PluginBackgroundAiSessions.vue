<script setup lang="ts">
// The AI CLI sessions a third-party plugin keeps running after its window
// closed (D1 on #648: the Host stored them for resume, so they are not
// reclaimed). Disclosure, not a limit: each one is listed with an End button,
// and nothing ends unless the user asks. Renders nothing while there are none.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { TERMINAL_AI_CLI_PROFILES } from '../../../shared/aiCliProfiles'

interface BackgroundAiSession {
  sessionId: string
  profileId: string
  packageVersion: string
  since: number
}

// `paused` stops the polling while the plugin's page is not shown.
const props = withDefaults(defineProps<{ pluginId: string; pollMs?: number; paused?: boolean }>(), { pollMs: 5000, paused: false })
const { t, locale } = useI18n()

const sessions = ref<BackgroundAiSession[]>([])
const ending = ref(new Set<string>())
const error = ref('')
let timer: ReturnType<typeof setInterval> | null = null

function api() {
  return window.agentTeam?.plugins
}

async function load(): Promise<void> {
  try {
    sessions.value = (await api()?.backgroundAiSessions?.(props.pluginId)) ?? []
  } catch {
    // Advisory: the list is read again on the next poll.
  }
}

async function end(sessionId: string): Promise<void> {
  ending.value = new Set(ending.value).add(sessionId)
  error.value = ''
  try {
    const answer = await api()?.endBackgroundAiSession?.(props.pluginId, sessionId)
    if (!answer?.ok) error.value = t('settings.extensions.backgroundAi.gone')
  } catch (err) {
    error.value = t('settings.extensions.backgroundAi.endFailed', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    const next = new Set(ending.value)
    next.delete(sessionId)
    ending.value = next
    await load()
  }
}

function profileLabel(profileId: string): string {
  return Object.hasOwn(TERMINAL_AI_CLI_PROFILES, profileId)
    ? TERMINAL_AI_CLI_PROFILES[profileId as keyof typeof TERMINAL_AI_CLI_PROFILES].label
    : profileId
}

function startPolling(): void {
  if (timer || props.paused) return
  void load()
  timer = setInterval(() => void load(), props.pollMs)
}

function stopPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

watch(() => props.paused, (paused) => { if (paused) stopPolling(); else startPolling() })
onMounted(startPolling)
onBeforeUnmount(stopPolling)
</script>

<template>
  <div v-if="sessions.length > 0 || error" class="ext-background-ai" role="status">
    <template v-if="sessions.length > 0">
      <p class="ext-background-ai-title">{{ t('settings.extensions.backgroundAi.title', { count: sessions.length }) }}</p>
      <p class="ext-background-ai-note">{{ t('settings.extensions.backgroundAi.note') }}</p>
      <ul class="ext-background-ai-list">
        <li v-for="session in sessions" :key="session.sessionId" class="ext-background-ai-item">
          <span class="ext-background-ai-desc">{{ t('settings.extensions.backgroundAi.item', {
            profile: profileLabel(session.profileId),
            version: session.packageVersion,
            time: new Date(session.since).toLocaleString(locale),
          }) }}</span>
          <button
            type="button"
            class="ext-background-ai-end nv-btn nv-btn--sm ext-btn-danger"
            :disabled="ending.has(session.sessionId)"
            @click="end(session.sessionId)"
          >
            {{ t('settings.extensions.backgroundAi.end') }}
          </button>
        </li>
      </ul>
    </template>
    <p v-if="error" class="ext-background-ai-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.ext-background-ai {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--nv-border, rgba(128, 128, 128, 0.3));
  border-radius: 6px;
}
.ext-background-ai-title {
  margin: 0;
  font-weight: 600;
}
.ext-background-ai-note,
.ext-background-ai-error {
  margin: 4px 0 0;
  font-size: 12px;
  opacity: 0.85;
}
.ext-background-ai-list {
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
.ext-background-ai-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 0;
}
.ext-background-ai-desc {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
