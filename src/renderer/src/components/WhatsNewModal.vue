<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { pickText, WHATS_NEW_CHROME, type WhatsNewEntry } from '../lib/whatsNew'
import NavideCloudMark from './NavideCloudMark.vue'

const props = defineProps<{
  entry: WhatsNewEntry
  /** The entry's tour was already taken to the end: offer it as a replay. */
  tourDone?: boolean
}>()
const emit = defineEmits<{ close: []; tour: [] }>()

const { locale } = useI18n()

const title = computed(() => pickText(props.entry.title, locale.value))
const major = computed(() => props.entry.major === true)
const header = computed(() =>
  pickText(major.value ? WHATS_NEW_CHROME.majorHeader : WHATS_NEW_CHROME.header, locale.value),
)
const dismiss = computed(() => pickText(WHATS_NEW_CHROME.dismiss, locale.value))
const highlights = computed(() =>
  props.entry.highlights.map((h) => pickText(h, locale.value)),
)
const note = computed(() =>
  props.entry.note ? pickText(props.entry.note, locale.value) : '',
)

// A spotlight is only drawn on a release that also claims to be major: the
// panel is what makes the release read as a big one, so letting a routine
// release carry it would spend the signal.
const spotlight = computed(() => (major.value ? (props.entry.spotlight ?? null) : null))
const spotlightPoints = computed(() =>
  (spotlight.value?.points ?? []).map((p) => pickText(p, locale.value)),
)
const spotlightTagline = computed(() =>
  spotlight.value ? pickText(spotlight.value.tagline, locale.value) : '',
)
const introducing = computed(() => pickText(WHATS_NEW_CHROME.introducing, locale.value))
const alsoIn = computed(() => pickText(WHATS_NEW_CHROME.alsoIn, locale.value))

const features = computed(() =>
  (props.entry.features ?? []).map((f) => ({
    icon: f.icon,
    name: pickText(f.name, locale.value),
    tagline: pickText(f.tagline, locale.value),
    where: pickText(f.where, locale.value),
  })),
)
const details = computed(() => pickText(WHATS_NEW_CHROME.details, locale.value))
// An entry with a tour asks a question instead of saying "Got it": take the
// tour, or not now (with where to find it again).
const hasTour = computed(() => (props.entry.tour?.length ?? 0) > 0)
const takeTour = computed(() =>
  pickText(props.tourDone ? WHATS_NEW_CHROME.retakeTour : WHATS_NEW_CHROME.takeTour, locale.value),
)
const notNow = computed(() => pickText(WHATS_NEW_CHROME.notNow, locale.value))
const reopenHint = computed(() => pickText(WHATS_NEW_CHROME.reopenHint, locale.value))

// Enter on the overlay means "Got it" — but on an entry that asks a question
// there is no single answer, and Enter on a focused button already presses it.
function onEnter(e: KeyboardEvent): void {
  if (hasTour.value) return
  if (e.target instanceof HTMLButtonElement) return
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <div
      class="modal nv-modal-overlay"
      tabindex="-1"
      @click.self="emit('close')"
      @keydown.esc="emit('close')"
      @keydown.enter="onEnter"
    >
      <div class="card nv-modal-shell nv-modal-shell--standard" :class="{ major }">
        <header>
          <span class="dot"></span>
          <strong>{{ header }} · v{{ entry.version }}</strong>
        </header>
        <div class="body">
          <h2 class="title">{{ title }}</h2>

          <!-- The one feature this release is remembered for, given the room
               to introduce itself rather than a bullet among nine others. -->
          <section v-if="spotlight" class="spotlight">
            <div class="sp-head">
              <span class="sp-mark" aria-hidden="true"><NavideCloudMark /></span>
              <div class="sp-head-text">
                <p class="sp-eyebrow">{{ introducing }}</p>
                <p class="sp-name">{{ spotlight.name }}</p>
              </div>
            </div>
            <p class="sp-tagline">{{ spotlightTagline }}</p>
            <ul class="sp-points">
              <li v-for="(point, i) in spotlightPoints" :key="i">{{ point }}</li>
            </ul>
          </section>

          <!-- Headline features side by side, for a release with more than
               one thing worth stopping for. -->
          <section v-if="features.length" class="features" data-testid="whats-new-features">
            <article v-for="(f, i) in features" :key="i" class="feature">
              <span class="ft-icon" aria-hidden="true">{{ f.icon }}</span>
              <p class="ft-name">{{ f.name }}</p>
              <p class="ft-tagline">{{ f.tagline }}</p>
              <p class="ft-where">{{ f.where }}</p>
            </article>
          </section>

          <h3 v-if="spotlight" class="also-in">{{ alsoIn }}</h3>
          <h3 v-else-if="features.length" class="also-in">{{ details }}</h3>
          <ul class="highlights">
            <li v-for="(line, i) in highlights" :key="i">{{ line }}</li>
          </ul>
          <p v-if="note" class="note">{{ note }}</p>
        </div>
        <footer v-if="hasTour">
          <span class="reopen-hint">{{ reopenHint }}</span>
          <button class="nv-btn" data-testid="whats-new-not-now" @click="emit('close')">{{ notNow }}</button>
          <button
            class="primary nv-btn nv-btn--primary"
            data-testid="whats-new-tour"
            @click="emit('tour')"
          >{{ takeTour }}</button>
        </footer>
        <footer v-else>
          <button class="primary nv-btn nv-btn--primary" @click="emit('close')">{{ dismiss }}</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  background: var(--modal-backdrop);
  backdrop-filter: blur(var(--modal-backdrop-blur));
  -webkit-backdrop-filter: blur(var(--modal-backdrop-blur));
  display: flex;
  align-items: center;
  justify-content: center;
  /* Above the Welcome screen (z-modal + 110), where it opens for an upgrade
     with no workspace restored; below Settings (z-modal + 120). Under Welcome
     it was unseen and never closed, and every modal check stayed true. */
  z-index: calc(var(--z-modal) + 112);
}
.modal:focus {
  outline: none;
}
.card {
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-left: 4px solid var(--accent-fg);
  border-radius: var(--radius-lg);
  width: min(var(--modal-w-standard), 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  color: var(--text-bright);
  font-family: var(--font-ui);
  font-size: var(--font-sm);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}
header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-muted);
  background: var(--bg-subtle);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent-fg);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-fg) 20%, transparent);
}
header strong {
  color: var(--text-bright);
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 18px;
}
.title {
  margin: 0 0 12px;
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--text-bright);
}
.highlights {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  line-height: 1.55;
}
.highlights li {
  color: var(--text-bright);
}
.note {
  margin: 14px 0 0;
  padding: 10px 12px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-muted);
  border-radius: 6px;
  line-height: var(--lh-base);
  color: var(--text-secondary);
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border-muted);
  background: var(--bg-base);
}
button {
  border: 1px solid var(--border-default);
  background: var(--bg-muted);
  color: var(--text-bright);
  font-size: var(--font-xs);
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: inherit;
}
button.primary {
  background: var(--success-emphasis);
  border-color: var(--success-strong);
  color: var(--text-on-emphasis);
  font-weight: 600;
}
button.primary:hover {
  background: var(--success-strong);
}

/* ── Major release ────────────────────────────────────────────────────────
   A release that introduces a new surface gets chrome that says so. The
   ordinary announcement keeps its quiet accent stripe; this one earns the
   wider panel and the tinted header, and nothing else in the app does — that
   is what makes it read as an occasion rather than a style. */
.card.major {
  /* Between standard (620) and wide (1100): the spotlight needs more room than
     a form, and --modal-w-wide is for data tables — at 1100px these lines get
     too long to read. */
  width: min(700px, 94vw);
  border-left-width: 0;
  border-color: var(--accent-muted);
  box-shadow: var(--shadow-modal);
}
.card.major header {
  background:
    linear-gradient(90deg, var(--accent-subtle) 0%, var(--bg-subtle) 72%);
  border-bottom-color: var(--accent-muted);
}
/* The version line is the badge on a major release: uppercase, spaced, and
   in the accent, so "重大更新 · v0.2.0" is legible as a label at a glance. */
.card.major header strong {
  color: var(--accent-fg);
  letter-spacing: 0.06em;
}
.card.major .dot {
  background: var(--accent-bright);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-bright) 24%, transparent);
}
.card.major .title {
  font-size: var(--font-xl, 19px);
  line-height: 1.45;
  margin-bottom: 16px;
}

/* ── Spotlight ────────────────────────────────────────────────────────────
   The feature panel. It sits above the bullet list because a person who reads
   one thing should read this one. */
.spotlight {
  border: 1px solid var(--accent-muted);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(130% 150% at 0% 0%, var(--accent-subtle) 0%, transparent 60%),
    var(--bg-subtle);
  padding: 18px 20px;
  margin-bottom: 22px;
}
.sp-head {
  display: flex;
  align-items: center;
  gap: 14px;
}
.sp-mark {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--accent-muted);
  background: var(--bg-base);
  color: var(--accent-fg);
  --nv-cloud-node-fill: var(--bg-base);
}
.sp-mark :deep(.nv-cloud-mark) { width: 30px; height: 23px; }
.sp-head-text { min-width: 0; }
.sp-eyebrow {
  margin: 0;
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent-fg);
}
.sp-name {
  margin: 1px 0 0;
  font-size: 21px;
  font-weight: 700;
  color: var(--text-bright);
  letter-spacing: 0.01em;
}
.sp-tagline {
  margin: 12px 0 0;
  color: var(--text-secondary);
  line-height: 1.6;
}
.sp-points {
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 9px;
}
/* Custom markers rather than discs: the bullet list below uses discs, and the
   two lists have to be told apart at a glance. */
.sp-points li {
  position: relative;
  padding-left: 22px;
  line-height: 1.55;
  color: var(--text-bright);
}
.sp-points li::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0.62em;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 2px solid var(--accent-fg);
}
.also-in {
  margin: 0 0 10px;
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.card.major .note {
  border-color: var(--accent-muted);
  background: var(--accent-subtle);
  color: var(--text-bright);
}

/* ── Feature cards ────────────────────────────────────────────────────────
   Two (or three) headline features, each its own card, so neither reads as a
   footnote to the other. */
.features {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
.feature {
  border: 1px solid var(--accent-muted);
  border-radius: var(--radius-lg);
  background:
    radial-gradient(130% 150% at 0% 0%, var(--accent-subtle) 0%, transparent 60%),
    var(--bg-subtle);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ft-icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--accent-muted);
  background: var(--bg-base);
  font-size: 18px;
}
.ft-name {
  margin: 4px 0 0;
  font-size: var(--font-lg);
  font-weight: 700;
  color: var(--text-bright);
}
.ft-tagline {
  margin: 0;
  line-height: 1.55;
  color: var(--text-bright);
}
.ft-where {
  margin: auto 0 0;
  padding-top: 6px;
  font-size: var(--font-xs);
  color: var(--accent-fg);
}
.reopen-hint {
  margin-right: auto;
  align-self: center;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}

/* A narrow window has no room for the wide panel; the content is the same. */
@media (max-width: 700px) {
  .sp-mark { width: 40px; height: 40px; }
  .sp-mark :deep(.nv-cloud-mark) { width: 25px; height: 19px; }
  .sp-name { font-size: 18px; }
}
</style>
