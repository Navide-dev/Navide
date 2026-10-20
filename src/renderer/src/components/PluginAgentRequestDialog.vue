<script setup lang="ts">
/**
 * The user's side of an agent's Navide plugin request (plan B, B2; contract
 * section 6). The MCP tools only file a request; nothing changes until the
 * user approves it here. Requests queue and are shown one at a time; one
 * decided in another window, finished or expired is dropped via the resolved
 * event.
 *
 * The card shows the Navide Marketplace's disclosure card for the requested
 * version (Registry data, not verified: the package itself is verified when
 * the install flow downloads it) and, for an update or a rollback, what would
 * change from the installed version. Approving asks the backend to move the
 * request to `applying` (a confirmation only this window can mint), then
 * carries it out with this window's own flows (applyApprovedRequest): the
 * install flow with its trust dialog, the rollback, the remove dialog, or the
 * Disabled switch, and reports the result.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotify } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'
import { usePluginAgentRequests } from '../composables/usePluginAgentRequests'
import { usePluginInventory } from '../composables/usePluginInventory'
import { askUninstall, ipcErrorMessage, removeWithAnswer, usePluginInstallFlow } from '../composables/usePluginInstallFlow'
import {
  applyApprovedRequest,
  isAppliableKind,
  type FinishStatus,
  type PluginRequestApplyDeps,
  type PluginRequestRecord,
} from '../lib/pluginAgentRequestApply'
import {
  PLUGIN_APPROVAL_DECIDE_ACTION,
  PLUGIN_APPROVAL_LIST_MESSAGE,
  PLUGIN_APPROVAL_REQUEST_EVENT,
  PLUGIN_APPROVAL_RESOLVED_EVENT,
  isFormApprovalKind,
  revealInvisibleText,
  type PluginApprovalRequest,
} from '../../../shared/pluginAgentTools'
import { diffDisclosure, type DisclosureDiff, type ManifestDisclosure } from '../../../shared/pluginDisclosure'
import PluginDisclosureCard from './PluginDisclosureCard.vue'
import PluginDisclosureDiff from './PluginDisclosureDiff.vue'
import PluginTrustDialog from './PluginTrustDialog.vue'

/** A plugin request as listed; `plugin-enable` and `disabled` come with the
 *  "who disabled it" requests (they are read when present). */
export type PluginAgentRequest = Omit<PluginApprovalRequest, 'kind'> & {
  kind: PluginApprovalRequest['kind'] | 'plugin-enable'
  disabled?: {
    by: 'user' | 'agent'
    /** Unix seconds, or null when it was not recorded. */
    at: number | null
    agent: { callerKind: string; paneId: string | null; paneName: string | null } | null
  } | null
}

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t } = useI18n()
const notify = useNotify()
const flow = usePluginInstallFlow()
const inventory = usePluginInventory()
const requests = usePluginAgentRequests(props.backend)

const queue = ref<PluginAgentRequest[]>([])
const busy = ref(false)
const error = ref('')
const outcome = ref<'completed' | 'failed' | null>(null)
const finishedLate = ref(false)
const installedDisclosure = ref<ManifestDisclosure | null>(null)
const now = ref(Date.now())
const current = computed(() => queue.value[0] ?? null)
// created_at / expires_at are Unix seconds; the backend expires lazily.
const expired = computed(() => !!current.value && current.value.expires_at * 1000 <= now.value)
const label = computed(() => (current.value ? `${current.value.target.namespace}.${current.value.target.name}` : ''))
// A kind this Navide cannot carry out yet is shown but cannot be approved.
const appliable = computed(() => !!current.value && isAppliableKind(current.value.kind))

function enqueue(request: PluginAgentRequest): void {
  if (!request?.approval_id || request.status !== 'pending') return
  // A form request (an agent's draft) opens its form in Settings, not this card.
  if (isFormApprovalKind(request.kind)) return
  if (queue.value.some((r) => r.approval_id === request.approval_id)) return
  queue.value.push(request)
}

function drop(approvalId: string): void {
  queue.value = queue.value.filter((r) => r.approval_id !== approvalId)
}

async function refresh(): Promise<void> {
  try {
    const res = await props.backend.send<{ requests: PluginAgentRequest[] }>(PLUGIN_APPROVAL_LIST_MESSAGE)
    if (!res.ok || !Array.isArray(res.payload?.requests)) return
    const pending = new Set(res.payload.requests.filter((r) => r.status === 'pending').map((r) => r.approval_id))
    queue.value = queue.value.filter((r) => pending.has(r.approval_id) || r.approval_id === busyId.value)
    res.payload.requests.forEach(enqueue)
  } catch {
    // Disconnected: the reconnect watcher below asks again.
  }
}

const title = computed(() => {
  const r = current.value
  if (!r) return ''
  const values = { plugin: label.value, version: r.target.version ?? '', from: r.target.fromVersion ?? '' }
  return t(`plugin-request.title.${r.kind.replace('plugin-', '')}`, values)
})

function callerText(kind: string | null | undefined, paneName: string | null | undefined): string {
  if (kind === 'pane') return paneName ? t('plugin-agent.caller.pane', { pane: paneName }) : t('plugin-agent.caller.pane-unknown')
  if (kind === 'external') return t('plugin-agent.caller.external')
  if (kind === 'host') return t('plugin-agent.caller.host')
  return t('plugin-request.caller-unknown')
}

const requesterText = computed(() =>
  current.value ? callerText(current.value.requester.callerKind, current.value.requester.paneName) : '',
)
const disabledByText = computed(() => {
  const disabled = current.value?.disabled
  if (!disabled) return ''
  if (disabled.by === 'user') return t('plugin-request.disabled-by-user')
  return callerText(disabled.agent?.callerKind, disabled.agent?.paneName)
})
const disabledAtText = computed(() => {
  const at = current.value?.disabled?.at
  return typeof at === 'number' ? new Date(at * 1000).toLocaleString() : t('plugin-request.not-recorded')
})
const expiresText = computed(() =>
  current.value ? new Date(current.value.expires_at * 1000).toLocaleTimeString() : '',
)
// Agent-written text is shown as plain text, with invisible characters spelled out.
const reasonText = computed(() => (current.value?.reason ? revealInvisibleText(current.value.reason) : ''))

// The disclosure shown: the requested version's listing card; for a removal
// with no card, what the installed version declares.
const shownDisclosure = computed<ManifestDisclosure | null>(() => {
  const r = current.value
  if (!r) return null
  if (r.card?.manifest) return r.card.manifest
  return r.kind === 'plugin-remove' ? installedDisclosure.value : null
})
const diff = computed<DisclosureDiff | null>(() => {
  const r = current.value
  if (!r || (r.kind !== 'plugin-update' && r.kind !== 'plugin-rollback')) return null
  if (!installedDisclosure.value || !r.card?.manifest) return null
  try {
    return diffDisclosure(installedDisclosure.value, r.card.manifest)
  } catch {
    return null
  }
})

watch(() => current.value?.approval_id, async (approvalId) => {
  error.value = ''
  outcome.value = null
  finishedLate.value = false
  installedDisclosure.value = null
  const r = current.value
  if (!approvalId || !r || r.kind === 'plugin-install') return
  try {
    installedDisclosure.value = (await window.agentTeam?.plugins?.installedDisclosure?.(r.target.id)) ?? null
  } catch {
    installedDisclosure.value = null  // the diff is only shown when it can be computed
  }
})

/** Resolves once the install flow has settled: committed, cancelled in the
 *  trust dialog, or failed. */
function installSettled(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => !flow.busy.value && !flow.pendingConfirm.value
    if (done()) {
      resolve()
      return
    }
    const stop = watch(() => [flow.busy.value, flow.pendingConfirm.value], () => {
      if (!done()) return
      stop()
      resolve()
    })
  })
}

function applyDeps(): PluginRequestApplyDeps {
  const plugins = () => {
    const api = window.agentTeam?.plugins
    if (!api) throw new Error(t('plugin-request.unavailable'))
    return api
  }
  const deps = {
    async install(namespace: string, name: string, version: string): Promise<void> {
      await flow.install(namespace, name, version)
      await installSettled()
      if (flow.error.value) throw new Error(flow.error.value)
    },
    // W1 (S2): the copy the Host staged when the agent asked, through the same
    // consent dialog as the user's own "Install from file".
    async installStaged(stagingId: string, digest: string | null): Promise<void> {
      await flow.prepareAgentFile(stagingId, digest, requesterText.value)
      await installSettled()
      if (flow.error.value) throw new Error(flow.error.value)
    },
    async rollback(pluginId: string): Promise<void> {
      // The same confirmation the Extensions pane asks before a rollback.
      const row = (await plugins().listInstalled()).find((p) => p.id === pluginId)
      const confirmed = await notify.confirm(
        row?.rollbackKind === 'factory'
          ? t('settings.extensions.rollback.confirmFactory', { id: pluginId })
          : t('settings.extensions.rollback.confirmPrevious', {
              id: pluginId,
              version: row?.rollbackToVersion ?? t('settings.extensions.rollback.previousVersion'),
            }),
        {
          title: t('settings.extensions.rollback.title'),
          confirmText: t('settings.extensions.rollback.confirm'),
          danger: true,
        },
      )
      if (!confirmed) return  // cancelled: nothing rolled back, the request finishes not-applied
      await plugins().rollback(pluginId)
      await inventory.refresh()
    },
    async remove(pluginId: string): Promise<void> {
      const answer = await askUninstall(t, notify, pluginId)
      if (!answer) return  // cancelled: nothing removed, the request finishes not-applied
      await removeWithAnswer(plugins(), pluginId, answer)
      await inventory.refresh()
    },
    // Used for a plugin-enable request (the user's own Disabled switch).
    async enable(pluginId: string): Promise<void> {
      await plugins().setDisabled(pluginId, false)
      await inventory.refresh()
    },
    listInstalled: requests.listInstalled,
    async finish(approvalId: string, result: FinishStatus): Promise<void> {
      const record = await requests.finish(approvalId, result)
      // Another window had settled it first (this one was reconnecting): the
      // backend recorded this result afterwards; say so.
      finishedLate.value = record?.finished_late === true
    },
  }
  return deps
}

const busyId = ref<string | null>(null)

async function decide(approve: boolean): Promise<void> {
  const request = current.value
  if (!request || busy.value) return
  if (approve && !isAppliableKind(request.kind)) return
  busy.value = true
  busyId.value = request.approval_id
  error.value = ''
  try {
    const subject = `${request.approval_id}:${approve ? 'approve' : 'reject'}`
    const confirmation = await window.agentTeam?.trustConfirm(PLUGIN_APPROVAL_DECIDE_ACTION, '', subject)
    const res = await props.backend.send<{ approval: PluginAgentRequest }>(
      PLUGIN_APPROVAL_DECIDE_ACTION,
      { approval_id: request.approval_id, approve, confirmation },
      120_000,
    )
    if (!res.ok) {
      error.value = res.error?.message ?? t('plugin-request.failed', { error: '' })
      if (res.error?.code === 'PLUGIN_APPROVAL_NOT_PENDING' || res.error?.code === 'PLUGIN_APPROVAL_NOT_FOUND') {
        drop(request.approval_id)
      }
      return
    }
    if (!approve) {
      drop(request.approval_id)
      return
    }
    const record = (res.payload?.approval ?? request) as unknown as PluginRequestRecord
    const result = await applyApprovedRequest(record, applyDeps())
    if (result.status === 'completed') {
      notify.toast(
        t(finishedLate.value ? 'plugin-request.completed-late' : 'plugin-request.completed', { plugin: label.value }),
        { type: finishedLate.value ? 'info' : 'success' },
      )
      drop(request.approval_id)
    } else {
      outcome.value = 'failed'
      error.value = t('plugin-request.failed', { error: result.error })
    }
  } catch (err) {
    error.value = ipcErrorMessage(err)
  } finally {
    busy.value = false
    busyId.value = null
  }
}

const offs: (() => void)[] = []
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  clock = setInterval(() => { now.value = Date.now() }, 5_000)
  offs.push(props.backend.on(PLUGIN_APPROVAL_REQUEST_EVENT, (raw) => enqueue(raw as PluginAgentRequest)))
  offs.push(props.backend.on(PLUGIN_APPROVAL_RESOLVED_EVENT, (raw) => {
    const { approval_id: approvalId } = raw as { approval_id: string }
    // The request this window is carrying out stays until its own result shows,
    // and a shown failed result stays until dismissed; any other request goes.
    if (approvalId === busyId.value) return
    if (outcome.value !== null && approvalId === current.value?.approval_id) return
    drop(approvalId)
  }))
  void refresh()
})
onBeforeUnmount(() => {
  offs.forEach((off) => off())
  clearInterval(clock)
})
watch(() => props.backend.status.value, (status) => { if (status === 'connected') void refresh() })
</script>

<template>
  <div v-if="current" class="pr-page" role="dialog" aria-modal="true" data-testid="plugin-request-dialog">
    <section class="pr-dialog">
      <header class="pr-top">
        <div>
          <div class="pr-kicker">{{ $t('plugin-request.kicker') }}</div>
          <h1>{{ title }}</h1>
          <p class="pr-desc">{{ $t('plugin-request.desc') }}</p>
        </div>
        <span v-if="queue.length > 1" class="pr-badge">{{ $t('plugin-request.queue', { count: queue.length }) }}</span>
      </header>

      <main class="pr-main">
        <dl class="pr-facts">
          <dt>{{ $t('plugin-request.requester') }}</dt><dd>{{ requesterText }}</dd>
          <template v-if="current.requester.workspace">
            <dt>{{ $t('plugin-request.workspace') }}</dt><dd class="pr-mono">{{ current.requester.workspace }}</dd>
          </template>
          <template v-if="current.kind === 'plugin-enable'">
            <dt>{{ $t('plugin-request.disabled-by') }}</dt><dd data-testid="plugin-request-disabled-by">{{ disabledByText }}</dd>
            <dt>{{ $t('plugin-request.disabled-at') }}</dt><dd data-testid="plugin-request-disabled-at">{{ disabledAtText }}</dd>
          </template>
          <template v-if="current.kind === 'plugin-install-file'">
            <dt>{{ $t(current.target.packageKind === 'folder' ? 'plugin-request.file.folder' : 'plugin-request.file.path') }}</dt>
            <dd class="pr-mono" data-testid="plugin-request-file-path">{{ revealInvisibleText(current.target.path ?? '') }}</dd>
            <template v-if="current.target.digest">
              <dt>{{ $t('plugin-request.file.digest') }}</dt>
              <dd class="pr-mono" data-testid="plugin-request-file-digest">{{ current.target.digest }}</dd>
            </template>
          </template>
          <dt>{{ $t('plugin-request.expires') }}</dt><dd>{{ expiresText }}</dd>
        </dl>
        <!-- W1 (S2): a local file is no Marketplace version; nothing vouches for it. -->
        <p v-if="current.kind === 'plugin-install-file'" class="pr-note pr-unreviewed" role="note" data-testid="plugin-request-file-unreviewed">
          {{ $t(current.target.packageKind === 'folder' ? 'plugin-request.file.unreviewed-folder' : 'plugin-request.file.unreviewed') }}
        </p>

        <div v-if="reasonText" class="pr-reason">
          <div class="pr-label">{{ $t('plugin-request.reason') }}</div>
          <p data-testid="plugin-request-reason">{{ reasonText }}</p>
        </div>

        <div v-if="diff" class="pr-section" data-testid="plugin-request-diff">
          <div class="pr-label">{{ $t('plugin-request.diff') }}</div>
          <PluginDisclosureDiff :diff="diff" />
        </div>

        <div class="pr-section">
          <div class="pr-label">{{ $t('plugin-request.card') }}</div>
          <PluginDisclosureCard
            v-if="shownDisclosure"
            :disclosure="shownDisclosure"
            :scan="current.card?.manifest ? current.card.scan ?? null : null"
            :registry="current.card?.registry ?? null"
            :verified="false"
          />
          <p v-else class="pr-note" data-testid="plugin-request-no-card">{{ $t('plugin-request.no-card') }}</p>
        </div>

        <p v-if="!appliable" class="pr-note" data-testid="plugin-request-not-appliable">{{ $t('plugin-request.not-appliable') }}</p>
        <pre v-if="expired" class="pr-error">{{ $t('plugin-request.expired') }}</pre>
        <pre v-else-if="error" class="pr-error" data-testid="plugin-request-error">{{ error }}</pre>
        <p v-if="finishedLate && outcome === 'failed'" class="pr-note" data-testid="plugin-request-finished-late">{{ $t('plugin-request.finished-late') }}</p>
      </main>

      <footer class="pr-footer">
        <span />
        <button
          v-if="expired || outcome === 'failed'"
          class="pr-btn ghost nv-btn"
          data-testid="plugin-request-dismiss"
          @click="drop(current.approval_id)"
        >
          {{ $t('plugin-request.dismiss') }}
        </button>
        <template v-else>
          <button class="pr-btn ghost nv-btn" :disabled="busy" data-testid="plugin-request-reject" @click="decide(false)">
            {{ $t('plugin-request.reject') }}
          </button>
          <button
            class="pr-btn primary nv-btn nv-btn--primary"
            :disabled="busy || !appliable"
            :title="appliable ? undefined : $t('plugin-request.not-appliable')"
            data-testid="plugin-request-approve"
            @click="decide(true)"
          >
            {{ busy ? $t('plugin-request.applying') : $t('plugin-request.approve') }}
          </button>
        </template>
      </footer>
    </section>

    <PluginTrustDialog
      v-if="flow.pendingConfirm.value"
      :pending="flow.pendingConfirm.value"
      :step="flow.pendingStep.value"
      @confirm-replace="flow.confirmReplace"
      @confirm-publisher="flow.confirmPublisher"
      @confirm-risk="flow.confirmRisk"
      @cancel="flow.cancel"
    />
  </div>
</template>

<style scoped>
.pr-page {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-modal) + 141);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  color: var(--text-primary);
  -webkit-app-region: no-drag;
}
.pr-dialog {
  width: min(var(--modal-w-standard), 92vw);
  max-height: min(760px, calc(100vh - 56px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-base);
  box-shadow: var(--shadow-modal);
}
.pr-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 22px 28px 18px; border-bottom: 1px solid var(--border-muted); }
.pr-kicker { color: var(--accent-bright); font-size: var(--font-xs); font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 6px 0 0; color: var(--text-bright); font-size: 20px; overflow-wrap: anywhere; }
.pr-desc { margin: 6px 0 0; color: var(--text-muted); font-size: 12.5px; line-height: 1.5; }
.pr-badge { flex: none; font-size: var(--font-2xs); border-radius: 99px; padding: 2px 9px; background: var(--bg-subtle); color: var(--text-muted); }
.pr-main { padding: 18px 28px; overflow: auto; }
.pr-facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0 0 14px; font-size: 12.5px; }
.pr-facts dt { color: var(--text-muted); }
.pr-facts dd { margin: 0; color: var(--text-primary); overflow-wrap: anywhere; }
.pr-mono { font-family: var(--font-mono, monospace); }
.pr-label { color: var(--text-muted); font-size: var(--font-2xs); letter-spacing: .06em; text-transform: uppercase; margin-bottom: 6px; }
.pr-reason { margin: 0 0 14px; padding: 10px 12px; border: 1px dashed var(--border-default); border-radius: 10px; background: var(--bg-subtle); }
.pr-reason p { margin: 0; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.pr-section { margin: 0 0 14px; }
.pr-note { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.pr-unreviewed { margin: 0 0 14px; padding: 8px 12px; border-radius: 8px; background: var(--bg-subtle); color: var(--danger-fg); }
.pr-error {
  margin: 8px 0 0; padding: 10px 12px; max-height: 120px; overflow: auto;
  border-radius: 8px; background: var(--bg-subtle); color: var(--danger-fg);
  font-size: 11.5px; line-height: var(--lh-base); white-space: pre-wrap; overflow-wrap: anywhere;
}
.pr-footer { display: flex; align-items: center; gap: 10px; padding: 14px 28px; border-top: 1px solid var(--border-muted); }
.pr-footer span { flex: 1; }
.pr-btn { border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 8px 13px; cursor: pointer; color: var(--text-primary); background: var(--bg-subtle); font-size: var(--font-sm); transition: background var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.pr-btn.primary { border-color: var(--accent-emphasis); background: var(--accent-emphasis); color: var(--text-on-emphasis); }
.pr-btn.ghost { background: transparent; }
.pr-btn:hover:not(:disabled) { background: var(--bg-hover-strong); border-color: var(--border-strong); }
.pr-btn.primary:hover:not(:disabled) { background: var(--accent-focus); border-color: var(--accent-focus); }
.pr-btn:disabled { opacity: .5; cursor: not-allowed; }
@media (max-width: 620px) {
  .pr-page { padding: 14px; }
  .pr-dialog { width: calc(100vw - 28px); }
  .pr-top, .pr-main, .pr-footer { padding-left: 18px; padding-right: 18px; }
}
</style>
