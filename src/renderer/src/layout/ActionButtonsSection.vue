<script setup lang="ts">
// Settings > Layout: the action buttons. The one place a button is added.
import { computed, ref } from 'vue'
import { i18n, vTruncate } from '@navide/plugin-ui/foundation'
import { commandI18nKey, listCommands } from '@navide/plugin-ui/shared'
import SettingsSection from '../components/settings/SettingsSection.vue'
import SettingsEmptyState from '../components/settings/SettingsEmptyState.vue'
import { buttonActions, type UiActionInfo } from '../composables/uiActionCatalog'
import { pluginActionFacts, pluginCommands } from '../lib/pluginCommands'
import { saveWorkbench, workbench } from '../lib/workbench'
import { MAX_WORKBENCH_BUTTONS, MAX_WORKBENCH_LABEL, type WorkbenchButton } from '../../../shared/workbench'

const { t, te } = i18n.global
const name = ref('')
const action = ref('')
const saveError = ref('')

const actions = computed(() => {
  void pluginCommands.value
  return buttonActions(listCommands(), pluginActionFacts)
})
const groups = computed(() => {
  const byCategory = new Map<string, typeof actions.value>()
  for (const entry of actions.value) {
    const category = categoryLabel(entry)
    byCategory.set(category, [...(byCategory.get(category) ?? []), entry])
  }
  return [...byCategory.entries()].map(([category, entries]) => ({ category, entries }))
})
const canAdd = computed(() =>
  name.value.trim().length > 0 && action.value !== '' && workbench.value.buttons.length < MAX_WORKBENCH_BUTTONS,
)

/** The translated title where there is one; a `ui.*` action has its sentence
 *  instead of a title spelled from its id. */
function actionLabel(entry: UiActionInfo): string {
  const key = commandI18nKey(entry.id)
  if (te(key)) return t(key)
  return entry.id.startsWith('ui.') ? (entry.summary ?? entry.title) : entry.title
}

function categoryLabel(entry: UiActionInfo): string {
  const key = `settings.keybindings.category.${entry.id.split('.')[0]}`
  return te(key) ? t(key) : entry.category
}

function titleOf(button: WorkbenchButton): string {
  const entry = actions.value.find((candidate) => candidate.id === button.steps[0]?.action)
  return entry ? actionLabel(entry) : t('actionBar.unavailable')
}

async function commit(buttons: WorkbenchButton[], hidden = workbench.value.hidden): Promise<void> {
  const result = await saveWorkbench({ schemaVersion: 1, hidden, buttons })
  saveError.value = result.ok ? '' : (result.error ?? 'write failed')
}

async function add(): Promise<void> {
  if (!canAdd.value) return
  await commit([
    ...workbench.value.buttons,
    { id: crypto.randomUUID(), label: name.value.trim(), steps: [{ action: action.value }] },
  ])
  name.value = ''
  action.value = ''
}

function remove(id: string): Promise<void> {
  return commit(workbench.value.buttons.filter((button) => button.id !== id))
}
</script>

<template>
  <SettingsSection class="abs" :label="$t('actionBar.settings-title')">
    <p class="abs-hint">{{ $t('actionBar.settings-hint') }}</p>
    <SettingsEmptyState v-if="!workbench.buttons.length" :message="$t('actionBar.empty')" />
    <ul v-else class="abs-list">
      <li v-for="button in workbench.buttons" :key="button.id" class="abs-row">
        <span v-truncate class="abs-label">{{ button.label }}</span>
        <span v-truncate class="abs-action">{{ titleOf(button) }}</span>
        <button type="button" class="nv-btn nv-btn--sm" @click="remove(button.id)">{{ $t('actionBar.remove') }}</button>
      </li>
    </ul>
    <form class="abs-add" @submit.prevent="add">
      <input
        v-model="name"
        class="nv-input abs-name"
        type="text"
        :maxlength="MAX_WORKBENCH_LABEL"
        :placeholder="$t('actionBar.name-placeholder')"
        :aria-label="$t('actionBar.name-placeholder')"
      />
      <select v-model="action" class="nv-input abs-select" :aria-label="$t('actionBar.action-placeholder')">
        <option value="" disabled>{{ $t('actionBar.action-placeholder') }}</option>
        <optgroup v-for="group in groups" :key="group.category" :label="group.category">
          <option v-for="entry in group.entries" :key="entry.id" :value="entry.id">{{ actionLabel(entry) }}</option>
        </optgroup>
      </select>
      <button type="submit" class="nv-btn nv-btn--sm" :disabled="!canAdd">{{ $t('actionBar.add') }}</button>
    </form>
    <label v-if="workbench.buttons.length" class="abs-hide">
      <input type="checkbox" :checked="workbench.hidden" @change="commit(workbench.buttons, ($event.target as HTMLInputElement).checked)" />
      {{ $t('actionBar.hide') }}
    </label>
    <p v-if="saveError" class="abs-error">{{ $t('actionBar.save-failed') }} — {{ saveError }}</p>
  </SettingsSection>
</template>

<style scoped>
.abs-hint {
  margin: 0 0 8px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.abs-list {
  display: flex;
  flex-direction: column;
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
}
.abs-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
}
.abs-row + .abs-row {
  border-top: 1px solid var(--border-muted);
}
.abs-label,
.abs-action {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.abs-label {
  color: var(--text-primary);
}
.abs-action {
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.abs-add {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.abs-name {
  flex: 1 1 140px;
  min-width: 0;
}
.abs-select {
  flex: 2 1 200px;
  min-width: 0;
}
.abs-hide {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
.abs-error {
  margin: 8px 0 0;
  font-size: var(--font-xs);
  color: var(--danger-fg);
}
</style>
