<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'

/** One row of the bot list: a bot, or the entries that have no bot. */
export interface ChannelNavItem {
  key: string
  badge: string
  name: string
  /** Connection tone; '' draws no status dot. */
  tone: string
  status: string
  summary: string
  pending: number
}

/** The bots of one platform; `label` is '' while there is only one platform to tell apart. */
export interface ChannelNavGroup {
  id: string
  label: string
  items: ChannelNavItem[]
}

/**
 * The left column of Settings → Channels: every bot with its platform, state,
 * people, chats and waiting requests, grouped by platform when there are several,
 * and the way to add another under the list. Picking a row shows it on the right.
 */
const props = defineProps<{
  groups: ChannelNavGroup[]
  active: string
  addActive: boolean
}>()

const emit = defineEmits<{
  select: [key: string]
  add: []
}>()

const { t } = useI18n()

// The page can open on a row far down a long list: the picked row stays in sight.
const list = ref<HTMLElement | null>(null)
watch(() => props.active, async (key) => {
  await nextTick()
  list.value?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView?.({ block: 'nearest' })
}, { immediate: true, flush: 'post' })
</script>

<template>
  <nav class="ch-nav" :aria-label="t('channels.bot.list')" data-testid="channel-nav">
    <div v-if="groups.length" ref="list" class="ch-nav-list">
      <template v-for="group in groups" :key="group.id">
        <div v-if="group.label" class="ch-nav-group" data-testid="channel-nav-group">{{ group.label }}</div>
        <button
          v-for="item in group.items"
          :key="item.key"
          type="button"
          class="ch-nav-item"
          :class="{ active: item.key === active }"
          :aria-current="item.key === active ? 'true' : undefined"
          :data-key="item.key"
          data-testid="channel-nav-item"
          @click="emit('select', item.key)"
        >
          <span class="ch-nav-mark" aria-hidden="true">
            {{ item.badge }}
            <span
              v-if="item.tone"
              class="ch-nav-dot"
              :class="item.tone"
              :data-tone="item.tone"
              :title="item.status"
              data-testid="channel-nav-status"
            ></span>
          </span>
          <span class="ch-nav-text">
            <span class="ch-nav-title">
              <span class="ch-nav-name" v-truncate>{{ item.name }}</span>
              <span v-if="item.pending" class="ch-nav-pending" data-testid="channel-nav-pending">{{ t('channels.pending-count', { n: item.pending }) }}</span>
            </span>
            <span class="ch-nav-summary" v-truncate data-testid="channel-nav-summary">{{ item.summary }}</span>
          </span>
        </button>
      </template>
    </div>
    <button
      type="button"
      class="ch-nav-add"
      :class="{ active: addActive }"
      :aria-current="addActive ? 'true' : undefined"
      data-testid="channel-nav-add"
      @click="emit('add')"
    >＋ {{ t('channels.bot.add') }}</button>
  </nav>
</template>

<style scoped>
.ch-nav {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--settings-card-border, var(--border-default));
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  overflow: hidden;
}
.ch-nav-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; padding: 4px; gap: 1px; }
.ch-nav-group {
  padding: 10px 8px 4px;
  font-size: var(--font-2xs);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.ch-nav-group:first-child { padding-top: 6px; }
.ch-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.ch-nav-item:hover { background: var(--bg-muted); }
.ch-nav-item.active { background: var(--accent-subtle); }
.ch-nav-mark {
  position: relative;
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  font-weight: 700;
  letter-spacing: 0.02em;
}
.ch-nav-item.active .ch-nav-mark { color: var(--accent-fg); border-color: var(--accent-muted); }
.ch-nav-dot {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 2px solid var(--bg-subtle);
  box-sizing: content-box;
  background: var(--text-muted);
}
.ch-nav-dot.ok { background: var(--success-fg); }
.ch-nav-dot.warn { background: var(--attention-fg); }
.ch-nav-dot.bad { background: var(--danger-fg); }
.ch-nav-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ch-nav-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ch-nav-name { flex: 1; min-width: 0; font-size: var(--font-xs); font-weight: 600; color: var(--text-bright); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-nav-summary { font-size: var(--font-2xs); color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-nav-pending {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-size: var(--font-2xs);
  font-weight: 600;
  white-space: nowrap;
}
.ch-nav-add {
  flex-shrink: 0;
  min-height: var(--control-h-md);
  padding: 8px 12px;
  border: none;
  border-top: 1px solid var(--settings-card-divider, var(--border-muted));
  background: transparent;
  color: var(--accent-fg);
  font: inherit;
  font-size: var(--font-xs);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.ch-nav-add:hover, .ch-nav-add.active { background: var(--accent-subtle); }
</style>
