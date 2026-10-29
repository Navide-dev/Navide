<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { MSG_ENVELOPE_PREFIX } from '../lib/agentMessaging'
import MockEnvelopePane from './helpMocks/MockEnvelopePane.vue'
import MockFigure from './helpMocks/MockFigure.vue'
import MockMessageLog from './helpMocks/MockMessageLog.vue'
import MockPaneCard from './helpMocks/MockPaneCard.vue'

// Read-only reference for inter-CLI messaging, shown inside Settings → Help.
// Static mirror of the messaging system; all prose lives in the locale files
// under `settings.help.messaging.*` — the limits quoted there are the real
// constants from useAgentMessaging.ts, so keep them in sync if those change.

interface CoverageRow {
  cli: string
  send: 'both' | 'protocolOnly' | 'none'
}

// Sending needs one of the two routes. Fourteen of the fifteen vendors have
// at least one; mcode has neither.
//
// The output protocol needs Navide to read the agent's turn text: the 14
// readers in log_readers/ put the reply on `turn_complete` as `text=`, and the
// parser (agentMessaging.ts) is vendor-agnostic — App.vue hands it `ev.text`
// with no vendor check — so the protocol route is open wherever a reader
// exists. mcode is the one vendor with no reader at all
// (log_readers/mcode.py is a documented placeholder: its conversations live in
// SQLite, and the row payloads cannot be modelled without an authenticated
// session), so nothing ever reaches the parser for an mcode pane.
//
// The MCP tools are wired at spawn for the 10 vendors whose CLI offers a way
// in: a launch flag (Claude Code, Codex, Copilot, Qwen), one env var carrying
// the whole config document (OpenCode, Kilo), or a per-pane mirror of the
// config directory (Kimi, Grok, Antigravity). Cursor is the exception that
// only reads a workspace file, so its wiring writes `.cursor/mcp.json` (and
// excludes it from git). Aider, Muse and Pi have no MCP surface at all
// (base.py says so outright); Droid and mcode are simply not wired yet.
//
// Receiving is unaffected throughout — that is text injected into the
// terminal, and it works for every CLI, mcode included.
const coverage: CoverageRow[] = [
  { cli: 'Claude Code', send: 'both' },
  { cli: 'Codex', send: 'both' },
  { cli: 'Copilot CLI', send: 'both' },
  { cli: 'Qwen Code', send: 'both' },
  { cli: 'OpenCode', send: 'both' },
  { cli: 'Kilo Code', send: 'both' },
  { cli: 'Kimi Code', send: 'both' },
  { cli: 'Grok CLI', send: 'both' },
  { cli: 'Antigravity CLI', send: 'both' },
  { cli: 'Cursor CLI', send: 'both' },
  { cli: 'Aider', send: 'protocolOnly' },
  { cli: 'Droid', send: 'protocolOnly' },
  { cli: 'Muse Code', send: 'protocolOnly' },
  { cli: 'Pi', send: 'protocolOnly' },
  { cli: 'MiniMax Code', send: 'none' },
]

// Row keys for the prose tables; each row's text is looked up under
// `settings.help.messaging.<section>.<table>.<key>` so both locales stay in
// parity and the row order is fixed here. Only the examples stay in code —
// they are literal addresses, not prose.
const addressing = [
  { key: 'pane', example: 'reviewer' },
  { key: 'folder', example: 'Agent-Team/reviewer' },
  { key: 'suffix', example: 'work/proj/reviewer' },
  { key: 'absolute', example: '/Users/me/proj/reviewer' },
  { key: 'device', example: 'mac-studio/Agent-Team/reviewer' },
] as const

const spawnLimits = ['children', 'total', 'depth'] as const

const guards = ['rate', 'queue', 'timeout', 'pause'] as const

const troubleshooting = [
  'noTool',
  'staleId',
  'unknownWorkspace',
  'ambiguous',
  'stuckQueued',
  'kickoffFailed',
  'deviceOffline',
  'rateLimit',
  'paused',
] as const

const { t } = useI18n()

// ── Channels ─────────────────────────────────────────────────────────────
// Settings ▸ Channels, the bind dialog and the titlebar monitor, quoted with
// the keys those surfaces render (ChannelsPane.vue, PaneChannelButton.vue,
// ChannelMonitorModal.vue). Mirror levels are listed in the bind dialog's own
// order, least to most.
const channelSetup = ['global', 'bots', 'quick', 'link', 'pairing'] as const
const channelLevels = ['replies', 'minimal', 'standard', 'full'] as const
const channelAnswers = ['bare', 'which', 'never', 'guard'] as const
const channelLabels = computed(() => ({
  nav: t('channels.nav'),
  global: t('channels.global.title'),
  botAdd: t('channels.bot.add'),
  quickAdd: t('channels.quick.add'),
  linkAccount: t('channels.link.link-account'),
  pairing: t('channels.pairing.title'),
  allow: t('channels.allow.title'),
  connect: t('channels.pane.connect'),
  replies: t('channels.pane.verbosity-replies'),
  minimal: t('channels.pane.verbosity-minimal'),
  standard: t('channels.pane.verbosity-standard'),
  full: t('channels.pane.verbosity-full'),
  monitor: t('channels.monitor.open'),
}))

// ── Mock screenshots ────────────────────────────────────────────────────────
// Two HTML pictures, drawn from the components they depict rather than
// captured. The ASCII diagram in section 1 stays: it is a SEQUENCE (who acts,
// in what order), which a picture of one instant cannot express — these two
// show what the message LOOKS like and where it lands, which the sequence
// cannot. They answer different questions, so both earn their place.

const MARKS = ['\u2460', '\u2461', '\u2462']

function mockLegend(figure: string, rows: string[]): { mark: string; label: string; text: string }[] {
  return rows.map((row, i) => ({
    mark: MARKS[i],
    label: t(`settings.help.messaging.mock.${figure}.legend.${row}.label`),
    text: t(`settings.help.messaging.mock.${figure}.legend.${row}.text`),
  }))
}

/** Sample name, kept in the locale files so a picture never hard-codes prose. */
function sample(key: string): string {
  return t(`settings.help.messaging.mock.sample.${key}`)
}

/** The status word the pane pill and the sidebar dot share. */
function statusWord(status: string): string {
  return t(`paneStatus.${status}`)
}

const deliveryLegend = computed(() => mockLegend('delivery', ['envelope', 'status']))
const panelLegend = computed(() => mockLegend('panel', ['actions', 'route', 'status']))

// The envelope exactly as agentMessaging.ts:334 assembles it: the prefix
// constant, the sender handle, the body, then the reply-format line.
const envelopeLines = computed(() => [
  { text: `${MSG_ENVELOPE_PREFIX} ${sample('pane1')}`, dim: true },
  { text: sample('body') },
  { text: sample('hint'), dim: true },
])

const logActions = computed(() => [t('msg.pause'), t('msg.clear-log')])

const logRows = computed(() => [
  {
    from: sample('pane1'),
    to: sample('pane2'),
    time: sample('t1'),
    status: 'delivered' as const,
    statusLabel: t('msg.status-delivered'),
    preview: sample('body'),
  },
  {
    from: sample('pane2'),
    to: sample('pane1'),
    time: sample('t2'),
    status: 'delivering' as const,
    statusLabel: t('msg.status-delivering'),
    preview: sample('preview2'),
  },
  {
    from: sample('pane1'),
    toWs: sample('workspaceB'),
    to: sample('pane2'),
    time: sample('t3'),
    status: 'queued' as const,
    statusLabel: t('msg.status-queued'),
    badge: t('msg.cross-workspace-badge'),
    preview: sample('preview3'),
  },
])
</script>

<template>
  <div class="cmh">
    <p class="cmh-intro" v-html="$t('settings.help.messaging.intro')"></p>

    <div class="cmh-callout">
      <div class="cmh-callout-title">{{ $t('settings.help.messaging.callout.title') }}</div>
      <div class="cmh-callout-text" v-html="$t('settings.help.messaging.callout.text')"></div>
    </div>

    <!-- ── How it works ─────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s1.title') }}</h2>
      <pre class="cmh-flow">{{ $t('settings.help.messaging.s1.flow') }}</pre>
      <p class="cmh-p" v-html="$t('settings.help.messaging.s1.p1')"></p>
    </section>

    <!-- ── The two routes ───────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s2.title') }}</h2>
      <p class="cmh-p" v-html="$t('settings.help.messaging.s2.p1')"></p>

      <div class="cmh-card">
        <div class="cmh-card-head">
          <span class="cmh-card-title">{{ $t('settings.help.messaging.s2.mcp.title') }}</span>
          <span class="cmh-tag">{{ $t('settings.help.messaging.s2.mcp.tag') }}</span>
        </div>
        <p class="cmh-p">{{ $t('settings.help.messaging.s2.mcp.p1') }}</p>
        <p class="cmh-p">{{ $t('settings.help.messaging.s2.mcp.p2') }}</p>
        <ul class="cmh-list">
          <li v-html="$t('settings.help.messaging.s2.mcp.tools.list')"></li>
          <li v-html="$t('settings.help.messaging.s2.mcp.tools.send')"></li>
          <li v-html="$t('settings.help.messaging.s2.mcp.tools.spawn')"></li>
          <li v-html="$t('settings.help.messaging.s2.mcp.tools.ack')"></li>
          <li v-html="$t('settings.help.messaging.s2.mcp.tools.pending')"></li>
        </ul>
        <p class="cmh-note" v-html="$t('settings.help.messaging.s2.mcp.note')"></p>
      </div>

      <div class="cmh-card">
        <div class="cmh-card-head">
          <span class="cmh-card-title">{{ $t('settings.help.messaging.s2.proto.title') }}</span>
          <span class="cmh-tag">{{ $t('settings.help.messaging.s2.proto.tag') }}</span>
        </div>
        <p class="cmh-p">{{ $t('settings.help.messaging.s2.proto.p1') }}</p>
        <pre class="cmh-code">{{ $t('settings.help.messaging.s2.proto.code') }}</pre>
        <p class="cmh-note" v-html="$t('settings.help.messaging.s2.proto.note')"></p>
      </div>
    </section>

    <!-- ── Which CLIs can send ──────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s3.title') }}</h2>
      <p class="cmh-p" v-html="$t('settings.help.messaging.s3.p1')"></p>
      <div class="cmh-tablewrap">
        <table class="cmh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.messaging.s3.table.cli') }}</th>
              <th>{{ $t('settings.help.messaging.s3.table.send') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in coverage" :key="row.cli">
              <td>{{ row.cli }}</td>
              <td class="cmh-supported">{{ $t(`settings.help.messaging.s3.sendModes.${row.send}`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cmh-note" v-html="$t('settings.help.messaging.s3.note1')"></p>
      <p class="cmh-note" v-html="$t('settings.help.messaging.s3.note2')"></p>
    </section>

    <!-- ── Addressing ───────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s4.title') }}</h2>
      <div class="cmh-tablewrap">
        <table class="cmh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.messaging.s4.table.form') }}</th>
              <th>{{ $t('settings.help.messaging.s4.table.meaning') }}</th>
              <th>{{ $t('settings.help.messaging.s4.table.example') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in addressing" :key="row.key">
              <td><code>{{ $t(`settings.help.messaging.s4.addressing.${row.key}.form`) }}</code></td>
              <td>{{ $t(`settings.help.messaging.s4.addressing.${row.key}.meaning`) }}</td>
              <td><code>{{ row.example }}</code></td>
            </tr>
          </tbody>
        </table>
      </div>
      <ul class="cmh-list">
        <li v-html="$t('settings.help.messaging.s4.list.noSlash')"></li>
        <li v-html="$t('settings.help.messaging.s4.list.ambiguous')"></li>
        <li v-html="$t('settings.help.messaging.s4.list.broadcast')"></li>
        <li v-html="$t('settings.help.messaging.s4.list.device')"></li>
      </ul>
    </section>

    <!-- ── Timing ───────────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s5.title') }}</h2>
      <p class="cmh-p" v-html="$t('settings.help.messaging.s5.p1')"></p>
      <ul class="cmh-list">
        <li>{{ $t('settings.help.messaging.s5.list.alive') }}</li>
        <li>{{ $t('settings.help.messaging.s5.list.noTyping') }}</li>
        <li>{{ $t('settings.help.messaging.s5.list.noTurn') }}</li>
        <li>{{ $t('settings.help.messaging.s5.list.quiet') }}</li>
      </ul>
      <p class="cmh-p">{{ $t('settings.help.messaging.s5.p2') }}</p>
      <p class="cmh-note">{{ $t('settings.help.messaging.s5.note') }}</p>

      <!-- Both ends of one message. The envelope is quoted because Navide
           writes it; the transcripts either side stay blank because a CLI's
           own output is not ours to invent. -->
      <MockFigure
        :caption="$t('settings.help.messaging.mock.delivery.caption')"
        :legend="deliveryLegend"
      >
        <div class="cmh-mock-pair">
          <MockPaneCard
            :title="sample('pane1')"
            status="idle"
            :status-label="statusWord('idle')"
            :lines="3"
          />
          <MockEnvelopePane
            :title="sample('pane2')"
            status="running"
            :status-label="statusWord('running')"
            :lines="envelopeLines"
            :body-mark="MARKS[0]"
            :mark="MARKS[1]"
            caret
            focus
          />
        </div>
      </MockFigure>
    </section>

    <!-- ── What you see ─────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s6.title') }}</h2>
      <ul class="cmh-list">
        <li v-html="$t('settings.help.messaging.s6.list.panel')"></li>
        <li v-html="$t('settings.help.messaging.s6.list.crossWorkspace')"></li>
        <li v-html="$t('settings.help.messaging.s6.list.mention')"></li>
        <li v-html="$t('settings.help.messaging.s6.list.drag')"></li>
        <li v-html="$t('settings.help.messaging.s6.list.wake')"></li>
      </ul>

      <!-- The panel those list items point at. -->
      <MockFigure
        :caption="$t('settings.help.messaging.mock.panel.caption')"
        :legend="panelLegend"
      >
        <MockMessageLog
          :title="$t('msg.panel-title')"
          :actions="logActions"
          :rows="logRows"
          :mark="MARKS[0]"
        />
      </MockFigure>
    </section>

    <!-- ── Spawning a new agent ─────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s7.title') }}</h2>
      <p class="cmh-p" v-html="$t('settings.help.messaging.s7.p1')"></p>
      <ul class="cmh-list">
        <li>{{ $t('settings.help.messaging.s7.list.name') }}</li>
        <li v-html="$t('settings.help.messaging.s7.list.report')"></li>
        <li v-html="$t('settings.help.messaging.s7.list.kickoff')"></li>
        <li v-html="$t('settings.help.messaging.s7.list.duplicate')"></li>
        <li v-html="$t('settings.help.messaging.s7.list.rejected')"></li>
        <li v-html="$t('settings.help.messaging.s7.list.resume')"></li>
      </ul>
      <div class="cmh-tablewrap">
        <table class="cmh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.messaging.s7.table.suggestion') }}</th>
              <th>{{ $t('settings.help.messaging.s7.table.value') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in spawnLimits" :key="key">
              <td>{{ $t(`settings.help.messaging.s7.limits.${key}.label`) }}</td>
              <td class="cmh-nowrap">{{ $t(`settings.help.messaging.s7.limits.${key}.value`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cmh-note" v-html="$t('settings.help.messaging.s7.note')"></p>
      <p class="cmh-note" v-html="$t('settings.help.messaging.s7.note2')"></p>
    </section>

    <!-- ── Guardrails ───────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s8.title') }}</h2>
      <p class="cmh-p">{{ $t('settings.help.messaging.s8.p1') }}</p>
      <div class="cmh-tablewrap">
        <table class="cmh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.messaging.s8.table.limit') }}</th>
              <th>{{ $t('settings.help.messaging.s8.table.value') }}</th>
              <th>{{ $t('settings.help.messaging.s8.table.why') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in guards" :key="key">
              <td>{{ $t(`settings.help.messaging.s8.guards.${key}.limit`) }}</td>
              <td class="cmh-nowrap">{{ $t(`settings.help.messaging.s8.guards.${key}.value`) }}</td>
              <td>{{ $t(`settings.help.messaging.s8.guards.${key}.why`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── Troubleshooting ──────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s9.title') }}</h2>
      <div class="cmh-tablewrap">
        <table class="cmh-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.messaging.s9.table.symptom') }}</th>
              <th>{{ $t('settings.help.messaging.s9.table.cause') }}</th>
              <th>{{ $t('settings.help.messaging.s9.table.fix') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in troubleshooting" :key="key">
              <td>{{ $t(`settings.help.messaging.s9.troubleshooting.${key}.symptom`) }}</td>
              <td>{{ $t(`settings.help.messaging.s9.troubleshooting.${key}.cause`) }}</td>
              <td>{{ $t(`settings.help.messaging.s9.troubleshooting.${key}.fix`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ── Known limits ─────────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s10.title') }}</h2>
      <ul class="cmh-list">
        <li v-html="$t('settings.help.messaging.s10.list.terminalPane')"></li>
        <li v-html="$t('settings.help.messaging.s10.list.receiveOnly')"></li>
        <li v-html="$t('settings.help.messaging.s10.list.detached')"></li>
        <li v-html="$t('settings.help.messaging.s10.list.queueFull')"></li>
        <li v-html="$t('settings.help.messaging.s10.list.noPermission')"></li>
        <li v-html="$t('settings.help.messaging.s10.list.ackLocal')"></li>
      </ul>
    </section>

    <!-- ── Across devices ───────────────────────────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s11.title') }}</h2>
      <p class="cmh-p" v-html="$t('settings.help.messaging.s11.p1')"></p>
      <ul class="cmh-list">
        <li v-html="$t('settings.help.messaging.s11.list.address')"></li>
        <li v-html="$t('settings.help.messaging.s11.list.works')"></li>
        <li v-html="$t('settings.help.messaging.s11.list.notWorks')"></li>
        <li v-html="$t('settings.help.messaging.s11.list.offline')"></li>
      </ul>
      <p class="cmh-note" v-html="$t('settings.help.messaging.s11.note')"></p>
    </section>

    <!-- ── What the sender is told afterwards ───────────────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.s12.title') }}</h2>
      <p class="cmh-p">{{ $t('settings.help.messaging.s12.p1') }}</p>
      <ul class="cmh-list">
        <li v-html="$t('settings.help.messaging.s12.list.notice')"></li>
        <li v-html="$t('settings.help.messaging.s12.list.stale')"></li>
        <li v-html="$t('settings.help.messaging.s12.list.check')"></li>
        <li v-html="$t('settings.help.messaging.s12.list.busy')"></li>
      </ul>
      <p class="cmh-note">{{ $t('settings.help.messaging.s12.note') }}</p>
    </section>

    <!-- ── Channels: talking to a pane from a chat app ──────────────── -->
    <section class="cmh-section">
      <h2 class="cmh-h2">{{ $t('settings.help.messaging.channels.title', channelLabels) }}</h2>
      <p class="cmh-p" v-html="$t('settings.help.messaging.channels.p1', channelLabels)"></p>
      <p class="cmh-p">{{ $t('settings.help.messaging.channels.receive') }}</p>

      <h3 class="cmh-h3">{{ $t('settings.help.messaging.channels.h1') }}</h3>
      <ul class="cmh-list">
        <li v-for="key in channelSetup" :key="key" v-html="$t(`settings.help.messaging.channels.setup.${key}`, channelLabels)"></li>
      </ul>

      <h3 class="cmh-h3">{{ $t('settings.help.messaging.channels.h2') }}</h3>
      <p class="cmh-p" v-html="$t('settings.help.messaging.channels.p2', channelLabels)"></p>
      <ul class="cmh-list">
        <li v-for="key in channelLevels" :key="key" v-html="$t(`settings.help.messaging.channels.levels.${key}`, channelLabels)"></li>
      </ul>
      <p class="cmh-p">{{ $t('settings.help.messaging.channels.p3') }}</p>

      <h3 class="cmh-h3">{{ $t('settings.help.messaging.channels.h3') }}</h3>
      <ul class="cmh-list">
        <li v-for="key in channelAnswers" :key="key" v-html="$t(`settings.help.messaging.channels.answer.${key}`)"></li>
      </ul>

      <h3 class="cmh-h3">{{ $t('settings.help.messaging.channels.h4') }}</h3>
      <p class="cmh-p">{{ $t('settings.help.messaging.channels.p4', channelLabels) }}</p>
    </section>

    <p class="cmh-tip">{{ $t('settings.help.messaging.tip') }}</p>
  </div>
</template>

<style scoped>
.cmh {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: var(--settings-page-max);
}

.cmh-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.cmh-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cmh-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cmh-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}

.cmh-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cmh-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
}
.cmh-h3 {
  margin: 6px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}
.cmh-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}
.cmh-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}
.cmh-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cmh-flow,
.cmh-code {
  margin: 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11.5px;
  line-height: var(--lh-loose);
  overflow-x: auto;
  white-space: pre;
  color: var(--text-primary);
}

.cmh-card {
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cmh-card-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.cmh-card-title {
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}
.cmh-tag {
  font-size: var(--font-2xs);
  font-weight: 600;
  border-radius: 99px;
  padding: 1px 8px;
  background: var(--accent-subtle);
  color: var(--accent-fg);
}

/* Two panes abreast inside a figure; they stack when the dialog is narrow. */
.cmh-mock-pair {
  display: flex;
  gap: 0.6em;
  align-items: stretch;
  min-width: 0;
  flex-wrap: wrap;
}
.cmh-mock-pair > * { flex: 1 1 13em; min-width: 0; }

.cmh-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: 8px;
}
.cmh-table {
  border-collapse: collapse;
  width: 100%;
  font-size: 12.5px;
}
.cmh-table th,
.cmh-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.cmh-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.cmh-table tr:last-child td { border-bottom: none; }
.cmh-nowrap { white-space: nowrap; }
.cmh-supported { color: var(--text-primary); }

/* `code` also appears inside v-html prose, which carries no scoped data-v
   attribute — hence :deep(). */
.cmh :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: 4px;
  padding: 1px 5px;
}

.cmh-tip {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.6;
}
</style>
