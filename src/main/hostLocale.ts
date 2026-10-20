import {
  UI_LOCALES,
  isUiLocale,
  normalizeSystemLocale as normalizeUiSystemLocale,
  type UiLocale,
} from '../../packages/plugin-ui/src/foundation/i18n/uiLocales'

// Main has no catalogs of its own; each main-process string table falls back
// to en-US for a locale it has no entry for.
export type SupportedLocale = UiLocale
export const SUPPORTED_LOCALES: readonly SupportedLocale[] = UI_LOCALES

export function normalizeSystemLocale(rawLocale: string | null | undefined): SupportedLocale {
  return normalizeUiSystemLocale(rawLocale)
}

/**
 * A main-process string table: the three translated locales are required,
 * every other UI locale is optional until its translation lands. Read it
 * through hostStrings() so a missing locale falls back to en-US.
 */
export type HostStringTable<T> = Record<'en-US' | 'zh-TW' | 'ja-JP', T> & Partial<Record<SupportedLocale, T>>

export function hostStrings<T>(table: HostStringTable<T>, locale: string): T {
  return (table as Partial<Record<string, T>>)[locale] ?? table['en-US']
}

export function validateSupportedLocale(value: unknown): SupportedLocale | null {
  return isUiLocale(value) ? value : null
}

export function readPersistedLocaleFromSettings(
  settings: Record<string, unknown> | null | undefined,
): SupportedLocale | null {
  if (!settings || typeof settings !== 'object') return null
  const raw = settings['agent-team:language']
  if (typeof raw !== 'string') return null
  const candidate = raw.trim()
  const validated = validateSupportedLocale(candidate)
  if (validated) return validated
  try {
    const decoded = JSON.parse(candidate)
    return validateSupportedLocale(decoded)
  } catch {
    return null
  }
}

export interface ResolveInitialHostLocaleInputs {
  persistedSetting?: unknown
  systemLocale?: string | null
}

export function resolveInitialHostLocale(inputs: ResolveInitialHostLocaleInputs): SupportedLocale {
  const persisted = validateSupportedLocale(inputs.persistedSetting)
  if (persisted) return persisted
  return normalizeSystemLocale(inputs.systemLocale)
}

export class HostLocaleManager {
  private runtimeLocale: SupportedLocale | null = null

  constructor(
    private readonly readPersistedLocale: () => unknown,
    private readonly getSystemLocale: () => string | null | undefined,
  ) {}

  getLocale(): SupportedLocale {
    if (this.runtimeLocale) return this.runtimeLocale
    return resolveInitialHostLocale({
      persistedSetting: this.readPersistedLocale(),
      systemLocale: this.getSystemLocale(),
    })
  }

  setRuntimeLocale(locale: unknown): SupportedLocale | null {
    const validated = validateSupportedLocale(locale)
    if (validated) {
      this.runtimeLocale = validated
      return validated
    }
    return null
  }
}
