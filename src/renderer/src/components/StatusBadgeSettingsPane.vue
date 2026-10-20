<script setup lang="ts">
// The Status Badges tab: rename and recolour every pane status in one place.
//
// The nine rows are the whole status vocabulary — the seven a pane reports plus
// the two only a pane row can show. Each row previews itself with the exact
// pill markup TerminalPane uses, so what the user picks here is what they will
// see on the pane, not an approximation of it.
//
// Colour is a swatch pick rather than a colour input on purpose: every choice
// has to stay legible across five themes, which a free hex cannot promise. The
// swatches render their real resolved colour under the current theme by binding
// the palette's token expressions straight into the button.
import { useI18n } from 'vue-i18n'
import { AVAILABLE_UI_LOCALES, vTruncate, type UiLocale } from '@navide/plugin-ui/foundation'

import { paneStatusLabelKey, type PaneStatusValue } from '../lib/paneStatusLabel'
import {
  DEFAULT_STATUS_COLORS,
  PANE_STATUS_ORDER,
  STATUS_COLOR_KEYS,
  STATUS_COLOR_PALETTE,
  type StatusColorKey,
} from '../lib/statusBadgePalette'
import {
  resetAllStatusBadgePrefs,
  resetStatusBadgePref,
  setStatusBadgePref,
  statusBadgeLabelOverride,
  useStatusBadgePrefs,
} from '../composables/useStatusBadgePrefs'

const { t, locale } = useI18n()
const { prefs, hasOverrides } = useStatusBadgePrefs()

/** Statuses a pane cannot report itself; they only ever appear on list rows,
 *  and saying so stops "why does my pane never show this?" */
const ROW_ONLY: readonly PaneStatusValue[] = ['waiting', 'disconnected']

/** The shipped translation for a status in one locale — the placeholder, and
 *  what an emptied field falls back to. */
function defaultLabel(status: PaneStatusValue, locale: string): string {
  return t(paneStatusLabelKey(status), {}, { locale })
}

function colorOf(status: PaneStatusValue): StatusColorKey {
  return prefs.value[status]?.color ?? DEFAULT_STATUS_COLORS[status]
}

/** Preview swatch / pill fill for a colour, resolved by the browser against the
 *  live theme rather than by us against a table. */
function swatchStyle(color: StatusColorKey): Record<string, string> {
  const spec = STATUS_COLOR_PALETTE[color]
  return { background: spec.bg, color: spec.fg, borderColor: spec.fg }
}

function previewStyle(status: PaneStatusValue): Record<string, string> {
  const spec = STATUS_COLOR_PALETTE[colorOf(status)]
  return { background: spec.bg, color: spec.fg }
}

/** What the badge would read as right now, in one locale. */
function previewLabel(status: PaneStatusValue, locale: string): string {
  return statusBadgeLabelOverride(status, locale) || defaultLabel(status, locale)
}

function isCustomized(status: PaneStatusValue): boolean {
  return !!prefs.value[status]
}

/** One label column per UI language that has a catalog. The original three
 *  keep their column headings; a later language is headed by its own name. */
const LEGACY_COLUMN_KEYS: Partial<Record<UiLocale, string>> = {
  'zh-TW': 'statusBadges.col.zh',
  'en-US': 'statusBadges.col.en',
  'ja-JP': 'statusBadges.col.ja',
}
const LABEL_COLUMNS = AVAILABLE_UI_LOCALES.map((code) => ({
  code,
  headingKey: LEGACY_COLUMN_KEYS[code] ?? `settings.appearance.language-${code}`,
}))

function onLabel(status: PaneStatusValue, locale: UiLocale, value: string): void {
  setStatusBadgePref(status, { labels: { [locale]: value } })
}
</script>

<template>
  <div class="sb" :style="{ '--sb-label-cols': LABEL_COLUMNS.length }">
    <p class="sb-intro">{{ $t('statusBadges.intro') }}</p>

    <div class="sb-head">
      <span class="sb-h-status">{{ $t('statusBadges.col.status') }}</span>
      <span v-for="column in LABEL_COLUMNS" :key="column.code" class="sb-h-label">{{ $t(column.headingKey) }}</span>
      <span class="sb-h-color">{{ $t('statusBadges.col.color') }}</span>
      <span class="sb-h-reset"></span>
    </div>

    <div
      v-for="status in PANE_STATUS_ORDER"
      :key="status"
      class="sb-row"
      :data-customized="isCustomized(status) ? 'yes' : 'no'"
    >
      <div class="sb-status">
        <span class="sb-preview" :style="previewStyle(status)">
          {{ previewLabel(status, locale) }}
        </span>
        <span class="sb-key">
          <span class="sb-key-name" v-truncate>{{ status }}</span>
          <em v-if="ROW_ONLY.includes(status)" class="sb-rowonly">
            {{ $t('statusBadges.row-only') }}
          </em>
        </span>
        <span class="sb-when">{{ $t(`statusBadges.when.${status}`) }}</span>
      </div>

      <label v-for="column in LABEL_COLUMNS" :key="column.code" class="sb-field">
        <span class="sb-sr">{{ $t(column.headingKey) }} — {{ status }}</span>
        <input
          type="text"
          maxlength="24"
          :value="prefs[status]?.labels?.[column.code] ?? ''"
          :placeholder="defaultLabel(status, column.code)"
          @change="onLabel(status, column.code, ($event.target as HTMLInputElement).value)"
        />
      </label>

      <div class="sb-colors" role="radiogroup" :aria-label="$t('statusBadges.col.color')">
        <button
          v-for="color in STATUS_COLOR_KEYS"
          :key="color"
          type="button"
          role="radio"
          class="sb-swatch"
          :class="{ 'is-on': colorOf(status) === color }"
          :aria-checked="colorOf(status) === color"
          :style="swatchStyle(color)"
          :title="$t(`statusBadges.color.${color}`)"
          @click="setStatusBadgePref(status, { color })"
        />
      </div>

      <button
        type="button"
        class="sb-reset"
        :disabled="!isCustomized(status)"
        :title="$t('statusBadges.reset-one')"
        @click="resetStatusBadgePref(status)"
      >
        {{ $t('statusBadges.reset-one') }}
      </button>
    </div>

    <div class="sb-foot">
      <p class="sb-note">{{ $t('statusBadges.note') }}</p>
      <button
        type="button"
        class="sb-reset-all"
        :disabled="!hasOverrides"
        @click="resetAllStatusBadgePrefs()"
      >
        {{ $t('statusBadges.reset-all') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.sb {
  display: grid;
  grid-template-columns: max-content minmax(120px, 2fr) repeat(var(--sb-label-cols, 3), minmax(108px, 1fr)) max-content max-content;
  column-gap: 12px;
  row-gap: 2px;
}
.sb-intro,
.sb-foot {
  grid-column: 1 / -1;
}
.sb-intro {
  margin: 0 0 14px;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  line-height: 1.6;
  max-width: 68ch;
}

/* The header and every row are subgrids of .sb, so the auto-sized colour and
 * reset columns take one width for all of them and the headers sit over their
 * own column. */
.sb-head,
.sb-row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  align-items: center;
  padding: 8px 10px;
}
.sb-head {
  font-size: var(--font-row-desc);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-muted);
  padding-bottom: 6px;
}
.sb-row {
  border-radius: var(--radius-md, 8px);
  border: 1px solid transparent;
}
.sb-row:hover {
  background: var(--bg-hover-faint);
}
/* A customized status is worth spotting at a glance when you come back to
 * undo one; the marker is a rail, not a fill, so it never fights the swatches. */
.sb-row[data-customized='yes'] {
  border-color: var(--border-muted);
  background: var(--bg-hover-faint);
}

/* The pill gets its own .sb column, as wide as the widest pill in the current
 * locale, so every key and description starts at the same x. */
.sb-h-status,
.sb-status {
  grid-column: span 2;
}
.sb-status {
  display: grid;
  grid-template-columns: subgrid;
  grid-template-areas: 'preview key' 'preview when';
  align-items: center;
  min-width: 0;
}
.sb-preview {
  grid-area: preview;
  align-self: center;
  justify-self: start;
  font-size: var(--font-3xs);
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
/* When the key and the "list only" tag do not fit on one line the tag wraps
 * under the key, so neither of them is cut. */
.sb-key {
  grid-area: key;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  min-width: 0;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-row-desc);
  color: var(--text-primary);
}
.sb-key-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-rowonly {
  font-family: inherit;
  font-style: normal;
  font-size: var(--font-3xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  border: 1px solid var(--border-muted);
  border-radius: 4px;
  padding: 0 4px;
  white-space: nowrap;
}
/* Wraps instead of truncating: the description is the only place that says
 * when a status applies, and ja-JP runs about twice as long as en-US. */
.sb-when {
  grid-area: when;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  line-height: 1.4;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

.sb-field {
  display: block;
  min-width: 0;
}
.sb-field input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background: var(--bg-base);
  color: var(--text-primary);
  font-family: var(--font-ui);
  font-size: var(--font-sm);
  line-height: var(--lh-base);
  padding: 4px 8px;
  transition: border-color var(--motion-fast) var(--ease-out);
}
/* The placeholder is the label in effect, not a hint, so it reads at the
 * secondary text colour rather than the muted one. */
.sb-field input::placeholder {
  color: var(--text-secondary);
}
.sb-field input:hover {
  border-color: var(--border-strong);
}
.sb-field input:focus {
  outline: none;
  border-color: var(--accent-focus);
}
/* Visually hidden but read aloud: each input needs its own name, and a visible
 * one would repeat the column header nine times. */
.sb-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* Two rows of five keep the column narrow enough that the reset button stays
 * inside the card in every locale, and leave each swatch a 24px target. */
.sb-colors {
  display: grid;
  grid-template-columns: repeat(5, 24px);
  gap: 4px;
}
.sb-swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px solid var(--border-muted);
  padding: 0;
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.sb-swatch:hover {
  transform: scale(1.15);
}
/* The selected swatch is ringed in the app's focus colour rather than its own,
 * so "which one is picked" stays readable even on the two neutral swatches. */
.sb-swatch.is-on {
  box-shadow: 0 0 0 2px var(--bg-base), 0 0 0 4px var(--accent-focus);
}
.sb-swatch:focus-visible {
  outline: 2px solid var(--accent-focus);
  outline-offset: 2px;
}

.sb-reset,
.sb-reset-all {
  font-size: var(--font-row-desc);
  padding: 4px 10px;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--border-default);
  background: var(--bg-subtle);
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
.sb-reset:hover:not(:disabled),
.sb-reset-all:hover:not(:disabled) {
  background: var(--bg-hover-strong);
}
/* Disabled drops the fill and border instead of fading the whole button, so
 * the label stays readable next to the inputs. */
.sb-reset:disabled,
.sb-reset-all:disabled {
  background: transparent;
  border-color: var(--border-muted);
  color: var(--text-secondary);
  cursor: default;
}

.sb-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border-muted);
}
.sb-note {
  margin: 0;
  font-size: var(--font-row-desc);
  color: var(--text-secondary);
  max-width: 60ch;
  line-height: 1.6;
}

/* Below the three-input width the grid stops being a table and becomes stacked
 * cards, which is the only way nine rows of six columns stay usable. */
@media (max-width: 920px) {
  .sb {
    display: flex;
    flex-direction: column;
  }
  .sb-head {
    display: none;
  }
  .sb-status {
    grid-column: auto;
    grid-template-columns: auto 1fr;
    column-gap: 10px;
  }
  .sb-row {
    grid-template-columns: 1fr;
    gap: 8px;
    border-color: var(--border-muted);
    margin-bottom: 8px;
  }
  .sb-reset {
    justify-self: start;
  }
}
</style>
