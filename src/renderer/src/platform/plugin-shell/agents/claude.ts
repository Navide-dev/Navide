/** Claude Code — per-vendor agent spec (see types.ts; assembled by index.ts). */

import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'claude',
  label: 'Claude Code (Anthropic)',
  defaultCommand: 'claude',
  // `--effort` warns and falls back to the default on an unknown value
  // (exit 0), so an unchecked typo would run at the wrong effort and look
  // like it worked — hence knownEfforts. `ultracode` is deliberately absent:
  // it is a Claude Code orchestration mode, not a model effort level.
  modelArgs: (m) => `--model ${m}`,
  effortArgs: (e) => `--effort ${e}`,
  knownEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  skipPermissionFlag: '--dangerously-skip-permissions',
  resumeArgs: (id) => `--resume ${id}`,
  supportsRebuild: true,
  verifiedTurnText: true,
  bracketedPaste: true,
  // Measured on a real PTY: Claude Code emits `ESC[?1049h` within the first
  // dozen bytes of startup and keeps the conversation there.
  fullScreenTui: true,
  // Claude Code prints "Login expired · Please run /login" (also seen as
  // "Error during compaction: Login expired · Please run /login"). Require
  // BOTH "Login expired" and the nearby "Please run /login" instruction so
  // ordinary output that merely mentions the phrase (e.g. this very CLI's
  // assistant text discussing /login) can't spuriously match — the real error
  // always carries both, separated only by " · ". Tolerant of any whitespace
  // run between words (a narrow pane hard-wraps mid-phrase); a trailing
  // boundary after /login keeps "/login-helper" / "/login2" below the
  // threshold.
  loginExpired: {
    pattern: /login\s+expired.{0,40}?please run\s+\/login(?:\s|$)/i,
    loginCommand: '/login',
  },
  // Restore-pin self-heals: the turn event's attributed id is adopted directly.
  supportsRestorePin: true,
  // A fresh pane can name its own session instead of waiting for the log
  // reader to attribute one. `handwritten` recognizes an id the USER typed
  // into a custom command — Claude only accepts a UUID here, so a strict match
  // is the deterministic parse and anything else yields no pin.
  pinsSessionIdAtLaunch: {
    flag: '--session-id',
    handwritten:
      /--session-id[=\s]+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![0-9a-fA-F-])/,
  },
  // Sessions are attributed by encoded cwd, so a pane whose saved id left no
  // transcript can be repointed at a real session from the same workspace.
  supportsGhostReconnect: true,
  // A background hook parked on the backend, woken with the envelope on its
  // stderr. It reaches the agent as a system reminder, never the input box, so
  // a pane someone is typing in can still take a message.
  //
  // This is the idle half of Stop-hook delivery, not a replacement for it: the
  // Stop hook covers a message that arrives while the agent is working, and the
  // push gate keeps this channel out of mid-turn even though acceptsMidTurnInput
  // lifts that hold for the typed path (see pushTargetForMessaging).
  pushChannel: { kind: 'rewake', holdsInputBox: false },
  // Measured against the running CLI: text written to its PTY during a turn is
  // queued by Claude itself and picked up at the next boundary — the same path
  // a person typing mid-turn uses, and it lands the same way. Holding messages
  // back until the pane fell idle was what made a reply from a busy pane take
  // 78s where the other direction took 2s; the queue this lifts into is the
  // CLI's own, so nothing is racing the turn in flight.
  acceptsMidTurnInput: true,
  // Claude has a Notification hook, and it stays the authoritative signal —
  // but it cannot cover every box that parks the pane on the user, so the
  // screen is read as well and whichever fires first wins:
  //
  //  • A permission prompt does fire the hook, yet the hook is a single event
  //    that can be lost outright (a settings.json rewritten by something else,
  //    an unreachable backend); the screen keeps asserting for as long as the
  //    box is painted.
  //  • AskUserQuestion has no notification type of its own, and its record
  //    only reaches the conversation log once the ANSWER is written — measured
  //    at 5m16s after the box appeared, in the same batch as the event that
  //    clears it. The log route is structurally too late; only the screen is
  //    on time.
  //
  // Several anchors, any one of which is enough. The first is the permission box's
  // last option, identical across its edit / command / MCP variants. The
  // second is the option-picker footer, which AskUserQuestion and the
  // permission box both draw and neither leaves behind: answering repaints it
  // away, and the watcher re-checks every poll, so a stale match cannot hold.
  // The gap is bounded because `matchAwaitingInput` collapses whitespace to
  // single spaces before testing, and the footer's own separators vary.
  // The two-option box (`Do you want to proceed?` / `1. Yes` / `2. No`) has
  // neither, so a third anchor is its `Esc to cancel · Tab to amend` footer.
  // A live box REPLACES Claude's input box, so after an anchor only a bounded
  // tail may follow, and it must not draw the idle input prompt: a `❯` or `>`
  // right after a frame character (`────` then `❯`, or the framed `│ >` older
  // builds draw). A statusLine, a hint row and blank rows fit the tail, and so
  // do border rows, which the 300-character bound does not count because one
  // spans the pane width and the #416 guard reads the screen with them kept.
  // The same words quoted in conversation sit above the idle input box, so the
  // prompt row after them rules the match out — matching those parked an idle
  // pane on AWAITING. The mirror case is a draft typed into the idle box that
  // ends on an anchor phrase: the prompt row sits BEFORE the anchor, with no
  // frame run between them, so the lookbehind rules it out. Only a run of 16 or
  // more frame characters (a rule or border row, which spans the pane) ends the
  // input box; a lone `│` side border or the corners of a pasted table do not.
  // A numbered cursor row (`❯ 1. Yes`)
  // is a live dialog's own option, not a prompt. Bash mode draws `!` for the
  // prompt, so it counts as one in both directions.
  awaitingInput: {
    pattern:
      /(?:No, and tell Claude what to do differently(?: \(esc\))?|Enter to select ·.{0,80}?Esc to cancel|Esc to cancel ·.{0,20}?Tab to amend)(?<![─-╿] ?(?:[❯>](?! ?\d+[.)])|!(?= ))(?:[^─-╿]|[─-╿](?![─-╿]{15}))*)(?!.*[─-╿] ?(?:[❯>]|!(?= )))(?:[─-╿]*[^─-╿]){0,300}[─-╿]*$/,
    // Additive to the hook, never authoritative over it: an MCP elicitation
    // draws no option box, so a non-match here says nothing about a wait the
    // hook raised. See the field's own doc comment.
    clearsOnMiss: false,
  },
  hint: 'planner + reviewer',
  // Quota failover (lib/quotaFailover.ts). Windows from the backend's
  // normalize_claude: five_hour → session, seven_day → weekly, both always
  // present; per-model seven_day_* / weekly_scoped → weekly-model, which is
  // never a veto (a spent promotional bucket does not block the account).
  quotaSemantics: { hard: ['session', 'weekly'], required: ['session', 'weekly'], scoped: ['weekly-model'] },
  // Claude Code's own limit banner, with the reset clock that names WHICH
  // window ran out (loopPrompt.SESSION_LIMIT_RE parses it). The clockless
  // "hit your limit" alone is prose until the account's reading agrees.
  quotaExhausted: {
    pattern: /hit your .{0,40}limit.{0,80}?resets\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*\([^)]+\)/i,
  },
} as const satisfies AgentSpec
