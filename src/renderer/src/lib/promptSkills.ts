// Prompt skills: the reusable one-shot instructions a CLI pane's ∞ button can
// cast. Each skill is one WHOLE prompt — skills are mutually exclusive, never
// concatenated (see .agent-team/plans/prompt-prompt-skills_70c667.html).
//
// Storage lives in the unified settings store under PROMPT_SKILLS_SETTING_KEY.
// The default skill's prompt is mirrored back to LOOP_PROMPT_SETTING_KEY on
// every save, so a downgrade to a build that predates skills still finds a
// usable loop prompt where it expects one.
import { DEFAULT_LOOP_PROMPT, LOOP_PROMPT_SETTING_KEY } from './loopPrompt'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { i18n } from '@navide/plugin-ui/foundation'
import { PROMPT_SKILL_SEED, seedText } from './promptSkillSeed'

export const PROMPT_SKILLS_SETTING_KEY = 'prompt-skills'

/** Built-in icon NAMES, not SVG strings: the drawing can change without
 *  touching a user's stored skills. Drawn by PromptSkillIcon.vue, which owns
 *  one path per name — the two lists must stay in step. */
export const PROMPT_SKILL_ICONS = [
  'advance',
  'green',
  'scan',
  'doc',
  'refactor',
  'edit',
  'bug',
  'test',
  'rocket',
  'shield',
  'bolt',
  'sparkle',
  'branch',
  'database',
  'terminal',
  'globe',
  'chart',
  'clock',
  'lock',
  'package',
  'question',
  'list',
  'eye',
  'star',
] as const
export type PromptSkillBuiltinIcon = (typeof PROMPT_SKILL_ICONS)[number]

/** A skill's icon is EITHER a builtin name above OR one character the user
 *  typed (an emoji, usually). Kept as a plain string rather than a union so a
 *  build that predates custom icons still reads the field instead of dropping
 *  the skill; `asIcon` is what keeps the value to those two shapes. */
export type PromptSkillIcon = string

/** Identifier shape of a builtin name. A value matching this that is NOT in
 *  the list is a name from a newer build, so it collapses instead of being
 *  drawn as text. Two characters minimum — every builtin is longer than that,
 *  and it leaves a single letter free to be a custom icon. */
const BUILTIN_ICON_NAME_RE = /^[a-z][a-z0-9-]+$/

export function isBuiltinPromptSkillIcon(value: string): value is PromptSkillBuiltinIcon {
  return (PROMPT_SKILL_ICONS as readonly string[]).includes(value)
}

/** Split into user-perceived characters, so a ZWJ sequence (👩‍💻) or a flag
 *  counts as one. Intl.Segmenter is present in Electron; the spread is a
 *  fallback for a test environment that lacks it. */
function graphemes(value: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (!Segmenter) return [...value]
  const segmenter = new Segmenter(undefined, { granularity: 'grapheme' })
  return Array.from(segmenter.segment(value), (s) => s.segment)
}

/** The single character a custom icon renders, or null when there is none to
 *  take. One grapheme only: a longer string would overflow the ring's slot, so
 *  a paste of several emoji keeps the first. */
export function normalizeCustomIcon(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  return graphemes(trimmed)[0] ?? null
}

/** The custom character this icon draws, or null when it names a builtin. */
export function promptSkillIconGlyph(icon: string): string | null {
  return isBuiltinPromptSkillIcon(icon) ? null : icon
}

export interface PromptSkill {
  id: string
  name: string
  icon: PromptSkillIcon
  description: string
  /** The whole injected instruction. LOOP_DONE_INSTRUCTION is appended at
   *  injection time, exactly as it is for the legacy single prompt. */
  prompt: string
  /** Per-skill resume text; empty means fall back to the global setting. */
  resumePrompt: string
  /** Stop the loop after this many turns. 0 means unlimited (today's behavior). */
  maxTurns: number
  category: string
  enabled: boolean
  /** Which skill a plain click on ∞ casts. Exactly one skill carries it, and
   *  it is the only one that runs as a loop (see isLoopSkill). */
  isDefault: boolean
}

/** The skill a fresh install starts with — the legacy loop prompt, verbatim. */
export function builtinPromptSkills(legacyPrompt = DEFAULT_LOOP_PROMPT): PromptSkill[] {
  return [
    {
      id: PROMPT_SKILL_SEED.id,
      name: seedText('name', i18n.global.locale.value),
      icon: PROMPT_SKILL_SEED.icon,
      description: seedText('description', i18n.global.locale.value),
      prompt: legacyPrompt,
      resumePrompt: '',
      maxTurns: 0,
      category: PROMPT_SKILL_SEED.category,
      enabled: true,
      isDefault: true,
    },
  ]
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asIcon(value: unknown): PromptSkillIcon {
  if (typeof value !== 'string') return 'advance'
  if (isBuiltinPromptSkillIcon(value)) return value
  // Identifier-shaped but unknown: a builtin this build cannot draw (a skill
  // written by a newer one). Fall back rather than render its first letter.
  if (BUILTIN_ICON_NAME_RE.test(value)) return 'advance'
  return normalizeCustomIcon(value) ?? 'advance'
}

function asTurns(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

function skillIdStem(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'skill'
  )
}

/** Slugify `name` into an id that doesn't collide with `taken`. Non-ASCII
 *  names (the common case here) leave nothing to slugify, hence the `skill`
 *  stem plus a counter. */
export function nextSkillId(taken: readonly string[], name: string): string {
  const stem = skillIdStem(name)
  if (!taken.includes(stem)) return stem
  for (let i = 2; ; i += 1) {
    const candidate = `${stem}-${i}`
    if (!taken.includes(candidate)) return candidate
  }
}

/** The id for a prompt someone just created: the slug plus 6 random hex.
 *  Prompts sync across devices by id, and the slug alone ('skill', 'skill-2')
 *  is what two devices would both pick. Only for new prompts — an existing id
 *  never changes, since that would sync as a delete plus an add. */
export function newSkillId(taken: readonly string[], name: string): string {
  const stem = skillIdStem(name)
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(3))
    const suffix = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    const candidate = `${stem}-${suffix}`
    if (!taken.includes(candidate)) return candidate
  }
}

/** Coerce whatever is in the settings store into a valid skill list.
 *
 *  Guarantees the rest of the app relies on: at least one skill, every id
 *  unique and non-empty, and exactly one `isDefault`. A stored list that is
 *  missing/!Array/empty falls back to the builtin seeded from `legacyPrompt`
 *  — that is the one-time migration off LOOP_PROMPT_SETTING_KEY. */
export function normalizePromptSkills(raw: unknown, legacyPrompt = DEFAULT_LOOP_PROMPT): PromptSkill[] {
  if (!Array.isArray(raw) || raw.length === 0) return builtinPromptSkills(legacyPrompt)
  const ids: string[] = []
  const skills: PromptSkill[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const prompt = asString(e.prompt)
    if (!prompt.trim()) continue // a skill with nothing to send is not a skill
    const name = asString(e.name).trim() || i18n.global.t('settings.prompts.untitled-name')
    const rawId = asString(e.id).trim()
    const id = rawId && !ids.includes(rawId) ? rawId : nextSkillId(ids, name)
    ids.push(id)
    skills.push({
      id,
      name,
      icon: asIcon(e.icon),
      description: asString(e.description),
      prompt,
      resumePrompt: asString(e.resumePrompt),
      maxTurns: asTurns(e.maxTurns),
      category: asString(e.category, 'custom'),
      enabled: e.enabled !== false,
      isDefault: e.isDefault === true,
    })
  }
  if (skills.length === 0) return builtinPromptSkills(legacyPrompt)
  // Exactly one default: keep the first one flagged, else promote the first
  // enabled skill (a disabled default would leave a plain ∞ click with nothing
  // to cast).
  const flagged = skills.findIndex((s) => s.isDefault && s.enabled)
  const chosen = flagged >= 0 ? flagged : Math.max(0, skills.findIndex((s) => s.enabled))
  return skills.map((s, i) => ({ ...s, isDefault: i === chosen }))
}

/** Read the skill list, migrating from the legacy single prompt on first run. */
export function loadPromptSkills(): PromptSkill[] {
  const legacy = settingsGet(LOOP_PROMPT_SETTING_KEY, DEFAULT_LOOP_PROMPT)
  return normalizePromptSkills(settingsGet<unknown>(PROMPT_SKILLS_SETTING_KEY, null), legacy)
}

/** Persist the list, mirroring the default skill's prompt to the legacy key. */
export function savePromptSkills(skills: readonly PromptSkill[]): PromptSkill[] {
  const normalized = normalizePromptSkills(skills as unknown)
  settingsSet(PROMPT_SKILLS_SETTING_KEY, normalized)
  settingsSet(LOOP_PROMPT_SETTING_KEY, defaultPromptSkill(normalized).prompt)
  return normalized
}

/** Only the default skill runs as a LOOP (badge, auto-continue, turn cap).
 *  Every other skill is a plain one-shot prompt: sent once, then done. */
export function isLoopSkill(skill: PromptSkill): boolean {
  return skill.isDefault
}

/** The skill a plain ∞ click casts. Never null: normalize guarantees one. */
export function defaultPromptSkill(skills: readonly PromptSkill[]): PromptSkill {
  return skills.find((s) => s.isDefault) ?? skills[0]
}

/** Look up by id, falling back to the default skill when the id is unknown
 *  (a stale pane can hold the id of a skill the user has since deleted). */
export function resolvePromptSkill(skills: readonly PromptSkill[], id: string | null | undefined): PromptSkill {
  if (!id) return defaultPromptSkill(skills)
  return skills.find((s) => s.id === id) ?? defaultPromptSkill(skills)
}

/** Skills offered by the ∞ picker: enabled only, default first. */
export function castablePromptSkills(skills: readonly PromptSkill[]): PromptSkill[] {
  const enabled = skills.filter((s) => s.enabled)
  return enabled.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

/* ── Ring geometry ──────────────────────────────────────────────────────────
 * The ∞ picker lays its slots on an arc centered on straight-down. Radius is
 * SOLVED from the slot count rather than fixed: neighbours sit STEP_DEG apart,
 * so the chord between two centers is 2·R·sin(step/2), and requiring that
 * chord to be one slot wide plus a gap gives R. One slot then hugs the button
 * while five fan out far enough not to touch — a fixed radius did the
 * opposite, floating a lone slot 74px away for no reason.
 */

/** Slot diameter and the visual gap kept between two neighbours. */
export const RING_SLOT_D = 40
export const RING_SLOT_GAP = 12
/** Closest a slot may sit to the button, and the furthest the ring may push
 *  out before it stops reading as attached to it. */
export const RING_R_MIN = 46
export const RING_R_MAX = 92
/** Angle between neighbours, and the widest fan allowed. A wider step pulls a
 *  small ring IN: the radius solved from the chord shrinks faster than the arc
 *  spreads, so two slots keep the same left/right span but sit closer to the
 *  button — the gap the cursor has to cross is what made them hard to hit. */
export const RING_STEP_DEG = 56
export const RING_SPAN_MAX_DEG = 160
/** Above this many skills the ring is replaced by the list layout. */
export const RING_MAX_SLOTS = 5

export interface RingGeometry {
  radius: number
  /** Degrees between neighbours (0 for a single slot). */
  step: number
  /** Angle of the first slot; 90° is straight down. */
  start: number
}

export function ringGeometry(count: number): RingGeometry {
  if (count <= 1) return { radius: RING_R_MIN, step: 0, start: 90 }
  const span = Math.min(RING_SPAN_MAX_DEG, RING_STEP_DEG * (count - 1))
  const step = span / (count - 1)
  const chord = RING_SLOT_D + RING_SLOT_GAP
  const needed = chord / (2 * Math.sin((step * Math.PI) / 360))
  return {
    radius: Math.min(RING_R_MAX, Math.max(RING_R_MIN, needed)),
    step,
    start: 90 - span / 2,
  }
}

/** Slot center offsets from the ring origin (the button's center, so every
 *  slot is the same distance from what the eye reads as the middle).
 *
 *  Index 0 is the LEFTMOST slot: the list arrives default-first and the digit
 *  keys are 1..n, so reading order has to run left-to-right like every other
 *  menu. Angles are measured from the +x axis, which walks right-to-left, so
 *  the arc is traversed backwards here. */
export function ringSlotOffsets(count: number): { x: number; y: number }[] {
  const { radius, step, start } = ringGeometry(count)
  return Array.from({ length: count }, (_, i) => {
    const rad = ((180 - start - step * i) * Math.PI) / 180
    return { x: Math.cos(rad) * radius, y: Math.sin(rad) * radius }
  })
}
