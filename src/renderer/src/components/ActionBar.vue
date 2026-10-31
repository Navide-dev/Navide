<script setup lang="ts">
// The user's action buttons, at the right end of the stage tabs. The Host draws
// every one: a button carries a label and steps, so nothing here can pass for
// a built-in control. With no buttons this renders nothing.
import { useI18n } from 'vue-i18n'
import { vTruncate } from '@navide/plugin-ui/foundation'
import { hasCommand } from '@navide/plugin-ui/shared'
import { describeUiAction } from '../composables/uiActionCatalog'
import { pluginActionFacts, pluginCommandEntry } from '../lib/pluginCommands'
import { isPermittedButton, runWorkbenchButton, visibleWorkbenchButtons } from '../lib/workbench'
import type { WorkbenchButton } from '../../../shared/workbench'

const { t } = useI18n()

function isAvailable(button: WorkbenchButton): boolean {
  return isPermittedButton(button) && button.steps.every((step) => hasCommand(step.action))
}

function pluginOf(button: WorkbenchButton): string | undefined {
  for (const step of button.steps) {
    const entry = pluginCommandEntry(step.action)
    if (entry) return entry.pluginName
  }
  return undefined
}

function titleFor(button: WorkbenchButton): string {
  if (!isAvailable(button)) return t('actionBar.unavailable')
  const plugin = pluginOf(button)
  const source = plugin ? t('actionBar.source-plugin', { name: plugin }) : t('actionBar.source-mine')
  // What it will really do: the label is free text and proves nothing.
  const actions = button.steps.map((step) => pluginActionFacts(step.action)?.title ?? describeUiAction(step.action).title)
  return `${source} — ${actions.join(' → ')}`
}

function run(button: WorkbenchButton): void {
  void runWorkbenchButton(button)
}
</script>

<template>
  <div v-if="visibleWorkbenchButtons.length" class="action-bar" role="toolbar" :aria-label="$t('actionBar.settings-title')">
    <button
      v-for="button in visibleWorkbenchButtons"
      :key="button.id"
      type="button"
      class="action-bar-btn"
      :disabled="!isAvailable(button)"
      :title="titleFor(button)"
      @click="run(button)"
    >
      <span v-if="pluginOf(button)" class="action-bar-mark" aria-hidden="true">◇</span>
      <span v-truncate class="action-bar-label">{{ button.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.action-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-right: 8px;
  padding-right: 8px;
  border-right: 1px solid var(--border-muted);
}
.action-bar-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 160px;
  height: var(--icon-btn-sm);
  padding: 0 8px;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-xs);
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
.action-bar-btn:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--border-default);
}
.action-bar-btn:focus-visible {
  outline: 2px solid var(--accent-fg);
  outline-offset: 1px;
}
.action-bar-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.action-bar-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.action-bar-mark {
  flex: none;
  color: var(--text-muted);
  font-size: var(--font-3xs);
}
</style>
