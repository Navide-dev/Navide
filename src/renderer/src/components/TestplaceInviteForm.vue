<script setup lang="ts">
/**
 * The Testplace invitation form (plan mcp-navide-0-2-27, W5b), shown in
 * Settings > Navide Marketplace > Developer next to the W3 forms.
 *
 * It opens three ways onto the same Send: the user's own click, an agent's
 * marketplace_testplace_invite_open (a plugin id at most) and an agent's
 * marketplace_testplace_invite_fill (a draft list of testers, each line the
 * agent wrote marked as such). Only the user's Send creates invitations
 * (submitMarketplaceForm). The join codes the Registry returns are shown here
 * once and go nowhere else: not to the agent, not into the request's result.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../composables/useBackend'
import {
  closeMarketplaceForm,
  decideFormRequest,
  submitMarketplaceForm,
  type OpenMarketplaceForm,
} from '../composables/useMarketplaceForms'
import { ipcErrorMessage } from '../composables/usePluginInstallFlow'
import { revealInvisibleText } from '../../../shared/pluginAgentTools'
import type { DeveloperCallResult } from '../../../shared/marketplaceDeveloper'

const props = defineProps<{ backend: ReturnType<typeof useBackend>; form: OpenMarketplaceForm }>()
const { t } = useI18n()

const MAX_LABEL = 120

const pluginId = ref('')
const inviteesText = ref('')
const agentLines = ref<string[]>([])
const busy = ref(false)
const error = ref('')
const created = ref<Array<{ id: string; label: string; joinToken: string }>>([])

const request = computed(() => props.form.request)
const requesterName = computed(() => {
  const r = props.form.requester
  if (!r) return ''
  if (r.callerKind === 'pane') return r.paneName ? t('plugin-agent.caller.pane', { pane: r.paneName }) : t('plugin-agent.caller.pane-unknown')
  return r.callerKind === 'external' ? t('plugin-agent.caller.external') : t('plugin-agent.caller.host')
})
const reasonText = computed(() => (request.value?.reason ? revealInvisibleText(request.value.reason) : ''))

watch(() => props.form.seq, () => {
  error.value = ''
  created.value = []
  pluginId.value = props.form.prefill.id || request.value?.target.id || ''
  const draft = request.value?.draft?.fields.invitees
  const lines = Array.isArray(draft) ? draft.filter((line): line is string => typeof line === 'string') : []
  agentLines.value = lines
  inviteesText.value = lines.join('\n')
}, { immediate: true })

const labels = computed(() => inviteesText.value.split('\n').map((line) => line.trim()).filter(Boolean))
/** Each line, and whether it is still exactly what the agent wrote. */
const lineRows = computed(() => labels.value.map((label) => ({ label, byAgent: agentLines.value.includes(label) })))
const validId = computed(() => /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(pluginId.value))
const canSend = computed(() =>
  validId.value && labels.value.length >= 1 && labels.value.every((label) => label.length <= MAX_LABEL))

function message(result: DeveloperCallResult): string {
  if (result.ok) return ''
  if (result.code === 'NOT_SIGNED_IN' || result.status === 401) return t('testplace.error.notSignedIn')
  if (result.code === 'QUALIFICATION_REQUIRED' || result.code === 'NAMESPACE_FROZEN') return t('marketplace-developer.error.qualification')
  return t('marketplace-developer.error.registry', { status: result.status, code: result.code ?? '', message: result.message })
}

async function send(): Promise<void> {
  const invite = window.agentTeam?.plugins?.testplaceInvite
  if (!invite || !canSend.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await submitMarketplaceForm(props.backend, request.value, () => invite(pluginId.value, labels.value))
    if (!result.ok) {
      error.value = message(result)
      return
    }
    const invites = (result.body as { invites?: Array<Record<string, unknown>> } | null)?.invites ?? []
    created.value = invites.flatMap((row) =>
      typeof row.join_token === 'string'
        ? [{ id: String(row.id ?? ''), label: typeof row.label === 'string' ? row.label : '', joinToken: row.join_token }]
        : [])
  } catch (err) {
    error.value = ipcErrorMessage(err)
  } finally {
    busy.value = false
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // The code stays on screen to copy by hand.
  }
}

async function discard(): Promise<void> {
  const pending = request.value
  closeMarketplaceForm()
  if (!pending || created.value.length > 0) return
  try {
    await decideFormRequest(props.backend, pending.approval_id, false)
  } catch {
    // Already decided elsewhere or expired: nothing left to reject.
  }
}
</script>

<template>
  <section class="dev-section dev-form tp-invite" role="form" :aria-label="$t('testplace.invite.title')">
    <h2 class="dev-title">{{ $t('testplace.invite.title') }}</h2>
    <div v-if="form.origin !== 'user'" class="dev-callout">
      <template v-if="form.origin === 'agent-open'">{{ $t('marketplace-developer.form.agent-opened', { agent: requesterName }) }}</template>
      <template v-else>
        {{ $t('marketplace-developer.form.agent-filled', { agent: requesterName }) }}
        <div v-if="reasonText" class="dev-reason">{{ $t('plugin-request.reason') }}: {{ reasonText }}</div>
      </template>
    </div>

    <template v-if="created.length === 0">
      <p class="dev-notice">{{ $t('testplace.invite.validity') }}</p>
      <div class="dev-field">
        <label for="tp-invite-id">{{ $t('testplace.invite.plugin') }}</label>
        <input id="tp-invite-id" v-model="pluginId" class="nv-input" type="text" placeholder="namespace.name" />
      </div>
      <div class="dev-field">
        <label for="tp-invite-list">{{ $t('testplace.invite.invitees') }}</label>
        <textarea id="tp-invite-list" v-model="inviteesText" class="nv-input dev-textarea" />
      </div>
      <ul v-if="lineRows.some((row) => row.byAgent)" class="tp-invite-lines">
        <li v-for="row in lineRows" :key="row.label" class="tp-invite-line">
          <span>{{ revealInvisibleText(row.label) }}</span>
          <span v-if="row.byAgent" class="dev-chip dev-chip--agent">{{ $t('marketplace-developer.form.by-agent') }}</span>
        </li>
      </ul>
      <div class="dev-actions">
        <button class="nv-btn nv-btn--primary" :disabled="busy || !canSend" @click="send">{{ $t('testplace.invite.submit') }}</button>
        <button class="nv-btn nv-btn--ghost" :disabled="busy" @click="discard">{{ $t('marketplace-developer.form.cancel') }}</button>
      </div>
    </template>

    <template v-else>
      <p class="dev-notice" role="status">{{ $t('testplace.invite.sent', { count: created.length }) }}</p>
      <table class="dev-table tp-invite-codes">
        <tbody>
          <tr v-for="row in created" :key="row.id || row.joinToken">
            <td>{{ revealInvisibleText(row.label) }}</td>
            <td><code class="tp-invite-code">{{ row.joinToken }}</code></td>
            <td><button class="nv-btn nv-btn--ghost nv-btn--sm" @click="copy(row.joinToken)">{{ $t('testplace.invite.copy') }}</button></td>
          </tr>
        </tbody>
      </table>
      <div class="dev-actions">
        <button class="nv-btn nv-btn--primary" @click="discard">{{ $t('testplace.invite.done') }}</button>
      </div>
    </template>

    <p v-if="error" class="dev-error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.dev-section { display: flex; flex-direction: column; gap: var(--space-2); }
.dev-form { border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: var(--space-4); background: var(--bg-subtle); }
.dev-title { margin: 0; font-size: var(--font-md); color: var(--text-bright); }
.dev-notice { margin: 0; font-size: var(--font-xs); color: var(--text-primary); }
.dev-callout { border-left: 3px solid var(--accent-fg); padding: var(--space-2) var(--space-3); background: var(--accent-subtle); font-size: var(--font-xs); }
.dev-reason { margin-top: var(--space-1, 4px); white-space: pre-wrap; color: var(--text-secondary); }
.dev-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.dev-field { display: flex; flex-direction: column; gap: var(--space-1, 4px); font-size: var(--font-xs); }
.dev-field label { color: var(--text-secondary); }
.dev-textarea { min-height: 88px; resize: vertical; }
.dev-chip { font-size: var(--font-2xs); padding: 0 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-muted); color: var(--text-secondary); }
.dev-chip--agent { border-color: var(--accent-fg); color: var(--accent-fg); }
.dev-error { margin: 0; color: var(--danger-bright); font-size: var(--font-xs); white-space: pre-wrap; }
.dev-table { width: 100%; border-collapse: collapse; font-size: var(--font-xs); }
.dev-table td { text-align: left; padding: var(--space-2); border-bottom: 1px solid var(--border-muted); vertical-align: top; }
.tp-invite-lines { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; font-size: var(--font-xs); }
.tp-invite-line { display: flex; align-items: center; gap: var(--space-2); }
.tp-invite-code { word-break: break-all; }
</style>
