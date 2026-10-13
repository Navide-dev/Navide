<script setup lang="ts">
// Messages tab of the right-hand rail: the inter-CLI delivery log.
//
// Laid out for a ~300px column (the rail is resizable down to 180px): the route
// gets a line of its own and wraps rather than clipping (with both handles
// qualified, `from → to` does not survive one ellipsised line), then a meta
// line, then the preview. The message body lives in an expandable detail block
// that scrolls instead of widening the rail.
import { computed, ref } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useI18n } from 'vue-i18n'
import { AGENT_SPECS } from '@navide/plugin-shell'
import {
  useAgentMessaging,
  type AgentMessage,
  type MessageReason,
} from '../composables/useAgentMessaging'

const AGENT_LABELS = new Map(AGENT_SPECS.map((s) => [s.agentKey, s.label]))

const messaging = useAgentMessaging()
const { t } = useI18n()

const expandedId = ref<number | null>(null)

// Newest first for the log list.
const rows = computed(() => [...messaging.messages.value].reverse())

// Rows by uid, so a reply can name the message it answers without scanning the
// whole log once per row.
const byUid = computed(() => new Map(messaging.messages.value.map((m) => [m.uid, m])))

/** The message a reply answers, when it is still in the log. */
function repliedTo(msg: AgentMessage): AgentMessage | undefined {
  return msg.inReplyTo ? byUid.value.get(msg.inReplyTo) : undefined
}

/** The push channel a message went out through, or '' when it was typed in.
 *  The kind is the backend's own label and is shown verbatim — inventing a
 *  friendlier word per mechanism would leave the log unable to say which one a
 *  row actually used. */
function pushKind(msg: AgentMessage): string {
  return msg.route?.startsWith('push:') ? msg.route.slice('push:'.length) : ''
}

/** Channel kinds whose push writes the CLI's composer. Keyed on the mechanism
 *  rather than the vendor because the mechanism is what the route records, and
 *  it is the mechanism that decides the fact worth telling: those panes still
 *  hold a message while someone is typing in them, and the others do not. */
const KINDS_WRITING_INPUT_BOX = new Set(['tui-http'])

function pushBadgeTitleKey(msg: AgentMessage): string {
  return KINDS_WRITING_INPUT_BOX.has(pushKind(msg))
    ? 'msg.push-badge-title-box'
    : 'msg.push-badge-title-direct'
}

function toggleExpand(id: number): void {
  expandedId.value = expandedId.value === id ? null : id
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString()
}

/** A failure reason is stored as an i18n key plus its substitutions, so the log
 *  reads in the user's language whichever layer produced the failure. */
function reasonText(reason: MessageReason): string {
  return t(`msg.reason-${reason.key}`, reason.params ?? {})
}

/** Split a handle into its `<workspace>/` prefix and the pane name. The pane
 *  name is the identifying half, so it is rendered at full contrast and the
 *  prefix is dimmed. */
function splitHandle(handle: string): { ws: string | null; name: string } {
  const cut = handle.lastIndexOf('/')
  return cut === -1
    ? { ws: null, name: handle }
    : { ws: handle.slice(0, cut), name: handle.slice(cut + 1) }
}

/** Which CLI a party is, as the vendor label used everywhere else in the app.
 *
 *  Suppressed when the handle is still the auto-assigned `<agentKey>-<n>`,
 *  which already names the vendor — "claude-1 (Claude Code)" says it twice.
 *  Unknown agentKey (or none: an external MCP client, or a row restored from
 *  before vendors were recorded) shows no vendor rather than a guess. */
function vendorOf(agentKey: string | undefined, handle: string): string | null {
  if (!agentKey) return null
  const label = AGENT_LABELS.get(agentKey)
  if (!label) return null
  const name = splitHandle(handle).name.toLowerCase()
  const autoPrefix = `${agentKey.toLowerCase()}-`
  const isAutoName = name.startsWith(autoPrefix) && /^\d+$/.test(name.slice(autoPrefix.length))
  return isAutoName ? null : label
}
</script>

<template>
  <div class="msg-panel">
    <div class="msg-bar">
      <span class="msg-title" v-truncate>{{ $t('msg.panel-title') }}</span>
      <span class="msg-acts">
        <button
          class="msg-btn"
          data-act="pause"
          @click="messaging.paused.value ? messaging.resumeMessaging() : messaging.pauseMessaging()"
        >
          {{ messaging.paused.value ? $t('msg.resume') : $t('msg.pause') }}
        </button>
        <button class="msg-btn" data-act="clear" @click="messaging.clearMessageLog()">
          {{ $t('msg.clear-log') }}
        </button>
      </span>
    </div>

    <div v-if="messaging.paused.value" class="msg-paused">{{ $t('msg.paused-banner') }}</div>

    <div class="msg-list">
      <div v-if="rows.length === 0" class="msg-empty">{{ $t('msg.empty') }}</div>
      <div
        v-for="msg in rows"
        :key="msg.id"
        class="msg-row"
        :class="{ expanded: expandedId === msg.id }"
        :data-msg-id="msg.id"
        @click="toggleExpand(msg.id)"
      >
        <div class="msg-route" :title="`${msg.from} → ${msg.to}`">
          <span class="msg-party msg-from">
            <span v-if="vendorOf(msg.fromAgent, msg.from)" class="msg-vendor"
              >{{ vendorOf(msg.fromAgent, msg.from) }} ·
            </span>
            <span v-if="splitHandle(msg.from).ws" class="msg-ws">{{ splitHandle(msg.from).ws }}/</span
            ><span class="msg-name">{{ splitHandle(msg.from).name }}</span>
          </span>
          <span class="msg-arrow">→</span>
          <span class="msg-party msg-to">
            <span v-if="vendorOf(msg.toAgent, msg.to)" class="msg-vendor"
              >{{ vendorOf(msg.toAgent, msg.to) }} ·
            </span>
            <span v-if="splitHandle(msg.to).ws" class="msg-ws">{{ splitHandle(msg.to).ws }}/</span
            ><span class="msg-name">{{ splitHandle(msg.to).name }}</span>
          </span>
        </div>
        <div class="msg-meta">
          <span class="msg-time">{{ fmtTime(msg.createdAt) }}</span>
          <span class="msg-st" :data-st="msg.status">{{ $t(`msg.status-${msg.status}`) }}</span>
          <span v-if="msg.remote" class="msg-xws" :title="msg.remoteWorkspace">
            {{ $t('msg.cross-workspace-badge') }}
          </span>
          <span v-if="msg.inReplyTo" class="msg-reply" :title="repliedTo(msg)?.content">
            {{ $t('msg.reply-badge') }}
          </span>
          <span v-if="msg.route === 'hook'" class="msg-route" :title="$t('msg.hook-badge-title')">
            {{ $t('msg.hook-badge') }}
          </span>
          <span
            v-else-if="pushKind(msg)"
            class="msg-route"
            :title="$t(pushBadgeTitleKey(msg))"
          >
            {{ $t('msg.push-badge', { kind: pushKind(msg) }) }}
          </span>
          <span v-if="msg.kind === 'notice'" class="msg-notice">
            {{ $t('msg.notice-badge') }}
          </span>
          <span v-else-if="msg.kind === 'ack'" class="msg-notice">
            {{ $t('msg.ack-badge') }}
          </span>
          <!-- Only while it is still waiting: once a row is `delivering` the
               envelope is being written into the pane and there is nothing left
               to take back. -->
          <button
            v-if="msg.status === 'queued'"
            class="msg-btn msg-act"
            data-act="cancel"
            :title="$t('msg.cancel-title')"
            @click.stop="messaging.cancelMessage(msg.id)"
          >
            {{ $t('msg.cancel') }}
          </button>
          <!-- No Resend on a notice: it only reports another row's failure, so
               re-sending it would deliver stale news, and the row it is about
               has its own Resend. None on an ack either: retryMessage() drops
               `kind`, so re-sending one would type into the pane the ack was
               written never to touch. -->
          <button
            v-else-if="
              (msg.status === 'failed' || msg.status === 'cancelled') &&
              msg.kind !== 'notice' &&
              msg.kind !== 'ack'
            "
            class="msg-btn msg-act"
            data-act="retry"
            @click.stop="messaging.retryMessage(msg.id)"
          >
            {{ $t('msg.retry') }}
          </button>
        </div>
        <div class="msg-preview" v-truncate>{{ msg.content }}</div>
        <!-- Why this row is where it is, without having to expand it. -->
        <div v-if="msg.reason" class="msg-reason" v-truncate>
          {{ reasonText(msg.reason) }}
        </div>
        <div v-else-if="msg.hold" class="msg-hold" v-truncate>
          {{ $t(`msg.hold-${msg.hold.key}`, { n: msg.hold.n ?? 0 }) }}
        </div>
        <div v-else-if="msg.deliveredWhileBusy" class="msg-hold" v-truncate>
          {{ $t('msg.delivered-while-busy') }}
        </div>
        <div v-if="expandedId === msg.id" class="msg-detail">
          <pre>{{ msg.content }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.msg-panel {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.msg-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: none;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);
}

.msg-title {
  min-width: 0;
  font-size: var(--font-2xs);
  font-weight: 700;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.msg-acts {
  display: flex;
  /* At the rail's 180px minimum the two labels stack rather than clip. */
  flex-wrap: wrap;
  gap: 4px;
}

.msg-btn {
  background: rgba(128, 128, 128, 0.12);
  color: var(--text-primary);
  border: 1px solid rgba(128, 128, 128, 0.25);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: var(--font-3xs);
  cursor: pointer;
}

.msg-btn:hover { background: rgba(128, 128, 128, 0.22); }
.msg-btn:disabled { opacity: 0.45; cursor: default; }

.msg-paused {
  flex: none;
  padding: 4px 10px;
  font-size: var(--font-3xs);
  background: rgba(230, 160, 60, 0.15);
  color: #e8a54b;
  border-bottom: 1px solid rgba(230, 160, 60, 0.25);
}

.msg-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.msg-empty {
  padding: 20px 10px;
  text-align: center;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}

.msg-row {
  padding: 5px 10px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
  cursor: pointer;
}

.msg-row:hover { background: rgba(128, 128, 128, 0.08); }

.msg-route {
  display: flex;
  align-items: baseline;
  /* Wraps rather than clips: with both handles qualified, `from → to` cannot
     survive one ellipsised line at this width, and the route is the one part of
     a row that has to stay readable. */
  flex-wrap: wrap;
  gap: 0 4px;
  min-width: 0;
  font-size: var(--font-2xs);
  font-weight: 600;
  color: var(--text-primary);
}

.msg-party {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* The pane name identifies the party; the CLI vendor and workspace prefix are
   context, so they recede the same way. */
.msg-ws,
.msg-vendor {
  font-weight: 400;
  color: var(--text-secondary);
}

.msg-arrow {
  flex: none;
  color: var(--text-secondary);
}

.msg-meta {
  display: flex;
  align-items: center;
  /* The badges don't shrink; let them drop to another line instead of being
     clipped when the rail is near its 180px minimum. */
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
  margin-top: 3px;
}

.msg-time {
  flex: none;
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}

.msg-st {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  border-radius: 99px;
  padding: 0 6px;
  white-space: nowrap;
}

.msg-xws {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  border-radius: 99px;
  padding: 0 6px;
  white-space: nowrap;
  background: rgba(110, 150, 230, 0.18);
  color: #7ba3e8;
}

.msg-reply {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  border-radius: 99px;
  padding: 0 6px;
  white-space: nowrap;
  background: rgba(140, 190, 140, 0.18);
  color: #7cb37c;
}

.msg-route {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  border-radius: 99px;
  padding: 0 6px;
  white-space: nowrap;
  background: rgba(160, 140, 220, 0.18);
  color: #a08cdc;
}

.msg-notice {
  flex: none;
  font-size: 9px;
  font-weight: 700;
  border-radius: 99px;
  padding: 0 6px;
  white-space: nowrap;
  background: rgba(200, 160, 90, 0.18);
  color: #c8a05a;
}

.msg-st[data-st='queued'] { background: rgba(128, 128, 128, 0.18); color: var(--text-secondary); }
.msg-st[data-st='delivering'] { background: rgba(230, 160, 60, 0.18); color: #e8a54b; }
.msg-st[data-st='delivered'] { background: rgba(80, 190, 100, 0.18); color: #4fae5f; }
.msg-st[data-st='failed'] { background: rgba(220, 80, 70, 0.18); color: #e0706a; }
/* Withdrawn on purpose, so it recedes rather than alarming like a failure. */
.msg-st[data-st='cancelled'] {
  background: rgba(128, 128, 128, 0.12);
  color: var(--text-secondary);
  text-decoration: line-through;
}

/* Pushed to the row's trailing edge so the badges stay grouped on the left. */
.msg-act {
  margin-left: auto;
  font-size: 9px;
  padding: 0 5px;
}

.msg-preview,
.msg-reason,
.msg-hold {
  min-width: 0;
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-3xs);
}

.msg-preview { color: var(--text-secondary); }

.msg-detail { padding: 6px 0 2px; }

.msg-detail pre {
  margin: 0;
  padding: 6px 8px;
  background: rgba(128, 128, 128, 0.1);
  border-radius: 4px;
  font-size: var(--font-3xs);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 220px;
  overflow-y: auto;
  color: var(--text-primary);
}

.msg-reason { color: #e0706a; }

.msg-hold {
  color: var(--text-secondary);
  font-style: italic;
}

:root[data-theme='light'] .msg-bar,
:root[data-theme='light'] .msg-row {
  border-bottom-color: rgba(31, 35, 40, 0.15);
}
</style>
