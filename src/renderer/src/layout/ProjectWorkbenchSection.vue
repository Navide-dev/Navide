<script setup lang="ts">
// Settings > Layout: what this project suggests, and the user's decision on it.
// Nothing here renders for a project with no .navide/workbench.json. The review
// names what each button really runs: the labels are free text from the repository.
import { computed, ref } from 'vue'
import { i18n, vTruncate } from '@navide/plugin-ui/foundation'
import { hasCommand, invokeCommand } from '@navide/plugin-ui/shared'
import SettingsSection from '../components/settings/SettingsSection.vue'
import { isAvailableButton, isDestructiveButton, isPermittedButton, workbenchActionName } from '../lib/workbench'
import {
  acceptProjectWorkbench,
  projectName,
  projectWorkbench,
  revokeProjectWorkbench,
} from '../lib/projectWorkbench'
import { isButtonAction } from '../composables/uiActionCatalog'
import { isPluginCommand } from '../lib/pluginCommands'
import type { ProjectLayoutMode, ProjectWorkbenchButton } from '../../../shared/projectWorkbench'

const { t } = i18n.global
const error = ref('')

const snapshot = computed(() => projectWorkbench.value)
const recommendation = computed(() => snapshot.value.recommendation)
const canDecide = computed(() => snapshot.value.status === 'pending' || snapshot.value.status === 'stale')
const layoutMode = computed(() => snapshot.value.active?.layoutMode)
const LAYOUT_LABELS: Record<ProjectLayoutMode, string> = {
  grid: 'label.view-mode-grid',
  auto: 'label.view-mode-sidebar',
  spotlight: 'label.view-mode-spotlight',
  fullscreen: 'label.view-mode-fullscreen',
}

function stepNames(button: ProjectWorkbenchButton): string {
  return button.steps.map((step) => {
    if (!isButtonAction(step.action, isPluginCommand)) return t('actionBar.project-refused-step', { action: step.action })
    // A title spelled from an unknown id would read like a real action.
    return hasCommand(step.action) ? workbenchActionName(step.action) : step.action
  }).join(' → ')
}

async function settle(run: () => Promise<boolean | string>): Promise<void> {
  const outcome = await run()
  error.value = outcome === true ? '' : t('actionBar.project-failed', { reason: String(outcome) })
}

function accept(): Promise<void> {
  const { fingerprint } = snapshot.value
  return settle(() => (fingerprint ? acceptProjectWorkbench(fingerprint) : Promise.resolve('stale')))
}

async function applyLayout(): Promise<void> {
  const result = await invokeCommand('ui.layout.setMode', { mode: layoutMode.value })
  error.value = result.ok ? '' : t('actionBar.project-failed', { reason: result.error ?? 'unavailable' })
}

async function openPlugin(id: string): Promise<void> {
  const result = await invokeCommand('ui.plugins.openMarketplace', { id })
  error.value = result.ok ? '' : t('actionBar.project-failed', { reason: result.error ?? 'unavailable' })
}
</script>

<template>
  <SettingsSection
    v-if="snapshot.status !== 'none'"
    class="pws"
    :label="$t('actionBar.project-title', { name: projectName })"
  >
    <p class="pws-status" :class="{ 'pws-status--warn': snapshot.status !== 'accepted' }">
      <span v-if="snapshot.status !== 'accepted'" aria-hidden="true">⚠ </span>{{ $t(`actionBar.project-status-${snapshot.status}`) }}
    </p>

    <template v-if="recommendation">
      <ul v-if="recommendation.buttons?.length" class="pws-list" :aria-label="$t('actionBar.project-buttons')">
        <li v-for="button in recommendation.buttons" :key="button.id" class="pws-row">
          <span v-truncate class="pws-label">{{ button.label }}</span>
          <span class="pws-actions">{{ stepNames(button) }}</span>
          <span v-if="!isPermittedButton(button)" class="pws-flag pws-flag--risk">{{ $t('actionBar.project-refused') }}</span>
          <span v-else-if="isDestructiveButton(button)" class="pws-flag pws-flag--risk">{{ $t('actionBar.project-destructive') }}</span>
          <span v-else-if="!isAvailableButton(button)" class="pws-flag">{{ $t('actionBar.unavailable') }}</span>
        </li>
      </ul>

      <p v-if="recommendation.layoutMode" class="pws-line">
        <span>{{ $t('actionBar.project-layout', { mode: $t(LAYOUT_LABELS[recommendation.layoutMode]) }) }}</span>
        <button v-if="layoutMode" type="button" class="nv-btn nv-btn--sm" @click="applyLayout">{{ $t('actionBar.project-apply') }}</button>
      </p>

      <ul v-if="recommendation.plugins?.length" class="pws-list" :aria-label="$t('actionBar.project-plugins')">
        <li v-for="plugin in recommendation.plugins" :key="plugin.id" class="pws-row pws-row--plugin">
          <span v-truncate class="pws-label">{{ plugin.id }}</span>
          <span class="pws-actions">{{ plugin.version }}</span>
          <button type="button" class="nv-btn nv-btn--sm" @click="openPlugin(plugin.id)">{{ $t('actionBar.project-open-plugin') }}</button>
        </li>
      </ul>

      <div class="pws-decide">
        <button v-if="canDecide" type="button" class="nv-btn nv-btn--sm nv-btn--primary" @click="accept">{{ $t('actionBar.project-accept') }}</button>
        <button v-if="snapshot.status === 'accepted'" type="button" class="nv-btn nv-btn--sm" @click="settle(revokeProjectWorkbench)">{{ $t('actionBar.project-revoke') }}</button>
      </div>
    </template>

    <p v-if="error" class="pws-error">{{ error }}</p>
  </SettingsSection>
</template>

<style scoped>
.pws-status {
  margin: 0 0 8px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.pws-status--warn {
  color: var(--text-primary);
}
.pws-list {
  display: flex;
  flex-direction: column;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
}
.pws-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
}
.pws-row--plugin {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
}
.pws-row + .pws-row {
  border-top: 1px solid var(--border-muted);
}
.pws-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.pws-actions {
  min-width: 0;
  overflow-wrap: anywhere;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.pws-flag {
  text-align: right;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.pws-flag--risk {
  color: var(--danger-fg);
}
.pws-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.pws-decide {
  display: flex;
  gap: 8px;
}
.pws-error {
  margin: 8px 0 0;
  font-size: var(--font-xs);
  color: var(--danger-fg);
}
</style>
