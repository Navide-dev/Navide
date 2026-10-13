<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { CliRiskContext } from '../composables/useResourceUsage'
import type { CliRiskAction, CliRiskHistoryRow, CliRiskPaneState, CliRiskSignal } from '../lib/cliRisk'
import { buildCliRiskAnalysisPrompt, cliRiskAnalysisPaneName, type CliRiskAnalysisSpawn } from '../lib/cliRiskAnalysisPrompt'

const props = defineProps<{
  paneId: string
  state?: CliRiskPaneState
  available?: boolean
  compact?: boolean
  act: CliRiskContext['actOnCliRisk']
  /** Observed pane's CLI vendor; the analysis pane runs the same vendor. */
  agentKey?: string
  workspacePath?: string
  /** Spawns the "Analyze with CLI" pane; the analyze buttons hide without it. */
  spawn?: CliRiskAnalysisSpawn
}>()

const t = i18n.global.t
// Shared-CDN endpoints are record-only: shown in the dialog, never the pill.
const first = computed(() => props.state?.signals.find((signal) => !signal.sharedCdn))
const open = ref(false)
const badgeRef = ref<HTMLButtonElement | null>(null)
const popRef = ref<HTMLElement | null>(null)
const popStyle = ref({ top: '0px', left: '0px' })
const pending = ref(false)
const error = ref('')
const dialogId = computed(() => `cli-risk-${props.paneId}`)

function endpoint(signal: CliRiskSignal): string {
  const ip = signal.ip ?? t('cli-risk.unknown-value')
  if (signal.port === undefined) return ip
  return `${ip.includes(':') ? `[${ip}]` : ip}:${signal.port}`
}

function size(signal: CliRiskSignal): string {
  return signal.bytes === undefined
    ? t('cli-risk.unknown-value')
    : `${(signal.bytes / (1024 * 1024)).toLocaleString(i18n.global.locale.value, { maximumFractionDigits: 1 })} MiB`
}

function heading(signal: CliRiskSignal): string {
  if (signal.kind === 'network') return t('cli-risk.network-title')
  return t(signal.severity === 'red' ? 'cli-risk.disk-again-title' : 'cli-risk.disk-title')
}

function label(signal: CliRiskSignal): string {
  return signal.kind === 'network'
    ? endpoint(signal)
    : t(signal.severity === 'red' ? 'cli-risk.disk-again-pill' : 'cli-risk.disk-pill', {
        size: size(signal), path: signal.path ?? t('cli-risk.unknown-value'),
      })
}

function processLabel(process: { pid: number; name: string | null }): string {
  return `${process.name ?? t('cli-risk.unknown-value')}(${process.pid})`
}

/** The command line is kept for the latest observation only; older rows name the pid. */
function listenerLabel(signal: CliRiskSignal, listener: NonNullable<CliRiskHistoryRow['listener']>): string {
  if (listener.status !== 'resolved') return t('cli-risk.listener-unknown')
  const name = listener.name ?? t('cli-risk.unknown-value')
  const command = signal.listener?.status === 'resolved' && signal.listener.pid === listener.pid
    ? signal.listener.command
    : null
  return command ? `${name} (pid ${listener.pid}, ${command})` : `${name} (pid ${listener.pid})`
}

function clock(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString(i18n.global.locale.value, { hour12: false })
}

/** One line per observation across every signal, newest first. */
const consoleLines = computed(() => {
  const lines: { key: string; at: string; text: string }[] = []
  for (const signal of props.state?.signals ?? []) {
    if (signal.kind !== 'network') {
      const path = signal.path ?? t('cli-risk.unknown-value')
      lines.push({ key: signal.id, at: signal.lastObservedAt, text: `${heading(signal)}  ${size(signal)}  ${path}` })
      continue
    }
    // Signals recorded before attribution existed have no history.
    const rows: CliRiskHistoryRow[] = signal.history?.length
      ? signal.history
      : [{ at: signal.lastObservedAt, connections: signal.connections ?? 0, local: signal.local ?? [], listener: signal.listener }]
    rows.forEach((row, index) => {
      const local = row.local.length ? row.local.map(processLabel).join(', ') : t('cli-risk.unknown-value')
      const parts = [`${local} → ${endpoint(signal)}`]
      if (row.listener) parts.push(`← ${listenerLabel(signal, row.listener)}`)
      parts.push(t('cli-risk.console-conn', { count: row.connections }))
      lines.push({ key: `${signal.id}:${index}`, at: row.at, text: parts.join('  ') })
    })
  }
  return lines.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
})

function position(): void {
  const rect = badgeRef.value?.getBoundingClientRect()
  const pop = popRef.value
  if (!rect || !pop) return
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 8))
  const below = rect.bottom + 6
  const top = below + pop.offsetHeight > window.innerHeight - 8
    ? Math.max(8, rect.top - 6 - pop.offsetHeight)
    : below
  popStyle.value = { top: `${top}px`, left: `${left}px` }
}

async function toggle(): Promise<void> {
  if (open.value) {
    close()
    return
  }
  error.value = ''
  open.value = true
  await nextTick()
  position()
  popRef.value?.focus()
}

function close(restoreFocus = false): void {
  open.value = false
  if (restoreFocus) badgeRef.value?.focus()
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  } else if (event.key === 'Tab' && popRef.value?.contains(document.activeElement)) {
    const buttons = [...popRef.value.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const firstButton = buttons[0]
    const lastButton = buttons[buttons.length - 1]
    if (event.shiftKey && (document.activeElement === firstButton || document.activeElement === popRef.value)) {
      event.preventDefault()
      lastButton?.focus()
    } else if (!event.shiftKey && document.activeElement === lastButton) {
      event.preventDefault()
      firstButton?.focus()
    }
  }
}

function onPointerDown(event: Event): void {
  const target = event.target as Node | null
  if (target && (popRef.value?.contains(target) || badgeRef.value?.contains(target))) return
  close()
}

function onBlur(): void { close() }

function detach(): void {
  document.removeEventListener('keydown', onKeydown, true)
  document.removeEventListener('pointerdown', onPointerDown, true)
  window.removeEventListener('blur', onBlur)
  window.removeEventListener('resize', position)
}

watch(open, (value) => {
  if (value) {
    document.addEventListener('keydown', onKeydown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', position)
  } else detach()
})
watch(() => props.state, async () => {
  if (!first.value) close()
  else if (open.value) {
    await nextTick()
    position()
  }
})
onBeforeUnmount(detach)

async function act(signal: CliRiskSignal, action: CliRiskAction['action']): Promise<void> {
  if (pending.value) return
  pending.value = true
  error.value = ''
  try {
    const response = await props.act(props.paneId, signal.id, action)
    if (!response.ok) error.value = response.error?.message || t('cli-risk.action-failed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('cli-risk.action-failed')
  } finally {
    pending.value = false
  }
}

const analyzing = ref(false)
const analysisVendor = computed(() => props.agentKey || first.value?.vendor || '')
const canAnalyze = computed(() => !!props.spawn && !!props.workspacePath && !!analysisVendor.value)

/** ui.pane.create words its errors for MCP callers. The one that leaves a pane
 *  behind — spawned, but its task never typed in — is said in the UI's words,
 *  and says so; the rest keep their detail inside a localized sentence. */
function analyzeErrorText(detail?: string): string {
  if (detail?.includes('failed to inject task')) return t('cli-risk.analyze-inject-failed')
  return detail ? t('cli-risk.analyze-failed-detail', { detail }) : t('cli-risk.analyze-failed')
}

/** Spawning waits for the CLI to come up, so the dialog may have been closed
 *  by the time it fails; reopen it (without taking focus from the terminal)
 *  rather than leave the error where nobody sees it. */
async function showAnalyzeError(message: string): Promise<void> {
  error.value = message
  if (open.value) return
  open.value = true
  await nextTick()
  position()
}

async function analyze(signals: CliRiskSignal[]): Promise<void> {
  if (!props.spawn || !props.workspacePath || !props.state || analyzing.value) return
  analyzing.value = true
  error.value = ''
  try {
    const response = await props.spawn({
      agent: analysisVendor.value,
      name: cliRiskAnalysisPaneName(),
      task: buildCliRiskAnalysisPrompt({
        paneId: props.paneId,
        vendor: analysisVendor.value,
        workspacePath: props.workspacePath,
        state: props.state,
        signals,
        locale: i18n.global.locale.value,
      }),
    })
    if (!response.ok) await showAnalyzeError(analyzeErrorText(response.error))
  } catch (err) {
    await showAnalyzeError(analyzeErrorText(err instanceof Error ? err.message : undefined))
  } finally {
    analyzing.value = false
  }
}

async function reveal(signal: CliRiskSignal): Promise<void> {
  if (!signal.path || pending.value) return
  pending.value = true
  error.value = ''
  try {
    const response = await window.agentTeam?.revealPath(signal.path)
    if (!response?.ok) error.value = response?.error || t('cli-risk.reveal-failed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('cli-risk.reveal-failed')
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <button
    v-if="first"
    ref="badgeRef"
    type="button"
    class="cli-risk-inline"
    v-truncate
    :class="[first.severity, { compact }]"
    :title="`${heading(first)}: ${label(first)}`"
    :aria-label="`${heading(first)}: ${label(first)}`"
    aria-haspopup="dialog"
    :aria-expanded="open"
    :aria-controls="open ? dialogId : undefined"
    @click.stop="toggle"
    @dblclick.stop
    @mousedown.stop
  ><span aria-hidden="true">▲</span><span class="cli-risk-label">{{ ' ' + label(first) }}</span></button>
  <Teleport to="body">
    <div
      v-if="open && first && state"
      :id="dialogId"
      ref="popRef"
      class="cli-risk-pop"
      :style="popStyle"
      role="dialog"
      :aria-label="t('cli-risk.details')"
      :aria-busy="pending"
      tabindex="-1"
      @click.stop
      @mousedown.stop
    >
      <div class="cli-risk-pop-head">
        <strong>{{ t('cli-risk.details') }}</strong>
        <span class="cli-risk-head-actions">
          <button v-if="canAnalyze" type="button" class="cli-risk-analyze-all" :title="t('cli-risk.analyze-hint', { vendor: analysisVendor })" :disabled="analyzing" @click="analyze(state.signals)">{{ t('cli-risk.analyze-all') }}</button>
          <button type="button" :aria-label="t('cli-risk.close')" @click="close(true)">×</button>
        </span>
      </div>
      <p v-if="available === false" class="cli-risk-stale">{{ t('cli-risk.unavailable') }}</p>
      <section v-for="signal in state.signals" :key="signal.id" class="cli-risk-signal" :data-signal-id="signal.id">
        <h3 :class="signal.severity">▲ {{ heading(signal) }}</h3>
        <p v-if="signal.stale" class="cli-risk-stale">{{ t('cli-risk.stale') }}</p>
        <dl>
          <dt>{{ t('cli-risk.vendor') }}</dt><dd>{{ signal.vendor }}</dd>
          <template v-if="signal.kind === 'network'">
            <dt>{{ t('cli-risk.endpoint') }}</dt><dd><code>{{ endpoint(signal) }}</code></dd>
            <template v-if="signal.sharedCdn">
              <dt>{{ t('cli-risk.shared-cdn-field') }}</dt><dd>{{ t('cli-risk.shared-cdn', { label: signal.sharedCdn }) }}</dd>
            </template>
            <dt>{{ t('cli-risk.connections') }}</dt><dd>{{ signal.connections === undefined ? t('cli-risk.unknown-value') : t('cli-risk.connection-count', { count: signal.connections }) }}</dd>
            <template v-if="signal.local?.length">
              <dt>{{ t('cli-risk.opened-by') }}</dt>
              <dd><div v-for="process in signal.local" :key="process.pid"><code>{{ processLabel(process) }}</code> {{ process.command ?? '' }}</div></dd>
            </template>
            <template v-if="signal.listener">
              <dt>{{ t('cli-risk.listener') }}</dt>
              <!-- A resolved listener outlives failed lookups, so say when it was seen. -->
              <dd v-if="signal.listener.status === 'resolved'"><code>{{ processLabel(signal.listener) }}</code> {{ signal.listener.command ?? '' }}<time v-if="signal.listener.observedAt" data-testid="cli-risk-listener-at" :datetime="signal.listener.observedAt">{{ ' · ' + clock(signal.listener.observedAt) }}</time></dd>
              <dd v-else>{{ t('cli-risk.listener-unknown') }}</dd>
            </template>
          </template>
          <template v-else>
            <dt>{{ t('cli-risk.path') }}</dt><dd><code>{{ signal.path ?? t('cli-risk.unknown-value') }}</code></dd>
            <dt>{{ t('cli-risk.size') }}</dt><dd>{{ size(signal) }}</dd>
            <dt>{{ t('cli-risk.format') }}</dt><dd>{{ t('cli-risk.opaque-format') }}</dd>
            <template v-if="signal.sizeClass !== undefined">
              <dt>{{ t('cli-risk.size-class') }}</dt><dd>{{ signal.sizeClass }}</dd>
            </template>
          </template>
          <dt>{{ t(signal.kind === 'network' ? 'cli-risk.observed-since' : 'cli-risk.first-observed') }}</dt><dd><time :datetime="signal.firstObservedAt">{{ signal.firstObservedAt }}</time></dd>
          <dt>{{ t('cli-risk.last-observed') }}</dt><dd><time :datetime="signal.lastObservedAt">{{ signal.lastObservedAt }}</time></dd>
          <template v-if="signal.absentObservedAt">
            <dt>{{ t('cli-risk.absent-observed') }}</dt><dd><time :datetime="signal.absentObservedAt">{{ signal.absentObservedAt }}</time></dd>
          </template>
          <template v-if="signal.expectedSetObservedAt">
            <dt>{{ t('cli-risk.expected-set') }}</dt><dd><time :datetime="signal.expectedSetObservedAt">{{ signal.expectedSetObservedAt }}</time></dd>
          </template>
          <dt>{{ t('cli-risk.observation-status') }}</dt><dd>{{ t(`cli-risk.status-${state[signal.kind].status}`) }}</dd>
          <dt>{{ t('cli-risk.last-success') }}</dt><dd><time v-if="state[signal.kind].lastSuccessAt" :datetime="state[signal.kind].lastSuccessAt">{{ state[signal.kind].lastSuccessAt }}</time><span v-else>{{ t('cli-risk.unknown-value') }}</span></dd>
        </dl>
        <p>{{ signal.scope === 'vendor' ? t('cli-risk.vendor-scope', { vendor: signal.vendor }) : t('cli-risk.pane-scope') }}</p>
        <p>{{ t(signal.kind === 'network' ? 'cli-risk.network-note' : signal.severity === 'red' ? 'cli-risk.disk-again-note' : 'cli-risk.disk-note') }}</p>
        <p v-if="signal.kind === 'network'">{{ t('cli-risk.ip-action-scope', { ip: signal.ip ?? t('cli-risk.unknown-value'), vendor: signal.vendor }) }}</p>
        <div class="cli-risk-actions">
          <button type="button" :disabled="pending" @click="act(signal, 'ignore')">{{ t(signal.kind === 'network' ? 'cli-risk.ignore-ip' : 'cli-risk.ignore') }}</button>
          <button v-if="signal.kind === 'network' && signal.ip" type="button" :disabled="pending" @click="act(signal, 'allow')">{{ t('cli-risk.allow-ip', { vendor: signal.vendor }) }}</button>
          <button v-if="signal.kind === 'disk' && signal.path" type="button" :disabled="pending" @click="reveal(signal)">{{ t('cli-risk.reveal') }}</button>
          <button v-if="canAnalyze" type="button" class="cli-risk-analyze" :title="t('cli-risk.analyze-hint', { vendor: analysisVendor })" :disabled="analyzing" @click="analyze([signal])">{{ t('cli-risk.analyze') }}</button>
        </div>
      </section>
      <details class="cli-risk-console" data-testid="cli-risk-console">
        <summary>{{ t('cli-risk.console') }}</summary>
        <ol>
          <li v-for="line in consoleLines" :key="line.key"><time :datetime="line.at">{{ clock(line.at) }}</time>{{ '  ' + line.text }}</li>
        </ol>
      </details>
      <p v-if="error" role="alert" class="cli-risk-error">{{ error }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.cli-risk-inline {
  font-size: var(--font-3xs);
  font-weight: 600;
  color: var(--attention-fg);
  background: var(--attention-subtle);
  border: 1px solid var(--attention-muted);
  border-radius: var(--radius-xs);
  padding: 1px 6px;
  white-space: nowrap;
  flex-shrink: 0;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.cli-risk-inline.red { color: var(--danger-fg); background: var(--danger-deep); border-color: var(--danger-fg); }
.cli-risk-inline:hover { border-color: currentColor; }
.cli-risk-inline:focus-visible, .cli-risk-pop button:focus-visible { outline: 2px solid var(--accent-focus); outline-offset: 2px; }
.cli-risk-inline.compact { padding: 1px 2px; }
.compact .cli-risk-label { display: none; }
@container cli-pane-header (max-width: 620px) {
  .cli-risk-inline { padding: 1px 2px; }
  .cli-risk-label { display: none; }
}
.cli-risk-pop {
  position: fixed;
  z-index: 300;
  box-sizing: border-box;
  width: 360px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow: auto;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 10px 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.cli-risk-pop-head { display: flex; align-items: center; justify-content: space-between; color: var(--text-bright); }
.cli-risk-head-actions { display: flex; align-items: center; gap: 6px; }
.cli-risk-signal + .cli-risk-signal { border-top: 1px solid var(--border-muted); margin-top: 10px; padding-top: 8px; }
h3 { margin: 6px 0; font-size: inherit; }
.yellow, .cli-risk-stale { color: var(--attention-fg); }
.red, .cli-risk-error { color: var(--danger-fg); }
dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; margin: 8px 0; }
dd { margin: 0; color: var(--text-primary); }
p { margin: 6px 0; }
.cli-risk-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.cli-risk-pop button { font: inherit; color: var(--text-primary); background: var(--bg-subtle); border: 1px solid var(--border-default); border-radius: var(--radius-xs); padding: 3px 7px; cursor: pointer; }
.cli-risk-pop button:disabled { opacity: 0.5; cursor: default; }
.cli-risk-console { border-top: 1px solid var(--border-muted); margin-top: 10px; padding-top: 8px; }
.cli-risk-console summary { cursor: pointer; color: var(--text-bright); }
/* Lines keep their shape and scroll inside; the popover never widens. */
.cli-risk-console ol { list-style: none; margin: 6px 0 0; padding: 6px 8px; max-height: 180px; overflow: auto; background: var(--bg-inset); border-radius: var(--radius-xs); font-family: var(--font-mono); white-space: pre; overflow-wrap: normal; color: var(--text-primary); }
</style>
