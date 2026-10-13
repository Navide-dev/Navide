<script setup lang="ts">
/**
 * The embedded terminal an onboarding install / maintenance command runs in.
 *
 * Bound to one useOnboarding instance: it shows that instance's current run
 * (live output, keyboard input for sudo and prompts, the exit code) and, when
 * the PTY could not start, the external-terminal fallback. The run itself is
 * owned by the composable, so this component can mount after output began.
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useI18n } from 'vue-i18n'
import type { useOnboarding } from '../composables/useOnboarding'

const props = defineProps<{
  onboarding: ReturnType<typeof useOnboarding>
}>()

const { t } = useI18n()
const host = ref<HTMLElement | null>(null)
const run = computed(() => props.onboarding.run.value)
const fallback = computed(() => props.onboarding.runFallback.value)

let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let detachOutput: (() => void) | null = null

const statusText = computed(() => {
  const current = run.value
  if (!current) return ''
  if (current.state !== 'exited') return t('install-terminal.running')
  if (current.cancelled) return t('install-terminal.cancelled')
  if (current.lost) return t('install-terminal.lost')
  if (current.signal) return t('install-terminal.signal', { signal: current.signal })
  if (current.exitCode === 0) return t('install-terminal.exited-ok')
  return t('install-terminal.exited-fail', { code: current.exitCode ?? '?' })
})

const failed = computed(() => {
  const current = run.value
  return !!current && current.state === 'exited' && current.exitCode !== 0
})

function fit(): void {
  if (!terminal || !fitAddon) return
  try {
    fitAddon.fit()
  } catch {
    // Not laid out yet (zero size): the next observer tick fits it.
    return
  }
  props.onboarding.runResize(terminal.cols, terminal.rows)
}

/** The screen exists only while there is a run to show (the fallback view
 *  has none), so the terminal opens on the first run that needs it. */
function ensureTerminal(): Terminal | null {
  if (terminal) return terminal
  if (!host.value) return null
  terminal = new Terminal({
    cursorBlink: true,
    scrollback: 5_000,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 12,
    rows: 14,
  })
  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(host.value)
  terminal.onData((data) => props.onboarding.runInput(data))
  resizeObserver = new ResizeObserver(() => fit())
  resizeObserver.observe(host.value)
  return terminal
}

/** A new run starts on a clean screen and replays its own output only. */
function bind(): void {
  detachOutput?.()
  detachOutput = null
  if (!run.value) return
  const term = ensureTerminal()
  if (!term) return
  term.reset()
  detachOutput = props.onboarding.attachRunOutput((data) => terminal?.write(data))
  fit()
  if (run.value.state !== 'exited') term.focus()
}

function teardown(): void {
  detachOutput?.()
  detachOutput = null
  resizeObserver?.disconnect()
  resizeObserver = null
  terminal?.dispose()
  fitAddon?.dispose()
  terminal = null
  fitAddon = null
}

onMounted(bind)

watch(() => run.value?.runId, (id, previous) => {
  if (id === previous) return
  // A dismissed run takes its screen element with it; the next run opens a
  // terminal on the new one.
  if (!run.value) teardown()
  else void nextTick(bind)
})

onUnmounted(teardown)
</script>

<template>
  <section class="install-terminal" data-testid="install-terminal">
    <div v-if="fallback && !run" class="it-fallback" data-testid="install-terminal-fallback">
      <strong>{{ t('install-terminal.fallback-title') }}</strong>
      <p>{{ t('install-terminal.fallback-desc') }}</p>
      <code class="it-command" v-truncate>{{ fallback.command }}</code>
      <p v-if="fallback.error" class="it-error">{{ fallback.error }}</p>
      <button
        type="button"
        class="it-btn"
        data-testid="install-terminal-open-external"
        @click="onboarding.openFallbackInTerminal()"
      >{{ t('install-terminal.open-in-terminal') }}</button>
    </div>
    <template v-if="run">
      <header class="it-head">
        <span class="it-label">{{ run.label }}</span>
        <code class="it-command" v-truncate>{{ run.command }}</code>
      </header>
      <div ref="host" class="it-screen" />
      <p v-if="run.inputError" class="it-error" role="alert" data-testid="install-terminal-input-error">
        {{ t('install-terminal.input-lost', { error: run.inputError }) }}
      </p>
      <footer class="it-foot">
        <span
          class="it-status"
          :class="{ 'is-failed': failed, 'is-ok': run.state === 'exited' && run.exitCode === 0 }"
          data-testid="install-terminal-status"
        >{{ statusText }}</span>
        <button
          v-if="run.state !== 'exited'"
          type="button"
          class="it-btn it-cancel"
          data-testid="install-terminal-cancel"
          :disabled="run.state !== 'running' || run.cancelled"
          @click="onboarding.cancelRun()"
        >{{ t('install-terminal.cancel') }}</button>
        <button
          v-else
          type="button"
          class="it-btn"
          data-testid="install-terminal-close"
          @click="onboarding.dismissRun()"
        >{{ t('install-terminal.close') }}</button>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.install-terminal {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.it-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.it-label {
  font-weight: 600;
  white-space: nowrap;
}
.it-command {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  opacity: 0.8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.it-screen {
  height: 220px;
  padding: 6px;
  border-radius: 6px;
  background: #0d1117;
  overflow: hidden;
}
.it-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.it-status {
  font-size: 12px;
  opacity: 0.85;
}
.it-status.is-failed {
  color: var(--color-danger, #f85149);
  opacity: 1;
}
.it-status.is-ok {
  color: var(--color-success, #3fb950);
  opacity: 1;
}
.it-btn {
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--color-border, #30363d);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.it-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.it-fallback {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.it-fallback p {
  margin: 0;
  font-size: 12px;
}
.it-error {
  margin: 0;
  font-size: 12px;
  color: var(--color-danger, #f85149);
}
</style>
