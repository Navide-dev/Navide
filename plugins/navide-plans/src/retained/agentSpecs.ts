// Private projection of the retained v1 execution picker. The parity test
// checks order, labels and hints against the host registry until v1 is removed.
export const CLI_AGENT_SPECS = [
  { agentKey: 'claude', label: 'Claude Code (Anthropic)', hint: 'planner + reviewer' },
  { agentKey: 'codex', label: 'Codex CLI (OpenAI)', hint: 'implementer' },
  { agentKey: 'antigravity', label: 'Antigravity CLI (Google)', hint: 'generalist' },
  { agentKey: 'grok', label: 'Grok Build (SpaceXAI)', hint: 'generalist' },
  { agentKey: 'kimi', label: 'Kimi Code CLI (Moonshot AI)', hint: 'generalist' },
  { agentKey: 'opencode', label: 'OpenCode (Anomaly)', hint: 'generalist' },
  { agentKey: 'qwen', label: 'Qwen Code (Alibaba Cloud)', hint: 'generalist' },
  { agentKey: 'kilo', label: 'Kilo Code CLI', hint: 'generalist' },
  { agentKey: 'pi', label: 'Pi', hint: 'generalist' },
  { agentKey: 'copilot', label: 'GitHub Copilot CLI', hint: 'generalist' },
  { agentKey: 'cursor', label: 'Cursor CLI', hint: 'generalist' },
  { agentKey: 'aider', label: 'Aider', hint: 'generalist' },
  { agentKey: 'muse', label: 'Muse Code (Meta)', hint: 'generalist' },
  { agentKey: 'droid', label: 'Droid CLI (Factory)', hint: 'generalist' },
  { agentKey: 'mcode', label: 'MiniMax Code', hint: 'generalist' },
  { agentKey: 'goose', label: 'Goose (AAIF)', hint: 'generalist' },
] as const
