import { ref } from 'vue'
import { detectUiLocale, i18n, isAvailableUiLocale, type AvailableUiLocale } from '@navide/plugin-ui/foundation'
import { onSettingsChanged, settingsGet, settingsReadiness, settingsSet } from '@navide/plugin-ui/shared'
import { isLinux, isWindows } from '../../../shared/osplat'

const LANGUAGE_KEY = 'agent-team:language'
// Only locales with a registered catalog are accepted, so a recognized code
// that has no translations yet never switches the UI to an empty catalog.
function parseSupportedLocale(raw: unknown): AvailableUiLocale | null {
  if (typeof raw !== 'string') return null
  const candidate = raw.trim()
  if (isAvailableUiLocale(candidate)) return candidate
  try {
    const decoded = JSON.parse(candidate)
    return isAvailableUiLocale(decoded) ? decoded : null
  } catch {
    return null
  }
}

function readLocal(): AvailableUiLocale | null {
  const v = settingsGet<unknown>(LANGUAGE_KEY, null)
  return parseSupportedLocale(v)
}

function writeLocal(value: string): void {
  settingsSet(LANGUAGE_KEY, value)
}

// Module-level singleton — shared across every component that calls useSettings().
const initialLocale = readLocal() ?? (i18n.global.locale.value as string)
const language = ref<string>(initialLocale)
if (isAvailableUiLocale(initialLocale) && i18n.global.locale.value !== initialLocale) {
  i18n.global.locale.value = initialLocale
}

let unwatchSettings: (() => void) | null = null

export function ensureLanguageSettingsSubscription(): void {
  unwatchSettings?.()
  unwatchSettings = onSettingsChanged((keys) => {
    if (keys.includes(LANGUAGE_KEY)) {
      const next = readLocal()
      if (next && next !== language.value) {
        language.value = next
        i18n.global.locale.value = next
      }
    }
  })
}
ensureLanguageSettingsSubscription()

function loadLanguage(backendFallback?: { language?: string }): void {
  const local = readLocal()
  if (local) {
    language.value = local
    i18n.global.locale.value = local
    return
  }
  const backend = backendFallback?.language ? parseSupportedLocale(backendFallback.language) : null
  const next = backend ?? detectUiLocale(navigator.language)
  language.value = next
  i18n.global.locale.value = next
  // Promote the workspace's dormant backup only once the settings store is
  // authoritative. Before the snapshot lands, readLocal() returns null for a
  // preference the user does have, and this write would bury it — permanently,
  // since a pending key also wins the reconcile that would otherwise fix it.
  if (backend && settingsReadiness.status === 'ready') writeLocal(next)
}

function setLanguage(locale: string, options: { broadcast?: boolean } = {}): void {
  const validated = parseSupportedLocale(locale)
  if (!validated) return
  const changed = language.value !== validated || i18n.global.locale.value !== validated
  language.value = validated
  i18n.global.locale.value = validated
  writeLocal(validated)
  if (options.broadcast !== false && changed) {
    window.agentTeam?.broadcastLanguageChange?.(validated)
  }
}

// Health-check timeout (seconds): how long the main process waits for the
// backend's /health endpoint before giving up on startup/restart. Persisted
// in a main-owned file (not localStorage) because main needs the value before
// any renderer window exists — see src/main/health-timeout.ts.
export const DEFAULT_HEALTH_CHECK_TIMEOUT_SEC = 45
export const MIN_HEALTH_CHECK_TIMEOUT_SEC = 15
export const MAX_HEALTH_CHECK_TIMEOUT_SEC = 120
// Mirrors src/main/health-timeout.ts: the first launch on Linux (AppImage) and
// Windows (fresh install, Defender scanning the unpacked backend) needs more.
export const EXTENDED_DEFAULT_HEALTH_CHECK_TIMEOUT_SEC = 120

export function defaultHealthCheckTimeoutSec(): number {
  return isLinux() || isWindows() ? EXTENDED_DEFAULT_HEALTH_CHECK_TIMEOUT_SEC : DEFAULT_HEALTH_CHECK_TIMEOUT_SEC
}

function clampHealthCheckTimeoutSec(raw: number): number {
  if (!Number.isFinite(raw)) return defaultHealthCheckTimeoutSec()
  return Math.min(MAX_HEALTH_CHECK_TIMEOUT_SEC, Math.max(MIN_HEALTH_CHECK_TIMEOUT_SEC, Math.round(raw)))
}

const healthCheckTimeoutSec = ref<number>(defaultHealthCheckTimeoutSec())

async function loadHealthCheckTimeoutSec(): Promise<void> {
  try {
    const result = await window.agentTeam?.readHealthCheckTimeout?.()
    if (result?.ok && typeof result.timeoutSec === 'number') {
      healthCheckTimeoutSec.value = clampHealthCheckTimeoutSec(result.timeoutSec)
    }
  } catch {
    // IPC unavailable — keep default
  }
}

function setHealthCheckTimeoutSec(sec: number): void {
  const clamped = clampHealthCheckTimeoutSec(sec)
  healthCheckTimeoutSec.value = clamped
  void window.agentTeam?.writeHealthCheckTimeout?.(clamped)
}

async function syncToBackend(
  sender: (type: string, payload: Record<string, unknown>) => Promise<unknown>,
  workspacePath: string,
): Promise<void> {
  if (!workspacePath) return
  try {
    await sender('project.set_language', {
      workspace_path: workspacePath,
      language: language.value,
    })
  } catch {
    // backup only — ignore failures
  }
}

export function useSettings() {
  const local = readLocal()
  if (local && language.value !== local) {
    language.value = local
    i18n.global.locale.value = local
  }
  return {
    language,
    loadLanguage,
    setLanguage,
    syncToBackend,
    healthCheckTimeoutSec,
    loadHealthCheckTimeoutSec,
    setHealthCheckTimeoutSec,
  }
}
