<script setup lang="ts">
// Announcements centre popover, anchored to its status-bar item (same backdrop
// + fixed-card shape as the backend supervisor popover in App.vue).
//
// Purely prop/emit driven: the feed and the updater actions live in App.vue, so
// this component only decides layout, expansion and which button a row offers.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { i18n, vTruncate } from '@navide/plugin-ui/foundation'
import type {
  Announcement,
  AnnouncementActionSpec,
  ConvenienceAnnouncementAction,
  EvolveAnnouncementAction,
  PaneRebuildAnnouncementAction,
  PluginAgentAnnouncementAction,
  QuotaAnnouncementAction,
} from '../composables/useAnnouncements'
import { WHATS_NEW_CHROME, pickText } from '../lib/whatsNew'

const props = defineProps<{ items: Announcement[] }>()
const emit = defineEmits<{
  close: []
  'mark-all-read': []
  read: [id: string]
  download: []
  install: []
  /** A quota row's button: the typed action, ids and epoch included, for the
   *  backend to re-validate. Nothing is executed here. */
  'quota-action': [action: QuotaAnnouncementAction]
  /** A release row's "Take the tour": the version whose tour to start. */
  tour: [version: string]
  /** A workspace self-evolution row's button, for App.vue to map onto the
   *  existing pane actions or the evolve panel. */
  'evolve-action': [action: EvolveAnnouncementAction]
  /** A convenience-feature row's button, for App.vue to map onto the
   *  overview, the convenience.* RPCs or the account switch. */
  'convenience-action': [action: ConvenienceAnnouncementAction]
  /** The undo on an "an agent disabled / enabled a Navide plugin" row. */
  'plugin-agent-action': [action: PluginAgentAnnouncementAction]
  /** H3: Rebuild on a backend-restart row, for one pane left ended. */
  'pane-action': [action: PaneRebuildAnnouncementAction]
}>()

/** Buttons of a row: the typed list, else the single update action. */
function actionsOf(item: Announcement): AnnouncementActionSpec[] {
  if (item.actions && item.actions.length > 0) return item.actions
  return item.action ? [{ kind: item.action }] : []
}

function onAction(action: AnnouncementActionSpec): void {
  if (action.kind === 'download') emit('download')
  else if (action.kind === 'install') emit('install')
  else if (action.kind === 'tour') emit('tour', action.version)
  else if (action.kind.startsWith('evolve-')) emit('evolve-action', action as EvolveAnnouncementAction)
  else if (action.kind.startsWith('convenience-')) emit('convenience-action', action as ConvenienceAnnouncementAction)
  else if (action.kind === 'pane-rebuild') emit('pane-action', action)
  else if (action.kind === 'plugin-agent-undo' || action.kind === 'plugin-agent-downgrade' || action.kind === 'plugin-staged-apply' ||
    action.kind === 'plugin-switch-back') {
    emit('plugin-agent-action', action)
  }
  else emit('quota-action', action as QuotaAnnouncementAction)
}

/** Quota-row button labels have no locale entries yet (see QUOTA_I18N_KEYS
 *  in useAnnouncements); fall back to English rather than print the key. */
function tq(key: string, fallback: string, params: Record<string, string> = {}): string {
  if (i18n.global.te(key)) return i18n.global.t(key, params)
  return fallback.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '')
}

function actionLabel(action: AnnouncementActionSpec): string {
  switch (action.kind) {
    case 'download':
      return i18n.global.t('updater.download')
    case 'install':
      return i18n.global.t('updater.install')
    case 'tour':
      // Same words as the popup's button: one announcement, one behaviour.
      return pickText(WHATS_NEW_CHROME.takeTour, String(i18n.global.locale.value))
    case 'quota-switch':
      return tq('announce.quota.switch-to', 'Switch to {label}', { label: action.label })
    case 'quota-retry-resume':
      return tq('announce.quota.retry-resume', 'Retry resume')
    case 'quota-switch-back':
      return tq('announce.quota.switch-back', 'Switch back to {label}', { label: action.label })
    case 'quota-reconcile':
      return action.liveSlotId === null
        ? tq('announce.quota.reconcile', 'Complete reconciliation')
        : tq('announce.quota.reconcile-as', 'The live account is {label}', { label: action.label })
    case 'evolve-open-pane':
    case 'evolve-resume-pane':
    case 'evolve-interrupt':
    case 'evolve-reclaim':
    case 'evolve-panel':
    case 'evolve-result':
      return i18n.global.t(`evolve.notice.action.${action.kind.slice('evolve-'.length)}`)
    case 'convenience-switch-back':
      return i18n.global.t('convenience.notice.button.switch-back', { label: action.label })
    case 'convenience-overview':
    case 'convenience-reallow':
    case 'convenience-keep-login':
    case 'convenience-dismiss':
    case 'convenience-upgrade-ack':
      return i18n.global.t(`convenience.notice.button.${action.kind.slice('convenience-'.length)}`)
    case 'plugin-agent-undo':
      return i18n.global.t(`plugin-agent.button.${action.disable ? 'disable' : 'enable'}`)
    case 'plugin-agent-downgrade':
      return i18n.global.t('plugin-agent.button.downgrade', { version: action.fromVersion })
    case 'plugin-staged-apply':
      return i18n.global.t('plugin-staged.button.apply')
    case 'plugin-switch-back':
      return i18n.global.t('plugin-switch.button.back', { version: action.fromVersion })
    case 'pane-rebuild':
      return i18n.global.t('announce.backend-restart.rebuild', { name: action.name })
  }
}

function actionKey(action: AnnouncementActionSpec): string {
  if ('liveSlotId' in action) return `${action.kind}:${action.liveSlotId ?? 'known'}`
  return 'slotId' in action ? `${action.kind}:${action.slotId}` : action.kind
}

function iconOf(item: Announcement): string {
  if (item.kind === 'release') return '🏷'
  if (item.kind === 'quota') return '◔'
  if (item.kind === 'scheduler') return '⏲'
  if (item.kind === 'evolve') return '✦'
  if (item.kind === 'convenience') return '⚙'
  if (item.kind === 'plugin-agent') return '⏻'
  if (item.kind === 'plugin-staged') return '⟳'
  if (item.kind === 'plugin-switch') return '⇄'
  return '⬆'
}

const expandedId = ref<string | null>(null)

/** Rows rendered per page — the rest wait behind the load-more button. The
 *  popover is v-if'd by its opener, so this resets on every open. */
const PAGE_SIZE = 8
const visibleCount = ref(PAGE_SIZE)

const visibleItems = computed(() => props.items.slice(0, visibleCount.value))
const remainingCount = computed(() => props.items.length - visibleItems.value.length)

function loadMore(): void {
  visibleCount.value += PAGE_SIZE
}

function toggle(item: Announcement): void {
  if (expandedId.value === item.id) {
    expandedId.value = null
    return
  }
  expandedId.value = item.id
  if (!item.read) emit('read', item.id)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString()
}
</script>

<template>
  <div class="an-backdrop" @click="emit('close')" />
  <div class="an-pop nv-popover" @click.stop>
    <div class="an-head">
      <span class="an-head-title" v-truncate>{{ $t('announce.title') }}</span>
      <button class="an-btn" data-act="mark-all" @click="emit('mark-all-read')">
        {{ $t('announce.mark-all-read') }}
      </button>
      <button class="an-btn" data-act="close" :title="$t('announce.close')" @click="emit('close')">✕</button>
    </div>

    <div class="an-list">
      <div v-if="items.length === 0" class="an-empty">{{ $t('announce.empty') }}</div>
      <div
        v-for="item in visibleItems"
        :key="item.id"
        class="an-row"
        :class="{ expanded: expandedId === item.id, unread: !item.read }"
        :data-ann-id="item.id"
        :data-ann-kind="item.kind"
        @click="toggle(item)"
      >
        <div class="an-line1">
          <span class="an-icon">{{ iconOf(item) }}</span>
          <span class="an-title">{{ item.title }}</span>
          <span v-if="item.version" class="an-ver">v{{ item.version }}</span>
          <span v-if="!item.read" class="an-dot" />
        </div>
        <div v-if="item.createdAt" class="an-time">{{ fmtTime(item.createdAt) }}</div>
        <div v-if="actionsOf(item).length > 0" class="an-acts">
          <button
            v-for="action in actionsOf(item)"
            :key="actionKey(action)"
            class="an-btn an-btn-primary"
            :data-act="action.kind"
            :data-slot="'slotId' in action ? action.slotId : undefined"
            :data-epoch="'epoch' in action ? action.epoch : undefined"
            @click.stop="onAction(action)"
          >{{ actionLabel(action) }}</button>
        </div>
        <div v-if="expandedId === item.id" class="an-detail">
          <div v-if="item.kind === 'update' && item.highlights.length > 0" class="an-sub">
            {{ $t('updater.release-notes') }}
          </div>
          <ul v-if="item.highlights.length > 0" class="an-points">
            <li v-for="(point, index) in item.highlights" :key="index">{{ point }}</li>
          </ul>
          <div v-if="item.note" class="an-note">{{ item.note }}</div>
        </div>
      </div>
      <div v-if="remainingCount > 0" class="an-more">
        <button class="an-btn" data-act="load-more" @click="loadMore">
          {{ $t('announce.load-more', { count: remainingCount }) }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.an-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
}
.an-pop {
  position: fixed;
  right: 8px;
  bottom: 30px;
  z-index: 1000;
  width: 340px;
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-popover);
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  box-shadow: var(--shadow-popover);
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.an-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-muted);
}
.an-head-title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.an-btn {
  flex: none;
  background: var(--bg-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 2px 7px;
  font-size: var(--font-3xs);
  cursor: pointer;
}
.an-btn:hover { color: var(--text-bright); }
.an-btn-primary {
  color: var(--accent-fg);
  font-weight: 600;
}
.an-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}
.an-empty {
  padding: 20px 10px;
  text-align: center;
  color: var(--text-muted);
}
.an-more {
  padding: 8px 10px;
  display: flex;
  justify-content: center;
}
.an-row {
  padding: 7px 10px;
  border-bottom: 1px solid var(--border-muted);
  cursor: pointer;
}
.an-row:hover { background: var(--bg-hover); }
.an-line1 {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.an-icon { flex: none; }
.an-title {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.an-row.unread .an-title { font-weight: 600; color: var(--text-bright); }
.an-ver {
  flex: none;
  font-size: var(--font-3xs);
  border-radius: 99px;
  padding: 0 6px;
  background: var(--bg-hover);
  color: var(--text-muted);
}
.an-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-fg);
}
.an-time {
  margin-top: 2px;
  font-size: var(--font-3xs);
  color: var(--text-muted);
}
.an-acts {
  margin-top: 5px;
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.an-detail { padding: 6px 0 2px; }
.an-sub {
  font-size: var(--font-3xs);
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 3px;
}
.an-points {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--text-primary);
}
.an-note {
  margin-top: 5px;
  color: var(--text-muted);
}
</style>
