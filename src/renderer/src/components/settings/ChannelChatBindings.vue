<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import {
  chatRows,
  type ChannelOverviewBinding,
  type ChannelOverviewChat,
  type ChannelsStore,
} from '../../composables/useChannels'
import { paneStatusLabelText, type PaneStatusValue } from '../../lib/paneStatusLabel'

/**
 * One bot's chats in Settings → Channels, each with the panes bound to it: jump
 * to a pane (in whichever window has it), unbind one row (the button asks once
 * more), or tick several and unbind them together after one confirmation. A row
 * whose pane is gone is an orphan and can be cleared. Auto child topics stay
 * folded under the pane they report into and are released with it.
 */
const props = defineProps<{
  store: ChannelsStore
  chats: ChannelOverviewChat[]
  busy?: boolean
}>()

const { t, te } = useI18n()

const rowsByChat = computed(() => props.chats.map((chat) => ({ chat, rows: chatRows(chat) })))
const allRows = computed(() => rowsByChat.value.flatMap((c) => c.rows.map((r) => ({ chat: c.chat, row: r }))))

const selected = reactive(new Set<string>())
const confirmingRow = ref<string | null>(null)
const confirmingBatch = ref(false)
const openChildren = reactive(new Set<string>())
const working = ref(false)
const error = ref('')
const failures = ref<{ name: string; error: string }[]>([])

// A row that went away (unbound elsewhere) must not stay ticked.
watch(allRows, (rows) => {
  const live = new Set(rows.map((r) => r.row.binding.pane_id))
  for (const id of [...selected]) if (!live.has(id)) selected.delete(id)
  if (!selected.size) confirmingBatch.value = false
})

const selectedRows = computed(() => allRows.value.filter((r) => selected.has(r.row.binding.pane_id)))
const selectedChats = computed(() => new Set(selectedRows.value.map((r) => r.chat.chat_id)).size)

function chatTitle(chat: ChannelOverviewChat): string {
  return chat.title || chat.chat_id
}

function isDirect(chat: ChannelOverviewChat): boolean {
  return chat.kind === 'private' || chat.kind === 'direct' || chat.kind === 'im' || chat.kind === 'dm'
}

function kindText(chat: ChannelOverviewChat): string {
  const kind = t(isDirect(chat) ? 'channels.pane.kind-direct' : 'channels.pane.kind-group')
  return chat.supports_topics ? `${kind} · ${t('channels.bindings.topics')}` : kind
}

function workspaceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

function statusLabel(b: ChannelOverviewBinding): string {
  const s = b.pane.display_status
  if (!s) return ''
  return te(`paneStatus.${s}`) ? paneStatusLabelText(s as PaneStatusValue) : s
}

function statusTone(b: ChannelOverviewBinding): string {
  switch (b.pane.display_status) {
    case 'running':
    case 'starting':
      return 'run'
    case 'awaiting':
    case 'waiting':
      return 'warn'
    case 'error':
    case 'disconnected':
      return 'bad'
    default:
      return 'idle'
  }
}

function levelText(b: ChannelOverviewBinding): string {
  return t(`channels.pane.verbosity-${b.verbosity ?? 'full'}`)
}

function boundAt(b: ChannelOverviewBinding): string {
  if (!b.created_at) return ''
  const d = new Date(b.created_at * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return t('channels.bindings.bound-at', { at: `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` })
}

function toggle(paneId: string, on: boolean): void {
  if (on) selected.add(paneId)
  else selected.delete(paneId)
  if (!selected.size) confirmingBatch.value = false
}

function clearSelection(): void {
  selected.clear()
  confirmingBatch.value = false
}

async function focus(b: ChannelOverviewBinding): Promise<void> {
  error.value = ''
  const res = await props.store.focusPane(b.pane_id)
  if (!res.ok) {
    error.value = res.error === 'not-found'
      ? t('channels.bindings.focus-no-window', { name: b.pane.name })
      : t('channels.bindings.focus-failed', { error: res.error ?? '' })
  }
}

async function unbind(paneIds: string[]): Promise<void> {
  if (working.value) return
  working.value = true
  error.value = ''
  failures.value = []
  try {
    const names = new Map(allRows.value.map((r) => [r.row.binding.pane_id, r.row.binding.pane.name]))
    const res = await props.store.unbindMany(paneIds)
    if (!res.ok) {
      error.value = res.error ?? t('channels.error.generic')
      return
    }
    const failed = (res.data?.results ?? []).filter((r) => !r.ok)
    failures.value = failed.map((r) => ({ name: names.get(r.pane_id) || r.pane_id, error: r.error ?? '' }))
    for (const id of paneIds) if (!failed.some((f) => f.pane_id === id)) selected.delete(id)
    confirmingBatch.value = false
    confirmingRow.value = null
  } finally {
    working.value = false
  }
}

function pressUnbind(paneId: string): void {
  if (confirmingRow.value !== paneId) {
    confirmingRow.value = paneId
    return
  }
  void unbind([paneId])
}
</script>

<template>
  <div class="cb" data-testid="channel-chats">
    <div v-for="{ chat, rows } in rowsByChat" :key="chat.chat_id" class="cb-chat" data-testid="channel-chat" :data-chat-id="chat.chat_id">
      <div class="cb-chat-head">
        <span class="cb-chat-icon" aria-hidden="true">{{ isDirect(chat) ? '💬' : '👥' }}</span>
        <span class="cb-chat-title" v-truncate data-testid="channel-chat-title">{{ chatTitle(chat) }}</span>
        <span class="cb-chat-kind">{{ kindText(chat) }}</span>
      </div>
      <p v-if="!rows.length" class="cb-unbound" data-testid="channel-chat-unbound">{{ t('channels.bindings.unbound') }}</p>
      <div
        v-for="row in rows"
        :key="row.binding.pane_id"
        class="cb-row"
        :class="{ orphan: row.orphan, selected: selected.has(row.binding.pane_id) }"
        data-testid="channel-binding"
        :data-pane-id="row.binding.pane_id"
      >
        <div class="cb-row-main">
          <input
            type="checkbox"
            class="cb-check"
            data-testid="channel-binding-select"
            :checked="selected.has(row.binding.pane_id)"
            :aria-label="t('channels.bindings.select', { name: row.binding.pane.name })"
            @change="toggle(row.binding.pane_id, ($event.target as HTMLInputElement).checked)"
          />
          <div class="cb-row-text">
            <div class="cb-row-title">
              <span v-if="row.binding.thread_id && chat.supports_topics" class="cb-topic">{{ t('channels.bindings.topic', { title: row.binding.title }) }}</span>
              <span class="cb-pane" data-testid="channel-binding-pane">{{ row.orphan ? t('channels.bindings.gone') : row.binding.pane.name }}</span>
              <span v-if="row.binding.pane.workspace_path" class="cb-ws" data-testid="channel-binding-workspace">{{ workspaceName(row.binding.pane.workspace_path) }}</span>
              <span v-else-if="row.orphan && row.binding.pane.name" class="cb-ws">{{ row.binding.pane.name }}</span>
            </div>
            <div class="cb-row-meta" data-testid="channel-binding-meta">
              <template v-if="row.orphan">{{ t('channels.bindings.orphan-hint') }}</template>
              <template v-else>
                <span v-if="statusLabel(row.binding)" class="cb-dot" :class="statusTone(row.binding)" aria-hidden="true"></span>
                <span v-if="statusLabel(row.binding)">{{ statusLabel(row.binding) }} · </span>{{ levelText(row.binding) }}<template v-if="boundAt(row.binding)"> · {{ boundAt(row.binding) }}</template>
              </template>
            </div>
          </div>
          <div class="cb-actions">
            <template v-if="row.orphan">
              <button type="button" class="ch-btn danger-ghost sm" :disabled="busy || working" data-testid="channel-binding-clear" @click="unbind([row.binding.pane_id])">{{ t('channels.bindings.clear') }}</button>
            </template>
            <template v-else>
              <button type="button" class="ch-btn ghost sm" data-testid="channel-binding-focus" @click="focus(row.binding)">{{ t('channels.bindings.focus') }}</button>
              <button
                type="button"
                class="ch-btn sm"
                :class="confirmingRow === row.binding.pane_id ? 'danger' : 'danger-ghost'"
                :disabled="busy || working"
                data-testid="channel-binding-unbind"
                @click="pressUnbind(row.binding.pane_id)"
                @blur="confirmingRow === row.binding.pane_id && (confirmingRow = null)"
              >{{ confirmingRow === row.binding.pane_id ? t('channels.bindings.unbind-confirm') : t('channels.bindings.unbind') }}</button>
            </template>
          </div>
        </div>
        <template v-if="row.children.length">
          <button
            type="button"
            class="cb-children-toggle"
            data-testid="channel-binding-children-toggle"
            :aria-expanded="openChildren.has(row.binding.pane_id)"
            @click="openChildren.has(row.binding.pane_id) ? openChildren.delete(row.binding.pane_id) : openChildren.add(row.binding.pane_id)"
          >{{ openChildren.has(row.binding.pane_id) ? '▾' : '▸' }} {{ t('channels.bindings.children', { n: row.children.length }) }}</button>
          <template v-if="openChildren.has(row.binding.pane_id)">
            <div v-for="child in row.children" :key="child.pane_id" class="cb-child" data-testid="channel-binding-child" :data-pane-id="child.pane_id">
              <div class="cb-row-text">
                <div class="cb-row-title">
                  <span class="cb-pane">↳ {{ child.pane.name }}</span>
                  <span class="cb-auto">{{ t('channels.bindings.auto') }}</span>
                </div>
                <div class="cb-row-meta">{{ t('channels.bindings.follows-parent') }} · {{ levelText(child) }}</div>
              </div>
              <div class="cb-actions">
                <button v-if="child.pane.exists" type="button" class="ch-btn ghost sm" data-testid="channel-binding-focus" @click="focus(child)">{{ t('channels.bindings.focus') }}</button>
              </div>
            </div>
          </template>
        </template>
      </div>
    </div>

    <div v-if="selected.size" class="cb-batch" data-testid="channel-batch">
      <template v-if="!confirmingBatch">
        <span class="cb-batch-count">{{ t('channels.bindings.selected', { n: selected.size }) }}</span>
        <span class="cb-spacer"></span>
        <button type="button" class="ch-btn ghost sm" data-testid="channel-batch-cancel" @click="clearSelection">{{ t('channels.cancel') }}</button>
        <button type="button" class="ch-btn danger-ghost sm" :disabled="busy || working" data-testid="channel-batch-unbind" @click="confirmingBatch = true">
          {{ t('channels.bindings.unbind-n', { n: selected.size }) }}
        </button>
      </template>
      <div v-else class="cb-batch-ask" data-testid="channel-batch-ask">
        <p class="cb-batch-title">{{ t('channels.bindings.batch-ask', { n: selected.size }) }}</p>
        <ul class="cb-batch-list">
          <li v-for="r in selectedRows" :key="r.row.binding.pane_id">{{ r.row.binding.pane.name || r.row.binding.pane_id }} — {{ chatTitle(r.chat) }}</li>
        </ul>
        <p class="cb-batch-note">{{ t('channels.bindings.batch-note', { n: selectedChats }) }}</p>
        <div class="cb-batch-actions">
          <span class="cb-spacer"></span>
          <button type="button" class="ch-btn ghost sm" :disabled="working" data-testid="channel-batch-back" @click="confirmingBatch = false">{{ t('channels.cancel') }}</button>
          <button type="button" class="ch-btn danger sm" :disabled="busy || working" data-testid="channel-batch-confirm" @click="unbind([...selected])">
            {{ t('channels.bindings.unbind-n', { n: selected.size }) }}
          </button>
        </div>
      </div>
    </div>
    <p v-if="error" class="ch-error" role="alert" data-testid="channel-bindings-error">{{ error }}</p>
    <div v-if="failures.length" class="ch-error" role="alert" data-testid="channel-batch-error">
      {{ t('channels.bindings.partial', { n: failures.length }) }}
      <ul class="cb-batch-list">
        <li v-for="f in failures" :key="f.name">{{ f.name }}: {{ f.error }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.cb { display: flex; flex-direction: column; gap: 8px; }
.cb-chat { border: 1px solid var(--border-muted); border-radius: var(--radius-sm); background: var(--bg-base); overflow: hidden; }
.cb-chat-head { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border-muted); background: var(--bg-muted); }
.cb-chat-icon { font-size: var(--font-xs); }
.cb-chat-title { font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cb-chat-kind { font-size: var(--font-3xs); color: var(--text-secondary); white-space: nowrap; }
.cb-unbound { margin: 0; padding: 8px 10px; font-size: var(--font-2xs); color: var(--text-muted); }
.cb-row { padding: 6px 10px; }
.cb-row + .cb-row { border-top: 1px solid var(--border-muted); }
.cb-row.selected { background: var(--accent-subtle); }
.cb-row.orphan .cb-pane { color: var(--danger-fg); }
.cb-row-main { display: flex; align-items: center; gap: 8px; }
.cb-check { flex-shrink: 0; margin: 0; accent-color: var(--accent-emphasis); }
.cb-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.cb-row-title { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.cb-topic { font-size: var(--font-2xs); color: var(--text-secondary); }
.cb-pane { font-size: var(--font-xs); font-weight: 600; color: var(--text-bright); }
.cb-ws, .cb-auto {
  font-size: var(--font-3xs);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
  border-radius: 999px;
  padding: 0 6px;
  white-space: nowrap;
}
.cb-row-meta { display: flex; align-items: center; gap: 4px; font-size: var(--font-2xs); color: var(--text-secondary); flex-wrap: wrap; }
.cb-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-secondary); flex-shrink: 0; }
.cb-dot.run { background: var(--success-fg); }
.cb-dot.warn { background: var(--attention-fg); }
.cb-dot.bad { background: var(--danger-fg); }
.cb-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.cb-children-toggle { margin: 4px 0 0 22px; font: inherit; font-size: var(--font-2xs); color: var(--accent-fg); background: transparent; border: none; padding: 0; cursor: pointer; }
.cb-child { display: flex; align-items: center; gap: 8px; margin: 4px 0 0 22px; padding: 4px 8px; border-left: 2px solid var(--border-default); }
.cb-batch { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--accent-muted); border-radius: var(--radius-sm); background: var(--accent-subtle); }
.cb-batch-count { font-size: var(--font-2xs); font-weight: 600; color: var(--text-primary); }
.cb-batch-ask { flex: 1; display: flex; flex-direction: column; gap: 4px; }
.cb-batch-title { margin: 0; font-size: var(--font-xs); font-weight: 600; color: var(--text-bright); }
.cb-batch-note { margin: 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.cb-batch-list { margin: 2px 0; padding-left: 18px; font-size: var(--font-2xs); color: var(--text-primary); }
.cb-batch-actions { display: flex; align-items: center; gap: 8px; }
.cb-spacer { flex: 1; }
/* ChannelsPane's button set; scoped styles do not reach into a child component. */
.ch-btn { border-radius: 5px; font-size: var(--font-2xs); padding: 3px 8px; cursor: pointer; border: 1px solid var(--border-default); background: transparent; color: var(--text-primary); white-space: nowrap; }
.ch-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ch-btn.ghost { color: var(--text-secondary); }
.ch-btn.ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
.ch-btn.danger-ghost { color: var(--danger-fg); border-color: var(--danger-muted); }
.ch-btn.danger-ghost:hover:not(:disabled) { border-color: var(--danger-fg); }
.ch-btn.danger { color: var(--text-on-emphasis); background: var(--danger-emphasis, var(--danger-fg)); border-color: var(--danger-emphasis, var(--danger-fg)); }
.ch-error { margin: 0; font-size: var(--font-2xs); color: var(--danger-fg); word-break: break-word; }
</style>
