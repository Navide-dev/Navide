<script setup lang="ts">
// A path shown as a value: shortened in the middle when it is long (the full
// path stays in the tooltip), and allowed to wrap only after a separator, so a
// folder name is never split across lines.
import { computed } from 'vue'
import { shortenPath } from '../../lib/shortenPath'

const props = withDefaults(defineProps<{ path: string; max?: number }>(), { max: 64 })

const parts = computed(() => shortenPath(props.path, props.max).split(/(?<=[/\\])/))
</script>

<template>
  <span class="path-text" :title="path"><template v-for="(part, i) in parts" :key="i">{{ part }}<wbr v-if="i < parts.length - 1" /></template></span>
</template>

<style scoped>
.path-text {
  font-family: var(--font-mono);
  word-break: normal;
  /* A single segment longer than the line is the only thing that may break. */
  overflow-wrap: break-word;
}
</style>
