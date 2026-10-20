<script setup lang="ts">
// The Messages panel, drawn rather than captured: the title bar with its two
// text buttons, then one row per message — the from → to route, the time and
// status pill, an optional cross-workspace badge, and the content preview.
//
// Mirrors AgentMessagesPanel.vue: `.msg-panel` with `.msg-bar` holding the
// title and the Pause delivery / Clear log buttons (:99), and a `.msg-row`
// made of `.msg-route` (`.msg-party` → `.msg-arrow` → `.msg-party`, :128),
// `.msg-meta` (`.msg-time`, the `.msg-st[data-st]` pill, `.msg-xws` badge,
// :144) and `.msg-preview` (:198). The real pill uses the theme's status
// tokens, and the same four states map onto them here so the picture follows
// the user's theme.
defineProps<{
  title: string
  /** The two text buttons on the title bar, in the order it draws them. */
  actions: string[]
  rows: {
    /** Workspace prefix on the sender, when the message crossed one. */
    fromWs?: string
    from: string
    toWs?: string
    to: string
    time: string
    status: 'queued' | 'delivering' | 'delivered' | 'failed'
    statusLabel: string
    /** Cross-workspace badge text; omit for a same-workspace row. */
    badge?: string
    preview: string
  }[]
  mark?: string
}>()
</script>

<template>
  <div class="mk-msglog">
    <div class="mk-msglog-bar">
      <span class="mk-msglog-title">{{ title }}</span>
      <span class="mk-msglog-gap" />
      <span v-for="action in actions" :key="action" class="mk-msglog-btn">{{ action }}</span>
      <span v-if="mark" class="mk-msglog-mark">{{ mark }}</span>
    </div>

    <div class="mk-msglog-list">
      <div v-for="row in rows" :key="row.preview" class="mk-msglog-row">
        <div class="mk-msglog-route">
          <span class="mk-msglog-party">
            <span v-if="row.fromWs" class="mk-msglog-ws">{{ row.fromWs }}/</span>{{ row.from }}
          </span>
          <span class="mk-msglog-arrow" aria-hidden="true">→</span>
          <span class="mk-msglog-party">
            <span v-if="row.toWs" class="mk-msglog-ws">{{ row.toWs }}/</span>{{ row.to }}
          </span>
        </div>
        <div class="mk-msglog-meta">
          <span class="mk-msglog-time">{{ row.time }}</span>
          <span class="mk-msglog-st" :data-st="row.status">{{ row.statusLabel }}</span>
          <span v-if="row.badge" class="mk-msglog-xws">{{ row.badge }}</span>
        </div>
        <div class="mk-msglog-preview">{{ row.preview }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mk-msglog {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  overflow: hidden;
  min-width: 0;
}

.mk-msglog-bar {
  display: flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.4em 0.55em;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
  overflow: hidden;
}
.mk-msglog-title { color: var(--text-bright); font-weight: 600; white-space: nowrap; }
.mk-msglog-gap { flex: 1; }
.mk-msglog-btn {
  flex: none;
  padding: 0.1em 0.45em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  color: var(--text-secondary);
  white-space: nowrap;
}
.mk-msglog-mark { flex: none; color: var(--accent-fg); font-size: 1.1em; }

.mk-msglog-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.mk-msglog-row {
  display: flex;
  flex-direction: column;
  gap: 0.2em;
  padding: 0.45em 0.55em;
  border-bottom: 1px solid var(--border-muted);
  min-width: 0;
}
.mk-msglog-row:last-child { border-bottom: none; }

.mk-msglog-route {
  display: flex;
  align-items: baseline;
  gap: 0.35em;
  min-width: 0;
  color: var(--text-bright);
  white-space: nowrap;
  overflow: hidden;
}
.mk-msglog-party { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.mk-msglog-ws { color: var(--text-muted); }
.mk-msglog-arrow { flex: none; color: var(--text-muted); }

.mk-msglog-meta {
  display: flex;
  align-items: center;
  gap: 0.4em;
  min-width: 0;
  flex-wrap: wrap;
}
.mk-msglog-time { color: var(--text-muted); font-size: 0.9em; }
.mk-msglog-st {
  padding: 0 0.45em;
  border-radius: 999px;
  font-size: 0.85em;
  background: var(--bg-muted);
  color: var(--text-secondary);
}
.mk-msglog-st[data-st='delivering'] {
  background: color-mix(in srgb, var(--warning-fg) 18%, transparent);
  color: var(--warning-fg);
}
.mk-msglog-st[data-st='delivered'] {
  background: var(--success-muted);
  color: var(--success-fg);
}
.mk-msglog-st[data-st='failed'] {
  background: color-mix(in srgb, var(--danger-fg) 18%, transparent);
  color: var(--danger-fg);
}
.mk-msglog-xws {
  padding: 0 0.45em;
  border-radius: 999px;
  font-size: 0.85em;
  background: var(--accent-subtle);
  color: var(--accent-fg);
  white-space: nowrap;
}

.mk-msglog-preview {
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
