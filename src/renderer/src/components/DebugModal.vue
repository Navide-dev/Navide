<script setup lang="ts">
// DebugModal — diagnostics surface behind cmd+shift+L.
//
// Four tabs: a live tail of backend.log with level/text filters and copy, a
// plain shell rooted at the log directory, an AI CLI agent primed with the log
// paths, and an Info sheet of every path/version the support flow asks for.
//
// Like the Pipeline Manager, this modal stays MOUNTED while closed (v-show, not
// v-if) so the embedded terminals keep owning their PTYs — unmounting would let
// the backend janitor reap a shell the user is still running. Esc is owned by
// the host's workbench.action.closeModal stack, which deliberately does not
// fire while a terminal has focus (Esc is the CLI's own interrupt key).
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useI18n } from 'vue-i18n'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import {
  aiTerminalPaneId,
  bracketedPaste,
  CLI_AGENT_SPECS,
  cliPermissionKey,
  resolveCliCommand,
} from '@navide/plugin-shell'
import {
  LOG_LEVELS,
  capLines,
  filterLogLines,
  logLineLevel,
  maskWsUrlToken,
  splitLogChunk,
  type LogLevel,
} from '../lib/debugLog'
import type { useBackend } from '../composables/useBackend'
import type { TerminalDockPort } from '@navide/terminal'
import { AiCliTerminal } from '@navide/plugin-shell'

const logLevelList = LOG_LEVELS
const getLineLevel = logLineLevel

const props = defineProps<{
  open: boolean
  backend: ReturnType<typeof useBackend>
  terminalPort: TerminalDockPort
  /** Workspace the AI tab spawns in; falls back to the log directory. */
  workspacePath: string
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

type Tab = 'log' | 'shell' | 'ai' | 'info'
const activeTab = ref<Tab>('log')

// ── Paths ───────────────────────────────────────────────────────────────────

interface DebugPaths {
  app_data_dir?: string
  roles?: string
  pipelines?: string
  mcp?: string
  skills?: string
  skills_state?: string
  analyzer?: string
  ai_chat?: string
  backend_log?: string
}

const paths = ref<DebugPaths>({})
const health = ref<{ version?: string; started_at?: string } | null>(null)
const appVersion = window.agentTeam?.version ?? '—'

const logPath = computed(() => paths.value.backend_log ?? '')
/** Directory holding backend.log — the shell tab's cwd. */
const logDir = computed(() => {
  const p = logPath.value
  const cut = p.lastIndexOf('/')
  return cut > 0 ? p.slice(0, cut) : ''
})

async function loadPaths(): Promise<void> {
  try {
    const resp = await props.backend.send<{ paths: DebugPaths }>('settings.paths', {})
    if (resp.ok && resp.payload?.paths) paths.value = resp.payload.paths
  } catch { /* non-fatal — the Info tab just shows blanks */ }
}

async function loadHealth(): Promise<void> {
  const base = props.backend.httpUrl.value
  if (!base) return
  try {
    const r = await fetch(`${base}/health`)
    if (r.ok) health.value = await r.json()
  } catch { /* non-fatal */ }
}

// Opening the modal during startup finds the backend still connecting, and both
// loads fail silently — leaving the log path unknown and the whole modal blank
// until the user closes and reopens it. Reload whenever the connection lands.
watch(
  () => props.backend.status.value,
  (status) => {
    if (status !== 'connected' || !props.open) return
    void loadPaths()
    void loadHealth()
  }
)

// ── Log tail ────────────────────────────────────────────────────────────────

/** Rendered line cap. The file is 10 MB before it rotates; keeping all of it in
 *  the DOM is what makes a log viewer unusable, so only the tail is retained. */
const LOG_MAX_LINES = 2000
const POLL_MS = 1500
/** How far back from the end the first read starts. Pulling all 10 MB through
 *  IPC to then throw away everything but the last 2000 lines is pure stall. */
const TAIL_BYTES = 512 * 1024

const logLines = ref<string[]>([])
const minLevel = ref<'all' | LogLevel>('all')
const textFilter = ref('')
const autoScroll = ref(true)
const logEl = ref<HTMLElement | null>(null)
const tailing = ref(false)

let logOffset = 0
/** Bytes after the last newline of the previous read — a poll can land
 *  mid-line, and joining it to the next chunk is what keeps lines intact. */
let partial = ''
let pollTimer: ReturnType<typeof setTimeout> | null = null
/** Bumped by stopTail() so an in-flight poll knows its chain was abandoned. */
let tailGeneration = 0
/** False until the cursor has been placed near the end of the file. */
let seeded = false
/** A seek into the middle of the file lands mid-line; that first fragment is
 *  not a real line and is dropped rather than rendered truncated. */
let dropFirstLine = false

function appendChunk(chunk: string): void {
  const split = splitLogChunk(partial, chunk)
  partial = split.partial
  let lines = split.lines
  if (dropFirstLine && lines.length > 0) {
    lines = lines.slice(1)
    dropFirstLine = false
  }
  logLines.value = capLines(logLines.value, lines, LOG_MAX_LINES)
}

function resetTail(): void {
  logOffset = 0
  partial = ''
  seeded = false
  dropFirstLine = false
  logLines.value = []
}

async function pollOnce(): Promise<void> {
  const path = logPath.value
  const read = window.agentTeam?.readFileFrom
  if (!path || !read) return
  try {
    if (!seeded) {
      // Probe past EOF: no content comes back, but the handler reports the real
      // size — one round trip buys a cursor near the tail.
      const probe = await read(path, Number.MAX_SAFE_INTEGER)
      if (!probe.ok) return
      logOffset = probe.newOffset > TAIL_BYTES ? probe.newOffset - TAIL_BYTES : 0
      dropFirstLine = logOffset > 0
      seeded = true
    }
    const r = await read(path, logOffset)
    if (!r.ok) return
    // The handler reports the real size, so a newOffset below the cursor we
    // asked from means the file rotated out from under us — start over.
    if (r.newOffset < logOffset) {
      resetTail()
      return
    }
    logOffset = r.newOffset
    if (r.content) appendChunk(r.content)
  } catch { /* transient read error — the next tick retries */ }
}

/** Self-rescheduling poll rather than setInterval: a slow read must not let
 *  ticks pile up on top of each other.
 *
 *  Every chain carries the generation it was started under. stopTail() bumps
 *  the counter, so a poll that was mid-await when the tab closed finds itself
 *  stale and stops instead of rescheduling. Without this, a stop/start inside
 *  one read's await window leaves two chains sharing `logOffset` — duplicated
 *  lines, and a timer stopTail() can no longer reach. */
function scheduleTail(generation: number): void {
  pollTimer = setTimeout(() => {
    void pollOnce().finally(() => {
      if (generation === tailGeneration) scheduleTail(generation)
    })
  }, POLL_MS)
}

function startTail(): void {
  if (tailing.value) return
  tailing.value = true
  const generation = tailGeneration
  void pollOnce().finally(() => {
    if (generation === tailGeneration) scheduleTail(generation)
  })
}

function stopTail(): void {
  tailing.value = false
  tailGeneration++
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

const visibleLines = computed(() =>
  filterLogLines(logLines.value, { minLevel: minLevel.value, text: textFilter.value })
)

watch(visibleLines, () => {
  if (!autoScroll.value) return
  void nextTick(() => {
    const el = logEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
})

const copied = ref(false)
async function copyVisible(): Promise<void> {
  try {
    await navigator.clipboard.writeText(visibleLines.value.join('\n'))
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch { /* clipboard denied — nothing useful to say */ }
}

function openPath(target: string): void {
  if (target) void window.agentTeam?.openPath?.(target)
}

/** Select the file in Finder rather than opening it. backend.log runs to 10 MB
 *  and the default handler would hand that to TextEdit; the Shell tab is the
 *  place to actually read it. */
function revealPath(target: string): void {
  if (target) void window.agentTeam?.revealPath?.(target)
}

// ── Embedded terminals ──────────────────────────────────────────────────────

// Each tab mounts its terminal only once visited, then stays mounted for the
// modal's life so its PTY survives tab switches and modal close.
const shellVisited = ref(false)
const aiVisited = ref(false)

const shellRef = ref<InstanceType<typeof AiCliTerminal> | null>(null)
const aiRef = ref<InstanceType<typeof AiCliTerminal> | null>(null)

const shellPaneId = computed(() => aiTerminalPaneId('debug-shell', logDir.value))
const aiWorkspace = computed(() => props.workspacePath || logDir.value)
const aiPaneId = computed(() => aiTerminalPaneId('debug-ai', aiWorkspace.value))

// CLI_AGENT_SPECS already excludes the plain-shell 'terminal' spec.
const aiSpecs = CLI_AGENT_SPECS
const aiAgent = ref(settingsGet('agentTeam.debug.agent', 'claude'))
watch(aiAgent, (v) => settingsSet('agentTeam.debug.agent', v))

const shellBusy = ref(false)
const aiBusy = ref(false)

function shellStatus(): string {
  return shellRef.value?.status ?? 'idle'
}
function aiStatus(): string {
  return aiRef.value?.status ?? 'idle'
}
/** A finished CLI leaves 'exited'/'stopped'/'error', never 'idle' — gating the
 *  controls on 'idle' would lock the agent picker forever after the first run. */
function isActive(status: string): boolean {
  return status === 'starting' || status === 'running'
}

async function startShell(): Promise<void> {
  const term = shellRef.value
  if (!term || shellBusy.value || !logDir.value) return
  if (props.backend.status.value !== 'connected') return
  if (term.status === 'starting' || term.status === 'running') return
  shellBusy.value = true
  try {
    const shell = props.backend.shell.value || 'bash'
    await term.spawn({
      // The inner shell name is the command on purpose: `zsh -ilc ''` runs an
      // empty command and exits immediately, so the PTY would die before the
      // user saw a prompt. Spawning the shell as its own command is what
      // App.vue does for its plain-terminal panes (see the agentKey 'terminal'
      // branch there). The -ilc wrapper still matters: ~/.zshrc is where
      // installers put PATH, and -lc alone would not read it.
      command: [shell, shell.endsWith('zsh') ? '-ilc' : '-lc', shell],
      cwd: logDir.value,
      agentKey: 'terminal',
      metadata: { workspace_path: logDir.value, origin: 'debug-modal' },
      skipReattach: true,
    })
  } catch { /* spawn errors are rendered inside the terminal */ }
  finally { shellBusy.value = false }
}

function buildAiContext(): string {
  return [
    "You are running in a terminal embedded in Navide's Debug window, helping " +
      'the user diagnose the app itself.',
    `Workspace: ${aiWorkspace.value}`,
    `Backend log: ${logPath.value}`,
    `App data dir: ${paths.value.app_data_dir ?? '(unknown)'}`,
    '',
    'The backend log is a rotating file (backend.log, plus backend.log.1 … .5). ' +
      'Read it with the usual shell tools before drawing conclusions.',
  ].join('\n')
}

async function startAi(): Promise<void> {
  const term = aiRef.value
  if (!term || aiBusy.value || !aiWorkspace.value) return
  if (props.backend.status.value !== 'connected') return
  // Snapshot rather than test term.status inline: narrowing it here would make
  // the post-spawn 'running' check below unreachable to the compiler.
  const before = term.status
  if (before === 'starting' || before === 'running') return
  aiBusy.value = true
  try {
    const shell = props.backend.shell.value || 'bash'
    const command = resolveCliCommand({
      agentKey: aiAgent.value,
      paneId: aiPaneId.value,
      historyRoot: aiWorkspace.value,
      yoloStored: settingsGet<string | null>('agentTeam.yolo', null),
      permissionStored: settingsGet<string | null>(cliPermissionKey(aiAgent.value), null),
    })
    await term.spawn({
      command: [shell, shell.endsWith('zsh') ? '-ilc' : '-lc', command],
      cwd: aiWorkspace.value,
      agentKey: aiAgent.value,
      metadata: { workspace_path: aiWorkspace.value, origin: 'debug-modal' },
      skipReattach: true,
    })
    if (term.status === 'running') void injectAiContext(term)
  } catch { /* spawn errors are rendered inside the terminal */ }
  finally { aiBusy.value = false }
}

/** Paste the log paths once the CLI's startup output goes quiet. Best-effort:
 *  a failure here never blocks the CLI the user just started. */
async function injectAiContext(term: InstanceType<typeof AiCliTerminal>): Promise<void> {
  try {
    const deadline = Date.now() + 12000
    for (;;) {
      const last = term.lastRawActivityAt
      if ((last > 0 && Date.now() - last >= 2000) || Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 250))
      if (term.status !== 'running') return
    }
    // Skip the submitting CR when the context itself never left, so a dropped
    // transport cannot submit an empty prompt in its place.
    if (!term.pasteText(bracketedPaste(buildAiContext()))) return
    await new Promise((r) => setTimeout(r, 300))
    term.pasteText('\r')
  } catch { /* best-effort */ }
}

function stopTerm(term: InstanceType<typeof AiCliTerminal> | null): void {
  if (!term) return
  // While 'starting' there is no sessionId yet, so kill() is a no-op and a hung
  // terminal.create would be uncancellable — cancel the pending create instead.
  if (term.status === 'starting') void term.cancelPendingCreate().catch(() => {})
  // A refused kill rejects now; it is logged, not left unhandled.
  else void term.kill().catch((err) => console.warn('[DebugModal] stop failed:', err))
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      stopTail()
      return
    }
    void loadPaths()
    void loadHealth()
    if (activeTab.value === 'log') startTail()
    // The modal opens from display:none — refit so any mounted terminal paints
    // at its real size (sanctioned explicit-refit path, no history loss).
    void nextTick(() => refitActive())
  },
  // The host mounts this component lazily at the moment it first opens, so
  // `open` is already true on the very first run — without immediate, the first
  // open would load nothing and never start tailing.
  { immediate: true }
)

// The tail only runs while its tab is on screen; a hidden tab polling the disk
// every 1.5 s for the modal's whole life buys nothing.
watch(activeTab, (tab) => {
  if (tab === 'log' && props.open) startTail()
  else stopTail()
  if (tab === 'shell') shellVisited.value = true
  if (tab === 'ai') aiVisited.value = true
  void nextTick(() => {
    refitActive()
    if (tab === 'shell' || tab === 'ai') void reattachOnce(tab)
  })
})

function refitActive(): void {
  if (activeTab.value === 'shell') shellRef.value?.fitTerminal({ redrawAfterSettle: true })
  if (activeTab.value === 'ai') aiRef.value?.fitTerminal({ redrawAfterSettle: true })
}

// A window reload drops ownership of any PTY these tabs started; the backend
// janitor only reaps it after an idle hour, so without this the CLI is stranded
// and invisible. Claim it back the first time the tab is opened. Once per
// terminal: a second attempt could rebind a session Start has since replaced.
const reattached = { shell: false, ai: false }
async function reattachOnce(tab: 'shell' | 'ai'): Promise<void> {
  if (reattached[tab]) return
  if (props.backend.status.value !== 'connected') return
  const term = tab === 'shell' ? shellRef.value : aiRef.value
  if (!term) return
  reattached[tab] = true
  // Pass the agent: tryReattach is the one path that never calls spawn(), and
  // the input protocol degrades to plain-shell encoding without it.
  try {
    await term.tryReattach({ agentKey: tab === 'shell' ? 'terminal' : aiAgent.value })
  } catch { /* PTY gone — the Start button stays as it was */ }
}

// The path arrives from the backend a beat after the modal opens, so the first
// startTail() ran with nothing to read. Restart on arrival instead of waiting
// out a poll interval.
watch(logPath, (p) => {
  if (!p || !props.open || activeTab.value !== 'log') return
  stopTail()
  resetTail()
  startTail()
})

onUnmounted(() => stopTail())
</script>

<template>
  <Teleport to="body">
    <div v-show="open" class="dbg-overlay nv-modal-overlay" @click.self="emit('close')">
      <div class="dbg-modal nv-modal-shell nv-modal-shell--wide">
        <header class="dbg-top">
          <div class="dbg-title">{{ t('debug.title') }}</div>
          <nav class="dbg-tabs">
            <button :class="{ active: activeTab === 'log' }" @click="activeTab = 'log'">
              {{ t('debug.tab.log') }}
            </button>
            <button :class="{ active: activeTab === 'shell' }" @click="activeTab = 'shell'">
              {{ t('debug.tab.shell') }}
            </button>
            <button :class="{ active: activeTab === 'ai' }" @click="activeTab = 'ai'">
              {{ t('debug.tab.ai') }}
            </button>
            <button :class="{ active: activeTab === 'info' }" @click="activeTab = 'info'">
              {{ t('debug.tab.info') }}
            </button>
          </nav>
          <div class="dbg-meta">
            <span class="dbg-dot" :class="backend.status.value"></span>
            <span>{{ t('debug.backend-status', { status: backend.status.value }) }}</span>
          </div>
          <button class="dbg-close" :title="t('debug.close')" @click="emit('close')">✕</button>
        </header>

        <!-- Log -->
        <section v-show="activeTab === 'log'" class="dbg-body">
          <div class="dbg-toolbar">
            <select v-model="minLevel" class="dbg-select">
              <option value="all">{{ t('debug.log.level-all') }}</option>
              <option v-for="lv in logLevelList" :key="lv" :value="lv">{{ lv }}+</option>
            </select>
            <input
              v-model="textFilter"
              class="dbg-input"
              type="text"
              :placeholder="t('debug.log.filter-placeholder')"
            />
            <label class="dbg-check">
              <input v-model="autoScroll" type="checkbox" />
              {{ t('debug.log.follow') }}
            </label>
            <span class="dbg-spacer"></span>
            <span class="dbg-count">
              {{ t('debug.log.count', { shown: visibleLines.length, total: logLines.length }) }}
            </span>
            <button class="dbg-btn" @click="copyVisible()">
              {{ copied ? t('debug.log.copied') : t('debug.log.copy') }}
            </button>
            <button class="dbg-btn" :disabled="!logPath" @click="revealPath(logPath)">
              {{ t('debug.log.reveal') }}
            </button>
          </div>
          <div ref="logEl" class="dbg-log">
            <div v-if="!logPath" class="dbg-empty">{{ t('debug.log.no-path') }}</div>
            <div v-else-if="visibleLines.length === 0" class="dbg-empty">
              {{ t('debug.log.empty') }}
            </div>
            <div
              v-for="(line, i) in visibleLines"
              v-else
              :key="i"
              class="dbg-log-line"
              :class="getLineLevel(line).toLowerCase()"
            >
              {{ line }}
            </div>
          </div>
        </section>

        <!-- Shell -->
        <section v-show="activeTab === 'shell'" class="dbg-body">
          <div class="dbg-toolbar">
            <span class="dbg-cwd" v-truncate>{{ logDir || '—' }}</span>
            <span class="dbg-spacer"></span>
            <span class="dbg-count">{{ shellStatus() }}</span>
            <button
              class="dbg-btn"
              :disabled="shellBusy || !logDir || isActive(shellStatus())"
              @click="startShell()"
            >
              {{ t('debug.term.start') }}
            </button>
            <button
              class="dbg-btn"
              :disabled="!isActive(shellStatus())"
              @click="shellRef?.interrupt()"
            >
              {{ t('debug.term.interrupt') }}
            </button>
            <button
              class="dbg-btn"
              :disabled="!isActive(shellStatus())"
              @click="stopTerm(shellRef)"
            >
              {{ t('debug.term.stop') }}
            </button>
          </div>
          <div class="dbg-term">
            <!-- :key — useTerminal captures paneId/workspacePath once at setup,
                 so a path that only resolves after mount must remount it. -->
            <AiCliTerminal
              v-if="shellVisited"
              :key="shellPaneId"
              ref="shellRef"
              :pane-id="shellPaneId"
              :terminal-port="terminalPort"
              :workspace-path="logDir"
            />
          </div>
        </section>

        <!-- Ask AI -->
        <section v-show="activeTab === 'ai'" class="dbg-body">
          <div class="dbg-toolbar">
            <select v-model="aiAgent" class="dbg-select" :disabled="isActive(aiStatus())">
              <option v-for="s in aiSpecs" :key="s.agentKey" :value="s.agentKey">
                {{ s.label }}
              </option>
            </select>
            <span class="dbg-cwd" v-truncate>{{ aiWorkspace || '—' }}</span>
            <span class="dbg-spacer"></span>
            <span class="dbg-count">{{ aiStatus() }}</span>
            <button
              class="dbg-btn"
              :disabled="aiBusy || !aiWorkspace || isActive(aiStatus())"
              @click="startAi()"
            >
              {{ t('debug.term.start') }}
            </button>
            <button
              class="dbg-btn"
              :disabled="!isActive(aiStatus())"
              @click="aiRef?.interrupt()"
            >
              {{ t('debug.term.interrupt') }}
            </button>
            <button class="dbg-btn" :disabled="!isActive(aiStatus())" @click="stopTerm(aiRef)">
              {{ t('debug.term.stop') }}
            </button>
          </div>
          <div class="dbg-term">
            <AiCliTerminal
              v-if="aiVisited"
              :key="aiPaneId"
              ref="aiRef"
              :pane-id="aiPaneId"
              :terminal-port="terminalPort"
              :workspace-path="aiWorkspace"
            />
          </div>
        </section>

        <!-- Info -->
        <section v-show="activeTab === 'info'" class="dbg-body">
          <div class="dbg-info">
            <h3>{{ t('debug.info.runtime') }}</h3>
            <dl>
              <dt>{{ t('debug.info.app') }}</dt>
              <dd>{{ appVersion }}</dd>
              <dt>{{ t('debug.info.backend') }}</dt>
              <dd>{{ health?.version ?? '—' }}</dd>
              <dt>{{ t('debug.info.started') }}</dt>
              <dd>{{ health?.started_at ?? '—' }}</dd>
              <dt>WebSocket</dt>
              <dd>{{ maskWsUrlToken(backend.wsUrl.value) || '—' }}</dd>
              <dt>HTTP</dt>
              <dd>{{ backend.httpUrl.value || '—' }}</dd>
              <dt>PID</dt>
              <dd>{{ backend.pid.value ?? '—' }}</dd>
              <dt>{{ t('debug.info.shell') }}</dt>
              <dd>{{ backend.shell.value || '—' }}</dd>
            </dl>
            <h3>{{ t('debug.info.paths') }}</h3>
            <div v-for="(value, key) in paths" :key="key" class="dbg-path-row">
              <span class="dbg-path-key">{{ key }}</span>
              <span class="dbg-path-value" v-truncate>{{ value }}</span>
              <button class="dbg-btn" @click="openPath(String(value))">
                {{ t('debug.info.open') }}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dbg-overlay {
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
.dbg-modal {
  width: min(var(--modal-w-wide), 92vw);
  height: 88vh;
  background: var(--bg-base);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
}
.dbg-top {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-muted);
  flex: none;
}
.dbg-title {
  font-size: var(--font-sm);
  font-weight: 600;
}
.dbg-tabs {
  display: flex;
  gap: 2px;
}
.dbg-tabs button {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.dbg-tabs button:hover {
  background: var(--bg-muted);
  color: var(--text-bright);
}
.dbg-tabs button.active {
  background: var(--accent-subtle);
  color: var(--accent-bright);
  font-weight: 600;
}
.dbg-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.dbg-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-secondary);
}
.dbg-dot.connected {
  background: var(--success-fg);
}
.dbg-dot.error {
  background: var(--danger-fg);
}
.dbg-close {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--font-sm);
  padding: 2px 6px;
}
.dbg-close:hover {
  color: var(--text-bright);
}

.dbg-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.dbg-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border-muted);
  flex: none;
}
.dbg-spacer {
  flex: 1;
}
.dbg-select,
.dbg-input {
  background: var(--bg-muted);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  font-size: var(--font-2xs);
  padding: 3px 6px;
}
.dbg-input {
  width: 220px;
}
.dbg-check {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  cursor: pointer;
}
.dbg-count {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}
.dbg-cwd {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  font-family: var(--font-mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
}
.dbg-btn {
  background: var(--bg-muted);
  color: var(--text-bright);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  font-size: var(--font-2xs);
  padding: 3px 9px;
  cursor: pointer;
}
.dbg-btn:hover:not(:disabled) {
  background: var(--accent-subtle);
  color: var(--accent-bright);
}
.dbg-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.dbg-log {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px 12px;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-2xs);
  line-height: var(--lh-base);
  user-select: text;
}
.dbg-log-line {
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary);
}
.dbg-log-line.warning {
  color: var(--warning-fg);
}
.dbg-log-line.error,
.dbg-log-line.critical {
  color: var(--danger-fg);
}
.dbg-log-line.info {
  color: var(--text-bright);
}
.dbg-empty {
  padding: 24px 0;
  text-align: center;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}

.dbg-term {
  flex: 1;
  min-height: 0;
  display: flex;
}

.dbg-info {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 16px;
  font-size: var(--font-xs);
  user-select: text;
}
.dbg-info h3 {
  font-size: var(--font-2xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  margin: 14px 0 6px;
}
.dbg-info h3:first-child {
  margin-top: 0;
}
.dbg-info dl {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 3px 12px;
  margin: 0;
}
.dbg-info dt {
  color: var(--text-secondary);
}
.dbg-info dd {
  margin: 0;
  font-family: var(--font-mono, monospace);
  overflow-wrap: anywhere;
}
.dbg-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}
.dbg-path-key {
  width: 120px;
  flex: none;
  color: var(--text-secondary);
}
.dbg-path-value {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-2xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
