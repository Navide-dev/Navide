<script setup lang="ts">
// ＋ menu → SSH Remote…: host, user, port and a private key path, plus the
// recent connections. Connect sends the target to `remote_ssh.connect`; the
// backend does not open SSH Remote panes yet, so the expected answer is
// REMOTE_SSH_UNSUPPORTED, shown as a notice — never a hang.
//
// The key is a path only: nothing here reads, copies or uploads it.
import { computed, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { useDialogFocus } from '../composables/useDialogFocus'
import {
  SSH_DEFAULT_PORT,
  loadSshRemoteRecent,
  rememberSshRemoteRecent,
  sshTargetLabel,
  type SshRemoteTarget,
} from '../composables/useSshRemotePrefs'

interface BackendReply {
  ok: boolean
  payload?: unknown
  error?: { code?: string; message?: string } | null
}

const props = defineProps<{
  open: boolean
  backend: { send: (type: string, payload?: Record<string, unknown>, timeoutMs?: number) => Promise<BackendReply> }
}>()
const emit = defineEmits<{ connected: [target: SshRemoteTarget]; cancel: [] }>()

const CONNECT_TIMEOUT_MS = 15_000

const host = ref('')
const user = ref('')
const port = ref<number | string>(SSH_DEFAULT_PORT)
const keyPath = ref('')
const recent = ref<SshRemoteTarget[]>([])
const busy = ref(false)
const error = ref('')
const unsupported = ref(false)

function fill(t: SshRemoteTarget): void {
  host.value = t.host
  user.value = t.user
  port.value = t.port
  keyPath.value = t.keyPath
}

function reset(): void {
  recent.value = loadSshRemoteRecent()
  host.value = ''
  user.value = ''
  port.value = SSH_DEFAULT_PORT
  keyPath.value = ''
  error.value = ''
  unsupported.value = false
}

watch(() => props.open, (open) => { if (open) reset() }, { immediate: true })
watch([host, user, port, keyPath], () => { unsupported.value = false; error.value = '' })

const root = ref<HTMLElement | null>(null)
const hostInput = ref<HTMLInputElement | null>(null)
useDialogFocus(root, () => hostInput.value)

const target = computed<SshRemoteTarget | null>(() => {
  const name = host.value.trim()
  const p = Number(port.value)
  if (!name || !Number.isInteger(p) || p < 1 || p > 65535) return null
  return { host: name, user: user.value.trim(), port: p, keyPath: keyPath.value.trim() }
})

async function connect(): Promise<void> {
  const t = target.value
  if (!t || busy.value) return
  busy.value = true
  error.value = ''
  unsupported.value = false
  try {
    const reply = await props.backend.send('remote_ssh.connect', { target: { ...t } }, CONNECT_TIMEOUT_MS)
    if (reply.ok) {
      rememberSshRemoteRecent(t)
      emit('connected', t)
      return
    }
    if (reply.error?.code === 'REMOTE_SSH_UNSUPPORTED') {
      // The target itself was accepted; only the pane is not built yet.
      rememberSshRemoteRecent(t)
      recent.value = loadSshRemoteRecent()
      unsupported.value = true
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

        <form class="grid" @submit.prevent="connect">
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
          <button type="submit" hidden />
        </form>

        <div class="field">
          <span class="lb">{{ $t('sshRemote.recent-label') }}</span>
          <p v-if="!recent.length" class="muted">{{ $t('sshRemote.recent-empty') }}</p>
          <div v-else class="recent" data-testid="ssh-recent">
            <button v-for="r in recent" :key="sshTargetLabel(r)" type="button" class="recent-row" data-testid="ssh-recent-row" @click="fill(r)">
              {{ sshTargetLabel(r) }}
            </button>
          </div>
        </div>

        <p v-if="unsupported" class="notice" role="status" data-testid="ssh-unsupported">{{ $t('sshRemote.unsupported') }}</p>
        <p v-if="error" class="err" role="alert">{{ error }}</p>

        <p class="note">{{ $t('sshRemote.privacy-note') }}</p>

        <footer class="actions">
          <button data-testid="ssh-cancel" @click="emit('cancel')">{{ $t('sshRemote.cancel') }}</button>
          <button class="primary" :disabled="!target || busy" data-testid="ssh-connect" @click="connect">
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
input {
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
.notice { color: var(--attention-fg, #9a6700); font-size: 12px; margin: 0 0 10px; }
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
