<script setup lang="ts">
/**
 * The panes still running on an MCP or skills set that has changed since they
 * started, listed on that setting's own page. A CLI reads both once at start,
 * so it keeps the old set until it is rebuilt. Disclosure only: every rebuild
 * is the user's click, and "Rebuild all idle" leaves a pane mid-turn alone.
 */
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { idleRebuildable, staleConfigKey, type StaleConfigPart } from '../lib/staleConfigPanes'

const props = defineProps<{ part: StaleConfigPart }>()

const { t } = useI18n()
const actions = inject(staleConfigKey, null)
const panes = computed(() => (actions?.panes() ?? []).filter((p) => p.parts.includes(props.part)))
const idleCount = computed(() => idleRebuildable(panes.value).length)
</script>

<template>
  <div v-if="panes.length" class="stale-config-notice" role="status" data-testid="stale-config-notice">
    <div class="stale-config-head">
      <div>
        <strong>{{ t('settings.stale-config.title', { count: panes.length }) }}</strong>
        <p>{{ t(part === 'mcp' ? 'settings.stale-config.body-mcp' : 'settings.stale-config.body-skills') }}</p>
      </div>
      <button
        type="button"
        :disabled="idleCount === 0"
        data-testid="stale-config-rebuild-idle"
        @click="actions?.rebuildAllIdle()"
      >{{ t('settings.stale-config.rebuild-all-idle', { count: idleCount }) }}</button>
    </div>
    <ul>
      <li v-for="pane in panes" :key="pane.id" :data-pane-id="pane.id">
        <span v-truncate class="stale-config-name">{{ pane.name }}</span>
        <span v-if="pane.busy" class="stale-config-state">{{ t('settings.stale-config.busy') }}</span>
        <span v-else-if="!pane.canRebuild" class="stale-config-state">{{ t('settings.stale-config.cannot-rebuild') }}</span>
        <button
          type="button"
          :disabled="!pane.canRebuild"
          data-testid="stale-config-rebuild"
          @click="actions?.rebuild(pane.id)"
        >{{ t('settings.stale-config.rebuild') }}</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.stale-config-notice {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-card);
  background: var(--bg-subtle);
}
.stale-config-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px 12px;
}
.stale-config-head > div {
  flex: 1 1 220px;
  min-width: 0;
}
.stale-config-head p {
  margin: 2px 0 0;
  color: var(--text-secondary);
}
.stale-config-notice ul {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.stale-config-notice li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  border-top: 1px dashed var(--border-default);
}
.stale-config-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stale-config-state {
  color: var(--text-secondary);
  white-space: nowrap;
}
</style>
