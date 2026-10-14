import { ref, type Ref } from 'vue'
import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

// Voice input settings. Both default OFF: with voice input off nothing about
// the feature runs — no mic, no voice.* requests, no hotkey (its `when`
// context stays false).

/** The command the dictation shortcut runs (bound in keybindings/defaults.ts). */
export const HOLD_TO_TALK_COMMAND = 'workbench.action.holdToTalk'
export const VOICE_INPUT_ENABLED_KEY = 'agentTeam.voiceInputEnabled'
export const VOICE_READBACK_ENABLED_KEY = 'agentTeam.voiceReadbackEnabled'
// Read-aloud voice ('' = the best voice for the UI language) and speed.
export const VOICE_READBACK_VOICE_KEY = 'agentTeam.voiceReadbackVoice'
export const VOICE_READBACK_RATE_KEY = 'agentTeam.voiceReadbackRate'
export const VOICE_READBACK_RATES = [0.8, 1, 1.2, 1.5] as const
// Chosen microphone: '' is the system default. The label is saved with it
// because Chromium hashes deviceIds per origin (dev vs packaged differ), so
// the label is what lets a saved choice be found again.
export const VOICE_INPUT_DEVICE_KEY = 'agentTeam.voiceInputDeviceId'
export const VOICE_INPUT_DEVICE_LABEL_KEY = 'agentTeam.voiceInputDeviceLabel'
// How the hotkey records: 'hold-tap' = hold to talk, a quick tap locks
// hands-free until the next press; 'hold' = hold only; 'toggle' = press to
// start, press again to stop.
export const VOICE_RECORDING_MODE_KEY = 'agentTeam.voiceRecordingMode'
export const VOICE_RECORDING_MODES = ['hold-tap', 'hold', 'toggle'] as const
export type VoiceRecordingMode = (typeof VOICE_RECORDING_MODES)[number]
// Chinese script the transcript is converted to (sent with voice.start):
// 'hant-tw' = Traditional, Taiwan standard (default; whisper sometimes answers
// in Simplified); 'hans' = Simplified; 'none' = as whisper wrote it.
export const VOICE_SCRIPT_KEY = 'agentTeam.voiceChineseScript'
export const VOICE_SCRIPTS = ['hant-tw', 'hans', 'none'] as const
export type VoiceScript = (typeof VOICE_SCRIPTS)[number]
// The old "Use the fn (🌐) key" switch (macOS, default off). fn is now an
// ordinary hold-to-talk binding ('fn'); a switch left on counts as fn bound
// (voiceWiring.holdToTalkFnRules) until the Voice Input shortcut row writes
// that binding and turns the switch off. Nothing turns it on any more.
export const VOICE_FN_KEY_KEY = 'agentTeam.voiceFnKeyEnabled'

function read(key: string): boolean {
  return settingsGet<boolean>(key, false) === true
}

function readString(key: string): string {
  const v = settingsGet<unknown>(key, '')
  return typeof v === 'string' ? v : ''
}

function readMode(): VoiceRecordingMode {
  const v = settingsGet<unknown>(VOICE_RECORDING_MODE_KEY, 'hold-tap')
  return (VOICE_RECORDING_MODES as readonly unknown[]).includes(v) ? (v as VoiceRecordingMode) : 'hold-tap'
}

function readRate(): number {
  const v = settingsGet<unknown>(VOICE_READBACK_RATE_KEY, 1)
  return (VOICE_READBACK_RATES as readonly unknown[]).includes(v) ? (v as number) : 1
}

function readScript(): VoiceScript {
  const v = settingsGet<unknown>(VOICE_SCRIPT_KEY, 'hant-tw')
  return (VOICE_SCRIPTS as readonly unknown[]).includes(v) ? (v as VoiceScript) : 'hant-tw'
}

const voiceInputEnabled = ref(read(VOICE_INPUT_ENABLED_KEY))
const voiceReadbackEnabled = ref(read(VOICE_READBACK_ENABLED_KEY))
const voiceReadbackVoice = ref(readString(VOICE_READBACK_VOICE_KEY))
const voiceReadbackRate = ref(readRate())
const voiceInputDeviceId = ref(readString(VOICE_INPUT_DEVICE_KEY))
const voiceInputDeviceLabel = ref(readString(VOICE_INPUT_DEVICE_LABEL_KEY))
const voiceRecordingMode = ref<VoiceRecordingMode>(readMode())
const voiceScript = ref<VoiceScript>(readScript())
const voiceFnKeyEnabled = ref(read(VOICE_FN_KEY_KEY))

let unsubscribe: (() => void) | null = null

/** Follow writes made by another window (settings are shared app-wide). */
function ensureSubscription(): void {
  if (unsubscribe) return
  unsubscribe = onSettingsChanged((keys) => {
    if (keys.includes(VOICE_INPUT_ENABLED_KEY)) voiceInputEnabled.value = read(VOICE_INPUT_ENABLED_KEY)
    if (keys.includes(VOICE_READBACK_ENABLED_KEY)) voiceReadbackEnabled.value = read(VOICE_READBACK_ENABLED_KEY)
    if (keys.includes(VOICE_READBACK_VOICE_KEY)) voiceReadbackVoice.value = readString(VOICE_READBACK_VOICE_KEY)
    if (keys.includes(VOICE_READBACK_RATE_KEY)) voiceReadbackRate.value = readRate()
    if (keys.includes(VOICE_INPUT_DEVICE_KEY)) voiceInputDeviceId.value = readString(VOICE_INPUT_DEVICE_KEY)
    if (keys.includes(VOICE_INPUT_DEVICE_LABEL_KEY)) voiceInputDeviceLabel.value = readString(VOICE_INPUT_DEVICE_LABEL_KEY)
    if (keys.includes(VOICE_RECORDING_MODE_KEY)) voiceRecordingMode.value = readMode()
    if (keys.includes(VOICE_SCRIPT_KEY)) voiceScript.value = readScript()
    if (keys.includes(VOICE_FN_KEY_KEY)) voiceFnKeyEnabled.value = read(VOICE_FN_KEY_KEY)
  })
}

export function useVoiceSettings(): {
  voiceInputEnabled: Readonly<Ref<boolean>>
  voiceReadbackEnabled: Readonly<Ref<boolean>>
  voiceReadbackVoice: Readonly<Ref<string>>
  voiceReadbackRate: Readonly<Ref<number>>
  voiceInputDeviceId: Readonly<Ref<string>>
  voiceInputDeviceLabel: Readonly<Ref<string>>
  voiceRecordingMode: Readonly<Ref<VoiceRecordingMode>>
  voiceScript: Readonly<Ref<VoiceScript>>
  voiceFnKeyEnabled: Readonly<Ref<boolean>>
  setVoiceInputEnabled: (on: boolean) => void
  setVoiceReadbackEnabled: (on: boolean) => void
  setVoiceReadbackVoice: (voiceURI: string) => void
  setVoiceReadbackRate: (rate: number) => void
  setVoiceInputDevice: (id: string, label: string) => void
  setVoiceRecordingMode: (mode: VoiceRecordingMode) => void
  setVoiceScript: (script: VoiceScript) => void
  setVoiceFnKeyEnabled: (on: boolean) => void
} {
  ensureSubscription()
  return {
    voiceInputEnabled,
    voiceReadbackEnabled,
    voiceReadbackVoice,
    voiceReadbackRate,
    voiceInputDeviceId,
    voiceInputDeviceLabel,
    voiceRecordingMode,
    voiceScript,
    voiceFnKeyEnabled,
    setVoiceInputEnabled: (on) => {
      voiceInputEnabled.value = on
      settingsSet(VOICE_INPUT_ENABLED_KEY, on)
    },
    setVoiceReadbackEnabled: (on) => {
      voiceReadbackEnabled.value = on
      settingsSet(VOICE_READBACK_ENABLED_KEY, on)
    },
    setVoiceReadbackVoice: (voiceURI) => {
      voiceReadbackVoice.value = voiceURI
      settingsSet(VOICE_READBACK_VOICE_KEY, voiceURI)
    },
    setVoiceReadbackRate: (rate) => {
      voiceReadbackRate.value = rate
      settingsSet(VOICE_READBACK_RATE_KEY, rate)
    },
    setVoiceInputDevice: (id, label) => {
      voiceInputDeviceId.value = id
      voiceInputDeviceLabel.value = id ? label : ''
      settingsSet(VOICE_INPUT_DEVICE_KEY, id)
      settingsSet(VOICE_INPUT_DEVICE_LABEL_KEY, id ? label : '')
    },
    setVoiceRecordingMode: (mode) => {
      voiceRecordingMode.value = mode
      settingsSet(VOICE_RECORDING_MODE_KEY, mode)
    },
    setVoiceScript: (script) => {
      voiceScript.value = script
      settingsSet(VOICE_SCRIPT_KEY, script)
    },
    setVoiceFnKeyEnabled: (on) => {
      voiceFnKeyEnabled.value = on
      settingsSet(VOICE_FN_KEY_KEY, on)
    },
  }
}
