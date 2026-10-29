<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

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
  { key: 'explorer', section: 'pane.explorer.title', shortcut: '⌘⇧E' },
  { key: 'search', section: 'pane.search.title', shortcut: '⌘⇧F' },
  { key: 'scm', section: 'pane.git.tab', shortcut: '⌘⇧G' },
  { key: 'problems', section: 'pane.problems.title', shortcut: '⌘⇧M' },
]

// Mini-IDE: the common editing actions. `note` marks the rows that carry a
// parenthetical remark next to the keys.
const editorActions: EditorActionRow[] = [
  { key: 'split', keys: ['⌘\\'], note: true },
  { key: 'findReplace', keys: ['⌘F', '⌘⌥F'] },
  { key: 'findNext', keys: ['⌘G', '⌘⇧G'] },
  { key: 'goto', keys: ['⌘L', '⌘⇧O', '⌘T'] },
  { key: 'format', keys: ['⇧⌥F', '⌘K ⌘F'] },
  { key: 'fold', keys: ['⌘⌥[', '⌘⌥]'], note: true },
  { key: 'multiCursor', keys: ['⌘⌥↑', '⌘⌥↓'] },
  { key: 'selectNext', keys: ['⌘D', '⌘⇧L'] },
  { key: 'quickFix', keys: ['⌘.'] },
  { key: 'aiRewrite', keys: ['⌘K ⌘K'] },
  { key: 'aiComplete', keys: ['⌘I'] },
  { key: 'aiTerminal', keys: ['⌘J'], note: true },
  { key: 'sendSelection', keys: ['⌘⇧L'], note: true },
  { key: 'quickOpen', keys: ['⌘P', '⌘⇧P'] },
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
  { key: 'gitTab', keys: ['⌘4'], where: 'main' },
  { key: 'plansTab', keys: ['⌘5'], where: 'main' },
  { key: 'gitWindow', keys: ['⌘⇧G'], where: 'main' },
  { key: 'editorWindow', keys: ['⌘⇧I'], where: 'any' },
  { key: 'previewTab', keys: ['⌘⌥V'], where: 'main' },
  { key: 'commit', keys: ['⌘↩', '⌘⇧↩'], where: 'git' },
  { key: 'aiMessage', keys: ['⌘⇧M'], where: 'git' },
  { key: 'stageAll', keys: ['⌘⇧A', '⌘⇧U'], where: 'git' },
  { key: 'fetchPull', keys: ['⌘⇧F', '⌘⇧L'], where: 'git' },
  { key: 'pushSync', keys: ['⌘⇧P', '⌘⇧S'], where: 'git' },
  { key: 'refresh', keys: ['F5', '⌘⇧R'], where: 'git' },
  { key: 'gotoAiTerminal', keys: ['⌘L'], where: 'git' },
  { key: 'quickOpenPlan', keys: ['⌘P'], where: 'plan' },
  { key: 'escape', keys: ['Esc'], where: 'plan' },
  { key: 'explorerSearch', keys: ['⌘⇧E', '⌘⇧F'], where: 'ide' },
  { key: 'scmProblems', keys: ['⌘⇧G', '⌘⇧M'], where: 'ide' },
  { key: 'fileTabs', keys: ['⌘1', '⌘9'], where: 'ide' },
  { key: 'split', keys: ['⌘\\'], where: 'ide' },
  { key: 'quickFix', keys: ['⌘.'], where: 'ide' },
  { key: 'aiRewriteComplete', keys: ['⌘K ⌘K', '⌘I'], where: 'ide' },
  { key: 'aiTerminal', keys: ['⌘J'], where: 'ide' },
  { key: 'cheatsheet', keys: ['⌘K ⌘S'], where: 'ide' },
]
const { t } = useI18n()

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
    <p class="cwh-intro">{{ $t('settings.help.codeWorkflow.intro') }}</p>

    <!-- ── 1 · The three work surfaces ──────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s1.title') }}</h2>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s1.p1')"></p>

      <div class="cwh-card">
        <div class="cwh-card-head">
          <span class="cwh-card-title">{{ $t('settings.help.codeWorkflow.s1.cards.git.title') }}</span>
          <span class="cwh-tag">{{ $t('settings.help.codeWorkflow.s1.cards.git.tag') }}</span>
        </div>
        <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s1.cards.git.text')"></p>
      </div>

      <div class="cwh-card">
        <div class="cwh-card-head">
          <span class="cwh-card-title">{{ $t('settings.help.codeWorkflow.s1.cards.plans.title') }}</span>
          <span class="cwh-tag">{{ $t('settings.help.codeWorkflow.s1.cards.plans.tag') }}</span>
        </div>
        <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s1.cards.plans.text')"></p>
      </div>

      <div class="cwh-card">
        <div class="cwh-card-head">
          <span class="cwh-card-title">{{ $t('settings.help.codeWorkflow.s1.cards.ide.title') }}</span>
          <span class="cwh-tag">{{ $t('settings.help.codeWorkflow.s1.cards.ide.tag') }}</span>
        </div>
        <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s1.cards.ide.text')"></p>
      </div>

      <div class="cwh-callout">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s1.callout.title') }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s1.callout.text')"></div>
      </div>
    </section>

    <!-- ── 2 · Git: staging and committing ──────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s2.title') }}</h2>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s2.h1') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p1')"></p>

      <MockFigure
        :caption="$t('settings.help.codeWorkflow.mock.git.caption')"
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
              <th>{{ $t('settings.help.codeWorkflow.s2.fileTable.glyph') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s2.fileTable.meaning') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s2.fileTable.where') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in fileButtons" :key="row.key">
              <td class="cwh-nowrap"><code>{{ row.glyph }}</code></td>
              <td>{{ row.meaning.map((k) => $t(k)).join(' / ') }}</td>
              <td>{{ $t(`settings.help.codeWorkflow.s2.fileButtons.${row.key}.where`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p2')"></p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s2.callout.title') }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s2.callout.text')"></div>
      </div>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s2.h2') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p3')"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p4')"></p>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s2.commitTable.item') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s2.commitTable.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in commitMenu" :key="row.key">
              <td class="cwh-nowrap"><code>{{ row.glyph }} {{ $t(row.label) }}</code></td>
              <td>{{ $t(`settings.help.codeWorkflow.s2.commitMenu.${row.key}.what`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p5')"></p>

      <h3 class="cwh-h3" v-html="$t('settings.help.codeWorkflow.s2.h3')"></h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p6')"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s2.h4') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s2.p7')"></p>
    </section>

    <!-- ── 3 · Git: branches and remotes ────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s3.title') }}</h2>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s3.h1') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s3.p1')"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s3.list.create')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s3.list.localRow')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s3.list.context')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s3.list.remote')"></li>
      </ul>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s3.p2')"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s3.h2') }}</h3>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s3.remoteTable.control') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s3.remoteTable.behavior') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in remoteActions" :key="key">
              <td class="cwh-nowrap">{{ $t(`settings.help.codeWorkflow.s3.remoteActions.${key}.control`) }}</td>
              <td>{{ $t(`settings.help.codeWorkflow.s3.remoteActions.${key}.behavior`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s3.p3')"></p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s3.callout.title') }}</div>
        <div class="cwh-callout-text">{{ $t('settings.help.codeWorkflow.s3.callout.text') }}</div>
      </div>
    </section>

    <!-- ── 4 · Git: conflicts, drafts and history ───────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s4.title') }}</h2>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s4.h1') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s4.p1')"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s4.p2')"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.badge')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.choices')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.base')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.apply')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.binary')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.conflictList.agent')"></li>
      </ul>

      <MockFigure
        :caption="$t('settings.help.codeWorkflow.mock.conflict.caption')"
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

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s4.h2') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s4.p3')"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s4.draftList.save')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s4.draftList.restore')"></li>
      </ul>
      <p class="cwh-note">{{ $t('settings.help.codeWorkflow.s4.note') }}</p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s4.h3') }}</h3>

      <MockFigure
        :caption="$t('settings.help.codeWorkflow.mock.diff.caption')"
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
              <th>{{ $t('settings.help.codeWorkflow.s4.diffTable.how') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s4.diffTable.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in diffViews" :key="key">
              <td>{{ $t(`settings.help.codeWorkflow.s4.diffViews.${key}.how`) }}</td>
              <td>{{ $t(`settings.help.codeWorkflow.s4.diffViews.${key}.what`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s4.p4')"></p>

      <div class="cwh-callout">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s4.callout.title') }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s4.callout.text')"></div>
      </div>
    </section>

    <!-- ── 5 · Plans: the list and the lifecycle ────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s5.title') }}</h2>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s5.h1') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p1')"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p2')"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s5.h2') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p3')"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s5.listTools.search')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s5.listTools.stage')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s5.listTools.sort')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s5.listTools.group')"></li>
      </ul>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p4')"></p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s5.callout1.title') }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s5.callout1.text')"></div>
      </div>

      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p5')"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s5.h3') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p6')"></p>
      <div class="cwh-callout">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s5.callout2.title') }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s5.callout2.text')"></div>
      </div>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p7')"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s5.h4') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p8')"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s5.p9')"></p>
    </section>

    <!-- ── 6 · Plans: the review toolbox ────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s6.title') }}</h2>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s6.p1')"></p>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s6.toolsTable.tool') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s6.toolsTable.opens') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in planTools" :key="row.key">
              <td class="cwh-nowrap">{{ row.glyph }} {{ $t(row.label) }}</td>
              <td v-html="$t(`settings.help.codeWorkflow.s6.planTools.${row.key}.opens`)"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s6.callout.title') }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s6.callout.text')"></div>
      </div>

      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s6.p2')"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s6.moreList.outline')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s6.moreList.history')"></li>
      </ul>

      <p class="cwh-note" v-html="$t('settings.help.codeWorkflow.s6.note')"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s6.h1') }}</h3>
      <p class="cwh-p">{{ $t('settings.help.codeWorkflow.s6.p3') }}</p>
    </section>

    <!-- ── 10 · Plans runs as a bundled plugin ──────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s10.title') }}</h2>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s10.p1')"></p>
      <p class="cwh-p">{{ $t('settings.help.codeWorkflow.s10.p2') }}</p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s10.h1') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s10.p3')"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s10.list.retry')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s10.list.repair')"></li>
      </ul>
      <p class="cwh-note" v-html="$t('settings.help.codeWorkflow.s10.p4')"></p>
    </section>

    <!-- ── 7 · The editor window ────────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s7.title') }}</h2>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s7.p1')"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s7.h1') }}</h3>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s7.sectionTable.section') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s7.sectionTable.key') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s7.sectionTable.note') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in editorSections" :key="row.key">
              <td class="cwh-nowrap">{{ $t(row.section) }}</td>
              <td class="cwh-nowrap"><kbd class="cwh-kbd">{{ row.shortcut }}</kbd></td>
              <td>{{ $t(`settings.help.codeWorkflow.s7.editorSections.${row.key}.note`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-note" v-html="$t('settings.help.codeWorkflow.s7.note1')"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s7.h2') }}</h3>
      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s7.actionTable.action') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s7.actionTable.keys') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in editorActions" :key="row.key">
              <td>{{ $t(`settings.help.codeWorkflow.s7.editorActions.${row.key}.action`) }}</td>
              <td class="cwh-keycell">
                <template v-for="(key, i) in row.keys" :key="key">
                  <span v-if="i > 0" class="cwh-keysep">/</span>
                  <kbd class="cwh-kbd">{{ key }}</kbd>
                </template>
                <span v-if="row.note" class="cwh-keynote">{{
                  $t(`settings.help.codeWorkflow.s7.editorActions.${row.key}.note`)
                }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cwh-note" v-html="$t('settings.help.codeWorkflow.s7.note2')"></p>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s7.h3') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s7.p2')"></p>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s7.p3')"></p>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s7.callout.title') }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s7.callout.text')"></div>
      </div>

      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s7.p4')"></p>
    </section>

    <!-- ── 8 · File preview and the change record track ─────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s8.title') }}</h2>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s8.h1') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s8.p1')"></p>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s8.previewTable.kind') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s8.previewTable.ext') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s8.previewTable.how') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="kind in previewTypes" :key="kind">
              <td class="cwh-nowrap">{{ kind }}</td>
              <td><code>{{ $t(`settings.help.codeWorkflow.s8.previewTypes.${kind}.ext`) }}</code></td>
              <td>{{ $t(`settings.help.codeWorkflow.s8.previewTypes.${kind}.how`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s8.p2')"></p>

      <div class="cwh-callout">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s8.callout1.title') }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s8.callout1.text')"></div>
      </div>

      <h3 class="cwh-h3">{{ $t('settings.help.codeWorkflow.s8.h2') }}</h3>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s8.p3')"></p>
      <ul class="cwh-list">
        <li v-html="$t('settings.help.codeWorkflow.s8.trackList.time')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s8.trackList.action')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s8.trackList.path')"></li>
        <li v-html="$t('settings.help.codeWorkflow.s8.trackList.who')"></li>
      </ul>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s8.p4')"></p>

      <div class="cwh-callout">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s8.callout2.title') }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s8.callout2.text')"></div>
      </div>
    </section>

    <!-- ── 9 · Shortcut cheat sheet ─────────────────────────────────── -->
    <section class="cwh-section">
      <h2 class="cwh-h2">{{ $t('settings.help.codeWorkflow.s9.title') }}</h2>
      <p class="cwh-p" v-html="$t('settings.help.codeWorkflow.s9.p1')"></p>

      <div class="cwh-tablewrap">
        <table class="cwh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.codeWorkflow.s9.shortcutTable.keys') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s9.shortcutTable.action') }}</th>
              <th>{{ $t('settings.help.codeWorkflow.s9.shortcutTable.where') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in shortcuts" :key="row.key">
              <td class="cwh-keycell">
                <template v-for="(key, i) in row.keys" :key="key">
                  <span v-if="i > 0" class="cwh-keysep">/</span>
                  <kbd class="cwh-kbd">{{ key }}</kbd>
                </template>
              </td>
              <td>{{ $t(`settings.help.codeWorkflow.s9.rows.${row.key}.action`) }}</td>
              <td class="cwh-nowrap">{{ $t(`settings.help.codeWorkflow.s9.where.${row.where}`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="cwh-callout cwh-callout--warn">
        <div class="cwh-callout-title">{{ $t('settings.help.codeWorkflow.s9.callout.title') }}</div>
        <div class="cwh-callout-text" v-html="$t('settings.help.codeWorkflow.s9.callout.text')"></div>
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
