<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import { i18n, vTruncate } from '@navide/plugin-ui/foundation'
import { AGENT_SPECS } from '@navide/plugin-shell'
import { agentConsoleKey, type AgentConsole } from '../../composables/useAgentConsole'
import { channelsKey, DEFAULT_ACCOUNT, type ChannelsStore } from '../../composables/useChannels'
import { formatChannelIdentity } from '../../lib/channelIdentity'
import { describeSchedule, type SchedulerJob } from '../../lib/schedulerJobs'
import { paneStatusLabelText } from '../../lib/paneStatusLabel'
import { revealPath } from '../../composables/hostShell'
import {
  AGENT_COLORS,
  AGENT_COLOR_HEX,
  agentInitial,
  agentVendorLabel,
  type AgentColor,
  type AgentIdentitySummary,
} from '../../lib/agentIdentity'

/**
 * Settings → Agents (plan agent-0-2-40_78e071, figure 2): the user's agent
 * identities and, for the selected one, identity, channel, schedules, memory
 * location and launch flags. Separate from the CLI Agents drawer, which is left
 * as it is (decision 2). Read-only where Navide has no source (memory).
 */
const props = defineProps<{
  agents: AgentIdentitySummary[]
  /** Identity to select on open (the pane's "Agent settings…"). */
  focusId?: string
  /** Test seams; the app provides both stores. */
  console?: AgentConsole
  channels?: ChannelsStore
}>()
const emit = defineEmits<{
  (e: 'open', identityId: string): void
  (e: 'stop', identityId: string): void
  (e: 'rename', identityId: string, name: string): void
  (e: 'go-tab', tab: 'channels' | 'cliAgents'): void
}>()

const t = i18n.global.t
const agentConsole = props.console ?? inject(agentConsoleKey, null)
const channels = props.channels ?? inject(channelsKey, null)

const selectedId = ref(props.focusId || props.agents[0]?.identity.id || '')
watch(() => props.focusId, (id) => { if (id) selectedId.value = id })
watch(() => props.agents.map((a) => a.identity.id).join(','), () => {
  if (!props.agents.some((a) => a.identity.id === selectedId.value)) selectedId.value = props.agents[0]?.identity.id ?? ''
})
const selected = computed(() => props.agents.find((a) => a.identity.id === selectedId.value) ?? null)

function statusText(row: AgentIdentitySummary): string {
  return row.open ? paneStatusLabelText(row.status as never) : t('agentPane.settings.closed')
}

// ── Identity ─────────────────────────────────────────────────────────────────
const nameDraft = ref('')
watch(selected, (row) => { nameDraft.value = row?.identity.name ?? '' }, { immediate: true })
/** A rename waiting for the user's confirmation: the schedules that address
 *  the old name and the pane's channel bindings are listed first. */
interface PendingRename {
  identityId: string
  oldName: string
  name: string
  jobs: SchedulerJob[]
  channels: number
}
const pendingRename = ref<PendingRename | null>(null)
const retargetJobs = ref(true)
const renameFailed = ref<string[]>([])

function commitName(): void {
  const row = selected.value
  const name = nameDraft.value.trim()
  if (pendingRename.value) return
  if (!row || !name || name === row.identity.name) {
    nameDraft.value = row?.identity.name ?? ''
    return
  }
  const paneId = row.identity.paneId
  const own = paneId ? channels?.bindingFor(paneId) : null
  pendingRename.value = {
    identityId: row.identity.id,
    oldName: row.identity.name,
    name,
    jobs: agentConsole?.jobsNamed(row.identity.name) ?? [],
    channels: paneId ? (own ? 1 : 0) + (channels?.childrenOf(paneId).length ?? 0) : 0,
  }
  retargetJobs.value = true
  renameFailed.value = []
}

function cancelRename(): void {
  pendingRename.value = null
  nameDraft.value = selected.value?.identity.name ?? ''
}

async function confirmRename(): Promise<void> {
  const r = pendingRename.value
  if (!r) return
  pendingRename.value = null
  emit('rename', r.identityId, r.name)
  if (retargetJobs.value && r.jobs.length && agentConsole) {
    renameFailed.value = await agentConsole.retargetJobs(r.jobs, r.name)
  }
}
function setColor(color: AgentColor): void {
  if (selected.value) agentConsole?.patch(selected.value.identity.id, { color })
}

// ── Channel ──────────────────────────────────────────────────────────────────
const binding = computed(() => {
  const paneId = selected.value?.identity.paneId
  return paneId ? channels?.bindingFor(paneId) ?? null : null
})
const channelText = computed(() => {
  const b = binding.value
  if (!b) return ''
  return formatChannelIdentity(b, { t, state: channels?.accountState(b.platform, b.account || DEFAULT_ACCOUNT) }, 'short')
})

// ── Schedules ────────────────────────────────────────────────────────────────
const jobs = computed(() => {
  const a = selected.value?.identity
  return a ? agentConsole?.jobsFor(a.paneId ?? '', a.name) ?? [] : []
})

// ── Memory ───────────────────────────────────────────────────────────────────
const memory = computed(() => {
  const key = selected.value?.identity.agentKey
  return key ? agentConsole?.notesFor(key)?.memory ?? null : null
})
watch(() => selected.value?.identity.agentKey, (key) => { if (key) void agentConsole?.refreshNotes(key) }, { immediate: true })

// ── Model & flags ────────────────────────────────────────────────────────────
const spec = computed(() => AGENT_SPECS.find((s) => s.agentKey === selected.value?.identity.agentKey))
</script>

<template>
  <div class="agents-pane" data-testid="agents-settings">
    <p class="s-page-intro">{{ t('agentPane.settings.intro') }}</p>
    <div v-if="!agents.length" class="ag-empty" data-testid="agents-empty">{{ t('agentPane.settings.empty') }}</div>
    <div v-else class="ag-layout">
      <nav class="ag-list" :aria-label="t('agentPane.settings.list')">
        <div class="ag-list-title">{{ t('agentPane.settings.list') }}</div>
        <button
          v-for="row in agents"
          :key="row.identity.id"
          type="button"
          class="ag-item"
          :class="{ on: row.identity.id === selectedId }"
          :aria-pressed="row.identity.id === selectedId ? 'true' : 'false'"
          data-testid="agents-item"
          @click="selectedId = row.identity.id"
        >
          <span class="ag-avatar" :style="{ background: AGENT_COLOR_HEX[row.identity.color] }" aria-hidden="true">{{ agentInitial(row.identity.name, row.identity.agentKey) }}</span>
          <span class="ag-item-txt">
            <span class="ag-item-name" v-truncate>{{ row.identity.name }}</span>
            <span class="ag-item-sub" v-truncate>{{ agentVendorLabel(row.identity.agentKey) }} · {{ row.open ? t('agentPane.settings.pane-open') : t('agentPane.settings.pane-closed') }}</span>
          </span>
          <span class="ag-pill" :data-status="row.open ? row.status : 'closed'">{{ statusText(row) }}</span>
        </button>
        <p class="ag-note">{{ t('agentPane.settings.identity-note') }}</p>
      </nav>

      <div v-if="selected" class="ag-detail">
        <div class="ag-head">
          <span class="ag-head-name" v-truncate>{{ selected.identity.name }}</span>
          <span class="ag-head-sub">{{ agentVendorLabel(selected.identity.agentKey) }}</span>
          <span class="ag-head-actions">
            <button type="button" class="ag-btn" data-testid="agents-open" @click="emit('open', selected.identity.id)">{{ selected.open ? t('agentPane.settings.switch-to') : t('agentPane.settings.open-pane') }}</button>
            <button type="button" class="ag-btn danger" data-testid="agents-stop" @click="emit('stop', selected.identity.id)">{{ t('agentPane.settings.stop-remove') }}</button>
          </span>
        </div>

        <div class="ag-cards">
          <section class="ag-card">
            <h3>{{ t('agentPane.settings.identity') }}</h3>
            <label class="ag-field">
              <span>{{ t('agentPane.settings.name') }}</span>
              <input v-model="nameDraft" data-testid="agents-name" @keydown.enter.prevent="commitName" @blur="commitName" />
            </label>
            <p v-if="renameFailed.length" class="ag-note ag-warn" data-testid="agents-rename-failed">{{ t('agentPane.settings.rename-failed', { names: renameFailed.join(', ') }) }}</p>
            <div class="ag-field">
              <span>{{ t('agentPane.settings.color') }}</span>
              <div class="ag-swatches" role="radiogroup" :aria-label="t('agentPane.settings.color')">
                <button
                  v-for="c in AGENT_COLORS"
                  :key="c"
                  type="button"
                  role="radio"
                  class="ag-swatch"
                  :class="{ on: selected.identity.color === c }"
                  :aria-checked="selected.identity.color === c ? 'true' : 'false'"
                  :aria-label="c"
                  :style="{ background: AGENT_COLOR_HEX[c] }"
                  @click="setColor(c)"
                />
              </div>
            </div>
          </section>

          <section class="ag-card">
            <h3>{{ t('agentPane.settings.channel') }}</h3>
            <div v-if="binding" class="ag-line ag-ellip" data-testid="agents-channel" v-truncate>{{ channelText }}</div>
            <div v-else class="ag-muted" data-testid="agents-channel-empty">{{ selected.open ? t('agentPane.panel.channel-unbound') : t('agentPane.settings.channel-closed') }}</div>
            <p class="ag-note">{{ t('agentPane.settings.channel-note') }}</p>
            <button type="button" class="ag-link" @click="emit('go-tab', 'channels')">{{ t('agentPane.settings.go-channels') }}</button>
          </section>

          <section class="ag-card">
            <h3>{{ t('agentPane.settings.schedules') }}</h3>
            <div v-for="job in jobs" :key="job.id" class="ag-line ag-job" data-testid="agents-job">
              <span v-truncate>{{ job.name }}</span>
              <span class="ag-muted">{{ describeSchedule(job.schedule, t, job.state) }} · {{ job.enabled ? t('agentPane.settings.job-on') : t('agentPane.panel.schedule-paused') }}</span>
            </div>
            <div v-if="!jobs.length" class="ag-muted" data-testid="agents-jobs-empty">{{ t('agentPane.panel.schedules-empty') }}</div>
            <p class="ag-note">{{ t('agentPane.settings.schedules-note') }}</p>
          </section>

          <section class="ag-card">
            <h3>{{ t('agentPane.settings.memory') }}</h3>
            <template v-if="memory && memory.root">
              <div class="ag-line ag-ellip" data-testid="agents-memory-root" :title="memory.root" v-truncate><code>{{ memory.root }}</code></div>
              <div v-if="memory.status === 'missing'" class="ag-muted">{{ t('agentPane.panel.memory-missing') }}</div>
              <button v-else type="button" class="ag-link" data-testid="agents-memory-open" @click="revealPath(memory.root)">{{ t('agentPane.panel.open-folder') }}</button>
            </template>
            <div v-else class="ag-muted" data-testid="agents-memory-empty">{{ memory ? t('agentPane.panel.memory-empty') : t('agentPane.panel.memory-loading') }}</div>
            <p class="ag-note">{{ t('agentPane.settings.memory-note') }}</p>
          </section>

          <section class="ag-card wide">
            <h3>{{ t('agentPane.settings.flags') }}</h3>
            <dl class="ag-dl">
              <dt>{{ t('agentPane.settings.command') }}</dt>
              <dd><code>{{ spec?.defaultCommand ?? '—' }}</code></dd>
              <dt>{{ t('agentPane.settings.yolo') }}</dt>
              <dd>{{ spec?.skipPermissionFlag ? t('agentPane.settings.yolo-flag', { flag: spec.skipPermissionFlag }) : t('agentPane.settings.unsupported') }}</dd>
              <dt>{{ t('agentPane.settings.resume') }}</dt>
              <dd>{{ spec?.resumeArgs ? t('agentPane.settings.resume-on') : t('agentPane.settings.unsupported') }}</dd>
              <dt>{{ t('agentPane.settings.session') }}</dt>
              <dd><code v-if="selected.identity.sessionId">{{ selected.identity.sessionId }}</code><span v-else class="ag-muted">{{ t('agentPane.settings.session-none') }}</span></dd>
            </dl>
            <p class="ag-note">{{ t('agentPane.settings.flags-note') }}</p>
            <button type="button" class="ag-link" @click="emit('go-tab', 'cliAgents')">{{ t('agentPane.settings.go-cli-agents') }}</button>
          </section>
        </div>
      </div>
    </div>
    <div v-if="pendingRename" class="ag-confirm-backdrop" @click.self="cancelRename">
      <div class="ag-confirm" role="dialog" aria-modal="true" :aria-label="t('agentPane.settings.rename-title', { old: pendingRename.oldName, name: pendingRename.name })" data-testid="agents-rename-confirm">
        <h3 class="ag-confirm-title">{{ t('agentPane.settings.rename-title', { old: pendingRename.oldName, name: pendingRename.name }) }}</h3>
        <template v-if="pendingRename.jobs.length">
          <div class="ag-line">{{ t('agentPane.settings.rename-schedules', { old: pendingRename.oldName, n: pendingRename.jobs.length }) }}</div>
          <ul class="ag-confirm-jobs">
            <li v-for="job in pendingRename.jobs" :key="job.id" data-testid="agents-rename-job" v-truncate>{{ job.name }}</li>
          </ul>
          <label class="ag-confirm-check">
            <input v-model="retargetJobs" type="checkbox" data-testid="agents-rename-retarget" />
            <span>{{ t('agentPane.settings.rename-update') }}</span>
          </label>
        </template>
        <div v-else class="ag-muted" data-testid="agents-rename-no-jobs">{{ t('agentPane.settings.rename-no-schedules') }}</div>
        <div class="ag-line" data-testid="agents-rename-channels">{{ t('agentPane.settings.rename-channels', { n: pendingRename.channels }) }}</div>
        <p class="ag-note">{{ t('agentPane.settings.rename-channels-note') }}</p>
        <div class="ag-confirm-actions">
          <button type="button" class="ag-btn" data-testid="agents-rename-cancel" @click="cancelRename">{{ t('agentPane.settings.rename-cancel') }}</button>
          <button type="button" class="ag-btn primary" data-testid="agents-rename-ok" @click="confirmRename">{{ t('agentPane.settings.rename-confirm') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agents-pane { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ag-empty { color: var(--text-secondary); padding: 24px 0; }
.ag-layout { display: grid; grid-template-columns: minmax(200px, 240px) minmax(0, 1fr); gap: 16px; min-width: 0; }
.ag-list { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.ag-list-title { font-weight: 600; margin-bottom: 2px; }
.ag-item {
  display: flex; align-items: center; gap: 8px; padding: 8px; min-width: 0;
  border: 1px solid var(--border-muted); border-radius: var(--radius-sm); background: var(--bg-base);
  color: var(--text-primary); font: inherit; text-align: left; cursor: pointer;
}
.ag-item.on { border-color: var(--accent-emphasis); background: var(--accent-subtle); }
.ag-avatar {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 50%; color: #fff; font-weight: 700; font-size: var(--font-xs);
}
.ag-item-txt { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.ag-item-name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-item-sub { color: var(--text-secondary); font-size: var(--font-3xs); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-pill { flex: none; font-size: var(--font-3xs); padding: 1px 7px; border-radius: 99px; background: var(--bg-muted); color: var(--text-secondary); }
.ag-pill[data-status='running'] { background: var(--success-subtle); color: var(--success-fg); }
.ag-pill[data-status='awaiting'] { background: var(--attention-subtle); color: var(--attention-fg); }
.ag-note { color: var(--text-secondary); font-size: var(--font-3xs); margin: 4px 0 0; }
.ag-detail { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.ag-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.ag-head-name { font-weight: 700; font-size: var(--font-md); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-head-sub { color: var(--text-secondary); font-size: var(--font-xs); }
.ag-head-actions { margin-left: auto; display: flex; gap: 6px; }
.ag-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.ag-card { border: 1px solid var(--border-muted); border-radius: var(--radius-sm); padding: 10px 12px; min-width: 0; background: var(--bg-base); }
.ag-card.wide { grid-column: 1 / -1; }
.ag-card h3 { margin: 0 0 8px; font-size: var(--font-sm); }
.ag-field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; font-size: var(--font-3xs); color: var(--text-secondary); }
.ag-field input { font: inherit; font-size: var(--font-xs); color: var(--text-primary); padding: 4px 6px; border: 1px solid var(--border-default); border-radius: var(--radius-xs); background: var(--bg-subtle); }
.ag-swatches { display: flex; gap: 6px; }
.ag-swatch { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
.ag-swatch.on { border-color: var(--text-primary); }
.ag-line { font-size: var(--font-xs); min-width: 0; overflow: hidden; white-space: nowrap; }
.ag-ellip { text-overflow: ellipsis; }
.ag-job { display: flex; flex-direction: column; margin-bottom: 4px; }
.ag-muted { color: var(--text-secondary); font-size: var(--font-xs); }
.ag-dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 0; font-size: var(--font-xs); }
.ag-dl dt { color: var(--text-secondary); }
.ag-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.ag-btn { font: inherit; font-size: var(--font-xs); padding: 3px 10px; border: 1px solid var(--border-default); border-radius: var(--radius-xs); background: var(--bg-base); color: var(--text-primary); cursor: pointer; }
.ag-btn.danger { color: var(--danger-fg); }
.ag-link { font: inherit; font-size: var(--font-xs); background: none; border: none; padding: 0; margin-top: 6px; color: var(--accent-fg); cursor: pointer; }
.ag-warn { color: var(--danger-fg); }
.ag-btn.primary { background: var(--accent-emphasis); border-color: transparent; color: #fff; }
.ag-confirm-backdrop { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--bg-base) 55%, transparent); }
.ag-confirm { width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-elevated); box-shadow: var(--shadow-lg, 0 8px 24px rgba(0, 0, 0, 0.3)); }
.ag-confirm-title { margin: 0 0 4px; font-size: var(--font-sm); overflow-wrap: anywhere; }
.ag-confirm-jobs { margin: 0; padding-left: 18px; font-size: var(--font-xs); }
.ag-confirm-jobs li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-confirm-check { display: flex; align-items: center; gap: 6px; font-size: var(--font-xs); }
.ag-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
@media (max-width: 720px) { .ag-layout { grid-template-columns: minmax(0, 1fr); } }
</style>
