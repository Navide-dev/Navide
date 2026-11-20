<script setup lang="ts">
// One package screenshot on the Marketplace detail page. Same path as the
// icon (plugins:marketplaceIcon, kind 'screenshot'): a size-capped,
// magic-byte-checked raster data: URL from the main process. Nothing is
// shown when it cannot be loaded, so a broken image never leaves a hole.
import { ref, watch } from 'vue'

const props = defineProps<{
  namespace: string
  name: string
  version: string
  path: string
  label: string
}>()

const src = ref<string | null>(null)

watch(
  () => [props.namespace, props.name, props.version, props.path] as const,
  async ([namespace, name, version, path]) => {
    src.value = null
    const api = window.agentTeam?.plugins
    if (!api?.marketplaceIcon) return
    try {
      const dataUrl = await api.marketplaceIcon({ namespace, name, version, path, kind: 'screenshot' })
      if (props.version === version && props.path === path && props.name === name) {
        src.value = typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') ? dataUrl : null
      }
    } catch {
      src.value = null
    }
  },
  { immediate: true }
)
</script>

<template>
  <img v-if="src" class="mkt-shot" :src="src" :alt="label" draggable="false" />
</template>

<style scoped>
.mkt-shot {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 10;
  object-fit: cover;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-muted);
}
</style>
