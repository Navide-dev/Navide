import { app, clipboard, Menu, webContents, type BrowserWindow, type MenuItemConstructorOptions, type WebContents } from 'electron'
import { LEGAL_LABELS, LEGAL_ROUTES, type LegalRoute } from '../shared/legalLinks'
import { MENU_STRINGS } from './menuStrings'
import type { SupportedLocale } from './hostLocale'
import { isMac } from '../shared/osplat'
import { getTerminalSelection } from './terminal-selection-cache'

/**
 * Application menu.
 *
 * The default Electron menu structure (kept so native accelerators like
 * ⌘C / ⌘V / ⌘Q keep working — `setApplicationMenu(null)` would break
 * copy/paste and quit) plus Navide-specific entries wired through
 * AppMenuHooks:
 *   - App menu (macOS): Settings… (⌘,) and Check for Updates…
 *   - File: Open Workspace… (⌘O); on non-macOS also Settings… / Check for
 *     Updates… (platforms without an app menu)
 *   - Window: Pipeline Manager
 *
 * Every label this file writes is localized through menuStrings.ts, indexed by
 * the `locale` argument. Items carrying an Electron `role` are not: Chromium
 * labels those in the SYSTEM locale and offers no way to override it, so a
 * zh-TW menu on an English machine reads as a mix. That is deliberate — see
 * menuStrings.ts. Electron also cannot re-label an installed menu, so changing
 * the language means building a new one (index.ts's rebuildAppMenu).
 *
 * FOUR deliberate omissions from the default menu remain, all because native
 * accelerators fire before the renderer's key handlers:
 *
 *   - The View submenu's `resetZoom` / `zoomIn` / `zoomOut` roles. Those roles
 *     bind ⌘0 / ⌘+ / ⌘- to `webContents` zoom, and this app already gives
 *     those three chords to per-pane content zoom (xterm font size in
 *     useTerminal.ts, Monaco font size in EditorViewMonaco.vue). Interface
 *     zoom does exist — Settings -> Appearance, or the Shift variants of these
 *     chords through the renderer's keybinding registry, applied by
 *     src/main/ui-zoom-store.ts — but it must not come from these roles, whose
 *     native accelerators would take ⌘0 / ⌘+ / ⌘- away from the panes.
 *   - The View submenu's `forceReload` role, which owns ⇧⌘R.
 *   - The View submenu's `reload` role, which owns ⌘R. Between them those two
 *     held both halves of the reload/rebuild pair, and had them backwards: ⌘R
 *     reloaded the whole renderer — every PTY, every unsaved buffer — while
 *     rebuilding one pane needed the longer chord. Now ⌘R rebuilds the focused
 *     pane and ⇧⌘R reloads the window, mirroring ⌘W / ⇧⌘W. Reloading is still
 *     in the View menu, as a plain item carrying no accelerator of its own.
 *   - The File submenu's `close` role ON macOS, which owns ⌘W. That key is the
 *     renderer's closeActiveEditor — close a TAB, not the window. The role won
 *     every time, so the binding users could see in Settings never ran. Off
 *     macOS the role stays in the Window menu: there it answers Ctrl+W, which
 *     no rule claims, and it is the only keyboard way to close a window there.
 *     The cost on macOS is that closing a window is now the traffic lights or
 *     ⌘Q — no window-closing key at all, since no rule binds ⌘W outside an
 *     editor. Accepted deliberately; ⌘W closing a tab is the common case.
 *
 * Installing a menu without them is the only way to drop them: Electron has no
 * API to edit the default menu in place.
 */
/** One entry in the File > Open Recent submenu. */
export interface RecentMenuEntry {
  path: string
  name: string
  exists: boolean
}

export interface AppMenuHooks {
  /** App menu (macOS) / File menu (non-macOS): open the settings modal. */
  onOpenSettings?: () => void
  /** App menu (macOS) / File menu (non-macOS): check for updates. */
  onCheckUpdates?: () => void
  /** File menu: pick a workspace folder and open it. */
  onOpenWorkspace?: () => void
  /** File menu: open a recent workspace by absolute path. */
  onOpenRecent?: (path: string) => void
  /** File menu: open a fresh window. */
  onNewWindow?: () => void
  /** Window menu: ask the main window to open the Pipeline Manager modal. */
  onOpenPipelineManager?: () => void
  /** Window menu: open the Resource Manager window (CPU + memory per CLI). */
  onOpenResourceManager?: () => void
  /** Window menu: open the Turn Stats modal (per-turn token usage of a pane). */
  onOpenTurnStats?: () => void
  /** Window menu: open the standalone machine-wide token monitor. */
  onOpenTokenMonitor?: () => void
  /** Window menu: open the account window (sign in / create an account). */
  onOpenAccount?: () => void
  /** Help menu: open the Navide GitHub repo. */
  onOpenRepo?: () => void
  /** Help menu: open the GitHub issues page. */
  onReportIssue?: () => void
  /** Help menu: show the keyboard-shortcuts panel. */
  onShowShortcuts?: () => void
  /** Help menu: reopen the What's New announcement (and its guided tour). */
  onShowWhatsNew?: () => void
  /** Help menu: replay the first-run welcome tour. */
  onShowWelcomeTour?: () => void
  /** Help menu: open one of the legal pages on navide.dev (see shared/legalLinks). */
  onOpenLegal?: (route: LegalRoute) => void
  /** View menu: route Reload Window through the native close preparation. */
  onReloadWindow?: (target: WebContents) => boolean | void
  // When provided, a dev-only "Developer" submenu with an entry that opens the
  // no-op plugin view is appended. Omit it (the default) and the menu is
  // byte-for-byte the shipping menu. Gated by the caller behind a dev flag.
  onOpenNoopPlugin?: () => void
  /** Same dev-only submenu: opens the M2 fs-probe plugin view. */
  onOpenFsProbePlugin?: () => void
  /** Same dev-only submenu: opens the M4 mini-IDE plugin view. */
  onOpenMiniIdePlugin?: () => void
  /** Same dev-only submenu: opens the Plans plugin view. */
  onOpenPlansPlugin?: () => void
}

/**
 * Expression evaluated in the focused page to read a terminal selection.
 *
 * useTerminal publishes this global; a page with no terminal (or a plugin view,
 * which gets a different preload) simply does not have it and yields '', which
 * routes the copy back to Chromium's own implementation.
 */
export const TERMINAL_SELECTION_EXPRESSION = 'window.__navideTerminalSelection?.() ?? ""'

/** How long Edit > Copy waits for the page before falling back to its own copy. */
const SELECTION_READ_TIMEOUT_MS = 300

/**
 * Marks the timeout arm of the selection race.
 *
 * Both a slow page and a page reporting no selection end up at the same
 * fallback, but they are very different failures — one is a busy renderer
 * losing a 300ms race, the other is genuinely nothing to copy. Without a
 * distinct value the log cannot tell them apart.
 */
const SELECTION_TIMED_OUT = Symbol('selection-read-timed-out')

export function installApplicationMenu(
  hooks: AppMenuHooks = {},
  recents: RecentMenuEntry[] = [],
  locale: SupportedLocale
): void {
  const mac = isMac()
  // Required, with no default: a caller that forgot to pass one would build an
  // English menu for a zh-TW user, and that failure looks exactly like success.
  const s = MENU_STRINGS[locale]

  // `role: 'copy'` copies the DOM selection, which a terminal pane never has
  // (`.xterm` is user-select: none), so Edit > Copy was inert while a CLI was
  // showing. Read the selection out of the focused page instead, and fall back
  // to Chromium's own copy for everything else.
  //
  // The target is `webContents.getFocusedWebContents()`, NOT the window's own
  // webContents: plugin UI lives in a child WebContentsView whose host window
  // renders a blank page (see frontendPluginManager), so anything addressed to
  // the window would reach nobody at all. Same conclusion context-menu.ts
  // already reached for the right-click menu.
  const copyItem: MenuItemConstructorOptions = {
    label: s.copy,
    accelerator: 'CmdOrCtrl+C',
    // Nothing awaits this handler, so every path must swallow its own errors:
    // an escaping rejection becomes an unhandled rejection in the main process.
    click: async (_item, win) => {
      try {
        const target =
          webContents.getFocusedWebContents() ??
          // The click signature types the window as BaseWindow; every window
          // this app creates is a BrowserWindow, so the narrowing is safe.
          (win as BrowserWindow | undefined)?.webContents
        if (!target || target.isDestroyed()) return
        // The page reports its selection as it changes, so the case that used
        // to lose the race below is now a synchronous read that never runs one.
        const pushed = getTerminalSelection(target.id)
        if (pushed) {
          clipboard.writeText(pushed)
          return
        }
        // Nothing on file: either the page holds no terminal selection, or it
        // never reports any — a plugin view on a different preload, a window
        // with no terminal. Ask it directly, exactly as before.
        const startedAt = Date.now()
        let selection: unknown = ''
        // Set when the read threw, so the fallback below does not also report
        // "the page said there is no selection" — the page said nothing at all.
        let readThrew = false
        try {
          // executeJavaScript never settles while the page is navigating, which
          // would strand Copy with no fallback — race it against a short
          // deadline and treat a slow page as "no terminal selection".
          selection = await Promise.race([
            target.executeJavaScript(TERMINAL_SELECTION_EXPRESSION, true),
            new Promise((resolve) => setTimeout(() => resolve(SELECTION_TIMED_OUT), SELECTION_READ_TIMEOUT_MS))
          ])
        } catch (err) {
          readThrew = true
          // A plugin view (different preload, no terminal global) rejects the
          // eval. Expected, but still worth a line: the fallback below copies
          // nothing at all over a terminal.
          console.warn(
            `[menu] Copy: reading the page selection threw — falling back to webContents.copy(): ${String(err)}`
          )
        }
        // The WebContents can be gone by the time the round-trip returns.
        if (target.isDestroyed()) return
        // Written from main, so it never depends on the page holding DOM focus
        // (opening the menu takes it away) — same reason context-menu.ts does.
        if (typeof selection === 'string' && selection) clipboard.writeText(selection)
        else {
          // webContents.copy() copies nothing over a terminal (.xterm is
          // user-select: none), so landing here means the user pressed Copy and
          // got an unchanged clipboard. Name the branch: a renderer too busy to
          // answer reads very differently from a page that promptly said there
          // is no selection, and only the first scales with CLI output. A throw
          // already reported itself above.
          if (!readThrew) {
            console.warn(
              selection === SELECTION_TIMED_OUT
                ? `[menu] Copy: page did not answer within ${SELECTION_READ_TIMEOUT_MS}ms (busy renderer?) — falling back to webContents.copy(), which copies nothing over a terminal`
                : `[menu] Copy: page reported no terminal selection in ${Date.now() - startedAt}ms — falling back to webContents.copy()`
            )
          }
          // Tell the page which branch this was: webContents.copy() leaves the
          // clipboard unchanged over a terminal, and the pane is the only place
          // that can say so to the person who pressed the key.
          target.send('terminal:copy-empty', selection === SELECTION_TIMED_OUT ? 'timeout' : 'no-selection')
          target.copy()
        }
      } catch { /* window torn down mid-copy — nothing useful to do */ }
    }
  }

  const settingsItem: MenuItemConstructorOptions = {
    label: s.settings,
    accelerator: 'CmdOrCtrl+,',
    click: () => hooks.onOpenSettings?.()
  }
  const checkUpdatesItem: MenuItemConstructorOptions = {
    label: s.checkUpdates,
    click: () => hooks.onCheckUpdates?.()
  }

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              settingsItem,
              checkUpdatesItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          } as MenuItemConstructorOptions
        ]
      : []),
    {
      label: s.file,
      submenu: [
        { label: s.newWindow, accelerator: 'CmdOrCtrl+N', click: () => hooks.onNewWindow?.() },
        {
          label: s.openWorkspace,
          accelerator: 'CmdOrCtrl+O',
          click: () => hooks.onOpenWorkspace?.()
        },
        {
          label: s.openRecent,
          submenu: recents.length
            ? recents.map((r) => ({
                label: r.name || r.path,
                enabled: r.exists,
                click: () => hooks.onOpenRecent?.(r.path)
              }))
            : [{ label: s.noRecentWorkspaces, enabled: false }]
        },
        // No app menu off macOS — surface the same entries under File. macOS
        // gets nothing here: its Settings… live in the app menu, and `close` is
        // omitted so ⌘W reaches the renderer (see the doc comment above).
        ...(mac
          ? []
          : [
              { type: 'separator' } as MenuItemConstructorOptions,
              settingsItem,
              checkUpdatesItem,
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'quit' } as MenuItemConstructorOptions
            ])
      ]
    },
    {
      label: s.edit,
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        copyItem,
        { role: 'paste' },
        ...(mac
          ? [
              { role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions,
              { role: 'delete' } as MenuItemConstructorOptions,
              { role: 'selectAll' } as MenuItemConstructorOptions
            ]
          : [
              { role: 'delete' } as MenuItemConstructorOptions,
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'selectAll' } as MenuItemConstructorOptions
            ])
      ]
    },
    {
      label: s.view,
      // No resetZoom / zoomIn / zoomOut, no forceReload, no `role: 'reload'` —
      // see the doc comment above.
      submenu: [
        // Same action the role performs, minus the accelerator it comes with.
        // Reloading stays reachable by mouse while ⌘R belongs to the renderer.
        {
          label: s.reloadWindow,
          click: (_item, win) => {
            const target =
              webContents.getFocusedWebContents() ?? (win as BrowserWindow | undefined)?.webContents
            if (!target || target.isDestroyed()) return
            // A guarded receiver window reloads only after its own file/provider
            // preparation settled; the hook owns committing and reloading then.
            if (hooks.onReloadWindow?.(target) === true) return
            target.reload()
          }
        },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: s.window,
      submenu: [
        { label: 'Navide Cloud', click: () => hooks.onOpenAccount?.() },
        { type: 'separator' },
        { label: s.pipelineManager, click: () => hooks.onOpenPipelineManager?.() },
        { label: s.resourceManager, click: () => hooks.onOpenResourceManager?.() },
        { label: s.turnStats, click: () => hooks.onOpenTurnStats?.() },
        { label: s.tokenMonitor, click: () => hooks.onOpenTokenMonitor?.() },
        { type: 'separator' },
        { role: 'minimize' },
        // macOS "zoom" = maximize the window frame. Unrelated to content zoom,
        // has no accelerator, and is part of the standard Window menu.
        { role: 'zoom' },
        ...(mac
          ? [
              { type: 'separator' } as MenuItemConstructorOptions,
              { role: 'front' } as MenuItemConstructorOptions
            ]
          : [{ role: 'close' } as MenuItemConstructorOptions])
      ]
    },
    {
      role: 'help',
      submenu: [
        { label: s.repo, click: () => hooks.onOpenRepo?.() },
        { label: s.reportIssue, click: () => hooks.onReportIssue?.() },
        { type: 'separator' },
        { label: s.shortcuts, click: () => hooks.onShowShortcuts?.() },
        { label: s.whatsNew, click: () => hooks.onShowWhatsNew?.() },
        { label: s.welcomeTour, click: () => hooks.onShowWelcomeTour?.() },
        { type: 'separator' },
        // One entry per page, in the table's order, so the menu and the site
        // can only disagree by editing the table.
        ...LEGAL_ROUTES.map(
          (route): MenuItemConstructorOptions => ({
            label: s.legal[route],
            click: () => hooks.onOpenLegal?.(route)
          })
        )
      ]
    } as MenuItemConstructorOptions
  ]

  // Dev-only, flag-gated: a Developer submenu to launch the M1 plugin view.
  // Never present unless the caller passes the hook (see index.ts gating), so
  // the default UI is untouched.
  if (hooks.onOpenNoopPlugin || hooks.onOpenFsProbePlugin || hooks.onOpenMiniIdePlugin || hooks.onOpenPlansPlugin) {
    const submenu: MenuItemConstructorOptions[] = []
    if (hooks.onOpenNoopPlugin) {
      submenu.push({ label: 'Open no-op plugin view', click: () => hooks.onOpenNoopPlugin?.() })
    }
    if (hooks.onOpenFsProbePlugin) {
      submenu.push({ label: 'Open fs-probe plugin view', click: () => hooks.onOpenFsProbePlugin?.() })
    }
    if (hooks.onOpenMiniIdePlugin) {
      submenu.push({ label: 'Open mini-IDE plugin view', click: () => hooks.onOpenMiniIdePlugin?.() })
    }
    if (hooks.onOpenPlansPlugin) {
      submenu.push({ label: 'Open Plans plugin view', click: () => hooks.onOpenPlansPlugin?.() })
    }
    template.push({ label: 'Developer', submenu })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
