<script setup lang="ts">
// An extension icon for Marketplace cards and detail headers. The bytes come
// from the main process as a size-capped, magic-byte-checked raster data: URL
// (plugins:marketplaceIcon); anything else, or no icon at all, shows a
// letter tile coloured from the extension id.
import { computed, ref, watch } from 'vue'
import { revealInvisibleText } from '../../../shared/pluginAgentTools'

const props = defineProps<{
  namespace: string
  name: string
  label: string
  version?: string | null
  path?: string | null
  size?: number
}>()

const src = ref<string | null>(null)

watch(
  () => [props.namespace, props.name, props.version, props.path] as const,
  async ([namespace, name, version, path]) => {
    src.value = null
    const api = window.agentTeam?.plugins
    if (!version || !path || !api?.marketplaceIcon) return
    try {
      const dataUrl = await api.marketplaceIcon({ namespace, name, version, path })
      // Ignore a late answer for an icon this component no longer shows.
      if (props.version === version && props.path === path && props.name === name) {
        src.value = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') ? dataUrl : null
      }
    } catch {
      src.value = null
    }
  },
  { immediate: true }
)

// A label that opens with an invisible character shows its spelled-out form's first letter.
const letter = computed(() => (revealInvisibleText(props.label).trim()[0] ?? '?').toUpperCase())
// 24 hues, 15 degrees apart, from a hash of the id. The Marketplace website
// computes the same bucket (registry/web.py tile_hue), so an extension wears
// one colour in the app and on the web.
const hue = computed(() => {
  let hash = 0
  for (const ch of `${props.namespace}.${props.name}`) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return (hash % 24) * 15
})
const box = computed(() => `${props.size ?? 36}px`)
</script>

<template>
  <img v-if="src" class="mkt-icon" :src="src" alt="" draggable="false" />
  <span
    v-else
    class="mkt-icon mkt-icon--letter"
    :style="{ background: `linear-gradient(150deg, hsl(${hue} 44% 32%), hsl(${hue} 50% 24%))` }"
    aria-hidden="true"
  >{{ letter }}</span>
</template>

<style scoped>
.mkt-icon {
  flex-shrink: 0;
  width: v-bind(box);
  height: v-bind(box);
  border-radius: var(--radius-tile);
  object-fit: contain;
}
.mkt-icon--letter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* White on the tile's darker end: >= 4.5:1 for every hue. */
  color: #fff;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
  font-weight: 700;
  font-size: calc(v-bind(box) * 0.45);
  user-select: none;
}
</style>
