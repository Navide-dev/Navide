<script setup lang="ts">
/**
 * Settings > Navide Marketplace > Developer (plan mcp-navide-0-2-27, W3).
 *
 * The whole manual path, without an agent: sign in, apply to be a developer,
 * publish a version, follow its review, yank it. An agent's
 * marketplace_*_open opens the same forms here, and its marketplace_*_fill
 * opens them with its draft, every agent-written field marked; either way
 * only the user's Submit sends anything (useMarketplaceForms.ts).
 *
 * The Host keeps the Registry tokens and the signing key; this page sees
 * states and Registry answers only.
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotify } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../composables/useBackend'
import {
  closeMarketplaceForm,
  decideFormRequest,
  openMarketplaceForm,
  showMarketplaceForm,
  submitMarketplaceForm,
} from '../composables/useMarketplaceForms'
import { ipcErrorMessage } from '../composables/usePluginInstallFlow'
import { DEVELOPER_APPLICATION_FIELDS, revealInvisibleText } from '../../../shared/pluginAgentTools'
import { diffDisclosure, type DisclosureDiff, type ManifestDisclosure } from '../../../shared/pluginDisclosure'
import type {
  DeveloperApplicationStatus,
  DeveloperCallResult,
  DeveloperPublicState,
  DeveloperVersionRow,
  StagedPackage,
} from '../../../shared/marketplaceDeveloper'
import PluginDisclosureCard from './PluginDisclosureCard.vue'
import PluginDisclosureDiff from './PluginDisclosureDiff.vue'
import TestplaceInviteForm from './TestplaceInviteForm.vue'

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
const { t } = useI18n()
const notify = useNotify()

type FieldName = (typeof DEVELOPER_APPLICATION_FIELDS)[number]
const BOOLEAN_FIELDS: ReadonlySet<FieldName> = new Set(['agreed_terms', 'needs_native_backend'])
const LONG_FIELDS: ReadonlySet<FieldName> = new Set(['description'])
const ORGANIZATION_FIELDS: ReadonlySet<FieldName> = new Set(['organization_name', 'organization_id'])

const api = () => {
  const developer = window.agentTeam?.developer
  if (!developer) throw new Error(t('marketplace-developer.unavailable'))
  return developer
}

const state = ref<DeveloperPublicState | null>(null)
const busy = ref<string | null>(null)
const error = ref('')
const application = ref<{ status: DeveloperApplicationStatus; reason: string | null; fields: Record<string, unknown> } | null>(null)
const versions = ref<DeveloperVersionRow[]>([])

const form = computed(() => openMarketplaceForm.value)
const request = computed(() => form.value?.request ?? null)
const requesterName = computed(() => {
  const r = form.value?.requester
  if (!r) return ''
  if (r.callerKind === 'pane') return r.paneName ? t('plugin-agent.caller.pane', { pane: r.paneName }) : t('plugin-agent.caller.pane-unknown')
  return r.callerKind === 'external' ? t('plugin-agent.caller.external') : t('plugin-agent.caller.host')
})
const reasonText = computed(() => (request.value?.reason ? revealInvisibleText(request.value.reason) : ''))

function message(result: DeveloperCallResult): string {
  if (result.ok) return ''
  if (result.code === 'NOT_SIGNED_IN' || result.status === 401) return t('marketplace-developer.error.not-signed-in')
  if (result.code === 'QUALIFICATION_REQUIRED') return t('marketplace-developer.error.qualification')
  return t('marketplace-developer.error.registry', { status: result.status, code: result.code ?? '', message: result.message })
}

async function run<T>(key: string, task: () => Promise<T>): Promise<T | null> {
  busy.value = key
  error.value = ''
  try {
    return await task()
  } catch (err) {
    error.value = ipcErrorMessage(err)
    return null
  } finally {
    busy.value = null
  }
}

async function refresh(): Promise<void> {
  const next = await run('refresh', () => api().state())
  if (!next) return
  state.value = next
  if (next.signedIn.account || next.signedIn.publisher) {
    const [app, list] = await Promise.all([api().application(), api().versions()])
    application.value = app.ok ? (app.body as typeof application.value) : null
    const body = list.ok ? (list.body as { items?: DeveloperVersionRow[] }) : null
    versions.value = body?.items ?? []
  } else {
    application.value = null
    versions.value = []
  }
}

async function signIn(scope: 'account' | 'publish'): Promise<void> {
  const next = await run(`sign-in-${scope}`, () => api().signIn(scope))
  if (next) await refresh()
}

async function signOut(): Promise<void> {
  const next = await run('sign-out', () => api().signOut())
  if (next) await refresh()
}

// ── the open form ─────────────────────────────────────────────────────────

const appFields = reactive<Record<string, string | boolean>>({})
/** Field -> the value the agent wrote; a field still equal to it is marked as the agent's. */
const agentValues = ref<Record<string, string | boolean>>({})
const staged = ref<StagedPackage | null>(null)
const publishTarget = ref('')
const previousDisclosure = ref<ManifestDisclosure | null>(null)
const yankId = ref('')
const yankVersion = ref('')

function writtenByAgent(field: string): boolean {
  return field in agentValues.value && agentValues.value[field] === appFields[field]
}

function resetApplicationFields(): void {
  for (const field of DEVELOPER_APPLICATION_FIELDS) appFields[field] = BOOLEAN_FIELDS.has(field) ? false : ''
}

async function loadStaged(path?: string): Promise<void> {
  const next = await run('stage', () => api().stagePackage(path))
  if (!next) return
  staged.value = next
  publishTarget.value = form.value?.prefill.target || (request.value?.draft?.fields.target as string | undefined) || next.defaultTarget
  previousDisclosure.value = null
  try {
    const [namespace, ...rest] = next.id.split('.')
    const detail = await window.agentTeam?.plugins?.marketplaceDetail?.({ namespace, name: rest.join('.') })
    const previous = detail?.versions.find((v) => v.version !== next.version && !v.yanked && v.disclosure)
    previousDisclosure.value = previous?.disclosure ?? null
  } catch {
    previousDisclosure.value = null  // a first version, or the Navide Marketplace is unreachable
  }
}

watch(() => form.value?.seq, () => {
  const current = form.value
  error.value = ''
  agentValues.value = {}
  staged.value = null
  if (!current) return
  if (current.form === 'developer-application') {
    resetApplicationFields()
    // What the user already sent (e.g. after a rejection) comes in as theirs.
    for (const [key, value] of Object.entries(application.value?.fields ?? {})) {
      if (key in appFields && (typeof value === 'string' || typeof value === 'boolean')) appFields[key] = value
    }
    const draft: Record<string, string | boolean> = {}
    for (const [key, value] of Object.entries(current.request?.draft?.fields ?? {})) {
      if (key in appFields && (typeof value === 'string' || typeof value === 'boolean')) draft[key] = value
    }
    Object.assign(appFields, draft)
    agentValues.value = draft
  } else if (current.form === 'publish') {
    const path = current.prefill.path || (current.request?.draft?.fields.path as string | undefined)
    if (path) void loadStaged(path)
  } else if (current.form === 'publish-yank') {
    yankId.value = current.prefill.id ?? ''
    yankVersion.value = current.prefill.version ?? ''
  }
}, { immediate: true })

const isOrganization = computed(() => appFields.applicant_type === 'organization')
const shownApplicationFields = computed(() =>
  DEVELOPER_APPLICATION_FIELDS.filter((field) => !ORGANIZATION_FIELDS.has(field) || isOrganization.value))
const publishDiff = computed<DisclosureDiff | null>(() => {
  if (!previousDisclosure.value || !staged.value?.disclosure) return null
  try {
    return diffDisclosure(previousDisclosure.value, staged.value.disclosure)
  } catch {
    return null
  }
})

async function discardForm(): Promise<void> {
  const pending = request.value
  closeMarketplaceForm()
  if (!pending) return
  try {
    await decideFormRequest(props.backend, pending.approval_id, false)
  } catch {
    // Already decided elsewhere or expired: nothing left to reject.
  }
}

async function submitApplication(): Promise<void> {
  const fields: Record<string, string | boolean> = {}
  const fieldSources: Record<string, 'user' | 'agent-draft'> = {}
  for (const field of shownApplicationFields.value) {
    const value = appFields[field]
    if (value === '') continue
    fields[field] = value
    fieldSources[field] = writtenByAgent(field) ? 'agent-draft' : 'user'
  }
  const result = await run('submit', () =>
    submitMarketplaceForm(props.backend, request.value, () => api().submitApplication({ fields, fieldSources })))
  if (!result) return
  if (!result.ok) {
    error.value = message(result)
    return
  }
  closeMarketplaceForm()
  notify.toast(t('marketplace-developer.application.sent'), { type: 'success' })
  await refresh()
}

async function submitPublish(): Promise<void> {
  const pkg = staged.value
  if (!pkg) return
  const result = await run('submit', () =>
    submitMarketplaceForm(props.backend, request.value, () => api().publish({ stageId: pkg.stageId, target: publishTarget.value })))
  if (!result) return
  if (!result.ok) {
    error.value = message(result)
    return
  }
  closeMarketplaceForm()
  notify.toast(t('marketplace-developer.publish.sent', { plugin: pkg.id, version: pkg.version }), { type: 'success' })
  await refresh()
}

async function submitYank(): Promise<void> {
  const [namespace, ...rest] = yankId.value.split('.')
  const confirmed = await notify.confirm(
    t('marketplace-developer.yank.confirm', { plugin: yankId.value, version: yankVersion.value }),
    { title: t('marketplace-developer.yank.title'), confirmText: t('marketplace-developer.yank.submit'), danger: true },
  )
  if (!confirmed) return
  const result = await run('submit', () =>
    submitMarketplaceForm(props.backend, request.value, () =>
      api().yank({ namespace, name: rest.join('.'), version: yankVersion.value })))
  if (!result) return
  if (!result.ok) {
    error.value = message(result)
    return
  }
  closeMarketplaceForm()
  notify.toast(t('marketplace-developer.yank.done', { plugin: yankId.value, version: yankVersion.value }), { type: 'success' })
  await refresh()
}

function openForm(name: 'developer-application' | 'publish' | 'publish-yank' | 'testplace-invite', prefill: Record<string, string> = {}): void {
  showMarketplaceForm({ form: name, origin: 'user', prefill, requester: null, request: null })
}

function versionStatus(row: DeveloperVersionRow): string {
  if (row.yanked) return t('marketplace-developer.versions.status.yanked')
  return t(`marketplace-developer.versions.status.${row.status ?? 'pending'}`)
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="dev-panel">
    <section class="dev-section" :aria-label="$t('marketplace-developer.account.title')">
      <h2 class="dev-title">{{ $t('marketplace-developer.account.title') }}</h2>
      <p class="dev-muted">{{ $t('marketplace-developer.account.desc') }}</p>
      <template v-if="state && (state.signedIn.account || state.signedIn.publisher)">
        <dl class="dev-facts">
          <dt>{{ $t('marketplace-developer.account.namespace') }}</dt>
          <dd>{{ state.namespace ?? $t('marketplace-developer.account.no-namespace') }}</dd>
          <dt>{{ $t('marketplace-developer.account.key') }}</dt>
          <dd>
            <code v-if="state.keyFingerprint">{{ state.keyFingerprint }}</code>
            <span v-else>{{ $t('marketplace-developer.account.no-key') }}</span>
            <span v-if="state.keyFingerprint" class="dev-chip">{{ state.keyRegistered ? $t('marketplace-developer.account.key-registered') : $t('marketplace-developer.account.key-unregistered') }}</span>
          </dd>
          <dt>{{ $t('marketplace-developer.account.expires') }}</dt>
          <dd>{{ state.tokenExpiresAt.publisher ?? state.tokenExpiresAt.account ?? '—' }}</dd>
        </dl>
        <div class="dev-actions">
          <button v-if="!state.signedIn.publisher" class="nv-btn nv-btn--primary nv-btn--sm" :disabled="busy !== null" @click="signIn('publish')">
            {{ $t('marketplace-developer.account.sign-in-publish') }}
          </button>
          <button class="nv-btn nv-btn--ghost nv-btn--sm" :disabled="busy !== null" @click="signOut">{{ $t('marketplace-developer.account.sign-out') }}</button>
        </div>
      </template>
      <div v-else class="dev-actions">
        <button class="nv-btn nv-btn--primary nv-btn--sm" :disabled="busy !== null" @click="signIn('account')">
          {{ busy === 'sign-in-account' ? $t('marketplace-developer.account.waiting') : $t('marketplace-developer.account.sign-in') }}
        </button>
        <button class="nv-btn nv-btn--sm" :disabled="busy !== null" @click="signIn('publish')">
          {{ $t('marketplace-developer.account.sign-in-publish') }}
        </button>
      </div>
    </section>

    <section class="dev-section">
      <h2 class="dev-title">{{ $t('marketplace-developer.application.title') }}</h2>
      <p class="dev-muted">
        {{ $t(`marketplace-developer.application.status.${application?.status ?? 'none'}`) }}
        <template v-if="application?.reason"> — {{ application.reason }}</template>
      </p>
      <div class="dev-actions">
        <button class="nv-btn nv-btn--sm" @click="openForm('developer-application')">{{ $t('marketplace-developer.application.open') }}</button>
        <button class="nv-btn nv-btn--sm" @click="openForm('publish')">{{ $t('marketplace-developer.publish.open') }}</button>
        <button class="nv-btn nv-btn--sm" @click="openForm('testplace-invite')">{{ $t('testplace.invite.open') }}</button>
      </div>
    </section>

    <section v-if="form && form.form !== 'testplace-invite'" class="dev-section dev-form" role="form" :aria-label="$t(`marketplace-developer.form.${form.form}`)">
      <h2 class="dev-title">{{ $t(`marketplace-developer.form.${form.form}`) }}</h2>
      <div v-if="form.origin !== 'user'" class="dev-callout">
        <template v-if="form.origin === 'link'">{{ $t('marketplace-developer.form.from-link') }}</template>
        <template v-else-if="form.origin === 'agent-open'">{{ $t('marketplace-developer.form.agent-opened', { agent: requesterName }) }}</template>
        <template v-else>
          {{ $t('marketplace-developer.form.agent-filled', { agent: requesterName }) }}
          <div v-if="reasonText" class="dev-reason">{{ $t('plugin-request.reason') }}: {{ reasonText }}</div>
        </template>
      </div>

      <template v-if="form.form === 'developer-application'">
        <p class="dev-notice">{{ $t('marketplace-developer.application.notice') }}</p>
        <div v-for="field in shownApplicationFields" :key="field" class="dev-field">
          <label :for="`dev-app-${field}`">
            {{ $t(`marketplace-developer.application.field.${field}`) }}
            <span v-if="writtenByAgent(field)" class="dev-chip dev-chip--agent">{{ $t('marketplace-developer.form.by-agent') }}</span>
          </label>
          <select v-if="field === 'applicant_type'" :id="`dev-app-${field}`" v-model="appFields[field]" class="nv-select">
            <option value="">—</option>
            <option value="individual">{{ $t('marketplace-developer.application.individual') }}</option>
            <option value="organization">{{ $t('marketplace-developer.application.organization') }}</option>
          </select>
          <input v-else-if="BOOLEAN_FIELDS.has(field)" :id="`dev-app-${field}`" v-model="appFields[field]" type="checkbox" />
          <textarea v-else-if="LONG_FIELDS.has(field)" :id="`dev-app-${field}`" v-model="appFields[field] as string" class="nv-input dev-textarea" maxlength="1000" />
          <input v-else :id="`dev-app-${field}`" v-model="appFields[field] as string" class="nv-input" type="text" />
        </div>
        <div class="dev-actions">
          <button class="nv-btn nv-btn--primary" :disabled="busy !== null" @click="submitApplication">{{ $t('marketplace-developer.form.submit') }}</button>
          <button class="nv-btn nv-btn--ghost" :disabled="busy !== null" @click="discardForm">{{ $t('marketplace-developer.form.cancel') }}</button>
        </div>
      </template>

      <template v-else-if="form.form === 'publish'">
        <p v-if="state && !state.signedIn.publisher" class="dev-notice">{{ $t('marketplace-developer.publish.sign-in-first') }}</p>
        <div class="dev-actions">
          <button class="nv-btn nv-btn--sm" :disabled="busy !== null" @click="loadStaged()">{{ $t('marketplace-developer.publish.choose') }}</button>
        </div>
        <template v-if="staged">
          <dl class="dev-facts">
            <dt>{{ $t('marketplace-developer.publish.package') }}</dt>
            <dd>{{ staged.id }} {{ staged.version }}</dd>
            <dt>{{ $t('marketplace-developer.publish.file') }}</dt>
            <dd><code>{{ staged.path }}</code></dd>
            <dt>{{ $t('marketplace-developer.publish.digest') }}</dt>
            <dd><code>{{ staged.digest }}</code></dd>
          </dl>
          <div class="dev-field">
            <label for="dev-publish-target">
              {{ $t('marketplace-developer.publish.target') }}
              <span v-if="request && publishTarget === request.draft?.fields.target" class="dev-chip dev-chip--agent">{{ $t('marketplace-developer.form.by-agent') }}</span>
            </label>
            <input id="dev-publish-target" v-model="publishTarget" class="nv-input" type="text" />
          </div>
          <p class="dev-muted">{{ $t('marketplace-developer.publish.changelog-hint') }}</p>
          <PluginDisclosureDiff v-if="publishDiff" :diff="publishDiff" />
          <PluginDisclosureCard :disclosure="staged.disclosure" :local-source="true" />
        </template>
        <div class="dev-actions">
          <button class="nv-btn nv-btn--primary" :disabled="busy !== null || !staged" @click="submitPublish">{{ $t('marketplace-developer.publish.submit') }}</button>
          <button class="nv-btn nv-btn--ghost" :disabled="busy !== null" @click="discardForm">{{ $t('marketplace-developer.form.cancel') }}</button>
        </div>
      </template>

      <template v-else-if="form.form === 'publish-yank'">
        <p class="dev-notice">{{ $t('marketplace-developer.yank.notice') }}</p>
        <div class="dev-field">
          <label for="dev-yank-id">{{ $t('marketplace-developer.publish.package') }}</label>
          <input id="dev-yank-id" v-model="yankId" class="nv-input" type="text" placeholder="namespace.name" />
        </div>
        <div class="dev-field">
          <label for="dev-yank-version">{{ $t('marketplace-developer.yank.version') }}</label>
          <input id="dev-yank-version" v-model="yankVersion" class="nv-input" type="text" placeholder="1.0.0" />
        </div>
        <div class="dev-actions">
          <button class="nv-btn nv-btn--danger" :disabled="busy !== null || !yankId || !yankVersion" @click="submitYank">{{ $t('marketplace-developer.yank.submit') }}</button>
          <button class="nv-btn nv-btn--ghost" :disabled="busy !== null" @click="discardForm">{{ $t('marketplace-developer.form.cancel') }}</button>
        </div>
      </template>
    </section>

    <TestplaceInviteForm v-if="form?.form === 'testplace-invite'" :backend="backend" :form="form" />

    <p v-if="error" class="dev-error" role="alert">{{ error }}</p>

    <section class="dev-section">
      <div class="dev-row">
        <h2 class="dev-title">{{ $t('marketplace-developer.versions.title') }}</h2>
        <button class="nv-btn nv-btn--ghost nv-btn--sm" :disabled="busy !== null" @click="refresh">{{ $t('marketplace-developer.versions.refresh') }}</button>
      </div>
      <p v-if="versions.length === 0" class="dev-muted">{{ $t('marketplace-developer.versions.empty') }}</p>
      <table v-else class="dev-table">
        <thead>
          <tr>
            <th>{{ $t('marketplace-developer.publish.package') }}</th>
            <th>{{ $t('marketplace-developer.yank.version') }}</th>
            <th>{{ $t('marketplace-developer.versions.state') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in versions" :key="`${row.namespace}.${row.name}@${row.version}`">
            <td>{{ row.namespace }}.{{ row.name }}</td>
            <td>{{ row.version }}</td>
            <td>
              {{ versionStatus(row) }}
              <div v-if="row.reason" class="dev-muted">{{ row.reason }}</div>
            </td>
            <td>
              <button
                v-if="!row.yanked"
                class="nv-btn nv-btn--ghost nv-btn--sm"
                @click="openForm('publish-yank', { id: `${row.namespace}.${row.name}`, version: row.version ?? '' })"
              >{{ $t('marketplace-developer.yank.submit') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.dev-panel { display: flex; flex-direction: column; gap: var(--space-5); padding: var(--space-4) var(--space-5); }
.dev-section { display: flex; flex-direction: column; gap: var(--space-2); }
.dev-form { border: 1px solid var(--border-default); border-radius: var(--radius-md); padding: var(--space-4); background: var(--bg-subtle); }
.dev-title { margin: 0; font-size: var(--font-md); color: var(--text-bright); }
.dev-muted { margin: 0; color: var(--text-secondary); font-size: var(--font-xs); }
.dev-notice { margin: 0; font-size: var(--font-xs); color: var(--text-primary); }
.dev-callout { border-left: 3px solid var(--accent-fg); padding: var(--space-2) var(--space-3); background: var(--accent-subtle); font-size: var(--font-xs); }
.dev-reason { margin-top: var(--space-1, 4px); white-space: pre-wrap; color: var(--text-secondary); }
.dev-facts { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1, 4px) var(--space-3); margin: 0; font-size: var(--font-xs); }
.dev-facts dt { color: var(--text-secondary); }
.dev-facts dd { margin: 0; word-break: break-all; }
.dev-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.dev-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.dev-field { display: flex; flex-direction: column; gap: var(--space-1, 4px); font-size: var(--font-xs); }
.dev-field label { display: flex; align-items: center; gap: var(--space-2); color: var(--text-secondary); }
.dev-textarea { min-height: 88px; resize: vertical; }
.dev-chip { font-size: var(--font-2xs); padding: 0 6px; border-radius: var(--radius-sm); border: 1px solid var(--border-muted); color: var(--text-secondary); }
.dev-chip--agent { border-color: var(--accent-fg); color: var(--accent-fg); }
.dev-error { margin: 0; color: var(--danger-bright); font-size: var(--font-xs); white-space: pre-wrap; }
.dev-table { width: 100%; border-collapse: collapse; font-size: var(--font-xs); }
.dev-table th, .dev-table td { text-align: left; padding: var(--space-2); border-bottom: 1px solid var(--border-muted); vertical-align: top; }
</style>
