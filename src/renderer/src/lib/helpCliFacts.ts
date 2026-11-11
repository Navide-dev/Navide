// Facts about the built-in CLIs that the Help pages quote — counts and name
// lists — derived from the vendor specs, so adding a CLI updates the prose
// instead of leaving "fifteen" behind in eleven locale files.
import { AGENT_SPECS, CLI_AGENT_SPECS, type AgentSpec } from '../platform/plugin-shell/agents'

/** The spec label without its trailing "(Vendor)": "Goose (AAIF)" → "Goose". */
export function cliName(spec: AgentSpec): string {
  return spec.label.replace(/\s*\([^)]*\)$/, '')
}

/** Names joined the way the locale writes a list ("A, B and C" / "A、B 和 C"). */
export function joinNames(names: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names)
}

// Two backend facts the renderer specs do not carry, keyed by registry key.
// MCP_WIRED = vendors whose cli_vendors/<key>.py declares `mcp_wiring`;
// NO_LOG_READER = vendors with no `make_log_reader` (nothing reads their turn
// text, so the bare-line output protocol cannot reach Navide either).
export const MCP_WIRED: ReadonlySet<string> = new Set([
  'claude', 'codex', 'copilot', 'qwen', 'opencode', 'kilo', 'kimi', 'grok', 'antigravity', 'cursor',
])
export const NO_LOG_READER: ReadonlySet<string> = new Set(['mcode', 'devin'])

export type SendRoute = 'both' | 'protocolOnly' | 'none'

export function sendRoute(spec: AgentSpec): SendRoute {
  if (NO_LOG_READER.has(spec.agentKey)) return 'none'
  return MCP_WIRED.has(spec.agentKey) ? 'both' : 'protocolOnly'
}

export interface CliFacts {
  total: number
  mcpCount: number
  mcpNames: string
  noMcpCount: number
  notWired: string
  protocolOnly: string
  receiveOnly: string
  sendCount: number
  noFlagCount: number
  noFlag: string
  agents: string
  midTurn: string
}

/** Everything a Help page interpolates, for one locale. */
export function cliFacts(locale: string): CliFacts {
  const names = (pick: (s: AgentSpec) => boolean): string[] => CLI_AGENT_SPECS.filter(pick).map(cliName)
  const list = (pick: (s: AgentSpec) => boolean): string => joinNames(names(pick), locale)
  return {
    total: CLI_AGENT_SPECS.length,
    mcpCount: names((s) => sendRoute(s) === 'both').length,
    mcpNames: list((s) => sendRoute(s) === 'both'),
    noMcpCount: names((s) => sendRoute(s) !== 'both').length,
    notWired: list((s) => sendRoute(s) !== 'both'),
    protocolOnly: list((s) => sendRoute(s) === 'protocolOnly'),
    receiveOnly: list((s) => sendRoute(s) === 'none'),
    sendCount: names((s) => sendRoute(s) !== 'none').length,
    noFlagCount: names((s) => !s.skipPermissionFlag).length,
    noFlag: list((s) => !s.skipPermissionFlag),
    agents: list((s) => s.kind === 'agent'),
    midTurn: list((s) => !!s.acceptsMidTurnInput),
  }
}

export type SpawnGroup = 'both' | 'modelOnly' | 'neither'

/** Which fields the Manual spawn dialog shows per spec (terminal included). */
export function spawnGroup(spec: AgentSpec): SpawnGroup {
  if (spec.modelArgs && spec.effortArgs) return 'both'
  return spec.modelArgs ? 'modelOnly' : 'neither'
}

export function spawnGroupNames(group: SpawnGroup, locale: string): { count: number; names: string } {
  const members = AGENT_SPECS.filter((s) => spawnGroup(s) === group).map(cliName)
  return { count: members.length, names: joinNames(members, locale) }
}
