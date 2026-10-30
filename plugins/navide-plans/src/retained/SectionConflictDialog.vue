<script setup lang="ts">
// Shown when a section the user was editing changed on disk in the meantime
// (planStore's `sectionConflict`). Both versions stay on screen until the user
// picks one; the version not kept is then shown on its own, with a copy
// button, until the user closes it, so a choice never makes text vanish
// silently. Nothing here writes: the parent performs the chosen write.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SectionConflict } from './planStore'

const props = defineProps<{ conflict: SectionConflict; saving?: boolean }>()
const emit = defineEmits<{
  (e: 'keep-mine'): void
  (e: 'keep-theirs'): void
  (e: 'close'): void
}>()
const { t } = useI18n()

/** Which side lost, once the parent reports the chosen write went through. */
const discarded = ref<'mine' | 'theirs' | null>(null)
const copied = ref<'mine' | 'theirs' | null>(null)

const mineText = computed(() => props.conflict.mine)
const theirsText = computed(() => props.conflict.theirs ?? '')

async function copy(side: 'mine' | 'theirs'): Promise<void> {
  try {
    await navigator.clipboard.writeText(side === 'mine' ? mineText.value : theirsText.value)
    copied.value = side
  } catch {
    copied.value = null
  }
}

/** Called by the parent after the chosen side was applied. */
function showDiscarded(side: 'mine' | 'theirs'): void {
  discarded.value = side
  copied.value = null
}

defineExpose({ showDiscarded })
</script>

<template>
  <div class="scd-overlay">
    <div class="scd-dialog" role="dialog" aria-modal="true" :aria-label="t('pane.plans.conflict-title')">
      <template v-if="discarded === null">
        <h2>{{ t('pane.plans.conflict-title') }}</h2>
        <p class="scd-note">{{ t('pane.plans.conflict-body') }}</p>
        <p class="scd-anchor">{{ conflict.anchor }}</p>
        <div class="scd-sides">
          <section class="scd-side" data-side="mine">
            <header>
              <span>{{ t('pane.plans.conflict-mine') }}</span>
              <button v-if="mineText" type="button" @click="void copy('mine')">
                {{ copied === 'mine' ? t('pane.plans.conflict-copied') : t('pane.plans.conflict-copy') }}
              </button>
            </header>
            <textarea v-if="mineText" readonly :value="mineText" />
            <p v-else class="scd-empty">{{ t('pane.plans.conflict-mine-delete') }}</p>
          </section>
          <section class="scd-side" data-side="theirs">
            <header>
              <span>{{ t('pane.plans.conflict-theirs') }}</span>
              <button v-if="conflict.theirs !== null" type="button" @click="void copy('theirs')">
                {{ copied === 'theirs' ? t('pane.plans.conflict-copied') : t('pane.plans.conflict-copy') }}
              </button>
            </header>
            <textarea v-if="conflict.theirs !== null" readonly :value="theirsText" />
            <p v-else class="scd-empty">{{ t('pane.plans.conflict-theirs-deleted') }}</p>
          </section>
        </div>
        <div class="scd-actions">
          <button type="button" class="scd-keep-theirs" :disabled="saving" @click="emit('keep-theirs')">
            {{ t('pane.plans.conflict-keep-theirs') }}
          </button>
          <button type="button" class="scd-keep-mine scd-primary" :disabled="saving" @click="emit('keep-mine')">
            {{ t('pane.plans.conflict-keep-mine') }}
          </button>
        </div>
      </template>
      <template v-else>
        <h2>{{ t('pane.plans.conflict-discarded-title') }}</h2>
        <p class="scd-note">{{ t('pane.plans.conflict-discarded-body') }}</p>
        <section class="scd-side" :data-side="discarded">
          <header>
            <span>{{ discarded === 'mine' ? t('pane.plans.conflict-mine') : t('pane.plans.conflict-theirs') }}</span>
            <button v-if="(discarded === 'mine' ? mineText : theirsText)" type="button" @click="void copy(discarded)">
              {{ copied === discarded ? t('pane.plans.conflict-copied') : t('pane.plans.conflict-copy') }}
            </button>
          </header>
          <textarea v-if="(discarded === 'mine' ? mineText : theirsText)" readonly :value="discarded === 'mine' ? mineText : theirsText" />
          <p v-else class="scd-empty">
            {{ discarded === 'mine' ? t('pane.plans.conflict-mine-delete') : t('pane.plans.conflict-theirs-deleted') }}
          </p>
        </section>
        <div class="scd-actions">
          <button type="button" class="scd-close scd-primary" @click="emit('close')">{{ t('pane.plans.conflict-close') }}</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.scd-overlay { position: fixed; inset: 0; z-index: 40; display: grid; place-items: start center; padding-top: 8vh; background: rgb(0 0 0 / 35%); }
.scd-dialog { display: grid; gap: 8px; width: min(920px, calc(100vw - 32px)); max-height: 84vh; overflow: auto; padding: 14px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-base); color: var(--text-primary); box-shadow: 0 14px 40px rgb(0 0 0 / 35%); }
.scd-dialog h2 { margin: 0; font-size: 15px; }
.scd-note { margin: 0; color: var(--text-muted); font-size: var(--font-sm); }
.scd-anchor { margin: 0; font-size: var(--font-sm); font-weight: 650; overflow-wrap: anywhere; }
.scd-sides { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 10px; }
.scd-side { display: grid; gap: 4px; min-width: 0; }
.scd-side header { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: var(--font-xs); font-weight: 650; }
.scd-side textarea { box-sizing: border-box; width: 100%; min-height: 220px; resize: vertical; padding: 8px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-subtle); color: var(--text-primary); font: var(--font-xs) / 1.45 var(--font-mono, monospace); }
.scd-empty { margin: 0; padding: 8px; border: 1px dashed var(--border-default); border-radius: 6px; color: var(--text-muted); font-size: var(--font-sm); }
.scd-actions { display: flex; justify-content: flex-end; gap: 8px; }
.scd-dialog button { border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-muted); color: var(--text-primary); cursor: pointer; font: inherit; font-size: var(--font-xs); padding: 4px 12px; }
.scd-dialog button:disabled { cursor: default; opacity: 0.6; }
.scd-dialog button.scd-primary { border-color: var(--accent-focus); color: var(--accent-fg); }
</style>
