/** OpenCode — per-vendor agent spec (see types.ts; assembled by index.ts). */

import { declared } from './_declared'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'opencode',
  // Label, command, flags and resume arguments: the launch declaration.
  //
  // The root command really does consume `--model` — it is declared on the
  // root command, threaded into the TUI and parsed there. An earlier audit
  // recorded this as silently swallowed; that was wrong. What it saw was
  // opencode REJECTING the value (unknown provider, or an id missing its
  // `provider/` prefix) through a three-second toast. Values must therefore
  // be `provider/model` within a provider the user has configured;
  // `opencode models` lists what that resolves to. Effort is not a flag here
  // either — it is part of the model id (`-high`, `-fast`) or a config
  // variant.
  //
  // No skipPermissionFlag: the opencode TUI has no permission-bypass flag —
  // only the `opencode run` subcommand does, as `--dangerously-skip-permissions`
  // (still listed under `opencode run --help` on 1.15.12).
  //
  // `--auto` was declared here once on the claim that an older build ignores an
  // unknown root flag, "verified" with `opencode --auto --version`. That probe
  // proves nothing: `--version` short-circuits inside yargs before unknown
  // arguments are ever checked. Re-measured on 1.15.12 without it, the root
  // command REJECTS the flag — `opencode --auto models` prints the help banner
  // and exits 1, while bare `opencode models` exits 0 — so a YOLO-mode pane
  // spawned `opencode --auto ...`, never reached the TUI, and died on startup.
  //
  // Resume (`--session <id>`): the id is `ses_`-prefixed.
  ...declared('opencode'),
  needsSessionMarker: true,
  // Also the short flag, which the pattern derived from the declaration
  // (Navide's own resume command) does not know.
  resumeCommandPattern: /^opencode\s+(?:--session|-s)\s+\S+/,
  supportsRebuild: true,
  // Measured on a real PTY: the CLI itself emits `ESC[?1049h` during startup
  // (probe read 8626 bytes of startup output) and keeps the conversation there.
  fullScreenTui: true,
  // The pane is spawned with a port and a message is appended to the composer
  // and submitted over it. `holdsInputBox` because that is literally what
  // `/tui/append-prompt` does — verified on 1.15.12, repeated calls concatenate
  // into the same composer — so a half-written line still has to be protected.
  pushChannel: { kind: 'tui-http', holdsInputBox: true },
  hint: 'generalist'
} as const satisfies AgentSpec
