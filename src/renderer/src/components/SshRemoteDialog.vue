<script setup lang="ts">
// ＋ menu → SSH Remote…: host, user, port and a private key path, the remote
// folder and what to open there (a terminal or a CLI), plus the recent
// connections. Connect sends the target to `remote_ssh.connect`, which checks
// the host once; on success the app opens the pane there. A
// failure is explained in plain terms; after a key or host-key refusal the
// user may open the pane anyway, where ssh itself asks for the passphrase or
// the fingerprint.
//
// The key is a path only: nothing here reads, copies or uploads it.
import { computed, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { AGENT_SPECS } from '@navide/plugin-shell'
import { useDialogFocus } from '../composables/useDialogFocus'
import {
  SSH_DEFAULT_DIR,
  SSH_DEFAULT_PORT,
  SSH_MCP_CLIS,
  SSH_REMOTE_CLIS,
  SSH_RESUMABLE_CLIS,
  SSH_TERMINAL,
  loadSshRemoteRecent,
  rememberSshRemoteRecent,
  sshFailureReason,
  sshTargetLabel,
  type SshFailureReason,
  type SshRemoteTarget,
} from '../composables/useSshRemotePrefs'

interface BackendReply {
  ok: boolean
  payload?: unknown
  error?: { code?: string; message?: string; details?: unknown } | null
}

const props = defineProps<{
  open: boolean
  backend: { send: (type: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<BackendReply> }
}>()
const emit = defineEmits<{ connected: [target: SshRemoteTarget]; cancel: [] }>()

// The backend's own ssh check gives up after 25 s.
const CONNECT_TIMEOUT_MS = 30_000

const host = ref('')
const user = ref('')
const port = ref<number | string>(SSH_DEFAULT_PORT)
const keyPath = ref('')
const remoteDir = ref(SSH_DEFAULT_DIR)
const cli = ref<string>(SSH_TERMINAL)
const recent = ref<SshRemoteTarget[]>([])
const busy = ref(false)
const error = ref('')
/** Why the last check failed; null when it did not. */
const reason = ref<SshFailureReason | null>(null)
const canForce = computed(() => reason.value === 'auth' || reason.value === 'host-key')

/** The CLIs the host can run, labelled as everywhere else in the app. */
const cliOptions = SSH_REMOTE_CLIS.map((key) => ({
  key,
  label: AGENT_SPECS.find((s) => s.agentKey === key)?.label ?? key,
}))
const cliLabel = computed(() => cliOptions.find((o) => o.key === cli.value)?.label ?? cli.value)
const isCli = computed(() => cli.value !== SSH_TERMINAL)

function fill(t: SshRemoteTarget): void {
  host.value = t.host
  user.value = t.user
  port.value = t.port
  keyPath.value = t.keyPath
  remoteDir.value = t.dir || SSH_DEFAULT_DIR
  cli.value = t.cli || SSH_TERMINAL
}

function reset(): void {
  recent.value = loadSshRemoteRecent()
  host.value = ''
  user.value = ''
  port.value = SSH_DEFAULT_PORT
  keyPath.value = ''
  remoteDir.value = SSH_DEFAULT_DIR
  cli.value = SSH_TERMINAL
  error.value = ''
  reason.value = null
}

watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })
watch([host, user, port, keyPath], () => { reason.value = null; error.value = '' })

const root = ref<HTMLElement | null>(null)
const hostInput = ref<HTMLInputElement | null>(null)
useDialogFocus(root, () => hostInput.value)

const target = computed<SshRemoteTarget | null>(() => {
  const name = host.value.trim()
  const p = Number(port.value)
  if (!name || !Number.isInteger(p) || p < 1 || p > 65535) return null
  return {
    host: name,
    user: user.value.trim(),
    port: p,
    keyPath: keyPath.value.trim(),
    dir: remoteDir.value.trim() || SSH_DEFAULT_DIR,
    cli: cli.value,
  }
})

async function connect(force = false): Promise<void> {
  const t = target.value
  if (!t || busy.value) return
  busy.value = true
  error.value = ''
  reason.value = null
  try {
    // The check needs the connection only; the folder and CLI are the pane's.
    const connection = { host: t.host, user: t.user, port: t.port, keyPath: t.keyPath }
    const reply = await props.backend.send(
      'remote_ssh.connect', { target: connection, ...(force ? { force: true } : {}) }, CONNECT_TIMEOUT_MS)
    if (reply.ok) {
      rememberSshRemoteRecent(t)
      emit('connected', t)
      return
    }
    if (reply.error?.code === 'REMOTE_SSH_FAILED') {
      reason.value = sshFailureReason(reply.error)
      return
    }
    error.value = i18n.global.t('sshRemote.error', { detail: reply.error?.message || reply.error?.code || '' })
  } catch (err) {
    error.value = i18n.global.t('sshRemote.error', { detail: err instanceof Error ? err.message : String(err) })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="ssh-dlg nv-modal-overlay" @click.self="emit('cancel')" @keydown.esc="emit('cancel')">
      <section
        ref="root"
        class="ssh-dlg-card nv-modal-shell"
        role="dialog"
        aria-modal="true"
        :aria-label="$t('sshRemote.dialog-title')"
        data-testid="ssh-dialog"
      >
        <header class="hdr">
          <h2>{{ $t('sshRemote.dialog-title') }} <span class="exp">{{ $t('arena.experimental') }}</span></h2>
          <button class="x" :aria-label="$t('sshRemote.cancel')" @click="emit('cancel')">✕</button>
        </header>

        <form class="grid" @submit.prevent="connect()">
          <label class="field wide">
            <span class="lb">{{ $t('sshRemote.host-label') }}</span>
            <input ref="hostInput" v-model="host" type="text" spellcheck="false" autocomplete="off" :placeholder="$t('sshRemote.host-placeholder')" data-testid="ssh-host" />
          </label>
          <label class="field">
            <span class="lb">{{ $t('sshRemote.user-label') }}</span>
            <input v-model="user" type="text" spellcheck="false" autocomplete="off" :placeholder="$t('sshRemote.user-placeholder')" data-testid="ssh-user" />
          </label>
          <label class="field">
            <span class="lb">{{ $t('sshRemote.port-label') }}</span>
            <input v-model="port" type="number" min="1" max="65535" data-testid="ssh-port" />
          </label>
          <label class="field wide">
            <span class="lb">{{ $t('sshRemote.key-label') }}</span>
            <input v-model="keyPath" type="text" spellcheck="false" autocomplete="off" :placeholder="$t('sshRemote.key-placeholder')" data-testid="ssh-key" />
            <span class="muted">{{ $t('sshRemote.key-hint') }}</span>
          </label>
          <label class="field wide">
            <span class="lb">{{ $t('sshRemote.dir-label') }}</span>
            <input v-model="remoteDir" type="text" spellcheck="false" autocomplete="off" :placeholder="$t('sshRemote.dir-placeholder')" data-testid="ssh-dir" />
          </label>
          <label class="field wide">
            <span class="lb">{{ $t('sshRemote.run-label') }}</span>
            <select v-model="cli" data-testid="ssh-cli">
              <option :value="SSH_TERMINAL">{{ $t('sshRemote.run-terminal') }}</option>
              <option v-for="o in cliOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
            </select>
          </label>
          <button type="submit" hidden />
        </form>

        <div v-if="isCli" class="cli-notes" data-testid="ssh-cli-notes">
          <p class="note">{{ $t('sshRemote.accounts-note', { cli: cliLabel }) }}</p>
          <p class="note" data-testid="ssh-tools-note">{{ SSH_MCP_CLIS.includes(cli) ? $t('sshRemote.tools-note', { cli: cliLabel }) : $t('sshRemote.no-tools-note', { cli: cliLabel }) }}</p>
          <p class="note">{{ SSH_RESUMABLE_CLIS.includes(cli) ? $t('sshRemote.resume-note') : $t('sshRemote.fresh-note', { cli: cliLabel }) }}</p>
        </div>

        <div class="field">
          <span class="lb">{{ $t('sshRemote.recent-label') }}</span>
          <p v-if="!recent.length" class="muted">{{ $t('sshRemote.recent-empty') }}</p>
          <div v-else class="recent" data-testid="ssh-recent">
            <button v-for="r in recent" :key="sshTargetLabel(r)" type="button" class="recent-row" data-testid="ssh-recent-row" v-truncate @click="fill(r)">
              {{ sshTargetLabel(r) }}
            </button>
          </div>
        </div>

        <div v-if="reason" class="err" role="alert" data-testid="ssh-reason">
          <p class="reason-text">{{ $t(`sshRemote.reason-${reason}`, { host: target?.host ?? '' }) }}</p>
          <button v-if="canForce" type="button" data-testid="ssh-force" :disabled="busy" @click="connect(true)">{{ $t('sshRemote.open-anyway') }}</button>
        </div>
        <p v-if="error" class="err" role="alert">{{ error }}</p>

        <p class="note">{{ $t('sshRemote.privacy-note') }}</p>

        <footer class="actions">
          <button data-testid="ssh-cancel" @click="emit('cancel')">{{ $t('sshRemote.cancel') }}</button>
          <button class="primary" :disabled="!target || busy" data-testid="ssh-connect" @click="connect()">
            {{ busy ? $t('sshRemote.connecting') : $t('sshRemote.connect') }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.ssh-dlg {
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
.ssh-dlg-card {
  width: min(520px, 94vw);
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
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 110px; gap: 0 12px; }
.field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; min-width: 0; }
.field.wide { grid-column: 1 / -1; }
.lb { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
input,
select {
  min-width: 0;
  padding: 6px 8px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
}
.recent { display: flex; flex-direction: column; border: 1px solid var(--border-default); border-radius: var(--radius-sm); max-height: 160px; overflow: auto; }
.recent-row { border: 0; border-radius: 0; background: none; text-align: left; font-family: var(--font-mono, monospace); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.recent-row + .recent-row { border-top: 1px solid var(--border-default); }
.recent-row:hover { background: var(--bg-subtle); }
.muted { color: var(--text-secondary); font-size: 12px; margin: 0; }
.note { color: var(--text-secondary); font-size: 11px; margin: 0 0 6px; }
.cli-notes { margin-bottom: 6px; }
.reason-text { margin: 0 0 6px; }
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
