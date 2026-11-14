/**
 * cli_set_model: how a running pane's model is switched in place.
 *
 * - codex: `/model <id>` with an argument switches the running session only
 *   (checked by hand against codex 0.166).
 * - claude: `/model <id>` would also save the model as the default for new
 *   sessions, so its bare `/model` picker is opened instead and the row is
 *   picked with `s` ("use this session only"; lib/paneAnswerKeys
 *   modelPickerKeys). `claudePickerLabel` names the row to look for.
 *
 * Every other CLI, and any switch with an effort, restarts onto `--model`.
 */
const LIVE_MODEL_COMMANDS: Readonly<Record<string, (model: string) => string>> = {
  codex: (m) => `/model ${m}`,
}

/** The command to type into the pane, or null when the switch needs a
 *  restart (or, for claude, the picker). An effort always restarts: neither
 *  command takes one. */
export function liveModelCommand(agentKey: string, model: string, effort: string): string | null {
  if (effort.trim()) return null
  const build = LIVE_MODEL_COMMANDS[agentKey]
  return build ? build(model.trim()) : null
}

const CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable'])
const CLAUDE_MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)$/

const title = (family: string) => family[0].toUpperCase() + family.slice(1)

/** The name claude's /model picker shows for a model id: an alias ("opus")
 *  is the bare family, which the picker matches to its one row of that family;
 *  a full id ("claude-opus-5-5") is "Opus 5.5". Null for anything else (dated
 *  ids, "[1m]" variants, other names), so the switch restarts instead of
 *  guessing at a row. */
export function claudePickerLabel(model: string): string | null {
  const id = model.trim().toLowerCase()
  if (CLAUDE_FAMILIES.has(id)) return title(id)
  const m = CLAUDE_MODEL_ID.exec(id)
  return m ? `${title(m[1])} ${m[2]}.${m[3]}` : null
}
