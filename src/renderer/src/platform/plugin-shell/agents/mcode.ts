/** MiniMax Code (mcode) — per-vendor agent spec (see types.ts; assembled by index.ts). */

import { declared } from './_declared'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'mcode',
  // Label and command: the launch declaration, which has nothing else.
  ...declared('mcode'),
  // Every optional capability below is deliberately absent, verified against
  // mcode 0.4.12 rather than inferred from the docs — the published reference
  // lists `--model`, `--effort`, `--permission` and `--resume` together with
  // the interactive flags, but each of those belongs to `mcode exec`, which
  // Navide never spawns.
  //
  // `mcode --help` gives the interactive command exactly five options:
  //   --lane <lane>, --session [id], -c/--continue, --tui-mode <mode>, -V
  //
  // No modelArgs / effortArgs: unlike the CLIs that quietly ignore an unknown
  // flag, mcode is strict — `mcode --bogus-flag-xyz` answers
  // `error: unknown option '--bogus-flag-xyz'` and exits. Declaring either one
  // would not degrade the pane, it would stop the pane from ever opening.
  //
  // No skipPermissionFlag: the interactive command has no unattended switch at
  // all. mcode's equivalent is a setting — `permissionMode` in
  // <data-dir>/config.yaml, or Alt+M in the TUI — so YOLO mode has no argv to
  // append for this vendor.
  //
  // No resumeArgs even though `--session <id>` exists: resuming requires being
  // able to name the id of a session Navide started, which requires a log
  // reader, and mcode keeps its history in SQLite
  // (<data-dir>/v2/sqlite/runtime-state.sqlite) rather than per-session JSONL.
  // The backend spec records that schema; both sides stay unset until a reader
  // can be written against a real authenticated session.
  //
  // bracketedPaste is likewise unset: it is a property of the live PTY stream
  // and has not been measured for mcode, and the other vendors' flags were all
  // set from a real capture.
  hint: 'generalist',
  // Quota failover, from mcode 0.4.12's chunks (vendor-owner source read, not
  // reproduced live): error kinds usage_limit ("LLM usage limit reached") and
  // credits_exhausted ("LLM credits exhausted") are quota; rate_limited ("LLM
  // provider rate limited the request") is not and is left out. The Codex-
  // OAuth route prints "You have hit your ChatGPT usage limit". Conversations
  // live in SQLite with no Navide reader yet, so PTY text is the only source.
  quotaExhausted: {
    pattern: /(LLM usage limit reached|LLM credits exhausted|hit your ChatGPT usage limit|usage_limited\(provider_quota\))/i,
  },
} as const satisfies AgentSpec
