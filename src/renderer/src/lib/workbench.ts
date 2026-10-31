// The action buttons of this app: one list shared by the bar and Settings.
import { computed, shallowRef } from 'vue'
import { invokeCommand } from '@navide/plugin-ui/shared'
import { EMPTY_WORKBENCH, parseWorkbench, type WorkbenchButton, type WorkbenchConfig } from '../../../shared/workbench'
import { DESTRUCTIVE_ACTIONS, isButtonAction } from '../composables/uiActionCatalog'
import { isPluginCommand } from './pluginCommands'

export const workbench = shallowRef<WorkbenchConfig>(EMPTY_WORKBENCH)

/** What the bar draws. Empty, the bar renders nothing at all. */
export const visibleWorkbenchButtons = computed(() => (workbench.value.hidden ? [] : workbench.value.buttons))

/** Read the file and follow changes from other windows. */
export async function loadWorkbench(): Promise<void> {
  const api = window.agentTeam
  api?.onWorkbenchChanged?.((content) => { workbench.value = parseWorkbench(content).config })
  const result = await api?.readWorkbench?.()
  if (result?.ok && typeof result.content === 'string') workbench.value = parseWorkbench(result.content).config
}

/** False for a button naming an action no button may run: the file was edited
 *  by hand, or by something other than Settings. */
export function isPermittedButton(button: WorkbenchButton): boolean {
  return button.steps.every((step) => isButtonAction(step.action, isPluginCommand))
}

export function isDestructiveButton(button: WorkbenchButton): boolean {
  return button.steps.some((step) => DESTRUCTIVE_ACTIONS.has(step.action))
}

/** Runs the steps in order and stops at the first that fails: a later step was
 *  written assuming the earlier one happened. A step no button may run stops
 *  the whole button before any step does. Answers the step that failed. */
export async function runWorkbenchButton(button: WorkbenchButton): Promise<{ failedAt: number; error?: string } | null> {
  const refused = button.steps.findIndex((step) => !isButtonAction(step.action, isPluginCommand))
  if (refused !== -1) return { failedAt: refused, error: `${button.steps[refused].action} cannot run from a button` }
  for (const [index, step] of button.steps.entries()) {
    const result = await invokeCommand(step.action)
    if (!result.ok) return { failedAt: index, ...(result.error ? { error: result.error } : {}) }
  }
  return null
}

export async function saveWorkbench(next: WorkbenchConfig): Promise<{ ok: boolean; error?: string }> {
  const previous = workbench.value
  workbench.value = next
  const result = await window.agentTeam?.writeWorkbench?.(JSON.stringify(next, null, 2))
  if (result?.ok) return result
  workbench.value = previous
  return result ?? { ok: false, error: 'unavailable' }
}
