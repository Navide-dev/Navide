<script setup lang="ts">
// Settings → General → Experimental → Remote container panes: the ＋ menu
// entry opens this. Host (a name from the user's ssh config) → list its
// containers → pick a running one whose network the tunnel supports → pick the
// CLI → optionally test → open. The pane itself is spawned by App.vue from the
// `open` event; nothing here starts a process.
//
// Only host, container and CLI names are remembered (useRemoteDevcontainerPrefs).
import { computed, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { useDialogFocus } from '../composables/useDialogFocus'
import {
  REMOTE_AGENT_LABELS,
  loadRemoteRecent,
  rememberRemoteRecent,
  type RemoteAgentKey,
  type RemoteNetwork,
  type RemoteRecent,
  type RemoteTarget,
} from '../composables/useRemoteDevcontainerPrefs'

interface BackendReply {
  ok: boolean
  payload?: unknown
  error?: { code?: string; message?: string; details?: Record<string, unknown> } | null
}

interface ListedContainer {
  name: string
  running: boolean
  network: { mode: string; gateway?: string; detail?: string }
}

interface ProbeResult {
  host_ok?: boolean
  container_ok?: boolean
  cli_path?: string
  cli_version?: string
  mcp?: string
  elapsed_ms?: number
  error?: string
}

/** The pane opens under agent key 'remote'; `remote.cli` is the CLI run there. */
export interface RemoteOpenRequest {
  remote: RemoteTarget
}

const props = defineProps<{
  open: boolean
  backend: { send: (type: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<BackendReply> }
}>()
const emit = defineEmits<{ open: [req: RemoteOpenRequest]; cancel: [] }>()

const AGENT_KEYS = Object.keys(REMOTE_AGENT_LABELS) as RemoteAgentKey[]
// ssh plus docker on a slow host takes a while; the backend has its own bound.
const LIST_TIMEOUT_MS = 30_000
const PROBE_TIMEOUT_MS = 45_000

const host = ref('')
const containers = ref<ListedContainer[] | null>(null)
const selected = ref('')
const agentKey = ref<RemoteAgentKey>('claude')
const listing = ref(false)
const testing = ref(false)
const error = ref('')
const probe = ref<ProbeResult | null>(null)
const recent = ref<RemoteRecent[]>([])

const recentHosts = computed(() => [...new Set(recent.value.map((r) => r.host))])

function reset(): void {
  recent.value = loadRemoteRecent()
  host.value = recent.value[0]?.host ?? ''
  agentKey.value = recent.value[0]?.agentKey ?? 'claude'
  containers.value = null
  selected.value = ''
  error.value = ''
  probe.value = null
}

watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })

const root = ref<HTMLElement | null>(null)
const hostInput = ref<HTMLInputElement | null>(null)
useDialogFocus(root, () => hostInput.value)

function selectable(c: ListedContainer): boolean {
  return c.running && (c.network.mode === 'host' || (c.network.mode === 'bridge' && !!c.network.gateway))
}

function networkOf(c: ListedContainer): RemoteNetwork {
  return c.network.mode === 'bridge' ? { mode: 'bridge', gateway: String(c.network.gateway) } : { mode: 'host' }
}

const target = computed<RemoteTarget | null>(() => {
  const c = containers.value?.find((row) => row.name === selected.value)
  if (!c || !selectable(c)) return null
  return { host: host.value.trim(), container: c.name, network: networkOf(c), cli: agentKey.value }
})

function sshError(reply: BackendReply): string {
  const stderr = reply.error?.details?.stderr
  const detail = (typeof stderr === 'string' && stderr.trim()) || reply.error?.message || reply.error?.code || ''
  return i18n.global.t('remoteDevcontainer.error-ssh', { host: host.value.trim(), detail })
}

async function listContainers(): Promise<void> {
  const name = host.value.trim()
  if (!name || listing.value) return
  listing.value = true
  error.value = ''
  probe.value = null
  containers.value = null
  selected.value = ''
  try {
    const reply = await props.backend.send('remote_devcontainer.list', { host: name }, LIST_TIMEOUT_MS)
    if (!reply.ok) {
      error.value = sshError(reply)
      return
    }
    const rows = (reply.payload as { containers?: ListedContainer[] } | null)?.containers
    containers.value = Array.isArray(rows) ? rows : []
    // The target used last on this host, when it is still there and usable.
    const last = recent.value.find((r) => r.host === name && containers.value!.some((c) => c.name === r.container && selectable(c)))
    if (last) {
      selected.value = last.container
      agentKey.value = last.agentKey
    }
  } catch (err) {
    error.value = i18n.global.t('remoteDevcontainer.error-ssh', { host: name, detail: err instanceof Error ? err.message : String(err) })
  } finally {
    listing.value = false
  }
}

watch([selected, agentKey], () => { probe.value = null })

async function testConnection(): Promise<void> {
  const remote = target.value
  if (!remote || testing.value) return
  testing.value = true
  error.value = ''
  probe.value = null
  try {
    const reply = await props.backend.send('remote_devcontainer.probe', { remote }, PROBE_TIMEOUT_MS)
    if (!reply.ok) {
      error.value = sshError(reply)
      return
    }
    probe.value = (reply.payload as ProbeResult | null) ?? {}
  } catch (err) {
    error.value = i18n.global.t('remoteDevcontainer.error-ssh', { host: remote.host, detail: err instanceof Error ? err.message : String(err) })
  } finally {
    testing.value = false
  }
}

interface ProbeLine { ok: boolean | null; text: string }

const probeLines = computed<ProbeLine[]>(() => {
  const r = probe.value
  const remote = target.value
  if (!r || !remote) return []
  const cli = REMOTE_AGENT_LABELS[agentKey.value]
  const t = i18n.global.t
  const lines: ProbeLine[] = [
    r.host_ok
      ? { ok: true, text: t('remoteDevcontainer.test-host-ok', { ms: r.elapsed_ms ?? 0 }) }
      : { ok: false, text: t('remoteDevcontainer.error-ssh', { host: remote.host, detail: r.error ?? '' }) },
  ]
  if (!r.host_ok) return lines
  lines.push(r.container_ok && r.cli_path
    ? { ok: true, text: t('remoteDevcontainer.test-cli-ok', { cli, container: remote.container, version: r.cli_version || r.cli_path }) }
    : { ok: false, text: t('remoteDevcontainer.test-cli-missing', { cli, container: remote.container }) })
  if (r.mcp === 'ok') lines.push({ ok: true, text: t('remoteDevcontainer.test-mcp-ok') })
  else if (r.mcp === 'unknown') lines.push({ ok: null, text: t('remoteDevcontainer.test-mcp-unknown') })
  else lines.push({ ok: false, text: t('remoteDevcontainer.test-mcp-failed') })
  return lines
})

function submit(): void {
  const remote = target.value
  if (!remote) return
  rememberRemoteRecent({ host: remote.host, container: remote.container, agentKey: remote.cli })
  emit('open', { remote })
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="remote-dlg nv-modal-overlay" @click.self="emit('cancel')" @keydown.esc="emit('cancel')">
      <section
        ref="root"
        class="remote-dlg-card nv-modal-shell"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('remoteDevcontainer.dialog-title')"
        data-testid="remote-dialog"
      >
        <header class="hdr">
          <h2>{{ $t('remoteDevcontainer.dialog-title') }} <span class="exp">{{ $t('arena.experimental') }}</span></h2>
          <button class="x" :aria-label="$t('remoteDevcontainer.cancel')" @click="emit('cancel')">✕</button>
        </header>

        <label class="field">
          <span class="lb">{{ $t('remoteDevcontainer.host-label') }}</span>
          <div class="host-row">
            <input
              ref="hostInput"
              v-model="host"
              type="text"
              spellcheck="false"
              autocomplete="off"
              list="remote-dlg-recent-hosts"
              :placeholder="$t('remoteDevcontainer.host-placeholder')"
              data-testid="remote-host"
              @keydown.enter.prevent="listContainers"
            />
            <datalist id="remote-dlg-recent-hosts" data-testid="remote-recent-hosts">
              <option v-for="h in recentHosts" :key="h" :value="h" />
            </datalist>
            <button :disabled="!host.trim() || listing" data-testid="remote-list" @click="listContainers">
              {{ listing ? $t('remoteDevcontainer.listing') : $t('remoteDevcontainer.list-containers') }}
            </button>
          </div>
        </label>

        <div v-if="containers" class="field">
          <span class="lb">{{ $t('remoteDevcontainer.container-label') }}</span>
          <p v-if="!containers.length" class="muted">{{ $t('remoteDevcontainer.no-containers') }}</p>
          <div v-else class="containers" role="radiogroup" :aria-label="$t('remoteDevcontainer.container-label')">
            <label
              v-for="c in containers"
              :key="c.name"
              class="crow"
              :class="{ disabled: !selectable(c), on: selected === c.name }"
              data-testid="remote-container-row"
            >
              <input v-model="selected" type="radio" name="remote-dlg-container" :value="c.name" :disabled="!selectable(c)" />
              <span class="cname">{{ c.name }}</span>
              <span class="cstate" :class="c.running ? 'run' : 'stop'">
                {{ c.running ? $t('remoteDevcontainer.running') : $t('remoteDevcontainer.stopped') }}
              </span>
              <span v-if="c.network.mode === 'unsupported'" class="muted" :title="c.network.detail">{{ $t('remoteDevcontainer.network-unsupported') }}</span>
            </label>
          </div>
        </div>

        <div class="field">
          <span class="lb">{{ $t('remoteDevcontainer.cli-label') }}</span>
          <div class="seg" role="radiogroup" :aria-label="$t('remoteDevcontainer.cli-label')">
            <button
              v-for="key in AGENT_KEYS"
              :key="key"
              type="button"
              role="radio"
              :aria-checked="agentKey === key ? 'true' : 'false'"
              :class="{ on: agentKey === key }"
              :data-testid="`remote-cli-${key}`"
              @click="agentKey = key"
            >{{ REMOTE_AGENT_LABELS[key] }}</button>
          </div>
        </div>

        <div class="field">
          <div class="test-row">
            <button :disabled="!target || testing" data-testid="remote-test" @click="testConnection">
              {{ testing ? $t('remoteDevcontainer.testing') : $t('remoteDevcontainer.test') }}
            </button>
            <span class="muted">{{ $t('remoteDevcontainer.test-steps') }}</span>
          </div>
          <ul v-if="probeLines.length" class="result" data-testid="remote-test-result">
            <li v-for="(line, i) in probeLines" :key="i" :class="line.ok === true ? 'ok' : line.ok === false ? 'bad' : 'warn'">
              <span class="mark" aria-hidden="true">{{ line.ok === true ? '✓' : line.ok === false ? '✗' : '?' }}</span>{{ line.text }}
            </li>
          </ul>
        </div>

        <p v-if="error" class="err" role="alert">{{ error }}</p>

        <p class="note">{{ $t('remoteDevcontainer.privacy-note') }}</p>
        <p class="note">{{ $t('remoteDevcontainer.account-note') }}</p>

        <footer class="actions">
          <button data-testid="remote-cancel" @click="emit('cancel')">{{ $t('remoteDevcontainer.cancel') }}</button>
          <button class="primary" :disabled="!target" data-testid="remote-open" @click="submit">{{ $t('remoteDevcontainer.open') }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.remote-dlg {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 120);
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
}
.remote-dlg-card {
  width: min(560px, 94vw);
  max-height: 90vh;
  overflow: auto;
  padding: 18px 20px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-base);
  box-shadow: var(--shadow-modal);
  color: var(--text-primary);
}
.hdr { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
h2 { margin: 0; font-size: 16px; }
.exp { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--text-secondary); }
.x { border: 0; background: none; color: var(--text-secondary); cursor: pointer; font-size: 14px; min-height: 0; padding: 0; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; min-width: 0; }
.lb { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.host-row, .test-row { display: flex; gap: 8px; align-items: center; min-width: 0; }
.host-row input { flex: 1; }
input[type='text'] {
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
}
.containers {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  max-height: 180px;
  overflow: auto;
}
.crow { display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-size: 13px; cursor: pointer; }
.crow + .crow { border-top: 1px solid var(--border-default); }
.crow.on { background: var(--bg-subtle); }
.crow.disabled { opacity: 0.55; cursor: default; }
.cname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono, monospace); }
.cstate { font-size: 11px; }
.cstate.run { color: var(--success-fg, #1a7f37); }
.cstate.stop { color: var(--text-secondary); }
.seg { display: inline-flex; align-self: flex-start; border: 1px solid var(--border-default); border-radius: var(--radius-sm); overflow: hidden; }
.seg button { border: 0; border-radius: 0; }
.seg button + button { border-left: 1px solid var(--border-default); }
.seg button.on { background: var(--accent-emphasis, var(--accent-focus)); color: var(--text-on-emphasis); }
.result { margin: 0; padding: 8px 10px; list-style: none; border: 1px solid var(--border-default); border-radius: var(--radius-sm); background: var(--bg-subtle); font-size: 12px; }
.result li { display: flex; gap: 6px; }
.result li + li { margin-top: 4px; }
.mark { width: 12px; flex: none; font-weight: 700; }
.ok .mark { color: var(--success-fg, #1a7f37); }
.bad .mark { color: var(--danger-fg, #cf222e); }
.warn .mark { color: var(--attention-fg, #9a6700); }
.muted { color: var(--text-secondary); font-size: 12px; margin: 0; }
.note { color: var(--text-secondary); font-size: 11px; margin: 0 0 6px; }
.err { color: var(--danger-fg, #cf222e); font-size: 12px; margin: 0 0 10px; white-space: pre-wrap; word-break: break-word; }
button {
  min-height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--accent-emphasis, var(--accent-focus)); border-color: transparent; color: var(--text-on-emphasis); }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
</style>
