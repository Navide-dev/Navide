<script setup lang="ts">
import { computed } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { useI18n } from 'vue-i18n'

import MockFigure from './helpMocks/MockFigure.vue'

// Read-only reference for the three operating systems Navide ships on, shown
// inside Settings → Help. The other seven topics describe the macOS window;
// this one carries only what actually differs — which file to download, how
// updating works, which buttons moved, and what the platform-specific
// machinery means for the person using it.
// Every claim below was verified against the packaging config, the release
// workflow, `src/shared/osplat.ts` and `backend/agent_team_backend/osplat/`
// when this page was written. If a target, an install shape or a platform
// capability changes, update this file too.
// All prose lives in the locale files under `settings.help.crossPlatform.*`;
// only the row keys and the platform names — identical in every locale —
// stay here.

// Download table rows, in the order a reader picks from: macOS, then the two
// Windows architectures, then the two Linux packages.
const downloads = ['macos', 'winX64', 'winArm', 'linuxAppImage', 'linuxDeb'] as const

// Which install shapes the in-app updater serves. Keyed by install shape
// rather than by platform, because that is what actually decides it.
const channels = ['mac', 'win', 'appimage', 'deb'] as const

// The credential store each platform uses. Platform names are the same in
// every locale, so they stay here rather than in the locale files.
const credentials: { key: string; platform: string }[] = [
  { key: 'macos', platform: 'macOS' },
  { key: 'windows', platform: 'Windows' },
  { key: 'linux', platform: 'Linux' },
]

const windowsLimits = ['signing', 'symlinks', 'schedule'] as const
const linuxLimits = ['deb', 'arm64', 'terminal'] as const

const { t } = useI18n()

// ── Mock screenshot ─────────────────────────────────────────────────────────
// The one difference that is easier seen than described: where the window
// buttons are. Drawn from the real chrome rather than captured, so it follows
// the user's theme. Every word in it is a locale lookup — a hard-coded label
// would be invisible here but is caught by the en-US rendering test.

const MARKS = ['①', '②']

const controlsLegend = computed(() =>
  ['mac', 'drawn'].map((row, i) => ({
    mark: MARKS[i],
    label: t(`settings.help.crossPlatform.mock.controls.legend.${row}.label`),
    text: t(`settings.help.crossPlatform.mock.controls.legend.${row}.text`),
  })),
)

const sampleTitle = computed(() => t('settings.help.crossPlatform.mock.controls.sample.title'))
</script>

<template>
  <div class="cph">
    <p class="cph-intro">{{ $t('settings.help.crossPlatform.intro') }}</p>

    <!-- ── 1 · Getting it and installing it ────────────────────────── -->
    <section class="cph-section">
      <h2 class="cph-h2">1 · {{ $t('settings.help.crossPlatform.s1.title') }}</h2>
      <p class="cph-p">{{ $t('settings.help.crossPlatform.s1.p1') }}</p>

      <div class="cph-tablewrap">
        <table class="cph-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.crossPlatform.s1.table.platform') }}</th>
              <th>{{ $t('settings.help.crossPlatform.s1.table.file') }}</th>
              <th>{{ $t('settings.help.crossPlatform.s1.table.how') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in downloads" :key="key">
              <td class="cph-nowrap">
                {{ $t(`settings.help.crossPlatform.s1.downloads.${key}.platform`) }}
              </td>
              <td>
                <code class="cph-file">{{
                  $t(`settings.help.crossPlatform.s1.downloads.${key}.file`)
                }}</code>
              </td>
              <td>{{ $t(`settings.help.crossPlatform.s1.downloads.${key}.how`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="cph-note">{{ $t('settings.help.crossPlatform.s1.note') }}</p>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s1.h1') }}</h3>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s1.p2')"></p>

      <div class="cph-callout cph-callout--warn">
        <div class="cph-callout-title">{{ $t('settings.help.crossPlatform.s1.callout.title') }}</div>
        <div class="cph-callout-text" v-html="$t('settings.help.crossPlatform.s1.callout.text')"></div>
      </div>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s1.h2') }}</h3>
      <p class="cph-p">{{ $t('settings.help.crossPlatform.s1.p3') }}</p>
    </section>

    <!-- ── 2 · Download sources ────────────────────────────────────── -->
    <section class="cph-section">
      <h2 class="cph-h2">2 · {{ $t('settings.help.crossPlatform.s2.title') }}</h2>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s2.p1')"></p>

      <ul class="cph-list">
        <li v-html="$t('settings.help.crossPlatform.s2.list.readme')"></li>
        <li v-html="$t('settings.help.crossPlatform.s2.list.identical')"></li>
        <li v-html="$t('settings.help.crossPlatform.s2.list.website')"></li>
      </ul>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s2.h1') }}</h3>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s2.p2')"></p>
      <p class="cph-note" v-html="$t('settings.help.crossPlatform.s2.note')"></p>
    </section>

    <!-- ── 3 · Auto-update across platforms ────────────────────────── -->
    <section class="cph-section">
      <h2 class="cph-h2">3 · {{ $t('settings.help.crossPlatform.s3.title') }}</h2>
      <p class="cph-p">{{ $t('settings.help.crossPlatform.s3.p1') }}</p>

      <div class="cph-tablewrap">
        <table class="cph-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.crossPlatform.s3.table.install') }}</th>
              <th>{{ $t('settings.help.crossPlatform.s3.table.updates') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="key in channels" :key="key">
              <td class="cph-nowrap">
                <strong>{{ $t(`settings.help.crossPlatform.s3.channels.${key}.install`) }}</strong>
              </td>
              <td>{{ $t(`settings.help.crossPlatform.s3.channels.${key}.updates`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s3.h1') }}</h3>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s3.p2')"></p>

      <div class="cph-callout">
        <div class="cph-callout-title">{{ $t('settings.help.crossPlatform.s3.callout.title') }}</div>
        <div class="cph-callout-text">{{ $t('settings.help.crossPlatform.s3.callout.text') }}</div>
      </div>
    </section>

    <!-- ── 4 · Differences you will notice ─────────────────────────── -->
    <section class="cph-section">
      <h2 class="cph-h2">4 · {{ $t('settings.help.crossPlatform.s4.title') }}</h2>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s4.h1') }}</h3>
      <p class="cph-p">{{ $t('settings.help.crossPlatform.s4.p1') }}</p>

      <!-- Where the buttons are, drawn rather than described. -->
      <MockFigure
        :caption="$t('settings.help.crossPlatform.mock.controls.caption')"
        :legend="controlsLegend"
      >
        <div class="cph-bars">
          <!-- The mark sits outside each bar: inside, it would push the
               traffic lights off the strip the picture is about. -->
          <div class="cph-barrow">
            <span class="cph-mark">{{ MARKS[0] }}</span>
            <div class="cph-bar cph-bar--mac">
              <span class="cph-lights"><i /><i /><i /></span>
              <span class="cph-bar-title" v-truncate>{{ sampleTitle }}</span>
              <span class="cph-bar-gear" aria-hidden="true">⚙</span>
            </div>
          </div>
          <div class="cph-barrow">
            <span class="cph-mark">{{ MARKS[1] }}</span>
            <div class="cph-bar cph-bar--drawn">
              <span class="cph-bar-title" v-truncate>{{ sampleTitle }}</span>
              <span class="cph-bar-gear" aria-hidden="true">⚙</span>
              <span class="cph-wincontrols" aria-hidden="true">
                <i class="cph-wc">&#x2500;</i>
                <i class="cph-wc">&#x25A1;</i>
                <i class="cph-wc cph-wc--close">&#x2715;</i>
              </span>
            </div>
          </div>
        </div>
      </MockFigure>

      <ul class="cph-list">
        <li v-html="$t('settings.help.crossPlatform.s4.list.controls')"></li>
        <li v-html="$t('settings.help.crossPlatform.s4.list.menubar')"></li>
        <li v-html="$t('settings.help.crossPlatform.s4.list.appMenu')"></li>
        <li v-html="$t('settings.help.crossPlatform.s4.list.closeItem')"></li>
        <li v-html="$t('settings.help.crossPlatform.s4.list.pluginWindows')"></li>
      </ul>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s4.h2') }}</h3>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s4.p2')"></p>

      <div class="cph-callout">
        <div class="cph-callout-title">{{ $t('settings.help.crossPlatform.s4.callout.title') }}</div>
        <div class="cph-callout-text" v-html="$t('settings.help.crossPlatform.s4.callout.text')"></div>
      </div>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s4.h3') }}</h3>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s4.p3')"></p>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s4.h4') }}</h3>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s4.p4')"></p>
    </section>

    <!-- ── 5 · What the machinery means for you ────────────────────── -->
    <section class="cph-section">
      <h2 class="cph-h2">5 · {{ $t('settings.help.crossPlatform.s5.title') }}</h2>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s5.h1') }}</h3>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s5.p1')"></p>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s5.p2')"></p>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s5.h2') }}</h3>
      <div class="cph-tablewrap">
        <table class="cph-table">
          <thead>
            <tr>
              <th>{{ $t('settings.help.crossPlatform.s5.credTable.platform') }}</th>
              <th>{{ $t('settings.help.crossPlatform.s5.credTable.store') }}</th>
              <th>{{ $t('settings.help.crossPlatform.s5.credTable.means') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in credentials" :key="row.key">
              <td class="cph-nowrap">{{ row.platform }}</td>
              <td class="cph-nowrap">
                {{ $t(`settings.help.crossPlatform.s5.creds.${row.key}.store`) }}
              </td>
              <td>{{ $t(`settings.help.crossPlatform.s5.creds.${row.key}.means`) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="cph-p">{{ $t('settings.help.crossPlatform.s5.p3') }}</p>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s5.h3') }}</h3>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s5.p4')"></p>
      <p class="cph-p">{{ $t('settings.help.crossPlatform.s5.p5') }}</p>
      <p class="cph-p">{{ $t('settings.help.crossPlatform.s5.p6') }}</p>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s5.h4') }}</h3>
      <p class="cph-p">{{ $t('settings.help.crossPlatform.s5.p7') }}</p>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s5.p8')"></p>
    </section>

    <!-- ── 6 · Known platform limitations ──────────────────────────── -->
    <section class="cph-section">
      <h2 class="cph-h2">6 · {{ $t('settings.help.crossPlatform.s6.title') }}</h2>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s6.h1') }}</h3>
      <ul class="cph-list">
        <li
          v-for="key in windowsLimits"
          :key="key"
          v-html="$t(`settings.help.crossPlatform.s6.win.${key}`)"
        ></li>
      </ul>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s6.h2') }}</h3>
      <ul class="cph-list">
        <li
          v-for="key in linuxLimits"
          :key="key"
          v-html="$t(`settings.help.crossPlatform.s6.linux.${key}`)"
        ></li>
      </ul>

      <h3 class="cph-h3">{{ $t('settings.help.crossPlatform.s6.h3') }}</h3>
      <ul class="cph-list">
        <li v-html="$t('settings.help.crossPlatform.s6.common.macPerms')"></li>
      </ul>
    </section>

    <!-- ── 7 · One person, several machines ────────────────────────── -->
    <section class="cph-section">
      <h2 class="cph-h2">7 · {{ $t('settings.help.crossPlatform.s7.title') }}</h2>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s7.p1')"></p>
      <p class="cph-p" v-html="$t('settings.help.crossPlatform.s7.p2')"></p>
      <p class="cph-note">{{ $t('settings.help.crossPlatform.s7.note') }}</p>
    </section>
  </div>
</template>

<style scoped>
.cph {
  display: flex;
  flex-direction: column;
  gap: 22px;
  color: var(--text-primary);
  max-width: 78ch;
}

.cph-intro {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  line-height: var(--lh-loose);
}

.cph-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cph-h2 {
  margin: 0;
  font-size: var(--font-md);
  font-weight: 700;
  color: var(--text-bright);
}
.cph-h3 {
  margin: 6px 0 0;
  font-size: var(--font-sm);
  font-weight: 700;
  color: var(--text-bright);
}
.cph-p {
  margin: 0;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
}
.cph-note {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-secondary);
}
.cph-list {
  margin: 0;
  padding-left: 1.3em;
  font-size: var(--font-sm);
  line-height: var(--lh-loose);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.cph-callout {
  border: 1px solid var(--accent-muted);
  background: var(--accent-subtle);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cph-callout-title {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent-fg);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cph-callout-text {
  font-size: var(--font-sm);
  line-height: 1.6;
}
.cph-callout--warn {
  border-color: var(--attention-muted);
  background: var(--attention-subtle);
}
.cph-callout--warn .cph-callout-title {
  color: var(--attention-fg);
}

.cph-tablewrap {
  overflow-x: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}
.cph-table {
  border-collapse: collapse;
  width: 100%;
  font-size: var(--font-xs);
}
.cph-table th,
.cph-table td {
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--border-muted);
  line-height: 1.55;
}
.cph-table th {
  background: var(--bg-inset);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.cph-table tr:last-child td { border-bottom: none; }
.cph-nowrap { white-space: nowrap; }

/* File names wrap on their hyphens rather than widening the column. */
.cph-file { word-break: break-all; }

/* ── The two title bars ────────────────────────────────────────────────────
   Mirrors App.vue's `.titlebar`: 38px tall, 80px reserved on the left for the
   macOS traffic lights, and — where the platform draws its own — a 146px
   reservation on the right instead. Sized in `em` like the other help mocks,
   so the picture shrinks with the dialog. */
.cph-bars {
  display: flex;
  flex-direction: column;
  gap: 0.8em;
  min-width: 0;
}
.cph-barrow {
  display: flex;
  align-items: center;
  gap: 0.6em;
  min-width: 0;
}
.cph-bar {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  gap: 0.6em;
  height: 2.9em;
  padding: 0 0.9em;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  min-width: 0;
}
.cph-bar--mac { padding-left: 0.7em; }
.cph-bar--drawn { padding-right: 0; }

.cph-mark {
  flex: none;
  color: var(--accent-fg);
  font-size: 1.15em;
}

.cph-lights {
  flex: none;
  display: flex;
  gap: 0.35em;
  /* The strip App.vue leaves free for the system's own buttons. */
  padding-right: 1.6em;
}
.cph-lights i {
  width: 0.7em;
  height: 0.7em;
  border-radius: 50%;
  background: var(--border-default);
}

.cph-bar-title {
  flex: 1 1 auto;
  min-width: 0;
  text-align: center;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cph-bar-gear {
  flex: none;
  color: var(--text-muted);
}

.cph-wincontrols {
  flex: none;
  display: flex;
  align-self: stretch;
  margin-left: 0.9em;
}
.cph-wc {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.8em;
  font-style: normal;
  color: var(--text-secondary);
  border-left: 1px solid var(--border-muted);
}
.cph-wc--close {
  color: var(--danger-fg);
  border-top-right-radius: var(--radius-sm);
  border-bottom-right-radius: var(--radius-sm);
}

/* `code` and `.cph-kbd` also appear inside v-html prose, which carries no
   scoped data-v attribute — hence :deep(). */
.cph :deep(code) {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.92em;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
}

.cph :deep(.cph-kbd) {
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
