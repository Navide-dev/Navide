import type { CommandHandler } from './types'

const _commands = new Map<string, CommandHandler>()
/** Ids that came through registerPluginCommand: the only ones that can be removed. */
const _pluginCommands = new Set<string>()

export function registerCommand(id: string, handler: CommandHandler): void {
  _commands.set(id, handler)
}

// A Navide plugin's command. It cannot take over an id the Host registered:
// false means nothing was registered.
export function registerPluginCommand(id: string, handler: CommandHandler): boolean {
  if (_commands.has(id) && !_pluginCommands.has(id)) return false
  _commands.set(id, handler)
  _pluginCommands.add(id)
  return true
}

// Removes a command only if registerPluginCommand added it; a Host command stays.
export function unregisterCommand(id: string): boolean {
  if (!_pluginCommands.delete(id)) return false
  _commands.delete(id)
  return true
}

// Returns true if a handler was found and it consumed the invocation.
//
// A handler that returns exactly `false` declines: the dispatcher then leaves
// the key event alone instead of calling preventDefault(). This matters for
// handlers that guard on focus — e.g. the sidebar-tab commands no-op while the
// user is typing in a text field, and swallowing the key there would strip the
// native behaviour and every downstream listener. Any other return value
// (including undefined, the common case) counts as handled.
export function executeCommand(id: string, args?: unknown, event?: KeyboardEvent): boolean {
  const handler = _commands.get(id)
  if (!handler) return false
  // Only a key passes the event: other callers keep the one-argument call.
  return (event ? handler(args, event) : handler(args)) !== false
}

export function hasCommand(id: string): boolean {
  return _commands.has(id)
}

export function listCommands(): string[] {
  return [..._commands.keys()]
}

export interface InvokeCommandResult {
  ok: boolean
  result?: unknown
  error?: string
  /** A stable reason the handler attached to the error it threw (`code` on
   *  the Error), for a caller that words the failure itself. */
  code?: string
  params?: Record<string, unknown>
}

// Like executeCommand, but awaits the handler and surfaces its return value
// (or a stringified error if it throws/rejects) instead of firing-and-forgetting.
// Used by the external UI action bus, whose caller needs a real reply.
export async function invokeCommand(id: string, args?: unknown): Promise<InvokeCommandResult> {
  const handler = _commands.get(id)
  if (!handler) return { ok: false, error: `unknown command: ${id}` }
  try {
    const result = await handler(args)
    return { ok: true, result }
  } catch (err) {
    const coded = err as { code?: unknown; params?: unknown } | null
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(typeof coded?.code === 'string' ? { code: coded.code } : {}),
      ...(coded?.params && typeof coded.params === 'object' ? { params: coded.params as Record<string, unknown> } : {}),
    }
  }
}

// For testing only.
export function _resetRegistry(): void {
  _commands.clear()
  _pluginCommands.clear()
}
