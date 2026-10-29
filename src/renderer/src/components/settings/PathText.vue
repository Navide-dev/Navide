<script setup lang="ts">
// A path shown as a value, always on one line: shortened in the middle to fit
// about 48 characters so the file name and its parent stay visible (the full
// path stays in the tooltip). If even that is wider than the space it has, the
// line ends in an ellipsis rather than wrapping inside a segment.
import { computed } from 'vue'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { shortenPath } from '../../lib/shortenPath'

const props = withDefaults(defineProps<{ path: string; max?: number }>(), { max: 48 })

const shown = computed(() => shortenPath(props.path, props.max))
</script>

<template>
  <span v-truncate="path" class="path-text">{{ shown }}</span>
</template>

<style scoped>
.path-text {
  display: inline-block;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
  font-family: var(--font-mono);
}
</style>
