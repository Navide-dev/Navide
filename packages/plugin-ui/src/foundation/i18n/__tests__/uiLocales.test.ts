import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import {
  BETA_UI_LOCALES,
  UI_LOCALES,
  UI_LOCALE_FALLBACK,
  UI_PLURAL_RULES,
  formatList,
  isBetaUiLocale,
  isUiLocale,
  normalizeSystemLocale,
  resolveAvailableLocale,
} from '../uiLocales'
import { AVAILABLE_UI_LOCALES, detectUiLocale, resolveAvailableUiLocale } from '..'

describe('uiLocales', () => {
  it('lists 11 locales, 8 of them beta', () => {
    expect(UI_LOCALES).toHaveLength(11)
    expect(BETA_UI_LOCALES).toHaveLength(8)
    expect(isBetaUiLocale('ko-KR')).toBe(true)
    expect(isBetaUiLocale('zh-TW')).toBe(false)
    expect(isBetaUiLocale('it-IT')).toBe(false)
  })

  it('recognizes only listed codes', () => {
    expect(isUiLocale('zh-CN')).toBe(true)
    expect(isUiLocale('vi-VN')).toBe(true)
    expect(isUiLocale('it-IT')).toBe(false)
    expect(isUiLocale('zh')).toBe(false)
    expect(isUiLocale(null)).toBe(false)
    expect(isUiLocale(42)).toBe(false)
  })

  it.each([
    ['zh-TW', 'zh-TW'],
    ['zh-Hant', 'zh-TW'],
    ['zh-Hant-TW', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-MO', 'zh-TW'],
    ['ZH_tw', 'zh-TW'],
    ['zh-CN', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-Hans-CN', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
    ['zh', 'zh-CN'],
    ['en', 'en-US'],
    ['en-GB', 'en-US'],
    ['ja', 'ja-JP'],
    ['ko-KR', 'ko-KR'],
    ['es-419', 'es-ES'],
    ['es-MX', 'es-ES'],
    ['fr-CA', 'fr-FR'],
    ['de-AT', 'de-DE'],
    ['pt-PT', 'pt-BR'],
    ['pt', 'pt-BR'],
    ['ru', 'ru-RU'],
    ['vi', 'vi-VN'],
    ['it-IT', 'en-US'],
    ['', 'en-US'],
    [null, 'en-US'],
    [undefined, 'en-US'],
  ])('normalizes system locale %s to %s', (raw, expected) => {
    expect(normalizeSystemLocale(raw)).toBe(expected)
  })

  it('resolves to en-US when the locale has no catalog', () => {
    expect(resolveAvailableLocale('ko-KR', ['en-US', 'zh-TW', 'ja-JP'])).toBe('en-US')
    expect(resolveAvailableLocale('ja-JP', ['en-US', 'zh-TW', 'ja-JP'])).toBe('ja-JP')
  })

  it('registers the translated catalogs only', () => {
    expect([...AVAILABLE_UI_LOCALES].sort()).toEqual(['en-US', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW'])
    expect(detectUiLocale('ko-KR')).toBe('ko-KR')
    expect(detectUiLocale('ko')).toBe('ko-KR')
    expect(detectUiLocale('de-DE')).toBe('en-US')
    expect(detectUiLocale('zh-Hans')).toBe('zh-CN')
    expect(detectUiLocale('zh-SG')).toBe('zh-CN')
    expect(detectUiLocale('zh-HK')).toBe('zh-TW')
    expect(resolveAvailableUiLocale('ru-RU')).toBe('en-US')
    expect(resolveAvailableUiLocale('ja-JP')).toBe('ja-JP')
    expect(resolveAvailableUiLocale('it-IT')).toBeNull()
  })

  describe('fallback chain', () => {
    const messages = {
      'en-US': { onlyEn: 'en', shared: 'en shared' },
      'zh-TW': { onlyZh: 'zh', shared: 'zh shared' },
      'ja-JP': { shared: 'ja shared' },
      'ko-KR': { shared: 'ko shared' },
    }
    const make = (locale: string) =>
      createI18n({
        legacy: false,
        locale,
        fallbackLocale: UI_LOCALE_FALLBACK,
        messages,
        missingWarn: false,
        fallbackWarn: false,
      }).global

    it('a new locale falls back to en-US', () => {
      const { t } = make('ko-KR')
      expect(t('shared')).toBe('ko shared')
      expect(t('onlyEn')).toBe('en')
    })

    it('a new locale reaches zh-TW only for a key en-US also lacks', () => {
      expect(make('ko-KR').t('onlyZh')).toBe('zh')
    })

    it('zh-CN does not fall back to zh-TW before en-US', () => {
      expect(make('zh-CN').t('shared')).toBe('en shared')
    })

    it('en-US, zh-TW and ja-JP keep the zh-TW fallback', () => {
      expect(make('ja-JP').t('onlyZh')).toBe('zh')
      expect(make('ja-JP').t('onlyEn')).toBe('onlyEn')
      expect(make('en-US').t('onlyZh')).toBe('zh')
      expect(make('zh-TW').t('onlyEn')).toBe('onlyEn')
    })
  })

  describe('plural rules', () => {
    const make = (locale: string, message: string) =>
      createI18n({
        legacy: false,
        locale,
        fallbackLocale: UI_LOCALE_FALLBACK,
        pluralRules: UI_PLURAL_RULES,
        messages: { [locale]: { files: message } },
      }).global

    it('Russian 3-form messages pick one | few | many', () => {
      const { t } = make('ru-RU', '{n} файл | {n} файла | {n} файлов')
      expect(t('files', 1)).toBe('1 файл')
      expect(t('files', 21)).toBe('21 файл')
      expect(t('files', 2)).toBe('2 файла')
      expect(t('files', 24)).toBe('24 файла')
      expect(t('files', 5)).toBe('5 файлов')
      expect(t('files', 11)).toBe('11 файлов')
      expect(t('files', 0)).toBe('0 файлов')
    })

    it('Russian 4-form messages keep a zero form first', () => {
      const { t } = make('ru-RU', 'нет | {n} файл | {n} файла | {n} файлов')
      expect(t('files', 0)).toBe('нет')
      expect(t('files', 1)).toBe('1 файл')
      expect(t('files', 3)).toBe('3 файла')
      expect(t('files', 7)).toBe('7 файлов')
    })

    it('French and Brazilian Portuguese treat 0 as singular', () => {
      expect(make('fr-FR', '{n} fichier | {n} fichiers').t('files', 0)).toBe('0 fichier')
      expect(make('fr-FR', '{n} fichier | {n} fichiers').t('files', 2)).toBe('2 fichiers')
      expect(make('pt-BR', '{n} arquivo | {n} arquivos').t('files', 0)).toBe('0 arquivo')
    })

    it('other locales keep the vue-i18n default', () => {
      expect(make('en-US', '{n} file | {n} files').t('files', 0)).toBe('0 files')
      expect(make('en-US', 'none | one | {n} files').t('files', 0)).toBe('none')
    })
  })

  it('formats lists with Intl.ListFormat', () => {
    expect(formatList(['a', 'b', 'c'], 'en-US')).toBe('a, b, and c')
    expect(formatList(['a', 'b', 'c'], 'zh-TW')).toBe('a、b和c')
    expect(formatList(['a', 'b', 'c'], 'ja-JP')).toBe('a、b、c')
    expect(formatList(['a', 'b'], 'en-US', 'disjunction')).toBe('a or b')
  })
})
