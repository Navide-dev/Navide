<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { findTourAnchor, type TourPrepare, type TourStep } from '../lib/tours'

// A step-by-step walkthrough over the live window: each step dims everything
// but the element it is about and explains it in a card beside it. Steps are
// data (lib/tours.ts); this component only walks them.
//
// Keyboard: → / Enter next, ← back, Esc leaves; Tab stays inside the card.
// The keys are taken in the capture phase so a Settings modal underneath does
// not also close on the same Esc.

const props = withDefaults(
  defineProps<{
    steps: TourStep[]
    /** Runs a step's `prepare` (App.vue opens or closes Settings). */
    runPrepare?: (prepare: TourPrepare) => void | Promise<void>
    /** How long a step waits for its anchor to be laid out before giving up. */
    anchorTimeoutMs?: number
  }>(),
  { runPrepare: undefined, anchorTimeoutMs: 2000 },
)
/** `completed` is true only when the last step's Done was used. */
const emit = defineEmits<{ close: [completed: boolean] }>()

const { t } = useI18n()

// The step the tour is on, and the step whose card is drawn. They differ only
// while a step looks for its anchor: a step with no prepare keeps the previous
// card up for that one frame, so Next never leaves an empty dimmed window, and
// a step with a prepare (which may take a while) shows its own card centred at
// once and moves it beside the anchor when that turns up.
const index = ref(0)
const shownIndex = ref<number | null>(null)
const anchorEl = ref<HTMLElement | null>(null)
const rect = ref<DOMRect | null>(null)
// True once the current step has finished looking for its anchor.
const settled = ref(false)
const cardRef = ref<HTMLElement | null>(null)

const step = computed(() => props.steps[index.value])
const isLast = computed(() => index.value === props.steps.length - 1)
const shownStep = computed(() => (shownIndex.value === null ? undefined : props.steps[shownIndex.value]))
const shownIsLast = computed(() => shownIndex.value === props.steps.length - 1)
const missing = computed(
  () => settled.value && shownIndex.value === index.value && !!step.value?.anchor && !anchorEl.value,
)

// Each step change starts a new lookup; an older one still polling must not
// write its result over the newer step's.
let lookupToken = 0
let pollTimer: ReturnType<typeof setTimeout> | null = null

function clearPoll(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

/** One frame: long enough for a state change to be laid out. A hidden or
 *  minimised window may not paint frames at all, so a short timer stands in. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 100)
    requestAnimationFrame(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function enterStep(): Promise<void> {
  const token = ++lookupToken
  clearPoll()
  settled.value = false
  const current = step.value
  if (!current) return
  if (current.prepare && props.runPrepare) {
    // Opening Settings can take a while: show this step's card centred now
    // rather than leaving the previous one up or nothing at all.
    shownIndex.value = index.value
    anchorEl.value = null
    rect.value = null
    // A prepare that never settles must not leave the tour without a card:
    // it gets the anchor budget, then the step shows regardless.
    let capTimer: ReturnType<typeof setTimeout> | null = null
    try {
      await Promise.race([
        props.runPrepare(current.prepare),
        new Promise<void>((r) => {
          capTimer = setTimeout(r, props.anchorTimeoutMs)
        }),
      ])
    } catch (err) {
      // The step still shows — just without its anchor.
      console.warn('[GuidedTour] prepare failed', err)
    } finally {
      if (capTimer) clearTimeout(capTimer)
    }
  }
  await nextTick()
  if (token !== lookupToken) return
  if (!current.anchor) {
    settle(token, null)
    return
  }
  const selector = current.anchor
  if (!current.prepare) {
    // Nothing was opened for this step, so the window already is what it
    // points at: the anchor is there after one frame or not at all. Waiting
    // out the budget here only left a blank dimmed window for two seconds.
    await nextFrame()
    if (token !== lookupToken) return
    settle(token, findTourAnchor(selector))
    return
  }
  const deadline = Date.now() + props.anchorTimeoutMs
  const poll = (): void => {
    if (token !== lookupToken) return
    const el = findTourAnchor(selector)
    if (el || Date.now() >= deadline) settle(token, el)
    else pollTimer = setTimeout(poll, 50)
  }
  poll()
}

function settle(token: number, el: HTMLElement | null): void {
  if (token !== lookupToken) return
  anchorEl.value = el
  rect.value = null
  if (el) {
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    rect.value = el.getBoundingClientRect()
  }
  shownIndex.value = index.value
  settled.value = true
  void nextTick(() => cardRef.value?.querySelector<HTMLElement>('[data-tour-primary]')?.focus())
}

function measure(): void {
  if (anchorEl.value) rect.value = anchorEl.value.getBoundingClientRect()
}

function next(): void {
  if (isLast.value) {
    emit('close', true)
    return
  }
  index.value++
}
function back(): void {
  if (index.value > 0) index.value--
}
function leave(): void {
  emit('close', false)
}

watch(index, () => void enterStep())

function onKeydown(e: KeyboardEvent): void {
  const inCard = !!cardRef.value && cardRef.value.contains(e.target as Node)
  if (e.key === 'Escape') {
    leave()
  } else if (e.key === 'ArrowRight') {
    next()
  } else if (e.key === 'ArrowLeft') {
    back()
  } else if (e.key === 'Enter' && !inCard) {
    // Enter on one of the card's own buttons presses that button natively.
    next()
  } else if (e.key === 'Tab') {
    const buttons = Array.from(cardRef.value?.querySelectorAll<HTMLElement>('button') ?? [])
    if (buttons.length === 0) return
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const to = e.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at + 1) % buttons.length
    buttons[to].focus()
  } else {
    // Other keys stay with the tour too: typing must not reach a pane
    // underneath while the window is dimmed. ⌘/Ctrl chords are left alone so
    // app shortcuts (Quit, Reload) keep working.
    if (!inCard && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    return
  }
  e.preventDefault()
  e.stopImmediatePropagation()
}

// The tour moves focus to its own card; when it goes away, focus goes back to
// wherever it was when the tour began, not to <body>.
let focusBefore: HTMLElement | null = null

onMounted(() => {
  focusBefore = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', measure)
  void enterStep()
})
onBeforeUnmount(() => {
  lookupToken++
  clearPoll()
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', measure)
})
onUnmounted(() => {
  if (focusBefore?.isConnected) focusBefore.focus()
  focusBefore = null
})

const PAD = 6
const GAP = 12
const CARD_W = 340
// A generous guess at the card's height: only used to decide above/below.
const CARD_H = 230

const holeStyle = computed(() => {
  const r = rect.value
  if (!r) return {}
  return {
    top: `${r.top - PAD}px`,
    left: `${r.left - PAD}px`,
    width: `${r.width + PAD * 2}px`,
    height: `${r.height + PAD * 2}px`,
  }
})

const cardStyle = computed((): Record<string, string> => {
  const r = rect.value
  if (!r) return {}
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.max(GAP, Math.min(r.left, vw - CARD_W - GAP))
  if (r.bottom + PAD + GAP + CARD_H <= vh) return { top: `${r.bottom + PAD + GAP}px`, left: `${left}px` }
  if (r.top - PAD - GAP - CARD_H >= 0) return { bottom: `${vh - r.top + PAD + GAP}px`, left: `${left}px` }
  // An anchor too tall for either side (a whole Settings page): sit inside
  // its bottom-right corner, where the page's own controls rarely are.
  return {
    bottom: `${vh - Math.min(r.bottom, vh) + GAP * 2}px`,
    right: `${vw - Math.min(r.right, vw) + GAP * 2}px`,
  }
})
</script>

<template>
  <Teleport to="body">
    <div class="tour" data-testid="guided-tour">
      <div v-if="rect" class="tour-hole" :style="holeStyle" data-testid="tour-hole"></div>
      <div v-else class="tour-dim"></div>
      <div
        v-if="shownStep"
        ref="cardRef"
        class="tour-card"
        :class="{ centred: !rect }"
        :style="cardStyle"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        :data-step="shownStep.id"
      >
        <p class="tour-progress" aria-live="polite">
          {{ t('tour.progress', { n: (shownIndex ?? 0) + 1, total: steps.length }) }}
        </p>
        <h2 id="tour-title" class="tour-title">{{ t(shownStep.titleKey) }}</h2>
        <p id="tour-body" class="tour-body">{{ t(shownStep.bodyKey) }}</p>
        <p v-if="missing && shownStep.missingKey" class="tour-missing" data-testid="tour-missing">
          {{ t(shownStep.missingKey) }}
        </p>
        <div class="tour-actions">
          <button v-if="!shownIsLast" type="button" class="tour-skip" data-testid="tour-skip" @click="leave">
            {{ t('tour.skip') }}
          </button>
          <span class="tour-spacer"></span>
          <button
            v-if="(shownIndex ?? 0) > 0"
            type="button"
            class="nv-btn"
            data-testid="tour-back"
            @click="back"
          >{{ t('tour.back') }}</button>
          <button
            type="button"
            class="nv-btn nv-btn--primary"
            data-tour-primary
            data-testid="tour-next"
            @click="next"
          >{{ shownIsLast ? t('tour.done') : t('tour.next') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.tour {
  position: fixed;
  inset: 0;
  /* Above Settings (z-modal + 120) and its confirm layers (+131): a step
     points into an open Settings page. */
  z-index: calc(var(--z-modal) + 400);
  font-family: var(--font-ui);
}
.tour-dim {
  position: absolute;
  inset: 0;
  background: var(--modal-backdrop);
}
/* The cut-out: one box whose enormous shadow dims the rest of the window. */
.tour-hole {
  position: absolute;
  border-radius: var(--radius-lg);
  box-shadow:
    0 0 0 2px var(--accent-fg),
    0 0 0 9999px var(--modal-backdrop);
  pointer-events: none;
  transition: top 0.18s ease, left 0.18s ease, width 0.18s ease, height 0.18s ease;
}
.tour-card {
  position: absolute;
  box-sizing: border-box;
  width: min(340px, calc(100vw - 24px));
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-top: 3px solid var(--accent-fg);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  padding: 14px 16px 12px;
  color: var(--text-bright);
  font-size: var(--font-sm);
}
.tour-card.centred {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(420px, calc(100vw - 24px));
}
.tour-card:focus-within {
  outline: none;
}
.tour-progress {
  margin: 0 0 4px;
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent-fg);
}
.tour-title {
  margin: 0 0 8px;
  font-size: var(--font-lg);
  font-weight: 600;
  color: var(--text-bright);
}
.tour-body {
  margin: 0;
  line-height: 1.55;
  white-space: pre-line;
  color: var(--text-bright);
}
.tour-missing {
  margin: 10px 0 0;
  padding: 8px 10px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  line-height: 1.5;
}
.tour-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.tour-spacer {
  flex: 1;
}
.tour-skip {
  border: none;
  background: none;
  padding: 4px 0;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-xs);
  cursor: pointer;
}
.tour-skip:hover,
.tour-skip:focus-visible {
  color: var(--text-bright);
  text-decoration: underline;
}
</style>
