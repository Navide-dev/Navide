<script setup lang="ts">
/** The right column for a stored API key. No pane spends a key yet, so there
 *  is no spend to show and no switch to offer: the panel says so. */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import type { ApiKeyRow, ApiKeyTestResult, useApiKeys } from '../../composables/useApiKeys'
import ApiKeyField, { reminderAmount } from './ApiKeyField.vue'

const props = defineProps<{ apiKeys: ReturnType<typeof useApiKeys>; row: ApiKeyRow; agentLabel: string }>()
const emit = defineEmits<{ (e: 'deleted'): void }>()
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

const initial = computed(() => Array.from(props.row.name)[0]?.toUpperCase() ?? '')

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
    closeReplace()
  },
)
watch(secret, () => {
  testResult.value = null
})
onBeforeUnmount(closeReplace)

async function run(work: Promise<{ ok: boolean; error_code?: string }>): Promise<boolean> {
  errorCode.value = null
  const answer = await work
  if (!answer.ok) errorCode.value = answer.error_code ?? 'internal-error'
  return answer.ok
}

function saveName(): void {
  if (name.value.trim() === props.row.name) return
  void run(props.apiKeys.update(props.row.id, { name: name.value }))
}

function saveReminder(): void {
  const amount = reminderAmount(reminder.value)
  if (amount === props.row.monthlyReminderUsd) return
  void run(props.apiKeys.update(props.row.id, { monthlyReminderUsd: amount }))
}

async function testStored(): Promise<void> {
  testing.value = true
  errorCode.value = null
  const answer = await props.apiKeys.testStored(props.row.id)
  testing.value = false
  if (answer.ok) storedResult.value = answer.result ?? 'unknown'
  else errorCode.value = answer.error_code ?? 'internal-error'
}

async function testPasted(): Promise<void> {
  testing.value = true
  const answer = await props.apiKeys.testPasted(props.row.agentKey, secret.value)
  testing.value = false
  if (answer.ok) testResult.value = answer.result ?? 'unknown'
  else errorCode.value = answer.error_code ?? 'internal-error'
}

async function replace(): Promise<void> {
  if (await run(props.apiKeys.replaceSecret(props.row.id, secret.value))) {
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
  if (yes && (await run(props.apiKeys.remove(props.row.id)))) emit('deleted')
}
</script>

<template>
  <div class="key-detail">
    <div class="key-head">
      <span class="key-av" aria-hidden="true">{{ initial }}</span>
      <input
        v-model="name"
        class="key-name"
        maxlength="60"
        :aria-label="t('settings.accounts.api-keys.form.name')"
        @change="saveName"
      />
    </div>
    <p class="key-meta">{{ agentLabel }}<span class="key-pill">{{ t('settings.accounts.api-keys.kind') }}</span>{{ t('settings.accounts.api-keys.detail.ends-with', { last4: row.last4 }) }}</p>
    <p class="key-state">{{ t('settings.accounts.api-keys.detail.not-in-use') }}</p>

    <label class="ak-label" for="api-key-detail-reminder">{{ t('settings.accounts.api-keys.form.reminder') }}</label>
    <input id="api-key-detail-reminder" v-model="reminder" class="ak-input key-amount" type="number" min="1" step="1" @change="saveReminder" />
    <p class="ak-hint">{{ t('settings.accounts.api-keys.form.reminder-hint') }}</p>

    <ul class="ak-safe">
      <li>{{ t('settings.accounts.api-keys.safe.local') }}</li>
      <li>{{ t('settings.accounts.api-keys.safe.no-sync') }}</li>
      <li>{{ t('settings.accounts.api-keys.safe.agent') }}</li>
    </ul>

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
      <div class="ak-actions">
        <button type="button" class="ak-btn" :disabled="testing" @click="testStored">
          {{ testing ? t('settings.accounts.api-keys.form.testing') : t('settings.accounts.api-keys.form.test') }}
        </button>
        <button type="button" class="ak-btn" @click="replacing = true">{{ t('settings.accounts.api-keys.detail.replace') }}</button>
        <button type="button" class="ak-btn danger" @click="remove">{{ t('settings.accounts.delete') }}</button>
      </div>
    </template>
    <p v-if="errorCode" class="ak-error" role="alert">{{ t(`settings.accounts.api-keys.error.${errorCode}`) }}</p>
  </div>
</template>

<style scoped src="./apiKeyStyles.css"></style>
<style scoped>
.key-head { display: flex; align-items: center; gap: 9px; }
.key-av { flex: none; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--bg-muted); color: var(--text-primary); font-size: var(--font-2xs); font-weight: 700; }
.key-name { flex: 1; min-width: 0; padding: 2px 4px; margin-left: -4px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--text-primary); font-size: var(--font-md); font-weight: 650; }
.key-name:hover { border-color: var(--border-muted); }
.key-name:focus-visible { border-color: var(--accent-fg); outline: none; }
.key-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0 0; font-size: var(--font-2xs); color: var(--text-secondary); }
.key-pill { padding: 0 8px; border: 1px solid var(--border-default); border-radius: 999px; background: var(--bg-muted); color: var(--text-primary); font-weight: 600; }
.key-state { margin: 14px 0 0; padding: 9px 12px; border-left: 2px solid var(--accent-fg); background: var(--bg-subtle); font-size: var(--font-xs); line-height: 1.5; color: var(--text-primary); max-width: 60ch; }
.key-amount { width: 140px; }
</style>
