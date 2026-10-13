<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { MCP_CATALOG } from '../data/mcpCatalog'
import MockCardRow from './helpMocks/MockCardRow.vue'
import MockFigure from './helpMocks/MockFigure.vue'
import MockPaneCard from './helpMocks/MockPaneCard.vue'
import MockSettings from './helpMocks/MockSettings.vue'
import MockSidebar from './helpMocks/MockSidebar.vue'
import MockStage from './helpMocks/MockStage.vue'
import MockTreeRow from './helpMocks/MockTreeRow.vue'
import MockWindow from './helpMocks/MockWindow.vue'

// Read-only reference for how MCP is used in Navide, shown inside Settings →
// Help. The three directions below are genuinely separate subsystems that
// happen to share a protocol name; conflating them is the usual confusion.
// All prose lives in the locale files under `settings.help.mcp.*`; the tool
// names below are identifiers and stay here.

const planTools = [
  'plan_list',
  'plan_read',
  'plan_create',
  'plan_update_stage',
  'plan_update_todo',
  'plan_add_note',
] as const

const cliTools = [
  'cli_list_targets',
  'cli_whoami',
  'cli_send',
  'cli_send_and_wait',
  'cli_check_message',
  'cli_inbox_summary',
  'cli_pending_incoming',
  'cli_open_agent',
  'cli_list_sessions',
  'cli_read_incoming',
  'cli_cancel_message',
  'cli_read_log',
  'cli_get_status',
  'cli_wait_idle',
  'cli_interrupt',
  'cli_answer_prompt',
  'cli_close_agent',
  'cli_reclaim_agent',
  'cli_place_pane',
  'cli_message_log',
  'cli_usage',
  'cli_token_stats',
] as const

const workspaceTools = [
  'workspace_list',
  'workspace_open',
  'workspace_switch',
  'skills_list',
  'prompt_list',
  'memory_list',
  'mcp_list',
  'cli_extensions_list',
  'credentials_list',
  'credentials_findings',
  'pipeline_list',
  'pipeline_status',
  'pipeline_start',
  'pipeline_next',
  'pipeline_resume',
  'pipeline_abort',
  'pipeline_reset',
  'pipeline_restart',
  'pipeline_define',
  'pipeline_graph',
  'pipeline_gate',
  'pipeline_restart_from',
  'stage_define',
  'role_define',
  'scheduler_list',
  'scheduler_upsert',
  'scheduler_remove',
  'scheduler_set_enabled',
  'scheduler_run_now',
  'scheduler_runs',
  'cli_permission_settings',
] as const

// The Preview panel's four verbs: record adds to the feed, show pushes to it,
// list reads it and clear takes things off. Kept apart from the workspace
// group because they are one surface, not four unrelated settings.
const previewTools = [
  'preview_record',
  'preview_show',
  'preview_list',
  'preview_clear',
] as const

const uiTools = ['ui_list_actions', 'ui_invoke', 'ui_snapshot', 'ui_diagnostics'] as const

// Row keys for the comparison and troubleshooting tables; the text for each
// row is looked up under `settings.help.mcp.<section>.<table>.<key>`.
const comparison = ['server', 'caller', 'config', 'when', 'what'] as const

const { t } = useI18n()

// ── Mock screenshots ────────────────────────────────────────────────────────
// Two HTML pictures, drawn from the components they depict rather than
// captured, so they follow the user's theme and never show anyone's real
// project. Every word is a locale lookup, so an untranslated label is caught
// by the en-US rendering test.

const MARKS = ['\u2460', '\u2461', '\u2462']

function mockLegend(figure: string, rows: string[]): { mark: string; label: string; text: string }[] {
  return rows.map((row, i) => ({
    mark: MARKS[i],
    label: t(`settings.help.mcp.mock.${figure}.legend.${row}.label`),
    text: t(`settings.help.mcp.mock.${figure}.legend.${row}.text`),
  }))
}

/** Sample name, kept in the locale files so a picture never hard-codes prose. */
function sample(key: string): string {
  return t(`settings.help.mcp.mock.sample.${key}`)
}

/** The status word the pane pill and the sidebar dot share. */
function statusWord(status: string): string {
  return t(`paneStatus.${status}`)
}

const settingsLegend = computed(() => mockLegend('settings', ['nav', 'actions', 'card']))
const addressingLegend = computed(() => mockLegend('addressing', ['local', 'cross']))

// The Integrations group of the settings nav, in the order it draws them.
const settingsNav = computed(() => [
  { label: t('settings.nav.mcp'), active: true },
  { label: t('settings.nav.skills') },
  { label: t('settings.nav.prompts') },
  { label: t('settings.nav.memory') },
])

const settingsActions = computed(() => [
  t('action.add-mcp'),
  t('settings.mcp.add-custom'),
  t('action.refresh'),
])

// Straight off MCP_CATALOG, so the picture cannot drift from the real list.
// Context7 ships enabled, hence the Installed badge on the first row.
const catalogRows = computed(() =>
  MCP_CATALOG.slice(0, 3).map((entry, i) => ({
    name: entry.name,
    label: entry.label,
    text: t(entry.descriptionKey),
    installed: i === 0,
  })),
)

// The sidebar's tab strip, in the order it draws them.
const sidebarIcons = ['\u{1F916}', '\u{1F500}', '\u{1F4C1}', '\u{1F33F}', '\u{1F4CB}']

// One run-group tab per window: every workspace has at least one, so an
// empty tab bar would be a state the product never shows.
const tabsA = computed(() => [{ label: sample('group'), count: 2, status: 'running' as const }])
const tabsB = computed(() => [{ label: sample('group'), count: 1, status: 'idle' as const }])

const troubleshooting = [
  'noTools',
  'serverUnused',
  'planLoadFailed',
  'staleIdentity',
  'staleTools',
  'unknownSession',
  'externalRejected',
] as const
</script>

<template>
  <div class="mh">
    <p class="mh-intro" v-html="$t('settings.help.mcp.intro')"></p>

    <div class="mh-dirs">
      <div v-for="dir in ['provide', 'consume', 'external']" :key="dir" class="mh-dir">
        <div class="mh-dir-arrow">{{ $t(`settings.help.mcp.dirs.${dir}.arrow`) }}</div>
        <div class="mh-dir-title">{{ $t(`settings.help.mcp.dirs.${dir}.title`) }}</div>
        <p class="mh-dir-text" v-html="$t(`settings.help.mcp.dirs.${dir}.text`)"></p>
      </div>
    </div>

    <!-- ── Direction 1 ──────────────────────────────────────────────── -->
    <section class="mh-section">
      <h2 class="mh-h2">{{ $t('settings.help.mcp.s1.title') }}</h2>
      <p class="mh-p">{{ $t('settings.help.mcp.s1.p1') }}</p>

      <h3 class="mh-h3">{{ $t('settings.help.mcp.s1.h1') }}</h3>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <tbody>
            <tr v-for="name in planTools" :key="name">
              <td class="mh-tool"><code>{{ name }}</code></td>
              <td>{{ $t(`settings.help.mcp.s1.planTools.${name}`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="mh-note">{{ $t('settings.help.mcp.s1.note1') }}</p>

      <h3 class="mh-h3">{{ $t('settings.help.mcp.s1.h2') }}</h3>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <tbody>
            <tr v-for="name in workspaceTools" :key="name">
              <td class="mh-tool"><code>{{ name }}</code></td>
              <td>{{ $t(`settings.help.mcp.s1.workspaceTools.${name}`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="mh-note" v-html="$t('settings.help.mcp.s1.note2')"></p>

      <h3 class="mh-h3">{{ $t('settings.help.mcp.s1.h5') }}</h3>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <tbody>
            <tr v-for="name in previewTools" :key="name">
              <td class="mh-tool"><code>{{ name }}</code></td>
              <td>{{ $t(`settings.help.mcp.s1.previewTools.${name}`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="mh-h3">{{ $t('settings.help.mcp.s1.h3') }}</h3>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <tbody>
            <tr v-for="name in cliTools" :key="name">
              <td class="mh-tool"><code>{{ name }}</code></td>
              <td>{{ $t(`settings.help.mcp.s1.cliTools.${name}`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="mh-note" v-html="$t('settings.help.mcp.s1.note3')"></p>
      <p class="mh-note" v-html="$t('settings.help.mcp.s1.note4')"></p>
      <p class="mh-note" v-html="$t('settings.help.mcp.s1.note5')"></p>
      <p class="mh-note" v-html="$t('settings.help.mcp.s1.note9')"></p>

      <!-- Who a name reaches. Two windows side by side is the only way to show
           that a bare name never leaves its own one. -->
      <MockFigure
        :caption="$t('settings.help.mcp.mock.addressing.caption')"
        :legend="addressingLegend"
      >
        <div class="mh-mock-pair">
          <MockWindow :title="sample('workspaceA')">
            <MockSidebar :icons="sidebarIcons" :active="0" :mark="MARKS[0]">
              <MockTreeRow kind="workspace" :label="sample('workspaceA')" :count="2" />
              <MockTreeRow
                kind="pane"
                :label="sample('pane1')"
                :sub="sample('sub1')"
                status="running"
                active
              />
              <MockTreeRow
                kind="pane"
                :label="sample('pane2')"
                :sub="sample('sub2')"
                status="idle"
              />
            </MockSidebar>
            <MockStage :tabs="tabsA" :columns="1">
              <MockPaneCard
                :title="sample('pane1')"
                status="running"
                :status-label="statusWord('running')"
                :lines="3"
                focus
              />
            </MockStage>
          </MockWindow>

          <MockWindow :title="sample('workspaceB')" :mark="MARKS[1]">
            <MockSidebar :icons="sidebarIcons" :active="0">
              <MockTreeRow kind="workspace" :label="sample('workspaceB')" :count="1" />
              <MockTreeRow
                kind="pane"
                :label="sample('pane2')"
                :sub="sample('sub2')"
                status="idle"
              />
            </MockSidebar>
            <MockStage :tabs="tabsB" :columns="1">
              <MockPaneCard
                :title="sample('pane2')"
                status="idle"
                :status-label="statusWord('idle')"
                :lines="3"
              />
            </MockStage>
          </MockWindow>
        </div>
      </MockFigure>

      <h3 class="mh-h3">{{ $t('settings.help.mcp.s1.h4') }}</h3>
      <p class="mh-p" v-html="$t('settings.help.mcp.s1.p2')"></p>
      <p class="mh-note" v-html="$t('settings.help.mcp.s1.note6')"></p>
      <p class="mh-note" v-html="$t('settings.help.mcp.s1.note7')"></p>
      <p class="mh-note" v-html="$t('settings.help.mcp.s1.note8')"></p>
    </section>

    <!-- ── Direction 2 ──────────────────────────────────────────────── -->
    <section class="mh-section">
      <h2 class="mh-h2">{{ $t('settings.help.mcp.s2.title') }}</h2>
      <p class="mh-p" v-html="$t('settings.help.mcp.s2.p1')"></p>
      <p class="mh-p">{{ $t('settings.help.mcp.s2.p2') }}</p>
      <ul class="mh-list">
        <li v-html="$t('settings.help.mcp.s2.catalog.context7')"></li>
        <li v-html="$t('settings.help.mcp.s2.catalog.github')"></li>
        <li v-html="$t('settings.help.mcp.s2.catalog.filesystem')"></li>
        <li v-html="$t('settings.help.mcp.s2.catalog.brave-search')"></li>
        <li v-html="$t('settings.help.mcp.s2.catalog.sentry')"></li>
      </ul>

      <!-- The page those entries are added from. The rows come straight off
           MCP_CATALOG, so the picture cannot drift from the real list. -->
      <MockFigure
        :caption="$t('settings.help.mcp.mock.settings.caption')"
        :legend="settingsLegend"
      >
        <MockSettings
          :nav-title="$t('settings.nav.title')"
          :nav-group="$t('settings.nav.group.integration')"
          :nav="settingsNav"
          :page-title="$t('settings.mcp.all-title')"
          :actions="settingsActions"
          :nav-mark="MARKS[0]"
        >
          <MockCardRow
            v-for="(row, i) in catalogRows"
            :key="row.name"
            :title="row.label"
            :text="row.text"
            :badge="row.installed ? $t('settings.help.mcp.mock.settings.installed') : undefined"
            :action="row.installed ? undefined : $t('settings.help.mcp.mock.settings.add')"
            :mark="i === 0 ? MARKS[2] : undefined"
          />
        </MockSettings>
      </MockFigure>

      <div class="mh-warn">
        <p v-html="$t('settings.help.mcp.s2.warn.p1')"></p>
        <p>{{ $t('settings.help.mcp.s2.warn.p2') }}</p>
      </div>
    </section>

    <!-- ── Direction 3 ──────────────────────────────────────────────── -->
    <section class="mh-section">
      <h2 class="mh-h2">{{ $t('settings.help.mcp.s3.title') }}</h2>
      <p class="mh-p" v-html="$t('settings.help.mcp.s3.p1')"></p>

      <h3 class="mh-h3">{{ $t('settings.help.mcp.s3.h1') }}</h3>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <tbody>
            <tr v-for="name in uiTools" :key="name">
              <td class="mh-tool"><code>{{ name }}</code></td>
              <td>{{ $t(`settings.help.mcp.s3.uiTools.${name}`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="mh-note" v-html="$t('settings.help.mcp.s3.note')"></p>

      <div class="mh-warn">
        <p v-html="$t('settings.help.mcp.s3.warn.p1')"></p>
        <p v-html="$t('settings.help.mcp.s3.warn.p2')"></p>
      </div>
    </section>

    <!-- ── Side by side ─────────────────────────────────────────────── -->
    <section class="mh-section">
      <h2 class="mh-h2">{{ $t('settings.help.mcp.s4.title') }}</h2>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <thead>
            <tr>
              <th></th>
              <th>{{ $t('settings.help.mcp.s4.table.provide') }}</th>
              <th>{{ $t('settings.help.mcp.s4.table.consume') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in comparison" :key="key">
              <th class="mh-aspect">{{ $t(`settings.help.mcp.s4.comparison.${key}.aspect`) }}</th>
              <td>{{ $t(`settings.help.mcp.s4.comparison.${key}.provide`) }}</td>
              <td>{{ $t(`settings.help.mcp.s4.comparison.${key}.consume`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── Troubleshooting ──────────────────────────────────────────── -->
    <section class="mh-section">
      <h2 class="mh-h2">{{ $t('settings.help.mcp.s5.title') }}</h2>
      <div class="mh-tablewrap">
        <table class="mh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.mcp.s5.table.symptom') }}</th>
              <th>{{ $t('settings.help.mcp.s5.table.detail') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in troubleshooting" :key="key">
              <td>{{ $t(`settings.help.mcp.s5.troubleshooting.${key}.symptom`) }}</td>
              <td>{{ $t(`settings.help.mcp.s5.troubleshooting.${key}.detail`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mh {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: 78ch;
}

.mh-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.mh-dirs {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.mh-dir {
  flex: 1 1 260px;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mh-dir-arrow {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: var(--font-2xs);
  color: var(--accent-fg);
  background: var(--accent-subtle);
  border-radius: 99px;
  padding: 1px 9px;
  align-self: flex-start;
}
.mh-dir-title {
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}
.mh-dir-text {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.mh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mh-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
}
.mh-h3 {
  margin: 8px 0 0;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-primary);
}
.mh-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}
.mh-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.mh-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mh-warn {
  border-left: 3px solid var(--st-progress, #c77400);
  background: var(--bg-inset);
  border-radius: 0 8px 8px 0;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mh-warn p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
}

/* Two windows abreast inside a figure; they stack when the dialog is narrow. */
.mh-mock-pair {
  display: flex;
  gap: 0.6em;
  align-items: stretch;
  min-width: 0;
  flex-wrap: wrap;
}
.mh-mock-pair > * { flex: 1 1 15em; min-width: 0; }

.mh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
}
.mh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12.5px;
}
.mh-table th,
.mh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.mh-table thead th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.mh-table tr:last-child td,
.mh-table tr:last-child th { border-bottom: none; }
.mh-aspect {
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.mh-tool { white-space: nowrap; }

/* `code` also appears inside v-html prose, which carries no scoped data-v
   attribute — hence :deep(). */
.mh :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: 4px;
  padding: 1px 5px;
}
</style>
