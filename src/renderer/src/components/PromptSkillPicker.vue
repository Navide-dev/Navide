<script setup lang="ts">
// The ∞ button's skill picker: hover the button, a ring of prompt skills fans
// out below it with a live preview of what each one would send.
//
// Two hard rules from the plan:
//  - A plain click on the button is untouched. This component only adds a
//    hover layer; it never intercepts the click.
//  - The ring is capped at RING_MAX_SLOTS slots. Beyond that (or in a narrow pane)
//    it renders the list layout instead — same skills, same keys, different
//    arrangement.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import PromptSkillIcon from './PromptSkillIcon.vue'
import {
  RING_MAX_SLOTS,
  RING_R_MAX,
  RING_SLOT_D,
  ringGeometry,
  ringSlotOffsets,
  type PromptSkill,
} from '../lib/promptSkills'

const props = defineProps<{
  skills: PromptSkill[]
}>()

const emit = defineEmits<{
  (e: 'cast', skillId: string): void
  /** True the moment the cursor lands on the button — before the open delay.
   *  The pane header carries its own native `title`, and a native tooltip
   *  drawn over the ring is exactly what this suppresses. */
  (e: 'active', value: boolean): void
}>()

/** Hover intent: header is also the drag / rename / context-menu hot zone, so
 *  a cursor merely passing over the button must not open anything. */
const OPEN_DELAY_MS = 300
/** Leaving grace — pointing at the ring briefly leaves the button itself. */
const CLOSE_DELAY_MS = 200
const NARROW_PANE_PX = 320

const anchorRef = ref<HTMLElement | null>(null)
const menuRef = ref<HTMLElement | null>(null)
const open = ref(false)
const hoverId = ref<string | null>(null)
/** The ring's origin is the button's center; the list hangs from its bottom
 *  edge, `halfHeight` below that. */
const anchor = ref({ x: 0, y: 0, halfHeight: 0 })
const flipPreview = ref(false)
/** Measured at open time from the owning pane, not passed in as a prop: the
 *  pane resizes constantly and only the value at open time matters. */
const paneWidth = ref(Infinity)

let openTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

function clearTimers(): void {
  if (openTimer) clearTimeout(openTimer)
  if (closeTimer) clearTimeout(closeTimer)
  openTimer = null
  closeTimer = null
}

const castable = computed(() => props.skills)
const asList = computed(() => castable.value.length > RING_MAX_SLOTS || paneWidth.value < NARROW_PANE_PX)

/** Geometry lives in lib/promptSkills so the spacing rule is testable and the
 *  component stays a renderer. Radius follows the slot count: one slot hugs
 *  the button, five fan out just far enough not to touch. */
const geometry = computed(() => ringGeometry(castable.value.length))

const slots = computed(() => {
  const offsets = ringSlotOffsets(castable.value.length)
  return castable.value.map((skill, i) => ({ skill, ...offsets[i] }))
})

/** The preview sits just outside the ring, and the settings row just under it,
 *  so both follow the radius instead of being pinned to magic numbers. */
const previewStyle = computed(() => {
  const offset = geometry.value.radius + RING_SLOT_D / 2 + 14
  return flipPreview.value ? { right: `${offset}px` } : { left: `${offset}px` }
})
const footStyle = computed(() => ({ top: `${geometry.value.radius + RING_SLOT_D / 2 + 12}px` }))

/** The button and the ring do not touch: there is bare pane header between
 *  them. Without something to hover, walking the cursor down to a slot leaves
 *  the anchor, starts the close timer, and the ring vanishes mid-reach. This
 *  box spans that gap and belongs to the menu, so entering it keeps the ring
 *  open. It is clipped to a wedge so it only covers the path to the slots. */
const bridgeStyle = computed(() => ({
  top: `${anchor.value.halfHeight}px`,
  width: `${geometry.value.radius * 2 + RING_SLOT_D}px`,
  height: `${geometry.value.radius + RING_SLOT_D / 2 - anchor.value.halfHeight}px`,
}))

const previewSkill = computed(() => castable.value.find((s) => s.id === hoverId.value) ?? null)

function measure(): void {
  const el = anchorRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  anchor.value = { x: r.left + r.width / 2, y: r.top + r.height / 2, halfHeight: r.height / 2 }
  paneWidth.value = el.closest<HTMLElement>('.pane')?.clientWidth ?? window.innerWidth
  // Preview sits to the right of the ring unless that would run off-screen.
  flipPreview.value = anchor.value.x + RING_R_MAX + RING_SLOT_D + 300 > window.innerWidth
}

function scheduleOpen(): void {
  if (castable.value.length === 0) return
  emit('active', true)
  clearTimers()
  openTimer = setTimeout(() => {
    measure()
    open.value = true
  }, OPEN_DELAY_MS)
}

function scheduleClose(): void {
  clearTimers()
  closeTimer = setTimeout(() => {
    open.value = false
    hoverId.value = null
    emit('active', false)
  }, CLOSE_DELAY_MS)
}

function closeNow(): void {
  clearTimers()
  open.value = false
  hoverId.value = null
  emit('active', false)
}

function cast(skill: PromptSkill): void {
  closeNow()
  emit('cast', skill.id)
}

/** Keyboard: ↓ from the button opens and focuses the first slot; arrows walk
 *  the slots; digits cast directly; Esc closes and returns focus. */
function onAnchorKeydown(e: KeyboardEvent): void {
  if (e.key !== 'ArrowDown' || castable.value.length === 0) return
  e.preventDefault()
  clearTimers()
  measure()
  open.value = true
  void nextTick(() => focusSlot(0))
}

function focusSlot(index: number): void {
  const items = menuRef.value?.querySelectorAll<HTMLElement>('[data-slot]')
  if (!items || items.length === 0) return
  const i = ((index % items.length) + items.length) % items.length
  items[i].focus()
  hoverId.value = items[i].dataset.skillId ?? null
}

function onMenuKeydown(e: KeyboardEvent): void {
  const items = Array.from(menuRef.value?.querySelectorAll<HTMLElement>('[data-slot]') ?? [])
  const current = items.findIndex((el) => el === document.activeElement)
  if (e.key === 'Escape') {
    e.preventDefault()
    closeNow()
    anchorRef.value?.querySelector('button')?.focus()
    return
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault()
    focusSlot(current + 1)
    return
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault()
    focusSlot(current - 1)
    return
  }
  if (/^[1-9]$/.test(e.key)) {
    const skill = castable.value[Number(e.key) - 1]
    if (skill) {
      e.preventDefault()
      cast(skill)
    }
  }
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeNow()
}

/** Escape has to work while focus is anywhere, so the listener is on window —
 *  guarded because a test may replace `window` with a spread copy, which drops
 *  the prototype's listener methods (TerminalPane.fileDrop.test.ts does). */
function bindEscape(on: boolean): void {
  const w: Window | undefined = globalThis.window
  const fn = on ? w?.addEventListener : w?.removeEventListener
  if (typeof fn !== 'function') return
  fn.call(w, 'keydown', onWindowKeydown as EventListener)
}

watch(open, bindEscape)

onBeforeUnmount(() => {
  clearTimers()
  bindEscape(false)
})

defineExpose({ closeNow })
</script>

<template>
  <span
    ref="anchorRef"
    class="ps-anchor"
    @mouseenter="scheduleOpen"
    @mouseleave="scheduleClose"
    @keydown="onAnchorKeydown"
  >
    <slot />
  </span>

  <Teleport to="body">
    <div
      v-if="open"
      ref="menuRef"
      class="ps-menu"
      :class="{ list: asList }"
      role="menu"
      :aria-label="$t('pane.terminal.skill-picker.label')"
      :style="{ left: `${anchor.x}px`, top: `${asList ? anchor.y + anchor.halfHeight : anchor.y}px` }"
      @mouseenter="clearTimers()"
      @mouseleave="scheduleClose"
      @keydown="onMenuKeydown"
    >
      <!-- Ring layout -->
      <template v-if="!asList">
        <div class="ps-bridge" :style="bridgeStyle" aria-hidden="true" />
        <button
          v-for="(slot, i) in slots"
          :key="slot.skill.id"
          data-slot
          :data-skill-id="slot.skill.id"
          type="button"
          class="ps-slot"
          role="menuitem"
          :aria-label="slot.skill.name"
          :style="{ transform: `translate(calc(-50% + ${slot.x}px), calc(-50% + ${slot.y}px))` }"
          @mouseenter="hoverId = slot.skill.id"
          @focus="hoverId = slot.skill.id"
          @click="cast(slot.skill)"
        >
          <PromptSkillIcon :name="slot.skill.icon" />
          <span class="ps-key">{{ i + 1 }}</span>
          <span class="ps-name">{{ slot.skill.name }}</span>
        </button>

        <div v-if="previewSkill" class="ps-preview" :style="previewStyle">
          <div class="ps-pv-title">
            <PromptSkillIcon :name="previewSkill.icon" />
            <span>{{ previewSkill.name }}</span>
          </div>
          <div class="ps-pv-body">{{ previewSkill.prompt }}</div>
          <div class="ps-pv-meta">
            <span v-if="previewSkill.isDefault">{{
              previewSkill.maxTurns > 0
                ? $t('pane.terminal.skill-picker.max-turns', { n: previewSkill.maxTurns })
                : $t('pane.terminal.skill-picker.unlimited')
            }}</span>
            <span v-else>{{ $t('pane.terminal.skill-picker.send-once') }}</span>
            <span v-if="previewSkill.isDefault">{{ $t('pane.terminal.skill-picker.is-default') }}</span>
          </div>
        </div>
      </template>

      <!-- List layout: narrow panes and long skill lists -->
      <template v-else>
        <div class="ps-list-head">{{ $t('pane.terminal.skill-picker.label') }}</div>
        <button
          v-for="(skill, i) in castable"
          :key="skill.id"
          data-slot
          :data-skill-id="skill.id"
          type="button"
          class="ps-row"
          role="menuitem"
          :aria-label="skill.name"
          @mouseenter="hoverId = skill.id"
          @focus="hoverId = skill.id"
          @click="cast(skill)"
        >
          <PromptSkillIcon :name="skill.icon" />
          <span class="ps-row-text">
            <span class="ps-row-title">
              <span class="ps-row-name">{{ skill.name }}</span>
              <span class="ps-row-meta">{{
                skill.maxTurns > 0 ? `×${skill.maxTurns}` : ''
              }}</span>
            </span>
            <span class="ps-row-desc" v-truncate>{{ skill.description || skill.prompt }}</span>
          </span>
          <span class="ps-key-inline">{{ i + 1 }}</span>
        </button>
      </template>

      <div v-if="!asList && !previewSkill" class="ps-foot" :style="footStyle">
        <span class="ps-foot-hint">{{ $t('pane.terminal.skill-picker.hint') }}</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ps-anchor {
  position: relative;
  display: inline-flex;
}

/* The menu is fixed to the anchor's bottom center; slots position themselves
   around that origin, so the header's overflow can never clip them. */
.ps-menu {
  position: fixed;
  width: 0;
  height: 0;
  z-index: var(--z-popover);
}

/* Hover bridge between the button and the ring. Behind everything else in
   the menu's stacking context, so it can never steal a slot's hover. */
.ps-bridge {
  position: absolute;
  left: 0;
  top: 0;
  transform: translateX(-50%);
  z-index: -1;
  clip-path: polygon(calc(50% - 22px) 0, calc(50% + 22px) 0, 100% 100%, 0 100%);
}

.ps-slot {
  position: absolute;
  left: 0;
  top: 0;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-popover);
  color: var(--text-primary);
  cursor: pointer;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out);
}
.ps-slot:hover,
.ps-slot:focus-visible {
  outline: none;
  border-color: var(--success-fg);
  color: var(--success-fg);
  background: var(--success-subtle);
}
.ps-key {
  position: absolute;
  right: 3px;
  bottom: 1px;
  font-size: 8px;
  font-weight: 700;
  color: var(--text-muted);
}
.ps-name {
  position: absolute;
  top: calc(100% + 5px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 9.5px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: var(--radius-xs);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  color: var(--text-bright);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--motion-fast) linear;
}
.ps-slot:hover .ps-name,
.ps-slot:focus-visible .ps-name {
  opacity: 1;
}

.ps-preview {
  position: absolute;
  top: 0;
  width: 296px;
  max-height: 220px;
  overflow-y: auto;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-popover);
  display: flex;
  flex-direction: column;
}
.ps-pv-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-2xs);
  font-weight: 700;
  color: var(--success-fg);
  margin-bottom: 4px;
}
.ps-pv-body {
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--text-primary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.ps-pv-meta {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--border-muted);
  display: flex;
  gap: 10px;
  font-size: 9.5px;
  color: var(--text-muted);
}
/* Footer row under the ring: the "point at a skill" nudge while nothing is
   hovered, plus the settings link. Positioned from the radius, not pinned. */
.ps-foot {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.ps-foot-hint {
  font-size: var(--font-3xs);
  color: var(--text-muted);
  background: var(--bg-overlay);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-xs);
  padding: 2px 8px;
}

/* List layout */
.ps-menu.list {
  width: 282px;
  height: auto;
  border-radius: var(--radius-md);
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  box-shadow: var(--shadow-popover);
  overflow: hidden;
  transform: translate(-24px, 8px);
}
.ps-list-head {
  font-size: var(--font-3xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  padding: 7px 12px 5px;
}
.ps-row {
  display: flex;
  gap: 9px;
  align-items: flex-start;
  width: 100%;
  padding: 7px 12px;
  background: none;
  border: none;
  border-left: 2px solid transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}
.ps-row:hover,
.ps-row:focus-visible {
  outline: none;
  background: var(--bg-hover);
  border-left-color: var(--success-fg);
}
.ps-row-text {
  flex: 1;
  min-width: 0;
}
.ps-row-title {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ps-row-name {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-bright);
}
.ps-row:hover .ps-row-name {
  color: var(--success-fg);
}
.ps-row-meta,
.ps-key-inline {
  font-size: 9px;
  color: var(--text-secondary);
}
.ps-row-desc {
  display: block;
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

</style>
