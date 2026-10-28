<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { voiceErrorI18nKey } from '../../composables/useVoiceInput'
import SettingsSection from './SettingsSection.vue'
import SettingsCard from './SettingsCard.vue'
import SettingRow from './SettingRow.vue'
import ToggleSwitch from './ToggleSwitch.vue'
import VoiceShortcutRow from './VoiceShortcutRow.vue'
import VoiceFnKeyRow from './VoiceFnKeyRow.vue'
import { isMacPlatform } from '@navide/plugin-ui/shared'
import { isMac, isWindows } from '../../../../shared/osplat'
import {
  readbackSupported,
  readbackVoiceModel,
  speakReadback,
  voicesForLanguage,
  type VoiceLike,
} from '../../composables/useVoiceReadback'
import {
  useVoiceSettings,
  VOICE_READBACK_RATES,
  VOICE_RECORDING_MODES,
  VOICE_SCRIPTS,
  type VoiceRecordingMode,
  type VoiceScript,
} from '../../voice/voiceSettings'
import type { useBackend } from '../../composables/useBackend'

// Settings → Voice Input. Two separate statuses: the Model (a file on disk)
// and the Engine (the sidecar process that loads it). A downloaded model says
// nothing about whether the engine is running. Both are asked for only while
// voice input is on and this section is shown: with it off this section is
// one switch and nothing is sent to the backend.

const props = defineProps<{ backend: ReturnType<typeof useBackend> }>()
defineEmits<{ 'open-shortcuts': [command: string] }>()
const { t, locale } = useI18n()
const {
  voiceInputEnabled,
  voiceReadbackEnabled,
  voiceReadbackVoice,
  voiceReadbackRate,
  voiceInputDeviceId,
  voiceInputDeviceLabel,
  voiceRecordingMode,
  voiceScript,
  setVoiceInputEnabled,
  setVoiceInputDevice,
  setVoiceRecordingMode,
  setVoiceScript,
  setVoiceReadbackEnabled,
  setVoiceReadbackVoice,
  setVoiceReadbackRate,
} = useVoiceSettings()

interface VoiceStatus {
  ok?: boolean
  sidecar?: 'ok' | 'missing'
  model?: { present?: boolean; bytes?: number; path?: string }
  gpu?: boolean | null
  running?: boolean
  starting?: boolean
  error?: string | null
}
interface Progress { bytes: number; total: number; done: boolean; error?: string }

const status = ref<VoiceStatus | null>(null)
const statusError = ref(false)
const progress = ref<Progress | null>(null)
let offProgress: (() => void) | null = null
// The engine is polled while the section is shown and voice input is on.
const ENGINE_POLL_MS = 2_000
let pollTimer: ReturnType<typeof setInterval> | null = null
/** A "Start now" / "Retry" request is in flight (the load can take a minute). */
const enginePending = ref(false)
const engineFailure = ref('')

async function refreshStatus(): Promise<void> {
  try {
    const res = await props.backend.send<VoiceStatus>('voice.status', {}, 10_000)
    status.value = res.ok ? res.payload : null
    statusError.value = !res.ok
  } catch {
    statusError.value = true
  }
}

function subscribeProgress(): void {
  if (offProgress) return
  offProgress = props.backend.on('voice.model.progress', (payload) => {
    const p = payload as Partial<Progress>
    progress.value = { bytes: p.bytes ?? 0, total: p.total ?? 0, done: p.done === true, error: p.error }
    if (p.done) void refreshStatus()
  })
}

function unsubscribeProgress(): void {
  offProgress?.()
  offProgress = null
}

function startPolling(): void {
  if (pollTimer !== null) return
  pollTimer = setInterval(() => void refreshStatus(), ENGINE_POLL_MS)
}

function stopPolling(): void {
  if (pollTimer !== null) clearInterval(pollTimer)
  pollTimer = null
}

async function startEngine(): Promise<void> {
  if (enginePending.value) return
  enginePending.value = true
  engineFailure.value = ''
  try {
    const res = await props.backend.send<{ ok?: boolean; reason?: string }>('voice.prewarm', {}, 125_000)
    // 'disabled' is voice switched off while it loaded: not a failure.
    if ((!res.ok || res.payload?.ok === false) && res.payload?.reason !== 'disabled') {
      engineFailure.value = t(voiceErrorI18nKey(`start-${res.payload?.reason ?? 'failed'}`), { code: res.payload?.reason ?? 'failed' })
    }
  } catch {
    engineFailure.value = t(voiceErrorI18nKey('backend'), { code: 'backend' })
  } finally {
    enginePending.value = false
    void refreshStatus()
  }
}

// ── Microphone device ─────────────────────────────────────────────────────────
// Listed only while voice input is on. The page never opens the mic
// (getUserMedia) to learn device names: before the first voice take the list
// may be unlabeled, and unnamed entries are numbered instead.
interface MicDevice { deviceId: string; label: string }
const devices = ref<MicDevice[]>([])
const devicesLoaded = ref(false)
let listeningDevices = false

async function refreshDevices(): Promise<void> {
  const md = navigator.mediaDevices
  if (!md?.enumerateDevices) return
  try {
    const all = await md.enumerateDevices()
    if (!voiceInputEnabled.value) return
    devices.value = all
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }))
    devicesLoaded.value = true
    rematchSavedDevice()
  } catch {
    devices.value = []
  }
}

function onDeviceChange(): void {
  void refreshDevices()
}

function listenDevices(): void {
  if (listeningDevices) return
  listeningDevices = true
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
}

function unlistenDevices(): void {
  if (!listeningDevices) return
  listeningDevices = false
  navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
}

/** A saved id from another origin (dev vs packaged) re-found by its label. */
function rematchSavedDevice(): void {
  const id = voiceInputDeviceId.value
  if (!id || devices.value.some((d) => d.deviceId === id)) return
  const label = voiceInputDeviceLabel.value
  const match = label ? devices.value.find((d) => d.label === label) : undefined
  if (match) setVoiceInputDevice(match.deviceId, match.label)
}

const savedDeviceMissing = computed(
  () => devicesLoaded.value && voiceInputDeviceId.value !== '' && !devices.value.some((d) => d.deviceId === voiceInputDeviceId.value),
)
const hasUnnamedDevice = computed(() => devices.value.some((d) => !d.label))

function deviceName(d: MicDevice, index: number): string {
  return d.label || t('settings.voice.device-unnamed', { n: index + 1 })
}

const deviceDescription = computed(() => {
  if (savedDeviceMissing.value) return t('settings.voice.device-missing-note')
  if (hasUnnamedDevice.value) return t('settings.voice.device-hint')
  return ''
})

function onSelectDevice(e: Event): void {
  const id = (e.target as HTMLSelectElement).value
  const index = devices.value.findIndex((d) => d.deviceId === id)
  setVoiceInputDevice(id, index >= 0 ? devices.value[index].label : '')
}

watch(
  voiceInputEnabled,
  (on) => {
    if (on) {
      subscribeProgress()
      void refreshStatus()
      startPolling()
      listenDevices()
      void refreshDevices()
    } else {
      unsubscribeProgress()
      stopPolling()
      unlistenDevices()
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  unsubscribeProgress()
  stopPolling()
  unlistenDevices()
})

const downloading = computed(() => progress.value !== null && !progress.value.done)

async function download(): Promise<void> {
  progress.value = { bytes: 0, total: 0, done: false }
  try {
    const res = await props.backend.send<{ ok?: boolean; reason?: string }>('voice.model.download', {}, 10_000)
    if (!res.ok || res.payload?.ok === false) {
      progress.value = { bytes: 0, total: 0, done: true, error: res.payload?.reason ?? res.error?.message ?? 'failed' }
    }
  } catch (err) {
    progress.value = { bytes: 0, total: 0, done: true, error: err instanceof Error ? err.message : String(err) }
  }
}

// Decimal megabytes, the unit the "about 148 MB" hint is written in; MiB here
// would show the same file as 141.1 MB next to it.
function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

const modelLine = computed(() => {
  if (statusError.value) return t('settings.voice.status-unavailable')
  const s = status.value
  if (!s) return t('settings.voice.status-checking')
  if (!s.model?.present) return t('settings.voice.model-missing')
  return t('settings.voice.model-ready', { size: mb(s.model.bytes ?? 0) })
})

// The engine row, from what the backend reports (voice.status) plus this
// page's own start request.
type EngineState = 'checking' | 'unavailable' | 'missing' | 'needs-model' | 'starting' | 'ready' | 'failed' | 'idle'
const engineState = computed<EngineState>(() => {
  if (statusError.value) return 'unavailable'
  const s = status.value
  if (!s) return 'checking'
  if (s.sidecar === 'missing') return 'missing'
  if (!s.model?.present) return 'needs-model'
  if (enginePending.value || s.starting) return 'starting'
  if (s.running) return 'ready'
  if (s.error || engineFailure.value) return 'failed'
  return 'idle'
})

const engineLine = computed(() => {
  const s = status.value
  switch (engineState.value) {
    case 'checking': return t('settings.voice.status-checking')
    case 'unavailable': return t('settings.voice.status-unavailable')
    case 'missing': return t('settings.voice.sidecar-missing')
    case 'needs-model': return t('settings.voice.engine-needs-model')
    case 'starting': return t('settings.voice.engine-starting')
    case 'ready': return t('settings.voice.engine-ready', { device: s?.gpu === true ? t('settings.voice.gpu-on') : t('settings.voice.gpu-off') })
    case 'failed': return t('settings.voice.engine-failed', { reason: s?.error || engineFailure.value })
    default: return t('settings.voice.engine-idle')
  }
})

const canStartEngine = computed(() => engineState.value === 'idle' || engineState.value === 'failed')

const progressLine = computed(() => {
  const p = progress.value
  if (!p) return ''
  if (p.error) return t('settings.voice.download-failed', { error: p.error })
  if (p.done) return t('settings.voice.download-done')
  if (p.total > 0) {
    return t('settings.voice.download-progress', {
      done: mb(p.bytes),
      total: mb(p.total),
      pct: Math.floor((p.bytes / p.total) * 100),
    })
  }
  return t('settings.voice.download-starting')
})

const canDownload = computed(
  () => !downloading.value && status.value?.sidecar === 'ok' && status.value?.model?.present === false,
)

// ── Read aloud ────────────────────────────────────────────────────────────────
// The platform synthesizer, so nothing is downloaded. Without one (Linux
// usually) the block is not shown. Voices are listed only while it is on.
const canReadAloud = readbackSupported()
interface VoiceOption { voiceURI: string; name: string; lang: string }
const voices = ref<VoiceOption[]>([])
/** Every installed voice, any language (the engine row counts them). */
const allVoices = ref<VoiceLike[]>([])

function refreshVoices(): void {
  const all = globalThis.speechSynthesis?.getVoices() ?? []
  allVoices.value = all.map((v) => ({ voiceURI: v.voiceURI, name: v.name, lang: v.lang, localService: v.localService }))
  voices.value = voicesForLanguage(all, String(locale.value)).map((v) => ({ voiceURI: v.voiceURI, name: v.name, lang: v.lang }))
}

// Voice model: the recommended download for the UI language (美佳 Premium for
// zh-TW). Only macOS can be sent to where voices are downloaded; an app cannot
// install one itself. Readback keeps using the best voice there is meanwhile.
const onMac = isMacPlatform()
const voiceModel = computed(() => readbackVoiceModel(allVoices.value, String(locale.value)))
const downloadHint = ref(false)

const voiceModelLine = computed(() => {
  const m = voiceModel.value
  let line = m.ready
    ? t('settings.voice.readback-model-ready', { voice: m.preferred })
    : m.using
      ? t('settings.voice.readback-model-missing', { voice: m.preferred, using: m.using.name })
      : t('settings.voice.readback-model-missing-none', { voice: m.preferred })
  if (!onMac && !m.ready) line += ` ${t('settings.voice.readback-model-other-os')}`
  else if (downloadHint.value && !m.ready) line += ` ${t('settings.voice.readback-model-download-hint', { voice: m.preferred })}`
  return line
})

async function openVoiceDownload(): Promise<void> {
  downloadHint.value = true
  await window.agentTeam?.openSpokenContentSettings?.()
}

// Where better voices come from, named per platform.
const voiceHintKey = isMac()
  ? 'settings.voice.readback-voice-hint'
  : isWindows()
    ? 'settings.voice.readback-voice-hint-windows'
    : 'settings.voice.readback-voice-hint-other-os'

function recheckVoices(): void {
  refreshVoices()
}

watch(
  [voiceReadbackEnabled, locale],
  ([on], _old, onCleanup) => {
    if (!canReadAloud || !on) return
    refreshVoices()
    // Chromium fills the list asynchronously; it is empty on the first call.
    globalThis.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices)
    onCleanup(() => globalThis.speechSynthesis?.removeEventListener?.('voiceschanged', refreshVoices))
  },
  { immediate: true },
)

const savedVoiceMissing = computed(
  () => voiceReadbackVoice.value !== '' && voices.value.length > 0 && !voices.value.some((v) => v.voiceURI === voiceReadbackVoice.value),
)

function previewReadback(): void {
  speakReadback(t('voice.readback.done', { label: 'Navide' }), {
    uiLang: String(locale.value),
    voiceURI: voiceReadbackVoice.value,
    rate: voiceReadbackRate.value,
  })
}
</script>

<template>
  <!-- No label: the page title already says Voice Input. -->
  <SettingsSection>
    <SettingsCard>
      <SettingRow
        data-settings-section="voice-input"
        :title="t('settings.voice.enabled')"
        :description="t('settings.voice.enabled-hint')"
      >
        <template #control>
          <ToggleSwitch
            :model-value="voiceInputEnabled"
            :aria-label="t('settings.voice.enabled')"
            @update:model-value="(v: boolean) => setVoiceInputEnabled(v)"
          />
        </template>
      </SettingRow>

      <VoiceShortcutRow v-if="voiceInputEnabled" @open-shortcuts="(command) => $emit('open-shortcuts', command)" />

      <VoiceFnKeyRow v-if="voiceInputEnabled" />

      <SettingRow
        v-if="voiceInputEnabled"
        data-settings-section="voice-device"
        :title="t('settings.voice.device')"
        :description="deviceDescription"
      >
        <template #control>
          <select
            class="voice-select"
            :aria-label="t('settings.voice.device')"
            :value="voiceInputDeviceId"
            @change="onSelectDevice"
          >
            <option value="">{{ t('settings.voice.device-default') }}</option>
            <option v-for="(d, i) in devices" :key="d.deviceId" :value="d.deviceId">{{ deviceName(d, i) }}</option>
            <option v-if="savedDeviceMissing" :value="voiceInputDeviceId" disabled>
              {{ voiceInputDeviceLabel || t('settings.voice.device') }} {{ t('settings.voice.device-unavailable') }}
            </option>
          </select>
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceInputEnabled"
        data-settings-section="voice-mode"
        :title="t('settings.voice.mode')"
        :description="t(`settings.voice.mode-${voiceRecordingMode}-hint`)"
      >
        <template #control>
          <select
            class="voice-select"
            :aria-label="t('settings.voice.mode')"
            :value="voiceRecordingMode"
            @change="setVoiceRecordingMode(($event.target as HTMLSelectElement).value as VoiceRecordingMode)"
          >
            <option v-for="m in VOICE_RECORDING_MODES" :key="m" :value="m">{{ t(`settings.voice.mode-${m}`) }}</option>
          </select>
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceInputEnabled"
        data-settings-section="voice-script"
        :title="t('settings.voice.script')"
        :description="t('settings.voice.script-hint')"
      >
        <template #control>
          <select
            class="voice-select"
            :aria-label="t('settings.voice.script')"
            :value="voiceScript"
            @change="setVoiceScript(($event.target as HTMLSelectElement).value as VoiceScript)"
          >
            <option v-for="s in VOICE_SCRIPTS" :key="s" :value="s">{{ t(`settings.voice.script-${s}`) }}</option>
          </select>
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceInputEnabled"
        data-settings-section="voice-model"
        :title="t('settings.voice.model')"
        :description="progressLine ? `${modelLine} — ${progressLine}` : modelLine"
      >
        <template #control>
          <progress
            v-if="downloading && progress && progress.total > 0"
            class="voice-progress"
            :value="progress.bytes"
            :max="progress.total"
          />
          <button class="voice-btn" :disabled="!canDownload" @click="download">
            {{ downloading ? t('settings.voice.downloading') : progress?.error ? t('settings.voice.download-retry') : t('settings.voice.download') }}
          </button>
          <button class="voice-btn" :disabled="downloading" @click="refreshStatus">
            {{ t('settings.voice.recheck') }}
          </button>
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceInputEnabled"
        data-settings-section="voice-engine"
        :title="t('settings.voice.engine')"
        :description="engineLine"
      >
        <template #control>
          <button v-if="canStartEngine" class="voice-btn" @click="startEngine">
            {{ engineState === 'failed' ? t('settings.voice.engine-retry') : t('settings.voice.engine-start') }}
          </button>
        </template>
      </SettingRow>
    </SettingsCard>
  </SettingsSection>

  <SettingsSection v-if="canReadAloud" :label="t('settings.voice.readback-section')">
    <SettingsCard>
      <SettingRow
        data-settings-section="voice-readback"
        :title="t('settings.voice.readback')"
        :description="t('settings.voice.readback-hint')"
      >
        <template #control>
          <ToggleSwitch
            :model-value="voiceReadbackEnabled"
            :aria-label="t('settings.voice.readback')"
            @update:model-value="(v: boolean) => setVoiceReadbackEnabled(v)"
          />
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceReadbackEnabled"
        data-settings-section="voice-readback-voice"
        :title="t('settings.voice.readback-voice')"
        :description="voices.length === 0 ? t('settings.voice.readback-voice-none') : t(voiceHintKey)"
      >
        <template #control>
          <select
            class="voice-select"
            :aria-label="t('settings.voice.readback-voice')"
            :value="voiceReadbackVoice"
            @change="setVoiceReadbackVoice(($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('settings.voice.readback-voice-auto') }}</option>
            <option v-for="v in voices" :key="v.voiceURI" :value="v.voiceURI">{{ v.name }} ({{ v.lang }})</option>
            <option v-if="savedVoiceMissing" :value="voiceReadbackVoice" disabled>
              {{ voiceReadbackVoice }} {{ t('settings.voice.device-unavailable') }}
            </option>
          </select>
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceReadbackEnabled"
        data-settings-section="voice-readback-model"
        :title="t('settings.voice.readback-model')"
        :description="voiceModelLine"
      >
        <template #control>
          <button
            v-if="onMac"
            class="voice-btn"
            data-testid="readback-model-download"
            :disabled="voiceModel.ready"
            @click="openVoiceDownload"
          >
            {{ t('settings.voice.download') }}
          </button>
          <button class="voice-btn" data-testid="readback-model-recheck" @click="recheckVoices">
            {{ t('settings.voice.recheck') }}
          </button>
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceReadbackEnabled"
        data-settings-section="voice-readback-engine"
        :title="t('settings.voice.readback-engine')"
        :description="allVoices.length > 0 ? t('settings.voice.readback-engine-ready') : t('settings.voice.readback-engine-no-voices')"
      />

      <SettingRow
        v-if="voiceReadbackEnabled"
        data-settings-section="voice-readback-rate"
        :title="t('settings.voice.readback-rate')"
      >
        <template #control>
          <select
            class="voice-select"
            :aria-label="t('settings.voice.readback-rate')"
            :value="String(voiceReadbackRate)"
            @change="setVoiceReadbackRate(Number(($event.target as HTMLSelectElement).value))"
          >
            <option v-for="r in VOICE_READBACK_RATES" :key="r" :value="String(r)">{{ r.toFixed(1) }}×</option>
          </select>
        </template>
      </SettingRow>

      <SettingRow
        v-if="voiceReadbackEnabled"
        data-settings-section="voice-readback-preview"
        :title="t('settings.voice.readback-preview')"
        :description="t('settings.voice.readback-stop-hint')"
      >
        <template #control>
          <button class="voice-btn" @click="previewReadback">▶ {{ t('voice.readback.done', { label: 'Navide' }) }}</button>
        </template>
      </SettingRow>
    </SettingsCard>
  </SettingsSection>
</template>

<style scoped>
.voice-btn {
  font-size: var(--font-2xs);
  padding: 4px 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.voice-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--accent-emphasis); }
.voice-btn:disabled { opacity: 0.5; cursor: default; }
.voice-select {
  font-size: var(--font-2xs);
  padding: 4px 8px;
  max-width: 240px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
}
.voice-progress {
  width: 120px;
  accent-color: var(--accent-emphasis);
}
</style>
