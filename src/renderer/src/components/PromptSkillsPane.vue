<script setup lang="ts">
// Settings → Prompts. The configuration half of prompt skills; the ∞ button's
// picker is the casting half. Layout and styling follow SkillsPane so the two
// integration pages read as one surface: toolbar, filter chips + search, a
// scrolling card grid, and a drawer for the selected item.
//
// This tab renders inside `.s-body--bleed`, which carries no gutter of its own
// — the pane supplies the 22px page gutter itself, exactly as .skills-pane
// does. Without it the content sits flush against the modal edge.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import PromptSkillIcon from './PromptSkillIcon.vue'
import { usePromptSkills } from '../composables/usePromptSkills'
import { reorderByIds } from '../lib/paneOrder'
import {
  PROMPT_SKILL_ICONS,
  newSkillId,
  normalizeCustomIcon,
  promptSkillIconGlyph,
  type PromptSkill,
  type PromptSkillBuiltinIcon as IconName,
} from '../lib/promptSkills'

const { t } = useI18n()
const { skills, save } = usePromptSkills()

const query = ref('')
const categoryFilter = ref('all')
const selectedId = ref<string | null>(null)
/** Working copy of the selected skill — edits commit on change, so the drawer
 *  never writes a half-typed prompt into the store. */
const draft = ref<PromptSkill | null>(null)

const categories = computed(() => {
  const counts = new Map<string, number>()
  for (const s of skills.value) counts.set(s.category, (counts.get(s.category) ?? 0) + 1)
  return [...counts.entries()].map(([key, count]) => ({ key, count }))
})

// Cards follow the ∞ picker's order: the default skill is always cast first,
// so it is pinned first here too, and the rest keep their saved order.
const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  const ordered = [...skills.value].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  return ordered.filter((s) => {
    if (categoryFilter.value !== 'all' && s.category !== categoryFilter.value) return false
    if (!q) return true
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.prompt.toLowerCase().includes(q)
    )
  })
})

/** Drag reordering works on the full list only — a filtered view hides
 *  neighbours, so a drop there would land somewhere the user cannot see. */
const canReorder = computed(() => categoryFilter.value === 'all' && !query.value.trim())
const dragId = ref('')
const dragOverId = ref('')

function onDragStart(e: DragEvent, skill: PromptSkill): void {
  if (!canReorder.value || skill.isDefault) { e.preventDefault(); return }
  dragId.value = skill.id
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', skill.id)
  }
}
function onDragOver(e: DragEvent, skill: PromptSkill): void {
  if (!dragId.value || dragId.value === skill.id || skill.isDefault) return
  e.preventDefault()
  dragOverId.value = skill.id
}
function onDragLeave(skill: PromptSkill): void {
  if (dragOverId.value === skill.id) dragOverId.value = ''
}
function onDrop(skill: PromptSkill): void {
  const from = dragId.value
  dragId.value = ''
  dragOverId.value = ''
  if (!canReorder.value || !from || skill.isDefault) return
  const next = [...skills.value]
  if (reorderByIds(next, from, skill.id)) save(next)
}

/** Re-read the drawer's working copy from the store. Actions that go through
 *  save() (default / enable / duplicate) change fields the drawer also shows,
 *  and without this the drawer keeps rendering the pre-save copy — e.g. "Set
 *  as default" stays clickable after it already took effect. */
function syncDraft(): void {
  const found = skills.value.find((s) => s.id === selectedId.value)
  draft.value = found ? { ...found } : null
}

watch(selectedId, syncDraft)

function commit(): void {
  const d = draft.value
  if (!d) return
  save(skills.value.map((s) => (s.id === d.id ? { ...d } : s)))
  syncDraft()
}

function createSkill(): void {
  const ids = skills.value.map((s) => s.id)
  const name = t('settings.prompts.new-name')
  const skill: PromptSkill = {
    id: newSkillId(ids, name),
    name,
    icon: 'edit',
    description: '',
    // A skill with an empty prompt is dropped by normalize, so seed it with the
    // name — the user replaces it in the drawer that opens right away.
    prompt: name,
    resumePrompt: '',
    maxTurns: 0,
    category: 'custom',
    enabled: true,
    isDefault: false,
  }
  save([...skills.value, skill])
  selectedId.value = skill.id
}

function duplicate(skill: PromptSkill): void {
  const copy: PromptSkill = {
    ...skill,
    id: newSkillId(skills.value.map((s) => s.id), `${skill.id}-copy`),
    name: t('settings.prompts.copy-name', { name: skill.name }),
    isDefault: false,
  }
  save([...skills.value, copy])
  selectedId.value = copy.id
}

function remove(skill: PromptSkill): void {
  if (skills.value.length <= 1) return // normalize would resurrect the builtin
  if (selectedId.value === skill.id) selectedId.value = null
  save(skills.value.filter((s) => s.id !== skill.id))
}

function makeDefault(skill: PromptSkill): void {
  save(skills.value.map((s) => ({ ...s, isDefault: s.id === skill.id })))
  syncDraft()
}

function toggleEnabled(skill: PromptSkill): void {
  save(skills.value.map((s) => (s.id === skill.id ? { ...s, enabled: !s.enabled } : s)))
  syncDraft()
}

const ICONS = PROMPT_SKILL_ICONS as readonly IconName[]

/** Custom icons: anything that is not a builtin name is one character the user
 *  typed. The field mirrors the draft so switching skills — or clicking a
 *  builtin — clears whatever was in it. */
const customIcon = ref('')
watch(
  () => draft.value?.icon,
  (icon) => {
    customIcon.value = icon ? (promptSkillIconGlyph(icon) ?? '') : ''
  },
  { immediate: true },
)

function applyCustomIcon(): void {
  const d = draft.value
  if (!d) return
  const glyph = normalizeCustomIcon(customIcon.value)
  if (!glyph) {
    // Nothing usable typed: put the field back rather than blanking the icon.
    customIcon.value = promptSkillIconGlyph(d.icon) ?? ''
    return
  }
  customIcon.value = glyph // a multi-emoji paste keeps only the first
  d.icon = glyph
  commit()
}
</script>

<template>
  <div class="prompts-pane" data-settings-section="prompts">
    <!-- ── Toolbar ──────────────────────────────────────────────────────── -->
    <div class="prompts-toolbar">
      <div>
        <h2>{{ t('settings.prompts.title') }}</h2>
        <p>{{ t('settings.prompts.intro') }}</p>
      </div>
      <button type="button" class="primary" @click="createSkill">
        {{ t('settings.prompts.new') }}
      </button>
    </div>

    <!-- ── Filter bar ───────────────────────────────────────────────────── -->
    <div class="prompts-filterbar">
      <div class="prompts-chips" role="group" :aria-label="t('settings.prompts.filter-label')">
        <button
          type="button"
          class="prompts-chip"
          :class="{ on: categoryFilter === 'all' }"
          :aria-pressed="categoryFilter === 'all'"
          @click="categoryFilter = 'all'"
        >{{ t('settings.prompts.all') }}<span class="count">{{ skills.length }}</span></button>
        <button
          v-for="c in categories"
          :key="c.key"
          type="button"
          class="prompts-chip"
          :class="{ on: categoryFilter === c.key }"
          :aria-pressed="categoryFilter === c.key"
          @click="categoryFilter = c.key"
        >{{ c.key }}<span class="count">{{ c.count }}</span></button>
      </div>
      <input
        v-model="query"
        class="prompts-search"
        type="search"
        :placeholder="t('settings.prompts.search')"
      />
    </div>

    <!-- ── Body: card grid + optional drawer ────────────────────────────── -->
    <div class="prompts-body" :class="{ 'drawer-open': draft !== null }">
      <div class="prompts-main">
        <div v-if="visible.length" class="prompts-cards">
          <button
            v-for="skill in visible"
            :key="skill.id"
            type="button"
            class="prompt-card"
            :data-skill-id="skill.id"
            :class="{ active: selectedId === skill.id, off: !skill.enabled, 'drag-over': dragOverId === skill.id }"
            :draggable="canReorder && !skill.isDefault"
            @dragstart="onDragStart($event, skill)"
            @dragover="onDragOver($event, skill)"
            @dragenter="onDragOver($event, skill)"
            @dragleave="onDragLeave(skill)"
            @drop.prevent="onDrop(skill)"
            @dragend="dragId = ''; dragOverId = ''"
            @click="selectedId = selectedId === skill.id ? null : skill.id"
          >
            <span class="prompt-card-head">
              <PromptSkillIcon :name="skill.icon" />
              <strong v-truncate>{{ skill.name }}</strong>
              <span v-if="skill.isDefault" class="prompt-badge default">{{
                t('settings.prompts.default-badge')
              }}</span>
            </span>
            <span class="prompt-card-desc" v-truncate>{{ skill.description || skill.prompt }}</span>
            <span class="prompt-card-tags">
              <span class="pchip">{{ skill.category }}</span>
              <span v-if="skill.isDefault" class="pchip">{{
                skill.maxTurns > 0
                  ? t('settings.prompts.turns', { n: skill.maxTurns })
                  : t('settings.prompts.turns-unlimited')
              }}</span>
              <span v-else class="pchip">{{ t('settings.prompts.send-once') }}</span>
              <span v-if="!skill.enabled" class="pchip warn">{{ t('settings.prompts.disabled') }}</span>
            </span>
          </button>
        </div>
        <div v-else class="prompts-state">
          <strong>{{ t('settings.prompts.empty') }}</strong>
        </div>
      </div>

      <!-- ── Drawer ─────────────────────────────────────────────────────── -->
      <aside v-if="draft" class="prompts-drawer">
        <div class="drawer-head">
          <div class="drawer-title">
            <PromptSkillIcon :name="draft.icon" />
            <h3>{{ draft.name }}</h3>
            <span v-if="draft.isDefault" class="prompt-badge default">{{
              t('settings.prompts.default-badge')
            }}</span>
            <span v-if="!draft.enabled" class="prompt-badge warn">{{
              t('settings.prompts.disabled')
            }}</span>
          </div>
          <button
            type="button"
            class="drawer-close"
            :aria-label="t('action.close')"
            @click="selectedId = null"
          >✕</button>
        </div>

        <div class="drawer-section">
          <label>
            <span>{{ t('settings.prompts.name') }}</span>
            <input v-model="draft.name" @change="commit" />
          </label>
          <label>
            <span>{{ t('settings.prompts.description') }}</span>
            <input v-model="draft.description" @change="commit" />
          </label>
          <div class="drawer-field">
            <span>{{ t('settings.prompts.icon') }}</span>
            <div class="icon-row">
              <button
                v-for="name in ICONS"
                :key="name"
                type="button"
                class="icon-btn"
                :class="{ on: draft.icon === name }"
                :aria-label="name"
                :title="name"
                :aria-pressed="draft.icon === name"
                @click="draft.icon = name; commit()"
              ><PromptSkillIcon :name="name" /></button>
              <input
                v-model="customIcon"
                class="icon-btn icon-custom"
                :class="{ on: !!promptSkillIconGlyph(draft.icon) }"
                :aria-label="t('settings.prompts.icon-custom')"
                :title="t('settings.prompts.icon-custom-hint')"
                placeholder="🙂"
                @change="applyCustomIcon"
                @blur="applyCustomIcon"
              />
            </div>
          </div>
        </div>

        <div class="drawer-section">
          <h4>{{ t('settings.prompts.prompt') }}</h4>
          <textarea v-model="draft.prompt" class="prompt-body" rows="8" spellcheck="false" @change="commit"></textarea>
        </div>

        <div class="drawer-section">
          <h4>{{ t('settings.prompts.advanced') }}</h4>
          <p v-if="!draft.isDefault" class="drawer-hint">{{ t('settings.prompts.send-once-hint') }}</p>
          <label v-if="draft.isDefault">
            <span>{{ t('settings.prompts.resume') }}</span>
            <input
              v-model="draft.resumePrompt"
              :placeholder="t('settings.prompts.resume-placeholder')"
              @change="commit"
            />
          </label>
          <div class="drawer-grid">
            <label v-if="draft.isDefault">
              <span>{{ t('settings.prompts.max-turns') }}</span>
              <input v-model.number="draft.maxTurns" type="number" min="0" @change="commit" />
            </label>
            <label>
              <span>{{ t('settings.prompts.category') }}</span>
              <input v-model="draft.category" @change="commit" />
            </label>
          </div>
        </div>

        <div class="drawer-actions secondary">
          <button type="button" :disabled="draft.isDefault" @click="makeDefault(draft)">
            {{ t('settings.prompts.set-default') }}
          </button>
          <button type="button" @click="toggleEnabled(draft)">
            {{ draft.enabled ? t('settings.prompts.disable') : t('settings.prompts.enable') }}
          </button>
          <button type="button" @click="duplicate(draft)">
            {{ t('settings.prompts.duplicate') }}
          </button>
        </div>
        <p class="drawer-hint">{{ t('settings.prompts.hint') }}</p>
        <div class="drawer-actions">
          <button type="button" class="danger" :disabled="skills.length <= 1" @click="remove(draft)">
            {{ t('settings.prompts.delete') }}
          </button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
/* Mirrors .skills-pane: the bleed tab has no gutter, so the pane owns it. */
.prompts-pane {
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
  padding: 16px 22px 18px;
  gap: 12px;
  overflow: hidden;
  color: var(--text-primary);
}

button,
input,
textarea {
  font: inherit;
}
button {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-muted);
  color: var(--text-primary);
  padding: 5px 9px;
  cursor: pointer;
}
button:hover:not(:disabled) {
  background: var(--bg-elevated);
  color: var(--text-bright);
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
button.primary {
  background: var(--accent-emphasis);
  border-color: var(--accent-emphasis);
  color: var(--text-on-emphasis);
}
button.danger {
  color: var(--danger-fg);
}
button:focus-visible,
input:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--accent-emphasis);
  outline-offset: 2px;
}
input,
textarea {
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--bg-base);
  color: var(--text-primary);
  padding: 7px 8px;
}
textarea {
  resize: vertical;
  line-height: var(--lh-base);
}
input:focus,
textarea:focus {
  border-color: var(--accent-emphasis);
}

/* ── Toolbar ──────────────────────────────────────────────────────────── */
.prompts-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.prompts-toolbar h2 {
  margin: 0;
  font-size: 15px;
  color: var(--text-bright);
}
.prompts-toolbar p {
  margin: 3px 0 0;
  max-width: 62ch;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}

/* ── Filter bar ───────────────────────────────────────────────────────── */
.prompts-filterbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.prompts-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.prompts-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  font-size: var(--font-2xs);
}
.prompts-chip.on {
  background: var(--bg-elevated);
  color: var(--text-bright);
  font-weight: 600;
}
.prompts-chip .count {
  font-size: var(--font-3xs);
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}
.prompts-search {
  flex: 1;
  min-width: 140px;
  max-width: 260px;
  margin-left: auto;
}

/* ── Body ─────────────────────────────────────────────────────────────── */
.prompts-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-height: 0;
  flex: 1;
  gap: 12px;
}
.prompts-body.drawer-open {
  grid-template-columns: minmax(0, 1fr) minmax(300px, 380px);
}
.prompts-main {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
}
.prompts-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}
.prompts-state {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 18px 8px;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  text-align: center;
}
.prompts-state strong {
  color: var(--text-bright);
}

/* ── Card ─────────────────────────────────────────────────────────────── */
.prompt-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  padding: 9px 11px;
  text-align: left;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
  min-width: 0;
}
.prompt-card:hover:not(:disabled) {
  background: var(--bg-muted);
  border-color: var(--border-default);
}
.prompt-card.active {
  border-color: var(--accent-fg);
  background: var(--bg-muted);
}
.prompt-card[draggable='true'] {
  cursor: grab;
}
.prompt-card.drag-over {
  box-shadow: inset 0 0 0 2px var(--accent-focus);
}
.prompt-card.off {
  opacity: 0.55;
}
.prompt-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: var(--text-secondary);
}
.prompt-card-head strong {
  flex: 1;
  min-width: 0;
  font-size: var(--font-xs);
  color: var(--text-bright);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prompt-card-desc {
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.prompt-card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 2px;
}
.pchip {
  display: inline-block;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--font-3xs);
  font-weight: 600;
  border: 1px solid var(--border-muted);
  color: var(--text-secondary);
}
.pchip.warn {
  color: var(--attention-fg);
  border-color: color-mix(in srgb, var(--attention-fg) 45%, var(--border-muted));
}
.prompt-badge {
  border-radius: var(--radius-pill);
  padding: 2px 7px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
}
.prompt-badge.default {
  color: var(--attention-fg);
  background: color-mix(in srgb, var(--attention-fg) 12%, transparent);
}
.prompt-badge.warn {
  color: var(--text-secondary);
  background: var(--bg-muted);
}

/* ── Drawer ───────────────────────────────────────────────────────────── */
.prompts-drawer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px 16px;
  gap: 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
}
.drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.drawer-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  color: var(--text-secondary);
}
.drawer-title h3 {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-bright);
  overflow-wrap: anywhere;
}
.drawer-close {
  padding: 2px 7px;
  font-size: var(--font-xs);
  line-height: 1;
}
.drawer-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.drawer-section h4 {
  margin: 0;
  font-size: var(--font-3xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}
.drawer-section label,
.drawer-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.drawer-section label > span,
.drawer-field > span {
  font-size: var(--font-3xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
}
.drawer-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.prompt-body {
  min-height: 170px;
  font-family: var(--font-mono);
  font-size: var(--font-2xs);
}
.icon-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.icon-btn {
  width: var(--icon-btn-lg);
  height: var(--icon-btn-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--text-secondary);
}
.icon-btn.on {
  border-color: var(--success-fg);
  color: var(--success-fg);
  background: var(--success-subtle);
}
/* Same box as a builtin swatch, but it is an input: one character, centred.
   `display` is reset because .icon-btn sets flex, which an input must not be. */
.icon-custom {
  display: block;
  font-size: 15px;
  line-height: 1;
  text-align: center;
  padding: 0;
}
.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
.drawer-actions.secondary {
  justify-content: flex-start;
  margin-top: 0;
  flex-wrap: wrap;
}
.drawer-hint {
  margin: 0;
  font-size: 10.5px;
  color: var(--text-secondary);
  line-height: 1.4;
}

@media (max-width: 900px) {
  .prompts-pane {
    overflow-y: auto;
  }
  .prompts-body,
  .prompts-body.drawer-open {
    grid-template-columns: 1fr;
  }
  .prompts-main {
    overflow: visible;
  }
  .prompts-drawer {
    overflow: visible;
  }
  .drawer-grid {
    grid-template-columns: 1fr;
  }
}
</style>
