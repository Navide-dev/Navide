<script setup lang="ts">
/**
 * The right column while adding an account: choose how the CLI connects, then
 * fill the form in the same place. The pasted key lives in `secret` only until
 * it is saved or this panel closes.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { isWindows } from '../../../../shared/osplat'
import { API_KEY_AGENTS, type ApiKeyProfile, type ApiKeyTestResult, type apiKeyAccountCalls } from './apiKeyAccount'
import ApiKeyField, { reminderAmount } from './ApiKeyField.vue'

const props = defineProps<{
  calls: ReturnType<typeof apiKeyAccountCalls>
  agents: { agentKey: string; label: string }[]
  agentKey: string
  /** Providers a multi-scope CLI must pick from before signing in. */
  scopes: string[]
  scope: string
}>()
const emit = defineEmits<{
  (e: 'update:agentKey', agentKey: string): void
  (e: 'update:scope', scope: string): void
  (e: 'subscribe', agentKey: string): void
  (e: 'saved', profile: ApiKeyProfile): void
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
// Which test may still report: an answer is about the key it was asked about.
let testRun = 0

const agentLabel = computed(() => props.agents.find((a) => a.agentKey === props.agentKey)?.label ?? '')
const keysSupported = computed(() => API_KEY_AGENTS.includes(props.agentKey))
// Said here rather than after a key was pasted and refused.
const keysBlockedHere = computed(() => props.agentKey === 'claude' && isWindows())

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
  testRun += 1
  testing.value = false
  testResult.value = null
})
watch(() => props.agentKey, back)
onBeforeUnmount(reset)

async function test(): Promise<void> {
  const run = ++testRun
  testing.value = true
  errorCode.value = null
  const answer = await props.calls.testPasted(props.agentKey, secret.value)
  if (run !== testRun) return
  testing.value = false
  if (answer.ok) testResult.value = answer.result ?? 'unknown'
  else errorCode.value = answer.error_code ?? 'internal-error'
}

async function save(): Promise<void> {
  saving.value = true
  errorCode.value = null
  const answer = await props.calls.create(props.agentKey, name.value, secret.value, reminderAmount(reminder.value))
  saving.value = false
  if (answer.ok && answer.profile) {
    reset()
    emit('saved', answer.profile)
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
      <div class="add-pick">
        <select
          v-if="agents.length > 1"
          class="ak-input"
          :aria-label="t('settings.accounts.api-keys.add.agent-label')"
          :value="agentKey"
          @change="$emit('update:agentKey', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="agent in agents" :key="agent.agentKey" :value="agent.agentKey">{{ agent.label }}</option>
        </select>
        <select
          v-if="scopes.length > 0"
          class="ak-input"
          :aria-label="t('settings.accounts.cli.new-account-scope')"
          :value="scope || scopes[0]"
          @change="$emit('update:scope', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="choice in scopes" :key="choice" :value="choice">{{ choice }}</option>
        </select>
      </div>
      <div class="add-ways">
        <button type="button" class="add-way" @click="$emit('subscribe', agentKey)">
          <b>{{ t('settings.accounts.api-keys.add.subscription') }}</b>
          <span>{{ t('settings.accounts.api-keys.add.subscription-desc') }}</span>
        </button>
        <button type="button" class="add-way" :disabled="!keysSupported || keysBlockedHere" data-way="api-key" @click="step = 'api-key'">
          <b>{{ t('settings.accounts.api-keys.add.api-key') }}</b>
          <span>{{
            keysBlockedHere
              ? t('settings.accounts.api-keys.error.unsupported-platform')
              : keysSupported
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
      </div>
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
      <input id="api-key-reminder" v-model="reminder" class="ak-input ak-amount" type="number" min="1" step="1" />
      <p class="ak-hint">{{ t('settings.accounts.api-keys.form.reminder-hint') }}</p>
      <p v-if="errorCode" class="ak-error" role="alert">{{ t(`settings.accounts.api-keys.error.${errorCode}`) }}</p>
      <ul class="ak-safe">
        <li>{{ t('settings.accounts.api-keys.safe.local') }}</li>
        <li>{{ t('settings.accounts.api-keys.safe.no-sync') }}</li>
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
.add-pick { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.add-pick:empty { display: none; }
.add-pick .ak-input { width: auto; max-width: 100%; }
.add-ways { display: grid; gap: 8px; margin-top: 12px; }
.add-way { position: relative; display: block; width: 100%; padding: 10px 12px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-subtle); color: var(--text-primary); text-align: left; cursor: pointer; transition: border-color 120ms ease; }
.add-way:hover:not(:disabled) { border-color: var(--accent-fg); }
.add-way:focus-visible { outline: 2px solid var(--accent-fg); outline-offset: 1px; }
.add-way:disabled { cursor: not-allowed; }
.add-way:disabled b, .add-way:disabled span { color: var(--text-muted); }
.add-way b { display: block; font-size: var(--font-xs); font-weight: 600; }
.add-way span { display: block; margin-top: 2px; font-size: var(--font-2xs); line-height: 1.4; color: var(--text-secondary); }
/* The tag takes its own line under a long label instead of covering it. */
.add-way em { display: block; margin-top: 4px; font-style: normal; font-size: var(--font-2xs); font-weight: 600; color: var(--text-secondary); }
</style>
