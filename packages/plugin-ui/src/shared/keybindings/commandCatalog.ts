// The command manifest, and human-readable names for command ids.
//
// Two problems are solved here.
//
// 1. There is no runtime way to enumerate every command. registerCommand is
//    called from four root components in four separate windows, each with its
//    own module instance, so the main window's registry only ever holds ~32 of
//    them. Settings needs the whole set to let a user bind a command that ships
//    with no default key, hence the static COMMAND_IDS list below. Its
//    companion test scans the source and fails if the two drift apart.
//
// 2. Commands carry no metadata at their call sites, so labels are derived from
//    the id rather than by widening registerCommand in ~190 places. Ids follow a
//    strict `<category>.<maybe 'action'>.<verbPhrase>` shape, which humanizes
//    cleanly; the override map below only covers the handful that do not.

export interface CommandInfo {
  id: string
  label: string
  category: string
}

const CATEGORY_LABELS: Record<string, string> = {
  workbench: 'Workbench',
  editor: 'Editor',
  git: 'Git',
  controlPane: 'CLI Panes',
  ui: 'External Control',
}

// Applied per word after splitting, so 'Cli' inside 'Select Cli Type 1' is fixed
// without touching words that merely contain those letters.
const ACRONYMS: Record<string, string> = {
  Cli: 'CLI',
  Ai: 'AI',
  Ide: 'IDE',
  Os: 'OS',
  Ui: 'UI',
  Url: 'URL',
}

// Ids whose humanized form would be wrong or unhelpful.
const LABEL_OVERRIDES: Record<string, string> = {
  'editor.action.addSelectionToNextFindMatch': 'Add Selection To Next Find Match',
  'editor.action.smartSelect.expand': 'Expand Selection',
  'editor.action.smartSelect.shrink': 'Shrink Selection',
  'editor.action.marker.nextInFiles': 'Next Problem In Files',
  'editor.action.marker.prevInFiles': 'Previous Problem In Files',
  'workbench.action.gotoWorkspaceSymbol': 'Go To Symbol In Workspace',
  'workbench.action.gotoSymbol': 'Go To Symbol In File',
  'workbench.action.showCommands': 'Show Command Palette',
  'workbench.action.quickOpen': 'Quick Open File',
  // 'changeEOLtoLF' defeats the acronym splitter: it reads 'EOL' + 'to' as
  // 'EO' + 'Lto'. Not worth a special case in the splitter for two ids.
  'editor.action.changeEOLtoLF': 'Change End Of Line To LF',
  'editor.action.changeEOLtoCRLF': 'Change End Of Line To CRLF',
}

function humanizeWords(segment: string): string {
  return segment
    // Acronym followed by a word, e.g. 'AIChat' → 'AI Chat'. Must run before
    // the lower→upper split, which cannot see a boundary inside a capital run.
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const cased = word.charAt(0).toUpperCase() + word.slice(1)
      return ACRONYMS[cased] ?? cased
    })
    .join(' ')
}

/**
 * i18n key for a command's title. Dots become underscores because vue-i18n
 * reads a dot as a path separator, and a command id is full of them.
 */
export function commandI18nKey(id: string): string {
  return `settings.keybindings.cmd.${id.replace(/\./g, '_')}`
}

export function describeCommand(id: string): CommandInfo {
  if (!id) return { id, label: 'Unbound', category: 'Unbound' }

  const segments = id.split('.')
  const head = segments[0]
  const category = CATEGORY_LABELS[head] ?? humanizeWords(head)

  const override = LABEL_OVERRIDES[id]
  if (override) return { id, label: override, category }

  // Drop the category and the noise-word 'action' before humanizing the rest.
  const rest = segments.slice(1).filter((s) => s !== 'action')
  const label = rest.length ? rest.map(humanizeWords).join(' ') : humanizeWords(head)
  return { id, label, category }
}

/**
 * Every command the app registers, including the ones that ship without a
 * default key — those are exactly the commands a user most wants to bind, and
 * they are invisible unless listed here.
 *
 * Kept in sync by `commandManifest.test.ts`, which scans the source for
 * `registerCommand('...')` literals and for the commands `defaults.ts` binds.
 * The second source matters because three families are registered in loops
 * (`controlPane.selectCliType${i}`, `editor.foldLevel${n}`,
 * `workbench.action.openEditorAtIndex${_i}`) and carry no literal id to scan.
 * A loop-registered command that also has no default binding would be invisible
 * to both scans — add it by hand if one ever appears.
 *
 * `ui.*` is deliberately excluded: those exist to be driven by external MCP
 * clients through ui_invoke, not by a keystroke. Listing them would put a dozen
 * entries a user has no reason to recognise into the editor, and binding one
 * does nothing useful. `commandManifest.test.ts` asserts they stay out.
 */
export const COMMAND_IDS: readonly string[] = [
  'controlPane.selectCliType1',
  'controlPane.selectCliType2',
  'controlPane.selectCliType3',
  'controlPane.selectCliType4',
  'controlPane.selectCliType5',
  'controlPane.selectCliType6',
  'controlPane.selectCliType7',
  'controlPane.selectCliType8',
  'controlPane.selectCliType9',
  'controlPane.selectSidebarTab1',
  'controlPane.selectSidebarTab2',
  'controlPane.selectSidebarTab3',
  'controlPane.selectSidebarTab4',
  'controlPane.selectSidebarTab5',
  'editor.action.addLineComment',
  'editor.action.addSelectionToNextFindMatch',
  'editor.action.blockComment',
  'editor.action.changeEOLtoCRLF',
  'editor.action.changeEOLtoLF',
  'editor.action.cursorBottom',
  'editor.action.cursorBottomSelect',
  'editor.action.cursorLineEnd',
  'editor.action.cursorLineEndSelect',
  'editor.action.cursorLineStart',
  'editor.action.cursorLineStartSelect',
  'editor.action.cursorTop',
  'editor.action.cursorTopSelect',
  'editor.action.cursorWordLeft',
  'editor.action.cursorWordLeftSelect',
  'editor.action.cursorWordRight',
  'editor.action.cursorWordRightSelect',
  'editor.action.deleteAllLeft',
  'editor.action.deleteAllRight',
  'editor.action.deleteLines',
  'editor.action.deleteWordLeft',
  'editor.action.deleteWordRight',
  'editor.action.detectIndentation',
  'editor.action.duplicateLineDown',
  'editor.action.duplicateLineUp',
  'editor.action.findReferences',
  'editor.action.fontZoomIn',
  'editor.action.fontZoomOut',
  'editor.action.fontZoomReset',
  'editor.action.formatDocument',
  'editor.action.formatSelection',
  'editor.action.gotoLine',
  'editor.action.indentLines',
  'editor.action.indentationToSpaces',
  'editor.action.indentationToTabs',
  'editor.action.inlineRewrite',
  'editor.action.insertCursorAbove',
  'editor.action.insertCursorAtEndOfEachLineSelected',
  'editor.action.insertCursorBelow',
  'editor.action.insertLineAfter',
  'editor.action.insertLineBefore',
  'editor.action.joinLines',
  'editor.action.jumpToBracket',
  'editor.action.marker.nextInFiles',
  'editor.action.marker.prevInFiles',
  'editor.action.moveLineDown',
  'editor.action.moveLineUp',
  'editor.action.moveSelectionToNextFindMatch',
  'editor.action.navigateToLastEditLocation',
  'editor.action.nextMatch',
  'editor.action.openFileAtCursor',
  'editor.action.openFind',
  'editor.action.openLink',
  'editor.action.openReplace',
  'editor.action.outdentLines',
  'editor.action.prevMatch',
  'editor.action.quickFix',
  'editor.action.redo',
  'editor.action.removeDuplicateLines',
  'editor.action.removeLineComment',
  'editor.action.renameSymbol',
  'editor.action.reverseLines',
  'editor.action.save',
  'editor.action.scrollLineDown',
  'editor.action.scrollLineUp',
  'editor.action.selectAll',
  'editor.action.selectCurrentWord',
  'editor.action.selectHighlights',
  'editor.action.selectLine',
  'editor.action.selectToBracket',
  'editor.action.smartSelect.expand',
  'editor.action.smartSelect.shrink',
  'editor.action.sortLinesAscending',
  'editor.action.sortLinesDescending',
  'editor.action.toggleComment',
  'editor.action.toggleLineNumbers',
  'editor.action.toggleWordWrap',
  'editor.action.transformFromBase64',
  'editor.action.transformFromUrlEncoded',
  'editor.action.transformToBase64',
  'editor.action.transformToCamelCase',
  'editor.action.transformToKebabCase',
  'editor.action.transformToLowercase',
  'editor.action.transformToPascalCase',
  'editor.action.transformToSnakeCase',
  'editor.action.transformToTitlecase',
  'editor.action.transformToUppercase',
  'editor.action.transformToUrlEncoded',
  'editor.action.transpose',
  'editor.action.triggerGhost',
  'editor.action.trimTrailingWhitespace',
  'editor.action.undo',
  'editor.action.useSelectionForFind',
  'editor.fold',
  'editor.foldAll',
  'editor.foldLevel1',
  'editor.foldLevel2',
  'editor.foldLevel3',
  'editor.foldLevel4',
  'editor.foldLevel5',
  'editor.foldLevel6',
  'editor.foldLevel7',
  'editor.foldRecursively',
  'editor.toggleFold',
  'editor.unfold',
  'editor.unfoldAll',
  'editor.unfoldRecursively',
  'git.amend',
  'git.commit',
  'git.fetch',
  'git.focusAgent',
  'git.generateMessage',
  'git.pull',
  'git.push',
  'git.refresh',
  'git.stageAll',
  'git.sync',
  'git.unstageAll',
  'workbench.action.addSelectionToChat',
  'workbench.action.changeLanguageMode',
  'workbench.action.closeActiveEditor',
  'workbench.action.closeActivePane',
  'workbench.action.closeAllEditors',
  'workbench.action.closeEditorsToTheLeft',
  'workbench.action.closeEditorsToTheRight',
  'workbench.action.closeModal',
  'workbench.action.closeOtherEditors',
  'workbench.action.closeWindow',
  'workbench.action.copyFilePath',
  'workbench.action.copyRelativeFilePath',
  'workbench.action.findInFiles',
  'workbench.action.findInFilesReplace',
  'workbench.action.focusActiveEditorGroup',
  'workbench.action.focusExplorer',
  'workbench.action.focusNextGroup',
  'workbench.action.focusNextPane',
  'workbench.action.focusPipeline',
  'workbench.action.focusPreview',
  'workbench.action.focusPreviousGroup',
  'workbench.action.focusPreviousPane',
  'workbench.action.focusSourceControl',
  'workbench.action.gotoSymbol',
  'workbench.action.gotoWorkspaceSymbol',
  'workbench.action.holdToTalk',
  'workbench.action.moveEditorLeftInGroup',
  'workbench.action.moveEditorRightInGroup',
  'workbench.action.navigateBack',
  'workbench.action.navigateForward',
  'workbench.action.newFile',
  'workbench.action.newWindow',
  'workbench.action.openBrowser',
  'workbench.action.openDebug',
  'workbench.action.openEditorAtIndex1',
  'workbench.action.openEditorAtIndex2',
  'workbench.action.openEditorAtIndex3',
  'workbench.action.openEditorAtIndex4',
  'workbench.action.openEditorAtIndex5',
  'workbench.action.openEditorAtIndex6',
  'workbench.action.openEditorAtIndex7',
  'workbench.action.openEditorAtIndex8',
  'workbench.action.openEditorAtIndex9',
  'workbench.action.openFile',
  'workbench.action.openFolder',
  'workbench.action.openGitWindow',
  'workbench.action.openKeyboardShortcuts',
  'workbench.action.openMiniIDE',
  'workbench.action.openNextEditor',
  'workbench.action.openPipelineManager',
  'workbench.action.openPlans',
  'workbench.action.openPreviousEditor',
  'workbench.action.openSettings',
  'workbench.action.openSettingsAccounts',
  'workbench.action.openSettingsChannels',
  'workbench.action.problems.focus',
  'workbench.action.quickOpen',
  'workbench.action.rebuildFocusedPane',
  'workbench.action.reloadWindow',
  'workbench.action.reopenClosedEditor',
  'workbench.action.revealFileInOS',
  'workbench.action.revealInExplorer',
  'workbench.action.saveAll',
  'workbench.action.selectTheme',
  'workbench.action.showCommands',
  'workbench.action.spawnAgent',
  'workbench.action.splitEditor',
  'workbench.action.toggleAIChat',
  'workbench.action.toggleSidebar',
  'workbench.action.toggleZenMode',
  'workbench.action.zoomUiIn',
  'workbench.action.zoomUiOut',
  'workbench.action.zoomUiReset',
]
