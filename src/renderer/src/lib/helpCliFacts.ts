// Facts about the built-in CLIs that the Help pages quote — counts and name
// lists — derived from the vendor specs, so adding a CLI updates the prose
// instead of leaving "fifteen" behind in eleven locale files.
import { AGENT_SPECS, CLI_AGENT_SPECS, OBSERVED_AGENT_KEYS, type AgentSpec } from '../platform/plugin-shell/agents'

/** The spec label without its trailing "(Vendor)": "Goose (AAIF)" → "Goose". */
export function cliName(spec: AgentSpec): string {
  return spec.label.replace(/\s*\([^)]*\)$/, '')
}

/** Names joined the way the locale writes a list ("A, B and C" / "A、B 和 C"). */
export function joinNames(names: readonly string[], locale: string): string {
  return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names)
}

// Two backend facts the renderer specs do not carry, keyed by registry key.
// MCP_WIRED = vendors whose cli_vendors/<key>.py declares `mcp_wiring`. The
// fact lives in that Python spec, not in the runtime's declaration, so it is
// kept here by hand; backend/tests/test_cli_vendors_registry.py fails when it
// drifts.
// NO_LOG_READER = vendors with no log reader (nothing reads their turn text,
// so the bare-line output protocol cannot reach Navide either): the CLIs whose
// declaration is not `observed`, derived, not listed. The same test holds it
// to the registry's `make_log_reader`.
export const MCP_WIRED: ReadonlySet<string> = new Set([
  'claude', 'codex', 'copilot', 'qwen', 'opencode', 'kilo', 'kimi', 'grok', 'antigravity', 'cursor', 'kiro',
])
export const NO_LOG_READER: ReadonlySet<string> = new Set(
  CLI_AGENT_SPECS.map((spec) => spec.agentKey).filter((key) => !OBSERVED_AGENT_KEYS.has(key)),
)

export type SendRoute = 'both' | 'mcpOnly' | 'protocolOnly' | 'none'

export function sendRoute(spec: AgentSpec): SendRoute {
  const mcp = MCP_WIRED.has(spec.agentKey)
  const protocol = !NO_LOG_READER.has(spec.agentKey)
  if (mcp) return protocol ? 'both' : 'mcpOnly'
  return protocol ? 'protocolOnly' : 'none'
}

// A type alias, not an interface: vue-i18n's $t takes Record<string, unknown>,
// which only an alias satisfies without an explicit index signature.
export type CliFacts = {
  total: number
  mcpCount: number
  mcpNames: string
  noMcpCount: number
  notWired: string
  protocolOnly: string
  mcpOnly: string
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
    mcpCount: names((s) => MCP_WIRED.has(s.agentKey)).length,
    mcpNames: list((s) => MCP_WIRED.has(s.agentKey)),
    noMcpCount: names((s) => !MCP_WIRED.has(s.agentKey)).length,
    notWired: list((s) => !MCP_WIRED.has(s.agentKey)),
    protocolOnly: list((s) => sendRoute(s) === 'protocolOnly'),
    mcpOnly: list((s) => sendRoute(s) === 'mcpOnly'),
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
