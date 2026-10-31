<script setup lang="ts">
// The user's action buttons, at the right end of the stage tabs. The Host draws
// every one: a button carries a label and steps, so nothing here can pass for
// a built-in control. With no buttons this renders nothing.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useNotify, vTruncate } from '@navide/plugin-ui/foundation'
import { pluginCommandEntry } from '../lib/pluginCommands'
import { isAvailableButton, isDestructiveButton, runWorkbenchButton, visibleWorkbenchButtons, workbenchActionName } from '../lib/workbench'
import { projectName, visibleProjectButtons } from '../lib/projectWorkbench'
import type { WorkbenchButton } from '../../../shared/workbench'

const { t } = useI18n()
const notify = useNotify()

/** Yours first, then the project's. A repository picks its own ids, so the key
 *  and the source are kept apart from the button. */
const entries = computed(() => [
  ...visibleWorkbenchButtons.value.map((button) => ({ key: `mine:${button.id}`, button, fromProject: false })),
  ...visibleProjectButtons.value.map((button) => ({ key: `project:${button.id}`, button, fromProject: true })),
])

function isAvailable(button: WorkbenchButton): boolean {
  return isAvailableButton(button)
}

function pluginOf(button: WorkbenchButton): string | undefined {
  for (const step of button.steps) {
    const entry = pluginCommandEntry(step.action)
    if (entry) return entry.pluginName
  }
  return undefined
}

function actionName(id: string): string {
  return workbenchActionName(id)
}

function sourceOf(button: WorkbenchButton, fromProject: boolean): string {
  if (fromProject) return t('actionBar.source-project', { name: projectName.value })
  const plugin = pluginOf(button)
  return plugin ? t('actionBar.source-plugin', { name: plugin }) : t('actionBar.source-mine')
}

function titleFor(button: WorkbenchButton, fromProject: boolean): string {
  if (!isAvailable(button)) return t('actionBar.unavailable')
  const source = sourceOf(button, fromProject)
  // What it will really do: the label is free text and proves nothing.
  return `${source} — ${button.steps.map((step) => actionName(step.action)).join(' → ')}`
}

async function run(button: WorkbenchButton): Promise<void> {
  if (isDestructiveButton(button)) {
    const actions = button.steps.map((step) => actionName(step.action)).join(' → ')
    const ok = await notify.confirm(t('actionBar.confirm-message', { actions }), {
      title: t('actionBar.confirm-title'),
      confirmText: t('actionBar.confirm-run'),
      danger: true,
    })
    if (!ok) return
  }
  const failure = await runWorkbenchButton(button)
  if (failure) {
    notify.toast(t('actionBar.step-failed', { name: button.label, step: failure.failedAt + 1 }), { type: 'error' })
  }
}
</script>

<template>
  <div v-if="entries.length" class="action-bar" role="toolbar" :aria-label="$t('actionBar.settings-title')">
    <button
      v-for="{ key, button, fromProject } in entries"
      :key="key"
      type="button"
      class="action-bar-btn"
      :disabled="!isAvailable(button)"
      :title="titleFor(button, fromProject)"
      @click="run(button)"
    >
      <span v-if="fromProject" class="action-bar-mark" aria-hidden="true">▣</span>
      <span v-else-if="pluginOf(button)" class="action-bar-mark" aria-hidden="true">◇</span>
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
