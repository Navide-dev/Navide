<script setup lang="ts">
import { computed, inject, watch } from 'vue'
import { i18n, vTruncate } from '@navide/plugin-ui/foundation'
import { agentConsoleKey, type AgentConsole } from '../../composables/useAgentConsole'
import { channelsKey, DEFAULT_ACCOUNT, type ChannelsStore } from '../../composables/useChannels'
import { formatChannelIdentity } from '../../lib/channelIdentity'
import { describeSchedule, formatClock } from '../../lib/schedulerJobs'
import { paneStatusLabelText } from '../../lib/paneStatusLabel'
import { revealPath } from '../../composables/hostShell'

/**
 * The agent pane's control panel (plan agent-0-2-40_78e071, figure 1 ⑤⑥):
 * status, channel, schedules, memory and todos, with wake / pause schedules /
 * agent settings. Read-only summaries; a section with no source says so
 * instead of showing a made-up value. Memory and todos come from
 * `agent.notes`, read when the panel opens and after each finished turn.
 */
const props = defineProps<{
  paneId: string
  paneName: string
  /** Vendor key (hermes, openclaw): whose memory the panel reads. */
  agentKey?: string
  displayStatus: string
  collapsed: boolean
  /** Test seams; the app provides both stores. */
  console?: AgentConsole
  channels?: ChannelsStore
}>()
const emit = defineEmits<{ (e: 'toggle'): void }>()

const t = i18n.global.t
const agents = props.console ?? inject(agentConsoleKey, null)
const channels = props.channels ?? inject(channelsKey, null)

const statusText = computed(() => paneStatusLabelText(props.displayStatus as never))

const binding = computed(() => channels?.bindingFor(props.paneId) ?? null)
const channelText = computed(() => {
  const b = binding.value
  if (!b) return ''
  return formatChannelIdentity(b, { t, state: channels?.accountState(b.platform, b.account || DEFAULT_ACCOUNT) }, 'short')
})

const jobs = computed(() => agents?.jobsFor(props.paneId, props.paneName) ?? [])
const next = computed(() => agents?.nextJob(props.paneId, props.paneName) ?? null)
const anyEnabled = computed(() => jobs.value.some((j) => j.enabled))

function jobWhen(job: (typeof jobs.value)[number]): string {
  const at = job.state?.next_run_at
  return typeof at === 'number' ? formatClock(at) : describeSchedule(job.schedule, t, job.state)
}

const identity = computed(() => agents?.identityForPane(props.paneId) ?? null)

const notes = computed(() => (props.agentKey ? agents?.notesFor(props.agentKey) ?? null : null))
const memory = computed(() => notes.value?.memory ?? null)
const todos = computed(() => notes.value?.todos ?? null)
watch(
  () => [props.agentKey, props.collapsed] as const,
  ([key, collapsed]) => { if (key && !collapsed) void agents?.refreshNotes(key) },
  { immediate: true },
)

function sectionEmptyText(status: string | undefined, kind: 'memory' | 'todos'): string {
  if (status === undefined) return t('agentPane.panel.memory-loading')
  if (status === 'unsupported') return t(kind === 'memory' ? 'agentPane.panel.memory-empty' : 'agentPane.panel.todos-empty')
  if (status === 'missing') return t('agentPane.panel.memory-missing')
  return kind === 'memory' ? t('agentPane.panel.memory-none') : t('agentPane.panel.todos-empty')
}
</script>

<template>
  <aside
    class="agent-panel"
    :class="{ collapsed }"
    data-testid="agent-control-panel"
    @mousedown.stop
  >
    <button
      class="ap-toggle"
      type="button"
      :title="collapsed ? t('agentPane.panel.expand') : t('agentPane.panel.collapse')"
      :aria-label="collapsed ? t('agentPane.panel.expand') : t('agentPane.panel.collapse')"
      :aria-expanded="collapsed ? 'false' : 'true'"
      data-testid="agent-panel-toggle"
      @click.stop="emit('toggle')"
    >{{ collapsed ? '‹' : '›' }}</button>
    <template v-if="!collapsed">
      <div class="ap-title">{{ t('agentPane.panel.title') }}</div>

      <section class="ap-sec">
        <div class="ap-label">{{ t('agentPane.panel.status') }}</div>
        <div class="ap-row"><span class="ap-dot" :data-status="displayStatus" /><span class="ap-job-name" v-truncate>{{ statusText }}</span></div>
        <div class="ap-note">{{ t('agentPane.panel.status-source') }}</div>
      </section>

      <section class="ap-sec">
        <div class="ap-label">{{ t('agentPane.panel.channels') }}</div>
        <div v-if="binding" class="ap-row ap-ellip" v-truncate data-testid="agent-panel-channel">{{ channelText }}</div>
        <template v-else>
          <div class="ap-empty" data-testid="agent-panel-channel-empty">{{ t('agentPane.panel.channel-unbound') }}</div>
          <div class="ap-note">{{ t('agentPane.panel.channel-unbound-hint') }}</div>
        </template>
      </section>

      <section class="ap-sec">
        <div class="ap-label">{{ t('agentPane.panel.schedules') }}</div>
        <div v-for="job in jobs" :key="job.id" class="ap-row ap-job" :class="{ off: !job.enabled }" data-testid="agent-panel-job">
          <span class="ap-job-when">{{ jobWhen(job) }}</span>
          <span class="ap-job-name" v-truncate>{{ job.name }}</span>
          <span v-if="!job.enabled" class="ap-job-off">{{ t('agentPane.panel.schedule-paused') }}</span>
        </div>
        <div v-if="!jobs.length" class="ap-empty" data-testid="agent-panel-jobs-empty">{{ t('agentPane.panel.schedules-empty') }}</div>
      </section>

      <section class="ap-sec">
        <div class="ap-label">{{ t('agentPane.panel.memory') }}</div>
        <div
          v-for="entry in memory?.entries ?? []"
          :key="entry.path"
          class="ap-note-row"
          :title="entry.preview"
          data-testid="agent-panel-memory-entry"
        >
          <span class="ap-note-name" v-truncate>{{ entry.name }}</span>
          <span class="ap-note-preview" v-truncate>{{ entry.preview }}</span>
        </div>
        <div v-if="!memory?.entries.length" class="ap-empty" data-testid="agent-panel-memory-empty">{{ sectionEmptyText(memory?.status, 'memory') }}</div>
        <template v-if="memory?.root">
          <div class="ap-note ap-source" :title="memory.root" data-testid="agent-panel-memory-source" v-truncate>{{ t('agentPane.panel.memory-source', { path: memory.root }) }}</div>
          <button
            v-if="memory.status !== 'missing'"
            class="ap-link"
            type="button"
            data-testid="agent-panel-memory-open"
            @click.stop="revealPath(memory.root)"
          >{{ t('agentPane.panel.open-folder') }}</button>
        </template>
      </section>

      <section class="ap-sec">
        <div class="ap-label">{{ t('agentPane.panel.todos') }}</div>
        <div
          v-for="entry in todos?.entries ?? []"
          :key="entry.path"
          class="ap-note-row"
          data-testid="agent-panel-todo-entry"
        ><span class="ap-note-name" v-truncate>{{ entry.preview || entry.name }}</span></div>
        <div v-if="!todos?.entries.length" class="ap-empty" data-testid="agent-panel-todos-empty">{{ sectionEmptyText(todos?.status, 'todos') }}</div>
      </section>

      <div class="ap-actions">
        <button
          class="ap-btn primary"
          type="button"
          data-testid="agent-panel-wake"
          v-truncate
          :disabled="!next"
          :title="next ? t('agentPane.action.wake-title', { name: next.name }) : t('agentPane.action.wake-none')"
          @click.stop="agents?.wakeNow(paneId, paneName)"
        >{{ t('agentPane.action.wake') }}</button>
        <button
          class="ap-btn"
          type="button"
          data-testid="agent-panel-pause"
          v-truncate
          :disabled="!jobs.length"
          @click.stop="agents?.setSchedulesPaused(paneId, paneName, anyEnabled)"
        >{{ anyEnabled || !jobs.length ? t('agentPane.action.pause-schedules') : t('agentPane.action.resume-schedules') }}</button>
        <button
          class="ap-btn wide"
          type="button"
          data-testid="agent-panel-settings"
          v-truncate
          :disabled="!identity"
          @click.stop="identity && agents?.openSettings(identity.id)"
        >{{ t('agentPane.action.settings') }}</button>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.agent-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 200px;
  overflow-y: auto;
  background: var(--bg-elevated);
  border-left: 1px solid var(--border-muted);
  padding: 8px 10px 10px;
  font-size: 12px;
  color: var(--text-primary);
  box-sizing: border-box;
  z-index: 2;
}
.agent-panel.collapsed {
  width: 18px;
  padding: 0;
  overflow: hidden;
}
.ap-toggle {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 16px;
  height: 18px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
}
.agent-panel.collapsed .ap-toggle { right: 1px; }
.ap-toggle:hover { color: var(--text-primary); }
.ap-title { font-weight: 700; font-size: 13px; margin-bottom: 6px; }
.ap-sec { margin-bottom: 10px; }
.ap-label { font-size: 10.5px; color: var(--text-secondary); margin-bottom: 2px; }
.ap-row { display: flex; align-items: center; gap: 6px; min-width: 0; white-space: nowrap; overflow: hidden; }
.ap-ellip { display: block; text-overflow: ellipsis; }
.ap-empty { color: var(--text-secondary); }
.ap-note { font-size: 10.5px; color: var(--text-secondary); }
.ap-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--text-secondary); }
.ap-dot[data-status='running'] { background: var(--success-fg); }
.ap-dot[data-status='awaiting'] { background: var(--warning-fg); }
.ap-dot[data-status='error'], .ap-dot[data-status='exited'] { background: var(--danger-fg); }
.ap-job-when { flex: none; font-variant-numeric: tabular-nums; }
.ap-job-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ap-job.off { color: var(--text-secondary); }
.ap-job-off { flex: none; font-size: 10.5px; }
.ap-note-row { display: flex; flex-direction: column; min-width: 0; margin-bottom: 4px; }
.ap-note-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ap-note-preview { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--text-secondary); }
.ap-source { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ap-link { font: inherit; font-size: 10.5px; background: none; border: none; padding: 0; color: var(--accent-fg); cursor: pointer; }
.ap-actions { display: grid; grid-template-columns: 1fr; gap: 6px; }
.ap-btn {
  font: inherit;
  padding: 4px 6px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-muted);
  background: var(--bg-base);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ap-btn.primary { background: var(--agent-color, var(--accent-emphasis)); border-color: transparent; color: #fff; }
.ap-btn.wide { grid-column: 1 / -1; }
.ap-btn:disabled { opacity: 0.5; cursor: default; }
</style>
