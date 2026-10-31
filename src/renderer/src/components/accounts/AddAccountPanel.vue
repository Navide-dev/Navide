<script setup lang="ts">
/**
 * The right column while adding an account: choose how the CLI should pay,
 * then fill the form in the same place. The pasted key lives in `secret` only
 * until it is saved or this panel closes.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { ApiKeyRow, ApiKeyTestResult, useApiKeys } from '../../composables/useApiKeys'
import ApiKeyField, { reminderAmount } from './ApiKeyField.vue'

const props = defineProps<{
  apiKeys: ReturnType<typeof useApiKeys>
  agents: { agentKey: string; label: string }[]
  agentKey: string
}>()
const emit = defineEmits<{
  (e: 'update:agentKey', agentKey: string): void
  (e: 'subscribe', agentKey: string): void
  (e: 'saved', key: ApiKeyRow): void
  (e: 'cancel'): void
}>()
const { t } = i18n.global

type Step = 'choose' | 'api-key'
const step = ref<Step>('choose')
const name = ref('')
const reminder = ref<string | number>('')
const secret = ref('')
const testing = ref(false)
const testResult = ref<ApiKeyTestResult | null>(null)
const saving = ref(false)
const errorCode = ref<string | null>(null)

const agentLabel = computed(() => props.agents.find((a) => a.agentKey === props.agentKey)?.label ?? '')
const keysSupported = computed(() => props.apiKeys.supportedAgents.value.includes(props.agentKey))

function reset(): void {
  name.value = ''
  reminder.value = ''
  secret.value = ''
  testResult.value = null
  errorCode.value = null
}

function back(): void {
  reset()
  step.value = 'choose'
}

watch(secret, () => {
  testResult.value = null
})
watch(() => props.agentKey, back)
onBeforeUnmount(reset)

async function test(): Promise<void> {
  testing.value = true
  errorCode.value = null
  const answer = await props.apiKeys.testPasted(props.agentKey, secret.value)
  testing.value = false
  if (answer.ok) testResult.value = answer.result ?? 'unknown'
  else errorCode.value = answer.error_code ?? 'internal-error'
}

async function save(): Promise<void> {
  saving.value = true
  errorCode.value = null
  const amount = reminderAmount(reminder.value)
  const answer = await props.apiKeys.create(props.agentKey, name.value, secret.value, amount)
  saving.value = false
  if (answer.ok && answer.key) {
    reset()
    emit('saved', answer.key)
  } else {
    errorCode.value = answer.error_code ?? 'internal-error'
  }
}

const canSave = computed(
  () => !saving.value && name.value.trim() !== '' && secret.value.trim() !== '' && testResult.value !== 'rejected',
)
</script>

<template>
  <div class="add-panel">
    <template v-if="step === 'choose'">
      <h4 class="ak-title">{{ t('settings.accounts.api-keys.add.title', { agent: agentLabel }) }}</h4>
      <select
        v-if="agents.length > 1"
        class="ak-input add-agent"
        :aria-label="t('settings.accounts.api-keys.add.agent-label')"
        :value="agentKey"
        @change="$emit('update:agentKey', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="agent in agents" :key="agent.agentKey" :value="agent.agentKey">{{ agent.label }}</option>
      </select>
      <button type="button" class="add-way" @click="$emit('subscribe', agentKey)">
        <b>{{ t('settings.accounts.api-keys.add.subscription') }}</b>
        <span>{{ t('settings.accounts.api-keys.add.subscription-desc') }}</span>
      </button>
      <button type="button" class="add-way" :disabled="!keysSupported" data-way="api-key" @click="step = 'api-key'">
        <b>{{ t('settings.accounts.api-keys.add.api-key') }}</b>
        <span>{{
          keysSupported
            ? t('settings.accounts.api-keys.add.api-key-desc')
            : t('settings.accounts.api-keys.add.api-key-unsupported')
        }}</span>
      </button>
      <button type="button" class="add-way" disabled>
        <b>{{ t('settings.accounts.api-keys.add.cloud') }}</b>
        <span>{{ t('settings.accounts.api-keys.add.cloud-desc') }}</span>
        <em>{{ t('settings.accounts.api-keys.add.coming-soon') }}</em>
      </button>
      <button type="button" class="add-way" disabled>
        <b>{{ t('settings.accounts.api-keys.add.endpoint') }}</b>
        <span>{{ t('settings.accounts.api-keys.add.endpoint-desc') }}</span>
        <em>{{ t('settings.accounts.api-keys.add.coming-soon') }}</em>
      </button>
      <div class="ak-actions end">
        <button type="button" class="ak-btn" @click="$emit('cancel')">{{ t('settings.accounts.cancel') }}</button>
      </div>
    </template>

    <form v-else @submit.prevent="save">
      <h4 class="ak-title">{{ t('settings.accounts.api-keys.form.title') }}</h4>
      <p class="ak-lead">{{ t('settings.accounts.api-keys.form.billing') }}</p>
      <label class="ak-label" for="api-key-name">{{ t('settings.accounts.api-keys.form.name') }}</label>
      <input id="api-key-name" v-model="name" class="ak-input" maxlength="60" autocomplete="off" />
      <ApiKeyField
        v-model="secret"
        :label="t('settings.accounts.api-keys.form.key')"
        :testing="testing"
        :result="testResult"
        @test="test"
      />
      <label class="ak-label" for="api-key-reminder">{{ t('settings.accounts.api-keys.form.reminder') }}</label>
      <input id="api-key-reminder" v-model="reminder" class="ak-input" type="number" min="1" step="1" />
      <p class="ak-hint">{{ t('settings.accounts.api-keys.form.reminder-hint') }}</p>
      <p v-if="errorCode" class="ak-error" role="alert">{{ t(`settings.accounts.api-keys.error.${errorCode}`) }}</p>
      <ul class="ak-safe">
        <li>{{ t('settings.accounts.api-keys.safe.local') }}</li>
        <li>{{ t('settings.accounts.api-keys.safe.no-sync') }}</li>
        <li>{{ t('settings.accounts.api-keys.safe.agent') }}</li>
      </ul>
      <div class="ak-actions end">
        <button type="button" class="ak-btn" @click="back">{{ t('settings.accounts.cancel') }}</button>
        <button type="submit" class="ak-btn primary" :disabled="!canSave">{{ t('settings.accounts.api-keys.form.save') }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped src="./apiKeyStyles.css"></style>
<style scoped>
.add-agent { width: auto; max-width: 100%; margin: 4px 0; }
.add-way { position: relative; display: block; width: 100%; margin-top: 8px; padding: 9px 12px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-subtle); color: var(--text-primary); text-align: left; cursor: pointer; }
.add-way:hover:not(:disabled) { border-color: var(--accent-fg); }
.add-way:disabled { cursor: not-allowed; opacity: 0.6; }
.add-way b { display: block; font-size: var(--font-xs); font-weight: 600; }
.add-way span { font-size: var(--font-2xs); color: var(--text-secondary); }
.add-way em { position: absolute; top: 9px; right: 12px; font-style: normal; font-size: var(--font-2xs); color: var(--text-secondary); }
</style>
