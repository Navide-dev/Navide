<script setup lang="ts">
/** The right column for an API key account. Navide cannot read a key's balance,
 *  so there is no quota or spend here, only what the user set. */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import ToggleSwitch from '../settings/ToggleSwitch.vue'
import type { ApiKeyAnswer, ApiKeyProfile, ApiKeyTestResult, apiKeyAccountCalls } from './apiKeyAccount'
import ApiKeyField, { reminderAmount } from './ApiKeyField.vue'

const props = defineProps<{
  calls: ReturnType<typeof apiKeyAccountCalls>
  row: ApiKeyProfile
  agentLabel: string
  /** New panes start on this account. */
  inUse: boolean
  switching: boolean
}>()
const emit = defineEmits<{
  (e: 'switch'): void
  (e: 'stop-using'): void
  (e: 'deleted'): void
}>()
const { t } = i18n.global
const { confirm } = useNotify()

const name = ref(props.row.name)
const reminder = ref<string | number>(props.row.monthlyReminderUsd ?? '')
const replacing = ref(false)
const secret = ref('')
const testing = ref(false)
const testResult = ref<ApiKeyTestResult | null>(null)
const storedResult = ref<ApiKeyTestResult | null>(null)
const errorCode = ref<string | null>(null)
// Which test may still report: an answer is about the key it was asked about.
let testRun = 0

// A Claude API key account is chosen per pane; a Codex one replaces the live
// login like any other account, so "stop" has no meaning there.
const perPane = computed(() => props.row.agentKey === 'claude')

function dropTest(): void {
  testRun += 1
  testing.value = false
}

function closeReplace(): void {
  replacing.value = false
  secret.value = ''
  testResult.value = null
}

watch(
  () => props.row.id,
  () => {
    name.value = props.row.name
    reminder.value = props.row.monthlyReminderUsd ?? ''
    storedResult.value = null
    errorCode.value = null
    dropTest()
    closeReplace()
  },
)
watch(secret, () => {
  dropTest()
  testResult.value = null
})
onBeforeUnmount(closeReplace)

async function run(work: Promise<ApiKeyAnswer>): Promise<boolean> {
  errorCode.value = null
  const answer = await work
  if (!answer.ok) errorCode.value = answer.error_code ?? 'internal-error'
  return answer.ok
}

function saveName(): void {
  if (name.value.trim() === props.row.name) return
  void run(props.calls.update(props.row.id, { name: name.value }))
}

function saveReminder(): void {
  const amount = reminderAmount(reminder.value)
  if (amount === props.row.monthlyReminderUsd) return
  void run(props.calls.update(props.row.id, { monthlyReminderUsd: amount }))
}

function setAutoSwitch(autoSwitch: boolean): void {
  void run(props.calls.update(props.row.id, { autoSwitch }))
}

async function testStored(): Promise<void> {
  const run = ++testRun
  testing.value = true
  errorCode.value = null
  const answer = await props.calls.testStored(props.row.id)
  if (run !== testRun) return
  testing.value = false
  if (answer.ok) storedResult.value = answer.result ?? 'unknown'
  else errorCode.value = answer.error_code ?? 'internal-error'
}

async function testPasted(): Promise<void> {
  const run = ++testRun
  testing.value = true
  errorCode.value = null
  const answer = await props.calls.testPasted(props.row.agentKey, secret.value)
  if (run !== testRun) return
  testing.value = false
  if (answer.ok) testResult.value = answer.result ?? 'unknown'
  else errorCode.value = answer.error_code ?? 'internal-error'
}

async function replace(): Promise<void> {
  if (await run(props.calls.replaceSecret(props.row.id, secret.value))) {
    dropTest()
    storedResult.value = null
    closeReplace()
  }
}

async function remove(): Promise<void> {
  const yes = await confirm(t('settings.accounts.api-keys.detail.delete-message', { name: props.row.name }), {
    title: t('settings.accounts.api-keys.detail.delete-title'),
    confirmText: t('settings.accounts.delete'),
    danger: true,
  })
  if (yes && (await run(props.calls.remove(props.row.id)))) emit('deleted')
}
</script>

<template>
  <div class="key-detail">
    <div class="key-head">
      <input
        v-model="name"
        class="key-name"
        maxlength="60"
        :aria-label="t('settings.accounts.api-keys.form.name')"
        @change="saveName"
      />
      <span v-if="inUse" class="key-pill in-use">{{
        t(perPane ? 'settings.accounts.api-keys.detail.in-use' : 'settings.accounts.cli.is-default')
      }}</span>
    </div>
    <p class="key-meta">
      <span class="key-pill">{{ t('settings.accounts.api-keys.kind') }}</span>
      <span>{{ agentLabel }}</span>
      <span class="key-last4">{{ t('settings.accounts.api-keys.detail.ends-with', { last4: row.last4 }) }}</span>
    </p>

    <div class="key-section">
      <div class="key-row">
        <div class="key-row-text">
          <label class="key-row-title" for="api-key-detail-reminder">{{ t('settings.accounts.api-keys.form.reminder') }}</label>
          <p class="ak-hint">{{ t('settings.accounts.api-keys.form.reminder-hint') }}</p>
        </div>
        <input id="api-key-detail-reminder" v-model="reminder" class="ak-input ak-amount" type="number" min="1" step="1" @change="saveReminder" />
      </div>
      <div class="key-row">
        <div class="key-row-text">
          <span id="api-key-auto-switch" class="key-row-title">{{ t('settings.accounts.api-keys.detail.auto-switch') }}</span>
          <p class="ak-hint">{{ t('settings.accounts.api-keys.detail.auto-switch-hint') }}</p>
        </div>
        <ToggleSwitch
          :model-value="row.autoSwitch === true"
          aria-labelledby="api-key-auto-switch"
          data-testid="api-key-auto-switch"
          @update:model-value="setAutoSwitch"
        />
      </div>
    </div>

    <template v-if="replacing">
      <ApiKeyField
        v-model="secret"
        :label="t('settings.accounts.api-keys.form.key-new')"
        :testing="testing"
        :result="testResult"
        @test="testPasted"
      />
      <div class="ak-actions">
        <button type="button" class="ak-btn primary" :disabled="!secret.trim() || testResult === 'rejected'" @click="replace">
          {{ t('settings.accounts.api-keys.detail.replace-save') }}
        </button>
        <button type="button" class="ak-btn" @click="closeReplace">{{ t('settings.accounts.cancel') }}</button>
      </div>
    </template>
    <template v-else>
      <p v-if="storedResult" class="ak-result" :class="storedResult" role="status">
        {{ t(`settings.accounts.api-keys.form.test-${storedResult}`) }}
      </p>
      <p v-if="perPane" class="ak-hint key-switch-hint">{{ t('settings.accounts.api-keys.detail.switch-hint') }}</p>
      <div class="ak-actions key-actions">
        <button
          v-if="!inUse"
          type="button"
          class="ak-btn primary"
          data-testid="api-key-switch"
          :disabled="switching"
          @click="emit('switch')"
        >
          {{
            switching
              ? t('settings.accounts.cli.switching')
              : t(perPane ? 'settings.accounts.api-keys.detail.use-for-new-panes' : 'settings.accounts.cli.set-default')
          }}
        </button>
        <button
          v-else-if="perPane"
          type="button"
          class="ak-btn"
          data-testid="api-key-stop-using"
          :disabled="switching"
          @click="emit('stop-using')"
        >
          {{ t('settings.accounts.api-keys.detail.stop-using') }}
        </button>
        <button type="button" class="ak-btn" :disabled="testing" data-testid="api-key-test" @click="testStored">
          {{ testing ? t('settings.accounts.api-keys.form.testing') : t('settings.accounts.api-keys.form.test') }}
        </button>
        <button type="button" class="ak-btn" data-testid="api-key-replace" @click="replacing = true">
          {{ t('settings.accounts.api-keys.detail.replace') }}
        </button>
        <button type="button" class="ak-btn danger key-delete" data-testid="api-key-delete" @click="remove">
          {{ t('settings.accounts.delete') }}
        </button>
      </div>
    </template>
    <p v-if="errorCode" class="ak-error" role="alert">{{ t(`settings.accounts.api-keys.error.${errorCode}`) }}</p>

    <ul class="ak-safe">
      <li>{{ t('settings.accounts.api-keys.safe.local') }}</li>
      <li>{{ t('settings.accounts.api-keys.safe.no-sync') }}</li>
    </ul>
  </div>
</template>

<style scoped src="./apiKeyStyles.css"></style>
<style scoped>
.key-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.key-name { flex: 1; min-width: 0; padding: 2px 4px; margin-left: -5px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--text-primary); font-size: var(--font-md); font-weight: 650; }
.key-name:hover { border-color: var(--border-muted); }
.key-name:focus-visible { border-color: var(--accent-fg); outline: none; }
.key-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 6px 0 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.key-last4 { font-variant-numeric: tabular-nums; }
.key-pill { flex: none; padding: 0 8px; border: 1px solid var(--border-default); border-radius: 999px; background: var(--bg-muted); color: var(--text-primary); font-size: var(--font-2xs); font-weight: 600; line-height: 1.6; }
.key-section { margin-top: 14px; border-top: 1px solid var(--border-muted); }
.key-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 0; border-bottom: 1px solid var(--border-muted); }
.key-row-text { flex: 1; min-width: 0; }
.key-row-title { display: block; font-size: var(--font-xs); font-weight: 600; color: var(--text-primary); }
.key-row .ak-hint { max-width: 52ch; line-height: 1.45; }
.key-row > .ak-amount, .key-row > :deep(.toggle-switch) { flex: none; }
.key-switch-hint { margin-top: 14px; line-height: 1.45; }
.key-switch-hint + .ak-actions { margin-top: 8px; }
/* Delete sits apart from the actions that keep the account. */
.key-delete { margin-left: auto; }
</style>
