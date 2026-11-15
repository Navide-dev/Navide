/** Aider — per-vendor agent spec (see types.ts; assembled by index.ts). */

import {
  aiderChatHistoryFlag,
  aiderHistoryPath,
  paneHistoryRoot,
  resumeHistoryFile,
} from './aider/history'
import { declared } from './_declared'
import type { AgentSpec } from './types'

export const SPEC = {
  agentKey: 'aider',
  // Label, command and flags: the launch declaration. No model flag,
  // deliberately: aider passes any model string straight through to litellm,
  // so a wrong value cannot be caught before launch. Its unattended flag,
  // --yes-always, auto-confirms every prompt (edits, shell commands, adds).
  ...declared('aider'),
  // Give every pane its own chat history: the default shared
  // `<git-root>/.aider.chat.history.md` merges all panes' token accounting.
  paneArg: (ctx) => aiderChatHistoryFlag(aiderHistoryPath(ctx.historyRoot, ctx.paneId)),
  // Both sides of that per-pane file: where it lives (spawn) and which one to
  // read back (resume). App.vue asks the spec for these instead of holding an
  // `agent !== 'aider'` guard of its own.
  paneHistoryRoot,
  resumeHistoryFile,
  // Aider has no session ids; its resume command is id-less. Resume is always
  // the lossy --restore-chat-history, reading the pane's chat-history file
  // when one is known (empty falls back to aider's default shared file).
  resumeWithoutId: (chatHistoryFile) =>
    [chatHistoryFile ? aiderChatHistoryFlag(chatHistoryFile) : '', '--restore-chat-history']
      .filter(Boolean)
      .join(' '),
  resumeCommandPattern: /^aider\b.*--restore-chat-history\b/,
  needsSessionMarker: true,
  // Aider's confirmation suffix, e.g.
  //   Add file to the chat? (Y)es/(N)o/(A)ll/(S)kip all/(D)on't ask again [Yes]:
  //   Run shell command? (Y)es/(N)o/(S)kip all/(D)on't ask again [Yes]:
  // The choice letters and the default-in-brackets are assembled in one place
  // (io.py) for every question, so matching the suffix covers all of them
  // without enumerating the question texts. They are hardcoded English with no
  // translation layer, so this does not move with the user's locale.
  //
  // Anchored at the END because aider is line-mode, not a full-screen TUI: an
  // answered question stays in the scrollback. The rendered text is read
  // upwards from the CURSOR, so the prompt is last only while aider is
  // actually sitting on it — once the answer is typed and output resumes, the
  // line is no longer the tail and stops matching.
  awaitingInput: {
    pattern: /\(Y\)es\/\(N\)o(\/\(A\)ll)?(\/\(S\)kip all)?(\/\(D\)on't ask again)? \[[^\]]+\]:\s*$/,
  },
  hint: 'generalist',
  // No quotaExhausted on purpose (aider 0.86.2, exceptions.py): its
  // RateLimitError text folds a 429 and an exhausted quota into one sentence,
  // BudgetExceededError is litellm's local budget, and neither reaches the
  // chat history. Exhaustion cannot be attributed, so the failover only ever
  // notifies for aider; this stays a Phase A todo until the vendor prints a
  // distinguishable notice.
} as const satisfies AgentSpec
