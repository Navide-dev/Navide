import { describe, expect, it } from 'vitest'

import manifest from '../helpScreenshots.json'
import { HELP_SCREENSHOT_BASE, helpScreenshotUrl, isHelpScreenshotUrl } from '../helpScreenshots'

const FAKE = {
  schemaVersion: 1,
  shots: {
    'cliAgents.menu': { 'zh-TW': '0123456789ab.png', 'en-US': 'ba9876543210.webp' },
    'bad.file': { 'zh-TW': '../../releases/latest/x.png' },
  },
}

describe('help screenshot URL scope', () => {
  it('accepts only https://dl.navide.dev/help/', () => {
    expect(HELP_SCREENSHOT_BASE).toBe('https://dl.navide.dev/help/')
    expect(isHelpScreenshotUrl('https://dl.navide.dev/help/a/zh-TW/0123456789ab.png')).toBe(true)
  })

  it.each([
    'https://dl.navide.dev/releases/latest/latest-mac.yml',
    'https://dl.navide.dev/help/../releases/latest/x.png',
    'https://dl.navide.dev/help/%2e%2e/releases/x.png',
    'https://dl.navide.dev/help%2f..%2freleases/x.png',
    'https://dl.navide.dev/helpers/x.png',
    'https://dl.navide.dev/',
    'http://dl.navide.dev/help/x.png',
    'https://evil.navide.dev/help/x.png',
    'https://dl.navide.dev.evil.com/help/x.png',
    'https://user@dl.navide.dev/help/x.png',
    'https://dl.navide.dev:8443/help/x.png',
    'https://dl.navide.dev/help/x.png?y=1',
    'file:///help/x.png',
    'not a url',
  ])('refuses %s', (url) => {
    expect(isHelpScreenshotUrl(url)).toBe(false)
  })

  it('builds a content-hashed URL per id and locale', () => {
    expect(helpScreenshotUrl('cliAgents.menu', 'zh-TW', FAKE)).toBe('https://dl.navide.dev/help/cliAgents.menu/zh-TW/0123456789ab.png')
    expect(helpScreenshotUrl('cliAgents.menu', 'en-US', FAKE)).toBe('https://dl.navide.dev/help/cliAgents.menu/en-US/ba9876543210.webp')
  })

  it('returns null for unknown figures, missing locales and malformed entries', () => {
    expect(helpScreenshotUrl('cliAgents.install', 'zh-TW', FAKE)).toBeNull()
    expect(helpScreenshotUrl('cliAgents.menu', 'ja-JP', FAKE)).toBeNull()
    expect(helpScreenshotUrl('bad.file', 'zh-TW', FAKE)).toBeNull()
    expect(helpScreenshotUrl('../releases', 'zh-TW', FAKE)).toBeNull()
  })

  it('ships a manifest whose every entry resolves inside help/', () => {
    expect(manifest.schemaVersion).toBe(1)
    for (const [id, locales] of Object.entries(manifest.shots as Record<string, Record<string, string>>)) {
      for (const locale of Object.keys(locales)) expect(helpScreenshotUrl(id, locale)).not.toBeNull()
    }
  })
})
