<script setup lang="ts">
export type LayoutMode = 'auto' | 'grid' | 'spotlight' | 'fullscreen' | 'persona'

defineProps<{ modelValue: LayoutMode }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: LayoutMode): void }>()

// [mode, glyph, tooltip KEY]. The key rather than the text: this array is
// evaluated once at setup, so a resolved string would freeze at whichever
// language was active then. `$t` in the template re-resolves on a switch.
const modes: [LayoutMode, string, string][] = [
  ['grid',       '⊞', 'label.view-mode-grid'],
  ['auto',       '◧', 'label.view-mode-sidebar'],
  ['spotlight',  '◎', 'label.view-mode-spotlight'],
  ['fullscreen', '⧉', 'label.view-mode-fullscreen'],
  // Glyph drawn in CSS (.persona-ico): no text glyph reads as "a person".
  ['persona',    '',  'label.view-mode-persona'],
]
</script>

<template>
  <div class="view-panel" role="toolbar" :aria-label="$t('label.view-mode-toolbar')">
    <button
      v-for="[mode, icon, titleKey] in modes"
      :key="mode"
      :class="['mode-btn', { active: modelValue === mode }]"
      :title="$t(titleKey)"
      :aria-pressed="modelValue === mode"
      @click="emit('update:modelValue', mode)"
    ><span v-if="mode === 'persona'" class="persona-ico" aria-hidden="true" /><template v-else>{{ icon }}</template></button>
  </div>
</template>

<style scoped>
.view-panel {
  display: flex;
  gap: 2px;
  background: var(--bg-overlay);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 3px;
  backdrop-filter: blur(4px);
}
.mode-btn {
  width: 28px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.1s, color 0.1s;
}
.mode-btn:hover {
  background: var(--bg-muted);
  color: var(--text-primary);
}
.persona-ico {
  width: 10px;
  height: 12px;
  background:
    radial-gradient(circle at 50% 50%, currentColor 2.6px, transparent 3px) 50% 0 / 10px 6px no-repeat,
    linear-gradient(currentColor, currentColor) 50% 100% / 10px 5px no-repeat;
  border-radius: 0 0 2px 2px;
}
.mode-btn.active {
  background: color-mix(in srgb, var(--accent-emphasis) 20%, transparent);
  color: var(--accent-bright);
}
</style>
