/**
 * Which MCP servers can run shell commands or drive the desktop, for the risk
 * card in Settings → MCP. Disclosure only: nothing here blocks a server.
 *
 * Two signals, both exact lookups so an ordinary server is never flagged:
 * - a tool the server reports whose name is a shell row of the backend Guard's
 *   MCP_TOOLS table (backend/agent_team_backend/guard/classify.py), case-folded;
 * - a known package named as the command or one of its arguments.
 */

export type McpRiskKind = 'desktop' | 'shell'

/** The shell rows of MCP_TOOLS in guard/classify.py. Its argument-driven rows
 *  (filesystem, registry, process) are left out: those names alone do not say
 *  a server runs commands. */
const SHELL_TOOLS = new Set([
  'powershell', 'bash', 'shell', 'run_command', 'run_shell_command', 'shell_command', 'exec_command',
  'execute_command', 'start_process', 'interact_with_process',
])

/** Packages verified from their source to offer these powers. */
const KNOWN_PACKAGES: Record<string, McpRiskKind[]> = {
  // CursorTouch/Windows-MCP: UI Automation input plus PowerShell, files, registry.
  'windows-mcp': ['desktop', 'shell'],
  // wonderwhy-er/DesktopCommanderMCP: terminal commands and process control.
  '@wonderwhy-er/desktop-commander': ['shell'],
}

export interface McpRiskSource {
  command?: string
  args?: string[]
  tools?: { name: string }[]
}

/** `pkg@1.2`, `@scope/pkg@1.2`, `pkg==1.2` → the bare package name. */
function packageName(token: string): string {
  const lower = token.trim().toLowerCase()
  const at = lower.indexOf('@', 1)
  const bare = at > 0 ? lower.slice(0, at) : lower
  return bare.split(/==|>=|<=|~=/)[0]
}

export function mcpRiskKinds(sources: McpRiskSource[]): McpRiskKind[] {
  const kinds = new Set<McpRiskKind>()
  for (const source of sources) {
    for (const token of [source.command ?? '', ...(source.args ?? [])]) {
      for (const kind of KNOWN_PACKAGES[packageName(token)] ?? []) kinds.add(kind)
    }
    if ((source.tools ?? []).some((tool) => SHELL_TOOLS.has(tool.name.toLowerCase()))) kinds.add('shell')
  }
  return (['desktop', 'shell'] as const).filter((kind) => kinds.has(kind))
}
