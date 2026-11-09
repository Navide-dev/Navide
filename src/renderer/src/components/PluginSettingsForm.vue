<script setup lang="ts">
// The settings a Navide plugin declares (contributes.settings), as a form in
// Settings → Navide Plugins. Values are kept in the plugin's own storage
// (scope plugin, key settings.<key>); the Host checks each one against the
// declaration before writing. Renders nothing for a plugin that declares none.
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { revealInvisibleText } from '../../../shared/pluginAgentTools'

type SettingValue = boolean | string | number
interface Setting {
  key: string
  title: string
  description?: string
  type: 'boolean' | 'string' | 'number' | 'enum'
  default: SettingValue
  options?: string[]
  minimum?: number
  maximum?: number
  maxLength?: number
}

const props = defineProps<{ pluginId: string }>()
const { t } = useI18n()

const settings = ref<Setting[]>([])
const values = ref<Record<string, SettingValue>>({})
const failed = ref<string | null>(null)

onMounted(async () => {
  const answer = await window.agentTeam?.plugins?.readSettings?.(props.pluginId).catch(() => null)
  if (!answer) return
  settings.value = answer.settings
  values.value = { ...answer.values }
})

async function save(setting: Setting, value: SettingValue): Promise<void> {
  failed.value = null
  const previous = values.value[setting.key]
  values.value = { ...values.value, [setting.key]: value }
  const ok = await window.agentTeam?.plugins?.writeSetting?.(props.pluginId, setting.key, value).catch(() => false)
  if (!ok) {
    values.value = { ...values.value, [setting.key]: previous }
    failed.value = setting.title
  }
}

function onNumber(setting: Setting, raw: string): void {
  const value = Number(raw)
  if (raw.trim() !== '' && Number.isFinite(value)) void save(setting, value)
}

const label = (setting: Setting): string => revealInvisibleText(setting.title)
</script>

<template>
  <section v-if="settings.length" class="nv-plugin-settings" :aria-label="t('settings.extensions.pluginSettings.heading')">
    <h5>{{ t('settings.extensions.pluginSettings.heading') }}</h5>
    <div v-for="setting in settings" :key="setting.key" class="nv-plugin-setting">
      <label v-if="setting.type === 'boolean'" class="nv-plugin-setting-check">
        <input
          type="checkbox"
          :checked="values[setting.key] === true"
          @change="save(setting, ($event.target as HTMLInputElement).checked)"
        />
        {{ label(setting) }}
      </label>
      <label v-else class="nv-plugin-setting-field">
        <span>{{ label(setting) }}</span>
        <select
          v-if="setting.type === 'enum'"
          :value="values[setting.key]"
          @change="save(setting, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="option in setting.options ?? []" :key="option" :value="option">{{ revealInvisibleText(option) }}</option>
        </select>
        <input
          v-else-if="setting.type === 'number'"
          type="number"
          :value="values[setting.key]"
          :min="setting.minimum"
          :max="setting.maximum"
          @change="onNumber(setting, ($event.target as HTMLInputElement).value)"
        />
        <input
          v-else
          type="text"
          :value="values[setting.key]"
          :maxlength="setting.maxLength ?? 1024"
          @change="save(setting, ($event.target as HTMLInputElement).value)"
        />
      </label>
      <p v-if="setting.description" class="nv-plugin-setting-hint">{{ revealInvisibleText(setting.description) }}</p>
      <button
        v-if="values[setting.key] !== setting.default"
        type="button"
        class="nv-btn nv-btn--sm"
        @click="save(setting, setting.default)"
      >{{ t('settings.extensions.pluginSettings.reset') }}</button>
    </div>
    <p v-if="failed" class="nv-plugin-settings-error" role="alert">
      {{ t('settings.extensions.pluginSettings.saveFailed', { title: revealInvisibleText(failed) }) }}
    </p>
  </section>
</template>

<style scoped>
.nv-plugin-settings { display: grid; gap: 8px; margin: 8px 0; }
.nv-plugin-setting { display: grid; gap: 4px; }
.nv-plugin-setting-field { display: grid; gap: 4px; }
.nv-plugin-setting-hint { margin: 0; opacity: 0.7; font-size: 12px; }
.nv-plugin-settings-error { margin: 0; color: var(--nv-danger, #d33); }
</style>
