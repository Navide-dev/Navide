<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { helpKey } from '../lib/helpKeys'

import MockDiff from './helpMocks/MockDiff.vue'
import MockFigure from './helpMocks/MockFigure.vue'
import MockFormRow from './helpMocks/MockFormRow.vue'
import MockPanel from './helpMocks/MockPanel.vue'
import MockToolbar from './helpMocks/MockToolbar.vue'
// Read-only reference for the code workflow surfaces (Git, Plans, Mini-IDE,
// preview), shown inside Settings → Help. Static mirror of the Navide user
// manual, book 4 — every button label, menu item and shortcut below was
// verified against the real components; keep them in sync if those change.
// All prose lives in the locale files under `settings.help.codeWorkflow.*`;
// the tables below keep only their row keys, the literal glyphs and the key
// combinations, which are identical in every language. Every button LABEL is
// read from the product's own locale key, so the help page and the button it
// describes are always saying the same word.

interface FileButtonRow {
  key: string
  glyph: string
  /** The product's own locale keys for this button — one per label, so a row
   *  that offers two of them ("Accept Ours / Accept Theirs") stays one row. */
  meaning: string[]
}

interface EditorSectionRow {
  key: string
  section: string
  shortcut: string
}

interface EditorActionRow {
  key: string
  keys: string[]
  note?: boolean
}

interface ShortcutRow {
  key: string
  keys: string[]
  where: 'main' | 'any' | 'git' | 'plan' | 'ide'
}

// Git: the buttons on a file row.
//
// Glyph columns use the exact character the product paints, so `＋` here is
// U+FF0B, matching GitPane.vue:1974 (Stage All), :2028, :2045 and :2090. Only
// a pure separator gets folded to ASCII; never "normalise" a glyph, because
// then the table stops describing what the user is looking at.
//
// The label beside the glyph is NOT a literal: it is the product's own locale
// key, resolved at render time. A help page that says "Stage" while the button
// under the reader's cursor says 暫存 is describing a different product, and a
// hard-coded English literal here would drift the moment either side moved.
const fileButtons: FileButtonRow[] = [
  { key: 'stage', glyph: '＋', meaning: ['action.stage'] },
  { key: 'discard', glyph: '↩', meaning: ['action.discard'] },
  { key: 'unstage', glyph: '−', meaning: ['action.unstage'] },
  { key: 'history', glyph: '⊡', meaning: ['action.file-history-blame'] },
  { key: 'conflict', glyph: '↰ / ↱', meaning: ['action.accept-ours', 'action.accept-theirs'] },
]

// Git: the ▾ menu next to the Commit button. Glyph painted here, label read
// from the same key the menu item itself uses.
const commitMenu = [
  { key: 'commit', glyph: '✓', label: 'action.commit' },
  { key: 'amend', glyph: '✎', label: 'action.amend-commit' },
  { key: 'push', glyph: '↑', label: 'action.commit-and-push' },
  { key: 'sync', glyph: '⇅', label: 'action.commit-and-sync' },
  { key: 'undo', glyph: '↺', label: 'action.undo-last-commit' },
  { key: 'auto', glyph: '✦', label: 'action.auto-commit' },
] as const

// Git: the remote action row. Both columns are prose, so only the row order
// lives here.
const remoteActions = ['account', 'publish', 'fetch', 'pull', 'push', 'sync', 'more'] as const

// Git: the four ways of looking at a change.
const diffViews = ['file', 'branch', 'inline', 'history'] as const

// Plans: the review toolbar.
const planTools = [
  { key: 'todos', glyph: '☑', label: 'pane.plans.todos' },
  { key: 'notes', glyph: '💬', label: 'pane.plans.review-notes' },
  { key: 'execute', glyph: '▶', label: 'pane.plans.execute' },
  { key: 'approve', glyph: '✓', label: 'pane.plans.review-approve' },
  { key: 'more', glyph: '⋯', label: 'pane.plans.more-actions' },
] as const

// Mini-IDE: the four sections in the left rail, named by the same keys the
// activity bar's own tooltips use (EditorWindowApp.vue:1965-1990).
const editorSections: EditorSectionRow[] = [
  { key: 'explorer', section: 'pane.explorer.title', shortcut: helpKey('workbench.action.focusExplorer') },
  { key: 'search', section: 'pane.search.title', shortcut: helpKey('workbench.action.findInFiles') },
  { key: 'scm', section: 'pane.git.tab', shortcut: helpKey('workbench.action.focusSourceControl') },
  { key: 'problems', section: 'pane.problems.title', shortcut: helpKey('workbench.action.problems.focus') },
]

// Keys are read from the live bindings (this platform plus the user's own
// rules). Split and quick open are handled inside the editor, not by a rule,
// so they keep their macOS glyphs.
const k = helpKey
const uniq = (keys: string[]): string[] => [...new Set(keys)]

// Mini-IDE: the common editing actions. `note` marks the rows that carry a
// parenthetical remark next to the keys.
const editorActions: EditorActionRow[] = [
  { key: 'split', keys: ['⌘\\'], note: true },
  { key: 'findReplace', keys: [k('editor.action.openFind'), k('editor.action.openReplace')] },
  { key: 'findNext', keys: [k('editor.action.nextMatch'), k('editor.action.prevMatch')] },
  { key: 'goto', keys: [k('editor.action.gotoLine'), k('workbench.action.gotoSymbol'), k('workbench.action.gotoWorkspaceSymbol')] },
  { key: 'format', keys: [k('editor.action.formatDocument'), k('editor.action.formatSelection')] },
  { key: 'fold', keys: [k('editor.fold'), k('editor.unfold')], note: true },
  { key: 'multiCursor', keys: [k('editor.action.insertCursorAbove'), k('editor.action.insertCursorBelow')] },
  { key: 'selectNext', keys: [k('editor.action.addSelectionToNextFindMatch'), k('editor.action.selectHighlights')] },
  { key: 'quickFix', keys: [k('editor.action.quickFix')] },
  { key: 'aiRewrite', keys: [k('editor.action.inlineRewrite')] },
  { key: 'aiComplete', keys: [k('editor.action.triggerGhost')] },
  { key: 'aiTerminal', keys: [k('workbench.action.toggleAIChat', 'cmd+j')], note: true },
  { key: 'sendSelection', keys: [k('workbench.action.addSelectionToChat')], note: true },
  { key: 'quickOpen', keys: uniq(['⌘P', k('workbench.action.showCommands')]) },
]

// Preview: the extension decides how a file opens. Both the extension list and
// the rendering are prose, so only the row order lives here.
const previewTypes = [
  'image',
  'video',
  'audio',
  'pdf',
  'html',
  'csv',
  'font',
  'archive',
  'notebook',
  'office',
  'binary',
] as const

// Shortcut cheat sheet. "where" is a condition, not a remark.
const shortcuts: ShortcutRow[] = [
  { key: 'gitTab', keys: [k('controlPane.selectSidebarTab4')], where: 'main' },
  { key: 'plansTab', keys: [k('controlPane.selectSidebarTab5')], where: 'main' },
  { key: 'gitWindow', keys: [k('workbench.action.openGitWindow')], where: 'main' },
  { key: 'editorWindow', keys: [k('workbench.action.openMiniIDE')], where: 'any' },
  { key: 'previewTab', keys: [k('workbench.action.focusPreview')], where: 'main' },
  { key: 'commit', keys: [k('git.commit'), k('git.amend')], where: 'git' },
  { key: 'aiMessage', keys: [k('git.generateMessage')], where: 'git' },
  { key: 'stageAll', keys: [k('git.stageAll'), k('git.unstageAll')], where: 'git' },
  { key: 'fetchPull', keys: [k('git.fetch'), k('git.pull')], where: 'git' },
  { key: 'pushSync', keys: [k('git.push'), k('git.sync')], where: 'git' },
  { key: 'refresh', keys: uniq([k('git.refresh', 'f5'), k('git.refresh', 'cmd+shift+r')]), where: 'git' },
  { key: 'gotoAiTerminal', keys: [k('git.focusAgent')], where: 'git' },
  { key: 'quickOpenPlan', keys: ['⌘P'], where: 'plan' },
  { key: 'escape', keys: ['Esc'], where: 'plan' },
  { key: 'explorerSearch', keys: [k('workbench.action.focusExplorer'), k('workbench.action.findInFiles')], where: 'ide' },
  { key: 'scmProblems', keys: [k('workbench.action.focusSourceControl'), k('workbench.action.problems.focus')], where: 'ide' },
  { key: 'fileTabs', keys: [k('workbench.action.openEditorAtIndex1'), k('workbench.action.openEditorAtIndex9')], where: 'ide' },
  { key: 'split', keys: ['⌘\\'], where: 'ide' },
  { key: 'quickFix', keys: [k('editor.action.quickFix')], where: 'ide' },
  { key: 'aiRewriteComplete', keys: [k('editor.action.inlineRewrite'), k('editor.action.triggerGhost')], where: 'ide' },
  { key: 'aiTerminal', keys: [k('workbench.action.toggleAIChat', 'cmd+j')], where: 'ide' },
  { key: 'cheatsheet', keys: [k('workbench.action.openKeyboardShortcuts')], where: 'ide' },
]
const { t } = useI18n()

// Values the prose interpolates: keys as the live bindings have them, and the
// interface labels read from the keys the product renders.
const prose = computed(() => ({
  gitTab: k('controlPane.selectSidebarTab4'),
  plansTab: k('controlPane.selectSidebarTab5'),
  gitWindow: k('workbench.action.openGitWindow'),
  miniIde: k('workbench.action.openMiniIDE'),
  previewTab: k('workbench.action.focusPreview'),
  editorTab1: k('workbench.action.openEditorAtIndex1'),
  editorTab9: k('workbench.action.openEditorAtIndex9'),
  replaceInFiles: k('workbench.action.findInFilesReplace'),
  prevGroup: k('workbench.action.focusPreviousGroup'),
  nextGroup: k('workbench.action.focusNextGroup'),
  foldAll: k('editor.foldAll'),
  unfoldAll: k('editor.unfoldAll'),
  aiChatAlt: k('workbench.action.toggleAIChat', 'cmd+shift+a'),
  pull: t('action.pull'),
  pullRebase: t('action.pull-rebase'),
  push: t('action.push'),
  pushForce: t('action.push-force-lease'),
  mergeInto: t('action.merge-current-into', { branch: '{branch}' }),
  mergeIntoPush: t('action.merge-current-into-push', { branch: '{branch}' }),
  deleteBranch: t('action.delete-branch'),
  fitWindow: t('preview.fit-window'),
  actualSize: t('preview.actual-size'),
  worktrees: t('label.worktrees'),
  bare: t('label.bare'),
  detached: t('label.detached'),
  locked: t('label.locked'),
  stale: t('label.stale'),
  openWindow: t('action.open-in-new-window'),
  reveal: t('action.reveal-in-finder'),
  lock: t('action.lock'),
  move: t('action.move'),
  remove: t('action.remove'),
  prune: t('action.prune'),
  repair: t('action.repair'),
  createBranch: t('label.create-new-branch'),
  addWorktree: t('action.add-worktree'),
}))

// ── Mock screenshots ────────────────────────────────────────────────────────
// Three HTML pictures of the Git surfaces this topic describes, drawn from
// the plugin's own components. Diff and conflict bodies are drawn as tinted
// bars rather than invented source: a diff is whatever the file says, and
// made-up code would be the one part of the picture that could not be true.

const MARKS = ['\u2460', '\u2461', '\u2462']

function mockLegend(figure: string, rows: string[]): { mark: string; label: string; text: string }[] {
  return rows.map((row, i) => ({
    mark: MARKS[i],
    label: t(`settings.help.codeWorkflow.mock.${figure}.legend.${row}.label`),
    text: t(`settings.help.codeWorkflow.mock.${figure}.legend.${row}.text`),
  }))
}

function sample(key: string): string {
  return t(`settings.help.codeWorkflow.mock.sample.${key}`)
}

const gitLegend = computed(() => mockLegend('git', ['sections', 'status', 'commit']))
const conflictLegend = computed(() => mockLegend('conflict', ['head', 'choices', 'apply']))
const diffLegend = computed(() => mockLegend('diff', ['hunk', 'sides', 'actions']))

// Section headers carry the bulk actions the real ones do, in the same order.
const stagedButtons = computed(() => [{ label: '\u2212' }])
const changesButtons = computed(() => [{ label: '\u21a9', danger: true }, { label: '\uff0b' }])

const conflictChoices = computed(() => [
  { label: t('action.accept-ours'), primary: true },
  { label: t('action.accept-theirs') },
  { label: t('action.accept-both') },
  { label: t('action.edit') },
])
const hunkActions = computed(() => [t('action.stage-hunk'), t('action.discard-hunk')])

// Bar widths only — see the note above about not inventing source lines.
const diffLines = [
  { kind: 'ctx' as const, width: 70 },
  { kind: 'del' as const, width: 55 },
  { kind: 'add' as const, width: 82 },
  { kind: 'add' as const, width: 46 },
  { kind: 'ctx' as const, width: 64 },
]
const conflictLines = [
  { kind: 'del' as const, width: 62 },
  { kind: 'add' as const, width: 78 },
]
</script>

<template>
  <div class="cwh">
    <p class="cwh-intro">{{ $t('settings.help.codeWorkflow.intro', prose) }}</p>

    <!-- ── 1 · The three work surfaces ──────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s1.title', prose) }}</h2>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s1.p1', prose)"></p>

      <div class="cwh-card">
        <div class="cwh-card-head">
          <span class="cwh-card-title">{{ $t('settings.help.codeWorkflow.s1.cards.git.title', prose) }}</span>
          <span class="cwh-tag">{{ $t('settings.help.codeWorkflow.s1.cards.git.tag', prose) }}</span>
        </div>
        <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s1.cards.git.text', prose)"></p>
      </div>

      <div class="cwh-card">
        <div class="cwh-card-head">
          <span class="cwh-card-title">{{ $t('settings.help.codeWorkflow.s1.cards.plans.title', prose) }}</span>
          <span class="cwh-tag">{{ $t('settings.help.codeWorkflow.s1.cards.plans.tag', prose) }}</span>
        </div>
        <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s1.cards.plans.text', prose)"></p>
      </div>

      <div class="cwh-card">
        <div class="cwh-card-head">
          <span class="cwh-card-title">{{ $t('settings.help.codeWorkflow.s1.cards.ide.title', prose) }}</span>
          <span class="cwh-tag">{{ $t('settings.help.codeWorkflow.s1.cards.ide.tag', prose) }}</span>
        </div>
        <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s1.cards.ide.text', prose)"></p>
      </div>

      <div class="cwh-callout">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s1.callout.title', prose) }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s1.callout.text', prose)"></div>
      </div>
    </section>

    <!-- ── 2 · Git: staging and committing ──────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s2.title', prose) }}</h2>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s2.h1', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p1', prose)"></p>

      <MockFigure
        :caption="$t('settings.help.codeWorkflow.mock.git.caption', prose)"
        :legend="gitLegend"
      >
        <MockPanel>
          <MockFormRow :label="sample('message')" badge="\u2726" />
          <MockToolbar
            :buttons="[{ label: '\u2713 ' + $t('action.commit'), primary: true }, { label: '\u25be' }]"
            :mark="MARKS[2]"
          />
        </MockPanel>
        <MockToolbar
          caret
          :label="$t('label.staged-changes')"
          badge="2"
          :buttons="stagedButtons"
          :mark="MARKS[0]"
        />
        <MockFormRow tag="M" tag-tone="warn" :label="sample('fileA')" :hint="sample('dirA')" />
        <MockFormRow tag="A" tag-tone="add" :label="sample('fileB')" :hint="sample('dirB')" />
        <MockToolbar caret :label="$t('label.changes')" badge="3" :buttons="changesButtons" />
        <MockFormRow tag="M" tag-tone="warn" :label="sample('fileC')" :hint="sample('dirC')" :mark="MARKS[1]" />
        <MockFormRow tag="U" tag-tone="muted" :label="sample('fileD')" />
        <MockFormRow tag="!" tag-tone="del" :label="sample('fileA')" :hint="sample('dirA')" />
      </MockFigure>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s2.fileTable.glyph', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s2.fileTable.meaning', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s2.fileTable.where', prose) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in fileButtons" :key="row.key">
              <td class="cwh-nowrap"><code>{{ row.glyph }}</code></td>
              <td>{{ row.meaning.map((k) => $t(k)).join(' / ') }}</td>
              <td>{{ $t(`settings.help.codeWorkflow.s2.fileButtons.${row.key}.where`, prose) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p2', prose)"></p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s2.callout.title', prose) }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s2.callout.text', prose)"></div>
      </div>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s2.h2', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p3', prose)"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p4', prose)"></p>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s2.commitTable.item', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s2.commitTable.what', prose) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in commitMenu" :key="row.key">
              <td class="cwh-nowrap"><code>{{ row.glyph }} {{ $t(row.label) }}</code></td>
              <td>{{ $t(`settings.help.codeWorkflow.s2.commitMenu.${row.key}.what`, prose) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p5', prose)"></p>

      <h3 class="cwh-h3" v-html="$t('settings.help.codeWorkflow.s2.h3', prose)"></h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p6', prose)"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s2.h4', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p7', prose)"></p>
    </section>

    <!-- ── 3 · Git: branches and remotes ────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s3.title', prose) }}</h2>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s3.h1', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s3.p1', prose)"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s3.list.create', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s3.list.localRow', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s3.list.context', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s3.list.remote', prose)"></li>
      </ul>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s3.p2', prose)"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s3.h2', prose) }}</h3>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s3.remoteTable.control', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s3.remoteTable.behavior', prose) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in remoteActions" :key="key">
              <td class="cwh-nowrap">{{ $t(`settings.help.codeWorkflow.s3.remoteActions.${key}.control`, prose) }}</td>
              <td>{{ $t(`settings.help.codeWorkflow.s3.remoteActions.${key}.behavior`, prose) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s3.p3', prose)"></p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s3.callout.title', prose) }}</div>
        <div class="cwh-callout-text">{{ $t('settings.help.codeWorkflow.s3.callout.text', prose) }}</div>
      </div>

      <h3 class="cwh-h3">{{ $t('label.worktrees') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s3.worktrees.p1', prose)"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s3.worktrees.p2', prose)"></p>
    </section>

    <!-- ── 4 · Git: conflicts, drafts and history ───────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s4.title', prose) }}</h2>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s4.h1', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s4.p1', prose)"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s4.p2', prose)"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.badge', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.choices', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.base', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.apply', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.binary', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.agent', prose)"></li>
      </ul>

      <MockFigure
        :caption="$t('settings.help.codeWorkflow.mock.conflict.caption', prose)"
        :legend="conflictLegend"
      >
        <MockPanel>
          <MockToolbar
            :label="sample('fileA')"
            :chip="$t('label.conflict')"
            chip-tone="crit"
            :note="sample('progress')"
            :buttons="[{ label: sample('base') }, { label: sample('apply'), primary: true }]"
            :mark="MARKS[0]"
          />
          <MockToolbar
            :label="`${sample('conflictNo')}  \u25c0 ${sample('ours')}  vs  \u25b6 ${sample('theirs')}`"
            :buttons="conflictChoices"
            :mark="MARKS[1]"
          />
          <MockDiff :header="sample('hunk')" :lines="conflictLines" />
        </MockPanel>
      </MockFigure>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s4.h2', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s4.p3', prose)"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s4.draftList.save', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.draftList.restore', prose)"></li>
      </ul>
      <p class="cwh-note">{{ $t('settings.help.codeWorkflow.s4.note', prose) }}</p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s4.h3', prose) }}</h3>

      <MockFigure
        :caption="$t('settings.help.codeWorkflow.mock.diff.caption', prose)"
        :legend="diffLegend"
      >
        <MockPanel>
          <MockToolbar :label="sample('fileB')" :note="sample('dirB')" />
          <MockDiff
            split
            :header="sample('hunk')"
            :lines="diffLines"
            :actions="hunkActions"
            :mark="MARKS[0]"
          />
        </MockPanel>
      </MockFigure>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s4.diffTable.how', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s4.diffTable.what', prose) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in diffViews" :key="key">
              <td>{{ $t(`settings.help.codeWorkflow.s4.diffViews.${key}.how`, prose) }}</td>
              <td>{{ $t(`settings.help.codeWorkflow.s4.diffViews.${key}.what`, prose) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s4.p4', prose)"></p>

      <div class="cwh-callout">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s4.callout.title', prose) }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s4.callout.text', prose)"></div>
      </div>
    </section>

    <!-- ── 5 · Plans: the list and the lifecycle ────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s5.title', prose) }}</h2>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s5.h1', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p1', prose)"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p2', prose)"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s5.h2', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p3', prose)"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s5.listTools.search', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s5.listTools.stage', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s5.listTools.sort', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s5.listTools.group', prose)"></li>
      </ul>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p4', prose)"></p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s5.callout1.title', prose) }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s5.callout1.text', prose)"></div>
      </div>

      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p5', prose)"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s5.h3', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p6', prose)"></p>
      <div class="cwh-callout">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s5.callout2.title', prose) }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s5.callout2.text', prose)"></div>
      </div>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p7', prose)"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s5.h4', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p8', prose)"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p9', prose)"></p>
    </section>

    <!-- ── 6 · Plans: the review toolbox ────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s6.title', prose) }}</h2>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s6.p1', prose)"></p>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s6.toolsTable.tool', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s6.toolsTable.opens', prose) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in planTools" :key="row.key">
              <td class="cwh-nowrap">{{ row.glyph }} {{ $t(row.label) }}</td>
              <td v-html="$t(`settings.help.codeWorkflow.s6.planTools.${row.key}.opens`, prose)"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s6.callout.title', prose) }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s6.callout.text', prose)"></div>
      </div>

      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s6.p2', prose)"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s6.moreList.outline', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s6.moreList.history', prose)"></li>
      </ul>

      <p class="cwh-note" v-html="$t('settings.help.codeWorkflow.s6.note', prose)"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s6.h1', prose) }}</h3>
      <p class="cwh-p">{{ $t('settings.help.codeWorkflow.s6.p3', prose) }}</p>
    </section>

    <!-- ── 10 · Plans runs as a bundled plugin ──────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s10.title', prose) }}</h2>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s10.p1', prose)"></p>
      <p class="cwh-p">{{ $t('settings.help.codeWorkflow.s10.p2', prose) }}</p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s10.h1', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s10.p3', prose)"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s10.list.retry', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s10.list.repair', prose)"></li>
      </ul>
      <p class="cwh-note" v-html="$t('settings.help.codeWorkflow.s10.p4', prose)"></p>
    </section>

    <!-- ── 7 · The editor window ────────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s7.title', prose) }}</h2>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s7.p1', prose)"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s7.h1', prose) }}</h3>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s7.sectionTable.section', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s7.sectionTable.key', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s7.sectionTable.note', prose) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in editorSections" :key="row.key">
              <td class="cwh-nowrap">{{ $t(row.section) }}</td>
              <td class="cwh-nowrap"><kbd class="cwh-kbd">{{ row.shortcut }}</kbd></td>
              <td>{{ $t(`settings.help.codeWorkflow.s7.editorSections.${row.key}.note`, prose) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-note" v-html="$t('settings.help.codeWorkflow.s7.note1', prose)"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s7.h2', prose) }}</h3>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s7.actionTable.action', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s7.actionTable.keys', prose) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in editorActions" :key="row.key">
              <td>{{ $t(`settings.help.codeWorkflow.s7.editorActions.${row.key}.action`, prose) }}</td>
              <td class="cwh-keycell">
                <template v-for="(key, i) in row.keys" :key="i">
                  <span v-if="i > 0" class="cwh-keysep">/</span>
                  <kbd class="cwh-kbd">{{ key }}</kbd>
                </template>
                <span v-if="row.note" class="cwh-keynote">{{
                  $t(`settings.help.codeWorkflow.s7.editorActions.${row.key}.note`, prose)
                }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-note" v-html="$t('settings.help.codeWorkflow.s7.note2', prose)"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s7.h3', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s7.p2', prose)"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s7.p3', prose)"></p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s7.callout.title', prose) }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s7.callout.text', prose)"></div>
      </div>

      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s7.p4', prose)"></p>
    </section>

    <!-- ── 8 · File preview and the change record track ─────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s8.title', prose) }}</h2>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s8.h1', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s8.p1', prose)"></p>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s8.previewTable.kind', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s8.previewTable.ext', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s8.previewTable.how', prose) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="kind in previewTypes" :key="kind">
              <td class="cwh-nowrap">{{ kind }}</td>
              <td><code>{{ $t(`settings.help.codeWorkflow.s8.previewTypes.${kind}.ext`, prose) }}</code></td>
              <td>{{ $t(`settings.help.codeWorkflow.s8.previewTypes.${kind}.how`, prose) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s8.p2', prose)"></p>

      <div class="cwh-callout">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s8.callout1.title', prose) }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s8.callout1.text', prose)"></div>
      </div>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s8.h2', prose) }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s8.p3', prose)"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s8.trackList.time', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s8.trackList.action', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s8.trackList.path', prose)"></li>
        <li v-html="$t('settings.help.codeWorkflow.s8.trackList.who', prose)"></li>
      </ul>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s8.p4', prose)"></p>

      <div class="cwh-callout">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s8.callout2.title', prose) }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s8.callout2.text', prose)"></div>
      </div>
    </section>

    <!-- ── 9 · Shortcut cheat sheet ─────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s9.title', prose) }}</h2>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s9.p1', prose)"></p>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s9.shortcutTable.keys', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s9.shortcutTable.action', prose) }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s9.shortcutTable.where', prose) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in shortcuts" :key="row.key">
              <td class="cwh-keycell">
                <template v-for="(key, i) in row.keys" :key="i">
                  <span v-if="i > 0" class="cwh-keysep">/</span>
                  <kbd class="cwh-kbd">{{ key }}</kbd>
                </template>
              </td>
              <td>{{ $t(`settings.help.codeWorkflow.s9.rows.${row.key}.action`, prose) }}</td>
              <td class="cwh-nowrap">{{ $t(`settings.help.codeWorkflow.s9.where.${row.where}`, prose) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s9.callout.title', prose) }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s9.callout.text', prose)"></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cwh {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: var(--settings-page-max);
}

.cwh-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.cwh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cwh-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
}
.cwh-h3 {
  margin: 6px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-primary);
}
.cwh-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}
.cwh-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}
.cwh-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cwh-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cwh-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cwh-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}
.cwh-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.cwh-callout--warn .cwh-callout-title {
  color: var(--attention-fg);
}

.cwh-card {
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cwh-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.cwh-card-title {
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}
.cwh-tag {
  font-size: var(--font-2xs);
  font-weight: 600;
  border-radius: 99px;
  padding: 1px 8px;
  background: var(--accent-subtle);
  color: var(--accent-fg);
}

.cwh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.cwh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-xs);
}
.cwh-table th,
.cwh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.cwh-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.cwh-table tr:last-child td { border-bottom: none; }
.cwh-nowrap { white-space: nowrap; }

.cwh-keycell {
  white-space: nowrap;
}
.cwh-keysep {
  color: var(--text-secondary);
  margin: 0 4px;
}
.cwh-keynote {
  color: var(--text-secondary);
  white-space: normal;
}

/* `code` and `.cwh-kbd` also appear inside v-html prose, which carries no
   scoped data-v attribute — hence :deep(). */
.cwh :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}

.cwh :deep(.cwh-kbd) {
  display: inline-block;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.9em;
  line-height: 1.4;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 0 5px;
  color: var(--text-bright);
  white-space: nowrap;
}
</style>
