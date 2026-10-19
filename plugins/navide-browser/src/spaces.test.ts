import { describe, expect, it } from 'vitest'
import enUS from './locales/en-US.json'
import jaJP from './locales/ja-JP.json'
import zhTW from './locales/zh-TW.json'
import { normalizeAddress, parseViews, pendingCount, sortSpaces, type WebViewInfo } from './spaces'

function view(overrides: Partial<WebViewInfo>): WebViewInfo {
  return {
    viewId: 'v', space: 's', owner: 'agent', control: 'agent', state: 'idle',
    url: 'https://example.com/', title: '', loading: false, attached: false, ...overrides,
  }
}

describe('parseViews', () => {
  it('keeps well-formed views and drops the rest', () => {
    const parsed = parseViews([
      view({ viewId: 'a', note: 'Sign in' }),
      { viewId: 'b', owner: 'admin', control: 'agent', state: 'idle' },
      { viewId: '', owner: 'agent', control: 'agent', state: 'idle' },
      'nope',
    ])
    expect(parsed.map((item) => item.viewId)).toEqual(['a'])
    expect(parsed[0].note).toBe('Sign in')
  })

  it('answers an empty list for anything that is not an array', () => {
    expect(parseViews(undefined)).toEqual([])
    expect(parseViews({ views: [] })).toEqual([])
  })
})

describe('sortSpaces', () => {
  it('pins the user Spaces first, then agents by urgency', () => {
    const sorted = sortSpaces([
      view({ viewId: 'done', state: 'done' }),
      view({ viewId: 'mine', owner: 'user', control: 'user' }),
      view({ viewId: 'running', state: 'running' }),
      view({ viewId: 'waiting', state: 'need-action', control: 'user' }),
    ])
    expect(sorted.map((item) => item.viewId)).toEqual(['mine', 'waiting', 'running', 'done'])
  })
})

describe('pendingCount', () => {
  it('counts only Spaces that need the user', () => {
    expect(pendingCount([view({ state: 'need-action' }), view({ state: 'running' }), view({ state: 'need-action' })])).toBe(2)
  })
})

describe('normalizeAddress', () => {
  it.each([
    ['example.com', 'https://example.com/'],
    ['  https://example.com/a?b=1 ', 'https://example.com/a?b=1'],
    ['http://localhost:3000', 'http://localhost:3000/'],
    ['localhost:3000/x', 'https://localhost:3000/x'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected)
  })

  it.each(['', 'javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,hi'])('refuses %s', (input) => {
    expect(normalizeAddress(input)).toBeNull()
  })
})

describe('locales', () => {
  function keys(value: unknown, prefix = ''): string[] {
    if (typeof value !== 'object' || value === null) return [prefix]
    return Object.entries(value).flatMap(([key, child]) => keys(child, prefix ? `${prefix}.${key}` : key)).sort()
  }

  it('carry the same keys in every language', () => {
    expect(keys(zhTW)).toEqual(keys(enUS))
    expect(keys(jaJP)).toEqual(keys(enUS))
  })

  it('say on first use and in settings that agents use your sign-ins, and that a reload stops agent scripts', () => {
    const identity = {
      en: 'Agents use your sign-ins in Navide Browser (they can send requests on websites for you).',
      zh: 'agent 會使用你在 Navide 瀏覽器中的登入身分（可代你在網頁上發送請求）。',
      ja: 'agent は Navide ブラウザーでのあなたのログイン情報を使います（あなたの代わりにウェブページでリクエストを送信できます）。',
    }
    const reload = {
      en: 'After you take over, agent scripts already running in a page stop only when you reload it.',
      zh: '你接手後，頁面內已經在跑的 agent 腳本要重新載入才會停止。',
      ja: '操作を引き継いだ後も、ページ内ですでに動いている agent のスクリプトは、再読み込みするまで止まりません。',
    }
    for (const [locale, key] of [[enUS, 'en'], [zhTW, 'zh'], [jaJP, 'ja']] as const) {
      expect(locale.browser.overview.empty).toContain(identity[key])
      expect(locale.browser.settings['shared-sign-in']).toContain(identity[key])
      expect(locale.browser.settings['shared-sign-in']).toContain(reload[key])
    }
    expect(zhTW.browser.action['reload-agent-scripts']).toBe('重新載入以清除 agent 腳本')
  })

  it('name the product Navide Browser and never the reference product', () => {
    expect(enUS.browser.app.title).toBe('Navide Browser')
    expect(zhTW.browser.app.title).toBe('Navide 瀏覽器')
    for (const locale of [enUS, zhTW, jaJP]) {
      expect(JSON.stringify(locale)).not.toMatch(/ego/i)
    }
  })
})
