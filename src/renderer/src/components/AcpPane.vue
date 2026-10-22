<script setup lang="ts">
// A CLI pane whose agent runs over the Agent Client Protocol: no PTY, no
// xterm. Navide draws the conversation from the backend's acp.* events — the
// agent's messages, its tool calls, its permission requests — and sends what is
// typed here as a prompt. It exposes the same PaneHandle as TerminalPane, so
// App.vue drives both alike (lib/paneHandle.ts).
//
// Text from the agent is shown as text (no HTML is rendered), and the "ACP"
// mark sits in the header the pane draws, where agent output cannot reach.
import { computed, nextTick, onBeforeUnmount, ref, watch, type ShallowUnwrapRef } from 'vue'
import type { TerminalSpawnOptions } from '@navide/terminal'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { paneStatusLabelText } from '../lib/paneStatusLabel'
import { statusBadgeStyle } from '../composables/useStatusBadgePrefs'
import { useAcpSession, type AcpPort } from '../composables/useAcpSession'
import type { PaneHandle } from '../lib/paneHandle'

interface Props {
  paneId: string
  title: string
  agentKey: string
  workspacePath?: string
  isFocus?: boolean
  acpPort: AcpPort
}
const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'set-focus', ev?: MouseEvent): void
  (e: 'context-menu', ev: MouseEvent): void
  (e: 'first-output'): void
}>()

const session = useAcpSession(props.paneId, props.acpPort)
session.onFirstOutput(() => emit('first-output'))
onBeforeUnmount(() => session.dispose())

const draft = ref('')
const lastUserKeyAt = ref(0)
const stopped = ref(false)
const composer = ref<HTMLTextAreaElement | null>(null)
const scroller = ref<HTMLElement | null>(null)

const displayStatus = session.displayStatus
const statusBadgeText = computed(() => paneStatusLabelText(displayStatus.value))
const statusBadgeVars = computed(() => statusBadgeStyle(displayStatus.value))
const live = computed(() => session.state.value === 'idle' || session.state.value === 'running' || session.state.value === 'cancelling')
const canSend = computed(() => live.value && draft.value.trim().length > 0)
const canCancel = computed(() => session.state.value === 'running')
const ended = computed(() => session.state.value === 'exited' || session.state.value === 'failed')

watch(() => session.transcript.length + session.permissions.length, async () => {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
})

async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text || !live.value) return
  draft.value = ''
  stopped.value = false
  await session.prompt(text)
}

function onKeydown(ev: KeyboardEvent): void {
  lastUserKeyAt.value = Date.now()
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault()
    void send()
  }
}

function lastLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
}

const noop = (): void => {}

const handle = {
  display: 'acp' as const,
  spawn: async (opts: TerminalSpawnOptions): Promise<void> => {
    await session.create({ agentKey: opts.agentKey || props.agentKey, cwd: opts.cwd || props.workspacePath || '' })
  },
  interrupt: (): Promise<boolean> => session.cancel(),
  kill: async (_opts?: { force?: boolean; retireRestore?: boolean }): Promise<void> => { await session.kill() },
  focus: (): void => { composer.value?.focus() },
  status: session.status,
  displayStatus,
  awaitingKind: computed<'permission' | 'question' | null>(() => (session.permissions.length > 0 ? 'permission' : null)),
  startingStartedAt: session.startingStartedAt,
  startingAgeMs: computed<number | null>(() => (
    session.startingStartedAt.value === null ? null : Date.now() - session.startingStartedAt.value
  )),
  cancelPendingCreate: async (): Promise<void> => { await session.kill() },
  // No PTY, so never a terminal session id: nothing may send terminal.* for this pane.
  sessionId: ref(''),
  attachedOutputLogFile: ref(''),
  error: computed(() => session.error.value),
  lastCommand: ref(''),
  cleanBuffer: session.text,
  cleanBytesSeen: session.textSeen,
  resumeSpawnedAt: ref(0),
  lastActivityAt: session.lastActivityAt,
  lastRawActivityAt: session.lastActivityAt,
  hasDraft: computed(() => draft.value.trim().length > 0),
  lastUserKeyAt,
  isBracketedPasteActive: (): boolean => false,
  // Voice and the ⌘V path put text in the composer; `submit` sends it as a prompt.
  insertText: (text: string, opts: { submit?: boolean; onSubmit?: (sent: boolean) => void } = {}): boolean => {
    if (!text || !live.value) return false
    draft.value = draft.value ? `${draft.value}${text}` : text
    if (opts.submit) {
      const toSend = draft.value.trim()
      draft.value = ''
      void session.prompt(toSend).then((r) => opts.onSubmit?.(r !== ''))
    }
    return true
  },
  // The terminal's hook- and screen-driven signals: an ACP pane's own events are
  // authoritative, so these change nothing here.
  markTurnComplete: noop,
  markNeedsInput: noop,
  clearNeedsInput: noop,
  holdNeedsInput: (_toolKey: string): void => {},
  releaseNeedsInputHold: noop,
  awaitingHeld: (): { since: number; key: string } => ({ since: 0, key: '' }),
  noteAnswerKeys: (_data: string): void => {},
  permissionWaitLive: (): boolean => session.permissions.length > 0,
  markQuestion: noop,
  clearQuestion: noop,
  markDeliveredPending: noop,
  clearDeliveredPending: (_all?: boolean): void => {},
  noteBackgroundTasks: (_kind: 'start' | 'end', _ids: string[]): void => {},
  hasLiveBackgroundTasks: (): boolean => false,
  // Positions in cleanBuffer (the transcript text), as the terminal's are in its clean buffer.
  markBufferPosition: (): number => session.text.value.length,
  recleanBuffer: noop,
  flushPendingClean: noop,
  readRenderedText: (maxLines: number): string => lastLines(session.text.value, maxLines),
  serializeScrollback: async (): Promise<string> => '',
  setStopped: (value: boolean): void => { stopped.value = value },
}

// Compile-time check: what this pane exposes unwraps to a PaneHandle.
type ExposesPaneHandle = ShallowUnwrapRef<typeof handle> extends PaneHandle ? true : never
const exposesPaneHandle: ExposesPaneHandle = true
void exposesPaneHandle

defineExpose(handle)

const transcript = session.transcript
const permissions = session.permissions
</script>

<template>
  <div
    class="acp-pane"
    :class="{ focused: isFocus }"
    @mousedown.left="emit('set-focus', $event)"
    @contextmenu.prevent="emit('context-menu', $event)"
  >
    <header class="acp-header">
      <span v-truncate class="acp-title">{{ title }}</span>
      <span class="acp-mark" :title="$t('pane.acp.mark-tooltip')">ACP</span>
      <span v-if="stopped" class="acp-stopped">STOP</span>
      <span class="status" :data-status="displayStatus" :style="statusBadgeVars">{{ statusBadgeText }}</span>
    </header>
    <div ref="scroller" class="acp-transcript">
      <div v-for="(entry, i) in transcript" :key="i" class="acp-entry" :data-role="entry.role">
        <template v-if="entry.role === 'tool'">
          <span class="acp-tool">{{ entry.text }}</span>
          <small v-if="entry.status" class="acp-tool-status">{{ entry.status }}</small>
        </template>
        <template v-else>{{ entry.text }}</template>
      </div>
      <div v-for="request in permissions" :key="request.requestId" class="acp-permission" data-testid="acp-permission">
        <p>{{ $t('pane.acp.permission', { title: request.title || '—' }) }}</p>
        <div class="acp-permission-options">
          <button
            v-for="option in request.options"
            :key="option.optionId"
            type="button"
            :data-kind="option.kind"
            @click="session.answer(request.requestId, option.optionId)"
          >{{ option.name }}</button>
        </div>
      </div>
      <div v-if="ended" class="acp-ended" data-testid="acp-ended">
        <p>{{ session.state.value === 'failed'
          ? $t('pane.acp.failed', { reason: session.error.value })
          : $t('pane.acp.exited', { code: session.exitCode.value ?? '—' }) }}</p>
        <pre v-if="session.stderrTail.value">{{ session.stderrTail.value }}</pre>
      </div>
    </div>
    <footer class="acp-composer">
      <textarea
        ref="composer"
        v-model="draft"
        rows="2"
        :placeholder="$t('pane.acp.placeholder')"
        :disabled="!live"
        @keydown="onKeydown"
      />
      <div class="acp-actions">
        <button type="button" :disabled="!canSend" data-testid="acp-send" @click="send">{{ $t('pane.acp.send') }}</button>
        <button v-if="canCancel" type="button" data-testid="acp-cancel" @click="session.cancel()">{{ $t('pane.acp.cancel') }}</button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.acp-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  overflow: hidden;
}
.acp-pane.focused { border-color: var(--accent-focus); }
.acp-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-elevated);
  font-size: var(--font-xs);
}
.acp-title { flex: 1; min-width: 0; font-weight: 600; color: var(--text-primary); }
.acp-mark, .acp-stopped {
  padding: 0 5px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  font-size: var(--font-3xs);
  color: var(--text-secondary);
}
/* The status badge reads exactly like a terminal pane's (TerminalPane.vue). */
.status {
  font-size: var(--font-3xs);
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--status-badge-bg, var(--bg-muted));
  color: var(--status-badge-fg, var(--text-secondary));
}
.status[data-status='running'] {
  background: var(--status-badge-bg, var(--success-muted));
  color: var(--status-badge-fg, var(--success-fg));
}
.status[data-status='starting'] {
  background: var(--status-badge-bg, var(--status-starting-muted));
  color: var(--status-badge-fg, var(--status-starting-fg));
}
.status[data-status='error'] {
  background: var(--status-badge-bg, var(--danger-deep));
  color: var(--status-badge-fg, var(--danger-fg));
}
.status[data-status='exited'] {
  background: var(--status-badge-bg, var(--bg-muted));
  color: var(--status-badge-fg, var(--text-primary));
}
.status[data-status='idle'] {
  background: var(--status-badge-bg, var(--status-idle-muted));
  color: var(--status-badge-fg, var(--status-idle-fg));
}
.status[data-status='awaiting'] {
  background: var(--status-badge-bg, color-mix(in srgb, var(--warning-fg) 20%, transparent));
  color: var(--status-badge-fg, var(--warning-fg));
}
.acp-transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  font-size: var(--font-sm);
  line-height: 1.5;
  color: var(--text-primary);
}
.acp-entry { white-space: pre-wrap; word-break: break-word; margin-bottom: 8px; }
.acp-entry[data-role='user'] { color: var(--text-secondary); border-left: 2px solid var(--border-default); padding-left: 6px; }
.acp-entry[data-role='thought'] { color: var(--text-secondary); font-style: italic; }
.acp-entry[data-role='notice'] { color: var(--danger-fg); }
.acp-tool { font-size: var(--font-xs); }
.acp-tool-status { margin-left: 6px; color: var(--text-secondary); }
.acp-permission {
  border: 1px solid var(--warning-fg);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  margin-bottom: 8px;
}
.acp-permission-options { display: flex; flex-wrap: wrap; gap: 6px; }
.acp-ended { color: var(--text-secondary); }
.acp-ended pre { white-space: pre-wrap; font-size: var(--font-2xs); }
.acp-composer {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid var(--border-muted);
}
.acp-composer textarea { flex: 1; resize: none; font: inherit; }
.acp-actions { display: flex; flex-direction: column; gap: 4px; }
</style>
