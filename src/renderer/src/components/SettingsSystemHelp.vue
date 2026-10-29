<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import MockFigure from './helpMocks/MockFigure.vue'
import MockPanel from './helpMocks/MockPanel.vue'
import MockSettings from './helpMocks/MockSettings.vue'
import MockStatRow from './helpMocks/MockStatRow.vue'
import MockToolbar from './helpMocks/MockToolbar.vue'
// Read-only reference for the settings window and the system surfaces around it
// (Navide Cloud, the app menus, standalone windows, resource upkeep).
// Static mirror of the shipped UI — a prose copy of the "Settings & system"
// manual. Purely presentational: no props, no emits, no state. All prose lives
// in the locale files under `settings.help.settingsSystem.*`; the tables below
// keep their row keys plus, for every visible label, the i18n key the real
// surface renders. Nothing here is a display literal: the settings nav, the
// setting titles, the Window menu and the storage groups are all translated in
// the product, so a literal would print English on a zh screen — which is
// exactly the bug this replaced.

// Every display label below is an i18n key, never a literal: the nav names,
// the setting titles, the Window menu items and the storage groups are all
// translated in the product, so a literal here would show English on a zh
// screen. Each `*Key` is the key the real surface renders — renaming a row in
// the product renames it here.
interface TabRow {
  key: string
  /** Only set on the first row of a group; drives the rowspan cell. */
  groupKey?: string
  groupSpan?: number
  navKey: string
}

interface StatusRow {
  state: string
  colorKey: string
}

interface StageRow {
  key: string
  stageKey?: string
  stageSpan?: number
}

// ── 1 · The twenty-five tabs ───────────────────────────────────────────────
const tabs: TabRow[] = [
  { key: 'general', groupKey: 'settings.nav.group.general', groupSpan: 8, navKey: 'settings.nav.general' },
  { key: 'appearance', navKey: 'settings.nav.appearance' },
  { key: 'language', navKey: 'settings.nav.language' },
  { key: 'statusBadges', navKey: 'settings.nav.statusBadges' },
  { key: 'layout', navKey: 'settings.nav.layout' },
  { key: 'notifications', navKey: 'settings.nav.notifications' },
  { key: 'voice', navKey: 'settings.nav.voice' },
  { key: 'appLock', navKey: 'settings.nav.appLock' },
  { key: 'accounts', groupKey: 'settings.nav.group.accountsAgents', groupSpan: 5, navKey: 'settings.nav.accounts' },
  { key: 'cliAgents', navKey: 'settings.nav.cliAgents' },
  { key: 'analyzer', navKey: 'settings.nav.analyzer' },
  { key: 'security', navKey: 'guard.nav' },
  { key: 'channels', navKey: 'channels.nav' },
  { key: 'mcp', groupKey: 'settings.nav.group.integration', groupSpan: 6, navKey: 'settings.nav.mcp' },
  { key: 'skills', navKey: 'settings.nav.skills' },
  { key: 'prompts', navKey: 'settings.nav.prompts' },
  { key: 'memory', navKey: 'settings.nav.memory' },
  { key: 'credentials', navKey: 'settings.nav.credentials' },
  { key: 'cliExtensions', navKey: 'settings.nav.cliExtensions' },
  // Navide Cloud, Navide Plugins and Navide Marketplace are the fourth
  // `.s-nav-group` in SettingsModal.vue, System the fifth. The execution policy
  // is not a page of its own: it is the editable block at the top of Navide Plugins,
  // and the disclosure overview is the block at its bottom.
  { key: 'cloud', groupKey: 'settings.nav.group.navidePlugins', groupSpan: 3, navKey: 'settings.nav.crossDevice' },
  { key: 'extensions', navKey: 'settings.nav.extensions' },
  { key: 'marketplace', navKey: 'settings.nav.marketplace' },
  { key: 'shortcuts', groupKey: 'settings.nav.group.system', groupSpan: 3, navKey: 'settings.nav.keybindings' },
  { key: 'updates', navKey: 'settings.nav.updates' },
  { key: 'help', navKey: 'settings.nav.help' },
]

// ── 2 · General ──────────────────────────────────────────────────────────
// Row titles, keyed to the SettingsModal.vue rows they describe. Two of them
// are namespaced `settings.appearance.*` for historical reasons while the row
// itself sits on the General tab; the key name is not the tab.
const generalSettings = [
  { key: 'confirmClose', nameKey: 'settings.general.confirm-close-pane' },
  { key: 'confirmCloseWorkspace', nameKey: 'settings.general.confirm-close-workspace' },
  { key: 'reclaimIdle', nameKey: 'settings.general.idle-reclaim' },
  { key: 'reclaimAfter', nameKey: 'settings.general.idle-reclaim-after' },
  { key: 'reclaimNow', nameKey: 'settings.general.idle-reclaim-now' },
  { key: 'resumeOnOpen', nameKey: 'settings.appearance.resume-behavior' },
  { key: 'resumeScope', nameKey: 'settings.appearance.restore-scope' },
  { key: 'resumeAfterRestart', nameKey: 'settings.general.auto-resume-reconnect' },
  { key: 'resumeInterrupted', nameKey: 'settings.general.resume-interrupted-on-launch' },
  { key: 'concurrentResume', nameKey: 'settings.appearance.resume-concurrency' },
  { key: 'defaultEditor', nameKey: 'settings.general.default-editor' },
  { key: 'quotaBadge', nameKey: 'usage.settings-title' },
  { key: 'environment', nameKey: 'settings.appearance.environment' },
  { key: 'backendTimeout', nameKey: 'settings.appearance.backend-timeout' },
  { key: 'settingsBundle', nameKey: 'settings.management.title' },
] as const

const statusBadges: StatusRow[] = [
  { state: 'starting', colorKey: 'statusBadges.color.blue' },
  { state: 'running', colorKey: 'statusBadges.color.green' },
  { state: 'idle', colorKey: 'statusBadges.color.yellow' },
  { state: 'awaiting', colorKey: 'statusBadges.color.orange' },
  { state: 'stopped', colorKey: 'statusBadges.color.ink' },
  { state: 'exited', colorKey: 'statusBadges.color.gray' },
  { state: 'error', colorKey: 'statusBadges.color.red' },
  { state: 'waiting', colorKey: 'statusBadges.color.gray' },
  { state: 'disconnected', colorKey: 'statusBadges.color.yellow' },
]

// ── 3 · Skills / Memory ──────────────────────────────────────────────────
const skillMatrix = ['on', 'native', 'none', 'pending'] as const

const memoryCoverage = [
  { key: 'mapped', labelKey: 'settings.memory.agents-mapped' },
  { key: 'configured', labelKey: 'settings.memory.agents-configured' },
  { key: 'unmapped', labelKey: 'settings.memory.agents-unknown' },
] as const

const updateStages: StageRow[] = [
  { key: 'autoCheck', stageKey: 'updater.stage.check', stageSpan: 2 },
  { key: 'checkFailures' },
  { key: 'autoDownload', stageKey: 'updater.stage.download', stageSpan: 2 },
  { key: 'retryDownload' },
  { key: 'installOnQuit', stageKey: 'updater.stage.install', stageSpan: 2 },
  { key: 'installTimeout' },
]

// The execution-policy block at the top of the Extensions page, in the order
// ExecutionPolicyPane.vue stacks it: effective policy, the two editable
// policies, the workspace source, then recovery.
const policyRows = [
  'hostDefault',
  'user',
  'highRisk',
  'source',
  'recovery',
  'failClosed',
] as const

// ── 5 · Navide Cloud ─────────────────────────────────────────────────────
const needsYou = [
  { key: 'pairing', labelKey: 'settings.p2p.trust.kind-device' },
  { key: 'accessRequest', labelKey: 'settings.p2p.trust.kind-access' },
] as const

// The Sync block, which is the first section of the Navide Cloud settings
// page rather than a tab of its own.
const syncRows = ['scopes', 'credentials', 'states', 'key', 'legacy', 'conflicts'] as const

// ── 6 · Menus and windows ────────────────────────────────────────────────
// The Window menu is built in the main process, which has no i18n and keeps
// its own per-locale table (src/main/menuStrings.ts). Four of these items have
// an equivalent key in the renderer's locale and read it here; the last two do
// not, so the topic owns their wording:
//   - tokenMonitor: the window's own title lives in TokenMonitorApp's local
//     i18n, outside the shared locale files.
//   - standard: Minimize / Zoom / Bring All to Front are Electron roles, so the
//     OS supplies the label in the OS's language, not Navide's. Left in English
//     rather than asserting a translation Navide does not control.
const windowMenu = [
  { key: 'cloud', labelKey: 'settings.nav.crossDevice' },
  { key: 'pipeline', labelKey: 'label.pipeline-manager' },
  { key: 'resource', labelKey: 'resource.title' },
  { key: 'turnStats', labelKey: 'turn-stats.title' },
  { key: 'tokenMonitor', labelKey: 'settings.help.settingsSystem.s6.windowMenu.tokenMonitor.label' },
  { key: 'standard', labelKey: 'settings.help.settingsSystem.s6.windowMenu.standard.label' },
] as const

const scheduleSections = [
  { key: 'crontab', labelKey: 'executions.crontab.title' },
  { key: 'agents', labelKey: 'executions.launchagents.title' },
  { key: 'daemons', labelKey: 'executions.daemons.title' },
] as const

const otherWindows = [
  'mainWindow',
  'editor',
  'git',
  'diff',
  'branchDiff',
  'plan',
  'draggedGroup',
  'draggedWorkspace',
] as const

// ── 7 · Resources and upkeep ─────────────────────────────────────────────
const storageCategories = [
  { key: 'appData', labelKey: 'resource.storage.group.appData' },
  { key: 'electron', labelKey: 'resource.storage.group.electron' },
  { key: 'cliHomes', labelKey: 'resource.storage.group.cliHomes' },
  { key: 'workspaces', labelKey: 'resource.storage.group.workspaces' },
] as const

const maintenance = [
  'memory',
  'disk',
  'leftover',
  'unresponsive',
  'shortcutClash',
  'stubbornKey',
  'remoteAgent',
  'background',
  'moveSettings',
  'tokenSpend',
] as const
// ── 8 · Usage surfaces ───────────────────────────────────────────────────
// Which of the three usage views is which. They are separate surfaces with
// separate data sources. Turn Stats has a title key of its own; the other two
// do not — Token Monitor's title lives in its window's local i18n, and "quota
// cycles" is this topic's name for the view (it has no title of its own, being
// headed by the account you picked), so the topic owns both strings.
const usageSurfaces = [
  { key: 'tokenMonitor', labelKey: 'settings.help.settingsSystem.s8.surfaces.tokenMonitor.label' },
  { key: 'turnStats', labelKey: 'turn-stats.title' },
  { key: 'quotaCycles', labelKey: 'settings.help.settingsSystem.s8.surfaces.quotaCycles.label' },
] as const

const { t } = useI18n()

// Labels the prose quotes, read from the keys the product itself renders so a
// renamed tab, topic or button renames the help text too.
const topicNames = computed(() => ({
  workspace: t('settings.help.topic.workspace'),
  messaging: t('settings.help.topic.messaging'),
  mcp: t('settings.help.topic.mcp'),
}))
const searchGaps = computed(() => ({
  layout: t('settings.nav.layout'),
  notifications: t('settings.nav.notifications'),
  security: t('guard.nav'),
  channels: t('channels.nav'),
}))
const extensionLabels = computed(() => ({
  toBundled: t('settings.extensions.rollback.toBundled'),
  toVersion: t('settings.extensions.rollback.toVersion', { version: '…' }),
  restart: t('settings.extensions.restartPlugin'),
  prerelease: t('settings.extensions.getPrereleases'),
  native: t('settings.extensions.nativeBackends.title'),
  nativeEnable: t('settings.extensions.nativeBackends.enable'),
  allow: t('settings.extensions.nativeBackends.allow'),
  marketplace: t('settings.nav.marketplace'),
  featured: t('settings.extensions.marketplace.featured'),
  pack: t('settings.extensions.pack.badge'),
  packInstall: t('settings.extensions.pack.install', { count: '…' }),
}))
// ── 9 · Security ─────────────────────────────────────────────────────────
// SecurityPane.vue's sections, in its own order, minus the enable switch, the
// fixed decision table and the vendor list, which the prose covers.
const guardItems = ['builtin', 'branches', 'rules', 'test', 'taint', 'audit'] as const
const guardLabels = computed(() => ({
  nav: t('guard.nav'),
  critical: t('guard.level.critical'),
  high: t('guard.level.high'),
  off: t('guard.builtin.off'),
  builtin: t('guard.builtin.title'),
  branches: t('guard.branches.title'),
  rules: t('guard.rules.title'),
  deny: t('guard.rules.kind.deny'),
  allow: t('guard.rules.kind.allow'),
  test: t('guard.test.title'),
  taint: t('guard.taint.title'),
  badge: t('guard.pane.badge'),
  audit: t('guard.audit.title'),
  terminal: t('guard.terminal.title'),
  block: t('guard.terminal.block.title'),
  allowEx: t('guard.terminal.allow.title'),
  termTest: t('guard.terminal.test.title'),
}))

// ── Mock screenshots ────────────────────────────────────────────────────────
// Two HTML pictures, drawn from the components they depict. Both are about
// ARRANGEMENT — which control sits where — because that is the one thing the
// prose tables in this topic cannot say; everything the tables already cover
// is deliberately not drawn again.
//
// Every label is a lookup of the key the real UI uses, so a renamed page or a
// reworded column lands in the picture too. Two claims in the prose did NOT
// survive being drawn from the source; they are noted where they occur.

const MARKS = ['\u2460', '\u2461', '\u2462']

function mockLegend(figure: string, rows: string[]): { mark: string; label: string; text: string }[] {
  return rows.map((row, i) => ({
    mark: MARKS[i],
    label: t(`settings.help.settingsSystem.mock.${figure}.legend.${row}.label`),
    text: t(`settings.help.settingsSystem.mock.${figure}.legend.${row}.text`),
  }))
}

function sample(key: string): string {
  return t(`settings.help.settingsSystem.mock.sample.${key}`)
}

const navLegend = computed(() => mockLegend('nav', ['search', 'groups', 'active']))
const resourceLegend = computed(() => mockLegend('resource', ['totals', 'rows', 'actions']))

// The nav exactly as SettingsModal.vue renders it: five groups,
// twenty-five pages, in this order. Labels come from the same `settings.nav.*`
// keys the real nav reads, so renaming a page renames it here.
//
// Drawing this is what caught the prose claiming four groups and sixteen
// pages, with Execution Policy missing from the table entirely: counting the
// nav items is something a picture forces and reading does not.
const settingsGroups = computed(() => [
  {
    title: t('settings.nav.group.general'),
    items: [
      { label: t('settings.nav.general'), active: true },
      { label: t('settings.nav.appearance') },
      { label: t('settings.nav.language') },
      { label: t('settings.nav.statusBadges') },
      { label: t('settings.nav.layout') },
      { label: t('settings.nav.notifications') },
      { label: t('settings.nav.voice') },
      { label: t('settings.nav.appLock') },
    ],
  },
  {
    title: t('settings.nav.group.accountsAgents'),
    items: [
      { label: t('settings.nav.accounts') },
      { label: t('settings.nav.cliAgents') },
      { label: t('settings.nav.analyzer') },
      { label: t('guard.nav') },
      { label: t('channels.nav') },
    ],
  },
  {
    title: t('settings.nav.group.integration'),
    items: [
      { label: t('settings.nav.mcp') },
      { label: t('settings.nav.skills') },
      { label: t('settings.nav.prompts') },
      { label: t('settings.nav.memory') },
      { label: t('settings.nav.credentials') },
      { label: t('settings.nav.cliExtensions') },
    ],
  },
  {
    title: t('settings.nav.group.navidePlugins'),
    items: [
      { label: t('settings.nav.crossDevice') },
      { label: t('settings.nav.extensions') },
      { label: t('settings.nav.marketplace') },
    ],
  },
  {
    title: t('settings.nav.group.system'),
    items: [
      { label: t('settings.nav.keybindings') },
      { label: t('settings.nav.updates') },
      { label: t('settings.nav.help') },
    ],
  },
])

const settingsSearch = computed(() => ({
  placeholder: t('settings.search.placeholder'),
  query: sample('query'),
  results: [
    { title: sample('hit1'), group: t('settings.nav.group.general') },
    { title: sample('hit2'), group: t('settings.nav.group.general') },
  ],
  mark: MARKS[0],
}))

// Resource Manager's own column headings and filters, from `resource.*`.
const resourceColumns = computed(() => [
  t('resource.col-cpu'),
  t('resource.col-memory'),
])
const resourceFilters = computed(() => [
  { label: t('resource.filter-all', { count: 3 }), primary: true },
  { label: t('resource.filter-busy', { count: 2 }) },
  { label: t('resource.filter-idle', { count: 1 }) },
])

// An idle row carries no `IDLE` text — ResourceManagerModal.vue tells idle
// from running by the dot colour alone (:645, where only `running` overrides
// the default attention colour). Drawing it is what caught the prose above
// claiming a label that does not exist.
const resourceRows = computed(() => [
  {
    name: sample('paneA'),
    meta: sample('metaA'),
    trend: [3, 5, 4, 9, 12, 11, 12],
    values: [sample('cpuA'), sample('memA')],
    state: 'running' as const,
  },
  {
    name: sample('paneB'),
    meta: sample('metaB'),
    trend: [8, 6, 5, 4, 3, 3, 3],
    values: [sample('cpuB'), sample('memB')],
    state: 'running' as const,
  },
  {
    name: sample('paneC'),
    meta: sample('metaC'),
    trend: [2, 1, 1, 0, 0, 0, 0],
    values: [sample('cpuC'), sample('memC')],
    state: 'idle' as const,
  },
])
</script>

<template>
  <div class="syh">
    <p class="syh-intro">{{ $t('settings.help.settingsSystem.intro') }}</p>

    <!-- ── 1 · Settings overview ────────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">1</span>{{ $t('settings.help.settingsSystem.s1.title') }}</h2>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s1.p1')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s1.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s1.p2')"></p>
      <div class="syh-callout">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s1.callout.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s1.callout.text', searchGaps)"></div>
      </div>

      <MockFigure
        :caption="$t('settings.help.settingsSystem.mock.nav.caption')"
        :legend="navLegend"
      >
        <MockSettings
          :nav-title="$t('settings.nav.title')"
          :groups="settingsGroups"
          :search="settingsSearch"
          :nav-mark="MARKS[1]"
          page-title=""
        />
      </MockFigure>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s1.h2') }}</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s1.tabTable.group') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s1.tabTable.tab') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s1.tabTable.what') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s1.tabTable.more') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in tabs" :key="row.key">
              <td v-if="row.groupKey" :rowspan="row.groupSpan" class="syh-group">{{ $t(row.groupKey) }}</td>
              <td class="syh-nowrap"><strong>{{ $t(row.navKey) }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s1.tabs.${row.key}.what`) }}</td>
              <td class="syh-muted">{{ $t(`settings.help.settingsSystem.s1.tabs.${row.key}.more`, topicNames) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s1.note')"></p>
    </section>

    <!-- ── 2 · General / Appearance / Status badges ─────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">2</span>{{ $t('settings.help.settingsSystem.s2.title') }}</h2>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s2.h1') }}</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s2.generalTable.name') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s2.generalTable.desc') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s2.generalTable.fallback') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in generalSettings" :key="row.key">
              <td><strong>{{ $t(row.nameKey) }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s2.generalSettings.${row.key}.desc`) }}</td>
              <td class="syh-nowrap">
                {{ $t(`settings.help.settingsSystem.s2.generalSettings.${row.key}.fallback`) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s2.h2') }}</h3>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s2.appearance.theme')"></li>
        <li v-html="$t('settings.help.settingsSystem.s2.appearance.colors')"></li>
        <li v-html="$t('settings.help.settingsSystem.s2.appearance.uiScale')"></li>
        <li v-html="$t('settings.help.settingsSystem.s2.appearance.restore')"></li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s2.callout.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s2.callout.text')"></div>
      </div>

      <h3 class="syh-h3">{{ $t('settings.nav.language') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s2.language')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s2.h3') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s2.p1')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s2.statusTable.state') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s2.statusTable.when') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s2.statusTable.color') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in statusBadges" :key="row.state">
              <td><code>{{ row.state }}</code></td>
              <td>{{ $t(`settings.help.settingsSystem.s2.statusBadges.${row.state}.when`) }}</td>
              <td class="syh-nowrap">{{ $t(row.colorKey) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s2.note')"></p>
    </section>

    <!-- ── 3 · Skills / Prompts / Memory ────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">3</span>{{ $t('settings.help.settingsSystem.s3.title') }}</h2>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s3.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p1')"></p>
      <div class="syh-callout">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s3.callout1.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s3.callout1.text')"></div>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p2')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s3.matrixTable.cell') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s3.matrixTable.meaning') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s3.matrixTable.who') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in skillMatrix" :key="key">
              <td class="syh-nowrap">
                <code>{{ $t(`settings.help.settingsSystem.s3.skillMatrix.${key}.cell`) }}</code>
              </td>
              <td>{{ $t(`settings.help.settingsSystem.s3.skillMatrix.${key}.meaning`) }}</td>
              <td>{{ $t(`settings.help.settingsSystem.s3.skillMatrix.${key}.who`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p3')"></p>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s3.liveRefresh')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s3.h2') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p4')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.cast')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.ring')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.overflow')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.preview')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.keyboard')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.prompts.disabled')"></li>
      </ul>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s3.note')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s3.h3') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p5')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s3.memory.levels')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.memory.notCreated')"></li>
        <li v-html="$t('settings.help.settingsSystem.s3.memory.reload')"></li>
      </ul>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s3.p6')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s3.coverageTable.category') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s3.coverageTable.meaning') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in memoryCoverage" :key="row.key">
              <td class="syh-nowrap"><strong>{{ $t(row.labelKey) }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s3.memoryCoverage.${row.key}.value`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s3.callout2.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s3.callout2.text')"></div>
      </div>
    </section>

    <!-- ── 4 · Shortcuts / Updates / Analyzer / Extensions ──────────── -->
    <section class="syh-section">
      <h2 class="syh-h2">
        <span class="syh-num">4</span>{{ $t('settings.help.settingsSystem.s4.title') }}
      </h2>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s4.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p1')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s4.shortcuts.record')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.shortcuts.instant')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.shortcuts.search')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.shortcuts.conflicts')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.shortcuts.reset')"></li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s4.callout.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s4.callout.text')"></div>
      </div>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s4.note')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s4.h2') }}</h3>
      <p class="syh-p">{{ $t('settings.help.settingsSystem.s4.p2') }}</p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s4.updateTable.stage') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s4.updateTable.toggle') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s4.updateTable.fallback') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in updateStages" :key="row.key">
              <td v-if="row.stageKey" :rowspan="row.stageSpan" class="syh-group">{{ $t(row.stageKey) }}</td>
              <td>{{ $t(`settings.help.settingsSystem.s4.updateStages.${row.key}.toggle`) }}</td>
              <td class="syh-nowrap">
                {{ $t(`settings.help.settingsSystem.s4.updateStages.${row.key}.fallback`) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p3')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p4')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.mirror')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s4.h3') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p5')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s4.analyzer.backend')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.analyzer.models')"></li>
        <li v-html="$t('settings.help.settingsSystem.s4.analyzer.benchmark')"></li>
      </ul>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s4.h4') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.policyIntro')"></p>
      <ul class="syh-list">
        <li v-for="key in policyRows" :key="key" v-html="$t(`settings.help.settingsSystem.s4.policy.${key}`)"></li>
      </ul>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s4.policyNote')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p6')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.p7')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.extRollback', extensionLabels)"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.extPrerelease', extensionLabels)"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.extNative', extensionLabels)"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s4.marketplace', extensionLabels)"></p>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s4.extNote')"></p>
    </section>

    <!-- ── 5 · Navide Cloud ─────────────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">5</span>{{ $t('settings.help.settingsSystem.s5.title') }}</h2>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p1')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s5.entries.account')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.entries.settings')"></li>
      </ul>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p2')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p3')"></p>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s5.callout1.title') }}</div>
        <div class="syh-callout-text">{{ $t('settings.help.settingsSystem.s5.callout1.text') }}</div>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p4')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h2') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p5')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.roster')"></p>
      <ol class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s5.pairing.step1')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.pairing.step2')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.pairing.step3')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.pairing.step4')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.pairing.step5')"></li>
      </ol>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s5.callout2.title') }}</div>
        <div class="syh-callout-text">{{ $t('settings.help.settingsSystem.s5.callout2.text') }}</div>
      </div>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s5.note1')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h3') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p6')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s5.needsYouTable.kind') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s5.needsYouTable.content') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s5.needsYouTable.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in needsYou" :key="row.key">
              <td class="syh-nowrap"><strong>{{ $t(row.labelKey) }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s5.needsYou.${row.key}.content`) }}</td>
              <td>{{ $t(`settings.help.settingsSystem.s5.needsYou.${row.key}.actions`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p7')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s5.trust.block')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.trust.unpair')"></li>
      </ul>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p8')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h4') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p9')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s5.rules.denyAll')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.rules.shape')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.rules.ownDevices')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.rules.online')"></li>
        <li v-html="$t('settings.help.settingsSystem.s5.rules.signed')"></li>
      </ul>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h5') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p10')"></p>
      <div class="syh-callout">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s5.callout3.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s5.callout3.text')"></div>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s5.h6') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s5.p11')"></p>
      <ul class="syh-list">
        <li v-for="key in syncRows" :key="key" v-html="$t(`settings.help.settingsSystem.s5.sync.${key}`)"></li>
      </ul>
    </section>

    <!-- ── 6 · Menus, standalone windows and schedules ──────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">6</span>{{ $t('settings.help.settingsSystem.s6.title') }}</h2>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s6.h1') }}</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s6.windowTable.item') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s6.windowTable.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in windowMenu" :key="row.key">
              <td><strong>{{ $t(row.labelKey) }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s6.windowMenu.${row.key}.value`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s6.note1')"></p>

      <div class="syh-card">
        <div class="syh-card-title">{{ $t('label.pipeline-manager') }}</div>
        <p class="syh-p" v-html="$t('settings.help.settingsSystem.s6.pipeline.p1')"></p>
        <p class="syh-p" v-html="$t('settings.help.settingsSystem.s6.pipeline.p2')"></p>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s6.h2') }}</h3>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s6.helpMenu.github')"></li>
        <li v-html="$t('settings.help.settingsSystem.s6.helpMenu.shortcuts')"></li>
        <li v-html="$t('settings.help.settingsSystem.s6.helpMenu.legal')"></li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s6.callout1.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s6.callout1.text')"></div>
      </div>

      <h3 class="syh-h3" v-html="$t('settings.help.settingsSystem.s6.h3')"></h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s6.p1')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s6.scheduleTable.section') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s6.scheduleTable.source') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s6.scheduleTable.actions') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in scheduleSections" :key="row.key">
              <td class="syh-nowrap"><strong>{{ $t(row.labelKey) }}</strong></td>
              <td><code>{{ $t(`settings.help.settingsSystem.s6.scheduleSections.${row.key}.source`) }}</code></td>
              <td>{{ $t(`settings.help.settingsSystem.s6.scheduleSections.${row.key}.actions`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s6.p2')"></p>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s6.note2')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s6.h4') }}</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s6.otherTable.window') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s6.otherTable.how') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in otherWindows" :key="key">
              <td class="syh-nowrap">{{ $t(`settings.help.settingsSystem.s6.otherWindows.${key}.window`) }}</td>
              <td>{{ $t(`settings.help.settingsSystem.s6.otherWindows.${key}.how`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="syh-callout">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s6.callout2.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s6.callout2.text')"></div>
      </div>
      <p class="syh-note">{{ $t('settings.help.settingsSystem.s6.note3') }}</p>
    </section>

    <!-- ── 7 · Resources and upkeep ─────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">7</span>{{ $t('settings.help.settingsSystem.s7.title') }}</h2>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s7.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s7.p1')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s7.resource.columns')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.resource.totals')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.resource.filters')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.resource.actions')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.resource.autoReclaim')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.resource.disk')"></li>
      </ul>

      <MockFigure
        :caption="$t('settings.help.settingsSystem.mock.resource.caption')"
        :legend="resourceLegend"
      >
        <MockPanel>
          <MockToolbar
            :label="$t('resource.title')"
            :buttons="[{ label: $t('resource.disk-scan') }, { label: $t('resource.refresh') }]"
            :mark="MARKS[0]"
          />
          <div class="syh-mock-cards">
            <MockPanel :label="$t('resource.cpu')" :note="sample('cpuTotal')" />
            <MockPanel :label="$t('resource.memory')" :note="sample('memTotal')" />
            <MockPanel :label="$t('resource.disk')" :note="sample('diskTotal')" />
          </div>
          <MockToolbar
            :buttons="resourceFilters"
            :note="`${$t('resource.sort-label')} · ${$t('resource.sort-memory')}`"
          />
          <MockPanel>
            <MockStatRow
              :name="$t('resource.col-name')"
              :values="resourceColumns"
              :action="$t('resource.col-trend')"
            />
            <MockStatRow
              v-for="(row, i) in resourceRows"
              :key="row.name"
              v-bind="row"
              :action="$t('resource.reclaim-row')"
              :mark="i === 0 ? MARKS[1] : undefined"
            />
          </MockPanel>
          <div class="syh-mock-foot">
            {{ $t('resource.auto-reclaim', { state: $t('label.on'), minutes: sample('autoReclaim') }) }}
          </div>
        </MockPanel>
      </MockFigure>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s7.note1')"></p>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s7.callout1.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s7.callout1.text')"></div>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s7.h2') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s7.p2')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s7.storageTable.category') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s7.storageTable.examples') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in storageCategories" :key="row.key">
              <td class="syh-nowrap"><strong>{{ $t(row.labelKey) }}</strong></td>
              <td>{{ $t(`settings.help.settingsSystem.s7.storageCategories.${row.key}.value`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s7.p3')"></p>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s7.p4')"></p>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s7.callout2.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s7.callout2.text')"></div>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s7.h3') }}</h3>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s7.orphans.leftover')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.orphans.backend')"></li>
        <li v-html="$t('settings.help.settingsSystem.s7.orphans.timeout')"></li>
      </ul>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s7.h4') }}</h3>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s7.maintenanceTable.symptom') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s7.maintenanceTable.where') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in maintenance" :key="key">
              <td>{{ $t(`settings.help.settingsSystem.s7.maintenance.${key}.symptom`) }}</td>
              <td>{{ $t(`settings.help.settingsSystem.s7.maintenance.${key}.where`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 8 · Usage: Token Monitor, Turn Stats, quota cycles ───────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">8</span>{{ $t('settings.help.settingsSystem.s8.title') }}</h2>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s8.p1')"></p>
      <div class="syh-tablewrap">
        <table class="syh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.settingsSystem.s8.whichTable.surface') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s8.whichTable.where') }}</th>
              <th>{{ $t('settings.help.settingsSystem.s8.whichTable.scope') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in usageSurfaces" :key="row.key">
              <td class="syh-nowrap"><strong>{{ $t(row.labelKey) }}</strong></td>
              <td v-html="$t(`settings.help.settingsSystem.s8.surfaces.${row.key}.where`)"></td>
              <td v-html="$t(`settings.help.settingsSystem.s8.surfaces.${row.key}.scope`)"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s8.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s8.p2')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s8.tokenMonitor.controls')"></li>
        <li v-html="$t('settings.help.settingsSystem.s8.tokenMonitor.stats')"></li>
        <li v-html="$t('settings.help.settingsSystem.s8.tokenMonitor.comparison')"></li>
        <li v-html="$t('settings.help.settingsSystem.s8.tokenMonitor.charts')"></li>
        <li v-html="$t('settings.help.settingsSystem.s8.tokenMonitor.table')"></li>
        <li v-html="$t('settings.help.settingsSystem.s8.tokenMonitor.quota')"></li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s8.callout1.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s8.callout1.text')"></div>
      </div>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s8.h2') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s8.p3')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s8.turnStats.columns')"></li>
        <li v-html="$t('settings.help.settingsSystem.s8.turnStats.account')"></li>
        <li v-html="$t('settings.help.settingsSystem.s8.turnStats.version')"></li>
        <li v-html="$t('settings.help.settingsSystem.s8.turnStats.export')"></li>
      </ul>
      <p class="syh-note" v-html="$t('settings.help.settingsSystem.s8.note1')"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s8.h3') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s8.p4')"></p>
      <ul class="syh-list">
        <li v-html="$t('settings.help.settingsSystem.s8.quotaCycles.tabs')"></li>
        <li v-html="$t('settings.help.settingsSystem.s8.quotaCycles.cycle')"></li>
        <li v-html="$t('settings.help.settingsSystem.s8.quotaCycles.periods')"></li>
      </ul>
      <div class="syh-callout syh-callout--warn">
        <div class="syh-callout-title">{{ $t('settings.help.settingsSystem.s8.callout2.title') }}</div>
        <div class="syh-callout-text" v-html="$t('settings.help.settingsSystem.s8.callout2.text')"></div>
      </div>
    </section>

    <!-- ── 9 · Security ─────────────────────────────────────────────── -->
    <section class="syh-section">
      <h2 class="syh-h2"><span class="syh-num">9</span>{{ $t('settings.help.settingsSystem.s9.title') }}</h2>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s9.p1', guardLabels)"></p>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s9.h1') }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s9.p2', guardLabels)"></p>
      <ul class="syh-list">
        <li v-for="key in guardItems" :key="key" v-html="$t(`settings.help.settingsSystem.s9.items.${key}`, guardLabels)"></li>
      </ul>

      <h3 class="syh-h3">{{ $t('settings.help.settingsSystem.s9.h2', guardLabels) }}</h3>
      <p class="syh-p" v-html="$t('settings.help.settingsSystem.s9.p3', guardLabels)"></p>
    </section>
  </div>
</template>

<style scoped>
/* Layout for the Resource Manager mock: the three summary cards sit in a row
   that wraps, and the auto-reclaim line under the table is a plain footnote. */
.syh-mock-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4em;
}
.syh-mock-cards > * { flex: 1 1 6em; }
.syh-mock-foot {
  color: var(--text-muted);
  font-size: 0.9em;
}
.syh {
  display: flex;
  flex-direction: column;
  gap: 26px;
  color: var(--text-primary);
  max-width: var(--settings-page-max);
}

.syh-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.syh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.syh-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.syh-num {
  color: var(--accent-fg);
  font-variant-numeric: tabular-nums;
  font-size: var(--font-sm);
}

.syh-h3 {
  margin: 10px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}

.syh-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}

.syh-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}

.syh-list {
  margin: 0;
  padding-left: 1.4em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.syh-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.syh-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.syh-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}
.syh-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.syh-callout--warn .syh-callout-title {
  color: var(--attention-fg);
}

.syh-card {
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.syh-card-title {
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}

.syh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.syh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-xs);
}
.syh-table th,
.syh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.syh-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.syh-table tr:last-child td { border-bottom: none; }

.syh-group {
  background: var(--bg-inset);
  font-size: var(--font-2xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  white-space: nowrap;
}
.syh-nowrap { white-space: nowrap; }
.syh-muted { color: var(--text-secondary); }

/* `code` and `.syh-kbd` also appear inside v-html prose, which carries no
   scoped data-v attribute — hence :deep(). */
.syh :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}

.syh :deep(.syh-kbd) {
  display: inline-block;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--font-2xs);
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-bottom-width: 2px;
  border-radius: var(--radius-sm);
  padding: 0 6px;
  white-space: nowrap;
  color: var(--text-primary);
}
</style>
