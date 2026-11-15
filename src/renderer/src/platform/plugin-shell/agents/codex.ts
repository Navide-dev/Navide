/** Codex — per-vendor agent spec (see types.ts; assembled by index.ts). */

import { declared } from './_declared'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'codex',
  // Label, command, flags and resume arguments: the launch declaration. No
  // effort flag: codex takes it as a config override
  // (`-c model_reasoning_effort=<value>`), a different injection shape than
  // every other vendor; declaring none refuses `effort` rather than guessing.
  // Resume is a subcommand (`resume <id>`), NOT a --flag.
  ...declared('codex'),
  // SessionStart or the pane's own rollout binds the ID after real work starts.
  // An idle pane must not submit a synthetic prompt just to discover its ID.
  needsSessionMarker: false,
  supportsRebuild: true,
  verifiedTurnText: true,
  bracketedPaste: true,
  // No fullScreenTui: 0.147.0 paints inline, in the NORMAL buffer, so its
  // conversation is already in the snapshot. Measured on a real PTY past the
  // directory-trust prompt (40k bytes of a fully drawn TUI): not one
  // `ESC[?1049h`, `?1047h` or `?47h`, with or without --no-alt-screen.
  // The binary does carry the sequence and crossterm's EnterAlternateScreen,
  // and --no-alt-screen is documented as "Disable alternate screen mode" —
  // an earlier round set the flag on that evidence alone and was wrong. A
  // string in a binary proves a code path exists, not that startup reaches
  // it; only the probe settles it. Re-measure before trusting either source
  // if a future release changes this.
  shiftEnterSequence: '\x1b[13;2u',
  // Restore-pin self-heals: per-pane CODEX_HOME announces the new session.
  supportsRestorePin: true,
  // Each pane gets its own CODEX_HOME, which is where the rollout a resume
  // reads back actually lives — so the pane needs an id for that home that
  // outlives a pane-id change across restores.
  needsSessionHome: true,
  // Older Agent-Team builds could persist a rollout filename or full path
  // before session_meta was readable. Recover only a strict trailing UUID;
  // any other Codex string is left exactly as it is.
  normalizeSessionId: (id) =>
    id.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\.jsonl)?$/i)?.[1] ?? id,
  // A saved conversation whose rollout is missing keeps its placeholder rather
  // than being replaced: starting a fresh Codex pane must stay an explicit
  // action from Agent History.
  preserveMissingSessionOnRestore: true,
  // Codex's approval dialog. Detected from the screen rather than a hook on
  // purpose: Codex gates newly-installed hooks behind a trust screen the user
  // must clear on every pane (and again whenever the hook file changes), so
  // installing one would put an unexplained prompt in front of them just to
  // light a badge.
  //
  // Two anchors, either of which is enough: the question line ("Would you like
  // to run the following command? / make the following edits? / grant these
  // permissions?") and the last option of the list, which is the same for all
  // three dialogs. Both belong to the live dialog only — Codex draws in a
  // full-screen alt buffer, so answering repaints them away.
  awaitingInput: {
    pattern: /Would you like to (run|make|grant) |No, and tell Codex what to do differently/,
  },
  // Codex 0.166's startup update menu (codex-rs/tui/src/update_prompt.rs),
  // measured on a real PTY with a stub version.json:
  //   Update available · 0.166.0 → 99.0.0 / Release notes: … /
  //   › 1. Update now (runs `npm install -g @openai/codex`) / 2. Skip /
  //   3. Skip until next version / … enter continue · esc skip
  // "Update now" is preselected, so Enter installs. Esc is "Skip" for this
  // launch only and writes nothing (3 would record dismissed_version). Both
  // patterns end at the screen's end: nothing is drawn below the menu, while
  // a transcript that merely quotes it has the composer under it. Navide
  // spawns pass `-c check_for_update_on_startup=false` by default, so this is
  // the net for a pane launched with the vendor's own check left on.
  updatePrompt: {
    pattern: /\bUpdate available\b.{0,400}?\bUpdate now\b.{0,300}?\bSkip until next version\b.{0,160}?\besc skip\s*$/,
    suspect: /\bUpdate available\b.{0,800}\bUpdate now\b.{0,800}\b[Ss]kip\b.{0,40}$/,
    skipKeys: '\x1b',
  },
  hint: 'implementer',
  // Quota failover: _codex_windows resolves primary/secondary by length to
  // session (5h) / weekly. Either can be missing: a lone weekly window is
  // declared in `absentWindows`, a lone session window needs no declaration.
  quotaSemantics: { hard: ['session', 'weekly'], required: ['session'] },
} as const satisfies AgentSpec
