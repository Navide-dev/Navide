<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuotaFailover } from '../composables/useQuotaFailover'

import MockDialog from './helpMocks/MockDialog.vue'
import MockFigure from './helpMocks/MockFigure.vue'
import MockFormRow from './helpMocks/MockFormRow.vue'
import MockMenu from './helpMocks/MockMenu.vue'
import MockMeter from './helpMocks/MockMeter.vue'
import MockPanel from './helpMocks/MockPanel.vue'

// Read-only reference for the CLI agents themselves, shown inside Settings → Help.
// Static mirror of the Navide user manual, book 2: which CLIs are built in, how
// they are detected and installed, how roles are applied, what Settings ▸ CLI
// Agents holds, and where accounts and quota come from. All prose lives in the
// locale files under `settings.help.cliAgents.*`; the vendor table below was
// checked against agentSpecs and the backend vendor files — when those change,
// this must follow.

interface VendorRow {
  name: string
  bin: string
  /** Registry key, to look the vendor up in the backend's switch capabilities. */
  agentKey: string
  skipFlag: string
  /** Locale key shown instead of "—" when a CLI has no bypass flag for a
   *  reason the reader needs (Goose approves tools by itself by default). */
  flagNote?: string
  usage: boolean
  /** Static fallback for the multi-account column, used only until the
   *  backend's capabilities have loaded (see multiAccountCell). */
  multiAccount: boolean
  /** Arguments the Accounts pane's sign-in button appends to `bin`, mirroring
   *  the vendor's `login_command_args`. Empty = the vendor declares none, so
   *  the button launches the CLI as usual and signing in happens inside it. */
  signIn: string
}

// Default order of the + menu and Ctrl+1…9. "usage" = Navide can read the
// remaining quota; "multiAccount" = several sign-ins can be kept in Settings
// and switched — rendered from the backend's account-switch capabilities
// (quota_failover.get_state → capabilities, one entry per registry key) once
// they have loaded, so the column follows every vendor's declaration instead
// of a list kept here. The three vendors without a permission-bypass flag
// (Grok CLI, OpenCode, Pi) simply have no such flag in the CLI itself.
//
// "signIn" mirrors each vendor's `login_command_args` (cli_vendors/*.py), which
// is what `_login_spawn_command` appends when the Accounts pane's sign-in
// button spawns a login pane. Checked against the registry on 2026-09-18; the
// eight vendors that declare none launch normally and sign in inside the CLI.
// test_help_panel_sign_in_column_matches_login_command_args keeps the two in
// step, so this table cannot quietly drift from what the button runs.
const vendors: VendorRow[] = [
  { name: 'Claude Code (Anthropic)', bin: 'claude', agentKey: 'claude', skipFlag: '--dangerously-skip-permissions', usage: true, multiAccount: true, signIn: 'auth login' },
  { name: 'Codex CLI (OpenAI)', bin: 'codex', agentKey: 'codex', skipFlag: '--dangerously-bypass-approvals-and-sandbox', usage: true, multiAccount: true, signIn: 'login' },
  { name: 'Antigravity CLI (Google)', bin: 'agy', agentKey: 'antigravity', skipFlag: '--dangerously-skip-permissions', usage: true, multiAccount: false, signIn: '' },
  { name: 'Grok Build (SpaceXAI)', bin: 'grok', agentKey: 'grok', skipFlag: '', usage: true, multiAccount: true, signIn: 'login' },
  { name: 'Kimi Code CLI (Moonshot AI)', bin: 'kimi', agentKey: 'kimi', skipFlag: '--yolo', usage: true, multiAccount: true, signIn: 'login' },
  { name: 'OpenCode (Anomaly)', bin: 'opencode', agentKey: 'opencode', skipFlag: '', usage: true, multiAccount: false, signIn: 'auth login' },
  { name: 'Qwen Code (Alibaba Cloud)', bin: 'qwen', agentKey: 'qwen', skipFlag: '--yolo', usage: true, multiAccount: false, signIn: '' },
  { name: 'Kilo Code CLI', bin: 'kilo', agentKey: 'kilo', skipFlag: '--auto', usage: true, multiAccount: true, signIn: 'auth login' },
  { name: 'Pi', bin: 'pi', agentKey: 'pi', skipFlag: '', usage: true, multiAccount: false, signIn: '' },
  { name: 'GitHub Copilot CLI', bin: 'copilot', agentKey: 'copilot', skipFlag: '--yolo', usage: true, multiAccount: false, signIn: 'login' },
  { name: 'Cursor CLI', bin: 'agent', agentKey: 'cursor', skipFlag: '--force', usage: true, multiAccount: false, signIn: '' },
  { name: 'Aider', bin: 'aider', agentKey: 'aider', skipFlag: '--yes-always', usage: false, multiAccount: false, signIn: '' },
  { name: 'Muse Code (Meta)', bin: 'muse', agentKey: 'muse', skipFlag: '--disable-approval', usage: false, multiAccount: false, signIn: 'login' },
  { name: 'Droid CLI (Factory)', bin: 'droid', agentKey: 'droid', skipFlag: '--auto high', usage: false, multiAccount: false, signIn: '' },
  { name: 'MiniMax Code', bin: 'mcode', agentKey: 'mcode', skipFlag: '', usage: false, multiAccount: false, signIn: 'login' },
  { name: 'Goose (AAIF)', bin: 'goose', agentKey: 'goose', skipFlag: '', flagNote: 'settings.help.cliAgents.s1.table.flagNoteGoose', usage: false, multiAccount: false, signIn: '' },
]

// Backend truth for the multi-account column. `supported` alone is not
// "automatic" and not "verified": the cell names the switch method and marks
// a layout nobody has exercised on a real account.
const failoverCaps = computed(() => useQuotaFailover().state.value?.capabilities ?? null)
function multiAccountCell(row: VendorRow): { yes: boolean; text: string } {
  const cap = failoverCaps.value?.[row.agentKey]
  if (!cap) return { yes: row.multiAccount, text: row.multiAccount ? '✓' : '—' }
  if (!cap.supported) return { yes: false, text: '—' }
  const method = t(`usage.failover-switch-${cap.switchMode}`)
  return { yes: true, text: cap.evidence === 'live' ? method : `${method} · ${t('usage.failover-unverified')}` }
}

// Row keys for the prose tables; the text for each row is looked up under
// `settings.help.cliAgents.<section>.<table>.<key>` so both locales stay in
// parity and the row order is fixed here.

// The three entry points share one guided-install dialog; only the source differs.
const dialogSources = ['spawn', 'pane', 'settings'] as const

// Status chips on a CLI Agents row, in the order cliAgentRow.ts emits them:
// what it is, what it runs as, how it is reached. `model` covers both the
// model and the effort chip, which always travel together.
const chips = [
  'install',
  'model',
  'permission',
  'push',
  'account',
  'binary',
  'command',
  'env',
] as const

// The fields one expanded vendor row of the launch-override accordion offers.
const launchFields = ['model', 'effort', 'command', 'env'] as const

// Which fields the Manual spawn dialog shows, decided by whether the vendor
// spec declares `modelArgs` / `effortArgs` — not by a hard-coded list. Counted
// against the specs in platform/plugin-shell/agents on 2026-09-18: 5 / 7 / 3,
// the last group being aider, droid and terminal.
const spawnGroups = ['both', 'modelOnly', 'neither'] as const

const installActions = ['update', 'doctor', 'install', 'autoUpdate', 'redetect'] as const

const accountActions = ['add', 'login', 'setDefault', 'refreshQuota', 'delete'] as const

const badgeStates = ['percent', 'reading', 'cached', 'expired', 'limit', 'cliMissing', 'noData'] as const

const troubleshooting = [
  'notInstalled',
  'notDetected',
  'notOnPath',
  'signedOut',
  'loginExpired',
  'parkedExpired',
  'detectingSession',
  'quotaStale',
  'panesRunning',
  'permissionFlag',
  'launchCommand',
  'envIgnored',
  'resumeIgnoresCommand',
] as const
// ── 9 · CLI risk observations ────────────────────────────────────────
// The three signal kinds CliRiskPill.vue can show, and the buttons its popover
// offers. Names are read from the pill's own `cli-risk.*` keys so the table
// can never quote a heading the pill no longer prints.
const riskSignals = [
  { key: 'network', nameKey: 'cli-risk.network-title', colorKey: 'statusBadges.color.yellow' },
  { key: 'disk', nameKey: 'cli-risk.disk-title', colorKey: 'statusBadges.color.yellow' },
  { key: 'diskAgain', nameKey: 'cli-risk.disk-again-title', colorKey: 'statusBadges.color.red' },
] as const

const riskActions = [
  { key: 'ignore', labelKey: 'cli-risk.ignore' },
  { key: 'ignoreIp', labelKey: 'cli-risk.ignore-ip' },
  { key: 'allowIp', labelKey: 'cli-risk.allow-ip' },
  { key: 'reveal', labelKey: 'cli-risk.reveal' },
] as const

const { t } = useI18n()

// ── Mock screenshots ────────────────────────────────────────────────────────
// Four HTML pictures of surfaces this topic describes, drawn from the
// components themselves rather than captured. Every word in them is a locale
// lookup; where the real UI already has a string — the install dialog's steps,
// the permission modes, the quota wording — the picture reuses that key, so a
// reworded label lands in the picture too.

const MARKS = ['\u2460', '\u2461', '\u2462', '\u2463']

function mockLegend(figure: string, rows: string[]): { mark: string; label: string; text: string }[] {
  return rows.map((row, i) => ({
    mark: MARKS[i],
    label: t(`settings.help.cliAgents.mock.${figure}.legend.${row}.label`),
    text: t(`settings.help.cliAgents.mock.${figure}.legend.${row}.text`),
  }))
}

/** Sample name or figure, kept in the locale files rather than hard-coded. */
function sample(key: string): string {
  return t(`settings.help.cliAgents.mock.sample.${key}`)
}

const menuLegend = computed(() => mockLegend('menu', ['role', 'pick', 'missing']))
const installLegend = computed(() => mockLegend('install', ['steps', 'chain', 'command']))
const settingsLegend = computed(() => mockLegend('settings', ['grip', 'toggle', 'launch', 'perm']))
const usageLegend = computed(() => mockLegend('usage', ['windows', 'reset', 'accounts']))

// Settings ▸ CLI Agents labels quoted by the s4 prose, read from the product's
// own keys so a renamed button renames the help text too.
const cardLabels = computed(() => ({
  search: t('settings.cliAgents.search'),
  all: t('settings.cliAgents.filter-all'),
  enabled: t('settings.cliAgents.filter-enabled'),
  attention: t('settings.cliAgents.filter-attention'),
  redetect: t('cli-manage.redetect'),
  enabledBox: t('settings.cliAgents.enabled'),
  reorderFiltered: t('settings.cliAgents.reorder-filtered'),
}))
const drawerLabels = computed(() => ({
  manage: t('settings.cliAgents.manage'),
  overview: t('settings.cliAgents.tab-overview'),
  launch: t('settings.cliLaunch.title'),
  perm: t('settings.cliPermission.title'),
  push: t('settings.pushChannels.title'),
  install: t('cli-manage.title'),
  enabledBox: t('settings.cliAgents.enabled'),
}))

// The + menu, with the fourth vendor in its "binary not found" form.
const menuItems = computed(() => [
  { label: sample('vendorA'), checked: true },
  { label: sample('vendorB') },
  { label: sample('vendorC') },
  { label: t('label.agent-not-installed', { label: sample('vendorD') }), dim: true },
])
const menuFooter = computed(() => [t('action.open-terminal'), `${t('label.manual-spawn')}\u2026`])

const installSteps = computed(() => [
  { label: t('cli-install.step.check'), state: 'active' as const },
  { label: t('cli-install.step.install'), state: 'todo' as const },
  { label: t('cli-install.step.verify'), state: 'todo' as const },
])
const installButtons = computed(() => [
  { label: t('cli-install.not-now') },
  { label: t('cli-install.install'), primary: true },
])
const installChain = computed(() => [sample('chain1'), sample('chain2'), sample('vendorA')])
</script>

<template>
  <div class="cah">
    <p class="cah-intro">{{ $t('settings.help.cliAgents.intro') }}</p>

    <!-- ── 1 · Supported CLIs ──────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">1</span>{{ $t('settings.help.cliAgents.s1.title') }}</h2>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s1.p1')"></p>

      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.cliAgents.s1.table.name') }}</th>
              <th>{{ $t('settings.help.cliAgents.s1.table.bin') }}</th>
              <th>{{ $t('settings.help.cliAgents.s1.table.flag') }}</th>
              <th>{{ $t('settings.help.cliAgents.s1.table.usage') }}</th>
              <th>{{ $t('settings.help.cliAgents.s1.table.multi') }}</th>
              <th>{{ $t('settings.help.cliAgents.s1.table.signIn') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in vendors" :key="row.bin">
              <td>{{ row.name }}</td>
              <td><code>{{ row.bin }}</code></td>
              <td>
                <code v-if="row.skipFlag">{{ row.skipFlag }}</code>
                <span v-else-if="row.flagNote">{{ $t(row.flagNote) }}</span>
                <span v-else class="cah-no">—</span>
              </td>
              <td :class="row.usage ? 'cah-yes' : 'cah-no'">{{ row.usage ? '✓' : '—' }}</td>
              <td :class="multiAccountCell(row).yes ? 'cah-yes' : 'cah-no'">
                {{ multiAccountCell(row).text }}
              </td>
              <td>
                <code v-if="row.signIn">{{ row.bin }} {{ row.signIn }}</code>
                <span v-else>{{ $t('settings.help.cliAgents.s1.table.signInInside') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="cah-note">{{ $t('settings.help.cliAgents.s1.note') }}</p>

      <div class="cah-callout">
        <div class="cah-callout-title">{{ $t('settings.help.cliAgents.s1.callout.title') }}</div>
        <div class="cah-callout-text" v-html="$t('settings.help.cliAgents.s1.callout.text')"></div>
      </div>
    </section>

    <!-- ── 2 · Install & detection ─────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">2</span>{{ $t('settings.help.cliAgents.s2.title') }}</h2>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s2.p1') }}</p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s2.h1') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s2.p2')"></p>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s2.p3') }}</p>

      <MockFigure
        :caption="$t('settings.help.cliAgents.mock.menu.caption')"
        :legend="menuLegend"
      >
        <MockMenu
          :select="$t('label.select-role')"
          :items="menuItems"
          :footer="menuFooter"
        />
      </MockFigure>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s2.h2') }}</h3>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s2.p4') }}</p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s2.h3') }}</h3>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s2.p5') }}</p>

      <MockFigure
        :caption="$t('settings.help.cliAgents.mock.install.caption')"
        :legend="installLegend"
      >
        <MockDialog
          :kicker="$t('cli-install.kicker')"
          :title="$t('cli-install.title', { label: sample('vendorA') })"
          :steps="installSteps"
          :buttons="installButtons"
          :mark="MARKS[0]"
        >
          <MockFormRow
            :label="sample('vendorA')"
            :badge="$t('cli-install.status.missing')"
            badge-tone="warn"
          />
          <MockPanel :label="$t('cli-install.chain-label')">
            <MockFormRow
              v-for="(link, i) in installChain"
              :key="link"
              :label="`${i + 1} · ${link}`"
              :hint="$t('cli-install.requirement-missing')"
            />
          </MockPanel>
          <MockPanel :label="$t('cli-install.command-label')" :code="sample('command')" />
        </MockDialog>
      </MockFigure>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.cliAgents.s2.table.source') }}</th>
              <th>{{ $t('settings.help.cliAgents.s2.table.when') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in dialogSources" :key="key">
              <td><code>{{ key }}</code></td>
              <td>{{ $t(`settings.help.cliAgents.s2.dialogSources.${key}.when`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s2.p6')"></p>
      <ul class="cah-list">
        <li v-html="$t('settings.help.cliAgents.s2.steps.check')"></li>
        <li v-html="$t('settings.help.cliAgents.s2.steps.install')"></li>
        <li v-html="$t('settings.help.cliAgents.s2.steps.verify')"></li>
      </ul>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s2.p7') }}</p>

      <div class="cah-callout cah-callout--warn">
        <div class="cah-callout-title">{{ $t('settings.help.cliAgents.s2.callout.title') }}</div>
        <div class="cah-callout-text" v-html="$t('settings.help.cliAgents.s2.callout.text')"></div>
      </div>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s2.h4') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s2.p8')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s2.p9')"></p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s2.h5') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s2.p10')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s2.p11')"></p>

      <div class="cah-callout">
        <div class="cah-callout-title">{{ $t('settings.help.cliAgents.s2.callout2.title') }}</div>
        <div class="cah-callout-text" v-html="$t('settings.help.cliAgents.s2.callout2.text')"></div>
      </div>
    </section>

    <!-- ── 3 · Roles ───────────────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">3</span>{{ $t('settings.help.cliAgents.s3.title') }}</h2>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s3.h1') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s3.p1')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s3.p2')"></p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s3.h2') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s3.p3')"></p>
      <p class="cah-note">{{ $t('settings.help.cliAgents.s3.note') }}</p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s3.h3') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s3.p4')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s3.p5')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s3.p6')"></p>

      <div class="cah-callout">
        <div class="cah-callout-title">{{ $t('settings.help.cliAgents.s3.callout.title') }}</div>
        <div class="cah-callout-text">{{ $t('settings.help.cliAgents.s3.callout.text') }}</div>
      </div>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s3.h4') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s3.p7')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s3.p8')"></p>
    </section>

    <!-- ── 4 · Settings ▸ CLI Agents ───────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">4</span>{{ $t('settings.help.cliAgents.s4.title') }}</h2>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.p1', { manage: $t('settings.cliAgents.manage') })"></p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s4.h1') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.p2', cardLabels)"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.attention', cardLabels)"></p>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s4.chipsIntro', drawerLabels) }}</p>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.cliAgents.s4.chipsTable.chip') }}</th>
              <th>{{ $t('settings.help.cliAgents.s4.chipsTable.shows') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in chips" :key="key">
              <td class="cah-nowrap"><strong>{{ $t(`settings.help.cliAgents.s4.chips.${key}.chip`) }}</strong></td>
              <td v-html="$t(`settings.help.cliAgents.s4.chips.${key}.shows`)"></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-note">{{ $t('settings.help.cliAgents.s4.chipsLegend') }}</p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s4.hDrawer') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.drawer', drawerLabels)"></p>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s4.drawerSearch') }}</p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s4.h2') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.launchIntro')"></p>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.cliAgents.s4.launchTable.field') }}</th>
              <th>{{ $t('settings.help.cliAgents.s4.launchTable.detail') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in launchFields" :key="key">
              <td class="cah-nowrap"><strong>{{ $t(`settings.help.cliAgents.s4.launchFields.${key}.field`) }}</strong></td>
              <td v-html="$t(`settings.help.cliAgents.s4.launchFields.${key}.detail`)"></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="cah-callout cah-callout--warn">
        <div class="cah-callout-title">{{ $t('settings.help.cliAgents.s4.callout3.title') }}</div>
        <div class="cah-callout-text" v-html="$t('settings.help.cliAgents.s4.callout3.text')"></div>
      </div>

      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.launchResume')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.launchReject')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.launchEnv')"></p>
      <p class="cah-note" v-html="$t('settings.help.cliAgents.s4.launchEnvNote')"></p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s4.h3') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.spawnIntro')"></p>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.cliAgents.s4.spawnTable.group') }}</th>
              <th>{{ $t('settings.help.cliAgents.s4.spawnTable.vendors') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in spawnGroups" :key="key">
              <td class="cah-nowrap"><strong>{{ $t(`settings.help.cliAgents.s4.spawnGroups.${key}.group`) }}</strong></td>
              <td>{{ $t(`settings.help.cliAgents.s4.spawnGroups.${key}.vendors`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-note" v-html="$t('settings.help.cliAgents.s4.spawnNote')"></p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s4.h4') }}</h3>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s4.p3') }}</p>
      <ul class="cah-list">
        <li v-html="$t('settings.help.cliAgents.s4.list.global')"></li>
        <li v-html="$t('settings.help.cliAgents.s4.list.perVendor')"></li>
      </ul>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s4.p4') }}</p>

      <MockFigure
        :caption="$t('settings.help.cliAgents.mock.settings.caption')"
        :legend="settingsLegend"
      >
        <MockPanel :label="$t('settings.cliAgents.title')">
          <MockFormRow grip check="on" :label="sample('vendorA')" />
          <MockFormRow
            grip
            check="on"
            :label="sample('vendorB')"
            badge="!"
            badge-tone="warn"
          />
          <MockFormRow grip check="off" :label="sample('vendorC')" dim />
        </MockPanel>
        <MockPanel :label="$t('settings.cliLaunch.title')">
          <MockFormRow :label="sample('vendorA')" :mark="MARKS[2]" />
          <MockFormRow :label="$t('settings.cliLaunch.model-label')" :code="sample('model')" />
          <MockFormRow
            :label="$t('settings.cliLaunch.effort-label')"
            :select="sample('effort')"
          />
          <MockFormRow
            :label="sample('envName')"
            :badge="$t('settings.cliLaunch.env-reserved-chip')"
            badge-tone="crit"
          />
        </MockPanel>
        <MockPanel :label="$t('settings.cliPermission.title')">
          <MockFormRow
            check="on"
            :label="$t('settings.cliPermission.global-label')"
          />
          <MockFormRow
            :label="sample('vendorA')"
            code="--dangerously-skip-permissions"
            :select="$t('settings.cliPermission.mode-inherit')"
          />
        </MockPanel>
      </MockFigure>

      <div class="cah-callout cah-callout--warn">
        <div class="cah-callout-title">{{ $t('settings.help.cliAgents.s4.callout1.title') }}</div>
        <div class="cah-callout-text" v-html="$t('settings.help.cliAgents.s4.callout1.text')"></div>
      </div>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s4.h5') }}</h3>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s4.p5') }}</p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.pushAllOff')"></p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s4.h6') }}</h3>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s4.p6') }}</p>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.cliAgents.s4.table.action') }}</th>
              <th>{{ $t('settings.help.cliAgents.s4.table.detail') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in installActions" :key="key">
              <td class="cah-nowrap"><strong>{{ $t(`settings.help.cliAgents.s4.installActions.${key}.action`) }}</strong></td>
              <td>{{ $t(`settings.help.cliAgents.s4.installActions.${key}.detail`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s4.p7')"></p>
      <p class="cah-note">{{ $t('settings.help.cliAgents.s4.note') }}</p>

      <div class="cah-callout">
        <div class="cah-callout-title">{{ $t('settings.help.cliAgents.s4.callout2.title') }}</div>
        <div class="cah-callout-text" v-html="$t('settings.help.cliAgents.s4.callout2.text')"></div>
      </div>
    </section>

    <!-- ── 5 · Accounts ────────────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">5</span>{{ $t('settings.help.cliAgents.s5.title') }}</h2>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s5.p1')"></p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s5.h1') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s5.p2')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s5.p3')"></p>

      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.cliAgents.s5.table.action') }}</th>
              <th>{{ $t('settings.help.cliAgents.s5.table.behavior') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in accountActions" :key="key">
              <td class="cah-nowrap"><strong>{{ $t(`settings.help.cliAgents.s5.accountActions.${key}.action`) }}</strong></td>
              <td>{{ $t(`settings.help.cliAgents.s5.accountActions.${key}.detail`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-note" v-html="$t('settings.help.cliAgents.s5.note1')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s5.p4')"></p>

      <p class="cah-p" v-html="$t('settings.help.cliAgents.s5.p5')"></p>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s5.p6') }}</p>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s5.p7') }}</p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s5.switchToast')"></p>

      <div class="cah-callout cah-callout--warn">
        <div class="cah-callout-title">{{ $t('settings.help.cliAgents.s5.callout1.title') }}</div>
        <div class="cah-callout-text" v-html="$t('settings.help.cliAgents.s5.callout1.text')"></div>
      </div>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s5.h2') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s5.p8')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s5.p9')"></p>
      <p class="cah-note">{{ $t('settings.help.cliAgents.s5.note2') }}</p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s5.h3') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s5.p10')"></p>
      <p class="cah-p">{{ $t('settings.help.cliAgents.s5.p11') }}</p>
      <div class="cah-callout">
        <div class="cah-callout-title">{{ $t('settings.help.cliAgents.s5.callout2.title') }}</div>
        <div class="cah-callout-text" v-html="$t('settings.help.cliAgents.s5.callout2.text')"></div>
      </div>
    </section>

    <!-- ── 6 · Quota display ───────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">6</span>{{ $t('settings.help.cliAgents.s6.title') }}</h2>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s6.p1')"></p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s6.h1') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s6.p2')"></p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s6.h2') }}</h3>
      <ul class="cah-list">
        <li v-html="$t('settings.help.cliAgents.s6.list.claude')"></li>
        <li v-html="$t('settings.help.cliAgents.s6.list.others')"></li>
      </ul>
      <p class="cah-note">{{ $t('settings.help.cliAgents.s6.note') }}</p>

      <MockFigure
        :caption="$t('settings.help.cliAgents.mock.usage.caption')"
        :legend="usageLegend"
      >
        <MockPanel :label="`${sample('vendorA')} \u00b7 ${sample('plan')}`">
          <MockMeter
            :label="sample('window1')"
            :value="$t('usage.remaining', { pct: sample('pct1') })"
            :percent="62"
            :note="$t('usage.resets-in', { time: sample('reset1') })"
          />
          <MockMeter
            :label="sample('window2')"
            :value="$t('usage.remaining', { pct: sample('pct2') })"
            :percent="18"
            tier="warn"
            :note="$t('usage.resets-in', { time: sample('reset2') })"
          />
          <MockPanel :label="$t('usage.switch-title')">
            <MockFormRow :label="sample('acct1')" :badge="sample('acctPct1')" badge-tone="ok" />
            <MockFormRow :label="sample('acct2')" :badge="sample('acctPct2')" badge-tone="crit" />
          </MockPanel>
        </MockPanel>
      </MockFigure>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s6.h3') }}</h3>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.cliAgents.s6.table.display') }}</th>
              <th>{{ $t('settings.help.cliAgents.s6.table.meaning') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in badgeStates" :key="key">
              <td class="cah-nowrap">{{ $t(`settings.help.cliAgents.s6.badgeStates.${key}.display`) }}</td>
              <td>{{ $t(`settings.help.cliAgents.s6.badgeStates.${key}.meaning`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s6.p3')"></p>

      <h3 class="cah-h3">{{ $t('settings.help.cliAgents.s6.h4') }}</h3>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s6.p4')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s6.p5')"></p>
    </section>

    <!-- ── 7 · Idle reclaim & CLI cost ─────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">7</span>{{ $t('settings.help.cliAgents.s7.title') }}</h2>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s7.p1')"></p>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s7.p2')"></p>
      <ul class="cah-list">
        <li>{{ $t('settings.help.cliAgents.s7.list.threshold') }}</li>
        <li>{{ $t('settings.help.cliAgents.s7.list.exempt') }}</li>
        <li v-html="$t('settings.help.cliAgents.s7.list.now')"></li>
      </ul>
      <p class="cah-note">{{ $t('settings.help.cliAgents.s7.note') }}</p>
    </section>

    <!-- ── 8 · Troubleshooting ─────────────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">8</span>{{ $t('settings.help.cliAgents.s8.title') }}</h2>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.cliAgents.s8.table.symptom') }}</th>
              <th>{{ $t('settings.help.cliAgents.s8.table.cause') }}</th>
              <th>{{ $t('settings.help.cliAgents.s8.table.fix') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in troubleshooting" :key="key">
              <td>{{ $t(`settings.help.cliAgents.s8.troubleshooting.${key}.symptom`) }}</td>
              <td>{{ $t(`settings.help.cliAgents.s8.troubleshooting.${key}.cause`) }}</td>
              <td>{{ $t(`settings.help.cliAgents.s8.troubleshooting.${key}.fix`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── 9 · CLI risk observations ───────────────────────────────── -->
    <section class="cah-section">
      <h2 class="cah-h2"><span class="cah-num">9</span>{{ $t('settings.help.cliAgents.s9.title') }}</h2>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s9.p1')"></p>
      <div class="cah-tablewrap">
        <table class="cah-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.cliAgents.s9.table.signal') }}</th>
              <th>{{ $t('settings.help.cliAgents.s9.table.color') }}</th>
              <th>{{ $t('settings.help.cliAgents.s9.table.when') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in riskSignals" :key="row.key">
              <td class="cah-nowrap"><strong>{{ $t(row.nameKey) }}</strong></td>
              <td class="cah-nowrap">{{ $t(row.colorKey) }}</td>
              <td v-html="$t(`settings.help.cliAgents.s9.signals.${row.key}.when`)"></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s9.p2')"></p>
      <ul class="cah-list">
        <li v-for="row in riskActions" :key="row.key">
          <strong>{{ $t(row.labelKey, { vendor: 'Claude Code' }) }}</strong>
          — {{ $t(`settings.help.cliAgents.s9.actions.${row.key}`) }}
        </li>
      </ul>
      <p class="cah-p" v-html="$t('settings.help.cliAgents.s9.p3')"></p>
      <div class="cah-callout cah-callout--warn">
        <div class="cah-callout-title">{{ $t('settings.help.cliAgents.s9.callout.title') }}</div>
        <div class="cah-callout-text" v-html="$t('settings.help.cliAgents.s9.callout.text')"></div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.cah {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: var(--settings-page-max);
}

.cah-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.cah-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cah-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
  display: flex;
  align-items: center;
  gap: 8px;
}
.cah-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: var(--radius-sm);
  background: var(--accent-subtle);
  color: var(--accent-fg);
  font-size: var(--font-2xs);
  font-weight: 700;
}

.cah-h3 {
  margin: 6px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}

.cah-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}

.cah-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}

.cah-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cah-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cah-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cah-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}
.cah-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.cah-callout--warn .cah-callout-title {
  color: var(--attention-fg);
}

.cah-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.cah-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-xs);
}
.cah-table th,
.cah-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.cah-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.cah-table tr:last-child td { border-bottom: none; }

.cah-nowrap { white-space: nowrap; }
.cah-yes { color: var(--text-bright); }
.cah-no { color: var(--text-secondary); }

/* `code` and `.cah-kbd` also appear inside v-html prose, which carries no
   scoped data-v attribute — hence :deep(). */
.cah :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: 4px;
  padding: 1px 5px;
  word-break: break-all;
}

.cah :deep(.cah-kbd) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.88em;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--text-bright);
  white-space: nowrap;
}
</style>
