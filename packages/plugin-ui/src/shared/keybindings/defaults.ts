import type { KeybindingRule } from './types'
import { isMacPlatform } from './parseKey'

// The key that opens sidebar tab `n` and the one that opens Settings, as this
// platform binds them. macOS keeps ⌘N and ⌘,. Off macOS ⌘ is the Win/Super key,
// which the OS keeps for itself, and Ctrl+digit already selects a CLI type
// (controlPane.selectCliType1..9), so the sidebar takes Ctrl+Alt+digit there
// and Settings takes Ctrl+, — the key the menu's CmdOrCtrl+, already answers.
export function sidebarTabKeySpec(n: number, mac = isMacPlatform()): string {
  return mac ? `cmd+${n}` : `ctrl+alt+${n}`
}
export function settingsKeySpec(mac = isMacPlatform()): string {
  return mac ? 'cmd+,' : 'ctrl+,'
}

// Default keybinding rules.
// - Commands with no registered handler are no-ops: executeCommand returns false,
//   stopPropagation is NOT called, so existing element handlers still fire.
// - This makes all rules safe to define upfront even before Phase C wires handlers.
export const defaults: KeybindingRule[] = [
  // ── Workbench ────────────────────────────────────────────────────────────
  { key: 'cmd+shift+f', command: 'workbench.action.findInFiles' },
  { key: 'cmd+,',       command: 'workbench.action.openSettings' },
  { key: 'cmd+w',       command: 'workbench.action.closeActiveEditor', when: 'editorOpen && !modalOpen' },
  // Same key, the other window: ⌘W closes one unit of whatever the window
  // holds — a tab in the Mini IDE, the focused CLI pane here. The two guards
  // are window identities and never both hold, so this is not a conflict.
  //
  // No !terminalFocus: a focused CLI pane is exactly when you want this, and ⌘W
  // means nothing to a PTY (Ctrl+W is the one shells use).
  { key: 'cmd+w',       command: 'workbench.action.closeActivePane', when: 'paneStage && !modalOpen' },
  // While a modal is open the two rules above are guarded off; the modal itself
  // is then the unit ⌘W closes. Same handler as Escape, so nested layers close
  // first. No !terminalFocus (unlike Esc): ⌘W means nothing to an embedded PTY.
  { key: 'cmd+w',       command: 'workbench.action.closeModal', when: 'modalOpen' },
  // Closing a WINDOW, not a tab. ⌘W used to do this through the menu's `close`
  // role, which was dropped so the rule above could have the key (main/menu.ts);
  // this restores the capability on a chord no role claims. Every window that
  // registers it routes to the same path the traffic lights take, so whatever
  // close guard a window already has still runs.
  { key: 'cmd+shift+w', command: 'workbench.action.closeWindow' },
  { key: 'cmd+shift+s', command: 'workbench.action.saveAll',             when: 'editorOpen' },
  // !terminalFocus: a modal may embed a CLI terminal (Pipeline Manager), where
  // Esc is the CLI's own interrupt key and must reach the PTY.
  { key: 'escape',      command: 'workbench.action.closeModal', when: 'modalOpen && !terminalFocus' },
  // The Plan window has no `modalOpen` to gate on: its ESC walks a priority
  // ladder of overlays and ends at closing the window, so the rule is scoped to
  // the window instead and the ladder lives in its handler. Same !terminalFocus
  // reason as above — that window embeds an AiCliDock PTY.
  { key: 'escape',      command: 'workbench.action.closeModal', when: 'planWindow && !terminalFocus' },

  // ── Editor ───────────────────────────────────────────────────────────────
  { key: 'cmd+s', command: 'editor.action.save',          when: 'editorOpen && !terminalFocus' },
  // cmd+k is a chord prefix; cmd+k cmd+k is the double-chord for inline rewrite
  // (single cmd+k is blocked by chord mode in editorTextFocus context)
  { key: 'cmd+k cmd+k',    command: 'editor.action.inlineRewrite', when: 'editorTextFocus' },
  { key: 'ctrl+shift+i',   command: 'editor.action.inlineRewrite', when: 'editorTextFocus' },
  { key: 'cmd+i',   command: 'editor.action.triggerGhost',  when: 'editorTextFocus' },
  { key: 'ctrl+space', command: 'editor.action.triggerGhost', when: 'editorTextFocus' },
  { key: 'cmd+f', command: 'editor.action.openFind',              when: 'editorOpen && !terminalFocus' },
  { key: 'cmd+e', command: 'editor.action.useSelectionForFind', when: 'editorOpen && !terminalFocus' },
  // Replace lives on Cmd+Alt+F (the macOS convention) so Cmd+H stays the system
  // "Hide application" shortcut instead of being shadowed inside the editor.
  { key: 'cmd+alt+f', command: 'editor.action.openReplace',       when: 'editorOpen && !terminalFocus' },
  { key: 'cmd+g', command: 'editor.action.nextMatch',     when: 'findOpen' },
  { key: 'cmd+shift+g', command: 'editor.action.prevMatch', when: 'findOpen' },
  { key: 'cmd+l', command: 'editor.action.gotoLine',      when: 'editorOpen' },
  { key: 'cmd+z',       command: 'editor.action.undo',    when: 'editorTextFocus' },
  { key: 'cmd+shift+z', command: 'editor.action.redo',    when: 'editorTextFocus' },
  { key: 'cmd+y',       command: 'editor.action.redo',    when: 'editorTextFocus' },
  { key: 'cmd+a',       command: 'editor.action.selectAll', when: 'editorTextFocus' },
  { key: 'ctrl+l',      command: 'editor.action.selectLine', when: 'editorTextFocus' },
  { key: 'ctrl+g',         command: 'editor.action.gotoLine',       when: 'editorOpen' },
  { key: 'cmd+/',         command: 'editor.action.toggleComment',  when: 'editorTextFocus' },
  { key: 'alt+z',         command: 'editor.action.toggleWordWrap', when: 'editorTextFocus' },
  { key: 'cmd+alt+/',     command: 'editor.action.blockComment',   when: 'editorTextFocus' },
  { key: 'shift+alt+a',  command: 'editor.action.blockComment',   when: 'editorTextFocus' },
  { key: 'cmd+shift+k',   command: 'editor.action.deleteLines',    when: 'editorTextFocus' },
  { key: 'alt+backspace', command: 'editor.action.deleteWordLeft',  when: 'editorTextFocus' },
  { key: 'alt+delete',    command: 'editor.action.deleteWordRight', when: 'editorTextFocus' },
  { key: 'cmd+backspace', command: 'editor.action.deleteAllLeft',  when: 'editorTextFocus' },
  { key: 'cmd+delete',    command: 'editor.action.deleteAllRight', when: 'editorTextFocus' },
  { key: 'cmd+enter',     command: 'editor.action.insertLineAfter', when: 'editorTextFocus' },
  { key: 'cmd+shift+enter', command: 'editor.action.insertLineBefore', when: 'editorTextFocus' },

  { key: 'alt+up',         command: 'editor.action.moveLineUp',       when: 'editorTextFocus' },
  { key: 'alt+down',       command: 'editor.action.moveLineDown',     when: 'editorTextFocus' },
  { key: 'shift+alt+down', command: 'editor.action.duplicateLineDown', when: 'editorTextFocus' },
  { key: 'shift+alt+up',   command: 'editor.action.duplicateLineUp',   when: 'editorTextFocus' },
  { key: 'cmd+shift+l',    command: 'editor.action.selectHighlights',  when: 'editorTextFocus' },
  { key: 'cmd+f2',         command: 'editor.action.selectHighlights',  when: 'editorTextFocus' },
  // macOS US: Cmd+Shift+\ fires e.key='|'; use cmd+shift+| to match correctly
  { key: 'cmd+shift+|',    command: 'editor.action.jumpToBracket',     when: 'editorTextFocus' },
  { key: 'cmd+d',          command: 'editor.action.addSelectionToNextFindMatch', when: 'editorTextFocus' },
  { key: 'cmd+]',          command: 'editor.action.indentLines',        when: 'editorTextFocus' },
  { key: 'cmd+[',          command: 'editor.action.outdentLines',       when: 'editorTextFocus' },
  { key: 'cmd+up',         command: 'editor.action.cursorTop',          when: 'editorTextFocus' },
  { key: 'cmd+down',       command: 'editor.action.cursorBottom',       when: 'editorTextFocus' },
  { key: 'cmd+shift+up',   command: 'editor.action.cursorTopSelect',    when: 'editorTextFocus' },
  { key: 'cmd+shift+down', command: 'editor.action.cursorBottomSelect', when: 'editorTextFocus' },
  { key: 'alt+left',         command: 'editor.action.cursorWordLeft',        when: 'editorTextFocus' },
  { key: 'alt+right',        command: 'editor.action.cursorWordRight',       when: 'editorTextFocus' },
  { key: 'ctrl+shift+left',  command: 'editor.action.cursorWordLeftSelect',  when: 'editorTextFocus' },
  { key: 'ctrl+shift+right', command: 'editor.action.cursorWordRightSelect', when: 'editorTextFocus' },
  { key: 'cmd+alt+enter',    command: 'editor.action.openLink',              when: 'editorTextFocus' },
  { key: 'ctrl+up',          command: 'editor.action.scrollLineUp',          when: 'editorTextFocus' },
  { key: 'ctrl+down',      command: 'editor.action.scrollLineDown',     when: 'editorTextFocus' },

  { key: 'cmd+k cmd+c', command: 'editor.action.addLineComment',         when: 'editorTextFocus' },
  { key: 'cmd+k cmd+u', command: 'editor.action.removeLineComment',      when: 'editorTextFocus' },
  { key: 'cmd+k cmd+x', command: 'editor.action.trimTrailingWhitespace', when: 'editorTextFocus' },
  { key: 'shift+alt+f',      command: 'editor.action.formatDocument',      when: 'editorTextFocus' },
  { key: 'cmd+k cmd+f',     command: 'editor.action.formatSelection',     when: 'editorTextFocus' },
  { key: 'shift+alt+right', command: 'editor.action.smartSelect.expand',  when: 'editorTextFocus' },
  { key: 'shift+alt+left',  command: 'editor.action.smartSelect.shrink',  when: 'editorTextFocus' },
  { key: 'cmd+k cmd+m', command: 'workbench.action.changeLanguageMode',    when: 'editorOpen' },
  { key: 'cmd+k cmd+p', command: 'workbench.action.copyFilePath',          when: 'editorOpen' },
  { key: 'cmd+k cmd+r',  command: 'workbench.action.revealInExplorer',  when: 'editorOpen' },
  { key: 'shift+alt+r', command: 'workbench.action.revealFileInOS',      when: 'editorOpen' },
  { key: 'cmd+k cmd+s', command: 'workbench.action.openKeyboardShortcuts' },
  { key: 'cmd+k cmd+t', command: 'workbench.action.selectTheme' },
  { key: 'cmd+k cmd+z', command: 'workbench.action.toggleZenMode' },
  { key: 'cmd+k cmd+o', command: 'workbench.action.openFolder' },
  { key: 'cmd+k cmd+e', command: 'workbench.action.focusActiveEditorGroup', when: 'editorOpen' },
  { key: 'cmd+k cmd+l', command: 'editor.action.toggleLineNumbers',          when: 'editorOpen' },
  { key: 'cmd+=',       command: 'editor.action.fontZoomIn',    when: 'editorOpen' },
  { key: 'cmd+-',       command: 'editor.action.fontZoomOut',   when: 'editorOpen' },
  { key: 'cmd+0',       command: 'editor.action.fontZoomReset', when: 'editorOpen' },
  // Interface zoom — the whole app chrome, not one font. It shares the zoom
  // chords above with Shift added, which is free: the matcher compares Shift
  // exactly, so ⌘= (editor font) and ⌘⇧= never resolve to each other.
  // macOS US reports ⌘⇧= as '+' and ⌘⇧- as '_', and only '/', digits and
  // alt+letter have physical-key fallbacks, so these two specs name the
  // character the keyboard actually emits — same reason as cmd+shift+| above.
  // No `when`: the main, editor and plans windows all register the handlers
  // (one factor scales them together), and the Git plugin view deliberately
  // does not — its preload has no bridge to main, so an unregistered binding
  // there is simply not consumed and falls through untouched.
  { key: 'cmd+shift++', command: 'workbench.action.zoomUiIn' },
  { key: 'cmd+shift+_', command: 'workbench.action.zoomUiOut' },
  { key: 'cmd+shift+0', command: 'workbench.action.zoomUiReset' },
  { key: 'f3',          command: 'editor.action.nextMatch',          when: 'findOpen' },
  { key: 'shift+f3',    command: 'editor.action.prevMatch',          when: 'findOpen' },

  { key: 'cmd+o',       command: 'workbench.action.openFile' },
  { key: 'cmd+n',       command: 'workbench.action.newFile' },
  { key: 'cmd+shift+n', command: 'workbench.action.newWindow' },
  { key: 'cmd+shift+o', command: 'workbench.action.gotoSymbol', when: 'editorOpen' },
  { key: 'cmd+t',       command: 'workbench.action.gotoWorkspaceSymbol' },

  // ── Multi-cursor ─────────────────────────────────────────────────────────────
  { key: 'cmd+alt+up',   command: 'editor.action.insertCursorAbove',                   when: 'editorTextFocus' },
  { key: 'cmd+alt+down', command: 'editor.action.insertCursorBelow',                   when: 'editorTextFocus' },
  { key: 'shift+alt+i',  command: 'editor.action.insertCursorAtEndOfEachLineSelected', when: 'editorTextFocus' },

  // ── Code Folding ─────────────────────────────────────────────────────────────
  { key: 'cmd+alt+[',   command: 'editor.fold',            when: 'editorOpen' },
  { key: 'cmd+alt+]',   command: 'editor.unfold',          when: 'editorOpen' },
  { key: 'cmd+k cmd+[', command: 'editor.foldRecursively', when: 'editorOpen' },
  { key: 'cmd+k cmd+]', command: 'editor.unfoldRecursively', when: 'editorOpen' },
  { key: 'cmd+k cmd+0', command: 'editor.foldAll',         when: 'editorOpen' },
  { key: 'cmd+k cmd+j', command: 'editor.unfoldAll',       when: 'editorOpen' },
  { key: 'cmd+k cmd+1', command: 'editor.foldLevel1',      when: 'editorOpen' },
  { key: 'cmd+k cmd+2', command: 'editor.foldLevel2',      when: 'editorOpen' },
  { key: 'cmd+k cmd+3', command: 'editor.foldLevel3',      when: 'editorOpen' },
  { key: 'cmd+k cmd+4', command: 'editor.foldLevel4',      when: 'editorOpen' },
  { key: 'cmd+k cmd+5', command: 'editor.foldLevel5',      when: 'editorOpen' },
  { key: 'cmd+k cmd+6', command: 'editor.foldLevel6',      when: 'editorOpen' },
  { key: 'cmd+k cmd+7', command: 'editor.foldLevel7',      when: 'editorOpen' },

  // ── Split Editor ─────────────────────────────────────────────────────────────
  { key: 'cmd+\\',         command: 'workbench.action.splitEditor',          when: 'editorOpen' },
  { key: 'cmd+k cmd+left', command: 'workbench.action.focusPreviousGroup' },
  { key: 'cmd+k cmd+right',command: 'workbench.action.focusNextGroup' },

  // ── Problems Panel ───────────────────────────────────────────────────────────
  { key: 'f8',          command: 'editor.action.marker.nextInFiles' },
  { key: 'shift+f8',    command: 'editor.action.marker.prevInFiles' },
  { key: 'cmd+shift+m', command: 'workbench.action.problems.focus' },

  // ── Quick Fix ────────────────────────────────────────────────────────────────
  { key: 'cmd+.',       command: 'editor.action.quickFix', when: 'editorTextFocus' },

  { key: 'cmd+shift+p', command: 'workbench.action.showCommands' },
  { key: 'f1',          command: 'workbench.action.showCommands' },
  { key: 'cmd+k cmd+w', command: 'workbench.action.closeAllEditors' },
  // 'mod', not 'cmd': the Plan window used to match this chord itself, on the
  // platform modifier, and folding it into the rule table must not cost Ctrl+P
  // off macOS (PlanWindowApp.test.ts pins that). Same key on macOS either way.
  { key: 'mod+p',       command: 'workbench.action.quickOpen' },
  { key: 'cmd+shift+t', command: 'workbench.action.reopenClosedEditor' },

  // ── Workbench: sidebar & view ────────────────────────────────────────────────
  { key: 'cmd+b',       command: 'workbench.action.toggleSidebar' },
  { key: 'cmd+shift+e', command: 'workbench.action.focusExplorer' },
  // Pipeline moved off cmd+shift+r (now Rebuild, below) to cmd+shift+y — the
  // only unclaimed cmd+shift+<letter> that macOS doesn't reserve.
  { key: 'cmd+shift+y', command: 'workbench.action.focusPipeline' },
  { key: 'cmd+shift+g', command: 'workbench.action.focusSourceControl', when: '!findOpen' },
  { key: 'cmd+shift+i', command: 'workbench.action.openMiniIDE' },
  // Right-rail preview panel. cmd+shift+v is left alone because terminals
  // treat it as paste-as-plain-text.
  { key: 'cmd+alt+v',   command: 'workbench.action.focusPreview' },
  // cmd+shift+p is the command palette and cmd+shift+l is taken by
  // selectHighlights/addSelectionToChat, so Plans lives on cmd+shift+d.
  { key: 'cmd+shift+d', command: 'workbench.action.openPlans' },
  // The Debug modal shares cmd+shift+l with the editor's selectHighlights and
  // addSelectionToChat, which are both gated on editorOpen — a context only the
  // Mini IDE window ever sets. Guarding on !editorOpen keeps the chord free for
  // the editor there and gives Debug every other window.
  { key: 'cmd+shift+l', command: 'workbench.action.openDebug', when: '!editorOpen' },
  { key: 'cmd+shift+u', command: 'workbench.action.spawnAgent' },
  // Rebuild is reachable two ways: cmd+shift+r is the primary chord (freed by
  // dropping the forceReload menu role in main/menu.ts), cmd+shift+b is kept as
  // the original alias.
  // ⌘R rebuilds ONE pane, ⇧⌘R reloads the whole window — the same two tiers as
  // ⌘W / ⇧⌘W. Both keys were the app menu's until main/menu.ts dropped the
  // `reload` and `forceReload` roles; before that the pair was inverted, with
  // the destructive one (reload every PTY and unsaved buffer) on the shorter
  // chord. cmd+shift+b stays as the original Rebuild alias.
  //
  // rebuildPaneViaResume already prompts before interrupting a running turn, so
  // ⌘R inherits that guard without adding one.
  { key: 'cmd+r',       command: 'workbench.action.rebuildFocusedPane' },
  { key: 'cmd+shift+b', command: 'workbench.action.rebuildFocusedPane' },
  // !gitWindow, not bare: that window spends ⇧⌘R on git.refresh, and while its
  // AI dock has focus the chord belongs to the PTY. An unguarded rule here would
  // reload the window out from under the terminal instead.
  { key: 'cmd+shift+r', command: 'workbench.action.reloadWindow', when: '!gitWindow' },

  // ── CLI type quick-select (ControlPane) ──────────────────────────────────────
  // Ctrl+<n> selects the Nth manual CLI type for the next spawn (no-op past the
  // list). Ctrl+digit is unused elsewhere, so e.key is '1'..'9' and the central
  // matcher hits directly — no physical-digit fallback needed.
  { key: 'ctrl+1', command: 'controlPane.selectCliType1' },
  { key: 'ctrl+2', command: 'controlPane.selectCliType2' },
  { key: 'ctrl+3', command: 'controlPane.selectCliType3' },
  { key: 'ctrl+4', command: 'controlPane.selectCliType4' },
  { key: 'ctrl+5', command: 'controlPane.selectCliType5' },
  { key: 'ctrl+6', command: 'controlPane.selectCliType6' },
  { key: 'ctrl+7', command: 'controlPane.selectCliType7' },
  { key: 'ctrl+8', command: 'controlPane.selectCliType8' },
  { key: 'ctrl+9', command: 'controlPane.selectCliType9' },

  // ── Main-window sidebar tabs ─────────────────────────────────────────────────
  // Cmd+<n> picks the Nth sidebar view. 'paneStage' scopes them to the main
  // window, so they never collide with the editor's Cmd+1..9 tab jumps below
  // (those are gated on 'editorOpen', a context only the Mini IDE sets).
  { key: 'cmd+1', command: 'controlPane.selectSidebarTab1', when: 'paneStage && !editorOpen' },
  { key: 'cmd+2', command: 'controlPane.selectSidebarTab2', when: 'paneStage && !editorOpen' },
  { key: 'cmd+3', command: 'controlPane.selectSidebarTab3', when: 'paneStage && !editorOpen' },
  { key: 'cmd+4', command: 'controlPane.selectSidebarTab4', when: 'paneStage && !editorOpen' },
  { key: 'cmd+5', command: 'controlPane.selectSidebarTab5', when: 'paneStage && !editorOpen' },
  // Off macOS only, added beside the ⌘ rules above (which stay as they were):
  // see sidebarTabKeySpec. Ctrl+Alt is AltGr on Windows; a digit that AltGr
  // turns into a character (German ², Polish ...) is typed, not taken — see
  // eventKeyMatches in parseKey.ts.
  ...(isMacPlatform() ? [] : [1, 2, 3, 4, 5].map((n): KeybindingRule => ({
    key: sidebarTabKeySpec(n, false), command: `controlPane.selectSidebarTab${n}`, when: 'paneStage && !editorOpen',
  }))),
  ...(isMacPlatform() ? [] : [{ key: settingsKeySpec(false), command: 'workbench.action.openSettings' }]),

  // ── Editor tabs ──────────────────────────────────────────────────────────────
  { key: 'ctrl+tab',       command: 'workbench.action.openNextEditor' },
  { key: 'ctrl+shift+tab', command: 'workbench.action.openPreviousEditor' },

  // ── CLI pane cycling ─────────────────────────────────────────────────────────
  // Browser-tab muscle memory for walking the visible CLI panes. These must sit
  // AFTER the editor-tab rules above: the resolver reverses the list, so these
  // are tried first and windows without a pane stage fall through to
  // openNext/PreviousEditor exactly as before.
  //
  // The guard is 'paneStage' (set only by the main window) rather than
  // '!editorOpen': the Mini IDE clears editorOpen whenever its last tab closes,
  // which would let these rules win in a window that never registers the
  // commands — and an unhandled binding is NOT consumed, so the Tab would leak
  // straight into that window's AI dock terminal.
  //
  // Ctrl+Tab is the one Tab combo free to intercept — bare Tab is shell
  // completion and Shift+Tab is Claude Code's permission-mode toggle, and the
  // dispatcher runs in the capture phase, so binding either would swallow it
  // before xterm forwards it to the PTY.
  //
  // '!modalOpen' stops the shortcut from shuffling panes behind a dialog. It
  // covers the modals wired into that context (see App.vue's modalOpen watch),
  // not every overlay in the app.
  { key: 'ctrl+tab',       command: 'workbench.action.focusNextPane',     when: 'paneStage && !modalOpen' },
  { key: 'ctrl+shift+tab', command: 'workbench.action.focusPreviousPane', when: 'paneStage && !modalOpen' },
  { key: 'cmd+shift+]', command: 'workbench.action.moveEditorRightInGroup', when: 'editorOpen' },
  { key: 'cmd+shift+[', command: 'workbench.action.moveEditorLeftInGroup',  when: 'editorOpen' },
  { key: 'cmd+1', command: 'workbench.action.openEditorAtIndex1', when: 'editorOpen' },
  { key: 'cmd+2', command: 'workbench.action.openEditorAtIndex2', when: 'editorOpen' },
  { key: 'cmd+3', command: 'workbench.action.openEditorAtIndex3', when: 'editorOpen' },
  { key: 'cmd+4', command: 'workbench.action.openEditorAtIndex4', when: 'editorOpen' },
  { key: 'cmd+5', command: 'workbench.action.openEditorAtIndex5', when: 'editorOpen' },
  { key: 'cmd+6', command: 'workbench.action.openEditorAtIndex6', when: 'editorOpen' },
  { key: 'cmd+7', command: 'workbench.action.openEditorAtIndex7', when: 'editorOpen' },
  { key: 'cmd+8', command: 'workbench.action.openEditorAtIndex8', when: 'editorOpen' },
  { key: 'cmd+9', command: 'workbench.action.openEditorAtIndex9', when: 'editorOpen' },

  // ── Navigation history ────────────────────────────────────────────────────────
  { key: 'ctrl+-',       command: 'workbench.action.navigateBack',    when: 'editorOpen' },
  { key: 'ctrl+shift+-', command: 'workbench.action.navigateForward', when: 'editorOpen' },

  // ── AI Chat ──────────────────────────────────────────────────────────────────
  { key: 'cmd+shift+a', command: 'workbench.action.toggleAIChat' },
  { key: 'ctrl+`',      command: 'workbench.action.toggleAIChat' },
  { key: 'cmd+j',       command: 'workbench.action.toggleAIChat' },
  // Note: cmd+shift+l is selectHighlights when editorTextFocus; addSelectionToChat fires only when editor is open but textarea is NOT focused
  { key: 'cmd+shift+l', command: 'workbench.action.addSelectionToChat', when: 'editorOpen && !editorTextFocus' },

  // ── Replace in files / editor utilities ──────────────────────────────────────
  { key: 'cmd+shift+h', command: 'workbench.action.findInFilesReplace' },
  { key: 'ctrl+t',      command: 'editor.action.transpose',           when: 'editorTextFocus' },
  { key: 'ctrl+j',      command: 'editor.action.joinLines',           when: 'editorTextFocus' },

  // ── Copy paths ────────────────────────────────────────────────────────────────
  { key: 'cmd+shift+alt+c', command: 'workbench.action.copyRelativeFilePath', when: 'editorOpen' },

  // ── Navigation ────────────────────────────────────────────────────────────────
  { key: 'cmd+k cmd+q', command: 'editor.action.navigateToLastEditLocation', when: 'editorOpen' },
  { key: 'cmd+k cmd+d', command: 'editor.action.moveSelectionToNextFindMatch', when: 'editorTextFocus' },
  { key: 'f12',         command: 'editor.action.openFileAtCursor',  when: 'editorTextFocus' },
  { key: 'shift+f12',  command: 'editor.action.findReferences',   when: 'editorTextFocus' },
  { key: 'f2',          command: 'editor.action.renameSymbol',     when: 'editorTextFocus' },

  // ── Cursor line navigation ─────────────────────────────────────────────────────
  { key: 'ctrl+home', command: 'editor.action.cursorTop',             when: 'editorTextFocus' },
  { key: 'ctrl+end',  command: 'editor.action.cursorBottom',          when: 'editorTextFocus' },
  { key: 'shift+home', command: 'editor.action.cursorLineStartSelect', when: 'editorTextFocus' },
  { key: 'shift+end',  command: 'editor.action.cursorLineEndSelect',   when: 'editorTextFocus' },
  { key: 'ctrl+shift+home', command: 'editor.action.cursorTopSelect',    when: 'editorTextFocus' },
  { key: 'ctrl+shift+end',  command: 'editor.action.cursorBottomSelect', when: 'editorTextFocus' },

  // ── Git window ───────────────────────────────────────────────────────────────
  // Opening it is the counterpart of cmd+shift+i for the Mini IDE. 'paneStage'
  // scopes the override to the main window: the Mini IDE keeps cmd+shift+g for
  // its Source Control sidebar (the rule above), and this one must sit AFTER
  // that rule to win where it applies.
  { key: 'cmd+shift+g', command: 'workbench.action.openGitWindow', when: 'paneStage && !findOpen' },
  // Navide Browser, beside the built-in plugin windows.
  { key: 'cmd+shift+x', command: 'workbench.action.openBrowser' },
  // Off macOS only, beside the ⌘ rules (which stay as they were): ⌘ is the
  // Win/Super key there, so ⌘⇧D / ⌘⇧G / ⌘⇧I / ⌘⇧X never reached Plans, Git, the
  // Mini IDE or Navide Browser. Ctrl takes the same letter, except the Mini
  // IDE: Ctrl+Shift+I is the menu's toggleDevTools accelerator off macOS, which
  // fires before any renderer rule, so the Mini IDE takes Ctrl+Shift+M (not
  // Ctrl+Alt+I: Ctrl+Alt is AltGr on Windows).
  ...(isMacPlatform() ? [] : [
    { key: 'ctrl+shift+d', command: 'workbench.action.openPlans' },
    { key: 'ctrl+shift+g', command: 'workbench.action.openGitWindow', when: 'paneStage && !findOpen' },
    { key: 'ctrl+shift+m', command: 'workbench.action.openMiniIDE' },
    { key: 'ctrl+shift+x', command: 'workbench.action.openBrowser' },
  ]),

  // ── Voice input ─────────────────────────────────────────────────────────────
  // Hold to talk into the focused CLI pane; releasing any key of the chord
  // stops the take (useVoiceInput). `voiceInput` is set only while the setting
  // is on, so with it off the chord is not consumed and reaches the PTY as
  // before. No Cmd: macOS withholds the keyup of a key held with Cmd, and the
  // release is the whole gesture. No !terminalFocus: a focused CLI pane is
  // exactly where this is meant to be pressed.
  { key: 'ctrl+alt+m', command: 'workbench.action.holdToTalk', when: 'paneStage && voiceInput && !modalOpen' },

  // Only the standalone Git window (GitWindowApp) sets `gitWindow`, and these
  // rules sit LAST so the reversed resolver tries them first: several of these
  // chords are claimed above by workbench commands that the Git window never
  // registers (cmd+shift+a toggleAIChat, cmd+shift+u spawnAgent, cmd+shift+p
  // showCommands, cmd+shift+f findInFiles, cmd+shift+r rebuildFocusedPane) —
  // and an unregistered binding is NOT consumed, so without this ordering the
  // key would fall through into the window's AI dock terminal.
  //
  // '!terminalFocus' everywhere: the Git window embeds an AiCliDock PTY, where
  // every one of these chords belongs to the CLI, not to us.
  { key: 'f5',              command: 'git.refresh',         when: 'gitWindow && !terminalFocus' },
  { key: 'cmd+shift+r',     command: 'git.refresh',         when: 'gitWindow && !terminalFocus' },
  { key: 'cmd+enter',       command: 'git.commit',          when: 'gitWindow && !terminalFocus' },
  { key: 'cmd+shift+enter', command: 'git.amend',           when: 'gitWindow && !terminalFocus' },
  { key: 'cmd+shift+m',     command: 'git.generateMessage', when: 'gitWindow && !terminalFocus' },
  { key: 'cmd+shift+a',     command: 'git.stageAll',        when: 'gitWindow && !terminalFocus' },
  { key: 'cmd+shift+u',     command: 'git.unstageAll',      when: 'gitWindow && !terminalFocus' },
  // Remote operations follow SourceTree's chords (fetch/pull/push), with sync
  // on cmd+shift+s since it is this window's primary toolbar action.
  { key: 'cmd+shift+f',     command: 'git.fetch',           when: 'gitWindow && !terminalFocus' },
  { key: 'cmd+shift+l',     command: 'git.pull',            when: 'gitWindow && !terminalFocus' },
  { key: 'cmd+shift+p',     command: 'git.push',            when: 'gitWindow && !terminalFocus' },
  { key: 'cmd+shift+s',     command: 'git.sync',            when: 'gitWindow && !terminalFocus' },
  // Same chord the Mini IDE uses to jump into its AI dock.
  { key: 'cmd+l',           command: 'git.focusAgent',      when: 'gitWindow && !terminalFocus' },
]
