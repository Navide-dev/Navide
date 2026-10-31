// The action buttons of this app: one list shared by the bar and Settings.
import { computed, shallowRef } from 'vue'
import { EMPTY_WORKBENCH, parseWorkbench, type WorkbenchConfig } from '../../../shared/workbench'

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

export async function saveWorkbench(next: WorkbenchConfig): Promise<{ ok: boolean; error?: string }> {
  const previous = workbench.value
  workbench.value = next
  const result = await window.agentTeam?.writeWorkbench?.(JSON.stringify(next, null, 2))
  if (result?.ok) return result
  workbench.value = previous
  return result ?? { ok: false, error: 'unavailable' }
}
