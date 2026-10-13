<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import MockFigure from './helpMocks/MockFigure.vue'
import MockPaneCard from './helpMocks/MockPaneCard.vue'
import MockRail from './helpMocks/MockRail.vue'
import MockSidebar from './helpMocks/MockSidebar.vue'
import MockStage from './helpMocks/MockStage.vue'
import MockTreeRow from './helpMocks/MockTreeRow.vue'
import MockWindow from './helpMocks/MockWindow.vue'

// Read-only reference for the main window's four building blocks — workspace,
// pane, stage layout and sidebar — shown inside Settings → Help.
// Static mirror of the Navide user manual, book 1: workspaces and panes; every
// claim below was verified against the codebase when the manual was written.
// All prose lives in the locale files under `settings.help.workspace.*`; only
// the row keys and the untranslatable key symbols stay here. If the layout
// slots, reclaim thresholds or shortcuts change, update this file too.

// Row keys for the prose tables; the text for each row is looked up under
// `settings.help.workspace.<section>.<table>.<key>` so both locales stay in
// parity and the row order is fixed here.

// `how` holds the key symbols, which are the same in every locale; the one row
// whose "how" is prose reads it from the locale files instead.
const paneActions: { key: string; how: string }[] = [
  { key: 'open', how: '⌘⇧U' },
  { key: 'nthCli', how: 'Ctrl+1 … Ctrl+9' },
  { key: 'rename', how: '' },
  { key: 'close', how: '⌘W' },
  { key: 'rebuild', how: '⌘R' },
  { key: 'cycle', how: 'Ctrl+Tab / Ctrl+⇧+Tab' },
]

// Mode, preset and tab names are the UI's own labels, so they are read from
// the very keys the UI renders rather than copied here: a rename in the
// product cannot leave this table quoting a label that no longer exists.
const stageModes: { key: string; glyph: string }[] = [
  { key: 'grid', glyph: '⊞' },
  { key: 'sidebar', glyph: '◧' },
  { key: 'spotlight', glyph: '◎' },
  { key: 'fullscreen', glyph: '⧉' },
]

const layoutPresets: { key: string; labelKey: string }[] = [
  { key: 'default', labelKey: 'layout.preset.default' },
  { key: 'focus', labelKey: 'layout.preset.focus' },
  { key: 'bottomPanel', labelKey: 'layout.preset.bottom-panel' },
]

const sidebarTabs: { key: string; icon: string; labelKey: string }[] = [
  { key: 'agents', icon: '🤖', labelKey: 'label.agents' },
  { key: 'pipeline', icon: '🔀', labelKey: 'label.pipeline' },
  { key: 'explorer', icon: '📁', labelKey: 'label.explorer' },
  { key: 'git', icon: '🌿', labelKey: 'label.git' },
  { key: 'plans', icon: '📋', labelKey: 'label.plans' },
]

const dropTargets = ['pane', 'tab', 'window'] as const

const infoPopovers = ['backend', 'announcements', 'clock', 'resource'] as const

const { t } = useI18n()

// Labels the prose quotes, read from the keys the product itself renders.
const sidebarModeLabels = computed(() => ({
  workspace: t('label.workspace'),
  free: t('label.sidebar-mode-free'),
}))
// The workspace row's context menu and ⋯ menu, as ControlPane.vue labels them.
const workspaceRowLabels = computed(() => ({
  more: t('action.more-workspace-actions'),
  rename: t('action.rename-workspace'),
  finder: t('action.open-in-finder'),
  copyPath: t('action.copy-path'),
  moveToGroup: t('label.move-to-workspace-group'),
  reclaim: t('action.reclaim-workspace'),
  close: t('action.close-workspace'),
  closePanes: t('action.close-workspace-and-panes'),
  rebuildAll: t('action.rebuild-all-cli-panes-label'),
  history: t('label.history'),
  detach: t('action.detach-workspace'),
}))

// ── Voice input ─────────────────────────────────────────────────────────
// One take, in order, then the rows of Settings ▸ Voice Input in the order
// VoiceSettingsSection.vue stacks them; each row is titled with its own key.
const voiceTake = ['start', 'release', 'enter', 'esc', 'limit', 'target'] as const
const voiceRows = [
  { key: 'enabled', labelKey: 'settings.voice.enabled' },
  { key: 'shortcut', labelKey: 'settings.voice.shortcut' },
  { key: 'fnKey', labelKey: 'settings.voice.fn-key' },
  { key: 'device', labelKey: 'settings.voice.device' },
  { key: 'mode', labelKey: 'settings.voice.mode' },
  { key: 'script', labelKey: 'settings.voice.script' },
  { key: 'model', labelKey: 'settings.voice.model' },
  { key: 'engine', labelKey: 'settings.voice.engine' },
] as const
const voiceLabels = computed(() => ({
  nav: t('settings.nav.voice'),
  enabled: t('settings.voice.enabled'),
  model: t('settings.voice.model'),
  engine: t('settings.voice.engine'),
  holdTap: t('settings.voice.mode-hold-tap'),
  hold: t('settings.voice.mode-hold'),
  toggle: t('settings.voice.mode-toggle'),
  hantTw: t('settings.voice.script-hant-tw'),
}))

// ── Mock screenshots ────────────────────────────────────────────────────────
// Two HTML pictures of the real window, drawn from the components they depict
// rather than captured, so they follow the user's theme and never show anyone's
// actual project. Every word in them is a locale lookup — an untranslated label
// would be invisible here but is caught by the en-US rendering test.

const MARKS = ['\u2460', '\u2461', '\u2462', '\u2463', '\u2464']

function mockLegend(figure: string, rows: string[]): { mark: string; label: string; text: string }[] {
  return rows.map((row, i) => ({
    mark: MARKS[i],
    label: t(`settings.help.workspace.mock.${figure}.legend.${row}.label`),
    text: t(`settings.help.workspace.mock.${figure}.legend.${row}.text`),
  }))
}

/** Sample name, kept in the locale files so a picture never hard-codes prose. */
function sample(key: string): string {
  return t(`settings.help.workspace.mock.sample.${key}`)
}

/**
 * The stage's arrangement buttons carry a glyph and no text; their name lives
 * only in the button tooltip, ahead of the dash (`Grid — show all panes`).
 */
function modeName(key: string): string {
  return t(`label.view-mode-${key}`).split(' — ')[0]
}

/** The status word the pane pill and the sidebar dot share. */
function statusWord(status: string): string {
  return t(`paneStatus.${status}`)
}

const shellLegend = computed(() => mockLegend('shell', ['titlebar', 'sidebar', 'stage', 'rail', 'status']))
const groupsLegend = computed(() => mockLegend('groups', ['tab', 'add', 'grid', 'tree']))

// The sidebar's tab strip and the right rail's, in the order each draws them.
const sidebarIcons = ['\u{1F916}', '\u{1F500}', '\u{1F4C1}', '\u{1F33F}', '\u{1F4CB}']
const railItems = computed(() => [
  { icon: '\u{1F4DC}', label: t('label.history') },
  { icon: '\u{1F4CA}', label: t('label.tokens') },
  { icon: '\u2709', label: t('label.messages') },
])

const mockTabs = computed(() => [
  { label: sample('group'), count: 3, status: 'running' as const },
  { label: sample('group2'), count: 1, status: 'idle' as const },
])

const mockStatusLeft = computed(() => [
  { text: sample('backend'), dot: true },
  { text: sample('resource') },
])
const mockStatusRight = computed(() => [sample('version'), sample('clock'), '\u2715'])

const shortcuts: { key: string; keys: string }[] = [
  { key: 'openWorkspace', keys: '⌘O' },
  { key: 'newWindow', keys: '⌘N' },
  { key: 'newPane', keys: '⌘⇧U' },
  { key: 'nthCli', keys: 'Ctrl+1…9' },
  { key: 'closePane', keys: '⌘W' },
  { key: 'rebuildPane', keys: '⌘R' },
  { key: 'nextPane', keys: 'Ctrl+Tab' },
  { key: 'toggleSidebar', keys: '⌘B' },
  { key: 'sidebarTabs', keys: '⌘1…⌘5' },
  { key: 'explorer', keys: '⌘⇧E' },
  { key: 'pipeline', keys: '⌘⇧Y' },
  { key: 'plans', keys: '⌘⇧D' },
  { key: 'gitWindow', keys: '⌘⇧G' },
  { key: 'editorWindow', keys: '⌘⇧I' },
  { key: 'preview', keys: '⌘⌥V' },
]
</script>

<template>
  <div class="wph">
    <p class="wph-intro">{{ $t('settings.help.workspace.intro') }}</p>

    <!-- ── 1 · Three terms ─────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">1 · {{ $t('settings.help.workspace.s1.title') }}</h2>
      <p class="wph-p">{{ $t('settings.help.workspace.s1.p1') }}</p>

      <div class="wph-card">
        <div class="wph-card-title">{{ $t('settings.help.workspace.s1.cards.workspace.title') }}</div>
        <p class="wph-p" v-html="$t('settings.help.workspace.s1.cards.workspace.text')"></p>
      </div>

      <div class="wph-card">
        <div class="wph-card-title">{{ $t('settings.help.workspace.s1.cards.pane.title') }}</div>
        <p class="wph-p" v-html="$t('settings.help.workspace.s1.cards.pane.text')"></p>
      </div>

      <div class="wph-card">
        <div class="wph-card-title">{{ $t('settings.help.workspace.s1.cards.group.title') }}</div>
        <p class="wph-p" v-html="$t('settings.help.workspace.s1.cards.group.text')"></p>
      </div>


      <!-- The whole window, drawn rather than captured. Placed here because the
           three terms above are easier to hold once you can see where each of
           them lives. -->
      <MockFigure
        :caption="$t('settings.help.workspace.mock.shell.caption')"
        :legend="shellLegend"
      >
        <MockWindow
          :title="sample('workspace')"
          :mark="MARKS[0]"
          :branch="sample('branch')"
          :status-left="mockStatusLeft"
          :status-right="mockStatusRight"
          :status-mark="MARKS[4]"
        >
          <MockSidebar :icons="sidebarIcons" :active="0" :mark="MARKS[1]">
            <MockTreeRow kind="workspace" :label="sample('workspace')" :count="4" />
            <MockTreeRow kind="group" :label="sample('group')" :count="3" />
            <MockTreeRow
              kind="pane"
              :label="sample('pane1')"
              :sub="sample('sub1')"
              status="running"
              active
            />
            <MockTreeRow
              kind="pane"
              :label="sample('pane3')"
              :sub="sample('sub3')"
              status="awaiting"
              :depth="1"
            />
            <MockTreeRow kind="pane" :label="sample('pane2')" :sub="sample('sub2')" status="idle" />
            <MockTreeRow kind="group" :label="sample('group2')" :count="1" />
          </MockSidebar>
          <MockStage :tabs="mockTabs" :active="0" :grid-mark="MARKS[2]">
            <MockPaneCard
              :title="sample('pane1')"
              status="running"
              :status-label="statusWord('running')"
              focus
            />
            <MockPaneCard :title="sample('pane2')" status="idle" :status-label="statusWord('idle')" />
            <MockPaneCard
              :title="sample('pane3')"
              status="awaiting"
              :status-label="statusWord('awaiting')"
              :lines="3"
            />
          </MockStage>
          <MockRail :items="railItems" :mark="MARKS[3]" />
        </MockWindow>
      </MockFigure>

      <div class="wph-callout">
        <div class="wph-callout-title">{{ $t('settings.help.workspace.s1.callout.title') }}</div>
        <div class="wph-callout-text">{{ $t('settings.help.workspace.s1.callout.text') }}</div>
      </div>
    </section>

    <!-- ── 2 · Workspaces ──────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">2 · {{ $t('settings.help.workspace.s2.title') }}</h2>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s2.h1') }}</h3>
      <p class="wph-p">{{ $t('settings.help.workspace.s2.p1') }}</p>
      <ul class="wph-list">
        <li v-html="$t('settings.help.workspace.s2.welcome.browse')"></li>
        <li v-html="$t('settings.help.workspace.s2.welcome.newWorkspace')"></li>
        <li v-html="$t('settings.help.workspace.s2.welcome.openHome')"></li>
        <li v-html="$t('settings.help.workspace.s2.welcome.recent')"></li>
      </ul>
      <p class="wph-p" v-html="$t('settings.help.workspace.s2.p2')"></p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s2.h2') }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s2.p3')"></p>
      <p class="wph-p" v-html="$t('settings.help.workspace.s2.p4')"></p>

      <div class="wph-callout wph-callout--warn">
        <div class="wph-callout-title">{{ $t('settings.help.workspace.s2.callout.title') }}</div>
        <div class="wph-callout-text">{{ $t('settings.help.workspace.s2.callout.text') }}</div>
      </div>

      <p class="wph-p">{{ $t('settings.help.workspace.s2.p5') }}</p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s2.h3') }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s2.p6')"></p>
    </section>

    <!-- ── 3 · Panes ───────────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">3 · {{ $t('settings.help.workspace.s3.title') }}</h2>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s3.h1') }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s3.p1')"></p>
      <ul class="wph-list">
        <li v-html="$t('settings.help.workspace.s3.addMenu.role')"></li>
        <li v-html="$t('settings.help.workspace.s3.addMenu.cliList')"></li>
        <li v-html="$t('settings.help.workspace.s3.addMenu.terminal')"></li>
      </ul>
      <p class="wph-p" v-html="$t('settings.help.workspace.s3.p2')"></p>

      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.workspace.s3.table.action') }}</th>
              <th>{{ $t('settings.help.workspace.s3.table.how') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in paneActions" :key="row.key">
              <td>{{ $t(`settings.help.workspace.s3.paneActions.${row.key}.action`) }}</td>
              <td v-if="row.how">{{ row.how }}</td>
              <td v-else>{{ $t(`settings.help.workspace.s3.paneActions.${row.key}.how`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="wph-note" v-html="$t('settings.help.workspace.s3.note')"></p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s3.h2') }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s3.p3')"></p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s3.h3') }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s3.p4')"></p>
      <p class="wph-p" v-html="$t('settings.help.workspace.s3.p5')"></p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s3.h4') }}</h3>
      <p class="wph-p">{{ $t('settings.help.workspace.s3.p6') }}</p>
      <ul class="wph-list">
        <li v-html="$t('settings.help.workspace.s3.reclaim.default')"></li>
        <li>{{ $t('settings.help.workspace.s3.reclaim.scan') }}</li>
        <li v-html="$t('settings.help.workspace.s3.reclaim.notClose')"></li>
        <li>{{ $t('settings.help.workspace.s3.reclaim.exempt') }}</li>
      </ul>
      <p class="wph-note" v-html="$t('settings.help.workspace.s3.note2')"></p>
    </section>

    <!-- ── 4 · Layout ──────────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">4 · {{ $t('settings.help.workspace.s4.title') }}</h2>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s4.h1') }}</h3>
      <p class="wph-p">{{ $t('settings.help.workspace.s4.p1') }}</p>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.workspace.s4.table.mode') }}</th>
              <th>{{ $t('settings.help.workspace.s4.table.behavior') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in stageModes" :key="row.key">
              <td class="wph-nowrap"><strong>{{ modeName(row.key) }} {{ row.glyph }}</strong></td>
              <td>{{ $t(`settings.help.workspace.s4.stageModes.${row.key}.behavior`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="wph-p" v-html="$t('settings.help.workspace.s4.p2')"></p>

      <!-- Same panes, both ways round: the tab bar and grid on the stage, the
           three-level list in the sidebar. -->
      <MockFigure
        :caption="$t('settings.help.workspace.mock.groups.caption')"
        :legend="groupsLegend"
      >
        <MockWindow>
          <MockSidebar :icons="sidebarIcons" :active="0" :mark="MARKS[3]">
            <MockTreeRow kind="workspace" :label="sample('workspace')" :count="4" />
            <MockTreeRow kind="group" :label="sample('group')" :count="3" />
            <MockTreeRow
              kind="pane"
              :label="sample('pane1')"
              :sub="sample('sub1')"
              status="running"
              active
            />
            <MockTreeRow
              kind="pane"
              :label="sample('pane3')"
              :sub="sample('sub3')"
              status="awaiting"
              :depth="1"
            />
            <MockTreeRow kind="pane" :label="sample('pane2')" :sub="sample('sub2')" status="idle" />
            <MockTreeRow kind="group" :label="sample('group2')" :count="1" />
          </MockSidebar>
          <MockStage
            :tabs="mockTabs"
            :active="0"
            :tab-mark="MARKS[0]"
            :add-mark="MARKS[1]"
            :grid-mark="MARKS[2]"
          >
            <MockPaneCard
              :title="sample('pane1')"
              status="running"
              :status-label="statusWord('running')"
              focus
            />
            <MockPaneCard :title="sample('pane2')" status="idle" :status-label="statusWord('idle')" />
            <MockPaneCard
              :title="sample('pane3')"
              status="awaiting"
              :status-label="statusWord('awaiting')"
              :lines="3"
            />
          </MockStage>
        </MockWindow>
      </MockFigure>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s4.h2') }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s4.p3')"></p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s4.h3') }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s4.p4')"></p>
      <ul class="wph-list">
        <li v-html="$t('settings.help.workspace.s4.slots.main')"></li>
        <li v-html="$t('settings.help.workspace.s4.slots.left')"></li>
        <li v-html="$t('settings.help.workspace.s4.slots.right')"></li>
        <li v-html="$t('settings.help.workspace.s4.slots.updown')"></li>
      </ul>
      <p class="wph-p">{{ $t('settings.help.workspace.s4.p5') }}</p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s4.h4') }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s4.p6')"></p>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.workspace.s4.presetTable.preset') }}</th>
              <th>{{ $t('settings.help.workspace.s4.presetTable.effect') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in layoutPresets" :key="row.key">
              <td class="wph-nowrap"><strong>{{ $t(row.labelKey) }}</strong></td>
              <td>{{ $t(`settings.help.workspace.s4.layoutPresets.${row.key}.effect`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 5 · The sidebar ─────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">5 · {{ $t('settings.help.workspace.s5.title') }}</h2>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s5.h1') }}</h3>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.workspace.s5.table.tab') }}</th>
              <th>{{ $t('settings.help.workspace.s5.table.content') }}</th>
              <th>{{ $t('settings.help.workspace.s5.table.keys') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in sidebarTabs" :key="row.key">
              <td class="wph-nowrap">{{ row.icon }} {{ $t(row.labelKey) }}</td>
              <td>{{ $t(`settings.help.workspace.s5.sidebarTabs.${row.key}.content`) }}</td>
              <td class="wph-nowrap">
                <kbd class="wph-kbd">{{ $t(`settings.help.workspace.s5.sidebarTabs.${row.key}.keys`) }}</kbd>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="wph-note" v-html="$t('settings.help.workspace.s5.note')"></p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s5.h2') }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s5.p1')"></p>
      <ul class="wph-list">
        <li v-html="$t('settings.help.workspace.s5.rows.workspace', workspaceRowLabels)"></li>
        <li v-html="$t('settings.help.workspace.s5.rows.group')"></li>
        <li v-html="$t('settings.help.workspace.s5.rows.pane')"></li>
      </ul>

      <div class="wph-callout">
        <div class="wph-callout-title">{{ $t('settings.help.workspace.s5.callout.title') }}</div>
        <div class="wph-callout-text" v-html="$t('settings.help.workspace.s5.callout.text')"></div>
      </div>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s5.hMode', sidebarModeLabels) }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s5.mode', sidebarModeLabels)"></p>
      <p class="wph-p" v-html="$t('settings.help.workspace.s5.modeNote', sidebarModeLabels)"></p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s5.h3') }}</h3>
      <p class="wph-p" v-html="$t('settings.help.workspace.s5.p2')"></p>
      <ul class="wph-list">
        <li v-html="$t('settings.help.workspace.s5.folds.pane')"></li>
        <li v-html="$t('settings.help.workspace.s5.folds.group')"></li>
        <li v-html="$t('settings.help.workspace.s5.folds.workspace')"></li>
      </ul>
      <p class="wph-note" v-html="$t('settings.help.workspace.s5.foldNote')"></p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s5.h4') }}</h3>
      <ul class="wph-list">
        <li v-html="$t('settings.help.workspace.s5.multiselect.cmdClick')"></li>
        <li v-html="$t('settings.help.workspace.s5.multiselect.shiftClick')"></li>
        <li v-html="$t('settings.help.workspace.s5.multiselect.batchMenu')"></li>
      </ul>
      <p class="wph-p" v-html="$t('settings.help.workspace.s5.p3')"></p>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.workspace.s5.dropTable.target') }}</th>
              <th>{{ $t('settings.help.workspace.s5.dropTable.result') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in dropTargets" :key="key">
              <td class="wph-nowrap">{{ $t(`settings.help.workspace.s5.dropTargets.${key}.target`) }}</td>
              <td>{{ $t(`settings.help.workspace.s5.dropTargets.${key}.result`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 6 · The status bar ──────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">6 · {{ $t('settings.help.workspace.s6.title') }}</h2>
      <p class="wph-p">{{ $t('settings.help.workspace.s6.p1') }}</p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s6.h1') }}</h3>
      <ul class="wph-list">
        <li v-html="$t('settings.help.workspace.s6.left.git')"></li>
        <li v-html="$t('settings.help.workspace.s6.left.backend')"></li>
        <li v-html="$t('settings.help.workspace.s6.left.resource')"></li>
        <li v-html="$t('settings.help.workspace.s6.left.update')"></li>
      </ul>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s6.h2') }}</h3>
      <ul class="wph-list">
        <li v-html="$t('settings.help.workspace.s6.right.pipeline')"></li>
        <li v-html="$t('settings.help.workspace.s6.right.tidying')"></li>
        <li v-html="$t('settings.help.workspace.s6.right.leftover')"></li>
        <li v-html="$t('settings.help.workspace.s6.right.disconnected')"></li>
        <li v-html="$t('settings.help.workspace.s6.right.announcements')"></li>
        <li>{{ $t('settings.help.workspace.s6.right.clock') }}</li>
        <li v-html="$t('settings.help.workspace.s6.right.closeAll')"></li>
      </ul>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.s6.h3') }}</h3>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.workspace.s6.popTable.where') }}</th>
              <th>{{ $t('settings.help.workspace.s6.popTable.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in infoPopovers" :key="key">
              <td class="wph-nowrap">{{ $t(`settings.help.workspace.s6.infoPopovers.${key}.where`) }}</td>
              <td>{{ $t(`settings.help.workspace.s6.infoPopovers.${key}.what`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="wph-callout wph-callout--warn">
        <div class="wph-callout-title">{{ $t('settings.help.workspace.s6.callout.title') }}</div>
        <div class="wph-callout-text">{{ $t('settings.help.workspace.s6.callout.text') }}</div>
      </div>
    </section>

    <!-- ── 7 · Voice input ──────────────────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">7 · {{ $t('settings.help.workspace.voice.title') }}</h2>
      <p class="wph-p" v-html="$t('settings.help.workspace.voice.p1', voiceLabels)"></p>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.voice.h1') }}</h3>
      <ul class="wph-list">
        <li v-for="key in voiceTake" :key="key" v-html="$t(`settings.help.workspace.voice.take.${key}`)"></li>
      </ul>

      <h3 class="wph-h3">{{ $t('settings.help.workspace.voice.h2', voiceLabels) }}</h3>
      <ul class="wph-list">
        <li v-for="row in voiceRows" :key="row.key">
          <strong>{{ $t(row.labelKey) }}</strong> — <span v-html="$t(`settings.help.workspace.voice.rows.${row.key}`, voiceLabels)"></span>
        </li>
      </ul>
      <p class="wph-note" v-html="$t('settings.help.workspace.voice.note', voiceLabels)"></p>
    </section>

    <!-- ── 8 · Shortcut quick reference ────────────────────────────── -->
    <section class="wph-section">
      <h2 class="wph-h2">8 · {{ $t('settings.help.workspace.s7.title') }}</h2>
      <p class="wph-p" v-html="$t('settings.help.workspace.s7.p1')"></p>
      <div class="wph-tablewrap">
        <table class="wph-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.workspace.s7.table.keys') }}</th>
              <th>{{ $t('settings.help.workspace.s7.table.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in shortcuts" :key="row.key">
              <td class="wph-nowrap"><kbd class="wph-kbd">{{ row.keys }}</kbd></td>
              <td>{{ $t(`settings.help.workspace.s7.shortcuts.${row.key}.action`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wph {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: 78ch;
}

.wph-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.wph-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wph-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
}
.wph-h3 {
  margin: 6px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}
.wph-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}
.wph-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}
.wph-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.wph-card {
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wph-card-title {
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}

.wph-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wph-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.wph-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}
.wph-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.wph-callout--warn .wph-callout-title {
  color: var(--attention-fg);
}

.wph-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.wph-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-xs);
}
.wph-table th,
.wph-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.wph-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.wph-table tr:last-child td { border-bottom: none; }
.wph-nowrap { white-space: nowrap; }

/* `code` and `.wph-kbd` also appear inside v-html prose, which carries no
   scoped data-v attribute — hence :deep(). */
.wph :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}

.wph :deep(.wph-kbd) {
  display: inline-block;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--font-2xs);
  line-height: 1.5;
  color: var(--text-primary);
  background: var(--bg-inset);
  border: 1px solid var(--border-default);
  border-bottom-width: 2px;
  border-radius: var(--radius-sm);
  padding: 0 5px;
  white-space: nowrap;
}
</style>
