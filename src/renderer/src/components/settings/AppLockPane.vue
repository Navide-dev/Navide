<script setup lang="ts">
// Settings → App Lock. Main owns the lock state, the settings and the PIN
// (src/main/appLock.ts); this page only reads them and asks for changes.
// The lock is a privacy screen over the windows and nothing more, which the
// notice at the top says in so many words.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { isMacPlatform } from '@navide/plugin-ui/shared'
import SettingsNotice from './SettingsNotice.vue'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'
import {
  APP_LOCK_IDLE_CHOICES,
  APP_LOCK_SYSTEM_NAMES,
  isValidAppLockPin,
  type AppLockResult,
  type AppLockSettings,
  type AppLockStatus,
} from '../../../../shared/appLock'

type PinForm = 'set' | 'change' | 'remove' | 'reset'

const { t } = useI18n()
const api = window.agentTeam?.appLock
const status = ref<AppLockStatus | null>(null)
let offStatus: (() => void) | null = null

onMounted(() => {
  if (!api) return
  offStatus = api.onStatus((s) => (status.value = s))
  void api.status().then((s) => (status.value = s), (e) => console.warn('[app-lock] status could not be read', e))
})
onBeforeUnmount(() => offStatus?.())

const settings = computed(() => status.value?.settings)
const hasPin = computed(() => status.value?.hasPin ?? false)
const systemAvailable = computed(() => status.value?.systemUnlockAvailable ?? false)
// Touch ID or Windows Hello; null where the PIN is the only way (Linux, Windows 10).
const systemKind = computed(() => status.value?.systemUnlockKind ?? null)
const system = computed(() => ({ system: APP_LOCK_SYSTEM_NAMES[systemKind.value ?? 'touch-id'] }))
const shortcut = isMacPlatform() ? '⌘⌥L' : 'Ctrl+Alt+L'

const form = ref<PinForm | null>(null)
const currentPin = ref('')
const newPin = ref('')
const confirmPin = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)

function errorText(result: AppLockResult): string {
  if (result.ok) return ''
  switch (result.error) {
    case 'invalid-pin': return t('settings.app-lock.error-invalid-pin')
    case 'wrong-pin': return t('settings.app-lock.error-wrong-pin')
    case 'cooldown': return t('settings.app-lock.error-cooldown', { seconds: Math.ceil((result.retryAfterMs ?? 0) / 1000) })
    case 'system-failed':
    case 'system-unavailable': return t('settings.app-lock.error-system-failed', system.value)
    default: return t('settings.app-lock.error-generic')
  }
}

async function update(patch: Partial<AppLockSettings>): Promise<void> {
  if (!api) return
  error.value = ''
  const result = await api.updateSettings(patch)
  if (!result.ok) error.value = errorText(result)
}

function openForm(next: PinForm): void {
  form.value = next
  currentPin.value = ''
  newPin.value = ''
  confirmPin.value = ''
  error.value = ''
  notice.value = ''
}

const needsCurrent = computed(() => form.value === 'change' || form.value === 'remove')
const needsNew = computed(() => form.value !== null && form.value !== 'remove')

async function submit(): Promise<void> {
  if (!api || !form.value || busy.value) return
  error.value = ''
  if (needsNew.value) {
    if (!isValidAppLockPin(newPin.value)) { error.value = t('settings.app-lock.error-invalid-pin'); return }
    if (newPin.value !== confirmPin.value) { error.value = t('settings.app-lock.error-mismatch'); return }
  }
  busy.value = true
  try {
    const kind = form.value
    const result = kind === 'set'
      ? await api.setPin(newPin.value)
      : kind === 'change'
        ? await api.setPin(newPin.value, currentPin.value)
        : kind === 'reset'
          ? await api.resetPinWithSystem(newPin.value)
          : await api.removePin(currentPin.value)
    if (!result.ok) { error.value = errorText(result); return }
    notice.value = kind === 'remove' ? t('settings.app-lock.pin-removed') : t('settings.app-lock.pin-saved')
    form.value = null
  } finally {
    busy.value = false
    currentPin.value = ''
    newPin.value = ''
    confirmPin.value = ''
  }
}

function digits(event: Event): string {
  const input = event.target as HTMLInputElement
  input.value = input.value.replace(/\D/g, '')
  return input.value
}

function idleLabel(minutes: number): string {
  return minutes === 0 ? t('settings.app-lock.idle-never') : t('settings.app-lock.idle-minutes', { n: minutes })
}
</script>

<template>
  <div v-if="api && settings" class="app-lock" data-testid="app-lock-pane">
    <SettingsNotice tone="info" data-testid="app-lock-notice" :message="t('settings.app-lock.notice')" />

    <SettingsSection :label="t('settings.app-lock.section-lock')">
      <SettingsCard>
        <SettingRow :title="t('settings.app-lock.enabled')" :description="systemKind ? t('settings.app-lock.enabled-hint', system) : t('settings.app-lock.enabled-hint-pin-only')">
          <template #control>
            <ToggleSwitch
              data-testid="app-lock-enabled"
              :model-value="settings.enabled"
              :disabled="!hasPin"
              :aria-label="t('settings.app-lock.enabled')"
              @update:model-value="(v) => update({ enabled: v })"
            />
          </template>
        </SettingRow>
        <SettingRow :title="t('settings.app-lock.lock-now')" :description="t('settings.app-lock.lock-now-hint', { shortcut })">
          <template #control>
            <button type="button" class="al-btn ghost" data-testid="app-lock-lock-now" :disabled="!settings.enabled" @click="api.lockNow()">
              {{ t('settings.app-lock.lock-now') }}
            </button>
          </template>
        </SettingRow>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection :label="t('settings.app-lock.section-pin')">
      <SettingsCard>
        <SettingRow :title="t('settings.app-lock.pin')" :description="hasPin ? t('settings.app-lock.pin-set-hint') : t('settings.app-lock.pin-none-hint')">
          <template #control>
            <div class="al-actions">
              <button v-if="!hasPin" type="button" class="al-btn ghost" data-testid="app-lock-set-pin" @click="openForm('set')">{{ t('settings.app-lock.set-pin') }}</button>
              <template v-else>
                <button type="button" class="al-btn ghost" data-testid="app-lock-change-pin" @click="openForm('change')">{{ t('settings.app-lock.change-pin') }}</button>
                <button type="button" class="al-btn ghost" data-testid="app-lock-remove-pin" @click="openForm('remove')">{{ t('settings.app-lock.remove-pin') }}</button>
              </template>
            </div>
          </template>
        </SettingRow>
        <form v-if="form" class="al-form" data-testid="app-lock-pin-form" @submit.prevent="submit">
          <p v-if="form === 'remove'" class="al-hint">{{ t('settings.app-lock.remove-pin-hint') }}</p>
          <label v-if="needsCurrent">
            <span>{{ t('settings.app-lock.current-pin') }}</span>
            <input :value="currentPin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" data-testid="app-lock-current-pin" @input="currentPin = digits($event)" />
          </label>
          <template v-if="needsNew">
            <label>
              <span>{{ t('settings.app-lock.new-pin') }}</span>
              <input :value="newPin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" data-testid="app-lock-new-pin" @input="newPin = digits($event)" />
            </label>
            <label>
              <span>{{ t('settings.app-lock.confirm-pin') }}</span>
              <input :value="confirmPin" type="password" inputmode="numeric" maxlength="12" autocomplete="off" data-testid="app-lock-confirm-pin" @input="confirmPin = digits($event)" />
            </label>
          </template>
          <div class="al-actions">
            <button type="submit" class="al-btn primary" data-testid="app-lock-pin-save" :disabled="busy">
              {{ form === 'remove' ? t('settings.app-lock.remove-pin') : t('settings.app-lock.save') }}
            </button>
            <button type="button" class="al-btn ghost" @click="form = null">{{ t('settings.app-lock.cancel') }}</button>
          </div>
        </form>
      </SettingsCard>
      <p v-if="error" class="al-error" role="alert" data-testid="app-lock-error">{{ error }}</p>
      <p v-else-if="notice" class="al-hint" data-testid="app-lock-notice-ok">{{ notice }}</p>
    </SettingsSection>

    <SettingsSection :label="t('settings.app-lock.section-unlock')">
      <SettingsCard>
        <SettingRow :title="t('settings.app-lock.method')" :description="systemAvailable ? undefined : systemKind ? t('settings.app-lock.system-unavailable', system) : t('settings.app-lock.pin-only')">
          <template #control>
            <select
              class="al-select"
              data-testid="app-lock-method"
              :value="systemAvailable ? settings.unlockMethod : 'pin'"
              :disabled="!systemAvailable"
              @change="update({ unlockMethod: ($event.target as HTMLSelectElement).value as AppLockSettings['unlockMethod'] })"
            >
              <option value="system">{{ t('settings.app-lock.method-system', system) }}</option>
              <option value="pin">{{ t('settings.app-lock.method-pin') }}</option>
            </select>
          </template>
        </SettingRow>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection :label="t('settings.app-lock.section-auto')">
      <SettingsCard>
        <SettingRow :title="t('settings.app-lock.idle')" :description="t('settings.app-lock.idle-hint')">
          <template #control>
            <select
              class="al-select"
              data-testid="app-lock-idle"
              :value="settings.idleMinutes"
              @change="update({ idleMinutes: Number(($event.target as HTMLSelectElement).value) })"
            >
              <option v-for="m in APP_LOCK_IDLE_CHOICES" :key="m" :value="m">{{ idleLabel(m) }}</option>
            </select>
          </template>
        </SettingRow>
        <SettingRow :title="t('settings.app-lock.on-screen-lock')">
          <template #control>
            <ToggleSwitch data-testid="app-lock-on-screen-lock" :model-value="settings.lockOnScreenLock" :aria-label="t('settings.app-lock.on-screen-lock')" @update:model-value="(v) => update({ lockOnScreenLock: v })" />
          </template>
        </SettingRow>
        <SettingRow :title="t('settings.app-lock.on-suspend')">
          <template #control>
            <ToggleSwitch data-testid="app-lock-on-suspend" :model-value="settings.lockOnSuspend" :aria-label="t('settings.app-lock.on-suspend')" @update:model-value="(v) => update({ lockOnSuspend: v })" />
          </template>
        </SettingRow>
        <SettingRow :title="t('settings.app-lock.on-start')">
          <template #control>
            <ToggleSwitch data-testid="app-lock-on-start" :model-value="settings.lockOnStart" :aria-label="t('settings.app-lock.on-start')" @update:model-value="(v) => update({ lockOnStart: v })" />
          </template>
        </SettingRow>
      </SettingsCard>
    </SettingsSection>

    <SettingsSection :label="t('settings.app-lock.section-forgot')">
      <SettingsCard>
        <SettingRow
          v-if="systemAvailable && hasPin"
          :title="t('settings.app-lock.reset-with-system', system)"
          :description="t('settings.app-lock.forgot-system', system)"
        >
          <template #control>
            <button type="button" class="al-btn ghost" data-testid="app-lock-reset-pin" @click="openForm('reset')">{{ t('settings.app-lock.reset-with-system', system) }}</button>
          </template>
        </SettingRow>
        <SettingRow v-else :title="systemKind ? t('settings.app-lock.forgot-manual-title', system) : t('settings.app-lock.forgot-manual-title-pin-only')" :description="t('settings.app-lock.forgot-manual')" />
      </SettingsCard>
    </SettingsSection>
  </div>
</template>

<style scoped>
.app-lock > .settings-notice { margin-bottom: var(--space-group); }
.al-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.al-btn {
  border-radius: 5px;
  font-size: var(--font-xs);
  padding: 5px 10px;
  cursor: pointer;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-primary);
  white-space: nowrap;
}
.al-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.al-btn.primary { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: var(--text-on-emphasis); }
.al-btn.primary:hover:not(:disabled) { background: var(--accent-fg); border-color: var(--accent-fg); }
.al-btn.primary:disabled { opacity: 1; background: transparent; border-color: var(--border-default); color: var(--text-secondary); }
.al-btn.ghost { color: var(--text-secondary); }
.al-btn.ghost:hover:not(:disabled) { border-color: var(--border-strong); color: var(--text-primary); }
.al-select,
.al-form input {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-xs);
  padding: 4px 8px;
  max-width: 100%;
}
.al-select:hover,
.al-form input:hover { border-color: var(--border-strong); }
.al-select:focus,
.al-form input:focus { border-color: var(--accent-focus); }
.al-select:focus:not(:focus-visible),
.al-form input:focus:not(:focus-visible) { outline: none; }
.al-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--space-row-y) var(--space-row-x);
}
.al-form label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; font-size: var(--font-row-desc); color: var(--text-secondary); }
.al-form label span { min-width: 120px; }
.al-form input { width: 160px; letter-spacing: 0.15em; }
.al-hint, .al-error { margin: 8px 0 0; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.5; }
.al-form .al-hint { margin: 0; }
.al-error { color: var(--danger-fg); overflow-wrap: anywhere; }
</style>
