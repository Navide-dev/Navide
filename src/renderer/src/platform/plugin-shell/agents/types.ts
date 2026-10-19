/**
 * Shared types for the per-vendor agent specs (one file per vendor in this
 * directory; `index.ts` assembles them). Kept separate from index.ts so a
 * vendor file never imports the assembler (no cycles).
 */

/** Lists one directory's entry names; null when it isn't listable. Supplied by
 *  the app so a spec can inspect the filesystem without owning an RPC client. */
export type DirLister = (dir: string) => Promise<string[] | null>

/** Inputs a spec's `paneArg` is computed from. */
export interface PaneArgContext {
  /** Pane UUID — the identity the per-pane file is named after. */
  paneId: string
  /** Directory the pane's per-pane files live in: its git root, else its cwd. */
  historyRoot: string
}

export interface AgentSpec {
  agentKey: string
  label: string
  defaultCommand: string
  /** CLI-specific flag that bypasses interactive permission / trust prompts
   *  so the agent runs unattended. Appended automatically when the user
   *  enables YOLO mode (default) and hasn't supplied a custom command. */
  skipPermissionFlag?: string
  /** Argument computed per pane, inserted between the base command and
   *  skipPermissionFlag. Only aider defines one (its private chat-history
   *  file); no other CLI shares state across panes by default. */
  paneArg?: (ctx: PaneArgContext) => string
  /** Vendor arguments that pick the model to run, WITHOUT the binary — e.g.
   *  `--model <id>`. Undefined = this CLI cannot be told which model to use
   *  at launch, and a spawn that asks for one is REFUSED rather than started
   *  on the default: droid accepts an unknown `--model` on its interactive
   *  command and ignores it, so dropping the flag would look like success
   *  until someone read the transcript. opencode was recorded here for the
   *  same reason once; that was wrong — its root command really does consume
   *  the flag, and it declares this field. See the note in opencode.ts. */
  modelArgs?: (model: string) => string
  /** Vendor arguments that pick a reasoning-effort level. Undefined = this
   *  CLI has no separate effort flag. Some encode effort in the model id
   *  instead (`gpt-5.3-codex-high`); those declare `modelArgs` only, and an
   *  `effort` asked of them is refused so the caller learns to put it in the
   *  model id. */
  effortArgs?: (effort: string) => string
  /** Effort values this CLI accepts. Unlike model ids — which change every
   *  release, so validating them would reject valid values — this vocabulary
   *  is small and closed, so it is checked before launch. Undefined with
   *  `effortArgs` present = accept any value and let the CLI report its own
   *  error. */
  knownEfforts?: readonly string[]
  hint?: string
  /** Vendor resume arguments WITHOUT the binary (the binary comes from
   *  `defaultCommand`, or the caller's custom command override) — e.g.
   *  `resume <id>` (codex subcommand) or `--resume=<id>`. Undefined = the
   *  vendor cannot resume by id (aider's lossy restore is special-cased in
   *  buildResumeCommand). */
  resumeArgs?: (sessionId: string) => string
  /** This CLI's logs carry no end-of-turn RECORD, so a turn's end can only be
   *  inferred from silence.
   *
   *  The test is where the boundary comes from, NOT whether a turn_complete
   *  event arrives — every vendor's reader emits one. pi and qwen synthesize
   *  theirs from their own 8-second quiet window, and kimi flushes the latest
   *  turn on the same timer when no following prompt closes it: the same
   *  inference one layer down, so the flag is set for those three. A vendor
   *  whose log states the boundary outright leaves it unset even when that
   *  statement is indirect: opencode (and kilo, which reuses its reader) reads
   *  a `step-finish` reason, antigravity a completed step carrying a reply,
   *  cursor an assistant row in its store.db. Records, not timers.
   *
   *  Unset MUST be trusted instead of second-guessed: activity is logged per
   *  output line, not as a heartbeat, so a CLI waiting on a long tool call —
   *  or on a permission prompt — looks exactly like a CLI that has finished.
   *  Inferring from silence there would inject text and a newline into a pane
   *  that is mid-task, and into a y/n prompt would answer it. */
  turnEndInferredFromSilence?: boolean
  /** Detection of this CLI's expired-login message in a pane's clean PTY
   *  output, plus the command typed into the CLI to recover. Undefined = the
   *  CLI's expired-login message has not been identified yet (only claude's
   *  has). Matching runs on a whitespace-collapsed buffer tail — see
   *  lib/cliLoginExpired.ts. */
  loginExpired?: {
    /** Matches the CLI's login-expired error in a buffer tail slice. */
    pattern: RegExp
    /** Command typed into the CLI to start a re-login. */
    loginCommand: string
  }
  /** Recognizes this CLI parked on the user — a permission/confirmation box or
   *  a direct question — in the pane's RENDERED screen text. Undefined = the
   *  vendor reports the state out of band, or its prompt shape has not been
   *  identified, and the pane keeps the plain idle/running behaviour. Matched
   *  against the rendered buffer rather than the raw stream so an answered
   *  prompt disappears on its own when the TUI repaints over it — see
   *  lib/cliAwaitingInput.ts. */
  awaitingInput?: {
    /** Matches the live prompt in the last rendered screen lines. Anchor it on
     *  the part that only exists while the prompt is WAITING (its option list
     *  or input marker), not on the question text, which survives in the
     *  scrollback of line-mode CLIs after the answer. Must not carry /g —
     *  test() is stateful with it and the watcher re-runs on the same text. */
    pattern: RegExp
    /** Whether a poll that does NOT match should clear the state. True (the
     *  default) for a vendor whose only signal is this pattern: the match IS
     *  the state, so losing it means the prompt is gone.
     *
     *  False for a vendor that also has a notification hook. There the screen
     *  is a second, additive source — it catches boxes the hook never reports
     *  (claude's AskUserQuestion) and covers a hook that failed to reach the
     *  backend — but it does not see everything the hook does (an MCP
     *  elicitation paints no option box), so a non-match is not evidence the
     *  wait ended and must not clear what the hook raised. Nothing leaks: a
     *  screen-raised wait ages out through the settle window as soon as real
     *  output lands, and the hook's own release path still runs. */
    clearsOnMiss?: boolean
  }
  /** This CLI's folder-trust prompt at launch, and the keys that accept it.
   *  Navide answers it for every pane it spawns, fresh or resumed, while the
   *  pane's first screen is up (lib/startupTrust.ts) — the same acceptance the
   *  marker bootstrap's dismissStartupDialog gives a fresh pane. Matched on the
   *  RENDERED, whitespace-collapsed screen, so a transcript replayed on resume
   *  that merely quotes the prompt is not mistaken for it. */
  startupTrust?: {
    pattern: RegExp
    keys: string
  }
  /** This vendor's TUI keeps bracketed paste on. Enables chunked clipboard
   *  paste wrapping AND serves as the default Shift+Enter encoding (bracketed
   *  LF inserts a literal newline without submitting). */
  bracketedPaste?: boolean
  /** This vendor draws its CONVERSATION in the terminal's alternate screen
   *  buffer (verified per vendor by probing the PTY / the shipped binary for
   *  `ESC[?1049h`), so a scrollback snapshot taken with `excludeAltBuffer: true`
   *  comes back all but empty. Set it and the snapshot includes the alt buffer
   *  instead — see serializeSnapshot in useTerminal.
   *
   *  Ceiling: xterm keeps NO scrollback for the alternate buffer, so what this
   *  recovers from a running session is the LAST SCREENFUL, never the whole
   *  conversation. (History does accumulate across restarts, because each
   *  replayed snapshot lands in the normal buffer the next one serializes.)
   *
   *  Leave it unset for anything whose full-screen views are TRANSIENT — a
   *  plain shell where the user opens vim or a pager, or a line-mode CLI whose
   *  conversation is already in the normal buffer. Saving a pager's screen as
   *  "history" is exactly what excludeAltBuffer exists to prevent. */
  fullScreenTui?: boolean
  /** Explicit Shift+Enter byte sequence when the vendor prefers something
   *  other than the bracketed-paste LF default (codex: CSI-u modified Enter).
   *  There is no vendor-neutral byte sequence for a modified Enter key in a
   *  traditional PTY — see encodeShiftEnter(). */
  shiftEnterSequence?: string
  /** Fresh (non-resume, non-login) panes embed an `at-pane:<paneId>` marker
   *  in this vendor's kickoff so the backend can match the resulting CLI
   *  session file back to the pane (these CLIs can't pin a session id at
   *  launch). Claude needs no marker: its sessions are attributed by encoded
   *  cwd instead. */
  needsSessionMarker?: boolean
  /** This vendor's log reader carries turn text that has been validated
   *  against real sessions, so turn-text judging (sentinel detection etc.) is
   *  authoritative and the loose in-buffer scan is skipped. Deliberately
   *  conservative: copilot, aider, kimi, qwen, pi, grok, cursor, muse,
   *  opencode, kilo and antigravity carry turn text too — enough for inter-CLI
   *  messaging, which only needs the text — but their readers have not been
   *  validated against real sessions, and for qwen/pi/grok/kimi the turn
   *  boundary is inferred from silence rather than read from a record. They
   *  stay unflagged and keep the buffer scan until that verification happens. */
  verifiedTurnText?: boolean
  /** This CLI accepts an inter-CLI message through something other than its
   *  PTY — an HTTP server it runs, a file it watches, a hook it leaves parked.
   *  Undefined = it has none, and every message to it is typed in.
   *
   *  The mechanism itself is the backend's (`push_delivery`); what the frontend
   *  needs from the spec is which gates still apply, because that differs per
   *  CLI and only the delivery side can know it. */
  pushChannel?: {
    /** Route label recorded on a message delivered this way, matching the
     *  backend's own kind so the log and the docs agree. */
    kind: 'tui-http' | 'input-file' | 'rewake'
    /** The push writes the CLI's composer, so it occupies the input box just
     *  as typing would and the typing hold still has to protect a half-written
     *  line. False = the text never reaches the composer, and a pane someone is
     *  typing in can take a message anyway. */
    holdsInputBox?: boolean
  }
  /** This CLI takes typed input while a turn is still running: the text lands
   *  in its own queue and is picked up at the next boundary, instead of being
   *  lost or corrupting the turn in flight. Undefined = it does not, and a
   *  message waits for the turn to end.
   *
   *  Only the turn-boundary holds (`mid-turn`, `settling`) are lifted by this.
   *  The typing hold is a different question — it protects the person at the
   *  keyboard, not the agent — and still applies.
   *
   *  Declare it per vendor and only from a real measurement. It is not a
   *  conservatism to be cleaned up: qwen aggregates several queued messages
   *  into one submission, so delivering mid-turn there merges two senders'
   *  messages into a single turn (see agents/qwen.ts). */
  acceptsMidTurnInput?: boolean
  /** Recognizes a saved command as this vendor's resume invocation (so a
   *  restore doesn't replay it as a user-custom base command). Undefined =
   *  the generic `<agentKey> --resume <id>` shape. */
  resumeCommandPattern?: RegExp
  /** Builds this vendor's ID-LESS resume arguments (aider: the lossy
   *  `--restore-chat-history`, optionally pointed at the pane's own
   *  chat-history file). Mutually exclusive with resumeArgs;
   *  buildResumeCommand ignores the session id when this is set. */
  resumeWithoutId?: (chatHistoryFile: string) => string
  /** Panes can be re-spawned via the vendor's resume command. */
  supportsRebuild?: boolean
  /** A restore may keep the SAVED session id pinned so Rebuild stays enabled
   *  (only vendors whose stale pin reliably self-heals — see resume-command). */
  supportsRestorePin?: boolean
  /** This CLI keeps its state in a per-pane home directory, so each pane needs
   *  a stable id for it — one that survives a restore even when the pane id
   *  changes. Only codex: its `CODEX_HOME` holds the rollout a resume reads
   *  back, so a pane that lost its home cannot resume at all. */
  needsSessionHome?: boolean
  /** Repairs a persisted session id into the form this vendor's resume command
   *  accepts. Undefined = the id is already canonical. Only codex needs one:
   *  older builds could persist a rollout filename before session_meta was
   *  readable. */
  normalizeSessionId?: (sessionId: string) => string
  /** A saved conversation this vendor cannot currently resume is data, not
   *  permission to start a replacement: keep the pane's record untouched and
   *  leave a fresh spawn to the user. Vendors without this get the opposite
   *  treatment — a warning plus a fresh pane. */
  preserveMissingSessionOnRestore?: boolean
  /** This CLI accepts a session id at launch, so a fresh pane can pin one
   *  instead of waiting for the log reader to attribute it. `flag` is the
   *  argument that carries it; `handwritten` recognizes an id the user typed
   *  into a custom command (the pin is then theirs, not ours). claude and grok. */
  pinsSessionIdAtLaunch?: {
    flag: string
    handwritten: RegExp
    /** The id this CLI wants, when a random UUIDv4 is not it (grok's are
     *  UUIDv7). Undefined = the caller's generator. */
    generateId?: () => string
  }
  /** What this CLI's usage windows (the backend's `fetch_usage` output) mean
   *  for quota-exhaustion failover — which kinds are account-level limits,
   *  which must be present before a reading counts as "has quota", which
   *  pool substitutes for a spent one, which are per-model. Undefined = not
   *  declared: a reading may show a spent window but never counts as
   *  positive headroom (per-model or per-provider vendors, and vendors with
   *  no usage fetcher). Read by lib/quotaFailover.ts. */
  quotaSemantics?: {
    hard: readonly string[]
    required: readonly string[]
    alternate?: readonly string[]
    scoped?: readonly string[]
  }
  /** This CLI's own out-of-quota notice, as it prints it, matched on a
   *  whitespace-collapsed buffer tail. The one piece of free text that counts
   *  as an explicit exhaustion signal for the vendor; generic wording never
   *  does. Undefined = no verified notice text (the vendor reports exhaustion
   *  through its usage windows, or its text has not been captured yet). */
  quotaExhausted?: {
    /** The notice as printed in the pane. */
    pattern: RegExp
    /** A structured signal instead of (or besides) text: the `detail` a
     *  turn_complete carries when this CLI's own log names the turn's
     *  outcome (droid's agent_turn_outcome.reason). Compared verbatim. */
    turnDetail?: string
  }
  /** A pane whose saved session left no transcript ("ghost") can be repointed
   *  at a real one from the same workspace instead of silently starting over.
   *  Requires a vendor whose sessions are attributable by cwd. Only claude. */
  supportsGhostReconnect?: boolean
  /** Where this pane's per-pane files live (its git root, else its cwd) — only
   *  for a vendor that writes them, and needed at spawn time to build
   *  `paneArg`'s context. Only aider. */
  paneHistoryRoot?: (cwd: string, listDir: DirLister) => Promise<string>
  /** The history file this pane must RESUME from, for a vendor whose resume
   *  reads one back (see `resumeWithoutId`). '' when there is none. Only
   *  aider. */
  resumeHistoryFile?: (
    workspacePath: string,
    paneId: string,
    listDir: DirLister,
  ) => Promise<string>
}
