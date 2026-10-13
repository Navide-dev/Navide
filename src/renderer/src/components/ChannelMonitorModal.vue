<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { i18n, vTruncate } from '@navide/plugin-ui/foundation'
import type { ChannelBinding, ChannelsStore } from '../composables/useChannels'

/**
 * In-app overlay listing every pane↔channel link with its live status. Rows
 * come from the shared channels store, which the backend's channels.* events
 * already keep current, so this adds no polling of its own.
 */
const props = defineProps<{
  open: boolean
  store: ChannelsStore
  /** Display name for a pane id; the caller owns pane naming. */
  paneLabel: (paneId: string) => string
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'focus-pane', paneId: string): void
}>()

const t = i18n.global.t

interface Row {
  binding: ChannelBinding
  pane: string
  channel: string
  status: string
  tone: 'ok' | 'warn' | 'err' | 'idle'
}

interface Group extends Row {
  /** Topics the backend auto-created for this pane's descendants; they go with its binding. */
  children: Row[]
}

function toRow(binding: ChannelBinding): Row {
  const state = props.store.accountState(binding.platform, binding.account)
  const lifecycle = state?.status.lifecycle ?? 'stopped'
  let status: string
  let tone: Row['tone']
  if (state && !state.enabled) {
    status = t('channels.status.disabled')
    tone = 'idle'
  } else {
    status = t(`channels.lifecycle.${lifecycle}`)
    tone = lifecycle === 'ready' ? 'ok' : lifecycle === 'blocked' ? 'err' : lifecycle === 'stopped' ? 'idle' : 'warn'
  }
  const platformName = t(`channels.platform.${binding.platform}`)
  return {
    binding,
    pane: props.paneLabel(binding.pane_id),
    channel: binding.title ? `${platformName} · ${binding.title}` : platformName,
    status,
    tone,
  }
}

// An auto binding's parent may itself be an auto child (a grandchild pane), so each one
// is filed under the manual binding at the top of its parent chain. One whose chain
// breaks is only there until the backend releases it, and stays a row of its own.
const groups = computed<Group[]>(() => {
  const all = props.store.bindings.value
  const byPane = new Map(all.map((b) => [b.pane_id, b]))
  const rootOf = (b: ChannelBinding): ChannelBinding | undefined => {
    const seen = new Set<string>()
    let cur: ChannelBinding | undefined = b
    while (cur?.auto && cur.parent_pane_id && !seen.has(cur.pane_id)) {
      seen.add(cur.pane_id)
      cur = byPane.get(cur.parent_pane_id)
    }
    return cur && !cur.auto ? cur : undefined
  }
  const children = new Map<string, Row[]>()
  const tops: ChannelBinding[] = []
  for (const b of all) {
    const root = b.auto ? rootOf(b) : undefined
    if (root) children.set(root.pane_id, [...(children.get(root.pane_id) ?? []), toRow(b)])
    else tops.push(b)
  }
  return tops.map((b) => ({ ...toRow(b), children: children.get(b.pane_id) ?? [] }))
})

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && props.open) emit('close')
}
watch(
  () => props.open,
  (open) => {
    if (open) window.addEventListener('keydown', onKeyDown)
    else window.removeEventListener('keydown', onKeyDown)
  },
  { immediate: true }
)
onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))

function disconnect(row: Row): void {
  void props.store.unbind(row.binding.pane_id, row.pane)
}
</script>

<template>
  <div v-if="open" class="s-overlay nv-modal-overlay cmon-overlay" data-testid="channel-monitor" @click.self="emit('close')">
    <div class="cmon-modal nv-modal-shell" role="dialog" aria-modal="true" :aria-label="t('channels.monitor.title')">
      <button
        class="cmon-close"
        type="button"
        data-testid="channel-monitor-close"
        :title="t('channels.monitor.close')"
        @click="emit('close')"
      >✕</button>

      <header class="cmon-head">
        <span class="cmon-mark" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.7 8.7 0 0 1-3.8-.9L3 21l1.8-5.1a8.1 8.1 0 0 1-.8-3.6A8.4 8.4 0 0 1 12.5 4 8.4 8.4 0 0 1 21 11.5z" />
            <path d="M8.5 12h.01M12.5 12h.01M16.5 12h.01" />
          </svg>
        </span>
        <div class="cmon-head-text">
          <h1 class="cmon-title">{{ t('channels.monitor.title') }}</h1>
          <p class="cmon-tagline">{{ t('channels.monitor.tagline') }}</p>
        </div>
      </header>

      <p v-if="!groups.length" class="cmon-empty" data-testid="channel-monitor-empty">{{ t('channels.monitor.empty') }}</p>
      <ul v-else class="cmon-list">
        <li v-for="row in groups" :key="row.binding.pane_id" class="cmon-item">
          <div class="cmon-row" data-testid="channel-monitor-row">
            <button
              class="cmon-go"
              type="button"
              data-testid="channel-monitor-go"
              :title="t('channels.monitor.go-to', { pane: row.pane })"
              @click="emit('focus-pane', row.binding.pane_id)"
            >
              <span class="cmon-dot" :class="row.tone"></span>
              <span class="cmon-text">
                <span class="cmon-pane" v-truncate>{{ row.pane }}</span>
                <span class="cmon-channel" v-truncate>{{ row.channel }}</span>
              </span>
              <span class="cmon-status" :class="row.tone">{{ row.status }}</span>
            </button>
            <button
              class="cmon-unlink"
              type="button"
              data-testid="channel-monitor-unlink"
              :aria-label="t('channels.monitor.disconnect-label', { pane: row.pane, channel: row.channel })"
              @click="disconnect(row)"
            >{{ t('channels.monitor.disconnect') }}</button>
          </div>
          <ul v-if="row.children.length" class="cmon-children">
            <li v-for="child in row.children" :key="child.binding.pane_id" class="cmon-row cmon-child" data-testid="channel-monitor-child">
              <button
                class="cmon-go"
                type="button"
                data-testid="channel-monitor-go"
                :title="t('channels.monitor.go-to', { pane: child.pane })"
                @click="emit('focus-pane', child.binding.pane_id)"
              >
                <span class="cmon-dot" :class="child.tone"></span>
                <span class="cmon-text">
                  <span class="cmon-pane" v-truncate>{{ child.pane }}</span>
                  <span class="cmon-channel" v-truncate>{{ child.channel }}</span>
                </span>
                <span class="cmon-auto" :title="t('channels.monitor.auto-child-hint')">{{ t('channels.monitor.auto-child') }}</span>
                <span class="cmon-status" :class="child.tone">{{ child.status }}</span>
              </button>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.s-overlay {
  position: fixed;
  inset: 0;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  z-index: calc(var(--z-modal) + 120);
  display: flex;
  align-items: center;
  justify-content: center;
  -webkit-app-region: no-drag;
}
.cmon-modal {
  position: relative;
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-lg);
  width: min(520px, 92vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-modal);
  font-size: 13px;
  line-height: 1.6;
}
.cmon-close {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 30;
  border: none;
  background: var(--bg-base);
  color: var(--text-secondary);
  font-size: var(--font-lg);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: var(--radius-control);
  line-height: 1;
}
.cmon-close:hover { background: var(--bg-muted); color: var(--text-bright); }
.cmon-close:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.cmon-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 56px 16px 22px;
  background: color-mix(in srgb, var(--done-fg) 9%, var(--bg-base));
  border-bottom: 2px solid color-mix(in srgb, var(--done-fg) 35%, transparent);
}
.cmon-mark {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 12px 12px 12px 4px;
  background: var(--done-fg);
  color: var(--bg-base);
}
.cmon-head-text { min-width: 0; }
.cmon-title { margin: 0; font-size: 17px; font-weight: 600; }
.cmon-tagline { margin: 2px 0 0; color: var(--text-secondary); }
.cmon-empty { margin: 0; padding: 28px; text-align: center; color: var(--text-secondary); }
.cmon-list { list-style: none; margin: 0; padding: 12px 16px 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.cmon-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-right: 8px;
  border: 1px solid var(--border-muted);
  border-left: 3px solid var(--text-secondary);
  border-radius: var(--radius-control);
  background: var(--bg-subtle);
}
.cmon-row:has(.cmon-dot.ok) { border-left-color: var(--success-fg); }
.cmon-row:has(.cmon-dot.warn) { border-left-color: var(--attention-fg); }
.cmon-row:has(.cmon-dot.err) { border-left-color: var(--danger-fg); }
.cmon-go {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-control);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cmon-go:hover { background: var(--bg-hover); }
.cmon-go:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.cmon-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.cmon-pane, .cmon-channel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cmon-channel { color: var(--text-secondary); font-size: 12px; }
.cmon-dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--text-secondary); }
.cmon-dot.ok { background: var(--success-fg); }
.cmon-dot.warn { background: var(--attention-fg); }
.cmon-dot.err { background: var(--danger-fg); }
.cmon-status { flex-shrink: 0; font-size: 12px; color: var(--text-secondary); }
.cmon-status.ok { color: var(--success-fg); }
.cmon-status.warn { color: var(--attention-fg); }
.cmon-status.err { color: var(--danger-fg); }
.cmon-unlink {
  flex-shrink: 0;
  padding: 4px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.cmon-unlink:hover { background: var(--bg-muted); color: var(--danger-fg); }
.cmon-unlink:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 2px; }
.cmon-item { display: flex; flex-direction: column; gap: 4px; }
.cmon-children { list-style: none; margin: 0 0 0 18px; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.cmon-child { padding-right: 0; }
.cmon-auto {
  flex-shrink: 0;
  padding: 1px 6px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-control);
  color: var(--text-secondary);
  font-size: 11px;
}
</style>
