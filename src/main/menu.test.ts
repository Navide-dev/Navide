import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { normalizePlatformId, platformId, setPlatformId, type PlatformId } from '../shared/osplat'
import { setTerminalSelection, forgetTerminalSelection } from './terminal-selection-cache'

// The platform to restore after a test that switched it: whatever this file
// saw when it loaded — the host, or an injection from a vitest setup file.
// Restoring to the host instead silently undid that injection for every
// later test in the file (see src/shared/platformBaseline.test.ts).
const BASELINE = platformId()

// Shared, hoisted capture of the template passed to Menu.buildFromTemplate,
// plus the clipboard / focused-WebContents doubles Edit > Copy drives.
const h = vi.hoisted(() => ({
  template: [] as MenuItemConstructorOptions[],
  clipboardWrites: [] as string[],
  focusedWebContents: null as unknown
}))

vi.mock('electron', () => ({
  app: { name: 'Agent-Team' },
  clipboard: { writeText: (text: string) => h.clipboardWrites.push(text) },
  webContents: { getFocusedWebContents: () => h.focusedWebContents },
  Menu: {
    buildFromTemplate: (template: MenuItemConstructorOptions[]) => {
      h.template = template
      return {}
    },
    setApplicationMenu: () => {}
  }
}))

import { installApplicationMenu, type AppMenuHooks } from './menu'
import { MENU_STRINGS } from './menuStrings'
import { LEGAL_LABELS, LEGAL_ROUTES } from '../shared/legalLinks'

const clipboardWrites = h.clipboardWrites

/** Stand-in for the WebContents that currently holds focus. */
const FOCUSED_ID = 42

const focused = {
  id: FOCUSED_ID,
  selection: '',
  throws: false,
  hangs: false,
  copyCalls: 0,
  evalCalls: 0,
  isDestroyed: (): boolean => false,
  executeJavaScript: async (): Promise<string> => {
    focused.evalCalls++
    if (focused.throws) throw new Error('no such page')
    // A renderer too busy to service the eval — what a CLI pane painting hard
    // does to Copy's selection race.
    if (focused.hangs) return new Promise<string>(() => {})
    return focused.selection
  },
  copy: (): void => { focused.copyCalls++ },
  sent: [] as { channel: string, args: unknown[] }[],
  send: (channel: string, ...args: unknown[]): void => { focused.sent.push({ channel, args }) },
  reloadCalls: 0,
  reload: (): void => { focused.reloadCalls++ }
}

// The menu's shape is a platform decision (`isMac()` in menu.ts), so every
// arm is driven here with setPlatformId and asserted on every host — this
// file used to read process.platform itself and assert only the host's arm,
// so a macOS runner never saw the Linux/Windows menu and vice versa.
const NON_MAC: PlatformId[] = ['linux', 'win32']

function submenuOf(label: string): MenuItemConstructorOptions[] {
  const top = h.template.find((i) => i.label === label)
  if (!top || !Array.isArray(top.submenu)) throw new Error(`no top-level submenu labeled "${label}"`)
  return top.submenu as MenuItemConstructorOptions[]
}

function itemIn(menu: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions {
  const found = menu.find((i) => i.label === label)
  if (!found) throw new Error(`no menu item labeled "${label}"`)
  return found
}

function fire(item: MenuItemConstructorOptions): void {
  ;(item.click as unknown as (() => void) | undefined)?.()
}

function makeHooks(): AppMenuHooks & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    onOpenSettings: () => calls.push('settings'),
    onCheckUpdates: () => calls.push('check-updates'),
    onOpenWorkspace: () => calls.push('open-workspace'),
    onOpenRecent: (p) => calls.push('open-recent:' + p),
    onNewWindow: () => calls.push('new-window'),
    onOpenPipelineManager: () => calls.push('pipeline-manager'),
    onOpenResourceManager: () => calls.push('resource-manager'),
    onOpenTurnStats: () => calls.push('turn-stats'),
    onOpenTokenMonitor: () => calls.push('token-monitor'),
    onOpenAccount: () => calls.push('account'),
    onOpenRepo: () => calls.push('open-repo'),
    onReportIssue: () => calls.push('report-issue'),
    onShowShortcuts: () => calls.push('show-shortcuts'),
    onShowWhatsNew: () => calls.push('show-whats-new'),
    onShowWelcomeTour: () => calls.push('show-welcome-tour'),
    onOpenLegal: (route) => calls.push('legal:' + route)
  }
}

describe('installApplicationMenu', () => {
  let hooks: ReturnType<typeof makeHooks>
  /** Copy reports every path that ends in an unchanged clipboard. */
  let warnings: string[]

  beforeEach(() => {
    hooks = makeHooks()
    warnings = []
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
    clipboardWrites.length = 0
    focused.selection = ''
    focused.throws = false
    focused.hangs = false
    focused.copyCalls = 0
    focused.evalCalls = 0
    focused.sent.length = 0
    focused.reloadCalls = 0
    forgetTerminalSelection(FOCUSED_ID) // module state outlives a single case
    h.focusedWebContents = focused
    installOn(normalizePlatformId(process.platform))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setPlatformId(BASELINE)
  })

  /** Rebuild the menu as `platform` would see it. */
  function installOn(platform: PlatformId): void {
    setPlatformId(platform)
    installApplicationMenu(hooks, [], 'en-US')
  }

  it.each([
    ['darwin', 'Agent-Team'],
    ['linux', 'File'],
    ['win32', 'File'],
  ] as const)('on %s the %s menu has Settings… with ⌘, and Check for Updates…', (platform, top) => {
    installOn(platform)
    const menu = submenuOf(top)
    const settings = itemIn(menu, 'Settings…')
    expect(settings.accelerator).toBe('CmdOrCtrl+,')
    const updates = itemIn(menu, 'Check for Updates…')
    fire(settings)
    fire(updates)
    expect(hooks.calls).toEqual(['settings', 'check-updates'])
  })

  it('File has Open Workspace… with ⌘O that invokes its hook', () => {
    const open = itemIn(submenuOf('File'), 'Open Workspace…')
    expect(open.accelerator).toBe('CmdOrCtrl+O')
    fire(open)
    expect(hooks.calls).toEqual(['open-workspace'])
  })

  it('File has New Window with ⌘N that invokes its hook', () => {
    const nw = itemIn(submenuOf('File'), 'New Window')
    expect(nw.accelerator).toBe('CmdOrCtrl+N')
    fire(nw)
    expect(hooks.calls).toEqual(['new-window'])
  })

  it('File > Open Recent lists the recents; missing folders are disabled and clicking opens by path', () => {
    installApplicationMenu(
      hooks,
      [
        { path: '/a/one', name: 'one', exists: true },
        { path: '/b/two', name: 'two', exists: false }
      ],
      'en-US'
    )
    const openRecent = itemIn(submenuOf('File'), 'Open Recent')
    const sub = openRecent.submenu as MenuItemConstructorOptions[]
    expect(sub.map((i) => i.label)).toEqual(['one', 'two'])
    expect(itemIn(sub, 'one').enabled).toBe(true)
    expect(itemIn(sub, 'two').enabled).toBe(false)
    fire(itemIn(sub, 'one'))
    expect(hooks.calls).toEqual(['open-recent:/a/one'])
  })

  it('File > Open Recent shows a disabled placeholder when there are no recents', () => {
    installApplicationMenu(hooks, [], 'en-US')
    const sub = itemIn(submenuOf('File'), 'Open Recent').submenu as MenuItemConstructorOptions[]
    expect(sub).toHaveLength(1)
    expect(sub[0].label).toBe('No Recent Workspaces')
    expect(sub[0].enabled).toBe(false)
  })

  it('Help menu has GitHub / Report an Issue / Keyboard Shortcuts that invoke their hooks', () => {
    const help = h.template.find((i) => i.role === 'help')
    if (!help || !Array.isArray(help.submenu)) throw new Error('no Help menu with submenu')
    const menu = help.submenu as MenuItemConstructorOptions[]
    fire(itemIn(menu, 'Navide on GitHub'))
    fire(itemIn(menu, 'Report an Issue…'))
    fire(itemIn(menu, 'Keyboard Shortcuts'))
    expect(hooks.calls).toEqual(['open-repo', 'report-issue', 'show-shortcuts'])
  })

  it("Help menu has What's New… after Keyboard Shortcuts, wired to its hook", () => {
    const help = h.template.find((i) => i.role === 'help')
    if (!help || !Array.isArray(help.submenu)) throw new Error('no Help menu with submenu')
    const menu = help.submenu as MenuItemConstructorOptions[]
    const labels = menu.map((i) => i.label)
    expect(labels.indexOf('What\u2019s New…')).toBe(labels.indexOf('Keyboard Shortcuts') + 1)
    fire(itemIn(menu, 'What\u2019s New…'))
    expect(hooks.calls).toEqual(['show-whats-new'])
  })

  it('Help menu has First-Run Tour… after What\u2019s New…, wired to its hook', () => {
    const help = h.template.find((i) => i.role === 'help')
    if (!help || !Array.isArray(help.submenu)) throw new Error('no Help menu with submenu')
    const menu = help.submenu as MenuItemConstructorOptions[]
    const labels = menu.map((i) => i.label)
    expect(labels.indexOf('First-Run Tour…')).toBe(labels.indexOf('What\u2019s New…') + 1)
    fire(itemIn(menu, 'First-Run Tour…'))
    expect(hooks.calls).toEqual(['show-welcome-tour'])
  })

  it('Help menu lists every legal page, in table order, each passing its route to the hook', () => {
    const help = h.template.find((i) => i.role === 'help')
    if (!help || !Array.isArray(help.submenu)) throw new Error('no Help menu with submenu')
    const menu = help.submenu as MenuItemConstructorOptions[]
    for (const route of LEGAL_ROUTES) fire(itemIn(menu, LEGAL_LABELS[route]))
    expect(hooks.calls).toEqual(LEGAL_ROUTES.map((r) => 'legal:' + r))
    // The legal block sits after its own separator, below Keyboard Shortcuts.
    const labels = menu.map((i) => i.label ?? (i.type === 'separator' ? '—' : '?'))
    expect(labels.indexOf('Keyboard Shortcuts')).toBeLessThan(labels.indexOf('Privacy'))
    expect(labels[labels.indexOf('Privacy') - 1]).toBe('—')
  })

  it('Window has Pipeline Manager wired to its hook', () => {
    const item = itemIn(submenuOf('Window'), 'Pipeline Manager')
    fire(item)
    expect(hooks.calls).toEqual(['pipeline-manager'])
  })

  it('Window has Resource Manager wired to its hook', () => {
    fire(itemIn(submenuOf('Window'), 'Resource Manager'))
    expect(hooks.calls).toEqual(['resource-manager'])
  })

  it('Window has Turn Stats wired to its hook', () => {
    fire(itemIn(submenuOf('Window'), 'Turn Stats'))
    expect(hooks.calls).toEqual(['turn-stats'])
  })

  it('Window has Token Monitor wired to its hook', () => {
    fire(itemIn(submenuOf('Window'), 'Token Monitor'))
    expect(hooks.calls).toEqual(['token-monitor'])
  })

  it('Window has Navide Cloud wired to its hook', () => {
    // Signing in must be reachable without finding Settings first — it is the
    // first thing a new user does.
    fire(itemIn(submenuOf('Window'), 'Navide Cloud'))
    expect(hooks.calls).toEqual(['account'])
  })

  // role: 'copy' copies the DOM selection, which a terminal pane never has, so
  // Edit > Copy reads the selection out of the focused page instead.
  describe('Edit > Copy', () => {
    function clickCopy(win?: unknown): Promise<void> {
      const copy = itemIn(submenuOf('Edit'), 'Copy')
      expect(copy.role).toBeUndefined()
      return (copy.click as unknown as (item: unknown, win: unknown) => Promise<void>)(undefined, win)
    }

    it('copies a terminal selection through main, not the page clipboard', async () => {
      focused.selection = 'selected terminal text'
      await clickCopy()
      expect(clipboardWrites).toEqual(['selected terminal text'])
      expect(focused.copyCalls).toBe(0)
    })

    // The pane pushes its selection as it changes, so the case that used to
    // lose the 300ms race is now a synchronous read that never runs one.
    describe('prefers what the page already pushed', () => {
      it('copies the pushed selection without asking the page at all', async () => {
        setTerminalSelection(FOCUSED_ID, 'pushed from the pane')
        focused.selection = 'should never be read'
        await clickCopy()
        expect(clipboardWrites).toEqual(['pushed from the pane'])
        expect(focused.evalCalls).toBe(0)
      })

      // A busy renderer is exactly the case the old path failed on: the eval
      // never lands in time. With a pushed selection there is nothing to wait
      // for, so Copy is correct even while the pane is painting.
      it('copies while the renderer is too busy to answer an eval', async () => {
        setTerminalSelection(FOCUSED_ID, 'pushed before the pane got busy')
        focused.hangs = true
        await clickCopy()
        expect(clipboardWrites).toEqual(['pushed before the pane got busy'])
        expect(focused.copyCalls).toBe(0)
      })

      // Nothing pushed means the page has no terminal selection, or never
      // reports one (a plugin view on another preload) — ask, as before.
      it('still asks the page when nothing was pushed', async () => {
        focused.selection = 'read from the page'
        await clickCopy()
        expect(clipboardWrites).toEqual(['read from the page'])
        expect(focused.evalCalls).toBe(1)
      })
    })

    it('falls back to the built-in copy when the page reports no selection', async () => {
      focused.selection = ''
      await clickCopy()
      expect(clipboardWrites).toEqual([])
      expect(focused.copyCalls).toBe(1)
    })

    // A plugin view (different preload, no terminal global) rejects the eval;
    // the copy must still happen rather than silently doing nothing.
    it('falls back when the page cannot be evaluated at all', async () => {
      focused.throws = true
      await clickCopy()
      expect(clipboardWrites).toEqual([])
      expect(focused.copyCalls).toBe(1)
    })

    // The plugin host window renders a blank page; its child WebContentsView is
    // what holds focus, so the window must never be preferred over it.
    it('prefers the focused WebContents over the window it was invoked from', async () => {
      focused.selection = 'from the focused view'
      const winContents = { isDestroyed: () => false, executeJavaScript: async () => 'from the window', copy: () => {} }
      await clickCopy({ webContents: winContents })
      expect(clipboardWrites).toEqual(['from the focused view'])
    })

    it('does nothing (without throwing) when nothing is focused', async () => {
      h.focusedWebContents = null
      await expect(clickCopy()).resolves.toBeUndefined()
      expect(clipboardWrites).toEqual([])
    })

    // Nothing awaits the click handler, so a throw here would surface as an
    // unhandled rejection in the main process rather than a failed copy.
    it('survives a WebContents destroyed mid-copy', async () => {
      const destroyed = {
        isDestroyed: () => true,
        executeJavaScript: async () => { throw new Error('Object has been destroyed') },
        copy: () => { throw new Error('Object has been destroyed') }
      }
      h.focusedWebContents = destroyed
      await expect(clickCopy()).resolves.toBeUndefined()
      expect(clipboardWrites).toEqual([])
    })

    // Every branch below ends at webContents.copy(), which copies nothing at
    // all over a terminal (.xterm is user-select: none) — so a user who pressed
    // Copy got an unchanged clipboard. They are very different failures and the
    // log has to tell them apart.
    describe('reports why a copy produced nothing', () => {
      it('names the timeout when the page loses the selection race', async () => {
        vi.useFakeTimers()
        focused.hangs = true
        const pending = clickCopy()
        await vi.advanceTimersByTimeAsync(300)
        await pending
        vi.useRealTimers()

        expect(clipboardWrites).toEqual([])
        expect(focused.copyCalls).toBe(1)
        expect(warnings.filter((w) => w.includes('did not answer within 300ms'))).toHaveLength(1)
      })

      it('names the empty answer when the page replies promptly', async () => {
        focused.selection = ''
        await clickCopy()
        expect(warnings.filter((w) => w.includes('reported no terminal selection'))).toHaveLength(1)
      })

      // The throw reports itself; adding "the page said there is no selection"
      // on top would be wrong — the page said nothing at all.
      it('reports a failed read once, not twice', async () => {
        focused.throws = true
        await clickCopy()
        const copyWarnings = warnings.filter((w) => w.includes('[menu] Copy:'))
        expect(copyWarnings).toHaveLength(1)
        expect(copyWarnings[0]).toContain('threw')
      })

      it('stays quiet when the copy succeeds', async () => {
        focused.selection = 'selected terminal text'
        await clickCopy()
        expect(warnings.filter((w) => w.includes('[menu] Copy:'))).toEqual([])
      })
    })

    // Issue #20: the console warning above is for a maintainer reading a log.
    // The person who pressed ⌘C sees nothing, and the page is the only place
    // that can tell them — so main names the branch it fell through on.
    describe('tells the page that Copy produced nothing', () => {
      it('sends terminal:copy-empty, and still runs the built-in copy', async () => {
        focused.selection = ''
        await clickCopy()
        expect(focused.sent).toEqual([{ channel: 'terminal:copy-empty', args: ['no-selection'] }])
        expect(focused.copyCalls).toBe(1)
      })

      it('sends nothing when the copy succeeded', async () => {
        focused.selection = 'selected terminal text'
        await clickCopy()
        expect(focused.sent).toEqual([])
        expect(clipboardWrites).toEqual(['selected terminal text'])
      })
    })
  })

  it('File has no Close Window on macOS (deliberate omission)', () => {
    // `role: 'close'` owns ⌘W, which fires in the main process ahead of the
    // renderer's closeActiveEditor. Putting it back silently kills tab-closing
    // while leaving the binding visible in Settings.
    installOn('darwin')
    const closeRoles = submenuOf('File').filter(
      (i) => typeof i.role === 'string' && i.role.toLowerCase() === 'close'
    )
    expect(closeRoles).toEqual([])
  })

  it.each(NON_MAC)('Window keeps Close on %s, where Ctrl+W is free', (platform) => {
    installOn(platform)
    const closeRoles = submenuOf('Window').filter(
      (i) => typeof i.role === 'string' && i.role.toLowerCase() === 'close'
    )
    expect(closeRoles).toHaveLength(1)
  })

  it('View reloads through a plain item, never the accelerator-carrying role', () => {
    const view = submenuOf('View')
    // `role: 'reload'` would bring ⌘R back with it, and the main process wins
    // that race — the renderer's rebuild-pane binding would stop firing without
    // a trace, which is the exact failure this whole area was fixing.
    expect(view.filter((i) => typeof i.role === 'string' && i.role.toLowerCase() === 'reload')).toEqual([])
    const reload = itemIn(view, 'Reload Window')
    expect(reload.accelerator).toBeUndefined()
    fire(reload)
    expect(focused.reloadCalls).toBe(1)
  })

  it('View still has no webContents zoom roles (deliberate omission)', () => {
    const view = submenuOf('View')
    const zoomRoles = view.filter(
      (i) => typeof i.role === 'string' && ['resetzoom', 'zoomin', 'zoomout'].includes(i.role.toLowerCase())
    )
    expect(zoomRoles).toEqual([])
  })

  it.each([
    ['darwin', 'Agent-Team'],
    ['linux', 'File'],
  ] as const)('builds and clicks safely with no hooks at all on %s', (platform, top) => {
    setPlatformId(platform)
    expect(() => installApplicationMenu({}, [], 'en-US')).not.toThrow()
    const menu = submenuOf(top)
    expect(() => fire(itemIn(menu, 'Settings…'))).not.toThrow()
    expect(() => fire(itemIn(submenuOf('Window'), 'Pipeline Manager'))).not.toThrow()
    expect(() => fire(itemIn(submenuOf('Window'), 'Resource Manager'))).not.toThrow()
    expect(() => fire(itemIn(submenuOf('Window'), 'Turn Stats'))).not.toThrow()
    expect(() => fire(itemIn(submenuOf('Window'), 'Token Monitor'))).not.toThrow()
  })
})

// The locale arm. `installApplicationMenu` takes the locale as a required
// argument precisely so a caller cannot silently fall back to English, so the
// zh-TW menu is asserted from the same template capture as the English one.
describe('application menu — locale', () => {
  const hooks = makeHooks()

  beforeEach(() => {
    h.template = []
    hooks.calls.length = 0
  })

  afterEach(() => {
    setPlatformId(BASELINE)
  })

  it('renders Japanese menu entries without changing their actions', () => {
    setPlatformId('linux')
    installApplicationMenu(hooks, [], 'ja-JP')
    expect(h.template.map(item => item.label)).toEqual(expect.arrayContaining(['ファイル', '編集', '表示', 'ウィンドウ']))
    fire(itemIn(submenuOf('ファイル'), 'ワークスペースを開く…'))
    expect(hooks.calls).toEqual(['open-workspace'])
    expect(MENU_STRINGS['ja-JP'].pickWorkspace).toBe('ワークスペースのフォルダーを選択')
    expect(Object.keys(MENU_STRINGS['ja-JP']).sort()).toEqual(Object.keys(MENU_STRINGS['en-US']).sort())
  })

  it('labels the top-level menus in the requested locale', () => {
    setPlatformId('linux')
    installApplicationMenu(hooks, [], 'zh-TW')
    const tops = h.template.map((i) => i.label).filter(Boolean)
    expect(tops).toContain('檔案')
    expect(tops).toContain('編輯')
    expect(tops).toContain('檢視')
    expect(tops).toContain('視窗')
    expect(tops).not.toContain('File')
  })

  it('translates the Navide-specific items a zh-TW user reaches for', () => {
    setPlatformId('linux')
    installApplicationMenu(hooks, [], 'zh-TW')
    const file = submenuOf('檔案')
    expect(() => itemIn(file, '開新視窗')).not.toThrow()
    expect(() => itemIn(file, '開啟工作區…')).not.toThrow()
    expect(itemIn(itemIn(file, '開啟最近使用').submenu as MenuItemConstructorOptions[], '沒有最近使用的工作區').enabled).toBe(false)
    const window = submenuOf('視窗')
    for (const label of ['流程管理', '資源控管', '每輪消耗', 'Token 監看']) {
      expect(() => itemIn(window, label)).not.toThrow()
    }
    fire(itemIn(window, '流程管理'))
    expect(hooks.calls).toEqual(['pipeline-manager'])
  })

  it('translates the Help menu legal entries and still routes them by route', () => {
    setPlatformId('linux')
    installApplicationMenu(hooks, [], 'zh-TW')
    const help = h.template.find((i) => i.role === 'help')
    if (!help || !Array.isArray(help.submenu)) throw new Error('no Help menu with submenu')
    const menu = help.submenu as MenuItemConstructorOptions[]
    expect(menu.map((i) => i.label)).toContain('隱私權')
    for (const route of LEGAL_ROUTES) fire(itemIn(menu, MENU_STRINGS['zh-TW'].legal[route]))
    expect(hooks.calls).toEqual(LEGAL_ROUTES.map((r) => 'legal:' + r))
  })

  // Chromium labels a `role` item in the SYSTEM locale, and Electron cannot
  // re-localize it. Supplying our own label would silently take those items
  // out of the OS's hands, so no role may carry one.
  it('leaves every role item unlabeled so the OS keeps wording them', () => {
    for (const locale of ['en-US', 'zh-TW', 'ja-JP'] as const) {
      for (const platform of ['darwin', 'linux'] as const) {
        setPlatformId(platform)
        installApplicationMenu(hooks, [], locale)
        const labeledRoles: string[] = []
        const walk = (items: MenuItemConstructorOptions[]): void => {
          for (const item of items) {
            if (item.role && item.label) labeledRoles.push(`${locale}/${platform}:${item.role}`)
            if (Array.isArray(item.submenu)) walk(item.submenu as MenuItemConstructorOptions[])
          }
        }
        walk(h.template)
        expect(labeledRoles).toEqual([])
      }
    }
  })

  it('keeps both locale tables filled with the same keys', () => {
    const en = MENU_STRINGS['en-US']
    const zh = MENU_STRINGS['zh-TW']
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(zh.legal).sort()).toEqual([...LEGAL_ROUTES].sort())
    for (const [key, value] of Object.entries(zh)) {
      if (typeof value === 'string') expect(value.trim()).not.toBe('')
      expect(key in en).toBe(true)
    }
  })
})
