<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { useBackend } from '../../composables/useBackend'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'

/**
 * Settings → General → Session log archive. Every switch starts off and the
 * backend (session_archive.py) does nothing but read these settings until one
 * is turned on. Uploads go to the user's own bucket through the standard AWS
 * credential chain; there is no field for a key, on purpose.
 */
const props = defineProps<{
  backend: Pick<ReturnType<typeof useBackend>, 'send'>
}>()

interface ArchiveSettings {
  compress_enabled: boolean
  idle_days: number
  remove_originals: boolean
  upload_enabled: boolean
  upload_after_days: number
  s3_bucket: string
  s3_prefix: string
  s3_region: string
}

const { t } = useI18n()
const settings = ref<ArchiveSettings | null>(null)
const error = ref('')

async function call(type: string, payload: Record<string, unknown>): Promise<void> {
  error.value = ''
  try {
    const res = await props.backend.send<ArchiveSettings>(type, payload)
    if (res.ok && res.payload) settings.value = res.payload
    else error.value = res.error?.message ?? t('settings.archive.save-failed')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

function save(updates: Partial<ArchiveSettings>): Promise<void> {
  return call('archive.settings.set', updates)
}

function saveDays(key: 'idle_days' | 'upload_after_days', event: Event): void {
  const input = event.target as HTMLInputElement
  const days = Math.round(Number(input.value))
  if (!Number.isFinite(days) || days < 1) {
    input.value = String(settings.value?.[key] ?? '')
    return
  }
  void save({ [key]: days })
}

function saveText(key: 's3_bucket' | 's3_prefix' | 's3_region', event: Event): void {
  void save({ [key]: (event.target as HTMLInputElement).value.trim() })
}

onMounted(() => call('archive.settings.get', {}))
</script>

<template>
  <SettingsSection :label="t('settings.section.session-archive')" data-testid="session-archive">
    <p class="sa-hint">{{ t('settings.archive.hint') }}</p>
    <SettingsCard v-if="settings">
      <SettingRow
        data-settings-section="archive-compress"
        :title="t('settings.archive.compress')"
        :description="t('settings.archive.compress-hint')"
        fold-description
      >
        <template #control>
          <ToggleSwitch
            :model-value="settings.compress_enabled"
            :aria-label="t('settings.archive.compress')"
            data-testid="archive-compress-toggle"
            @update:model-value="(on: boolean) => save({ compress_enabled: on })"
          />
        </template>
      </SettingRow>
      <template v-if="settings.compress_enabled">
        <SettingRow data-settings-section="archive-idle-days" :title="t('settings.archive.idle-days')">
          <template #control>
            <input
              type="number"
              min="1"
              :value="settings.idle_days"
              data-testid="archive-idle-days"
              @change="saveDays('idle_days', $event)"
            />
          </template>
        </SettingRow>
        <SettingRow
          data-settings-section="archive-remove-originals"
          :title="t('settings.archive.remove-originals')"
          :description="t('settings.archive.remove-originals-hint')"
          fold-description
        >
          <template #control>
            <ToggleSwitch
              :model-value="settings.remove_originals"
              :aria-label="t('settings.archive.remove-originals')"
              data-testid="archive-remove-originals-toggle"
              @update:model-value="(on: boolean) => save({ remove_originals: on })"
            />
          </template>
        </SettingRow>
      </template>
      <SettingRow
        data-settings-section="archive-upload"
        :title="t('settings.archive.upload')"
        :description="t('settings.archive.upload-hint')"
        fold-description
      >
        <template #control>
          <ToggleSwitch
            :model-value="settings.upload_enabled"
            :aria-label="t('settings.archive.upload')"
            data-testid="archive-upload-toggle"
            @update:model-value="(on: boolean) => save({ upload_enabled: on })"
          />
        </template>
      </SettingRow>
      <template v-if="settings.upload_enabled">
        <SettingRow data-settings-section="archive-upload-after-days" :title="t('settings.archive.upload-after-days')">
          <template #control>
            <input
              type="number"
              min="1"
              :value="settings.upload_after_days"
              data-testid="archive-upload-after-days"
              @change="saveDays('upload_after_days', $event)"
            />
          </template>
        </SettingRow>
        <SettingRow data-settings-section="archive-bucket" :title="t('settings.archive.bucket')">
          <template #control>
            <input type="text" :value="settings.s3_bucket" data-testid="archive-bucket" @change="saveText('s3_bucket', $event)" />
          </template>
        </SettingRow>
        <SettingRow data-settings-section="archive-prefix" :title="t('settings.archive.prefix')">
          <template #control>
            <input type="text" :value="settings.s3_prefix" data-testid="archive-prefix" @change="saveText('s3_prefix', $event)" />
          </template>
        </SettingRow>
        <SettingRow data-settings-section="archive-region" :title="t('settings.archive.region')">
          <template #control>
            <input
              type="text"
              :value="settings.s3_region"
              :placeholder="t('settings.archive.region-placeholder')"
              data-testid="archive-region"
              @change="saveText('s3_region', $event)"
            />
          </template>
        </SettingRow>
      </template>
    </SettingsCard>
    <p v-if="error" class="sa-error" role="alert" data-testid="archive-error">{{ error }}</p>
  </SettingsSection>
</template>

<style scoped>
.sa-hint { margin: 0 0 8px; font-size: var(--font-row-desc); color: var(--text-secondary); line-height: 1.4; }
.sa-error { margin: 8px 0 0; font-size: var(--font-row-desc); color: var(--danger, var(--text-primary)); }
</style>
