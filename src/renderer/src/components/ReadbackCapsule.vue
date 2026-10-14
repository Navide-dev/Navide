<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import type { ReadbackLine } from '../composables/useVoiceReadback'

// The read-aloud pill, shown while a readback line is being spoken. A line
// about one pane sits at the bottom of that pane (like VoiceCapsule); a merged
// line about several sits at the bottom of the window.

const props = defineProps<{ state: ReadbackLine | null }>()
const emit = defineEmits<{ stop: [] }>()
const { t } = useI18n()

const rect = ref<{ left: number; top: number; width: number } | null>(null)
let frame = 0

function measure(): void {
  const ids = props.state?.paneIds ?? []
  const el = ids.length === 1 ? document.querySelector(`[data-pane-id="${CSS.escape(ids[0])}"]`) : null
  if (!el) {
    rect.value = null
    return
  }
  const r = el.getBoundingClientRect()
  rect.value = { left: r.left, top: r.bottom, width: r.width }
}

function tick(): void {
  measure()
  frame = requestAnimationFrame(tick)
}

watch(
  () => props.state !== null,
  (shown) => {
    cancelAnimationFrame(frame)
    if (shown) tick()
  },
  { immediate: true },
)
onBeforeUnmount(() => cancelAnimationFrame(frame))

const style = computed(() => {
  if (!rect.value) return { left: '50%', top: 'calc(100% - 24px)' }
  return {
    left: `${rect.value.left + rect.value.width / 2}px`,
    top: `${rect.value.top - 12}px`,
    maxWidth: `${Math.max(160, rect.value.width - 24)}px`,
  }
})
</script>

<template>
  <div v-if="state" class="readback-capsule" :style="style" role="status" aria-live="polite">
    <span class="rc-wave" aria-hidden="true">▂▅▇▅▂</span>
    <span v-truncate class="rc-text">{{ state.text }}</span>
    <span class="rc-kbd">{{ t('voice.readback.esc-stop') }}</span>
    <button type="button" class="rc-stop" :aria-label="t('voice.readback.stop')" @click="emit('stop')">✕</button>
  </div>
</template>

<style scoped>
.readback-capsule {
  position: fixed;
  z-index: 60;
  transform: translate(-50%, -100%);
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: var(--font-xs);
  white-space: nowrap;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}
.rc-wave {
  flex-shrink: 0;
  letter-spacing: 1px;
  color: var(--accent-emphasis);
}
.rc-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rc-kbd {
  flex-shrink: 0;
  padding: 0 6px;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
}
.rc-stop {
  flex-shrink: 0;
  padding: 1px 8px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  cursor: pointer;
}
.rc-stop:hover { color: var(--text-primary); border-color: var(--accent-emphasis); }
</style>
