/**
 * cli_set_model: the in-CLI command that switches a running pane's model, for
 * the CLIs that take one with an argument. Checked by hand against claude and
 * codex 0.166 (`/model <id>` switches, or names the id it does not know).
 * Every other CLI is switched by a restart onto `--model` instead.
 */
const LIVE_MODEL_COMMANDS: Readonly<Record<string, (model: string) => string>> = {
  claude: (m) => `/model ${m}`,
  codex: (m) => `/model ${m}`,
}

/** The command to type into the pane, or null when the switch needs a
 *  restart. An effort always restarts: neither command takes one. */
export function liveModelCommand(agentKey: string, model: string, effort: string): string | null {
  if (effort.trim()) return null
  const build = LIVE_MODEL_COMMANDS[agentKey]
  return build ? build(model.trim()) : null
}
