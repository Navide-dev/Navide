<script setup lang="ts">
/**
 * Puts one PaneAccountBar inside each pane that ran out of quota. It is
 * teleported rather than written into the pane because App.tuiUnchanged pins the
 * pane block and TerminalPane's template word for word. The bar is absolutely
 * positioned inside the pane, so it scrolls, hides and closes with the pane and
 * never changes the PTY's size.
 */
import { shallowRef, watch } from 'vue'
import { formatLoopTime } from '../../lib/loopPrompt'
import PaneAccountBar from './PaneAccountBar.vue'

export interface PaneAccountBarItem {
  paneId: string
  usageLimitUntil: number | null
  switchOffered: boolean
}

const props = defineProps<{ items: PaneAccountBarItem[] }>()
defineEmits<{ (e: 'switch-account', paneId: string): void }>()

const targets = shallowRef(new Map<string, HTMLElement>())

// After the render that added a pane, so its element exists to be found.
watch(
  () => props.items.map((item) => item.paneId).join('\n'),
  () => {
    const found = new Map<string, HTMLElement>()
    for (const el of document.querySelectorAll<HTMLElement>('.pane[data-pane-id]')) {
      found.set(el.dataset.paneId ?? '', el)
    }
    targets.value = found
  },
  { flush: 'post', immediate: true },
)
</script>

<template>
  <template v-for="item in items" :key="item.paneId">
    <Teleport v-if="targets.get(item.paneId)" :to="targets.get(item.paneId)">
      <PaneAccountBar
        :back-at="item.usageLimitUntil != null ? formatLoopTime(item.usageLimitUntil) : null"
        :switch-offered="item.switchOffered"
        @switch-account="$emit('switch-account', item.paneId)"
      />
    </Teleport>
  </template>
</template>
