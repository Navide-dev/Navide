// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import enUS from './locales/en-US.json'
import jaJP from './locales/ja-JP.json'
import zhTW from './locales/zh-TW.json'
import { defaults, KeyResolver } from '@navide/plugin-ui/shared'
import {
  activeTabId,
  cycleDirection,
  DISCARD_AFTER_MS,
  groupSpaces,
  keptPages,
  mayDiscard,
  normalizeAddress,
  orderTabs,
  parseLayoutMode,
  parseViews,
  pendingCount,
  showsAgentScriptWarning,
  sortSpaces,
  spaceUploads,
  tileGrid,
  type WebViewInfo,
} from './spaces'
import manifest from '../manifest.json'


function view(overrides: Partial<WebViewInfo>): WebViewInfo {
  return {
    viewId: 'v', space: 's', owner: 'agent', control: 'agent', state: 'idle',
    url: 'https://example.com/', title: '', loading: false, attached: false, agentScriptSinceLoad: false, ...overrides,
  }
}

describe('parseViews', () => {
  it('keeps well-formed views and drops the rest', () => {
    const parsed = parseViews([
      view({ viewId: 'a', note: 'Sign In' }),
      { viewId: 'b', owner: 'admin', control: 'agent', state: 'idle' },
      { viewId: '', owner: 'agent', control: 'agent', state: 'idle' },
      'nope',
    ])
    expect(parsed.map((item) => item.viewId)).toEqual(['a'])
    expect(parsed[0].note).toBe('Sign In')
  })

  it('answers an empty list for anything that is not an array', () => {
    expect(parseViews(undefined)).toEqual([])
    expect(parseViews({ views: [] })).toEqual([])
  })
})

describe('agent script warning', () => {
  it('shows only while the user controls a page the agent ran script in, until the user keeps the page', () => {
    const risky = view({ viewId: 'r', control: 'user', agentScriptSinceLoad: true })
    expect(showsAgentScriptWarning(risky, new Set())).toBe(true)
    expect(showsAgentScriptWarning(risky, new Set(['r']))).toBe(false)
    expect(showsAgentScriptWarning(view({ control: 'agent', agentScriptSinceLoad: true }), new Set())).toBe(false)
    expect(showsAgentScriptWarning(view({ control: 'user', agentScriptSinceLoad: false }), new Set())).toBe(false)
    expect(showsAgentScriptWarning(null, new Set())).toBe(false)
  })

  it('reads the flag from the Host and forgets a kept page once it loads a new document', () => {
    expect(parseViews([view({ viewId: 'a', agentScriptSinceLoad: true })])[0].agentScriptSinceLoad).toBe(true)
    expect(parseViews([{ viewId: 'b', owner: 'agent', control: 'agent', state: 'idle' }])[0].agentScriptSinceLoad).toBe(false)
    const kept = keptPages([view({ viewId: 'a', agentScriptSinceLoad: true }), view({ viewId: 'b' })], new Set(['a', 'b', 'gone']))
    expect([...kept]).toEqual(['a'])
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
    expect(zhTW.browser['agent-script']).toEqual({
      warning: 'agent 的腳本可能仍在這個頁面執行，輸入密碼或驗證碼前請先重新載入。',
      reload: '重新載入',
      keep: '保留頁面',
    })
    expect(zhTW.browser.action['delegate-note']).toBe('任何 pane、任何工作區的 agent 都能使用')
    // How many Spaces are open, each one a web page using memory (no cap).
    expect(enUS.browser.overview['open-count']).toBe('{count} open, each using memory')
    expect(zhTW.browser.overview['open-count']).toBe('{count} 個開著，每個都會占用記憶體')
    expect(jaJP.browser.overview['open-count']).toBe('{count} 件を開いています（それぞれメモリを使います）')
  })

  it('name the product Navide Browser and never the reference product', () => {
    expect(enUS.browser.app.title).toBe('Navide Browser')
    expect(zhTW.browser.app.title).toBe('Navide 瀏覽器')
    for (const locale of [enUS, zhTW, jaJP]) {
      expect(JSON.stringify(locale)).not.toMatch(/ego/i)
    }
  })
})

describe('tabs and Spaces (0.2.35)', () => {
  it('parses the dialog, uploads and opener the Host reports', () => {
    const [parsed] = parseViews([view({
      viewId: 'p',
      openerViewId: 'o',
      dialog: { type: 'confirm', message: 'Leave?' },
      uploads: [{ file: '.env', origin: 'https://a.example', sensitive: true, at: '2026-10-30T01:00:00.000Z' }, { file: '' } as never],
    })])
    expect(parsed.openerViewId).toBe('o')
    expect(parsed.dialog).toEqual({ type: 'confirm', message: 'Leave?' })
    expect(parsed.uploads).toEqual([{ file: '.env', origin: 'https://a.example', sensitive: true, at: '2026-10-30T01:00:00.000Z' }])
    const [plain] = parseViews([{ ...view({ viewId: 'q' }), dialog: { type: 'bogus' }, uploads: 'x' }])
    expect(plain.dialog).toBeUndefined()
    expect(plain.uploads).toBeUndefined()
  })

  it('puts each popup right after its opener', () => {
    const ordered = orderTabs([
      view({ viewId: 'a' }), view({ viewId: 'b' }), view({ viewId: 'a1', openerViewId: 'a' }),
      view({ viewId: 'a2', openerViewId: 'a' }), view({ viewId: 'a1x', openerViewId: 'a1' }), view({ viewId: 'lost', openerViewId: 'gone' }),
    ])
    expect(ordered.map((tab) => tab.viewId)).toEqual(['a', 'a1', 'a1x', 'a2', 'b', 'lost'])
  })

  it('keeps tabs of an opener cycle instead of losing them', () => {
    const ordered = orderTabs([view({ viewId: 'x', openerViewId: 'y' }), view({ viewId: 'y', openerViewId: 'x' })])
    expect(ordered.map((tab) => tab.viewId).sort()).toEqual(['x', 'y'])
  })

  it('groups tabs by Space name, user Spaces first, then by the most urgent tab', () => {
    const spaces = groupSpaces([
      view({ viewId: '1', space: 'pane-a', state: 'done' }),
      view({ viewId: '2', space: 'pane-b', state: 'running' }),
      view({ viewId: '3', space: 'pane-a', state: 'need-action', control: 'user' }),
      view({ viewId: '4', space: 'Mine', owner: 'user', control: 'user' }),
    ], [{ id: 'd1', space: 'pane-c', owner: 'agent', url: 'https://c.example/', title: 'C', thumbnail: null }])
    expect(spaces.map((space) => [space.name, space.state, space.tabs.map((tab) => tab.viewId)])).toEqual([
      ['Mine', 'idle', ['4']],
      ['pane-a', 'need-action', ['1', '3']],
      ['pane-b', 'running', ['2']],
      ['pane-c', 'idle', []],
    ])
    expect(spaces[3].discarded.map((tab) => tab.id)).toEqual(['d1'])
  })

  it('shows the remembered tab while it exists, else the first', () => {
    const [space] = groupSpaces([view({ viewId: 'a' }), view({ viewId: 'b' })], [
      { id: 'gone', space: 's', owner: 'agent', url: '', title: '', thumbnail: null },
    ])
    expect(activeTabId(space, 'b')).toBe('b')
    expect(activeTabId(space, 'gone')).toBe('gone')
    expect(activeTabId(space, 'closed')).toBe('a')
    expect(activeTabId(space, undefined)).toBe('a')
  })

  it('lays out up to nine tiles in the most square grid', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 9, 12].map((count) => tileGrid(count))).toEqual([
      { cols: 1, rows: 1 }, { cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 2, rows: 2 }, { cols: 3, rows: 2 },
      { cols: 3, rows: 2 }, { cols: 3, rows: 3 }, { cols: 3, rows: 3 }, { cols: 3, rows: 3 },
    ])
  })

  it('discards only a tab out of sight for ten minutes that is not waiting, working or showing a dialog', () => {
    const later = DISCARD_AFTER_MS
    expect(mayDiscard(view({ owner: 'user', control: 'user' }), 0, later, false)).toBe(true)
    expect(mayDiscard(view({ owner: 'user', control: 'user' }), 0, later - 1, false)).toBe(false)
    expect(mayDiscard(view({ owner: 'user', control: 'user' }), 0, later, true)).toBe(false)
    expect(mayDiscard(view({ owner: 'user', control: 'user' }), undefined, later, false)).toBe(false)
    expect(mayDiscard(view({ owner: 'user', control: 'user', dialog: { type: 'alert', message: '' } }), 0, later, false)).toBe(false)
    expect(mayDiscard(view({ state: 'done' }), 0, later, false)).toBe(true)
    expect(mayDiscard(view({ state: 'idle' }), 0, later, false)).toBe(true)
    expect(mayDiscard(view({ state: 'running' }), 0, later, false)).toBe(false)
    expect(mayDiscard(view({ state: 'need-action', control: 'user' }), 0, later, false)).toBe(false)
  })

  it('lists every upload of a Space, newest first', () => {
    const [space] = groupSpaces([
      view({ viewId: 'a', uploads: [{ file: 'a.txt', origin: 'https://x', sensitive: false, at: '2026-10-30T01:00:00Z' }] }),
      view({ viewId: 'b', uploads: [{ file: 'id_rsa', origin: 'https://y', sensitive: true, at: '2026-10-30T02:00:00Z' }] }),
    ])
    expect(spaceUploads(space).map((upload) => [upload.file, upload.viewId, upload.sensitive])).toEqual([
      ['id_rsa', 'b', true], ['a.txt', 'a', false],
    ])
  })

  it('cycles Spaces with the chords Navide uses for panes', () => {
    const resolver = new KeyResolver(defaults.filter((rule) => cycleDirection(rule.command) !== 0))
    const key = (shiftKey: boolean) => new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey })
    expect(cycleDirection(resolver.resolve(key(false), { paneStage: true, modalOpen: false })?.command)).toBe(1)
    expect(cycleDirection(resolver.resolve(key(true), { paneStage: true, modalOpen: false })?.command)).toBe(-1)
    expect(cycleDirection('workbench.action.openSettings')).toBe(0)
  })

  it('remembers the layout mode, tiled unless switch was chosen', () => {
    expect(parseLayoutMode('switch')).toBe('switch')
    expect(parseLayoutMode('tiled')).toBe('tiled')
    expect(parseLayoutMode(42)).toBe('tiled')
  })
})

describe('manifest agent tools', () => {
  it('keep the first eight tools and add eight more (the contract check is backend/tests/test_navide_browser_tabs_tools.py)', () => {
    const names = manifest.backend.agentTools.map((tool) => tool.name)
    expect(names.slice(0, 8)).toEqual([
      'browser_list', 'browser_open', 'browser_snapshot', 'browser_act', 'browser_screenshot', 'browser_handoff',
      'browser_wait_for_control', 'browser_finish',
    ])
    expect(names.slice(8)).toEqual([
      'browser_close', 'browser_tabs', 'browser_evaluate', 'browser_wait', 'browser_dialog', 'browser_upload',
      'browser_take_over', 'browser_cdp',
    ])
    expect(manifest.backend.methods).toEqual(manifest.backend.agentTools.map((tool) => tool.method))
  })
})
