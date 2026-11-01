<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'
import {
  FORM_FIELD_TYPES,
  GITHUB_EVENTS,
  curlExample,
  formUrl,
  minutesLeft,
  outcomeKey,
  refusalKey,
  triggerState,
  triggerUrl,
  type FormField,
  type TriggerKind,
  type WebhookEvent,
  type WebhookStatus,
  type WebhookTrigger,
} from '../../lib/webhookTriggers'
import SettingsCard from './SettingsCard.vue'
import SettingsEmptyState from './SettingsEmptyState.vue'
import SettingsNotice from './SettingsNotice.vue'
import SettingRow from './SettingRow.vue'
import SettingsSection from './SettingsSection.vue'
import ToggleSwitch from './ToggleSwitch.vue'

/**
 * Settings → Webhooks: the one place triggers are made, switched and read
 * back. Only this window reaches these messages: no MCP tool, ui.* action or
 * plugin capability does, so an agent cannot open a door for itself. Everything
 * that would make a run less safe than the default is said here, at the moment
 * it is turned on, and has to be ticked.
 */
const props = defineProps<{
  backend: Pick<ReturnType<typeof useBackend>, 'send' | 'on' | 'status'>
  workspacePath?: string
}>()

const { t, te } = useI18n()

const POLL_MS = 5000

const status = ref<WebhookStatus | null>(null)
const pipelines = ref<Array<{ id: string; name: string }>>([])
const actionError = ref('')
const busy = ref(false)
const now = ref(Date.now())
/** A key or secret, on screen until dismissed and never fetched again. */
const revealed = ref<{ name: string; kind: TriggerKind; id: string; value: string; formPublic?: boolean } | null>(null)
const copied = ref('')
const creating = ref(false)
const hostDraft = ref('')
const hostDirty = ref(false)
const form = reactive({
  name: '', kind: 'webhook' as TriggerKind, pipelineId: '', perMinute: 6, perDay: 20, timeoutMin: 30,
  noGateAck: false, events: [] as string[], formPublic: false,
  fields: [{ label: '', type: 'text', required: false, options: '' }] as Array<{ label: string; type: FormField['type']; required: boolean; options: string }>,
})
/** The trigger whose disclosure is open, one at a time. */
const confirming = ref<{ id: string; what: 'unattended' | 'weak-key'; ticked: boolean } | null>(null)
const openLog = ref('')
const deleting = ref('')
const events = ref<WebhookEvent[]>([])

interface Answer { ok: boolean; payload?: Record<string, unknown>; code?: string; message?: string; details?: Record<string, unknown> }

async function call(type: string, payload: Record<string, unknown> = {}): Promise<Answer> {
  try {
    const resp = await props.backend.send<Record<string, unknown>>(type, payload)
    if (resp.ok && resp.payload) return { ok: true, payload: resp.payload }
    const error = resp.error as { code?: string; message?: string; details?: Record<string, unknown> } | undefined
    return { ok: false, code: error?.code, message: error?.message, details: error?.details }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

function adopt(answer: Answer): void {
  if (answer.ok && answer.payload && 'triggers' in answer.payload) {
    status.value = answer.payload as unknown as WebhookStatus
    if (!hostDirty.value) hostDraft.value = status.value.settings.public_host
  }
}

function explain(answer: Answer): string {
  const reason = String(answer.details?.reason ?? '')
  const key = refusalKey(reason) || (answer.code ? `webhooks.error.${answer.code}` : '')
  return key && te(key) ? t(key) : (answer.message ?? t('webhooks.error.generic'))
}

async function act(type: string, payload: Record<string, unknown>): Promise<Answer> {
  busy.value = true
  try {
    const answer = await call(type, payload)
    actionError.value = answer.ok ? '' : explain(answer)
    adopt(answer)
    return answer
  } finally {
    busy.value = false
  }
}

async function refresh(): Promise<void> {
  adopt(await call('webhook.status'))
  now.value = Date.now()
}

let poll: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  await refresh()
  const answer = await call('pipelines.list')
  pipelines.value = (answer.payload?.pipelines as Array<{ id: string; name: string }> | undefined) ?? []
  form.pipelineId = pipelines.value[0]?.id ?? ''
  poll = setInterval(() => { void refresh() }, POLL_MS)
})
onBeforeUnmount(() => clearInterval(poll))

const guardOff = computed(() => status.value?.guard_enabled === false)
const triggers = computed(() => status.value?.triggers ?? [])
const needsWorkspace = computed(() => !props.workspacePath)
const hasPublicHost = computed(() => !!status.value?.settings.public_host)

function pipelineName(id: string): string {
  return pipelines.value.find((p) => p.id === id)?.name ?? id
}

function stateLabel(trigger: WebhookTrigger): string {
  if (!status.value) return ''
  const state = triggerState(trigger, status.value)
  if (state === 'waiting') {
    const run = status.value.runs.find((r) => r.trigger_id === trigger.id)
    return t('webhooks.state.waiting', { minutes: minutesLeft(run?.stops_at ?? 0, now.value) })
  }
  return t(`webhooks.state.${state}`)
}

function stateTone(trigger: WebhookTrigger): string {
  if (!status.value) return 'muted'
  return { waiting: 'warn', running: 'ok', ready: 'ok', off: 'muted', 'listener-off': 'muted' }[triggerState(trigger, status.value)]
}

function url(trigger: WebhookTrigger): string {
  return status.value ? triggerUrl(status.value, trigger.id) : ''
}

async function setListener(enabled: boolean): Promise<void> {
  await act('webhook.settings.set', { enabled })
}

async function saveHost(): Promise<void> {
  const answer = await act('webhook.settings.set', {
    enabled: status.value?.settings.enabled === true, public_host: hostDraft.value.trim(),
  })
  if (answer.ok) hostDirty.value = false
}

function toggleEvent(name: string): void {
  form.events = form.events.includes(name) ? form.events.filter((e) => e !== name) : [...form.events, name]
}

const canCreate = computed(() => !!form.name.trim() && !!form.pipelineId
  && (form.kind !== 'form' || form.fields.every((f) => f.label.trim())))

async function create(): Promise<void> {
  const answer = await act('webhook.trigger.create', {
    name: form.name, workspace_path: props.workspacePath ?? '', pipeline_id: form.pipelineId, kind: form.kind,
    per_minute: form.perMinute, per_day: form.perDay, approval_timeout_min: form.timeoutMin,
    no_gate_ack: form.noGateAck, events: form.events, form_public: form.formPublic,
    fields: form.fields.map((f) => ({ ...f, options: f.options.split(',') })),
  })
  if (!answer.ok) return
  const created = answer.payload as { trigger: WebhookTrigger; token: string; problem: string }
  revealed.value = {
    name: created.trigger.name, kind: created.trigger.kind, id: created.trigger.id, value: created.token,
    formPublic: created.trigger.form_public,
  }
  const key = refusalKey(created.problem)
  actionError.value = key ? t(key) : ''
  creating.value = false
  Object.assign(form, { name: '', noGateAck: false, events: [], formPublic: false, fields: [{ label: '', type: 'text', required: false, options: '' }] })
  await refresh()
}

async function setEnabled(trigger: WebhookTrigger, enabled: boolean, acknowledged = false): Promise<void> {
  const answer = await act('webhook.trigger.enable', {
    id: trigger.id, enabled, ...(acknowledged ? { weak_key_acknowledged: true } : {}),
  })
  if (answer.code === 'WEAK_KEY_ACK_REQUIRED') {
    actionError.value = ''
    confirming.value = { id: trigger.id, what: 'weak-key', ticked: false }
  } else if (answer.ok) {
    confirming.value = null
  }
}

async function setUnattended(trigger: WebhookTrigger, unattended: boolean): Promise<void> {
  if (unattended) {
    confirming.value = { id: trigger.id, what: 'unattended', ticked: false }
    return
  }
  await act('webhook.trigger.set_unattended', { id: trigger.id, unattended: false })
}

async function confirmDisclosure(trigger: WebhookTrigger): Promise<void> {
  if (!confirming.value?.ticked) return
  if (confirming.value.what === 'weak-key') {
    await setEnabled(trigger, true, true)
    return
  }
  const answer = await act('webhook.trigger.set_unattended', { id: trigger.id, unattended: true })
  if (answer.ok) confirming.value = null
}

async function saveLimits(trigger: WebhookTrigger): Promise<void> {
  await act('webhook.trigger.update', {
    id: trigger.id, per_minute: trigger.per_minute, per_day: trigger.per_day,
    approval_timeout_min: trigger.approval_timeout_min,
  })
}

async function rotate(trigger: WebhookTrigger): Promise<void> {
  const answer = await act('webhook.trigger.rotate', { id: trigger.id })
  if (answer.ok) {
    revealed.value = {
      name: trigger.name, kind: trigger.kind, id: trigger.id, value: String(answer.payload?.token),
      formPublic: trigger.form_public,
    }
  }
}

/** Deleting ends the key and the secret for good, so it takes a second click. */
async function remove(trigger: WebhookTrigger): Promise<void> {
  if (deleting.value !== trigger.id) {
    deleting.value = trigger.id
    return
  }
  deleting.value = ''
  await act('webhook.trigger.delete', { id: trigger.id })
}

async function toggleLog(trigger: WebhookTrigger): Promise<void> {
  if (openLog.value === trigger.id) {
    openLog.value = ''
    return
  }
  const answer = await call('webhook.events', { id: trigger.id })
  events.value = (answer.payload?.events as WebhookEvent[] | undefined) ?? []
  openLog.value = trigger.id
}

function outcomeLabel(outcome: string): string {
  const key = outcomeKey(outcome)
  return key && te(key) ? t(key) : outcome
}

function time(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

async function copy(text: string, tag: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  copied.value = tag
  setTimeout(() => { if (copied.value === tag) copied.value = '' }, 1500)
}

const revealedUrl = computed(() => {
  if (!status.value || !revealed.value) return ''
  return revealed.value.kind === 'form'
    ? formUrl(status.value, revealed.value.value, revealed.value.formPublic === true)
    : triggerUrl(status.value, revealed.value.id)
})

const REVEAL_TITLE: Record<TriggerKind, string> = {
  webhook: 'webhooks.reveal.titleKey', github: 'webhooks.reveal.titleSecret', form: 'webhooks.reveal.titleForm',
}
const ROTATE: Record<TriggerKind, string> = {
  webhook: 'webhooks.rotateKey', github: 'webhooks.rotateSecret', form: 'webhooks.rotateForm',
}
/** No port until the first trigger is on, and an address without one is useless. */
const hasAddress = computed(() => !!status.value && (hasPublicHost.value || !!(status.value.port || status.value.settings.port)))
</script>

<template>
  <div class="webhooks" data-testid="webhooks-pane">
    <SettingsNotice v-if="guardOff" tone="danger" :message="t('webhooks.guardOff')" />
    <SettingsNotice v-if="status?.error" tone="danger" :message="t('webhooks.portTaken', { error: status.error })" />
    <SettingsNotice v-if="actionError" tone="danger" :message="actionError" />

    <SettingsCard>
      <SettingRow :title="t('webhooks.enabled.title')" :description="t('webhooks.enabled.desc')" fold-description>
        <template #control>
          <ToggleSwitch
            :model-value="status?.settings.enabled === true"
            :disabled="busy || guardOff"
            :aria-label="t('webhooks.enabled.title')"
            @update:model-value="setListener"
          />
        </template>
      </SettingRow>
      <SettingRow :title="t('webhooks.host.title')" :description="t('webhooks.host.desc')" fold-description>
        <template #control>
          <div class="wh-host">
            <input
              v-model="hostDraft"
              class="wh-input"
              :placeholder="t('webhooks.host.placeholder')"
              :aria-label="t('webhooks.host.title')"
              spellcheck="false"
              @input="hostDirty = true"
              @keydown.enter="saveHost"
            />
            <button type="button" class="wh-btn" :disabled="busy || !hostDirty" @click="saveHost">{{ t('webhooks.save') }}</button>
          </div>
        </template>
      </SettingRow>
    </SettingsCard>
    <SettingsNotice v-if="hasPublicHost" tone="warning" :message="t('webhooks.host.warning')" class="wh-gap" />

    <SettingsCard v-if="revealed" class="wh-reveal" data-testid="webhooks-reveal">
      <div class="wh-reveal-head">
        <strong>{{ t(REVEAL_TITLE[revealed.kind], { name: revealed.name }) }}</strong>
        <span>{{ t('webhooks.reveal.once') }}</span>
      </div>
      <div v-if="hasAddress" class="wh-field">
        <span class="wh-field-label">{{ t('webhooks.reveal.url') }}</span>
        <code v-truncate class="wh-code">{{ revealedUrl }}</code>
        <button type="button" class="wh-btn" @click="copy(revealedUrl, 'url')">{{ copied === 'url' ? t('webhooks.copied') : t('webhooks.copy') }}</button>
      </div>
      <div v-if="revealed.kind !== 'form'" class="wh-field">
        <span class="wh-field-label">{{ t(revealed.kind === 'github' ? 'webhooks.reveal.secret' : 'webhooks.reveal.key') }}</span>
        <code v-truncate class="wh-code">{{ revealed.value }}</code>
        <button type="button" class="wh-btn" @click="copy(revealed.value, 'key')">{{ copied === 'key' ? t('webhooks.copied') : t('webhooks.copy') }}</button>
      </div>
      <div v-if="!hasAddress" class="wh-hint">{{ t('webhooks.reveal.noAddress') }}</div>
      <div v-if="revealed.kind === 'github'" class="wh-hint">{{ t('webhooks.reveal.githubHint') }}</div>
      <div v-if="revealed.kind === 'form'" class="wh-hint">{{ t('webhooks.reveal.formHint') }}</div>
      <div class="wh-actions">
        <button
          v-if="revealed.kind === 'webhook' && hasAddress"
          type="button"
          class="wh-btn"
          @click="copy(curlExample(revealedUrl, revealed.value), 'curl')"
        >{{ copied === 'curl' ? t('webhooks.copied') : t('webhooks.reveal.copyCurl') }}</button>
        <button type="button" class="wh-btn primary" data-testid="webhooks-reveal-done" @click="revealed = null">{{ t('webhooks.reveal.done') }}</button>
      </div>
    </SettingsCard>

    <SettingsSection :label="t('webhooks.triggers')">
      <div class="wh-section-actions">
        <button
          type="button"
          class="wh-btn"
          data-testid="webhooks-new"
          :disabled="needsWorkspace || creating"
          :title="needsWorkspace ? t('webhooks.needsWorkspace') : undefined"
          @click="creating = true"
        >{{ t('webhooks.new') }}</button>
      </div>

      <SettingsCard v-if="creating" class="wh-form" data-testid="webhooks-form">
        <label class="wh-form-row">
          <span>{{ t('webhooks.form.name') }}</span>
          <input v-model="form.name" class="wh-input" data-testid="webhooks-form-name" />
        </label>
        <label class="wh-form-row">
          <span>{{ t('webhooks.form.source') }}</span>
          <select v-model="form.kind" class="wh-input" data-testid="webhooks-form-kind">
            <option value="webhook">{{ t('webhooks.kind.webhook') }}</option>
            <option value="github">{{ t('webhooks.kind.github') }}</option>
            <option value="form">{{ t('webhooks.kind.form') }}</option>
          </select>
        </label>
        <label class="wh-form-row">
          <span>{{ t('webhooks.form.pipeline') }}</span>
          <select v-model="form.pipelineId" class="wh-input" data-testid="webhooks-form-pipeline">
            <option v-for="p in pipelines" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </label>
        <div class="wh-form-row">
          <span>{{ t('webhooks.form.workspace') }}</span>
          <code v-truncate class="wh-code">{{ workspacePath }}</code>
        </div>
        <div v-if="form.kind === 'github'" class="wh-form-row wh-form-top">
          <span>{{ t('webhooks.form.events') }}</span>
          <div class="wh-events">
            <label v-for="name in GITHUB_EVENTS" :key="name" class="wh-check">
              <input type="checkbox" :checked="form.events.includes(name)" @change="toggleEvent(name)" />
              <code>{{ name }}</code>
            </label>
            <span class="wh-hint">{{ t('webhooks.form.eventsHint') }}</span>
          </div>
        </div>
        <div v-if="form.kind === 'form'" class="wh-form-row wh-form-top">
          <span>{{ t('webhooks.form.fields') }}</span>
          <div class="wh-fields">
            <div v-for="(field, index) in form.fields" :key="index" class="wh-field-row" data-testid="webhooks-form-field">
              <input v-model="field.label" class="wh-input" :placeholder="t('webhooks.form.fieldLabel')" :aria-label="t('webhooks.form.fieldLabel')" />
              <select v-model="field.type" class="wh-input" :aria-label="t('webhooks.form.fieldType')">
                <option v-for="type in FORM_FIELD_TYPES" :key="type" :value="type">{{ t(`webhooks.fieldType.${type}`) }}</option>
              </select>
              <label class="wh-check"><input v-model="field.required" type="checkbox" /><span>{{ t('webhooks.form.required') }}</span></label>
              <button type="button" class="wh-btn ghost" :disabled="form.fields.length === 1" @click="form.fields.splice(index, 1)">{{ t('webhooks.form.removeField') }}</button>
              <input v-if="field.type === 'select'" v-model="field.options" class="wh-input wh-field-options" :placeholder="t('webhooks.form.options')" :aria-label="t('webhooks.form.options')" />
            </div>
            <button type="button" class="wh-btn wh-add-field" data-testid="webhooks-form-add" @click="form.fields.push({ label: '', type: 'text', required: false, options: '' })">{{ t('webhooks.form.addField') }}</button>
            <span class="wh-hint">{{ t('webhooks.form.fieldsHint') }}</span>
          </div>
        </div>
        <label v-if="form.kind === 'form'" class="wh-check wh-ack">
          <input v-model="form.formPublic" type="checkbox" data-testid="webhooks-form-public" />
          <span>{{ t('webhooks.form.public') }}</span>
        </label>
        <div class="wh-form-row">
          <span>{{ t('webhooks.form.limits') }}</span>
          <div class="wh-limits">
            <label><input v-model.number="form.perMinute" class="wh-input wh-num" type="number" min="1" max="60" /> {{ t('webhooks.perMinute') }}</label>
            <label><input v-model.number="form.perDay" class="wh-input wh-num" type="number" min="1" max="500" /> {{ t('webhooks.perDay') }}</label>
          </div>
        </div>
        <label class="wh-form-row">
          <span>{{ t('webhooks.form.timeout') }}</span>
          <div class="wh-limits">
            <label><input v-model.number="form.timeoutMin" class="wh-input wh-num" type="number" min="5" max="240" /> {{ t('webhooks.minutesUnit') }}</label>
          </div>
        </label>
        <label class="wh-check wh-ack">
          <input v-model="form.noGateAck" type="checkbox" data-testid="webhooks-form-nogate" />
          <span>{{ t('webhooks.form.noGate') }}</span>
        </label>
        <p class="wh-hint">{{ t('webhooks.form.default') }}</p>
        <div class="wh-actions">
          <button type="button" class="wh-btn ghost" @click="creating = false">{{ t('webhooks.cancel') }}</button>
          <button type="button" class="wh-btn primary" data-testid="webhooks-form-create" :disabled="busy || !canCreate" @click="create">{{ t('webhooks.create') }}</button>
        </div>
      </SettingsCard>

      <SettingsEmptyState v-if="status && !triggers.length && !creating" :title="t('webhooks.empty.title')" :message="t('webhooks.empty.desc')" />

      <SettingsCard v-for="trigger in triggers" :key="trigger.id" class="wh-trigger" data-testid="webhooks-trigger">
        <div class="wh-head">
          <div class="wh-head-text">
            <div class="wh-name">
              <span v-truncate>{{ trigger.name }}</span>
              <span class="wh-chip">{{ t(`webhooks.kind.${trigger.kind}`) }}</span>
              <span v-if="trigger.unattended" class="wh-chip warn">{{ t('webhooks.unattended.chip') }}</span>
            </div>
            <div class="wh-meta">
              <span class="wh-state" :class="stateTone(trigger)" data-testid="webhooks-state">{{ stateLabel(trigger) }}</span>
              <span v-truncate>{{ pipelineName(trigger.pipeline_id) }}</span>
              <span>{{ t('webhooks.rate', { minute: trigger.per_minute, day: trigger.per_day }) }}</span>
            </div>
          </div>
          <ToggleSwitch
            :model-value="trigger.enabled"
            :disabled="busy || guardOff"
            :aria-label="t('webhooks.enable', { name: trigger.name })"
            @update:model-value="(on: boolean) => setEnabled(trigger, on)"
          />
        </div>
        <div v-if="hasAddress && trigger.kind !== 'form'" class="wh-field">
          <code v-truncate class="wh-code">{{ url(trigger) }}</code>
          <button type="button" class="wh-btn ghost" @click="copy(url(trigger), trigger.id)">{{ copied === trigger.id ? t('webhooks.copied') : t('webhooks.copy') }}</button>
        </div>

        <details class="wh-more" :open="confirming?.id === trigger.id || undefined">
          <summary>{{ t('webhooks.more') }}</summary>
          <div class="wh-more-body">
            <SettingRow :title="t('webhooks.unattended.title')" :description="status?.unattended_supported ? t('webhooks.unattended.desc') : t('webhooks.unattended.unsupported')">
              <template #control>
                <ToggleSwitch
                  :model-value="trigger.unattended"
                  :disabled="busy || !status?.unattended_supported"
                  :aria-label="t('webhooks.unattended.title')"
                  @update:model-value="(on: boolean) => setUnattended(trigger, on)"
                />
              </template>
            </SettingRow>
            <div v-if="confirming?.id === trigger.id" class="wh-disclose" data-testid="webhooks-disclose">
              <template v-if="confirming.what === 'unattended'">
                <strong>{{ t('webhooks.unattended.confirmTitle') }}</strong>
                <ul>
                  <li>{{ t('webhooks.unattended.skips') }}</li>
                  <li>{{ t('webhooks.unattended.external') }}</li>
                  <li>{{ t('webhooks.unattended.scripts') }}</li>
                  <li>{{ t('webhooks.unattended.hook') }}</li>
                </ul>
              </template>
              <template v-else>
                <strong>{{ t('webhooks.weakKey.title') }}</strong>
                <p>{{ t('webhooks.weakKey.body') }}</p>
              </template>
              <label class="wh-check wh-ack">
                <input v-model="confirming.ticked" type="checkbox" data-testid="webhooks-disclose-tick" />
                <span>{{ t(confirming.what === 'unattended' ? 'webhooks.unattended.tick' : 'webhooks.weakKey.tick') }}</span>
              </label>
              <div class="wh-actions">
                <button type="button" class="wh-btn ghost" @click="confirming = null">{{ t('webhooks.cancel') }}</button>
                <button type="button" class="wh-btn primary" data-testid="webhooks-disclose-confirm" :disabled="busy || !confirming.ticked" @click="confirmDisclosure(trigger)">{{ t('webhooks.turnOn') }}</button>
              </div>
            </div>
            <div class="wh-limits wh-limits-row">
              <label><input v-model.number="trigger.per_minute" class="wh-input wh-num" type="number" min="1" max="60" /> {{ t('webhooks.perMinute') }}</label>
              <label><input v-model.number="trigger.per_day" class="wh-input wh-num" type="number" min="1" max="500" /> {{ t('webhooks.perDay') }}</label>
              <label><input v-model.number="trigger.approval_timeout_min" class="wh-input wh-num" type="number" min="5" max="240" /> {{ t('webhooks.minutes') }}</label>
              <button type="button" class="wh-btn" :disabled="busy" @click="saveLimits(trigger)">{{ t('webhooks.save') }}</button>
            </div>
            <div class="wh-actions wh-actions-start">
              <button type="button" class="wh-btn" data-testid="webhooks-log" @click="toggleLog(trigger)">{{ t('webhooks.log.title') }}</button>
              <button type="button" class="wh-btn" @click="rotate(trigger)">{{ t(ROTATE[trigger.kind]) }}</button>
              <button type="button" class="wh-btn danger" data-testid="webhooks-delete" @click="remove(trigger)" @blur="deleting = ''">{{ t(deleting === trigger.id ? 'webhooks.deleteConfirm' : 'webhooks.delete') }}</button>
            </div>
            <table v-if="openLog === trigger.id && events.length" class="wh-log" data-testid="webhooks-log-table">
              <tbody>
                <tr v-for="event in events" :key="event.id">
                  <td class="wh-log-time">{{ time(event.ts) }}</td>
                  <td>{{ outcomeLabel(event.outcome) }}<template v-if="event.count > 1"> × {{ event.count }}</template></td>
                  <td class="wh-log-num">{{ event.status || '' }}</td>
                  <td class="wh-log-num">{{ event.size ?? '' }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else-if="openLog === trigger.id" class="wh-hint">{{ t('webhooks.log.empty') }}</p>
          </div>
        </details>
      </SettingsCard>
    </SettingsSection>
  </div>
</template>

<style scoped>
.webhooks > .settings-notice { margin-bottom: var(--space-group); }
.wh-gap { margin-top: 10px; }
.wh-btn {
  border-radius: 5px;
  font-size: var(--font-xs);
  padding: 5px 10px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
  white-space: nowrap;
}
.wh-btn:hover:not(:disabled) { border-color: var(--border-strong); }
.wh-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.wh-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-accent, #fff); }
.wh-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.wh-btn.primary:disabled { background: transparent; border-color: var(--border-default); color: var(--text-secondary); opacity: 1; }
.wh-btn.ghost { color: var(--text-secondary); }
.wh-btn.danger { color: var(--danger-fg, #d9534f); }
.wh-input {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 4px 8px;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.wh-num { width: 62px; }
.wh-code {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.wh-host { display: flex; gap: 6px; align-items: center; }
.wh-host .wh-input { width: 200px; }
.wh-hint { margin: 0; font-size: var(--font-xs); color: var(--text-secondary); line-height: 1.5; }
.wh-section-actions { display: flex; justify-content: flex-end; margin: -26px 0 8px; }
.wh-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.wh-actions-start { justify-content: flex-start; }
.wh-field { display: flex; align-items: center; gap: 10px; padding: 7px 0; min-width: 0; }
.wh-field-label { flex: none; width: 88px; font-size: var(--font-xs); color: var(--text-secondary); }

.wh-reveal { margin-top: var(--space-group); padding: 14px 16px; border-color: var(--accent-emphasis); }
.wh-reveal-head { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; font-size: var(--font-sm); }
.wh-reveal-head span { font-size: var(--font-xs); color: var(--text-secondary); }

.wh-form { padding: 14px 16px; margin-bottom: 10px; }
.wh-form-row { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 12px; align-items: center; padding: 5px 0; font-size: var(--font-xs); color: var(--text-secondary); }
.wh-form-top { align-items: start; }
.wh-form-row .wh-input:not(.wh-num) { width: 100%; }
.wh-limits { display: flex; flex-wrap: wrap; gap: 14px; color: var(--text-secondary); font-size: var(--font-xs); }
.wh-limits label { display: inline-flex; align-items: center; gap: 6px; }
.wh-limits-row { align-items: center; padding: 8px 0; }
.wh-events { display: flex; flex-wrap: wrap; gap: 6px 14px; }
.wh-events .wh-hint { flex-basis: 100%; }
.wh-fields { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.wh-field-row { display: grid; grid-template-columns: minmax(0, 1fr) 110px auto auto; gap: 8px; align-items: center; }
.wh-field-row .wh-check { align-items: center; }
.wh-field-options { grid-column: 1 / -1; }
.wh-add-field { align-self: flex-start; }
.wh-check { display: inline-flex; align-items: flex-start; gap: 7px; font-size: var(--font-xs); color: var(--text-primary); line-height: 1.5; }
.wh-check input { margin: 2px 0 0; flex: none; }
.wh-ack { display: flex; margin: 8px 0 4px; }

.wh-trigger { padding: 12px 16px; margin-bottom: 10px; }
.wh-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.wh-head-text { min-width: 0; flex: 1; }
.wh-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--font-sm); font-weight: 600; color: var(--text-primary); }
.wh-chip { flex: none; padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; color: var(--text-secondary); background: var(--bg-hover); }
.wh-chip.warn { color: var(--warning-fg, #c08a1e); background: color-mix(in srgb, var(--warning-fg, #c08a1e) 14%, transparent); }
.wh-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin-top: 3px; font-size: var(--font-xs); color: var(--text-secondary); min-width: 0; }
.wh-state.ok { color: var(--success-fg, #2e9e5b); }
.wh-state.warn { color: var(--warning-fg, #c08a1e); font-weight: 600; }

.wh-disclose { margin: 8px 0 4px; padding: 10px 12px; border-left: 2px solid var(--warning-fg, #c08a1e); background: var(--bg-hover); font-size: var(--font-xs); color: var(--text-primary); line-height: 1.55; }
.wh-disclose ul { margin: 6px 0; padding-left: 18px; }
.wh-disclose p { margin: 6px 0; }

.wh-more { margin-top: 4px; }
.wh-more summary { cursor: pointer; font-size: var(--font-xs); color: var(--text-secondary); padding: 3px 0; width: fit-content; }
.wh-more-body { padding-top: 4px; }
.wh-more-body :deep(.setting-row) { padding-left: 0; padding-right: 0; }
.wh-log { width: 100%; margin-top: 10px; border-collapse: collapse; font-size: var(--font-xs); color: var(--text-secondary); }
.wh-log td { padding: 4px 8px 4px 0; border-top: 1px solid var(--border-subtle, var(--border-default)); vertical-align: top; }
.wh-log-time { white-space: nowrap; width: 1%; padding-right: 16px !important; }
.wh-log-num { width: 1%; white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }

@media (max-width: 640px) {
  .wh-form-row { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .wh-host { flex-wrap: wrap; }
  .wh-host .wh-input { width: 100%; }
}
</style>
