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

// Read-only icon reference, shown inside Settings → Help.
// This is where a user looks up "what does this button do": every icon below
// is drawn with the same path data the real surface uses, so the shapes match
// what is on screen. Static mirror — if a surface changes its icon, this file
// has to be updated by hand. All prose lives in the locale files under
// `settings.help.icons.*`; a tooltip or button label quoted here is read from
// the product's own locale key, so it follows the interface into whatever
// language the reader has set. Only status IDENTIFIERS (`running`, `awaiting`
// — the values, not their labels) stay in the template untranslated.
//
// Most rows keep their icon cell in the template, because the icon column is
// sometimes an inline SVG, sometimes a Unicode glyph, sometimes a colour dot,
// and sometimes just a placeholder word. Only the two purely textual tables
// use data rows.

interface StageBadgeRow {
  key: string
  /** The product's own locale key for the badge, not a literal: the badge on
   *  screen is translated, so a hard-coded 'Draft' here would describe a
   *  product the reader is not looking at. */
  badge: string
}

interface TextButtonRow {
  key: string
  /** Locale keys, one per label — a control offering two of them
   *  ("Pause delivery / Resume delivery") stays a single row. */
  name: string[]
}

// Plan stage badges. The progress bar under the badge uses the same palette,
// so the two are always consistent.
const stageBadges: StageBadgeRow[] = [
  { key: 'draft', badge: 'pane.plans.stage-draft' },
  { key: 'inReview', badge: 'pane.plans.stage-in-review' },
  { key: 'approved', badge: 'pane.plans.stage-approved' },
  { key: 'inProgress', badge: 'pane.plans.stage-in-progress' },
  { key: 'done', badge: 'pane.plans.stage-done' },
  { key: 'abandoned', badge: 'pane.plans.stage-abandoned' },
]

// The Messages panel has no icons at all — every control is a text button.
const messageButtons: TextButtonRow[] = [
  { key: 'pauseResume', name: ['msg.pause', 'msg.resume'] },
  { key: 'clearLog', name: ['msg.clear-log'] },
  { key: 'withdraw', name: ['msg.cancel'] },
  { key: 'resend', name: ['msg.retry'] },
]

const { t } = useI18n()

// Title-bar badges that are labelled in the product itself: the name and the
// explanation are the badge's own label and tooltip, so they cannot drift.
const titleBarBadges = computed(() => [
  { key: 'usageLimit', glyph: '⛔', name: `${t('pane.terminal.usage-limit-badge', { time: '…' })} / ${t('pane.terminal.usage-limit-badge-unknown')}`, what: t('pane.terminal.usage-limit-tooltip', { time: '…' }) },
  { key: 'switchAccount', glyph: '›', name: t('account-follow.quota-button'), what: t('account-follow.quota-button-tooltip') },
  { key: 'staleConfig', glyph: '⟳', name: t('pane.terminal.stale-config-badge'), what: t('pane.terminal.stale-config-tooltip-both') },
  { key: 'stopIneffective', glyph: '■', name: t('pane.terminal.stop-ineffective'), what: t('pane.terminal.stop-ineffective-tooltip') },
  { key: 'muted', glyph: '🔕', name: t('action.mute'), what: t('pane.terminal.muted-tooltip') },
  { key: 'readback', glyph: '🔊', name: t('pane.terminal.readback-speaking'), what: t('pane.terminal.readback-on-tooltip') },
  { key: 'guard', glyph: '🛡', name: t('guard.pane.badge'), what: t('guard.pane.explain') },
  { key: 'risk', glyph: '!', name: `${t('cli-risk.network-title')} / ${t('cli-risk.disk-title')}`, what: t('settings.help.icons.s2.titleBar.riskPill.what', { analyze: t('cli-risk.analyze') }) },
])

// ── Chapter locator ─────────────────────────────────────────────────────────
// The one picture this topic needs. Every table row already DRAWS its icon, so
// re-drawing the icons would add nothing; what a table cannot give is where a
// region is, and the callout above asks the reader to start by naming the
// region. So the marks here are the chapter numbers, not ①②③ — the picture is
// a table of contents for the main window. Chapters 5 (Git pane) and 6 (Plan
// window) are separate surfaces, 8 is about colour and 9 about the icons a
// prompt skill can wear, so they are absent rather than faked.
const LOCATOR_CHAPTERS = ['1', '2', '3', '4', '7'] as const

/** Sample name, kept in the locale files so the picture hard-codes no prose. */
function sample(key: string): string {
  return t(`settings.help.icons.mock.sample.${key}`)
}

/** The status word the pane pill and the sidebar dot share. */
function statusWord(status: string): string {
  return t(`paneStatus.${status}`)
}

const locatorLegend = computed(() =>
  (['sidebar', 'panes', 'tabs', 'status', 'rail'] as const).map((row, i) => ({
    mark: LOCATOR_CHAPTERS[i],
    label: t(`settings.help.icons.mock.locator.legend.${row}.label`),
    text: t(`settings.help.icons.mock.locator.legend.${row}.text`),
  })),
)

// The sidebar's tab strip and the right rail's, in the order each draws them.
const locatorSidebarIcons = ['\u{1F916}', '\u{1F500}', '\u{1F4C1}', '\u{1F33F}', '\u{1F4CB}']
const locatorRail = computed(() => [
  { icon: '\u{1F4DC}', label: t('label.history') },
  { icon: '\u{1F4CA}', label: t('label.tokens') },
  { icon: '\u2709', label: t('label.messages') },
])
const locatorTabs = computed(() => [
  { label: sample('group'), count: 2, status: 'running' as const },
])
const locatorStatusLeft = computed(() => [{ text: sample('backend'), dot: true }])
const locatorStatusRight = computed(() => [sample('clock')])
</script>

<template>
  <div class="irh">
    <p class="irh-intro" v-html="$t('settings.help.icons.intro')"></p>

    <div class="irh-callout">
      <div class="irh-callout-title">{{ $t('settings.help.icons.howto.title') }}</div>
      <div class="irh-callout-text">{{ $t('settings.help.icons.howto.text') }}</div>
    </div>

    <!-- Where each chapter lives. The marks are chapter numbers, so the
         picture doubles as this topic's table of contents. -->
    <MockFigure
      :caption="$t('settings.help.icons.mock.locator.caption')"
      :legend="locatorLegend"
    >
      <MockWindow
        :title="sample('workspace')"
        :branch="sample('branch')"
        :status-left="locatorStatusLeft"
        :status-right="locatorStatusRight"
        :status-mark="LOCATOR_CHAPTERS[3]"
      >
        <MockSidebar
          :icons="locatorSidebarIcons"
          :active="0"
          :mark="LOCATOR_CHAPTERS[0]"
        >
          <MockTreeRow kind="workspace" :label="sample('workspace')" :count="2" />
          <MockTreeRow kind="group" :label="sample('group')" :count="2" />
          <MockTreeRow
            kind="pane"
            :label="sample('pane1')"
            :sub="sample('sub1')"
            status="running"
            active
          />
          <MockTreeRow kind="pane" :label="sample('pane2')" :sub="sample('sub2')" status="idle" />
        </MockSidebar>
        <MockStage
          :tabs="locatorTabs"
          :active="0"
          :tab-mark="LOCATOR_CHAPTERS[2]"
          :grid-mark="LOCATOR_CHAPTERS[1]"
          :columns="2"
        >
          <MockPaneCard
            :title="sample('pane1')"
            status="running"
            :status-label="statusWord('running')"
            :lines="3"
            focus
          />
          <MockPaneCard
            :title="sample('pane2')"
            status="idle"
            :status-label="statusWord('idle')"
            :lines="3"
          />
        </MockStage>
        <MockRail :items="locatorRail" :mark="LOCATOR_CHAPTERS[4]" />
      </MockWindow>
    </MockFigure>

    <!-- ── 1 · Sidebar ──────────────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">1 · {{ $t('settings.help.icons.s1.title') }}</h2>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s1.h1') }}</h3>
      <p class="irh-p" v-html="$t('settings.help.icons.s1.p1')"></p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0Zm0 4.5a1.25 1.25 0 1 1 2.5 0A1.25 1.25 0 0 1 2 8Zm0 4.5a1.25 1.25 0 1 1 2.5 0 1.25 1.25 0 0 1-2.5 0ZM6.5 2.75A.75.75 0 0 1 7.25 2h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm0 4.5A.75.75 0 0 1 7.25 6.5h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm0 4.5a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Z"/></svg>
              </td>
              <td><code>{{ $t('label.agents') }} (⌘1)</code></td>
              <td>{{ $t('settings.help.icons.s1.tabs.agents.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.tabs.agents.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M0 1.75C0 .784.784 0 1.75 0h3.5C6.216 0 7 .784 7 1.75v3.5A1.75 1.75 0 0 1 5.25 7H4v4a1 1 0 0 0 1 1h4v-1.25C9 9.784 9.784 9 10.75 9h3.5c.966 0 1.75.784 1.75 1.75v3.5A1.75 1.75 0 0 1 14.25 16h-3.5A1.75 1.75 0 0 1 9 14.25v-.75H5A2.5 2.5 0 0 1 2.5 11V7h-.75A1.75 1.75 0 0 1 0 5.25Zm1.75-.25a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-3.5a.25.25 0 0 0-.25-.25Zm9 9a.25.25 0 0 0-.25.25v3.5c0 .138.112.25.25.25h3.5a.25.25 0 0 0 .25-.25v-3.5a.25.25 0 0 0-.25-.25Z"/></svg>
              </td>
              <td><code>{{ $t('label.pipeline') }} (⌘2)</code></td>
              <td>{{ $t('settings.help.icons.s1.tabs.pipeline.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.tabs.pipeline.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5L6.2 1.7A1.75 1.75 0 0 0 4.96 1H1.75Z"/></svg>
              </td>
              <td><code>{{ $t('label.explorer') }} (⌘3)</code></td>
              <td>{{ $t('settings.help.icons.s1.tabs.explorer.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.tabs.explorer.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25z"/></svg>
              </td>
              <td><code>{{ $t('label.git') }} (⌘4)</code></td>
              <td>{{ $t('settings.help.icons.s1.tabs.git.where') }}</td>
              <td v-html="$t('settings.help.icons.s1.tabs.git.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2a1 1 0 0 0-1 1H2.75A1.75 1.75 0 0 0 1 4.75v9.5c0 .966.784 1.75 1.75 1.75h10.5A1.75 1.75 0 0 0 15 14.25v-9.5A1.75 1.75 0 0 0 13.25 3H12a1 1 0 0 0-1-1H5Zm0 2h6v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4Zm-2.25.5H4a2.5 2.5 0 0 0 2 1h4a2.5 2.5 0 0 0 2-1h1.25a.25.25 0 0 1 .25.25v9.5a.25.25 0 0 1-.25.25H2.75a.25.25 0 0 1-.25-.25v-9.5a.25.25 0 0 1 .25-.25Z"/></svg>
              </td>
              <td><code>{{ $t('label.plans') }} (⌘5)</code></td>
              <td>{{ $t('settings.help.icons.s1.tabs.plans.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.tabs.plans.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◇</span></td>
              <td>{{ $t('settings.help.icons.s1.tabs.plugin.name') }}</td>
              <td>{{ $t('settings.help.icons.s1.tabs.plugin.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.tabs.plugin.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">‹</span></td>
              <td v-html="$t('settings.help.icons.s1.tabs.collapse.name')"></td>
              <td>{{ $t('settings.help.icons.s1.tabs.collapse.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.tabs.collapse.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s1.h2') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="1.5" width="10" height="10" rx="1"/><rect x="1.5" y="4.5" width="10" height="10" rx="1"/><path d="M4 9.5h5"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s1.ws.collapseAll.name')"></td>
              <td>{{ $t('settings.help.icons.s1.ws.collapseAll.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.ws.collapseAll.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td v-html="$t('settings.help.icons.s1.ws.openWorkspace.name')"></td>
              <td>{{ $t('settings.help.icons.s1.ws.openWorkspace.where') }}</td>
              <td v-html="$t('settings.help.icons.s1.ws.openWorkspace.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 12.5v-9h4l1.5 2h7v7z"/></svg>
              </td>
              <td>{{ $t('settings.help.icons.s1.ws.folderMark.name') }}</td>
              <td>{{ $t('settings.help.icons.s1.ws.folderMark.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.ws.folderMark.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">›</span> / <span class="irh-glyph">⌄</span></td>
              <td v-html="$t('settings.help.icons.s1.ws.subtree.name')"></td>
              <td>{{ $t('settings.help.icons.s1.ws.subtree.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.ws.subtree.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-avatar" aria-hidden="true">A</span></td>
              <td>{{ $t('settings.help.icons.s1.ws.agentAvatar.name') }}</td>
              <td>{{ $t('settings.help.icons.s1.ws.agentAvatar.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.ws.agentAvatar.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 3.5v4h-4M2.5 12.5v-4h4M12.7 7A5 5 0 0 0 4 4.5L2.5 6M3.3 9A5 5 0 0 0 12 11.5l1.5-1.5"/></svg>
              </td>
              <td><code>{{ $t('action.rebuild-all-cli-panes') }}</code></td>
              <td>{{ $t('settings.help.icons.s1.ws.rebuildAll.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.ws.rebuildAll.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5h-1A1.5 1.5 0 0 0 3 5v8.5A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5V5a1.5 1.5 0 0 0-1.5-1.5h-1"/><rect x="5.5" y="1.5" width="5" height="3" rx="1"/><path d="M5.75 8h4.5M5.75 11h3"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s1.ws.history.name')"></td>
              <td>{{ $t('settings.help.icons.s1.ws.history.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.ws.history.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M14 8.6V4.25A1.75 1.75 0 0 0 12.25 2.5h-8.5A1.75 1.75 0 0 0 2 4.25v7.5A1.75 1.75 0 0 0 3.75 13.5H8.6"/><path d="M4.9 5.9 7.4 8.4 4.9 10.9"/><path d="M12.25 9.75v5M9.75 12.25h5"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s1.ws.openAgent.name')"></td>
              <td>{{ $t('settings.help.icons.s1.ws.openAgent.where') }}</td>
              <td v-html="$t('settings.help.icons.s1.ws.openAgent.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td v-html="$t('settings.help.icons.s1.ws.newGroup.name')"></td>
              <td>{{ $t('settings.help.icons.s1.ws.newGroup.where') }}</td>
              <td v-html="$t('settings.help.icons.s1.ws.newGroup.what')"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s1.h3') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">›</span> / <span class="irh-glyph">⌄</span></td>
              <td v-html="$t('settings.help.icons.s1.group.groupSubtree.name')"></td>
              <td>{{ $t('settings.help.icons.s1.group.groupSubtree.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.group.groupSubtree.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td v-html="$t('settings.help.icons.s1.group.openInGroup.name')"></td>
              <td>{{ $t('settings.help.icons.s1.group.openInGroup.where') }}</td>
              <td v-html="$t('settings.help.icons.s1.group.openInGroup.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▸</span> / <span class="irh-glyph">▾</span></td>
              <td v-html="$t('settings.help.icons.s1.group.lineageSubtree.name')"></td>
              <td>{{ $t('settings.help.icons.s1.group.lineageSubtree.where') }}</td>
              <td v-html="$t('settings.help.icons.s1.group.lineageSubtree.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◦</span></td>
              <td><code>{{ $t('pane.terminal.auto-named-tooltip') }}</code></td>
              <td>{{ $t('settings.help.icons.s1.group.autoNamed.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.group.autoNamed.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">🎯</span></td>
              <td><code>{{ $t('label.stage-manager-tooltip') }}</code></td>
              <td v-html="$t('settings.help.icons.s1.group.stageManager.where')"></td>
              <td>{{ $t('settings.help.icons.s1.group.stageManager.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
              </td>
              <td><code>{{ $t('label.docked-in-sidebar') }}</code></td>
              <td v-html="$t('settings.help.icons.s1.group.docked.where')"></td>
              <td>{{ $t('settings.help.icons.s1.group.docked.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▶</span></td>
              <td>{{ $t('settings.help.icons.s1.group.expandRow.name') }}</td>
              <td>{{ $t('settings.help.icons.s1.group.expandRow.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.group.expandRow.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 3.5v4h-4M2.5 12.5v-4h4M12.7 7A5 5 0 0 0 4 4.5L2.5 6M3.3 9A5 5 0 0 0 12 11.5l1.5-1.5"/></svg>
              </td>
              <td><code>{{ $t('pane.terminal.rebuild-tooltip') }}</code></td>
              <td>{{ $t('settings.help.icons.s1.group.rebuild.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.group.rebuild.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⊟</span></td>
              <td v-html="$t('settings.help.icons.s1.group.minimize.name')"></td>
              <td>{{ $t('settings.help.icons.s1.group.minimize.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.group.minimize.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⚙</span></td>
              <td><code>{{ $t('action.manage-pipelines') }}</code></td>
              <td>{{ $t('settings.help.icons.s1.group.managePipelines.where') }}</td>
              <td>{{ $t('settings.help.icons.s1.group.managePipelines.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↺</span></td>
              <td v-html="$t('settings.help.icons.s1.group.startOver.name')"></td>
              <td v-html="$t('settings.help.icons.s1.group.startOver.where')"></td>
              <td>{{ $t('settings.help.icons.s1.group.startOver.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 2 · The pane itself ──────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">2 · {{ $t('settings.help.icons.s2.title') }}</h2>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s2.h1') }}</h3>
      <p class="irh-p">{{ $t('settings.help.icons.s2.p1') }}</p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 3.5v4h-4M2.5 12.5v-4h4M12.7 7A5 5 0 0 0 4 4.5L2.5 6M3.3 9A5 5 0 0 0 12 11.5l1.5-1.5"/></svg>
              </td>
              <td><code>{{ $t('pane.terminal.rebuild-tooltip') }}</code></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.rebuild.where') }}</td>
              <td v-html="$t('settings.help.icons.s2.titleBar.rebuild.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⊟</span></td>
              <td v-html="$t('settings.help.icons.s2.titleBar.minimize.name')"></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.minimize.where') }}</td>
              <td>{{ $t('settings.help.icons.s2.titleBar.minimize.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◦</span></td>
              <td v-html="$t('settings.help.icons.s2.titleBar.autoNamed.name')"></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.autoNamed.where') }}</td>
              <td>{{ $t('settings.help.icons.s2.titleBar.autoNamed.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">🎯</span></td>
              <td><code>{{ $t('pane.terminal.commander-tooltip') }}</code></td>
              <td v-html="$t('settings.help.icons.s2.titleBar.globalManager.where')"></td>
              <td>{{ $t('pane.terminal.commander-tooltip') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">∞</span></td>
              <td v-html="$t('settings.help.icons.s2.titleBar.loop.name')"></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.loop.where') }}</td>
              <td v-html="$t('settings.help.icons.s2.titleBar.loop.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">∞</span></td>
              <td v-html="$t('settings.help.icons.s2.titleBar.loopActive.name')"></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.loopActive.where') }}</td>
              <td>{{ $t('settings.help.icons.s2.titleBar.loopActive.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⚠</span></td>
              <td v-html="$t('settings.help.icons.s2.titleBar.loginExpired.name')"></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.loginExpired.where') }}</td>
              <td v-html="$t('settings.help.icons.s2.titleBar.loginExpired.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⚠</span></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.quotaWarn.name') }}</td>
              <td>{{ $t('settings.help.icons.s2.titleBar.quotaWarn.where') }}</td>
              <td>{{ $t('settings.help.icons.s2.titleBar.quotaWarn.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-plain">{{ $t('settings.help.icons.s2.titleBar.quota.sample') }}</span></td>
              <td v-html="$t('settings.help.icons.s2.titleBar.quota.name')"></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.quota.where') }}</td>
              <td v-html="$t('settings.help.icons.s2.titleBar.quota.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✓</span></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.activeAccount.name') }}</td>
              <td>{{ $t('settings.help.icons.s2.titleBar.activeAccount.where') }}</td>
              <td>{{ $t('settings.help.icons.s2.titleBar.activeAccount.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">～</span></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.cachedQuota.name') }}</td>
              <td>{{ $t('settings.help.icons.s2.titleBar.cachedQuota.where') }}</td>
              <td>{{ $t('settings.help.icons.s2.titleBar.cachedQuota.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td v-html="$t('settings.help.icons.s2.titleBar.addAccounts.name')"></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.addAccounts.where') }}</td>
              <td>{{ $t('settings.help.icons.s2.titleBar.addAccounts.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↻</span></td>
              <td v-html="$t('settings.help.icons.s2.titleBar.continue.name')"></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.continue.where') }}</td>
              <td v-html="$t('settings.help.icons.s2.titleBar.continue.what')"></td>
            </tr>
            <tr v-for="row in titleBarBadges" :key="row.key">
              <td class="irh-icocell"><span class="irh-glyph">{{ row.glyph }}</span></td>
              <td><code>{{ row.name }}</code></td>
              <td>{{ $t('settings.help.icons.s2.titleBar.loop.where') }}</td>
              <td v-html="row.what"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s2.h2') }}</h3>
      <p class="irh-p">{{ $t('settings.help.icons.s2.p2') }}</p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↩</span></td>
              <td v-html="$t('settings.help.icons.s2.placeholder.resume.name')"></td>
              <td>{{ $t('settings.help.icons.s2.placeholder.resume.where') }}</td>
              <td v-html="$t('settings.help.icons.s2.placeholder.resume.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⊟</span></td>
              <td v-html="$t('settings.help.icons.s2.placeholder.minimize.name')"></td>
              <td>{{ $t('settings.help.icons.s2.placeholder.minimize.where') }}</td>
              <td>{{ $t('settings.help.icons.s2.placeholder.minimize.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◦</span></td>
              <td><code>{{ $t('pane.terminal.auto-named-tooltip') }}</code></td>
              <td>{{ $t('settings.help.icons.s2.placeholder.autoNamed.where') }}</td>
              <td>{{ $t('settings.help.icons.s2.placeholder.autoNamed.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 3 · Stage and tab bar ────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">3 · {{ $t('settings.help.icons.s3.title') }}</h2>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s3.h1') }}</h3>
      <p class="irh-p">{{ $t('settings.help.icons.s3.p1') }}</p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⊞</span></td>
              <td><code>{{ $t('label.view-mode-grid') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.modes.grid.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.modes.grid.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◧</span></td>
              <td><code>{{ $t('label.view-mode-sidebar') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.modes.sidebar.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.modes.sidebar.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◎</span></td>
              <td><code>{{ $t('label.view-mode-spotlight') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.modes.spotlight.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.modes.spotlight.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⧉</span></td>
              <td><code>{{ $t('label.view-mode-fullscreen') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.modes.fullscreen.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.modes.fullscreen.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s3.h2') }}</h3>
      <p class="irh-p">{{ $t('settings.help.icons.s3.p2') }}</p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">∞</span></td>
              <td><code>{{ $t('label.grid-ratio-auto') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.gridBar.auto.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.gridBar.auto.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">2×1</span></td>
              <td><code>{{ $t('label.grid-ratio-2x1') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.gridBar.r2x1.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.gridBar.r2x1.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">2×2</span></td>
              <td><code>{{ $t('label.grid-ratio-2x2') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.gridBar.r2x2.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.gridBar.r2x2.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">3×3</span></td>
              <td><code>{{ $t('label.grid-ratio-3x3') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.gridBar.r3x3.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.gridBar.r3x3.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">×</span></td>
              <td><code>{{ $t('label.grid-custom-columns') }}</code> / <code>{{ $t('label.grid-custom-rows') }}</code></td>
              <td v-html="$t('settings.help.icons.s3.gridBar.custom.where')"></td>
              <td>{{ $t('settings.help.icons.s3.gridBar.custom.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">‹</span></td>
              <td><code>{{ $t('action.prev-page') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.gridBar.prevPage.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.gridBar.prevPage.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">›</span></td>
              <td><code>{{ $t('action.next-page') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.gridBar.nextPage.where') }}</td>
              <td v-html="$t('settings.help.icons.s3.gridBar.nextPage.what')"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s3.h3') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td v-html="$t('settings.help.icons.s3.tabBar.deleteTab.name')"></td>
              <td>{{ $t('settings.help.icons.s3.tabBar.deleteTab.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.tabBar.deleteTab.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">+</span></td>
              <td v-html="$t('settings.help.icons.s3.tabBar.addTab.name')"></td>
              <td>{{ $t('settings.help.icons.s3.tabBar.addTab.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.tabBar.addTab.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 3.5v4h-4M2.5 12.5v-4h4M12.7 7A5 5 0 0 0 4 4.5L2.5 6M3.3 9A5 5 0 0 0 12 11.5l1.5-1.5"/></svg>
              </td>
              <td><code>{{ $t('action.rebuild-tab-cli-panes') }}</code></td>
              <td>{{ $t('settings.help.icons.s3.tabBar.rebuildTab.where') }}</td>
              <td>{{ $t('settings.help.icons.s3.tabBar.rebuildTab.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 4 · Status bar ───────────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">4 · {{ $t('settings.help.icons.s4.title') }}</h2>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s4.h1') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 24 24" aria-hidden="true"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              </td>
              <td>{{ $t('settings.help.icons.s4.left.branch.name') }}</td>
              <td>{{ $t('settings.help.icons.s4.left.branch.where') }}</td>
              <td v-html="$t('settings.help.icons.s4.left.branch.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↓</span> <span class="irh-glyph">↑</span></td>
              <td>{{ $t('settings.help.icons.s4.left.aheadBehind.name') }}</td>
              <td>{{ $t('settings.help.icons.s4.left.aheadBehind.where') }}</td>
              <td v-html="$t('settings.help.icons.s4.left.aheadBehind.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-plain">{{ $t('settings.help.icons.s4.left.backend.sample') }}</span></td>
              <td><code>{{ $t('label.backend-pill-connected') }}</code> / <code>{{ $t('label.backend-pill-down') }}</code> / <code>{{ $t('label.backend-pill-connecting') }}</code></td>
              <td>{{ $t('settings.help.icons.s4.left.backend.where') }}</td>
              <td v-html="$t('settings.help.icons.s4.left.backend.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▤</span></td>
              <td v-html="$t('settings.help.icons.s4.left.resources.name')"></td>
              <td v-html="$t('settings.help.icons.s4.left.resources.where')"></td>
              <td>{{ $t('settings.help.icons.s4.left.resources.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↑</span></td>
              <td v-html="$t('settings.help.icons.s4.left.updateAvailable.name')"></td>
              <td>{{ $t('settings.help.icons.s4.left.updateAvailable.where') }}</td>
              <td>{{ $t('settings.help.icons.s4.left.updateAvailable.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↓</span></td>
              <td v-html="$t('settings.help.icons.s4.left.updateDownloading.name')"></td>
              <td>{{ $t('settings.help.icons.s4.left.updateDownloading.where') }}</td>
              <td v-html="$t('settings.help.icons.s4.left.updateDownloading.what')"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s4.h2') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↻</span></td>
              <td v-html="$t('settings.help.icons.s4.right.tidying.name')"></td>
              <td>{{ $t('settings.help.icons.s4.right.tidying.where') }}</td>
              <td>{{ $t('settings.help.icons.s4.right.tidying.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⚠</span></td>
              <td v-html="$t('settings.help.icons.s4.right.leftover.name')"></td>
              <td>{{ $t('settings.help.icons.s4.right.leftover.where') }}</td>
              <td v-html="$t('settings.help.icons.s4.right.leftover.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⚡</span></td>
              <td v-html="$t('settings.help.icons.s4.right.disconnected.name')"></td>
              <td>{{ $t('settings.help.icons.s4.right.disconnected.where') }}</td>
              <td>{{ $t('settings.help.icons.s4.right.disconnected.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td v-html="$t('settings.help.icons.s4.right.dismiss.name')"></td>
              <td v-html="$t('settings.help.icons.s4.right.dismiss.where')"></td>
              <td>{{ $t('settings.help.icons.s4.right.dismiss.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">📢</span></td>
              <td v-html="$t('settings.help.icons.s4.right.announcements.name')"></td>
              <td>{{ $t('settings.help.icons.s4.right.announcements.where') }}</td>
              <td>{{ $t('settings.help.icons.s4.right.announcements.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-plain">{{ $t('settings.help.icons.s4.right.time.sample') }}</span></td>
              <td v-html="$t('settings.help.icons.s4.right.time.name')"></td>
              <td>{{ $t('settings.help.icons.s4.right.time.where') }}</td>
              <td v-html="$t('settings.help.icons.s4.right.time.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td v-html="$t('settings.help.icons.s4.right.closeAll.name')"></td>
              <td>{{ $t('settings.help.icons.s4.right.closeAll.where') }}</td>
              <td>{{ $t('settings.help.icons.s4.right.closeAll.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 5 · Git pane ─────────────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">5 · {{ $t('settings.help.icons.s5.title') }}</h2>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s5.h1') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 2.75a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM1.5 8a.75.75 0 1 1 1.5 0A.75.75 0 0 1 1.5 8zm.75 4.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM4.25 3.5h9.5a.75.75 0 0 0 0-1.5h-9.5a.75.75 0 0 0 0 1.5zM4 8.75h9.75a.75.75 0 0 0 0-1.5H4a.75.75 0 0 0 0 1.5zm0 5.5h9.75a.75.75 0 0 0 0-1.5H4a.75.75 0 0 0 0 1.5z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s5.toolbar.listView.name')"></td>
              <td>{{ $t('settings.help.icons.s5.toolbar.listView.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.toolbar.listView.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12v1.5H2zm0 3.5h12V9H2zm0 3.5h12v1.5H2z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s5.toolbar.treeView.name')"></td>
              <td>{{ $t('settings.help.icons.s5.toolbar.treeView.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.toolbar.treeView.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="1.5" width="10" height="10" rx="1"/><rect x="1.5" y="4.5" width="10" height="10" rx="1"/><path d="M4 9.5h5"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s5.toolbar.collapseAll.name')"></td>
              <td>{{ $t('settings.help.icons.s5.toolbar.collapseAll.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.toolbar.collapseAll.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 7.5A6 6 0 0 1 13 5.185V2.75a.75.75 0 0 1 1.5 0V7a.75.75 0 0 1-.75.75H9.25a.75.75 0 0 1 0-1.5h2.565A4.5 4.5 0 1 0 12 10a.75.75 0 1 1 1.261.815A6 6 0 1 1 1.5 7.5z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s5.toolbar.refresh.name')"></td>
              <td>{{ $t('settings.help.icons.s5.toolbar.refresh.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.toolbar.refresh.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="1.5"/><path d="M5.5 1.5v13M1.5 5.5h4"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s5.toolbar.newWindow.name')"></td>
              <td>{{ $t('settings.help.icons.s5.toolbar.newWindow.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.toolbar.newWindow.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0zm0 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM7 5v3.5l3 1.5-.5 1L6 9V5z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s5.toolbar.diffReview.name')"></td>
              <td>{{ $t('settings.help.icons.s5.toolbar.diffReview.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.toolbar.diffReview.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">···</span></td>
              <td v-html="$t('settings.help.icons.s5.toolbar.moreOptions.name')"></td>
              <td>{{ $t('settings.help.icons.s5.toolbar.moreOptions.where') }}</td>
              <td v-html="$t('settings.help.icons.s5.toolbar.moreOptions.what')"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s5.h2') }}</h3>
      <p class="irh-p">{{ $t('settings.help.icons.s5.p1') }}</p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td><code>{{ $t('action.stage') }}</code> / <code>{{ $t('action.stage-folder') }}</code> / <code>{{ $t('action.stage-all') }}</code></td>
              <td>{{ $t('settings.help.icons.s5.files.stage.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.files.stage.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">−</span></td>
              <td><code>{{ $t('action.unstage') }}</code> / <code>{{ $t('action.unstage-folder') }}</code> / <code>{{ $t('action.unstage-all') }}</code></td>
              <td>{{ $t('settings.help.icons.s5.files.unstage.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.files.unstage.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↩</span></td>
              <td><code>{{ $t('action.discard') }}</code> / <code>{{ $t('action.discard-folder') }}</code> / <code>{{ $t('action.discard-all') }}</code></td>
              <td>{{ $t('settings.help.icons.s5.files.discard.where') }}</td>
              <td v-html="$t('settings.help.icons.s5.files.discard.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⊡</span></td>
              <td><code>{{ $t('action.file-history-blame') }}</code></td>
              <td>{{ $t('settings.help.icons.s5.files.blame.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.files.blame.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↰</span></td>
              <td v-html="$t('settings.help.icons.s5.files.acceptOurs.name')"></td>
              <td v-html="$t('settings.help.icons.s5.files.acceptOurs.where')"></td>
              <td>{{ $t('settings.help.icons.s5.files.acceptOurs.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↱</span></td>
              <td v-html="$t('settings.help.icons.s5.files.acceptTheirs.name')"></td>
              <td>{{ $t('settings.help.icons.s5.files.acceptTheirs.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.files.acceptTheirs.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
              </td>
              <td>{{ $t('settings.help.icons.s5.files.folderMark.name') }}</td>
              <td>{{ $t('settings.help.icons.s5.files.folderMark.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.files.folderMark.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25V1.75zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5H3.75zm6.75.56v2.19c0 .138.112.25.25.25h2.19L10.5 2.06z"/></svg>
              </td>
              <td><code>{{ $t('action.open-diff-in-editor') }}</code></td>
              <td>{{ $t('settings.help.icons.s5.files.openDiff.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.files.openDiff.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s5.h3') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▾</span></td>
              <td v-html="$t('settings.help.icons.s5.commit.moreOptions.name')"></td>
              <td>{{ $t('settings.help.icons.s5.commit.moreOptions.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.commit.moreOptions.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✓</span></td>
              <td v-html="$t('settings.help.icons.s5.commit.commit.name')"></td>
              <td>{{ $t('settings.help.icons.s5.commit.commit.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.commit.commit.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✎</span></td>
              <td v-html="$t('settings.help.icons.s5.commit.amend.name')"></td>
              <td>{{ $t('settings.help.icons.s5.commit.amend.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.commit.amend.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↑</span></td>
              <td><code>{{ $t('action.commit-and-push') }}</code></td>
              <td>{{ $t('settings.help.icons.s5.commit.commitPush.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.commit.commitPush.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇅</span></td>
              <td><code>{{ $t('action.commit-and-sync') }}</code></td>
              <td>{{ $t('settings.help.icons.s5.commit.commitSync.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.commit.commitSync.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↺</span></td>
              <td v-html="$t('settings.help.icons.s5.commit.undo.name')"></td>
              <td>{{ $t('settings.help.icons.s5.commit.undo.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.commit.undo.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✦</span></td>
              <td v-html="$t('settings.help.icons.s5.commit.autoCommit.name')"></td>
              <td>{{ $t('settings.help.icons.s5.commit.autoCommit.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.commit.autoCommit.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⟳</span></td>
              <td>{{ $t('settings.help.icons.s5.commit.generating.name') }}</td>
              <td>{{ $t('settings.help.icons.s5.commit.generating.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.commit.generating.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s5.h4') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25z"/></svg>
              </td>
              <td>{{ $t('settings.help.icons.s5.branch.branchPill.name') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.branchPill.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.branchPill.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.561 8.073a6.005 6.005 0 0 1 3.432 5.142.75.75 0 1 1-1.498.07 4.5 4.5 0 0 0-8.99 0 .75.75 0 0 1-1.498-.07 6.004 6.004 0 0 1 3.431-5.142 3.999 3.999 0 1 1 5.622 0zM8 1.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s5.branch.account.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.account.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.account.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 7.5A6 6 0 0 1 13 5.185V2.75a.75.75 0 0 1 1.5 0V7a.75.75 0 0 1-.75.75H9.25a.75.75 0 0 1 0-1.5h2.565A4.5 4.5 0 1 0 12 10a.75.75 0 1 1 1.261.815A6 6 0 1 1 1.5 7.5z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s5.branch.fetch.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.fetch.where') }}</td>
              <td v-html="$t('settings.help.icons.s5.branch.fetch.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↓</span></td>
              <td v-html="$t('settings.help.icons.s5.branch.pull.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.pull.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.pull.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↑</span></td>
              <td v-html="$t('settings.help.icons.s5.branch.push.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.push.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.push.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇅</span></td>
              <td v-html="$t('settings.help.icons.s5.branch.sync.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.sync.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.sync.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▾</span></td>
              <td v-html="$t('settings.help.icons.s5.branch.morePushOptions.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.morePushOptions.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.morePushOptions.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇔</span></td>
              <td v-html="$t('settings.help.icons.s5.branch.compare.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.compare.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.compare.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇡</span></td>
              <td v-html="$t('settings.help.icons.s5.branch.rebase.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.rebase.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.rebase.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇣</span></td>
              <td v-html="$t('settings.help.icons.s5.branch.merge.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.merge.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.merge.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↵</span></td>
              <td v-html="$t('settings.help.icons.s5.branch.switch.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.switch.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.switch.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇅</span></td>
              <td v-html="$t('settings.help.icons.s5.branch.showRemotes.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.showRemotes.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.showRemotes.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⬇</span></td>
              <td v-html="$t('settings.help.icons.s5.branch.checkout.name')"></td>
              <td>{{ $t('settings.help.icons.s5.branch.checkout.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.branch.checkout.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s5.h5') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⎘</span></td>
              <td><code>{{ $t('action.stash-apply') }}</code></td>
              <td>{{ $t('settings.help.icons.s5.stash.apply.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.apply.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↑</span></td>
              <td><code>{{ $t('action.stash-pop') }}</code></td>
              <td>{{ $t('settings.help.icons.s5.stash.pop.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.pop.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td v-html="$t('settings.help.icons.s5.stash.drop.name')"></td>
              <td>{{ $t('settings.help.icons.s5.stash.drop.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.drop.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">↗</span></td>
              <td v-html="$t('settings.help.icons.s5.stash.openRemoteUrl.name')"></td>
              <td>{{ $t('settings.help.icons.s5.stash.openRemoteUrl.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.openRemoteUrl.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⧉</span></td>
              <td v-html="$t('settings.help.icons.s5.stash.openInNewWindow.name')"></td>
              <td>{{ $t('settings.help.icons.s5.stash.openInNewWindow.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.openInNewWindow.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◱</span></td>
              <td v-html="$t('settings.help.icons.s5.stash.revealInFinder.name')"></td>
              <td>{{ $t('settings.help.icons.s5.stash.revealInFinder.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.revealInFinder.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">🔒</span> <span class="irh-glyph">🔓</span></td>
              <td v-html="$t('settings.help.icons.s5.stash.lockUnlock.name')"></td>
              <td>{{ $t('settings.help.icons.s5.stash.lockUnlock.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.lockUnlock.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⇄</span></td>
              <td v-html="$t('settings.help.icons.s5.stash.move.name')"></td>
              <td>{{ $t('settings.help.icons.s5.stash.move.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.move.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td v-html="$t('settings.help.icons.s5.stash.remove.name')"></td>
              <td>{{ $t('settings.help.icons.s5.stash.remove.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.remove.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s5.stash.browseFolder.name')"></td>
              <td>{{ $t('settings.help.icons.s5.stash.browseFolder.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.browseFolder.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">＋</span></td>
              <td v-html="$t('settings.help.icons.s5.stash.addWorktree.name')"></td>
              <td>{{ $t('settings.help.icons.s5.stash.addWorktree.where') }}</td>
              <td>{{ $t('settings.help.icons.s5.stash.addWorktree.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="irh-callout irh-callout--warn">
        <div class="irh-callout-title">{{ $t('settings.help.icons.s5.callout.title') }}</div>
        <div class="irh-callout-text" v-html="$t('settings.help.icons.s5.callout.text')"></div>
      </div>
    </section>

    <!-- ── 6 · Plan window ──────────────────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">6 · {{ $t('settings.help.icons.s6.title') }}</h2>
      <p class="irh-p" v-html="$t('settings.help.icons.s6.p1')"></p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-plain">{{ $t('settings.help.icons.s6.toolbar.stageBadge.sample') }}</span></td>
              <td v-html="$t('settings.help.icons.s6.toolbar.stageBadge.name')"></td>
              <td>{{ $t('settings.help.icons.s6.toolbar.stageBadge.where') }}</td>
              <td>{{ $t('settings.help.icons.s6.toolbar.stageBadge.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">☑</span></td>
              <td v-html="$t('settings.help.icons.s6.toolbar.todos.name')"></td>
              <td>{{ $t('settings.help.icons.s6.toolbar.todos.where') }}</td>
              <td>{{ $t('settings.help.icons.s6.toolbar.todos.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">💬</span></td>
              <td><code>{{ $t('pane.plans.review-notes') }} · {{ $t('pane.plans.review-unresolved', { count: 'N' }) }}</code></td>
              <td>{{ $t('settings.help.icons.s6.toolbar.reviewNotes.where') }}</td>
              <td v-html="$t('settings.help.icons.s6.toolbar.reviewNotes.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▶</span></td>
              <td v-html="$t('settings.help.icons.s6.toolbar.execute.name')"></td>
              <td>{{ $t('settings.help.icons.s6.toolbar.execute.where') }}</td>
              <td v-html="$t('settings.help.icons.s6.toolbar.execute.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✓</span></td>
              <td v-html="$t('settings.help.icons.s6.toolbar.approve.name')"></td>
              <td>{{ $t('settings.help.icons.s6.toolbar.approve.where') }}</td>
              <td>{{ $t('settings.help.icons.s6.toolbar.approve.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⋯</span></td>
              <td v-html="$t('settings.help.icons.s6.toolbar.moreActions.name')"></td>
              <td>{{ $t('settings.help.icons.s6.toolbar.moreActions.where') }}</td>
              <td>{{ $t('settings.help.icons.s6.toolbar.moreActions.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▸</span></td>
              <td v-html="$t('settings.help.icons.s6.toolbar.outline.name')"></td>
              <td v-html="$t('settings.help.icons.s6.toolbar.outline.where')"></td>
              <td>{{ $t('settings.help.icons.s6.toolbar.outline.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">✕</span></td>
              <td>{{ $t('settings.help.icons.s6.toolbar.clearAnchor.name') }}</td>
              <td>{{ $t('settings.help.icons.s6.toolbar.clearAnchor.where') }}</td>
              <td>{{ $t('settings.help.icons.s6.toolbar.clearAnchor.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-plain">{{ $t('settings.help.icons.s6.toolbar.todoStatus.sample') }}</span></td>
              <td v-html="$t('settings.help.icons.s6.toolbar.todoStatus.name')"></td>
              <td v-html="$t('settings.help.icons.s6.toolbar.todoStatus.where')"></td>
              <td>{{ $t('settings.help.icons.s6.toolbar.todoStatus.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s6.h1') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.s6.stageTable.badge') }}</th>
              <th>{{ $t('settings.help.icons.s6.stageTable.color') }}</th>
              <th>{{ $t('settings.help.icons.s6.stageTable.meaning') }}</th>
              <th>{{ $t('settings.help.icons.s6.stageTable.canStart') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in stageBadges" :key="row.key">
              <td><code>{{ $t(row.badge) }}</code></td>
              <td class="irh-nowrap">{{ $t(`settings.help.icons.s6.stageBadges.${row.key}.color`) }}</td>
              <td>{{ $t(`settings.help.icons.s6.stageBadges.${row.key}.meaning`) }}</td>
              <td class="irh-nowrap">{{ $t(`settings.help.icons.s6.stageBadges.${row.key}.canStart`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="irh-note">{{ $t('settings.help.icons.s6.note') }}</p>
    </section>

    <!-- ── 7 · Right rail and Messages ──────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">7 · {{ $t('settings.help.icons.s7.title') }}</h2>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s7.h1') }}</h3>
      <p class="irh-p" v-html="$t('settings.help.icons.s7.p1')"></p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM3 8a5 5 0 1 1 10 0A5 5 0 0 1 3 8Z"/><path d="M7.4 4.5h1.2v3.4h2.9v1.2H7.4Z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s7.rail.history.name')"></td>
              <td>{{ $t('settings.help.icons.s7.rail.history.where') }}</td>
              <td>{{ $t('settings.help.icons.s7.rail.history.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 7.5h2.25v6H2.5Z"/><path d="M6.9 3.5h2.25v10H6.9Z"/><path d="M11.3 6h2.25v7.5H11.3Z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s7.rail.tokens.name')"></td>
              <td>{{ $t('settings.help.icons.s7.rail.tokens.where') }}</td>
              <td>{{ $t('settings.help.icons.s7.rail.tokens.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.75 3h8.5A1.75 1.75 0 0 1 14 4.75v8.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-8.5A1.75 1.75 0 0 1 3.75 3Zm0 1.5a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25Z"/><path d="M2.75 6.5h10.5V8H2.75Z"/><path d="M5 1a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 5 1Zm6 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 11 1Z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s7.rail.schedule.name')"></td>
              <td>{{ $t('settings.help.icons.s7.rail.schedule.where') }}</td>
              <td v-html="$t('settings.help.icons.s7.rail.schedule.what')"></td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 3h10.5A1.75 1.75 0 0 1 15 4.75v6.5A1.75 1.75 0 0 1 13.25 13H2.75A1.75 1.75 0 0 1 1 11.25v-6.5A1.75 1.75 0 0 1 2.75 3Zm0 1.5a.25.25 0 0 0-.25.25v6.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-6.5a.25.25 0 0 0-.25-.25Z"/><path d="M2.4 5.32a.75.75 0 0 1 1.04-.22L8 8.1l4.56-3a.75.75 0 1 1 .82 1.26l-4.97 3.26a.75.75 0 0 1-.82 0L2.62 6.36a.75.75 0 0 1-.22-1.04Z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s7.rail.messages.name')"></td>
              <td>{{ $t('settings.help.icons.s7.rail.messages.where') }}</td>
              <td>{{ $t('settings.help.icons.s7.rail.messages.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic irh-ic--filled" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5c3.1 0 5.7 2.1 6.9 4.2a.6.6 0 0 1 0 .6C13.7 10.4 11.1 12.5 8 12.5S2.3 10.4 1.1 8.3a.6.6 0 0 1 0-.6C2.3 5.6 4.9 3.5 8 3.5Zm0 1.5C5.6 5 3.4 6.6 2.3 8c1.1 1.4 3.3 3 5.7 3s4.6-1.6 5.7-3C12.6 6.6 10.4 5 8 5Z"/><path d="M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>
              </td>
              <td v-html="$t('settings.help.icons.s7.rail.preview.name')"></td>
              <td>{{ $t('settings.help.icons.s7.rail.preview.where') }}</td>
              <td>{{ $t('settings.help.icons.s7.rail.preview.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">›</span></td>
              <td v-html="$t('settings.help.icons.s7.rail.collapse.name')"></td>
              <td>{{ $t('settings.help.icons.s7.rail.collapse.where') }}</td>
              <td>{{ $t('settings.help.icons.s7.rail.collapse.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">⟲</span></td>
              <td><code>{{ $t('action.reset-run-counter') }}</code> / <code>{{ $t('action.wipe-workspace-history') }}</code> / <code>{{ $t('action.wipe-global-tally') }}</code></td>
              <td>{{ $t('settings.help.icons.s7.rail.resetCounters.where') }}</td>
              <td>{{ $t('settings.help.icons.s7.rail.resetCounters.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s7.h2') }}</h3>
      <div class="irh-callout irh-callout--warn">
        <div class="irh-callout-title">{{ $t('settings.help.icons.s7.callout.title') }}</div>
        <div class="irh-callout-text" v-html="$t('settings.help.icons.s7.callout.text')"></div>
      </div>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.table.name') }}</th>
              <th>{{ $t('settings.help.icons.table.where') }}</th>
              <th>{{ $t('settings.help.icons.table.what') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in messageButtons" :key="row.key">
              <td class="irh-icocell"><span class="irh-plain">{{ $t('settings.help.icons.s7.messages.sample') }}</span></td>
              <td><code>{{ row.name.map((k) => $t(k)).join(' / ') }}</code></td>
              <td>{{ $t(`settings.help.icons.s7.messageButtons.${row.key}.where`) }}</td>
              <td>{{ $t(`settings.help.icons.s7.messageButtons.${row.key}.effect`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 8 · Status colors and marks ──────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">8 · {{ $t('settings.help.icons.s8.title') }}</h2>
      <p class="irh-p">{{ $t('settings.help.icons.s8.p1') }}</p>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s8.h1') }}</h3>
      <p class="irh-p" v-html="$t('settings.help.icons.s8.p2')"></p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.s8.dotTable.sample') }}</th>
              <th>{{ $t('settings.help.icons.s8.dotTable.state') }}</th>
              <th>{{ $t('settings.help.icons.s8.dotTable.meaning') }}</th>
              <th>{{ $t('settings.help.icons.s8.dotTable.advice') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="running"></span>{{ $t('settings.help.icons.s8.dots.running.sample') }}</td>
              <td><code>running</code></td>
              <td>{{ $t('settings.help.icons.s8.dots.running.meaning') }}</td>
              <td>{{ $t('settings.help.icons.s8.dots.running.advice') }}</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="starting"></span>{{ $t('settings.help.icons.s8.dots.starting.sample') }}</td>
              <td><code>starting</code></td>
              <td>{{ $t('settings.help.icons.s8.dots.starting.meaning') }}</td>
              <td>{{ $t('settings.help.icons.s8.dots.starting.advice') }}</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="idle"></span>{{ $t('settings.help.icons.s8.dots.idle.sample') }}</td>
              <td><code>idle</code></td>
              <td>{{ $t('settings.help.icons.s8.dots.idle.meaning') }}</td>
              <td>{{ $t('settings.help.icons.s8.dots.idle.advice') }}</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="awaiting"></span>{{ $t('settings.help.icons.s8.dots.awaiting.sample') }}</td>
              <td><code>awaiting</code></td>
              <td v-html="$t('settings.help.icons.s8.dots.awaiting.meaning')"></td>
              <td>{{ $t('settings.help.icons.s8.dots.awaiting.advice') }}</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="waiting"></span>{{ $t('settings.help.icons.s8.dots.waiting.sample') }}</td>
              <td><code>waiting</code></td>
              <td>{{ $t('settings.help.icons.s8.dots.waiting.meaning') }}</td>
              <td>{{ $t('settings.help.icons.s8.dots.waiting.advice') }}</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="error"></span>{{ $t('settings.help.icons.s8.dots.error.sample') }}</td>
              <td><code>error</code></td>
              <td>{{ $t('settings.help.icons.s8.dots.error.meaning') }}</td>
              <td>{{ $t('settings.help.icons.s8.dots.error.advice') }}</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="exited"></span>{{ $t('settings.help.icons.s8.dots.exited.sample') }}</td>
              <td><code>exited</code></td>
              <td>{{ $t('settings.help.icons.s8.dots.exited.meaning') }}</td>
              <td>{{ $t('settings.help.icons.s8.dots.exited.advice') }}</td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-dot" data-state="stopped"></span>{{ $t('settings.help.icons.s8.dots.stopped.sample') }}</td>
              <td><code>stopped</code> / <code>disconnected</code></td>
              <td>{{ $t('settings.help.icons.s8.dots.stopped.meaning') }}</td>
              <td v-html="$t('settings.help.icons.s8.dots.stopped.advice')"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s8.h2') }}</h3>
      <p class="irh-p" v-html="$t('settings.help.icons.s8.p3')"></p>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.s8.sqTable.color') }}</th>
              <th>{{ $t('settings.help.icons.s8.sqTable.state') }}</th>
              <th>{{ $t('settings.help.icons.s8.sqTable.tooltip') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-nowrap"><span class="irh-sq" data-state="awaiting"></span>{{ $t('settings.help.icons.s8.squares.awaiting.sample') }}</td>
              <td><code>awaiting</code></td>
              <td v-html="$t('settings.help.icons.s8.squares.awaiting.tooltip')"></td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-sq" data-state="active"></span>{{ $t('settings.help.icons.s8.squares.active.sample') }}</td>
              <td><code>active</code></td>
              <td v-html="$t('settings.help.icons.s8.squares.active.tooltip')"></td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-sq" data-state="idle"></span>{{ $t('settings.help.icons.s8.squares.idle.sample') }}</td>
              <td><code>idle</code></td>
              <td v-html="$t('settings.help.icons.s8.squares.idle.tooltip')"></td>
            </tr>
            <tr>
              <td class="irh-nowrap"><span class="irh-sq" data-state="empty"></span>{{ $t('settings.help.icons.s8.squares.empty.sample') }}</td>
              <td><code>empty</code></td>
              <td v-html="$t('settings.help.icons.s8.squares.empty.tooltip')"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="irh-callout">
        <div class="irh-callout-title">{{ $t('settings.help.icons.s8.callout.title') }}</div>
        <div class="irh-callout-text">{{ $t('settings.help.icons.s8.callout.text') }}</div>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s8.h4') }}</h3>
      <p class="irh-p" v-html="$t('settings.help.icons.s8.p4')"></p>

      <div class="irh-callout">
        <div class="irh-callout-title">{{ $t('settings.help.icons.s8.callout2.title') }}</div>
        <div class="irh-callout-text" v-html="$t('settings.help.icons.s8.callout2.text')"></div>
      </div>

      <h3 class="irh-h3">{{ $t('settings.help.icons.s8.h3') }}</h3>
      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.s8.markTable.icon') }}</th>
              <th>{{ $t('settings.help.icons.s8.markTable.name') }}</th>
              <th>{{ $t('settings.help.icons.s8.markTable.where') }}</th>
              <th>{{ $t('settings.help.icons.s8.markTable.meaning') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">◦</span></td>
              <td v-html="$t('settings.help.icons.s8.marks.autoNamed.name')"></td>
              <td>{{ $t('settings.help.icons.s8.marks.autoNamed.where') }}</td>
              <td v-html="$t('settings.help.icons.s8.marks.autoNamed.meaning')"></td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">🎯</span></td>
              <td v-html="$t('settings.help.icons.s8.marks.manager.name')"></td>
              <td>{{ $t('settings.help.icons.s8.marks.manager.where') }}</td>
              <td>{{ $t('settings.help.icons.s8.marks.manager.meaning') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell"><span class="irh-glyph">▶</span></td>
              <td>{{ $t('settings.help.icons.s8.marks.expand.name') }}</td>
              <td>{{ $t('settings.help.icons.s8.marks.expand.where') }}</td>
              <td v-html="$t('settings.help.icons.s8.marks.expand.meaning')"></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 9 · Prompt skill icons ───────────────────────────────────── -->
    <section class="irh-section">
      <h2 class="irh-h2">9 · {{ $t('settings.help.icons.s9.title') }}</h2>
      <p class="irh-p" v-html="$t('settings.help.icons.s9.p1')"></p>

      <div class="irh-tablewrap">
        <table class="irh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.icons.table.icon') }}</th>
              <th>{{ $t('settings.help.icons.s9.nameCol') }}</th>
              <th>{{ $t('settings.help.icons.s9.useCol') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.6 3.8 7 8l-4.4 4.2zM8.6 3.8 13 8l-4.4 4.2z"/></svg>
              </td>
              <td><code>advance</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.advance.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.9" /><path d="M5.4 8.2 7.2 10l3.4-3.9"/></svg>
              </td>
              <td><code>green</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.green.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.3" /><path d="M10.2 10.2 13.6 13.6"/></svg>
              </td>
              <td><code>scan</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.scan.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.2h5l3 3v8.6H4zM9 2.2v3.1h3M6 9.2h4M6 11.2h2.6"/></svg>
              </td>
              <td><code>doc</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.doc.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7M13.2 2.4v2.6h-2.6"/></svg>
              </td>
              <td><code>refactor</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.refactor.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.1 2.5 13.5 4.9 6.2 12.2l-3.2 0.8 0.8-3.2zM9.9 3.7l2.4 2.4"/></svg>
              </td>
              <td><code>edit</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.edit.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.3 6.4a2.7 2.7 0 0 1 5.4 0v2.3a2.7 2.7 0 0 1-5.4 0zM6.4 4.7 5.3 3.2M9.6 4.7l1.1-1.5M5.3 7.2H2.8M10.7 7.2h2.5M5.7 9.8 3.6 11.3M10.3 9.8l2.1 1.5"/></svg>
              </td>
              <td><code>bug</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.bug.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 2.3v3.9L3.4 11.8a1.3 1.3 0 0 0 1.1 2h7a1.3 1.3 0 0 0 1.1-2L9.5 6.2V2.3M5.5 2.3h5M5.1 9.2h5.8"/></svg>
              </td>
              <td><code>test</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.test.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.9c2.1 1.8 3.2 4.1 3.2 6.4L8 11.4 4.8 8.3C4.8 6 5.9 3.7 8 1.9zM6.3 10.9 4.8 13.8l2.2-1M9.7 10.9l1.5 2.9-2.2-1M6.9 7.4a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0"/></svg>
              </td>
              <td><code>rocket</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.rocket.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 13 4v3.5c0 3-2 5.4-5 6.5-3-1.1-5-3.5-5-6.5V4z"/></svg>
              </td>
              <td><code>shield</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.shield.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.3 1.8 4.3 9h3.1l-.7 5.2L11.7 7H8.6z"/></svg>
              </td>
              <td><code>bolt</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.bolt.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.7 2.1 6.8 5l2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9L1.7 6.1 4.6 5zM11.5 8.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/></svg>
              </td>
              <td><code>sparkle</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.sparkle.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.8 2.1a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8M4.8 11.1a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8M11.2 2.1a1.4 1.4 0 1 0 0 2.8a1.4 1.4 0 1 0 0-2.8M4.8 4.9v6.2M4.8 8.2h3.2a3.2 3.2 0 0 0 3.2-3.2"/></svg>
              </td>
              <td><code>branch</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.branch.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.3 4.1c0-1.1 2.1-2 4.7-2s4.7.9 4.7 2-2.1 2-4.7 2-4.7-.9-4.7-2zM3.3 4.1v7.8c0 1.1 2.1 2 4.7 2s4.7-.9 4.7-2V4.1M3.3 8c0 1.1 2.1 2 4.7 2s4.7-.9 4.7-2"/></svg>
              </td>
              <td><code>database</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.database.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.4 3h11.2v10H2.4zM4.9 6.2 7 8.3l-2.1 2.1M8.7 10.6h2.9"/></svg>
              </td>
              <td><code>terminal</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.terminal.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.1 8a5.9 5.9 0 1 0 11.8 0a5.9 5.9 0 1 0-11.8 0M2.3 8h11.4M8 2.1c1.6 1.6 2.5 3.7 2.5 5.9S9.6 12.3 8 13.9C6.4 12.3 5.5 10.2 5.5 8S6.4 3.7 8 2.1z"/></svg>
              </td>
              <td><code>globe</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.globe.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.7 13.3h10.6M4.9 11V7.3M8 11V3.7M11.1 11V6.1"/></svg>
              </td>
              <td><code>chart</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.chart.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.1 8a5.9 5.9 0 1 0 11.8 0a5.9 5.9 0 1 0-11.8 0M8 4.7V8l2.4 1.6"/></svg>
              </td>
              <td><code>clock</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.clock.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.1 7h7.8v6.5H4.1zM5.9 7V5.1a2.1 2.1 0 0 1 4.2 0V7M8 9.4v1.7"/></svg>
              </td>
              <td><code>lock</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.lock.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 13.5 5v6L8 13.8 2.5 11V5zM2.5 5 8 7.8 13.5 5M8 7.8v6"/></svg>
              </td>
              <td><code>package</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.package.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.1 8a5.9 5.9 0 1 0 11.8 0a5.9 5.9 0 1 0-11.8 0M6.3 6.3a1.8 1.8 0 0 1 3.5.5c0 1.2-1.8 1.4-1.8 2.7M8 11.5v.1"/></svg>
              </td>
              <td><code>question</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.question.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.2h8.1M5.5 8h8.1M5.5 11.8h8.1M2.6 4.2h.1M2.6 8h.1M2.6 11.8h.1"/></svg>
              </td>
              <td><code>list</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.list.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 8s2.4-4.3 6.2-4.3S14.2 8 14.2 8s-2.4 4.3-6.2 4.3S1.8 8 1.8 8zM6.1 8a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0-3.8 0"/></svg>
              </td>
              <td><code>eye</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.eye.what') }}</td>
            </tr>
            <tr>
              <td class="irh-icocell">
                <svg class="irh-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 9.8 5.9l4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4L2.2 6.5l4-.6z"/></svg>
              </td>
              <td><code>star</code></td>
              <td>{{ $t('settings.help.icons.s9.builtin.star.what') }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="irh-note" v-html="$t('settings.help.icons.s9.p2')"></p>
    </section>
  </div>
</template>

<style scoped>
.irh {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: 92ch;
}

.irh-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.irh-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.irh-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.irh-callout--warn .irh-callout-title { color: var(--attention-fg); }
.irh-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.irh-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}

.irh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.irh-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
}
.irh-h3 {
  margin: 8px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-primary);
}
.irh-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}
.irh-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

/* This page has four-column tables with long English tooltip strings in them,
   so horizontal scrolling matters more here than anywhere else in Help. */
.irh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.irh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12.5px;
}
.irh-table th,
.irh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.irh-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.irh-table tr:last-child td { border-bottom: none; }
.irh-nowrap { white-space: nowrap; }

/* Fixed, centred icon column so the shapes line up down the table and stay
   comparable at a glance — that is the whole point of this page. */
.irh-icocell {
  width: 62px;
  min-width: 62px;
  text-align: center;
  white-space: nowrap;
}

/* Icons follow the text colour so both themes are correct without a second
   palette. Filled and stroked variants match how each surface draws them. */
.irh-ic {
  width: 17px;
  height: 17px;
  display: inline-block;
  vertical-align: -3px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  color: var(--text-primary);
}
.irh-ic--filled {
  fill: currentColor;
  stroke: none;
}
.irh-glyph {
  font-size: 15px;
  color: var(--text-primary);
}
/* Mirrors ControlPane's .ws-add-avatar (the + menu's agent avatar). */
.irh-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent-emphasis);
  color: var(--text-on-emphasis);
  font-size: var(--font-3xs);
  font-weight: 700;
}
.irh-plain {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
}

/* Swatches for chapter 8. These reuse the same tokens the real indicators use
   (ControlPane's .status-dot and StageTabBar's .tab-dot), so a recoloured
   theme moves the sample and the real thing together. They are static — the
   live dots animate, this page just names the colour. */
.irh-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 7px;
  vertical-align: 1px;
  background: var(--text-muted);
}
.irh-dot[data-state='running'] { background: var(--success-fg); }
.irh-dot[data-state='starting'] { background: var(--status-starting-fg); }
.irh-dot[data-state='idle'] { background: var(--status-idle-fg); }
.irh-dot[data-state='awaiting'] {
  background: var(--warning-fg);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--warning-fg) 25%, transparent);
}
.irh-dot[data-state='waiting'] {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--text-secondary);
}
.irh-dot[data-state='error'] {
  background: var(--danger-fg);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger-fg) 25%, transparent);
}
.irh-dot[data-state='exited'] {
  background: var(--text-disabled);
  opacity: 0.6;
}
.irh-dot[data-state='stopped'] { background: var(--text-muted); }

.irh-sq {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  margin-right: 7px;
  vertical-align: 1px;
  background: var(--border-default);
}
.irh-sq[data-state='awaiting'] { background: var(--warning-fg); }
.irh-sq[data-state='active'] { background: var(--success-fg); }
.irh-sq[data-state='idle'] { background: var(--status-idle-emphasis); }

/* `code` also appears inside v-html prose, which carries no scoped data-v
   attribute — hence :deep(). */
.irh :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}
</style>
