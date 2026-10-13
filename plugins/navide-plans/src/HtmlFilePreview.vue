<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { createPluginCapabilityClient } from '@navide/plugin-sdk'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'

const props = defineProps<{ path: string; name: string }>()
const capabilities = createPluginCapabilityClient().capabilities
const { t } = useI18n()
const resourceUrl = ref('')
const error = ref('')
const extension = computed(() => props.path.split('.').pop()?.toUpperCase() ?? 'HTML')
let generation = 0

watch(() => props.path, async path => {
  const current = ++generation
  resourceUrl.value = ''
  error.value = ''
  try {
    // The query selects a resource, never authority. The receiving instance
    // must pass the normal workspace fs grant and policy checks itself.
    const result = await capabilities.invoke('fs.previewResource', { path })
    if (current === generation) resourceUrl.value = result.url
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  }
}, { immediate: true })

async function openExternally(): Promise<void> {
  const current = generation
  try {
    await capabilities.invoke('ui.openPath', { path: props.path })
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : String(cause)
  }
}

onUnmounted(() => { generation++ })
</script>

<template>
  <div class="fpv">
    <div class="fpv-toolbar">
      <span class="fpv-name" v-truncate :title="path">{{ name }}</span>
      <span class="fpv-meta">{{ extension }}</span>
      <span class="fpv-hint">{{ t('preview.html-scripts-disabled') }}</span>
      <span class="fpv-spacer" />
      <button class="fpv-btn fpv-open-btn" @click="openExternally">
        {{ t('preview.open-externally') }}
      </button>
    </div>
    <div v-if="error" class="fpv-error" role="alert">{{ error }}</div>
    <div v-else class="fpv-body">
      <!-- The resource endpoint's CSP sandbox is independent of this empty
           iframe sandbox. Report HTML never runs in a Plugin/Host origin. -->
      <iframe v-if="resourceUrl" class="fpv-html-frame" :src="resourceUrl" :title="name" sandbox="" />
    </div>
  </div>
</template>

<style scoped>
.fpv {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-base);
  color: var(--text-primary);
}
.fpv-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.25));
  font-size: var(--font-xs);
  flex: none;
}
.fpv-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fpv-meta, .fpv-hint { color: var(--text-secondary); white-space: nowrap; }
.fpv-spacer { flex: 1; }
.fpv-btn {
  background: transparent;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.35));
  border-radius: 4px;
  color: var(--text-secondary);
  font-size: var(--font-2xs);
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.fpv-btn:hover { color: var(--text-primary); }
.fpv-body { flex: 1; min-height: 0; overflow: auto; }
.fpv-html-frame { width: 100%; height: 100%; border: none; background: white; }
.fpv-error { padding: 12px; color: var(--text-secondary); }
</style>
