// The Navide plugin commands of this window: what the shortcuts page lists and
// what a key can run. Empty until a plugin declares one.
import { shallowRef } from 'vue'
import { registerPluginCommand, unregisterCommand } from '@navide/plugin-ui/shared'
import type { PluginCommandEntry } from '../../../shared/pluginCommands'

export const pluginCommands = shallowRef<readonly PluginCommandEntry[]>([])

export function pluginCommandEntry(id: string): PluginCommandEntry | undefined {
  return pluginCommands.value.find((command) => command.commandId === id)
}

export function isPluginCommand(id: string): boolean {
  return pluginCommandEntry(id) !== undefined
}

/** Replaces the list, registering what is new and removing what has gone. An
 *  id the Host already owns is left out: it can never run as a plugin's. */
export function syncPluginCommands(
  next: readonly PluginCommandEntry[],
  run: (commandId: string) => void,
): void {
  const incoming = new Set(next.map((command) => command.commandId))
  for (const { commandId } of pluginCommands.value) {
    if (!incoming.has(commandId)) unregisterCommand(commandId)
  }
  pluginCommands.value = next.filter(({ commandId }) => registerPluginCommand(commandId, () => run(commandId)))
}

const HOST_COMMAND_HEADS = new Set(['workbench', 'ui', 'editor', 'git', 'navide', 'controlPane'])

/** An id a plugin could have declared, for a binding whose plugin is not here:
 *  publisher, name, command, and not one of the Host's own namespaces. */
export function isPluginShapedCommand(id: string): boolean {
  const segments = id.split('.')
  return segments.length >= 3 && !HOST_COMMAND_HEADS.has(segments[0])
}
