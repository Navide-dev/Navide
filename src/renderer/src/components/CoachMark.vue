<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { findTourAnchor } from '../lib/tours'
import {
  COACH_DONE_MS,
  COACH_MISSING_CENTRE_MS,
  COACH_TICK_MS,
  welcomeActionAlreadyDone,
  welcomeActionDone,
  type CoachStep,
  type WelcomeFacts,
} from '../lib/welcomeTour'

// Coach marks: a small bubble beside the real control, saying the one thing
// to do there, the person doing the step in the real window. For as long as
// the tour is on screen the window is masked grey: one shape with holes cut
// for the control and for what it opens (its `allow`: a menu, a popover).
// Clicks in a hole reach what is under it; anywhere else they land on the
// mask and do nothing, so a stray click cannot end or derail the tour. With
// no control to point at the whole window is masked and only the bubble
// answers. No key is taken. Once the host's facts say it
// is done, the bubble says so for a moment and moves on to the next control.
// A step already done when it comes up is passed over.
//
// Next on every bubble but the last moves on without the step's action (the
// step is not come back to); the last bubble offers Done. Skip (or Esc,
// unless the focus is in a terminal, where Esc belongs to the CLI) ends the
// tour. Steps are data (lib/welcomeTour.ts).
//
// A replay is asked for, so it shows every bubble in order: nothing is passed
// over for being done already, and one whose control is not on screen sits in
// the middle instead of waiting unseen. An action done
// while a bubble is up still moves it on.
//
// From the moment a step comes up until it is judged done or the person
// presses Skip, Next or Done, its bubble stays on screen: it is placed clear
// of the control and of what the control opens (a menu, a popover), it keeps
// its place while the control briefly goes, and only after
// COACH_MISSING_CENTRE_MS without it moves to the middle. Only stepping aside
// for a modal takes it away, and it is back the moment that closes.
//
// The last bubble never closes by itself, in either mode: its action — resting
// the pointer on the quota badge — happens on the way to the bubble too, and
// closing then took the tour away mid-read. It says done and waits for Done.

const props = withDefaults(
  defineProps<{
    steps: CoachStep[]
    /** The window as the tour sees it; read inside a reactive watch. */
    facts: () => WelcomeFacts
    startIndex?: number
    /** A replay from the Help menu: Next is offered. */
    replay?: boolean
    /** Something else needs the screen: draw nothing, take no keys. */
    suspended?: boolean
  }>(),
  { startIndex: 0, replay: false, suspended: false },
)
const emit = defineEmits<{
  /** The tour moved on to this step. */
  progress: [index: number]
  /** `completed` is true when the last step was done. */
  finish: [completed: boolean]
}>()

const { t } = useI18n()

const index = ref(props.startIndex)
const step = computed<CoachStep | undefined>(() => props.steps[index.value])
const isLast = computed(() => index.value === props.steps.length - 1)
const enteredAt = ref(0)
const doneShown = ref(false)
const rect = ref<DOMRect | null>(null)
// Where the bubble is placed from: the control, or where it last was while it
// is briefly gone; null puts the bubble in the middle.
const placeRect = ref<DOMRect | null>(null)
const targetId = ref('')
// The step's control is not on screen and its fallback stands in: the bubble
// points at where the control will appear, with the fallback's line.
const onFallback = ref(false)
// Where the bubble sits: which of the spots (see place()) and its position.
// Kept from tick to tick while it still fits and overlaps nothing, so the
// bubble does not hop between spots as the layout settles.
const spot = ref<{ kind: number; left: number; top: number } | null>(null)
// What the control has opened (the step's `allow`), cut out of the mask too.
const allowRects = ref<DOMRect[]>([])
const viewport = ref({ width: window.innerWidth, height: window.innerHeight })

let doneTimer: ReturnType<typeof setTimeout> | null = null
let ticker: ReturnType<typeof setInterval> | null = null
// When the current step first found its control absent (0 = present).
let missingSince = 0
// A first-run step whose control stayed away: its bubble shows in the middle,
// saying so, with Next, instead of sitting unseen with no way out.
const lost = ref(false)
// The step's action was already done when it came up (a replay shows it
// anyway): only Next moves it on, not the done-ness it arrived with.
let doneAtEntry = false
let ended = false

function end(completed: boolean): void {
  if (ended) return
  ended = true
  emit('finish', completed)
}

function enter(): void {
  if (doneTimer) clearTimeout(doneTimer)
  doneTimer = null
  doneShown.value = false
  missingSince = 0
  lost.value = false
  enteredAt.value = Date.now()
  rect.value = null
  placeRect.value = null
  spot.value = null
  onFallback.value = false
  targetId.value = ''
  const current = step.value
  if (!current) {
    end(true)
    return
  }
  const facts = props.facts()
  if (!props.replay && welcomeActionAlreadyDone(current.waitFor, facts)) {
    advance()
    return
  }
  doneAtEntry = welcomeActionDone(current.waitFor, facts, enteredAt.value)
  locate()
}

function advance(): void {
  if (ended) return
  if (index.value >= props.steps.length - 1) {
    end(true)
    return
  }
  index.value++
  emit('progress', index.value)
  enter()
}

/** Find the step's control again: it may have moved, appeared or gone. */
function locate(): void {
  const current = step.value
  if (!current || ended) return
  viewport.value = { width: window.innerWidth, height: window.innerHeight }
  allowRects.value = (current.allow ?? []).flatMap((selector) =>
    [...document.querySelectorAll<HTMLElement>(selector)]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0),
  )
  const control = findTourAnchor(current.anchor(props.facts()))
  const el = control ?? (current.fallback ? findTourAnchor(current.fallback.anchor) : null)
  onFallback.value = !control && !!current.fallback
  if (el) {
    rect.value = el.getBoundingClientRect()
    placeRect.value = rect.value
    targetId.value = el.id
    missingSince = 0
    lost.value = false
    place()
    return
  }
  rect.value = null
  targetId.value = ''
  const now = Date.now()
  if (!missingSince) missingSince = now
  // Briefly gone (a re-render, a move): the bubble keeps its place.
  if (now - missingSince >= COACH_MISSING_CENTRE_MS) placeRect.value = null
  place()
  if (doneShown.value || props.replay) return
  if (now - missingSince >= COACH_MISSING_CENTRE_MS) lost.value = true
}

// The step's action happened: say so, then move on.
watch(
  () => !!step.value && welcomeActionDone(step.value.waitFor, props.facts(), enteredAt.value),
  (done) => {
    if (!done || doneShown.value || ended || doneAtEntry) return
    doneShown.value = true
    if (isLast.value) return
    doneTimer = setTimeout(() => {
      doneTimer = null
      advance()
    }, COACH_DONE_MS)
  },
)

// Esc is Skip only from a bubble on screen, and only when nothing else had a
// use for it: a menu or a rename that closed on it, an input method composing,
// a text field or a terminal (where Esc belongs to the CLI) holding the focus.
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.keyCode === 229) return
  if (!bubbleVisible.value) return
  const focus = document.activeElement
  if (focus instanceof Element && focus.closest('.xterm, input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return
  end(false)
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  ticker = setInterval(locate, COACH_TICK_MS)
  enter()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  if (ticker) clearInterval(ticker)
  if (doneTimer) clearTimeout(doneTimer)
})

const PAD = 4
const GAP = 10
const BUBBLE_W = 280
// A generous guess at the bubble's height, for placing it.
const BUBBLE_H = 140

// A bubble with no control to sit beside — none yet, or gone for a while —
// sits in the middle.
const centred = computed(() => !placeRect.value)
// The mask's holes, as x,y,width,height: the control (with the ring's padding)
// and whatever it has opened.
const holes = computed((): [number, number, number, number][] => {
  const r = rect.value
  const cut: [number, number, number, number][] = r
    ? [[r.left - PAD, r.top - PAD, r.width + PAD * 2, r.height + PAD * 2]]
    : []
  for (const a of allowRects.value) cut.push([a.left, a.top, a.width, a.height])
  return cut
})

// One shape over the window, the holes cut out (even-odd). clip-path also
// clips hit-testing, so a click in a hole goes to what is under it.
const maskStyle = computed((): Record<string, string> => {
  const { width, height } = viewport.value
  const d = [`M0 0H${width}V${height}H0Z`, ...holes.value.map(([x, y, w, h]) => `M${x} ${y}h${w}v${h}h${-w}Z`)].join(' ')
  return { pointerEvents: 'auto', clipPath: `path(evenodd, '${d}')` }
})

/** Whether a bubble is on screen right now. */
const bubbleVisible = computed(() => !props.suspended && !!step.value)

const ringStyle = computed((): Record<string, string> => {
  const r = rect.value
  if (!r) return { pointerEvents: 'none' }
  return {
    pointerEvents: 'none',
    top: `${r.top - PAD}px`,
    left: `${r.left - PAD}px`,
    width: `${r.width + PAD * 2}px`,
    height: `${r.height + PAD * 2}px`,
  }
})

// Beside the control, clear of every hole — the control and what it opened —
// so a menu the control opens is never under the bubble: below it, above it,
// right of it, left of it, then a corner of the window. The spot it had is
// tried first, so it only moves when that spot now overlaps or no longer fits.
function place(): void {
  const r = placeRect.value
  if (!r) {
    spot.value = null
    return
  }
  const { width: vw, height: vh } = viewport.value
  const w = BUBBLE_W
  const h = BUBBLE_H
  const x = (v: number): number => Math.max(GAP, Math.min(v, vw - w - GAP))
  const y = (v: number): number => Math.max(GAP, Math.min(v, vh - h - GAP))
  const spots: [number, number][] = [
    [x(r.left), r.bottom + PAD + GAP],
    [x(r.left), r.top - PAD - GAP - h],
    [r.right + PAD + GAP, y(r.top)],
    [r.left - PAD - GAP - w, y(r.top)],
    [vw - w - GAP, vh - h - GAP],
    [GAP, vh - h - GAP],
    [vw - w - GAP, GAP],
    [GAP, GAP],
  ]
  const fits = ([sx, sy]: [number, number]): boolean => sx >= GAP && sy >= GAP && sx + w <= vw - GAP && sy + h <= vh - GAP
  const clear = ([sx, sy]: [number, number]): boolean =>
    holes.value.every(([hx, hy, hw, hh]) => sx >= hx + hw || sx + w <= hx || sy >= hy + hh || sy + h <= hy)
  const ok = (i: number): boolean => fits(spots[i]) && clear(spots[i])
  const kept = spot.value?.kind
  let kind = kept !== undefined && ok(kept) ? kept : spots.findIndex((_, i) => ok(i))
  if (kind < 0) kind = Math.max(0, spots.findIndex(fits))
  spot.value = { kind, left: spots[kind][0], top: spots[kind][1] }
}

const bubbleStyle = computed((): Record<string, string> => {
  const at = spot.value
  if (!at) return { pointerEvents: 'auto', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  return { pointerEvents: 'auto', top: `${at.top}px`, left: `${at.left}px` }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="!suspended && step" class="coach" data-testid="coach-layer" style="pointer-events: none">
      <div
        class="coach-mask"
        data-testid="coach-mask"
        :data-holes="holes.map((h) => h.join(',')).join(';')"
        :style="maskStyle"
        @pointerdown.stop.prevent
        @mousedown.stop.prevent
        @click.stop.prevent
        @dblclick.stop.prevent
        @contextmenu.stop.prevent
        @wheel.stop.prevent
      ></div>
      <div v-if="rect" class="coach-ring" data-testid="coach-ring" :data-target="targetId" :style="ringStyle"></div>
      <div
        class="coach-bubble"
        :class="{ centred }"
        data-testid="coach-bubble"
        :data-step="step.id"
        :style="bubbleStyle"
        role="status"
        aria-live="polite"
      >
        <p class="coach-progress">{{ t('tour.progress', { n: index + 1, total: steps.length }) }}</p>
        <p class="coach-text">{{ t(onFallback && step.fallback ? step.fallback.textKey : step.textKey) }}</p>
        <p v-if="lost && !rect && !step.fallback" class="coach-missing" data-testid="coach-missing">{{ t('tour.welcome.missing') }}</p>
        <p v-if="doneShown" class="coach-done" data-testid="coach-done">{{ t('tour.welcome.doneFeedback') }}</p>
        <div class="coach-actions">
          <button type="button" class="coach-link" data-testid="coach-skip" @click="end(false)">
            {{ t('tour.skip') }}
          </button>
          <button v-if="!isLast" type="button" class="coach-link" data-testid="coach-next" @click="advance">
            {{ t('tour.welcome.next') }}
          </button>
          <button v-if="isLast" type="button" class="coach-link" data-testid="coach-finish" @click="end(true)">
            {{ t('tour.done') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.coach {
  position: fixed;
  inset: 0;
  /* Above the Welcome screen (z-modal + 110), whose buttons the first bubble
     points at; below Settings (z-modal + 120). Real modals suspend the tour. */
  z-index: calc(var(--z-modal) + 115);
  font-family: var(--font-ui);
}
.coach-mask {
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / 32%);
  backdrop-filter: grayscale(1);
  /* Over the title bar too: no window drag from under the mask. */
  -webkit-app-region: no-drag;
}
.coach-ring {
  position: absolute;
  border: 2px solid var(--accent-fg);
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-fg) 22%, transparent);
  transition: top 0.18s ease, left 0.18s ease, width 0.18s ease, height 0.18s ease;
}
.coach-bubble {
  position: absolute;
  box-sizing: border-box;
  width: min(280px, calc(100vw - 20px));
  background: var(--bg-base);
  border: 1px solid var(--border-default);
  border-left: 3px solid var(--accent-fg);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-modal);
  padding: 10px 12px 8px;
  color: var(--text-bright);
  font-size: var(--font-sm);
  line-height: 1.5;
}
.coach-progress {
  margin: 0 0 4px;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.coach-text {
  margin: 0;
}
.coach-missing {
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
}
.coach-done {
  margin: 6px 0 0;
  color: var(--success-fg);
  font-weight: 600;
}
.coach-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 6px;
}
.coach-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  cursor: pointer;
  text-decoration: underline;
}
.coach-link:hover,
.coach-link:focus-visible {
  color: var(--text-bright);
}
</style>
