<script setup lang="ts">
// Frame, numbered key and caption shared by every Settings → Help mock
// screenshot. The picture itself is drawn by whatever sits in the default
// slot; this component only supplies the surround, so a mock never has to
// restate the border, the ①②③ key or the caption typography.
//
// The legend arrives as data rather than as slotted markup: slot content
// carries the CALLER's scope id, so list styling declared here would not
// reach it.
//
// `shot` names a real screenshot on dl.navide.dev/help/ (see
// lib/helpScreenshots.ts). The mock stays on screen until that image has
// loaded and comes back if it fails, so offline or unpublished figures read
// exactly as before and a broken image is never shown.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { helpScreenshotUrl } from '../../lib/helpScreenshots'

const props = defineProps<{
  /** One-line explanation printed under the picture. */
  caption: string
  /** Optional key: one row per marked region, in mark order. */
  legend?: { mark: string; label: string; text: string }[]
  /** Optional screenshot id in the help manifest. */
  shot?: string
}>()

const { locale } = useI18n()
const shotUrl = computed(() => {
  if (!props.shot) return null
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return null
  return helpScreenshotUrl(props.shot, String(locale.value))
})
const loaded = ref(false)
const failed = ref(false)
watch(shotUrl, () => {
  loaded.value = false
  failed.value = false
})
</script>

<template>
  <figure class="mk-fig">
    <div v-show="!loaded" class="mk-fig-frame"><slot /></div>
    <img
      v-if="shotUrl && !failed"
      v-show="loaded"
      class="mk-fig-shot"
      :src="shotUrl"
      :alt="caption"
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      draggable="false"
      @load="loaded = true"
      @error="failed = true; loaded = false"
    />
    <ol v-if="legend?.length" class="mk-fig-legend">
      <li v-for="item in legend" :key="item.mark">
        <span class="mk-fig-mark">{{ item.mark }}</span>
        <span><strong>{{ item.label }}</strong> — {{ item.text }}</span>
      </li>
    </ol>
    <figcaption class="mk-fig-cap">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.mk-fig {
  margin: 2px 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 0;
}

/* The mock's own type scale. Everything inside sizes itself in `em`, so the
   whole picture shrinks with the dialog instead of overflowing it. */
.mk-fig-frame {
  font-size: var(--font-2xs);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  padding: 0.9em;
  min-width: 0;
  overflow: hidden;
}

.mk-fig-shot {
  display: block;
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.mk-fig-legend {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--font-xs);
  line-height: 1.55;
  color: var(--text-secondary);
}
.mk-fig-legend li {
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.mk-fig-mark {
  flex: none;
  color: var(--accent-fg);
  font-size: var(--font-sm);
}
.mk-fig-legend strong { color: var(--text-primary); }

.mk-fig-cap {
  font-size: var(--font-xs);
  line-height: 1.55;
  color: var(--text-muted);
}
</style>
