/** What the main window is told about a Navide plugin's own secrets
 *  (`secrets`, src/main/plugins/pluginSecrets.ts): they were isolated because
 *  the same plugin id now comes from another source or publisher, or they were
 *  deleted. Never a name or a value. */
export type PluginSecretsNotice =
  | { kind: 'identityMismatch'; pluginId: string }
  | { kind: 'cleared'; pluginId: string; count: number }

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/

export function isPluginSecretsNotice(value: unknown): value is PluginSecretsNotice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.pluginId !== 'string' || !PLUGIN_ID_PATTERN.test(record.pluginId)) return false
  if (record.kind === 'identityMismatch') return Object.keys(record).length === 2
  return record.kind === 'cleared' && Object.keys(record).length === 3 &&
    typeof record.count === 'number' && Number.isInteger(record.count) && record.count > 0
}
