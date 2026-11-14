<script lang="ts">
/** A number input's v-model holds a number once it has one, a string while empty. */
export function reminderAmount(raw: string | number): number | null {
  const text = String(raw).trim()
  return text === '' ? null : Number(text)
}
</script>

<script setup lang="ts">
/** The password field for an API key, and the one way to test it. The value
 *  stays in the parent only until it is saved. */
import { i18n } from '@navide/plugin-ui/foundation'
import type { ApiKeyTestResult } from './apiKeyAccount'

defineProps<{
  modelValue: string
  label: string
  testing: boolean
  result: ApiKeyTestResult | null
  disabled?: boolean
}>()
defineEmits<{ (e: 'update:modelValue', value: string): void; (e: 'test'): void }>()
const { t } = i18n.global
</script>

<template>
  <label class="ak-label" for="api-key-secret">{{ label }}</label>
  <div class="ak-secret">
    <input
      id="api-key-secret"
      class="ak-input"
      type="password"
      autocomplete="off"
      spellcheck="false"
      :value="modelValue"
      :disabled="disabled"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button type="button" class="ak-btn" :disabled="disabled || testing || !modelValue.trim()" @click="$emit('test')">
      {{ testing ? t('settings.accounts.api-keys.form.testing') : t('settings.accounts.api-keys.form.test') }}
    </button>
  </div>
  <p class="ak-hint">{{ t('settings.accounts.api-keys.form.key-hint') }}</p>
  <p v-if="result" class="ak-result" :class="result" role="status">
    {{ t(`settings.accounts.api-keys.form.test-${result}`) }}
  </p>
</template>

<style scoped src="./apiKeyStyles.css"></style>
