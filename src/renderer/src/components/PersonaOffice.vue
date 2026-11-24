<script setup lang="ts">
/** Persona mode: the stage drawn as an office. Each run group is a room, each
 *  pane a person at a desk whose pose says what the pane is doing.
 *
 *  Purely a view: it reads the rooms App passes in and emits what the user
 *  picked. The terminals stay mounted (hidden) underneath, so leaving persona
 *  mode is instant and no terminal reflows.
 *
 *  Colours are the app's own: the status badge colours (user overrides
 *  included, via statusBadgeColorKey), the focus ring, the group palette and
 *  the agent identity colours. They are resolved from CSS variables through a
 *  probe element, so a theme switch repaints the office too. */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { paneStatusLabelText, type PaneStatusValue } from '../lib/paneStatusLabel'
import { PANE_STATUS_ORDER, STATUS_COLOR_PALETTE } from '../lib/statusBadgePalette'
import { statusBadgeColorKey } from '../composables/useStatusBadgePrefs'
import {
  attentionList,
  buildingAvailable,
  deskAt,
  deskLayout,
  deskPos,
  floorAlarm,
  lampOpacity,
  personaPose,
  roomCounts,
  WALK_MS,
  type PersonaPerson,
  type PersonaRoom,
} from '../lib/persona/personaModel'
import {
  drawBang,
  drawBoard,
  drawClock,
  drawCoffeeMachine,
  drawHead,
  drawNameTag,
  drawPlant,
  drawPoster,
  drawRack,
  drawRoom,
  drawRug,
  drawShelf,
  drawStation,
  drawWindow,
  lookFor,
  plotter,
  withAlpha,
  type PersonaPalette,
  type PersonaPose,
} from '../lib/persona/sprites'

const props = defineProps<{
  rooms: PersonaRoom[]
  activeRoomKey: string
  focusPaneId: string | null
  /** The question an awaiting pane is holding, read when its card opens. */
  questionFor?: (id: string) => string
}>()

const emit = defineEmits<{
  (e: 'select-room', key: string): void
  (e: 'focus-pane', id: string): void
  (e: 'back-to-grid', id: string): void
}>()

const { t } = useI18n()

const rootRef = ref<HTMLElement | null>(null)
const scrollRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const buildingRef = ref<HTMLCanvasElement | null>(null)
const probeRef = ref<HTMLElement | null>(null)

const showBuilding = ref(false)
const cardId = ref<string | null>(null)
const hoverFloor = ref<number | null>(null)
const widthPx = ref(800)
const buildingHeightPx = ref(600)
const now = ref(Date.now())

const activeRoom = computed<PersonaRoom | null>(() =>
  props.rooms.find((r) => r.key === props.activeRoomKey) ?? props.rooms[0] ?? null
)
const people = computed<PersonaPerson[]>(() => activeRoom.value?.people ?? [])
const heightPx = ref(600)
const layout = computed(() => deskLayout(people.value.length, widthPx.value, heightPx.value))
const attention = computed(() => (people.value.length > 8 ? attentionList(people.value) : []))
const canShowBuilding = computed(() => buildingAvailable(props.rooms))
const activeCounts = computed(() => roomCounts(people.value))
const cardPerson = computed(() => people.value.find((p) => p.id === cardId.value) ?? null)
const cardQuestion = computed(() => {
  const p = cardPerson.value
  return p && p.status === 'awaiting' ? props.questionFor?.(p.id) ?? '' : ''
})
const totalPeople = computed(() => props.rooms.reduce((n, r) => n + r.people.length, 0))

const buildingTotals = computed(() => {
  const all = props.rooms.flatMap((r) => r.people)
  const c = roomCounts(all)
  return { running: c.running, awaiting: c.awaiting, failing: c.failing, idle: c.total - c.running - c.awaiting - c.failing }
})

// ── Colours ────────────────────────────────────────────────────────────────

const statusColors = ref<Record<string, string>>({})
const tokens = ref({ awaiting: '#f0883e', attention: '#d29922', error: '#f85149', errorDeep: '#6f1f1f', focus: '#388bfd' })

/** Resolve a CSS colour expression (var(), color-mix()) to an rgb() string. */
function resolveColor(expr: string): string {
  const probe = probeRef.value
  if (!probe) return expr
  probe.style.color = ''
  probe.style.color = expr
  return getComputedStyle(probe).color || expr
}

function refreshColors(): void {
  const next: Record<string, string> = {}
  for (const s of PANE_STATUS_ORDER) next[s] = resolveColor(STATUS_COLOR_PALETTE[statusBadgeColorKey(s)].fg)
  statusColors.value = next
  tokens.value = {
    awaiting: next.awaiting,
    attention: resolveColor('var(--attention-fg)'),
    error: resolveColor('var(--danger-fg)'),
    errorDeep: resolveColor('var(--danger-deep)'),
    focus: resolveColor('var(--accent-focus)'),
  }
}

// statusBadgeColorKey reads the reactive prefs, so a user recolouring a status
// in Settings re-runs this.
watch(() => PANE_STATUS_ORDER.map((s) => statusBadgeColorKey(s)).join(), () => { refreshColors(); requestDraw() })

function paletteFor(status: PaneStatusValue): PersonaPalette {
  const tk = tokens.value
  return {
    status: statusColors.value[status] ?? tk.focus,
    awaiting: tk.awaiting,
    attention: tk.attention,
    error: tk.error,
    errorDeep: tk.errorDeep,
    focus: tk.focus,
    focusSoft: withAlpha(tk.focus, 0.6),
  }
}

// ── Motion ─────────────────────────────────────────────────────────────────

const reducedMotion = ref(false)
const paused = ref(false)
// Main reports window visibility over IPC: terminal panes disable background
// throttling, which pins document.hidden to false.
let windowVisible = true
let offWindowVisibility: (() => void) | undefined
let motionQuery: MediaQueryList | null = null
const lastPose = new Map<string, PersonaPose>()
const walkStart = new Map<string, number>()

function updatePaused(): void {
  paused.value = !windowVisible || document.hidden || !document.hasFocus()
  if (!paused.value) requestDraw()
}

function onMotionChange(): void {
  reducedMotion.value = !!motionQuery?.matches
  requestDraw()
}

// ── Drawing ────────────────────────────────────────────────────────────────

let rafId = 0
let lastDrawAt = 0
const FRAME_MS = 70

function animating(): boolean {
  return !reducedMotion.value && !paused.value
}

function requestDraw(): void {
  if (rafId) return
  rafId = requestAnimationFrame(tick)
}

function tick(ts: number): void {
  rafId = 0
  if (animating() && ts - lastDrawAt < FRAME_MS) {
    rafId = requestAnimationFrame(tick)
    return
  }
  lastDrawAt = ts
  now.value = Date.now()
  if (showBuilding.value) drawBuilding()
  else drawOffice()
  if (animating()) rafId = requestAnimationFrame(tick)
}

const ROOM_STYLES: { wall: string; floor: [string, string] }[] = [
  { wall: '#e9e2d3', floor: ['#cfd6de', '#c4ccd6'] },
  { wall: '#cfe5d2', floor: ['#d6d0c4', '#cbc4b6'] },
  { wall: '#d9dcf2', floor: ['#d3d6e0', '#c8ccd8'] },
  { wall: '#f2dccc', floor: ['#d8cfc6', '#cdc3b9'] },
]

function roomIndex(): number {
  return Math.max(0, props.rooms.findIndex((r) => r.key === activeRoom.value?.key))
}

function drawOffice(): void {
  const canvas = canvasRef.value
  const room = activeRoom.value
  if (!canvas || !room) return
  const L = layout.value
  const S = L.S
  const W = Math.ceil(widthPx.value / S)
  // At least the visible height, so a short room has no dead band below it.
  const H = Math.max(L.heightU, Math.ceil(heightPx.value / S))
  const pxW = Math.round(widthPx.value), pxH = H * S
  if (canvas.width !== pxW) canvas.width = pxW
  if (canvas.height !== pxH) canvas.height = pxH
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, pxW, pxH)
  const p = plotter(ctx, S)
  const ri = roomIndex()
  const style = ROOM_STYLES[ri % ROOM_STYLES.length]
  drawRoom(p, W, H, L.wallH, style.wall, style.floor)
  drawRug(p, 6, L.wallH + 6, W - 12, H - L.wallH - 10, room.color)
  // Furniture differs per room; the layout leans on the wall width.
  const wallItems = Math.max(1, Math.floor((W - 40) / 70))
  for (let i = 0; i < wallItems; i++) {
    const x = 24 + i * Math.floor((W - 48) / wallItems)
    const kind = (i + ri) % 4
    if (kind === 0) drawWindow(p, x, 6, 52, 30)
    else if (kind === 1) drawBoard(p, x, 8, 36, 26)
    else if (kind === 2) drawShelf(p, x, 6)
    else drawPoster(p, x, 8, room.color)
    if (i === 0 && ri % 2 === 1) drawRack(p, 4, 2)
  }
  drawClock(p, W - 22, 10)
  drawPlant(p, 2, L.wallH - 14)
  drawPlant(p, W - 14, L.wallH - 14)
  drawCoffeeMachine(p, W - 22, H - 36)

  const t = performance.now()
  const frame = animating() ? Math.floor(t / 400) : 0
  const list = people.value
  list.forEach((person, i) => {
    const { x, y } = deskPos(L, i)
    const pose = personaPose(person, now.value)
    const prev = lastPose.get(person.id)
    if (prev !== undefined && prev !== pose && !reducedMotion.value) walkStart.set(person.id, t)
    lastPose.set(person.id, pose)
    const ws = walkStart.get(person.id)
    let walk = 0
    if (ws !== undefined) {
      const k = (t - ws) / WALK_MS
      if (k >= 1 || reducedMotion.value) walkStart.delete(person.id)
      else walk = 1 - k
    }
    drawStation(ctx, S, x, y, lookFor(person.id, person.agentColor), pose, { ...paletteFor(person.status), status: dotColor(person) }, {
      frame: frame + i,
      selected: person.id === props.focusPaneId,
      walk,
      lamp: lampOpacity(person.status, t, !animating()),
      quota: person.quota ?? null,
      loginExpired: person.loginExpired,
      guarded: person.guarded,
    })
  })
  const tagSize = S >= 4 ? 14 : S === 3 ? 12 : 11
  list.forEach((person, i) => {
    const { x, y } = deskPos(L, i)
    const pose = personaPose(person, now.value)
    drawNameTag(ctx, S, x, y - (pose === 'raise' ? 7 : 2), person.name, { ...paletteFor(person.status), status: dotColor(person) }, {
      size: tagSize,
      selected: person.id === props.focusPaneId,
      mark: person.agentColor ?? null,
    })
  })
}

const FLOOR_H = 44
const BX = 20

/** Units-to-pixels for the building: the largest that fits both ways (the
 *  plotter snaps every rectangle to whole pixels, so a fractional scale stays
 *  crisp), between 1 and 3. */
function buildingScale(): number {
  const fitH = buildingHeightPx.value / ((props.rooms.length * FLOOR_H) + 60)
  const fitW = (widthPx.value - 340) / 560
  return Math.max(1, Math.min(3, fitH, fitW))
}

function buildingWidthU(S: number): number {
  return Math.floor((widthPx.value - 340) / S) - BX * 2
}

function drawBuilding(): void {
  const canvas = buildingRef.value
  if (!canvas) return
  const S = buildingScale()
  const BW = Math.max(200, buildingWidthU(S))
  const TOP = 24
  const pxW = Math.max(200, Math.round(widthPx.value - 320))
  const pxH = (TOP + props.rooms.length * FLOOR_H + 20) * S
  if (canvas.width !== pxW) canvas.width = pxW
  if (canvas.height !== pxH) canvas.height = pxH
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, pxW, pxH)
  const p = plotter(ctx, S)
  const tk = tokens.value
  p(BX - 6, TOP - 8, BW + 12, 5, '#5b4a3a')
  p(BX - 4, TOP - 3, BW + 8, props.rooms.length * FLOOR_H + 6, '#4a4f63')
  const nowTs = performance.now()
  props.rooms.forEach((room, f) => {
    const y = TOP + f * FLOOR_H
    const style = ROOM_STYLES[f % ROOM_STYLES.length]
    p(BX, y, BW, FLOOR_H - 3, style.wall)
    p(BX, y + FLOOR_H - 12, BW, 9, withAlpha(room.color, 0.25))
    if (room.key === activeRoom.value?.key || f === hoverFloor.value) {
      p(BX - 4, y - 2, BW + 8, 2, tk.focus); p(BX - 4, y + FLOOR_H - 3, BW + 8, 2, tk.focus)
      p(BX - 4, y, 2, FLOOR_H - 3, tk.focus); p(BX + BW + 2, y, 2, FLOOR_H - 3, tk.focus)
    }
    p(BX + 4, y + 4, 3, 13, room.color)
    ctx.fillStyle = '#20232f'
    ctx.font = `600 ${Math.max(11, 6 * S)}px -apple-system, "PingFang TC", sans-serif`
    ctx.textBaseline = 'middle'
    const floorNo = props.rooms.length - f
    ctx.fillText(`${t('persona.floor', { n: floorNo })} ${room.label}`, (BX + 10) * S, (y + 10.5) * S)
    ctx.font = `${Math.max(10, 5 * S)}px -apple-system, "PingFang TC", sans-serif`
    ctx.fillText(t('persona.people', { n: room.people.length }), (BX + 10) * S, (y + 30) * S)
    ctx.textBaseline = 'alphabetic'
    const startX = BX + 100
    const fit = Math.max(1, Math.floor((BW - 110) / 18))
    room.people.slice(0, fit).forEach((person, i) => {
      const hx = startX + i * 18, hy = y + 12
      const pose = personaPose(person, now.value)
      drawHead(p, hx, hy, lookFor(person.id, person.agentColor), { closed: pose === 'sleep', worried: pose === 'smoke' || pose === 'quota' || pose === 'unplugged' })
      p(hx + 1, hy + 11, 8, 3, statusColors.value[person.status] ?? tk.focus)
      if (pose === 'raise') drawBang(p, hx + 11, hy - 4, tk.awaiting)
    })
    if (room.people.length > fit) {
      ctx.fillStyle = '#20232f'
      ctx.fillText(`+${room.people.length - fit}`, (startX + fit * 18) * S, (y + 20) * S)
    }
    const alarm = floorAlarm(room.people)
    if (alarm) {
      const c = alarm === 'failing' ? tk.error : tk.awaiting
      const on = alarm === 'awaiting' ? lampOpacity('awaiting', nowTs, !animating()) : 1
      p(BX + BW + 6, y + 12, 8, 14, '#2a2d3a'); p(BX + BW + 7, y + 13, 6, 12, withAlpha(c, on)); p(BX + BW + 15, y + 15, 4, 8, withAlpha(c, 0.4 * on))
    }
  })
}

// ── Interaction ────────────────────────────────────────────────────────────

const cardPos = ref({ left: 0, top: 0 })

function openCard(id: string): void {
  cardId.value = id
  const i = people.value.findIndex((p) => p.id === id)
  if (i < 0) return
  const L = layout.value
  const { x, y } = deskPos(L, i)
  const scrollTop = scrollRef.value?.scrollTop ?? 0
  const left = (x + 44) * L.S
  cardPos.value = {
    left: Math.max(8, Math.min(widthPx.value - 320, left > widthPx.value - 320 ? x * L.S - 316 : left)),
    top: Math.max(8, y * L.S - 20 - scrollTop + (attention.value.length ? 0 : 0)),
  }
}

function personAtEvent(e: MouseEvent): PersonaPerson | null {
  const canvas = canvasRef.value
  if (!canvas) return null
  const r = canvas.getBoundingClientRect()
  const S = layout.value.S
  const i = deskAt(layout.value, people.value.length, (e.clientX - r.left) / S, (e.clientY - r.top) / S)
  return i >= 0 ? people.value[i] : null
}

function onCanvasClick(e: MouseEvent): void {
  const person = personAtEvent(e)
  if (person) openCard(person.id)
  else cardId.value = null
}

function onCanvasDblClick(e: MouseEvent): void {
  const person = personAtEvent(e)
  if (person) emit('focus-pane', person.id)
}

function onCanvasMove(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement
  el.style.cursor = personAtEvent(e) ? 'pointer' : 'default'
}

function floorAtEvent(e: MouseEvent): number | null {
  const canvas = buildingRef.value
  if (!canvas) return null
  const r = canvas.getBoundingClientRect()
  const S = buildingScale()
  const uy = (e.clientY - r.top) / S - 24
  const f = Math.floor(uy / FLOOR_H)
  return f >= 0 && f < props.rooms.length ? f : null
}

function onBuildingMove(e: MouseEvent): void {
  const f = floorAtEvent(e)
  if (f !== hoverFloor.value) { hoverFloor.value = f; requestDraw() }
  ;(e.currentTarget as HTMLElement).style.cursor = f === null ? 'default' : 'pointer'
}

function onBuildingClick(e: MouseEvent): void {
  const f = floorAtEvent(e)
  if (f === null) return
  enterRoom(props.rooms[f].key)
}

function enterRoom(key: string): void {
  showBuilding.value = false
  hoverFloor.value = null
  cardId.value = null
  emit('select-room', key)
}

const summaryRoom = computed(() => {
  const f = hoverFloor.value
  return f === null ? activeRoom.value : props.rooms[f] ?? null
})
const summaryCounts = computed(() => roomCounts(summaryRoom.value?.people ?? []))
const summaryAttention = computed(() => attentionList(summaryRoom.value?.people ?? []).slice(0, 4))

function waitedText(person: PersonaPerson): string {
  if (person.since === undefined) return ''
  const mins = Math.floor((now.value - person.since) / 60000)
  return mins < 1 ? t('persona.waited-under-minute') : t('persona.waited-minutes', { n: mins })
}

/** A person's status colour; an exhausted quota reads as the error colour. */
function dotColor(person: PersonaPerson): string {
  return person.quota === 'empty' ? tokens.value.error : statusColors.value[person.status] ?? tokens.value.focus
}

function personStatusText(person: PersonaPerson): string {
  if (person.quota === 'empty') return t('persona.quota-empty')
  return paneStatusLabelText(person.status)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (cardId.value) cardId.value = null
    else if (showBuilding.value) showBuilding.value = false
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

let resizeObserver: ResizeObserver | null = null
let themeObserver: MutationObserver | null = null

onMounted(() => {
  refreshColors()
  motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
  reducedMotion.value = !!motionQuery?.matches
  motionQuery?.addEventListener?.('change', onMotionChange)
  document.addEventListener('visibilitychange', updatePaused)
  window.addEventListener('blur', updatePaused)
  window.addEventListener('focus', updatePaused)
  offWindowVisibility = window.agentTeam?.onWindowVisibility?.((visible: boolean) => {
    windowVisible = visible
    updatePaused()
  })
  paused.value = document.hidden || !document.hasFocus()
  resizeObserver = new ResizeObserver(() => {
    const el = scrollRef.value ?? rootRef.value
    if (el) {
      widthPx.value = Math.max(320, el.clientWidth)
      heightPx.value = Math.max(200, el.clientHeight)
    }
    if (rootRef.value) buildingHeightPx.value = rootRef.value.clientHeight - 20
    requestDraw()
  })
  if (rootRef.value) resizeObserver.observe(rootRef.value)
  themeObserver = new MutationObserver(() => { refreshColors(); requestDraw() })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
  requestDraw()
})

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
  motionQuery?.removeEventListener?.('change', onMotionChange)
  document.removeEventListener('visibilitychange', updatePaused)
  window.removeEventListener('blur', updatePaused)
  window.removeEventListener('focus', updatePaused)
  offWindowVisibility?.()
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
})

watch(
  () => [props.rooms, props.activeRoomKey, props.focusPaneId, showBuilding.value, reducedMotion.value],
  () => { void nextTick(requestDraw) },
  { deep: true }
)
// The scroll area comes and goes with the building view, and the attention row
// above it changes its height: watch the element itself, not just the root.
watch(scrollRef, (el, old) => {
  if (old) resizeObserver?.unobserve(old)
  if (el) resizeObserver?.observe(el)
})
watch(() => props.activeRoomKey, () => { cardId.value = null })
watch(cardPerson, (p) => { if (!p) cardId.value = null })
</script>

<template>
  <div ref="rootRef" class="persona" tabindex="-1" @keydown="onKeydown">
    <span ref="probeRef" class="persona-probe" aria-hidden="true" />
    <!-- No tab strip of its own: the rooms ARE the stage tabs, switched from the
         existing tab bar. The plate and the building button sit in the scene. -->
    <div class="persona-tools">
      <button
        v-if="canShowBuilding"
        type="button"
        :class="['persona-tool', { on: showBuilding }]"
        :aria-pressed="showBuilding"
        :title="showBuilding ? $t('persona.building-back') : $t('persona.building')"
        :aria-label="showBuilding ? $t('persona.building-back') : $t('persona.building')"
        @click="showBuilding = !showBuilding; cardId = null"
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M3 1h10v14h-4v-3H7v3H3zM5 3v2h2V3zm4 0v2h2V3zM5 7v2h2V7zm4 0v2h2V7z" />
        </svg>
      </button>
    </div>

    <template v-if="!showBuilding">
      <div v-if="attention.length" class="persona-attn">
        <div class="t">{{ $t('persona.attention') }}<small>{{ $t('persona.attention-hint', { n: attention.length }) }}</small></div>
        <div class="list">
          <button
            v-for="person in attention"
            :key="person.id"
            type="button"
            :class="['ac', { err: person.status !== 'awaiting' }]"
            @click="openCard(person.id)"
            @dblclick="emit('focus-pane', person.id)"
          >
            <i class="dot" :style="{ background: dotColor(person) }" />
            <span><b>{{ person.name }}</b><em>{{ personStatusText(person) }}<template v-if="person.status === 'awaiting' && waitedText(person)"> · {{ waitedText(person) }}</template></em></span>
          </button>
        </div>
      </div>
      <div class="persona-office">
        <!-- Door plate: the room (stage tab) and its head count, on the wall. -->
        <div v-if="activeRoom" class="persona-plate">
          <span class="sw" :style="{ background: activeRoom.color }" />
          <b class="name">{{ activeRoom.label }}</b>
          <span class="n">
            {{ $t('persona.people', { n: activeCounts.total }) }} ·
            <em>{{ $t('persona.running', { n: activeCounts.running }) }}</em>
          </span>
          <span
            v-if="activeCounts.awaiting"
            class="bang"
            :title="$t('persona.awaiting-count', { n: activeCounts.awaiting })"
          >!{{ activeCounts.awaiting }}</span>
          <span
            v-if="activeCounts.failing"
            class="bang err"
            :title="$t('persona.failing-count', { n: activeCounts.failing })"
          >{{ activeCounts.failing }}</span>
        </div>
        <div ref="scrollRef" class="persona-scroll">
          <canvas
            ref="canvasRef"
            class="persona-canvas"
            role="img"
            :aria-label="$t('persona.canvas-label', { n: people.length })"
            @click="onCanvasClick"
            @dblclick="onCanvasDblClick"
            @mousemove="onCanvasMove"
          />
          <!-- The same people as buttons, for keyboard and screen readers. -->
          <ul class="persona-sr">
            <li v-for="person in people" :key="person.id">
              <button type="button" @click="openCard(person.id)">{{ person.name }} — {{ personStatusText(person) }}</button>
            </li>
          </ul>
          <div v-if="!people.length" class="persona-empty">{{ $t('persona.empty-room') }}</div>
        </div>
      </div>
      <div class="persona-legend" aria-hidden="true">
        <span><b>⌨</b>{{ $t('persona.legend-type') }}</span>
        <span><b :style="{ color: tokens.awaiting }">!</b>{{ $t('persona.legend-raise') }}</span>
        <span><b>☕</b>{{ $t('persona.legend-idle') }}</span>
        <span><b :style="{ color: tokens.error }">●</b>{{ $t('persona.legend-error') }}</span>
      </div>
      <div
        v-if="cardPerson"
        class="persona-card"
        role="dialog"
        :aria-label="cardPerson.name"
        :style="{ left: cardPos.left + 'px', top: cardPos.top + 'px', borderColor: dotColor(cardPerson) }"
      >
        <button type="button" class="x" :aria-label="$t('persona.close')" @click="cardId = null">×</button>
        <h5>
          <i v-if="cardPerson.agentColor" class="mark" :style="{ background: cardPerson.agentColor }" />
          {{ cardPerson.name }}
          <span class="vendor">{{ cardPerson.vendor }}</span>
        </h5>
        <div class="st">
          <i class="dot" :style="{ background: dotColor(cardPerson) }" />
          {{ personStatusText(cardPerson) }}<template v-if="waitedText(cardPerson)"> · {{ waitedText(cardPerson) }}</template>
        </div>
        <div v-if="cardPerson.quota && cardPerson.quota !== 'empty'" class="quota">{{ $t(`persona.quota-${cardPerson.quota}`) }}</div>
        <div v-if="cardPerson.loginExpired || cardPerson.guarded" class="flags">
          <span v-if="cardPerson.loginExpired" class="flag">{{ $t('pane.terminal.login-expired-badge') }}</span>
          <span v-if="cardPerson.guarded" class="flag">🛡 {{ $t('guard.pane.badge') }}</span>
        </div>
        <div v-if="cardQuestion" class="q" :style="{ color: tokens.awaiting }">{{ cardQuestion }}</div>
        <div class="btns">
          <button type="button" class="p" @click="emit('focus-pane', cardPerson.id)">{{ $t('persona.focus-pane') }}</button>
          <button type="button" @click="emit('back-to-grid', cardPerson.id)">{{ $t('persona.back-to-grid') }}</button>
        </div>
      </div>
    </template>

    <div v-else class="persona-building">
      <div class="persona-building-scroll">
        <canvas
          ref="buildingRef"
          class="persona-canvas"
          role="img"
          :aria-label="$t('persona.building-label', { rooms: rooms.length, n: totalPeople })"
          @mousemove="onBuildingMove"
          @mouseleave="hoverFloor = null; requestDraw()"
          @click="onBuildingClick"
        />
      </div>
      <div class="side">
        <div class="box">
          <h5>{{ $t('persona.building-title') }}</h5>
          <div class="row"><span><i class="k" :style="{ background: statusColors.running }" />{{ paneStatusLabelText('running') }}</span><b>{{ buildingTotals.running }}</b></div>
          <div class="row"><span><i class="k" :style="{ background: tokens.awaiting }" />{{ paneStatusLabelText('awaiting') }}</span><b>{{ buildingTotals.awaiting }}</b></div>
          <div class="row"><span><i class="k" :style="{ background: tokens.error }" />{{ $t('persona.failing') }}</span><b>{{ buildingTotals.failing }}</b></div>
          <div class="row"><span><i class="k" :style="{ background: statusColors.idle }" />{{ paneStatusLabelText('idle') }}</span><b>{{ buildingTotals.idle }}</b></div>
        </div>
        <div v-if="summaryRoom" class="box go" :style="{ borderColor: tokens.focus }">
          <h5><i class="k" :style="{ background: summaryRoom.color }" />{{ summaryRoom.label }}</h5>
          <div class="row"><span>{{ $t('persona.people', { n: summaryCounts.total }) }} · {{ $t('persona.running', { n: summaryCounts.running }) }}</span></div>
          <div
            v-for="person in summaryAttention"
            :key="person.id"
            class="row"
            :style="{ color: person.status === 'awaiting' ? tokens.awaiting : tokens.error }"
          ><span>{{ person.status === 'awaiting' ? '!' : '✗' }} {{ person.name }} · {{ personStatusText(person) }}</span></div>
          <button type="button" class="b" :style="{ background: tokens.focus }" @click="enterRoom(summaryRoom.key)">{{ $t('persona.enter-room') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.persona {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-canvas);
  z-index: 30;
  outline: none;
  overflow: hidden;
}
.persona-probe { position: absolute; width: 0; height: 0; overflow: hidden; }
.persona-tools {
  position: absolute;
  top: 10px;
  right: 12px;
  z-index: 3;
  display: flex;
  gap: 4px;
}
.persona-tool {
  width: 30px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-overlay);
  color: var(--text-secondary);
  cursor: pointer;
}
.persona-tool:hover { color: var(--text-primary); }
.persona-tool.on { border-color: var(--accent-focus); color: var(--accent-bright); }
.persona-office { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
.persona-plate {
  position: absolute;
  top: 10px;
  left: 12px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  border-radius: 6px;
  border: 2px solid #6c5a44;
  background: rgba(20, 22, 34, 0.88);
  color: #e6e8ef;
  font-size: var(--font-sm);
  white-space: nowrap;
}
.persona-plate .sw { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.persona-plate .n { font-size: var(--font-xs); color: #aab0c3; }
.persona-plate .n em { font-style: normal; color: var(--success-fg); font-weight: 600; }
.persona-plate .bang {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: 99px;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--warning-fg); color: #fff; font-weight: 800; font-size: var(--font-xs);
}
.persona-plate .bang.err { background: var(--danger-fg); }
.persona-attn {
  flex: none;
  padding-right: 56px !important;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-default);
  overflow-x: auto;
}
.persona-attn .t { flex: none; width: 84px; font-size: var(--font-sm); font-weight: 700; color: var(--warning-fg); line-height: 1.35; }
.persona-attn .t small { display: block; color: var(--text-muted); font-weight: 400; font-size: var(--font-xs); }
.persona-attn .list { display: flex; gap: 8px; }
.persona-attn .ac {
  flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 8px;
  background: var(--bg-muted); border: 1px solid var(--warning-fg); border-radius: 10px;
  color: var(--text-primary); cursor: pointer; text-align: left;
}
.persona-attn .ac.err { border-color: var(--danger-fg); }
.persona-attn .ac b { display: block; font-size: var(--font-sm); }
.persona-attn .ac em { font-style: normal; font-size: var(--font-xs); color: var(--warning-fg); }
.persona-attn .ac.err em { color: var(--danger-fg); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; }
.persona-scroll { position: relative; flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.persona-canvas { display: block; image-rendering: pixelated; }
.persona-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); margin: 0; padding: 0; }
.persona-empty { position: absolute; inset: 40% 0 auto; text-align: center; color: var(--text-muted); }
.persona-legend { position: absolute; left: 12px; bottom: 10px; display: flex; gap: 6px; pointer-events: none; flex-wrap: wrap; }
.persona-legend span { background: rgba(20, 22, 34, 0.86); color: #e6e8ef; border-radius: 8px; padding: 4px 9px; font-size: var(--font-xs); }
.persona-legend b { margin-right: 4px; }
.persona-card {
  position: absolute;
  width: 300px;
  margin-top: 90px;
  background: var(--bg-overlay);
  border: 2px solid var(--accent-focus);
  border-radius: 12px;
  padding: 12px 14px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45);
  color: var(--text-primary);
  font-size: var(--font-sm);
  z-index: 2;
}
.persona-card .x { position: absolute; right: 8px; top: 6px; border: none; background: none; color: var(--text-muted); font-size: 16px; cursor: pointer; }
.persona-card h5 { margin: 0 0 6px; font-size: var(--font-md); display: flex; gap: 8px; align-items: center; padding-right: 16px; }
.persona-card .mark { width: 4px; height: 16px; border-radius: 2px; }
.persona-card .vendor { font-size: var(--font-xs); color: var(--text-muted); font-weight: 400; }
.persona-card .st { display: flex; align-items: center; gap: 6px; }
.persona-card .quota { margin-top: 4px; color: var(--attention-fg); }
.persona-card .flags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.persona-card .flag {
  font-size: var(--font-3xs); font-weight: 600; color: var(--attention-fg);
  background: var(--attention-subtle); border: 1px solid var(--attention-muted);
  border-radius: var(--radius-xs); padding: 1px 6px;
}
.persona-card .q { background: var(--bg-muted); border-radius: 8px; padding: 8px 10px; margin: 8px 0 0; white-space: pre-wrap; max-height: 120px; overflow: auto; }
.persona-card .btns { display: flex; gap: 8px; margin-top: 10px; }
.persona-card .btns button { flex: 1; padding: 6px; border-radius: 8px; border: 1px solid var(--border-default); background: var(--bg-muted); color: var(--text-primary); cursor: pointer; }
.persona-card .btns button.p { background: var(--accent-emphasis); border-color: var(--accent-emphasis); color: #fff; font-weight: 700; }
.persona-building { position: relative; flex: 1; min-height: 0; display: flex; background: linear-gradient(#9fd4f2, #d8eef8 70%, #b9d9a8 70%); }
.persona-building-scroll { flex: 1; min-width: 0; overflow: auto; padding-top: 12px; }
.persona-building .side { flex: none; width: 300px; padding: 48px 16px 16px 0; display: flex; flex-direction: column; gap: 10px; }
.persona-building .box { background: rgba(20, 22, 34, 0.9); color: #e6e8ef; border-radius: 12px; padding: 12px 14px; font-size: var(--font-sm); }
.persona-building .box h5 { margin: 0 0 6px; font-size: var(--font-md); display: flex; align-items: center; }
.persona-building .row { display: flex; justify-content: space-between; padding: 3px 0; }
.persona-building .k { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
.persona-building .go { border: 2px solid; }
.persona-building .go .b { margin-top: 8px; width: 100%; border: none; color: #fff; font-weight: 700; border-radius: 8px; padding: 6px; cursor: pointer; }
</style>
