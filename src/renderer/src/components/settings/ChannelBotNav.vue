<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { filterChannelEntries, highlightChannelMatch } from '../../lib/channelSearch'

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
  /** The user's label or display name beside a live handle; '' for none. */
  tag?: string
  /** The bot's slot id and platform id ("bot-2e7877 · id 7421…"). */
  ids?: string
  /** Where it is bound and when it was last active. */
  binding?: string
  /** Running / not linked / pane closed / token invalid; absent when none applies. */
  flag?: { kind: 'ok' | 'off' | 'warn' | 'bad'; text: string }
  /** Every text the search box finds this row by (lib/channelSearch). */
  search?: string[]
  /** Telegram's numeric bot id, which a pasted number is matched against first. */
  botId?: string
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
  /** Show the search box (a list long enough to need one). */
  searchable?: boolean
}>()

const emit = defineEmits<{
  select: [key: string]
  add: []
}>()

const { t } = useI18n()

// Search: rows whose texts contain the query stay, with the hit marked.
const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const total = computed(() => props.groups.reduce((n, g) => n + g.items.length, 0))
const shown = computed<ChannelNavGroup[]>(() => {
  if (!props.searchable || !query.value.trim()) return props.groups
  const items = props.groups.flatMap((g) => g.items.map((item) => ({ group: g.id, item })))
  const kept = new Set(filterChannelEntries(items, query.value,
    (e) => e.item.search ?? [e.item.name], (e) => e.item.botId ?? '').map((e) => e.item.key))
  return props.groups
    .map((g) => ({ ...g, items: g.items.filter((i) => kept.has(i.key)) }))
    .filter((g) => g.items.length)
})
const shownItems = computed(() => shown.value.flatMap((g) => g.items))

function marks(text: string) {
  return highlightChannelMatch(text, props.searchable ? query.value : '')
}

function focusSearch(): void {
  searchInput.value?.focus()
}

function clearSearch(): void {
  query.value = ''
  searchInput.value?.focus()
}

function onSearchKey(e: KeyboardEvent): void {
  if (e.key === 'Escape' && query.value) {
    // Only clearing: an empty box lets Escape close the window as before.
    e.stopPropagation()
    e.preventDefault()
    query.value = ''
    return
  }
  const items = shownItems.value
  if (!items.length) return
  const at = items.findIndex((i) => i.key === props.active)
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const step = e.key === 'ArrowDown' ? 1 : -1
    const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length
    emit('select', items[next].key)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    emit('select', items[Math.max(at, 0)].key)
  }
}

defineExpose({ focusSearch })

// The page can open on a row far down a long list: the picked row stays in sight.
const list = ref<HTMLElement | null>(null)
watch(() => props.active, async (key) => {
  await nextTick()
  list.value?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView?.({ block: 'nearest' })
}, { immediate: true, flush: 'post' })
</script>

<template>
  <nav class="ch-nav" :aria-label="t('channels.bot.list')" data-testid="channel-nav">
    <div v-if="searchable" class="ch-nav-search">
      <input
        ref="searchInput"
        v-model="query"
        type="search"
        class="ch-nav-search-input"
        :placeholder="t('channels.bot.search-placeholder')"
        :aria-label="t('channels.bot.search-placeholder')"
        data-testid="channel-nav-search"
        @keydown="onSearchKey"
      />
      <span v-if="query.trim()" class="ch-nav-search-count" data-testid="channel-nav-search-count">{{ shownItems.length }} / {{ total }}</span>
    </div>
    <div v-if="searchable && query.trim() && !shownItems.length" class="ch-nav-empty" data-testid="channel-nav-search-empty">
      <span>{{ t('channels.bot.search-empty') }}</span>
      <button type="button" class="ch-nav-empty-clear" data-testid="channel-nav-search-clear" @click="clearSearch">{{ t('channels.bot.search-clear') }}</button>
    </div>
    <div v-if="shown.length" ref="list" class="ch-nav-list">
      <template v-for="group in shown" :key="group.id">
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
              <span class="ch-nav-name" v-truncate><template v-for="(part, i) in marks(item.name)" :key="i"><mark v-if="part.hit" class="ch-nav-mark-hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template><span v-if="item.tag" class="ch-nav-tag" data-testid="channel-nav-tag"> · <template v-for="(part, i) in marks(item.tag)" :key="i"><mark v-if="part.hit" class="ch-nav-mark-hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span></span>
              <span v-if="item.flag" class="ch-nav-flag" :class="item.flag.kind" :data-flag="item.flag.kind" data-testid="channel-nav-flag">{{ item.flag.text }}</span>
              <span v-if="item.pending" class="ch-nav-pending" data-testid="channel-nav-pending">{{ t('channels.pending-count', { n: item.pending }) }}</span>
            </span>
            <span v-if="item.ids" class="ch-nav-summary ch-nav-ids" v-truncate data-testid="channel-nav-ids"><template v-for="(part, i) in marks(item.ids)" :key="i"><mark v-if="part.hit" class="ch-nav-mark-hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
            <span v-if="item.binding" class="ch-nav-summary" v-truncate data-testid="channel-nav-binding"><template v-for="(part, i) in marks(item.binding)" :key="i"><mark v-if="part.hit" class="ch-nav-mark-hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
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
.ch-nav-search { flex-shrink: 0; display: flex; align-items: center; gap: 6px; padding: 6px 6px 2px; }
.ch-nav-search-input {
  flex: 1;
  min-width: 0;
  height: var(--control-h-md);
  padding: 0 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-xs);
}
.ch-nav-search-input:focus { outline: none; border-color: var(--accent-muted); }
.ch-nav-search-count { flex-shrink: 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.ch-nav-empty { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 10px; font-size: var(--font-xs); color: var(--text-secondary); }
.ch-nav-empty-clear { border: none; background: transparent; color: var(--accent-fg); font: inherit; cursor: pointer; padding: 0; }
.ch-nav-mark-hit { background: var(--accent-subtle); color: var(--accent-fg); border-radius: 2px; padding: 0 1px; }
.ch-nav-tag { font-weight: 400; color: var(--text-secondary); }
.ch-nav-ids { font-family: var(--font-mono); }
.ch-nav-flag {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 999px;
  font-size: var(--font-2xs);
  font-weight: 600;
  white-space: nowrap;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.ch-nav-flag.ok { background: var(--success-subtle); color: var(--success-fg); }
.ch-nav-flag.warn { background: var(--attention-subtle); color: var(--attention-fg); }
.ch-nav-flag.bad { background: var(--danger-subtle); color: var(--danger-fg); }
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
