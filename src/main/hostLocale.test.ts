import { describe, expect, it } from 'vitest'
import {
  HostLocaleManager,
  normalizeSystemLocale,
  readPersistedLocaleFromSettings,
  resolveInitialHostLocale,
  validateSupportedLocale,
} from './hostLocale'

describe('Host locale resolution', () => {
  it('validates supported interface locales', () => {
    expect(validateSupportedLocale('en-US')).toBe('en-US')
    expect(validateSupportedLocale('zh-TW')).toBe('zh-TW')
    expect(validateSupportedLocale('ja-JP')).toBe('ja-JP')
    expect(validateSupportedLocale('zh-CN')).toBe('zh-CN')
    expect(validateSupportedLocale('fr-FR')).toBe('fr-FR')
    expect(validateSupportedLocale('it-IT')).toBeNull()
    expect(validateSupportedLocale('zh')).toBeNull()
    expect(validateSupportedLocale('')).toBeNull()
    expect(validateSupportedLocale(null)).toBeNull()
    expect(validateSupportedLocale(123)).toBeNull()
  })

  it('normalizes system locale strings matching foundation and useSettings semantics', () => {
    expect(normalizeSystemLocale('zh-TW')).toBe('zh-TW')
    expect(normalizeSystemLocale('zh-HK')).toBe('zh-TW')
    expect(normalizeSystemLocale('zh-Hant-TW')).toBe('zh-TW')
    expect(normalizeSystemLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeSystemLocale('zh-Hans')).toBe('zh-CN')
    expect(normalizeSystemLocale('zh-SG')).toBe('zh-CN')
    expect(normalizeSystemLocale('zh')).toBe('zh-CN')

    expect(normalizeSystemLocale('en-US')).toBe('en-US')
    expect(normalizeSystemLocale('en-GB')).toBe('en-US')
    expect(normalizeSystemLocale('en')).toBe('en-US')

    expect(normalizeSystemLocale('ja-JP')).toBe('ja-JP')
    expect(normalizeSystemLocale('ja')).toBe('ja-JP')
    expect(normalizeSystemLocale(' JA-jp ')).toBe('ja-JP')

    expect(normalizeSystemLocale('fr-CA')).toBe('fr-FR')
    expect(normalizeSystemLocale('pt-PT')).toBe('pt-BR')
    expect(normalizeSystemLocale('es-419')).toBe('es-ES')

    // Unrecognized system locales fall back to en-US
    expect(normalizeSystemLocale('it-IT')).toBe('en-US')
    expect(normalizeSystemLocale('')).toBe('en-US')
    expect(normalizeSystemLocale(null)).toBe('en-US')
    expect(normalizeSystemLocale(undefined)).toBe('en-US')
  })

  it.each(['ja-JP', '"ja-JP"'])('retains persisted Japanese %s across restart and runtime updates', (raw) => {
    const persisted = readPersistedLocaleFromSettings({ 'agent-team:language': raw })
    const manager = new HostLocaleManager(() => persisted, () => 'en-US')
    expect(manager.getLocale()).toBe('ja-JP')
    expect(manager.setRuntimeLocale('en-US')).toBe('en-US')
    expect(manager.setRuntimeLocale('ja-JP')).toBe('ja-JP')
    expect(manager.setRuntimeLocale('it-IT')).toBeNull()
    expect(manager.getLocale()).toBe('ja-JP')
  })

  it('prioritizes valid persisted settings over system locale', () => {
    expect(resolveInitialHostLocale({
      persistedSetting: 'en-US',
      systemLocale: 'zh-TW',
    })).toBe('en-US')

    expect(resolveInitialHostLocale({
      persistedSetting: 'zh-TW',
      systemLocale: 'en-US',
    })).toBe('zh-TW')

    // Invalid or missing persisted setting falls back to system locale
    expect(resolveInitialHostLocale({
      persistedSetting: 'invalid',
      systemLocale: 'en-US',
    })).toBe('en-US')

    expect(resolveInitialHostLocale({
      persistedSetting: null,
      systemLocale: 'zh-TW',
    })).toBe('zh-TW')

    expect(resolveInitialHostLocale({
      persistedSetting: null,
      systemLocale: 'it-IT',
    })).toBe('en-US')
  })

  it('HostLocaleManager caches validated runtime locale upon language IPC and ignores invalid', () => {
    let persistedValue: unknown = null
    let systemLocale = 'en-US'

    const manager = new HostLocaleManager(
      () => persistedValue,
      () => systemLocale,
    )

    // Initial read resolves system locale because persisted is null
    expect(manager.getLocale()).toBe('en-US')

    // Runtime update to zh-TW caches in-memory immediately
    const updated = manager.setRuntimeLocale('zh-TW')
    expect(updated).toBe('zh-TW')
    expect(manager.getLocale()).toBe('zh-TW')

    // Subsequent read ignores stale persisted value because runtimeLocale is active
    persistedValue = 'en-US'
    expect(manager.getLocale()).toBe('zh-TW')

    // Invalid runtime update is rejected and preserves previous valid runtime locale
    const rejected = manager.setRuntimeLocale('it-IT')
    expect(rejected).toBeNull()
    expect(manager.getLocale()).toBe('zh-TW')

    // Valid update back to en-US
    expect(manager.setRuntimeLocale('en-US')).toBe('en-US')
    expect(manager.getLocale()).toBe('en-US')
  })

  it('reads raw and legacy JSON-encoded persisted locale from ui_settings map', () => {
    // Raw string settings
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': 'zh-TW' })).toBe('zh-TW')
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': 'en-US' })).toBe('en-US')

    // Legacy JSON-encoded string settings
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '"zh-TW"' })).toBe('zh-TW')
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '"en-US"' })).toBe('en-US')

    // Whitespace handling
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '  zh-TW  ' })).toBe('zh-TW')
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '  "en-US"  ' })).toBe('en-US')

    // Invalid, malformed, or missing settings
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': 'it-IT' })).toBeNull()
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '"it-IT"' })).toBeNull()
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': '' })).toBeNull()
    expect(readPersistedLocaleFromSettings({ 'agent-team:language': 123 })).toBeNull()
    expect(readPersistedLocaleFromSettings({})).toBeNull()
    expect(readPersistedLocaleFromSettings(null)).toBeNull()
    expect(readPersistedLocaleFromSettings(undefined)).toBeNull()
  })

  it('regression: raw persisted zh-TW setting wins over en-US system locale', () => {
    const rawSettings = { 'agent-team:language': 'zh-TW' }
    const persisted = readPersistedLocaleFromSettings(rawSettings)
    expect(persisted).toBe('zh-TW')

    const initialLocale = resolveInitialHostLocale({
      persistedSetting: persisted,
      systemLocale: 'en-US',
    })
    expect(initialLocale).toBe('zh-TW')

    const manager = new HostLocaleManager(
      () => readPersistedLocaleFromSettings(rawSettings),
      () => 'en-US',
    )
    expect(manager.getLocale()).toBe('zh-TW')
  })

  it('regression: legacy JSON-encoded "zh-TW" setting wins over en-US system locale', () => {
    const jsonSettings = { 'agent-team:language': '"zh-TW"' }
    const persisted = readPersistedLocaleFromSettings(jsonSettings)
    expect(persisted).toBe('zh-TW')

    const initialLocale = resolveInitialHostLocale({
      persistedSetting: persisted,
      systemLocale: 'en-US',
    })
    expect(initialLocale).toBe('zh-TW')

    const manager = new HostLocaleManager(
      () => readPersistedLocaleFromSettings(jsonSettings),
      () => 'en-US',
    )
    expect(manager.getLocale()).toBe('zh-TW')
  })
})
