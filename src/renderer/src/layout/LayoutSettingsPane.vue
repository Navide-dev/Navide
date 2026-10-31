<script setup lang="ts">
// The Layout tab: every region of the shell, editable in one place.
//
// Moving a view is done here rather than by dragging it (a shell-level drag
// would collide with the pane drag that spawns a window). Each row therefore
// carries its own destination picker, and a slot that cannot render a view
// never appears in it.
import { computed } from 'vue'
import { useLayoutStore } from './useLayoutStore'
import { LAYOUT_PRESETS, SLOT_LIMITS, type SlotId } from './slots'
import { isMovable, moveTargetsFor, viewById, type ViewDescriptor } from './viewRegistry'
import SettingsSection from '../components/settings/SettingsSection.vue'
import ActionButtonsSection from './ActionButtonsSection.vue'

const {
  layout,
  setSlotSize,
  setSlotCollapsed,
  setActiveView,
  slotOf,
  moveView,
  hideView,
  showView,
  setChrome,
  resetLayout,
  applyPreset,
  canCollapse,
} = useLayoutStore()

/** Reading order, top to bottom then left to right — not the collapse order. */
const SLOT_ORDER: readonly SlotId[] = ['up', 'left', 'right', 'down']

const slotLabelKey = (id: SlotId): string => `layout.slot.${id}`

function rowsFor(id: SlotId): ViewDescriptor[] {
  return layout.value.slots[id].views
    .map((v) => viewById(v))
    .filter((v): v is ViewDescriptor => !!v)
}

const hiddenRows = computed(() =>
  layout.value.hidden.map((v) => viewById(v)).filter((v): v is ViewDescriptor => !!v)
)

/** A view with no other home shows why instead of an empty picker. */
function targets(viewId: string): SlotId[] {
  return moveTargetsFor(viewId, slotOf(viewId))
}

function onSize(id: SlotId, raw: string): void {
  const n = parseInt(raw, 10)
  if (Number.isFinite(n)) setSlotSize(id, n)
}
</script>

<template>
  <div class="ls">

    <!-- A page section, not a card: the one section-heading style, with the
         preset buttons right under it. -->
    <SettingsSection class="ls-presets-section" :label="$t('layout.presets')">
      <div class="ls-presets">
        <button v-for="p in LAYOUT_PRESETS" :key="p.id" class="nv-btn nv-btn--sm ls-preset" @click="applyPreset(p.id)">
          {{ $t(p.labelKey) }}
        </button>
      </div>
    </SettingsSection>

    <section v-for="id in SLOT_ORDER" :key="id" class="ls-slot">
      <header class="ls-slot-hdr">
        <h2 class="ls-slot-name">{{ $t(slotLabelKey(id)) }}</h2>
        <label class="ls-size">
          {{ $t(id === 'up' || id === 'down' ? 'layout.height' : 'layout.width') }}
          <input
            type="number"
            class="nv-input ls-size-input"
            :min="SLOT_LIMITS[id].min"
            :max="SLOT_LIMITS[id].max"
            :value="layout.slots[id].size"
            :disabled="!layout.slots[id].views.length"
            @change="onSize(id, ($event.target as HTMLInputElement).value)"
          />
        </label>
        <label class="ls-toggle">
          <input
            type="checkbox"
            :checked="layout.slots[id].collapsed"
            :disabled="!canCollapse(id)"
            @change="setSlotCollapsed(id, ($event.target as HTMLInputElement).checked)"
          />
          {{ $t('layout.collapsed') }}
        </label>
      </header>

      <p v-if="!layout.slots[id].views.length" class="ls-empty">{{ $t('layout.empty-slot') }}</p>

      <ul v-else class="ls-views">
        <li v-for="v in rowsFor(id)" :key="v.id" class="ls-view">
          <!-- The region's shown view carries a small accent dot, not a
               selection fill: every row reads the same, the dot says which
               one the region shows. -->
          <button
            class="ls-view-name"
            :class="{ active: layout.slots[id].active === v.id }"
            :title="$t('layout.make-active')"
            :aria-pressed="layout.slots[id].active === v.id"
            @click="setActiveView(id, v.id)"
          >
            <span class="ls-view-dot" aria-hidden="true"></span>
            {{ $t(v.titleKey) }}
          </button>
          <select
            class="nv-select ls-move"
            :disabled="!targets(v.id).length"
            :value="''"
            @change="moveView(v.id, ($event.target as HTMLSelectElement).value as SlotId)"
          >
            <option value="" disabled>
              {{ targets(v.id).length ? $t('layout.move-to') : $t('layout.pinned') }}
            </option>
            <option v-for="t in targets(v.id)" :key="t" :value="t">{{ $t(slotLabelKey(t)) }}</option>
          </select>
          <!-- A view pinned to one slot can still be removed from the layout;
               what it cannot do is move. `isMovable` is the removal gate
               because only a view with somewhere to belong can be restored. -->
          <button
            class="nv-btn nv-btn--sm ls-hide"
            :disabled="!isMovable(v.id)"
            :aria-label="$t('layout.remove')"
            :title="$t('layout.remove')"
            @click="hideView(v.id)"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>
          </button>
        </li>
      </ul>
    </section>

    <!-- main is a region too; showing it fixed is the honest way to say so. -->
    <section class="ls-slot ls-slot--fixed">
      <header class="ls-slot-hdr">
        <h2 class="ls-slot-name">{{ $t('layout.slot.main') }}</h2>
        <span class="ls-fixed-note">{{ $t('layout.main-fixed') }}</span>
      </header>
      <ul class="ls-views">
        <li class="ls-view">
          <span class="ls-view-name is-static">{{ $t('label.cli-stage') }}</span>
        </li>
      </ul>
    </section>

    <section v-if="hiddenRows.length" class="ls-slot">
      <header class="ls-slot-hdr">
        <h2 class="ls-slot-name">{{ $t('layout.hidden') }}</h2>
      </header>
      <ul class="ls-views">
        <li v-for="v in hiddenRows" :key="v.id" class="ls-view">
          <span class="ls-view-name is-static">{{ $t(v.titleKey) }}</span>
          <button class="nv-btn nv-btn--sm ls-restore" @click="showView(v.id)">{{ $t('layout.restore') }}</button>
        </li>
      </ul>
    </section>

    <section class="ls-slot">
      <header class="ls-slot-hdr">
        <h2 class="ls-slot-name">{{ $t('layout.chrome') }}</h2>
      </header>
      <!-- Not offered: the window is frameless with the macOS traffic lights
           drawn over the content, so hiding this bar strands them on top of
           whatever is in the left panel. -->
      <label class="ls-toggle is-fixed">
        <input type="checkbox" checked disabled />
        {{ $t('layout.titlebar') }}
        <span class="ls-fixed-note">{{ $t('layout.titlebar-fixed') }}</span>
      </label>
      <label class="ls-toggle">
        <input
          type="checkbox"
          :checked="layout.chrome.statusbar"
          @change="setChrome('statusbar', ($event.target as HTMLInputElement).checked)"
        />
        {{ $t('layout.statusbar') }}
        <!-- The announcements, clock, agent overview and memory popovers are
             all opened from the status bar; hiding it puts them out of reach. -->
        <span class="ls-fixed-note">{{ $t('layout.statusbar-note') }}</span>
      </label>
    </section>

    <div class="ls-actions">
      <button class="nv-btn nv-btn--sm ls-reset" @click="resetLayout">{{ $t('layout.reset') }}</button>
      <span class="ls-reset-note">{{ $t('layout.reset-note') }}</span>
    </div>

    <ActionButtonsSection />
  </div>
</template>

<style scoped>
.ls { display: flex; flex-direction: column; gap: 18px; max-width: 720px; }
/* The page header already sets the gap above the first section. */
.ls > .ls-presets-section { margin-top: 0; }

.ls-slot {
  border: 1px solid var(--border-muted);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--bg-subtle);
}
.ls-slot--fixed { opacity: 0.75; }
.ls-slot-hdr {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
/* Inside its card a region's name is the card's first row title, not a
   second section-heading style. */
.ls-slot-name { margin: 0; margin-right: auto; font-size: var(--font-row-title); font-weight: 600; color: var(--text-bright); }
.ls-fixed-note { font-size: var(--font-2xs); color: var(--text-secondary); }

.ls-size { display: flex; align-items: center; gap: 6px; font-size: var(--font-2xs); color: var(--text-secondary); }
.ls-size-input { width: 76px; height: var(--control-h-md); box-sizing: border-box; }
/* Disabled keeps its frame and readable text, so an empty slot's size still
   reads as a field. A pinned view's picker looks like every other picker and
   takes the shared disabled look of .nv-select. */
.ls-size-input:disabled { opacity: 1; background: transparent; color: var(--text-secondary); cursor: default; }

.ls-toggle.is-fixed { opacity: 0.7; cursor: default; }
.ls-toggle {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  font-size: var(--font-2xs);
  color: var(--text-secondary);
  cursor: pointer;
}

.ls-empty { margin: 0; font-size: var(--font-2xs); color: var(--text-secondary); }
/* A toggle's note is its own line under the label, not a run-on after it. */
.ls-toggle .ls-fixed-note { flex-basis: 100%; padding-left: 19px; }

/* Views are rows of the card, hairlines between. */
.ls-views { list-style: none; margin: 0 -14px; padding: 0; display: flex; flex-direction: column; }
.ls-view { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; padding: 4px 14px; border-top: 1px solid var(--border-muted); }

.ls-view-name {
  flex: 1 1 180px;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  height: 28px;
  padding: 0 6px;
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-sm);
  text-align: left;
  cursor: pointer;
}
.ls-view-name:hover:not(.is-static) { background: var(--bg-hover); }
.ls-view-name.is-static { cursor: default; padding-left: 20px; }
/* The view the region shows: an accent dot, same weight and no fill. */
.ls-view-dot {
  flex: 0 0 6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
}
.ls-view-name.active .ls-view-dot { background: var(--accent-fg); }

.ls-move,
.ls-hide,
.ls-restore,
.ls-reset,
.ls-preset {
  height: var(--control-h-md);
  box-sizing: border-box;
}
/* Every picker is one width, so the Remove buttons line up; a row too narrow
   for both wraps the controls under the view name. */
/* At least one width, so the Remove buttons line up; a longer label
   ("Verschieben nach …") sizes the picker to its longest option instead of
   cutting it, never wider than the row. */
.ls-move { flex: 0 0 auto; width: auto; min-width: 168px; max-width: 100%; text-overflow: ellipsis; }
/* "Pinned here" is the view's real place, not a placeholder: shown in the
   secondary text colour at full strength while the picker is disabled. */
.ls-move:disabled { opacity: 1; color: var(--text-secondary); cursor: default; }
/* Remove is a small icon button, named by its aria-label and tooltip. */
.ls-hide {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-h-md);
  padding: 0;
}

.ls-presets { display: flex; gap: 8px; flex-wrap: wrap; }

.ls-actions { display: flex; align-items: center; gap: 10px; }
.ls-reset-note { font-size: var(--font-2xs); color: var(--text-secondary); }
</style>
