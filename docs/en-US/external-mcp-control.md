# External MCP Control

Navide exposes an MCP (Model Context Protocol) endpoint, `/plan-mcp`, that a
CLI agent running in a Navide pane uses automatically. That same endpoint can
also be opened to a client outside Navide's own process tree — a script, an
AI agent running elsewhere, or any MCP-capable tool — so it can drive a
running Navide window: open panes, invoke UI actions, read another agent's
conversation log, and manage plan documents.

This is off by default. Turning it on means **any process running on your
Mac can control Navide** — see [Security model](#security-model) before
enabling it.

For the two directions every pane already gets automatically (Navide handing
tools to its own CLI agents, and Navide consuming external documentation MCP
servers during a pipeline run), see the "說明" tab under Settings → MCP in
the app ([`McpHelp.vue`](../../src/renderer/src/components/McpHelp.vue)).
This document covers the third, opt-in direction: an external client
controlling Navide.

## Connecting

1. Open **Settings → MCP → External access** and turn on **Allow external
   MCP clients**.
2. Copy the **Connection URL**. It has the form:

   ```text
   http://127.0.0.1:<port>/plan-mcp?client=external&t=<token>
   ```

   `<port>` is the backend's current port (it is chosen dynamically at
   launch, so the URL changes across restarts — re-copy it after restarting
   Navide) and `<token>` is a bearer secret scoped to external callers only.
3. Point your MCP client at that URL over **streamable HTTP**. No further
   handshake or registration is needed — every tool call is authenticated by
   the token in the URL's query string.
4. **Regenerate token** in the same panel invalidates the old token
   immediately and mints a new one; use it if a URL may have leaked.

The endpoint only accepts three kinds of caller credential: a pane's own
credential (minted when Navide spawns a claude/codex pane), this backend's
internal "host" credential (used by its own CLI wiring), and the external
credential described above — gated on the Settings toggle. An external
caller has no pane identity and therefore no workspace of its own: every
tool that addresses a pane (`cli_send`, `cli_send_and_wait`, `cli_read_log`,
`cli_get_status`, `cli_wait_idle`) requires the fully-qualified `<folder>/<pane>` form rather
than a bare pane name — or a `pane_id`, which names one exact pane and is
already fully qualified — and every tool that addresses UI state
(`ui_invoke`, `ui_snapshot`, `ui_list_actions`) or a plan document
(`plan_*`) requires an explicit `workspace_path` — a caller running as a
pane may omit it and get that pane's own workspace. Having no pane also means
having no tab group: `cli_send`'s `to: "group"` broadcast is refused with
`no-group` for a host or external caller, which has neither a group of its own
to fan out to nor a window to ask about one. Address the panes individually, or
by `pane_id`.

Implementation: [`mcp_server/server.py`](../../backend/agent_team_backend/mcp_server/server.py)
(tools), [`mcp_server/auth.py`](../../backend/agent_team_backend/mcp_server/auth.py)
(credential store, `plan_mcp_auth.json` under the app data directory), and
[`mcp_server/wiring.py`](../../backend/agent_team_backend/mcp_server/wiring.py)
(pane/host wiring — not needed for an external client).

## Tool catalog

### Plan documents

| Tool | Parameters | What it does |
|---|---|---|
| `plan_list` | `workspace_path` | List plan documents under `.agent-team/plans/`: `rel_path`, `name`, `stage`, `overview`, `todos` summary, `mtime` |
| `plan_read` | `workspace_path`, `rel_path` | Read one plan's parsed meta and raw HTML |
| `plan_create` | `workspace_path`, `name`, `overview`, `todos` | Create a plan from the template, starting at stage `draft` |
| `plan_update_stage` | `workspace_path`, `rel_path`, `stage` | Set stage: `draft`, `in-review`, `approved`, `in-progress`, `done`, `abandoned` |
| `plan_update_todo` | `workspace_path`, `rel_path`, `todo_id`, `status` | Set one todo's status: `pending`, `in-progress`, `done`, `skipped` |
| `plan_add_note` | `workspace_path`, `rel_path`, `text`, `author?` (`ai`\|`user`, default `ai`) | Append a review note |

`workspace_path` is required here because an external client is not a pane;
a pane caller omits it and the tools use that pane's own workspace, which is
what the plan window resolves plans against.

`plan_create` returns a `warning` field when `workspace_path` doesn't match
any live pane's workspace — the file is written, but Navide's plan window
won't find it.

`plan_list` returns a list, and MCP delivers a list as **one content block
per item** rather than a single JSON array. Concatenating the blocks and
parsing once fails with `Extra data`; parse each block on its own, or read
the call's `structuredContent`. Every other tool here returns a single
object, so this only bites on `plan_list`.

### CLI panes — messaging and spawning

These tools feed the same delivery queue an agent reaches by printing a
bare-line `---MSG-START---` block; [Inter-CLI messaging](inter-cli-messaging.md)
documents the addresses, the idle gate and the guard rails they share.

| Tool | Parameters | What it does |
|---|---|---|
| `cli_list_targets` | — | List addressable CLI panes: `name`, `address`, `pane_id` (the key every `ui.pane.*` action takes, and an alternative to `address` on the pane tools below), `workspace_path`, `same_workspace`, `busy`, `realized` (false for a restore placeholder: no CLI is running behind it, so it is busy forever and a message parks until someone opens it — `ui.pane.open`, or `cli_send(open_target=true)`), `hold_reason?` |
| `cli_whoami` | — | **CLI panes only.** Your own identity, in the same shape the roster describes a peer: `{ok, caller, name, address, pane_id, workspace_path, agent_key, busy, offline, realized, delegation_hint, hold_reason?, surface?, window_kind?, spawned_by?, waiting_on_me?}`. `delegation_hint` restates the delegation rule (below, under `cli_open_agent`) for a pane that never read the server instructions. `pane_id` is what every `ui.pane.*` action takes, so this is what lets a pane act on itself; `spawned_by` names the pane that opened you (`{pane_id, gone: true}` once it has closed) |
| `cli_send` | `to` (a pane address, or `"group"` to broadcast), `text`, `wait_for_delivery_s=0` (capped at 120), `pane_id?`, `reply_to?` | Deliver an instruction to another pane once it's idle (queued if busy); returns `msg_key`, and with a wait, what became of it. To a plain terminal pane (`agent_key: "terminal"`) the text is typed bare and **runs as a shell command with the user's privileges**; terminals are skipped by `"group"` and refuse chat-channel content — see [Plain terminal panes](inter-cli-messaging.md#plain-terminal-panes) |
| `cli_check_message` | `msg_key` | What became of one `cli_send`: `{status, target, age_seconds, reason?, settled_after_s?, hold?, held_for_s?, stale?}` |
| `cli_cancel_message` | `msg_key` | Withdraw a message you sent, if it has not gone in yet. Decided by the window owning the recipient's queue: still waiting → dropped and the status becomes `cancelled`; delivery already started → the withdrawal is ignored and you are told what it settled as. A withdrawal is not a failure and writes no notice back to you. Returns `{ok, msg_key, status, reason?}` |
| `cli_inbox_summary` | — | Your own sends that are stuck or failed: `{count, messages: [{msg_key, target, status, age_seconds, stale?, reason?, hold?, held_for_s?, excerpt}]}` |
| `cli_pending_incoming` | `limit=20` (capped at 200) | **CLI panes only.** What is queued *for you* and has not gone in yet: `{count, messages: [{uid, sender, status, age_seconds, kind?, excerpt, correlation_id?, in_reply_to?, hold?, held_for_s?, stale?}]}` |
| `cli_read_incoming` | `uid=""`, `limit=5` (capped at 20), `include_delivered=false`, `peek=false` | **CLI panes only.** The full text of messages sent to you, where `cli_pending_incoming` gives 200 characters with the whitespace flattened: `{count, messages: [{uid, sender, status, kind?, content, age_seconds, consumed, correlation_id?, in_reply_to?, hold?, held_for_s?, stale?}], note?}`. **Reading consumes by default** — a message you read is not typed into your pane afterwards. `peek: true` reads without consuming. Consuming is reserve-then-release, so a lost release returns the message to the queue and it may arrive a second time; `consumed` is reported per message and `note` explains any that were not |
| `cli_send_and_wait` | `to`, `text`, `timeout_s=60` (capped at 120), `pane_id?` | `cli_send` plus the wait for that turn to finish; returns `cli_wait_idle`'s result plus `{ok, target, msg_key}`  **Remote panes**: send and delivery gate work as they do locally (`rejected` stays distinct from `failed`); the wait half uses the roster badge with the same weaknesses as `cli_wait_idle`. |
| `cli_open_agent` | `agent`, `name`, `task`, `workspace_path` (required for a non-pane caller), `model`, `effort`, `pane_id?`, `session_id?`, `run_group_id?` | Spawn a new CLI pane with a task; returns `{ok, name, address, pane_id}`, plus `advisories` when the spawn crossed an advisory threshold. **Delegation rule** (also in the server instructions): work that edits files, runs longer than a few minutes, or that the user may want to watch, interrupt or take over goes to a pane opened here — not to the agent's own subagent facility (Claude Code's `Agent` / `Task` tools). A pane is visible in Navide, can be opened mid-run and outlives the caller's session; a subagent is a black box that hands back one summary. Subagents stay the right tool for short read-only lookups whose whole result is a paragraph. `model` and `effort` are optional and are refused — not ignored — when that CLI cannot take them, so a pane never quietly starts on a different model than asked for. Most CLIs accept a model; fewer accept a separate effort, the rest encoding it in the model id (`gpt-5.3-codex-high`). Model ids are not validated (they change every release); effort is checked against that CLI's vocabulary. **Two ways to open onto something that already exists**, and they are not interchangeable: `pane_id` reopens a restore placeholder Navide is already holding (see `cli_list_targets`' `realized: false`), keeping its name and resuming only the one conversation its own record remembers; `session_id` opens a **new** pane onto any conversation the vendor still has on disk — including one started outside Navide in a plain terminal — using that CLI's own resume syntax (`claude --resume <id>`, `codex resume <id>`, `opencode --session <id>`, …), so it starts with that conversation's memory and `task` is then typed in as the follow-up. Read the ids from `cli_list_sessions`. The id is checked against the vendor's session store **before** the pane opens: an id with nothing on disk is refused with `unknown-session-id` rather than opening a pane that silently starts fresh, which is indistinguishable from a successful resume until you read the transcript. The two are mutually exclusive (`conflicting-target`), and aider — the one CLI with no session ids — is refused with `no-session-support`. A resumed pane answers with `resumed_session_id` and `restored_lineage`. **By default, a resume restores the conversation's previous parent and tab group**; an explicit `run_group_id` changes only the tab group. A pane's record outlives the pane — closing one marks it removed rather than deleting it — so the parent pane and tab group that conversation last sat in are still on disk, and the pane reopens under that parent, in that group, rather than parented onto the caller. A conversation that was a root pane goes back to the root. `restored_lineage` is `{spawned_by, run_group_id}`, always present on a resume, so the caller can see where it landed; `spawned_by: ""` means the root. When the project document no longer remembers the pane at all, the pane opens unparented (`spawned_by: ""`); `restored_lineage.run_group_id` is empty by default or contains the explicit `run_group_id` when one was supplied. **`agent: "terminal"`** opens a plain login-shell pane: `task` is optional — a command line typed once after the prompt, with nothing appended (no report-back instructions; a shell cannot report) — and `model`, `effort` and `session_id` are refused. It is never retyped, so an unconfirmed kickoff answers `unverified`; read `cli_read_log` before resending, because a resend runs the command again |
| `cli_close_agent` | `target`, `pane_id?` | Close a pane — the other half of `cli_open_agent`. **This ends the other agent's work**: the pane and its PTY go away, whatever turn was running dies with them, and anything queued for it is never delivered. It cannot be undone — a closed pane's session is gone, not parked, so check `cli_get_status` first; `cli_interrupt` is the softer rung and `cli_send` softer still. Returns `{ok, target, name, closed, advisories?}`, where `advisories` names what closing cost and nobody else would have reported — the pane was mid-turn, messages were queued for it, it had children that are now orphaned — gathered before the kill because none of it is knowable afterwards. Panes on this machine only: a `<device>/<workspace>/<pane>` address fails with `close-local-only`, which is a limit of this tool rather than a wrong address |
| `cli_reclaim_agent` | `target`, `pane_id?` | Reclaim a finished pane — the reversible counterpart of `cli_close_agent`. Its CLI process ends and the pane stays as a click-to-resume card holding its conversation, the status bar's "reclaim now" (`ui.pane.reclaim`) for one pane addressed like `cli_send`, in whichever window holds it. The status bar's guards apply: a busy, focused or non-resumable pane, or one with unsent input or queued messages, is refused. Returns `{ok, target, name, reclaimed}`; a refusal answers `ok: false`, `reclaimed: false`, the guard's `reason` and `error_code` `reclaim-refused`. Panes on this machine only (`reclaim-local-only`), never your own (`self-reclaim`); a window older than v0.2.16 answers `reclaim-unsupported` — update the app rather than falling back to `cli_close_agent` |

**Choosing a tab group when opening a pane.** `cli_open_agent` accepts optional
`run_group_id` for a fresh pane or a new pane opened with `session_id`:

- Omit it or pass `null` to preserve existing group selection rules: fresh
  panes opened by pane callers inherit the caller's group, resumed conversations
  use the existing saved-group and fallback rules, and standalone callers retain
  their existing defaults.
- Pass `""` to open in the manual, ungrouped tab.
- Pass an existing group ID in the target workspace to override the inherited
  or saved group. The pane's parent lineage is unchanged by this parameter.
- Invalid IDs and groups from another workspace are refused before spawning.
- An explicit group cannot be combined with `pane_id`, which reopens an existing
  pane. Use `cli_place_pane` to move that pane instead.

A successful explicit selection returns `run_group_id`; when resuming,
`restored_lineage.run_group_id` also reflects the override.

Read the current MCP tool schema before calling. Obtain IDs from
`cli_list_sessions` (`run_group_id`) for the target workspace; use a group ID
that still exists, not its display name. For example, replace the path and
group ID below with values returned for the target workspace:

```json
{
  "agent": "codex",
  "name": "Review",
  "task": "Review the change and report findings.",
  "workspace_path": "/path/to/project",
  "run_group_id": "existing-group-id"
}
```

`cli_send` returns once the message is *accepted* for delivery, not once the
other agent read it. `cli_check_message` closes that loop: `status` is
`queued` (broadcast, no window has reported back — a message held for a busy
pane stays here until it is actually injected), `delivered`, or `failed`.
On `failed`, `reason` is the receiving window's verdict: `rate-limit` (too
many messages between the same pair too quickly), `queue-full` (the target's
pending-message queue is at its cap), `inject-failed` (typing it into the
pane did not take), `pane-closed` (the target went away before delivery), or
`no-report` (the attempt never reported an outcome).

`unconfirmed` (reason `delivery-unconfirmed`) is neither of those: the text
and its Enter went into a CLI that had just been resumed, and that CLI has
not shown it received it. It was sent, and it may be running, so do not
resend on it alone — look at the pane first with `cli_get_status` or
`cli_read_log`. The status becomes `delivered` if the CLI's transcript shows
the message later.

A failure is also pushed at the sending pane without being asked for: Navide
writes a `[Navide MSG] delivery failed` notice naming the target and the
reason into that pane once it is idle, through the same queue and injection
path as an ordinary message. It is a heads-up for an agent that never polls —
`cli_check_message` stays the authoritative answer, and the notice is not
addressable, so nothing should reply to it.

**Waiting for the message to land.** Polling only closes the loop for an agent
that remembers to poll, and one that sends and moves on never learns anything.
`wait_for_delivery_s` is the in-band answer: `cli_send` waits that long for the
message to actually go in and reports what happened in the same result.

| Outcome | What comes back |
|---|---|
| It went in | `status: "delivered"`, `settled_after_s` |
| The window refused it | `status: "failed"` (or `"rejected"` from another device), `reason` |
| Still waiting when the clock ran out | `status: "queued"`, `waited_s`, plus `hold` and `held_for_s` when the receiving window said why |

`ok` stays **true** for a refusal, for the same reason `cli_send_and_wait`'s
`target_lost` does: the send happened and `msg_key` is real, so answering
`ok: false` would read as "never sent" and invite a resend that dispatches the
work twice. 10–30s is the useful range — the wait costs the caller's own turn,
and a pane that is mid-turn or being typed into can hold a message far longer.
Left at its default of `0`, the answer is byte-for-byte what it always was.

**Why a message is still queued.** `hold` is the same reason the Messages panel
shows — `{key, n?}`, where `key` is `typing`, `mid-turn`, `behind`, `starting`,
`settling`, `not-ready`, `gone`, `paused` or `remote-ack` — and `held_for_s` is
how long it has been that way. A message to another device that has gone a
minute unanswered is asked about through the server, and then reads
`remote-busy` (its target pane is mid-turn) or `remote-unreported` (it is not,
and the far side has still said nothing). It appears on `cli_check_message` and on a
timed-out `cli_send` wait, and it is absent once the message settles or while
no window has reported one. `cli_list_targets` surfaces the same fact per pane
as `hold_reason`, which is what makes `busy` explainable — but only while a
message sent from here is queued for that pane, so its absence says nothing.

**When it has been queued too long.** `stale` appears on a `queued` message once
it has been waiting more than **two minutes**, on `cli_check_message` and on a
timed-out `cli_send` wait alike. It is not a verdict — nothing has failed and
nothing has given up — it is the point at which "it is on its way" stops being a
safe assumption, so read `hold` next to it and decide whether to keep waiting,
address someone else, or say something to the user. It is measured from the send,
not from the current hold: a message flipping between `mid-turn` and `typing`
restarts `held_for_s` every time, and the case this exists for — the one where no
window ever reported a hold at all — has no hold clock to read.

**Broadcasting to your own tab group.** `to: "group"` reaches every other pane
in the caller's own tab group, in the caller's own workspace. It is deliberately
not the bare-line protocol's `all`, which means every pane in the window
regardless of group — one word meaning two scopes would be very hard to debug —
and it costs what `all` already costs: a pane actually named `group` can no
longer be addressed by name here. Panes in no group share one implicit group, so
they reach each other rather than nobody, and a broadcast from someone who never
made a group is not silently a no-op.

The answer is a different shape —
`{ok, broadcast: "group", group_id, delivered_to, recipients: [{name, pane_id, msg_key, accepted, reason?}]}` —
carrying one `msg_key` **per recipient**, because each recipient is an ordinary
independent message: its own per-pair rate-limit budget, its own idle hold, its
own delivery report. Everything above therefore applies one recipient at a time,
and each key is passed to `cli_check_message` separately; `wait_for_delivery_s`
does not apply to a broadcast and is ignored. A recipient that went away between
the window listing it and delivery is reported in place, `accepted: false` with
`reason: "target-offline"`, rather than failing the rest of the broadcast. An
empty `recipients` is not a failure — it means your group has nobody else in it.

`cli_inbox_summary` is the same fact without a `msg_key` to ask about. It takes
no arguments, answers about the caller and no one else, and returns every send of
yours that is currently stale or failed — with a 60-character `excerpt` so a
message is recognizable without having kept its key. Delivered messages and
freshly queued ones are left out, so an empty list means "nothing of mine is
stuck", never "nothing was sent". It exists for the agent a notice cannot reach:
a delivery-failure notice is typed back into the sending pane once that pane is
idle, so an agent that stays busy for an hour never sees one, and an external
client has no pane to type into at all. Calling it between pieces of your own
work is how you find out that the message you sent twenty minutes ago is still
sitting in a queue.

That table is backend **memory**, not a log: it holds the last 500 sends for
one hour and is lost on backend restart. An unknown `msg_key` returns
`{ok: false, error}` and means "not tracked any more", not "never sent".

`cli_pending_incoming` is its mirror — what is queued *for you*, oldest first,
with `status` either `queued` or `delivering` and a `kind` of `notice` or
`fallback` on the messages Navide wrote rather than an agent. **It is the one
tool in this section an external client cannot use.** Everything else here acts
*on* a pane; this one asks about the caller's own inbox, and only a CLI pane has
one: a host or external caller has no messaging name for anything to be
addressed to, so the call comes back `{ok: false, error}` rather than an empty
list. Nothing can be addressed to you, so nothing can be waiting for you. An
external client that wants the same picture from the outside reads a pane's
`hold_reason` in `cli_list_targets`, or follows its own sends with
`cli_check_message` / `cli_inbox_summary`.

Unlike the send table above, this one reads the persisted message log, so it
survives a backend restart. Two limits apply: the log is written by the
receiving window a moment after a message is queued, so something sent in the
last second may not be listed yet, and messages are matched by the pane's
**current** messaging name, so anything queued for a name it has since been
renamed away from is not returned.

`cli_send_and_wait` handles the race a manual `cli_send` + `cli_wait_idle`
pair loses to — the target is idle at the moment you send, so a plain wait
returns "already idle" before it ever read the message. It waits for the
message to **go in** first, then records the target's last activity before
sending and only accepts a *newer* turn as the answer, so `last_activity.text`
is what the other agent said in reply. Its timeout `reason` is
`cli_wait_idle`'s, plus `never_started` for a target that stayed idle and never
showed any sign of picking the message up. A send refused outright returns
`cli_send`'s `{ok: false, error}` unchanged.

`timeout_s` covers both halves: **at most half of it** goes to getting the
message in, and whatever is left waits for the turn. Time spent on delivery is
not lost — the message lands when the pane frees up, which is most of what the
idle wait would have sat through anyway — but a message still held at the
halfway mark is unlikely to be answered in what remains, and its hold reason is
a far more useful answer than "timeout, busy". When it never arrives the result
is `source: "not_delivered"` with `delivery_status` (`queued` with `hold` /
`held_for_s`, or `failed` / `rejected` with `reason`). That is the fix for a
message being held while its target sat idle: the old order answered `idle`
from the state it was sent into, which reads as "it finished your work" when
the work was never handed over. Like `target_lost`, it stays `ok: true` — do
not resend on it.

If the target stops being addressable *during* the wait — its window closed,
its pane was killed — the result is `{ok: true, idle: false, source:
"target_lost", error}`. It stays `ok: true` deliberately: the send already
happened and the `msg_key` is still valid, so reporting a failure there would
read as "never sent" and invite a resend, dispatching the work twice. Read it
as "delivered, but I can no longer confirm it was finished".

Spawning is not capped. A pane may spawn any number of children, a workspace
may hold any number of CLI panes, and a spawn chain may run any depth — past
advisory thresholds (3 children, 8 workspace panes, depth 2) the call still
succeeds and returns `advisories` naming the cost, e.g. that each pane holds
250-500MB. What still fails is a malformed request: an unknown agent key, a
missing or already-taken name, an empty task. Those advisories are also
recorded as diagnostics, readable via `ui_diagnostics`.

### CLI panes — reading back

| Tool | Parameters | What it does |
|---|---|---|
| `cli_read_log` | `target`, `tail_lines=200`, `since?`, `pane_id?` | Tail of the pane's conversation log (≤512KB and ≤`tail_lines` lines); returns `next_cursor` and `rotated` |
| `cli_get_status` | `target`, `pane_id?` | `{busy, agent_key, last_activity?, usage?, ui?}` — `ui` mirrors `ui.pane.getStatus` when the owning window answers, and carries the pane's launch identity when it has one: `agentLabel`, `model` / `effort` (what the pane was launched with — a `/model` typed inside the CLI is invisible here; absent = vendor default), `profileId` (account pin, bookkeeping only: every pane runs on the live login), `loginExpired` / `usageLimitUntil` (present only while the CLI has printed that message). `usage` is the vendor's **cached** quota snapshot — the same row `cli_usage` reports under `providers[agent_key]`, never refreshed by this call; read `fetchedAt` / `stale` for its age.  **Remote panes**: answers from the roster with `remote: true` and `source: "roster_status"` — one badge word, no `last_activity`, no `ui` block, no `usage` (this machine's cache is about this machine's logins), debounced 0.5s and swept 30s, so near-live rather than live. |
| `cli_wait_idle` | `target`, `timeout_s=60` (capped at 120), `pane_id?` | Blocks until the pane is idle or the timeout passes; returns `{idle, source, waited_s, last_activity?, ui_status?}`, plus `reason` on timeout  **Remote panes**: polls the roster badge. `source` is `roster_status` or `roster_offline`, **never** `turn_complete` — the strongest remote observation is "the badge stopped saying busy". A parked pane times out with `reason: "awaiting_unclassified"`, because the roster carries one word and cannot separate a permission prompt (waiting on a human) from a question (effectively idle). `offline` is a real third answer, returned at once rather than waited out. |
| `cli_interrupt` | `target`, `pane_id` | Send the CLI's interrupt key to a pane on this machine — `ESC` for codex, `^C` for the rest. **This does not stop a turn**: depending on the CLI it may abort the turn, merely clear the input box, or on a second press quit the CLI entirely. It is a keystroke, not a command. Verify with `cli_get_status`/`cli_wait_idle`; if the work can be allowed to finish, `cli_send` a message instead. Returns `{ok, target, name, sent, status_before, advisories?}` — `sent: false` means nothing was issued (no session, or the window was reconnecting). Local panes only |
| `cli_message_log` | `limit=50` (capped at 200) | **CLI panes only.** Your own message history — what you sent and what reached you, newest last. `cli_inbox_summary` reports only sends that are stuck and `cli_pending_incoming` only what has not been delivered yet; neither answers "what did we already say to each other" once a message has landed. This is the persisted log, so it survives a backend restart, and reading here never takes a message off anyone's queue. Only your own rows come back, matched on your current messaging name — a message queued for a name you have since been renamed away from stops matching as yours. Returns `{ok, count, messages, scanned, truncated}`; each message is `{uid, created_at, status, sender, recipient, direction, excerpt}` plus, when set, `kind` / `reason` / `delivered_at` / `correlation_id` / `reply_to` / `remote` / `remote_workspace`. `excerpt` is 200 characters with the whitespace flattened — `cli_read_incoming` is what returns a message in full. `truncated` means older rows were cut off, either by `limit` or by the window of recent rows scanned |
| `cli_list_sessions` | `agent=""`, `workspace_path`, `limit=50` (capped at 200), `include_gone=true` | The conversations in this workspace a pane could be opened onto — where the `session_id` `cli_open_agent` takes comes from. A CLI session outlives the pane that ran it: the pane closes, the app restarts, the pane is rebuilt, and the vendor's transcript stays on disk. Returns `{workspace_path, sessions, count, scanned}`, newest first; each row is `{session_id, agent_key, pane_id, pane_name, spawned_at, removed_at, starred, live, resumable, spawned_by, run_group_id}`. The last two say where a resume would put the pane back — the position that conversation last occupied, not the caller's — with `spawned_by: ""` meaning it was a root pane. **`resumable: false` is history, not an option** — the transcript is gone (or the CLI has no id-based resume) and `cli_open_agent` refuses the id; it is the vendor's own on-disk check, the same one behind the Rebuild button. `live` says the pane that owned the conversation is still open: resuming a live session into a second pane is what forks or corrupts it, because the CLI holding it does not expect a second reader — `cli_send` to that pane instead, or pass `include_gone: false` to list only live ones. `pane_id` is the pane that owned the conversation and may be long gone; it is for recognising the row, not for addressing anything. One conversation is listed once however many panes have pointed at it, since a rebuilt or restored pane writes a fresh history row carrying the same id. `scanned` says how deep into the history the call actually went — one call reads the most recent few hundred panes rather than the whole store. Read-only |
| `cli_place_pane` | `target`, `pane_id?`, `run_group_id?`, `spawned_by?` | Move a pane: change the tab group it sits in and/or the pane it is a child of — the write half of the lineage `cli_list_targets` and `cli_list_sessions` report. Two independent halves, each optional; pass only what should change, since `""` is a real value for both (the ungrouped 手動 tab, and the root of the lineage) and a half not passed is left alone. `spawned_by` takes a `pane_id`, not a name, and a stale id is resolved through the alias table. Refused when the parent is the pane itself or one of its descendants (the tree would loop), a pane in another workspace, or a group no tab has. Group is applied first, then parent, and `applied` in the answer says which halves landed — a parent refusal does not undo a group move that already did. Same write paths as dragging the pane in the sidebar, so the record and the screen agree and a restart keeps the position. Does not touch the pane's CLI. Local panes only. Returns `{ok, target, name, pane_id, applied, run_group_id, spawned_by}` with the position afterwards |

`cli_read_log`'s `since` reads incrementally: pass back the `next_cursor` from
your previous call to get only what the pane has said since then, instead of
re-reading the same tail. The cursor is a byte offset into an append-only
capture file, so it stops meaning anything if that file is truncated or
replaced — the call then returns a plain tail with `rotated: true`, which is a
fresh start rather than new output.

`cli_wait_idle`'s `last_activity` is what `cli_get_status` reports under the
same key, so a caller that waited out a turn also gets what the turn said
without a second call; `ui_status` is the owning window's own word for the
pane, present only when a probe reached it during the wait. On timeout,
`reason` separates three failures that look alike but aren't: `awaiting` (the
pane is parked on a permission prompt, waiting on a **human** — answer it in
the UI), `busy` (it really is still working; wait longer), and `unreachable`
(the window that owns the pane stopped answering, so nothing in the result is
current).

**Capability boundary — idle/completion detection.** Most CLIs' log readers
emit a `turn_complete` event carrying the finished turn's text: **aider,
antigravity, claude, codex, copilot, cursor, droid, grok, kilo, kimi, muse,
opencode, pi, qwen**. For those, `cli_wait_idle` and `cli_get_status`'s
`last_activity.type` resolve on the precise turn-complete signal — with one
qualification: **kimi, pi, qwen** have no end-of-turn record of their
own and synthesize `turn_complete` from 8 seconds of silence in the log, so
for those three the event is itself an inference, and a long enough pause
mid-turn can end the wait early. For a plain terminal pane there is no such
signal at all —
`cli_wait_idle` settles once the pane stops printing and reports
`source: "quiet_period"`, and `cli_get_status` carries no `last_activity` for
it (its `agent_key` is `"terminal"`). A terminal is a shell: text sent to it
runs as a command line with the user's privileges — see
[Plain terminal panes](inter-cli-messaging.md#plain-terminal-panes).
Treat a quiet-period-based idle result as a heuristic, not a guarantee the
CLI has actually finished.

This is also why `source` is the field to read on a `cli_send_and_wait`
result: the shape is identical whichever CLI produced it, but the confidence
is not. `turn_complete` from aider/antigravity/claude/codex/copilot/cursor/droid/
grok/kilo/muse/opencode is the CLI's own word that the turn ended; the same value
from kimi/pi/qwen is the 8-second-silence inference above; and
`quiet_period` — the only outcome available for a plain terminal pane —
means nothing reported an end of turn at all, so check the content
rather than trusting the signal. `target_lost` is the fourth value and the
only one that is not a verdict on the turn: it says the pane went away before
the wait could reach one.

### UI action bus

| Tool | Parameters | What it does |
|---|---|---|
| `ui_list_actions` | `workspace_path` | List every command id registered in the Navide window that owns `workspace_path` |
| `ui_invoke` | `workspace_path`, `action`, `args?` | Invoke one registered action, passing `args` through verbatim |
| `ui_snapshot` | `workspace_path` | Structured snapshot of that window's UI state |
| `ui_diagnostics` | `workspace_path`, `since_seq=0`, `pane_id`, `limit=50` | Renderer-side diagnostics that window recorded about its own UI actions — e.g. `injectText` resending content because its echo check timed out, or giving up entirely — which a `ui_invoke` caller cannot see from `ok: true` alone, and which used to appear only in that window's devtools console. Use it when a tool reported success but the in-window behaviour looked wrong (duplicated input, a stuck send). `since_seq` returns only entries after that sequence number, so passing a previous call's `nextSeq` polls incrementally |

All three wait up to 15 seconds for the owning window to reply, and error if
no window currently has `workspace_path` open (compared by exact string —
pass the same path the window was opened with). `ui_invoke`'s `action:
"ui.workspace.open"` is the one exception: since no window may yet own that
workspace, it is routed to any one live Navide window instead of the one
matching `workspace_path`.

The path match applies to a caller with no pane identity — an external client
or the host wiring. A call from a Navide CLI pane naming that pane's own
workspace is delivered straight to the window hosting that pane, whether or not
it is focused and whatever project it currently has open, so a pane can always
reach its own window; naming a different project keeps the broadcast path, so a
deliberate cross-window call still reaches the window that has that project
open.

Reaching the window is not the same as running against `workspace_path`.
Actions that act on "the project this window is showing" — `ui.pane.create`,
`ui.preview.show`, `ui.window.openGit` — are refused with an error when the
hosting window has since switched project, rather than silently acting on the
wrong one. The read-only ops (`ui_snapshot`, `ui_list_actions`,
`ui_diagnostics`, `ui.pane.getStatus`) answer either way and describe the
window as it actually is.

`ui_list_actions` returns the *entire* command registry the window uses for
its keybindings, not only the `ui.*` ids below — internal ids (e.g.
`workbench.action.*`) exist for keyboard shortcuts and are not a documented
external contract; only the `ui.*` actions in the table below have stable,
documented argument shapes.

#### `ui.*` action reference

| Action | Args | Effect |
|---|---|---|
| `ui.settings.open` | `{tab?}` (one of `general`, `mcp`, `analyzer`, `updates`, `appearance`, `accounts`, `keybindings`) | Open Settings, optionally to a specific tab |
| `ui.settings.close` | — | Close Settings |
| `ui.settings.yolo` | `{yolo?}` | Read the global CLI permission-bypass switch, or set it when `yolo` is passed. Returns `{yolo, agents}`, each agent being `{agent, mode, skipFlag}`. Not workspace-scoped: any window answers it, and `skipFlag` — not `yolo` — is the per-vendor answer |
| `ui.pane.create` | `{agent, name?, task?}` | Spawn a pane for `agent` in the window's open workspace; `task`, if given, is sent as the kickoff prompt and skips role injection |
| `ui.pane.close` | `{paneId}` | Kill a pane |
| `ui.pane.focus` | `{paneId}` | Reveal and focus a pane (switches tab if needed) |
| `ui.pane.open` | `{paneId}` | Open a restore placeholder (a pane whose `cli_list_targets` row says `realized: false`) and wait for it. Returns `{realized, reason, paneId}` — `paneId` is the id the pane is known by afterwards, `reason` is `opened`, `fresh` (a new session, no memory of the old one), `already-open`, or why it stayed closed. Under resume behavior `ask` it does not raise the modal |
| `ui.pane.getStatus` | `{paneId}` | Returns `{status, buffer, logPath?, awaitingKind?, kickoff?, agentLabel?, model?, effort?, profileId?, loginExpired?, usageLimitUntil?}` for that pane — the identity keys only when the pane has a value for them |
| `ui.pane.interrupt` | `{paneId}` | Press that pane's interrupt key. Returns `{sent, status, advisories?}` — the status is read *before* the press, because the press changes the very thing being reported |
| `ui.pane.reclaim` | `{paneId}` (one id or an array) | Free finished panes' resources: each CLI process ends and the pane stays as a click-to-resume card, the status bar's "reclaim now". Busy or awaiting, focused, unsent-input, queued-message and non-resumable panes are refused. Returns `{reclaimed, refused: [{paneId, reason, detail}]}` |
| `ui.pane.place` | `{paneId, runGroupId?, spawnedBy?}` | Move a pane to a tab group and/or make it a child of another pane. Each key is optional and independent; `""` is a value (ungrouped tab / root), an absent key is left alone. Group first, then parent. Returns `{paneId, applied, runGroupId, spawnedBy}`. The action behind `cli_place_pane` |
| `ui.tab.switch` | `{tabId}` | Switch the active stage/run-group tab |
| `ui.preview.show` | `{kind, …}` | Show a file, diff or inline snippet in the right rail's preview panel |
| `ui.window.openPlans` | `{rel_path?}` | Open the Plan window; with `rel_path` (`.agent-team/plans/<name>.html`, relative, no `..`) it opens focused on that one plan document |
| `ui.window.openResourceManager` | — | Open the Resource Manager (CPU, memory and disk usage, with storage cleanup) |
| `ui.window.openTurnStats` | — | Open Turn Stats (per-turn token usage of one CLI pane) |
| `ui.window.openGit` | — | Open the Git window for the current workspace |
| `ui.window.openPipeline` | `{pipelineId?}` | Open the Pipeline Manager window |
| `ui.workspace.open` | `{path}` | Open `path` as a workspace (routed to any live window — see above) |
| `ui.workspace.switch` | `{path}` | Switch this window to a workspace it already holds; panes are kept. A path the window does not hold is refused (use `ui.workspace.open`) |
| `ui.layout.setMode` | `{mode}` | Change the pane layout mode |
| `ui.pipeline.start` | `{task?, pipelineId?}` | Start a pipeline run in the window's open workspace. Errors when no workspace is open, when a run is already running (abort it first), when no `pipelineId` was given and the workspace has none selected, or when the run never reached `running`. Returns `{pipelineId, stages, workspacePath, state}` |
| `ui.pipeline.abort` | — | Abort the run in progress; errors when nothing is running rather than answering ok for a no-op. Returns `{workspacePath, state}` |
| `ui.pipeline.next` | — | Advance the running pipeline to its next stage now. Errors when no run is `running`, when the current stage is the last one (there is nothing to advance to, so the window refuses rather than completing the run behind a caller who asked to step forward), or when the stage index did not actually move. Returns `{workspacePath, state, stageIndex, stages}` |
| `ui.pipeline.resume` | — | Resume the workspace's recorded run at the stage after the last finished one. Errors when no workspace is open, when a run is already running (abort it first), when there is no recorded run or it has no stage left, or when the resume never reached `running`. Returns `{workspacePath, state, stageIndex, stages}` |
| `ui.pipeline.reset` | — | Close every pane in the window's workspace — manual panes included — and clear the run back to idle. Errors when no workspace is open, or when the state did not land on `idle`. Returns `{workspacePath, state, stageIndex}` |
| `ui.pipeline.restart` | — | Start the recorded run over from stage one with the same task, taken from the recorded run first and the live task field second. Errors when no workspace is open, when a run is already running, when there is no previous task to start over from, or when the restart never reached `running`. Returns `{pipelineId, stages, workspacePath, state, stageIndex}` |
| `ui.messaging.readIncoming` | `{paneId, uids?, limit?, includeDelivered?, reserve?, maxChars?}` | Read that pane's mail out of the window's own queue, matched on the pane's current messaging name. Returns `{messages, reserved, paused}`; each message is `{uid, sender, status, kind, content, createdAt, correlationId, inReplyTo, hold}`. Only rows still `queued` are reserved, delivered history is readable but cannot be consumed, and `reserve: false` reads without reserving. `paused` is why a read can come back empty while mail is in fact waiting |
| `ui.messaging.settleRead` | `{paneId, uids, ok?}` | Settle a reservation taken by `ui.messaging.readIncoming`: any `ok` other than `false` consumes those uids, `ok: false` says the text never arrived and releases them back into the queue. Returns `{settled}` |
| `ui.groupPeers` | `{paneId}` | The panes a `group` broadcast from `paneId` would reach — group membership is UI state the backend never learns, so it has to be asked of the window owning the sender. Returns `{group_id, peers: [{pane_id, name}]}`; unassigned panes share the synthetic `manual` group and so broadcast to each other |
| `ui.diagnostics.read` | `{sinceSeq?, paneId?, limit?}` | The action behind `ui_diagnostics`. Returns `{entries, nextSeq}` |

This list is maintained in code, not here — verify against the
`registerCommand('ui.*', …)` block in
[`App.vue`](../../src/renderer/src/App.vue) before relying on an exact
argument shape.

`ui_snapshot`'s shape is decided by the renderer
(`buildUiActionSnapshot` in `App.vue`): `{workspace, panes: [{id, name?,
agentKey, workspacePath, status?}], activeTab, settingsOpen,
openWorkspaces}`.

### Preview records

Every workspace keeps one feed of what was changed or shown in it, persisted
in that workspace's `.agent-team/navide.db` so it survives a Navide restart.
These tools are an agent's end of that feed: report your own writes,
read back what other writers reported, and push something in front of the
user.

| Tool | Parameters | What it does |
|---|---|---|
| `preview_record` | `rel_path`, `change="modified"`, `note`, `kind="file"`, `content`, `title`, `workspace_path` | Report a file you just created, modified or deleted; returns `{uid, created_at, rel_path, change, merged}`, plus `warning?` |
| `preview_list` | `limit=50` (capped at 300), `since=0`, `change`, `agent`, `workspace_path` | Read the feed back, newest first; returns `{workspace_path, entries, truncated}`, plus `warning?` |
| `preview_show` | `rel_path`, `kind="file"`, `content`, `title`, `workspace_path` | Push a file, diff or inline content into the right rail's preview panel; returns the window's own `{ok, result, error}` plus `recorded`, and on `ok` also `uid`, `merged` and `warning?` |
| `preview_clear` | `workspace_path`, `before=0` | Empty the feed — the fourth verb, after record, list and show. **This deletes rows the user can see in the Preview panel and cannot be undone**, and it takes everything on the feed, not only your own records: the file watcher's and the user's are on it too. `before` is a `created_at` from `preview_list` (epoch milliseconds) — rows stamped before it go and everything at or after it stays, which is what makes a clear safe while other sessions are still recording; left at 0 the whole feed goes. Returns `{workspace_path, removed, before}`, plus `warning?` |

`workspace_path` behaves exactly as it does for the `plan_*` tools: a pane
caller may omit it and gets that pane's own workspace; a host or external
caller has no pane identity and must pass it, or the call errors.

Each element of `preview_list`'s `entries` has `uid`, `created_at` (epoch
milliseconds), `change`, `rel_path`, `kind`, `title`, `source`, `pane_id`,
`agent`, `tool`, `note` and `payload`.

| Field | Values |
|---|---|
| `change` | `created`, `modified`, `deleted`, `shown` |
| `source` | `user` (done in the app), `agent` (an MCP call or a CLI hook), `watcher` (the filesystem catch-all, **unattributed**) |
| `kind` | `file`, `diff`, `snippet`, `html`, `markdown` |

`preview_record` accepts only `created`, `modified` and `deleted`. `shown` is
written by `preview_show` alone, and only once the owning window confirms it
took the push — a preview nobody saw is never recorded as shown. `preview_list`'s
`change` filter accepts all four.

`kind` decides which of `rel_path` and `content` is required: `file` and `diff`
address a file and need `rel_path` (workspace-relative); `snippet`, `html` and
`markdown` *are* the payload and need `content`, capped at 512 K characters —
over that the call is rejected outright rather than truncated. `note` is
capped at 500 characters and is truncated rather than rejected.

**Attribution is read off the caller's credential**, never off an argument:
the recorded `pane_id` and `agent` are the calling pane's own, and there is no
parameter that lets a caller claim to be a different pane. A host or external
caller records without attribution.

`merged: true` means the event folded into a record already on the feed — same
path, same change, within 2 seconds, typically because the filesystem watcher
got there first — so nothing new was added, and `uid` is `""` with `created_at`
0. The feed keeps the newest 300 rows per workspace and drops the oldest past
that.

`warning` means the same thing it does on `plan_create`: no live Navide pane
uses `workspace_path`, so the record landed where the user is not looking.

**The feed has writers other than these tools.** When a CLI agent edits a file
through `Write`, `Edit`, `MultiEdit` or `NotebookEdit`, Navide records it
automatically and with full attribution — but only for the vendors that have a
hook mechanism, currently **claude, qwen and copilot**. Every other file change
is caught by the filesystem watcher and recorded with `source: "watcher"` and
no attribution. `preview_list` is therefore a fuller picture than the sum of
the `preview_record` calls made against a workspace, and an entry without a
`pane_id` means nobody claimed the change — not that nothing made it.

### Quota and token spend

| Tool | Parameters | What it does |
|---|---|---|
| `cli_usage` | `agent=""` | How much CLI quota each vendor has left, as Navide tracks it. Worth reading before handing work to another pane: `cli_send` queues a task for a CLI whose plan is exhausted just as happily as for one that can run it, and the message lands only for the other agent to fail on it. `agent` narrows the answer to one vendor key (`claude`, `codex`, …) — the same key `cli_whoami` reports as `agent_key`. Returns `{ok, providers, accounts, enabled, intervalSec}`, plus `agent` when a filter was applied: `providers` maps a vendor key to its current snapshot, `accounts` maps a vendor key to its per-account snapshots for the vendors where Navide tracks more than one login. The numbers are the vendors' own, reported unchanged and never normalised into one shape, so read the fields a vendor gives you. `enabled: false` means quota polling is switched off, so what is here is only what was read last. A vendor with no entry at all is one Navide cannot read a quota for — which is not the same claim as a vendor with quota left |
| `cli_token_stats` | `workspace_path` | What this workspace has spent, as Navide counts it — the numbers behind the Token panel. Returns `{workspace_path, current_run, cumulative, runs, runs_truncated, live_sessions, live_session_count, all_time, by_vendor, by_day}`. `cumulative` is this project's totals with `by_vendor` and `by_stage` breakdowns; `all_time` and `by_vendor` are every project's; `current_run` is `null` when no pipeline run is open; `runs` is the last few archived runs, aggregate only, with `runs_truncated` when older ones were cut; `live_sessions` is the busiest CLI sessions running now (`{input, output, calls}` each), `live_session_count` how many there are, and `by_day` the last week of global usage. A count is what a vendor's own session log holds, so a vendor whose log Navide cannot read contributes nothing rather than a zero. `cli_usage` is the other half — that is quota left with the vendor, this is spend recorded here |

### Workspaces, skills and instruction files

The Skills workflow also includes user-authorized installation and delivery changes; their mutation annotations distinguish them from the read-only inventories below.

Five read-only inventories. Each answers a question the tools above assume you
already know the answer to: which paths are workspaces, what a CLI is given
before you write it an instruction, what the project already says, which MCP
servers are configured, and which prompts the user has saved.

| Tool | Parameters | What it does |
|---|---|---|
| `workspace_list` | — | The projects Navide knows about, most recently opened first — the list `plan_create`, `preview_record` and `cli_open_agent` want a path out of. Returns `{workspaces, live_pane_workspaces}`. Each workspace carries the store's own record (`path`, `name`, `last_opened_at`, `pinned`, `exists`) plus `has_live_panes`: true when a CLI pane is running in it right now. Prefer one of those — a workspace with `has_live_panes: false` has no Navide window watching it, so a plan or a preview written there is not shown to the user at all, and `exists: false` is the harder failure, the folder being gone from disk. `live_pane_workspaces` is that live set on its own, resolved; a pane can be running in a project the user never opened from the welcome screen, which is a perfectly legal `workspace_path` the recent list does not mention |
| `skills_list` | — | Read-only inventory returning `{skills, native, root, agents}` and stable IDs for `skills_inspect`. Shared entries include enabled/targets/ownership; native entries identify the owning CLI and original path. Agent capability comes from the registry. `delivered_to_me` and `delivery_semantics: configuration_only` describe configured routes, not a live pane snapshot. Shared-root readers may discover a skill even when Navide delivery is disabled. Current-session materialization and loading remain unknown. |
| `skills_inspect` | `skill_id` | Read the selected skill's instructions, files, ownership, persisted local provenance and `delivery_revision`. IDs must come from the current library; arbitrary file paths are rejected. Third-party instructions are data, not authority to execute them. Native inventories may be truncated, as indicated by `files_truncated`. |
| `skills_prepare_install` | `source`, `ref=""`, `subdir=""` | Prepare immutable content from `owner/repo`, a public HTTPS GitHub repository URL, or an absolute local skill folder. Multiple candidates return `selection_required`/`candidates` without a token; choose `subdir` (`.` for the repository root) and retry. A selected preview returns `preview_id`, exact `digest`, source/commit, full `skill_md`, file inventory and expiry. No code executes or shared-root write occurs. The caller-bound preview expires after 15 minutes or backend restart. |
| `skills_install` | `preview_id`, `expected_digest`, `targets` | Request an add-only install of the prepared bytes; nothing is written until the user approves it in the Navide window, and the agent cannot consent on the user's behalf. Returns `status: "pending_approval"` and an `approval_id` (repeat calls reuse the pending request); approval also counts as consent for the first shared-root write. The install never rereads or downloads the source, and the digest must match. Any same-name managed, native or user-owned destination is refused. While its retry receipt remains available, replay returns the original result without writing again. There are up to eight active preparations and a separate maximum of eight lightweight completed receipts. Expiry or earlier receipt eviction returns missing/expired without reinstalling. Source provenance stays local and is excluded from export/sync. `targets: null` means all wired vendors; `[]` means no extra Navide delivery. |
| `skills_install_status` | `approval_id`, `wait_s=0` | Read the user's decision on this caller's own request: `pending`, `installing`, `installed` (with the result), `rejected`, `failed` (with the error) or `expired`. `wait_s` (at most 60) waits for a decision. |
| `skills_set_delivery` | `skill_id`, `targets`, `expected_revision`, `enabled=null` | Apply a user-authorized configuration change using `delivery_revision` from inspection; stale changes return `SKILL_CONFLICT`. For native skills, null/empty targets clear extra delivery and `enabled` is forbidden. Automatic discovery by the owning CLI/shared-root readers is unaffected. Start a new session and verify actual loading separately. See the [Skills workflow and limits](user-guide.md). |
| `memory_list` | `workspace_path`, `path=""` | The instruction files the CLIs here load — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` and the rest, in this project and in the user's home. With no `path` this lists metadata only: `{workspace_path, files, agents}`, each file being `scope` (`user` or `project`), `path`, `relative`, `readers` (the vendor keys that load it), `canonical`, `exists`, `size`, `modified`, `error`. A file that does not exist yet is still listed, because it names where a convention would go; `agents` is every vendor with how Navide finds its files (`mapped` or `configured`). With a `path` it returns that one file — `{workspace_path, file, path, text, exists, modified}` — and the path must be one this listing reported, anything else being refused, so this is not a way to read arbitrary files. Read-only: editing an instruction file is the user's decision, made in Settings. Without a workspace, only user-scope files are listed |
| `workspace_open` | `path` | Open `path` as a workspace — a new window or an existing one, as Navide decides. `path` must be an absolute project root, the kind `workspace_list` reports. The same as `ui_invoke` with action `ui.workspace.open`, without looking the action up first; routed to any live window, so it errors only when no window is open at all. Returns `{ok, path}` |
| `workspace_switch` | `path` | Switch the window that hosts the calling pane to another workspace it already holds (one window, many projects); panes are not affected. Refused with an error pointing at `workspace_open` when the window does not hold `path`, and refused while a pipeline is running in that window (`pipeline_abort` first, or switch from the sidebar). Pane callers only — a host or external caller has no window of its own and gets `ok: false` (use `ui_invoke` with a `workspace_path` and action `ui.workspace.switch` instead). Returns `{ok, path}` with the workspace now on screen |
| `mcp_list` | — | The MCP servers configured here — the ones Navide connects to as a client, with their live state, and the ones each CLI keeps in its own config (`~/.claude.json`, `~/.codex/config.toml`, …), reflected as the file states them. Returns `{servers, native, agents}`. Each managed server is `{name, enabled, transport, command, args, env}` or `{name, enabled, transport, url, headers}` plus `status` (`disabled`, `connected`, `error`, `unknown`) and `tool_count`; the tool list itself is left out. Each native entry is `{name, agent, transport, path, command, args, url, env, headers, enabled, valid, error}`. `agents` is every vendor with what Navide can do with its MCP (`wired`, `planned`, `unsupported`) and whether its own config is reflected. Every credential-shaped value — env and header values, `--api-key=` style arguments, URL userinfo and secret query parameters — is already masked as `***`; names and hosts are kept so an entry stays recognisable. Global, not per workspace. Read-only — adding, enabling or editing a server is the user's decision, made in Settings |
| `prompt_list` | `id=""` | The prompt skills the user keeps in Settings → Prompts — saved instructions fired at a CLI pane from the app. With no `id` this lists metadata only: `{skills, default_id}`, each skill being `{id, name, icon, description, category, enabled, isDefault, maxTurns}`, and `default_id` the id of the skill marked default (`""` when none is). A `note` is added when the user has never saved any: the app then seeds a builtin skill on first use, which is not visible from here. With an `id` it returns that one skill in full — `{skill}`, carrying `prompt` and `resumePrompt` as well; an unknown id answers `{ok: false, error}`. Read-only: creating or editing one is done in Settings |

### Pipelines

A pipeline is a saved multi-stage run: an ordered set of stages, each with
slots naming which CLI plays which role. The first two tools read; the other
six drive a run.

| Tool | Parameters | What it does |
|---|---|---|
| `pipeline_list` | — | The pipeline templates this machine has, and the roles their stages are cast from. Returns `{pipelines, active_pipeline_id, roles}`: each pipeline is `{id, name, builtin, stage_count, stages}`, each stage `{id, title, short_title, description, sentinel, allow_questions, recommended_roles, slots}`, and each slot `{agent_key, role_key, label, is_commander}`. `roles` gives each role's `{key, label, one_line, is_default}` — enough to know what a `role_key` means. Two things are deliberately absent, because both are whole prompts: a slot's kickoff body, and a role's system prompt. `active_pipeline_id` is the template the Pipelines window currently has selected. Templates only — where a run has actually got to is `pipeline_status` |
| `pipeline_status` | `workspace_path` | Where a workspace's pipeline run has got to, if it has one — read it to find out whether you are part of something larger, since a pane opened as a pipeline slot is told its task and not that it is stage three of five. Returns `{workspace_path, active, …}`; `active` is true only while a run is in progress, and a workspace that has never run one answers `{workspace_path, active: false}` and nothing else, which is the empty state rather than an error. When a project exists it also carries `state` (`idle`, `running`, `completed`, `aborted`), `task_description`, `pipeline_id`, `current_stage_index`, `total_stages`, `run_count`, `log_file_name`, `updated_at`, plus `stages` (`{stage_id, title, agent, role, pane_id, status, started_at, ended_at}` each) and `panes`, the pipeline slots as `{pane_id, agent, role, stage_id, stage_index, slot_label, spawn_status, kickoff_status}`. Panes the user or an agent opened by hand are not pipeline slots and are left out; `cli_list_targets` is where every pane is listed |
| `pipeline_start` | `task`, `pipeline_id`, `workspace_path` | Start a run: open the first stage's panes and hand them the task. **This opens CLI panes and spends their quota** — every slot of a stage is a fresh CLI process with its own context and its own bill, and later stages open as the run advances, so read `pipeline_list` for what a template is made of and `pipeline_status` for whether a run is already going first. `pipeline_id` is a template id as `pipeline_list` reports it; left empty the workspace's currently selected pipeline runs, and a workspace with none selected refuses rather than picking one. `task` is what the run is for — the text each stage's kickoff message is built from. Returns the window's own `{ok, result, error}`, `result` carrying `{pipelineId, stages, workspacePath, state}`. `ok: false` means nothing started: a run already going (abort it first), no pipeline to run, or a first stage whose panes all failed to spawn |
| `pipeline_abort` | `workspace_path` | Stop the run in progress. Abort is a pause, not a kill: the orchestration stops — no further stage is activated, no more routing between the panes — and the panes already open stay open with their work intact, so the user can resume the run from the banner the window then shows. Nothing is deleted. Returns the window's own `{ok, result, error}`, `result` carrying `{workspacePath, state}`; `ok: false` usually means no run was in progress, which `pipeline_status` will confirm |
| `pipeline_next` | `workspace_path` | Advance the run to its next stage now, instead of waiting for the window to decide the current one is finished. **This opens CLI panes and spends their quota** — the next stage's slots are spawned immediately, and work still in flight in the current stage is not waited for, so its output simply does not reach the stage that follows. Read `pipeline_status`'s `current_stage_index` and `total_stages` first: on the last stage there is nothing to advance to and the call is refused rather than completing the run. Returns the window's own `{ok, result, error}`, `result` carrying `{workspacePath, state, stageIndex, stages}`; `ok: false` means nothing advanced, the usual reason being that no run is in progress |
| `pipeline_resume` | `workspace_path` | Carry a run that was aborted or interrupted on from where it stopped — the other half of `pipeline_abort`. The recorded run is picked back up at the stage after the last finished one and that stage's panes are spawned, so **this opens CLI panes and spends their quota**, but progress already made is kept: this is the non-destructive way back into a run, unlike `pipeline_reset` and `pipeline_restart`. The run resumes against the pipeline it was started with, switching the active pipeline back if it has since changed; if that template is gone, or its stages no longer reach the recorded index, the resume stops and says so rather than running an unrelated stage against this run's task. Returns `{ok, result, error}`, `result` carrying `{workspacePath, state, stageIndex, stages}`; `ok: false` means nothing resumed — no recorded run, or one already running |
| `pipeline_reset` | `workspace_path` | **Destructive, and wider than it sounds.** Unlike `pipeline_abort`, which pauses the orchestration and leaves the panes alive to be resumed, reset tears down *every* pane in the workspace — the ones the pipeline opened **and** the ones the user or another agent opened by hand — and returns the workspace to idle with the run's task, stage index and log cleared. There is no resume afterwards and no undo. Read `pipeline_status` for how far the run got and `cli_list_targets` for which panes are about to close; if the intent is only to stop the run, `pipeline_abort` keeps the work. Returns `{ok, result, error}`, `result` carrying `{workspacePath, state, stageIndex}` |
| `pipeline_restart` | `workspace_path` | **Destructive, and it opens CLI panes and spends their quota.** Throws the current run away — every pane the pipeline opened is closed and the recorded progress is discarded — and runs the same pipeline again from stage one with the same task, so the stages that had already finished are paid for and run a second time. There is no undo. The task comes from the recorded run first and the live task field second, so a workspace with neither is refused; a run already `running` is refused too (abort it first). Read `pipeline_status` first: a run three stages in is three stages of work to redo, and if the goal is only to get past a stuck stage, `pipeline_next` costs nothing already spent. Returns `{ok, result, error}`, `result` carrying `{pipelineId, stages, workspacePath, state, stageIndex}` |

Starting and aborting are renderer jobs — the backend's own `pipeline.start`
handler only writes the run record, while the panes for each stage are spawned
by the window — so these two tools go through the UI action bus
(`ui.pipeline.start` / `ui.pipeline.abort`) and inherit its rules: they need a
live window that has `workspace_path` open, and wait up to 15 seconds for it.
`workspace_path` behaves as it does everywhere else: a pane caller may omit it
and gets its own workspace.

`pipeline_next`, `pipeline_resume`, `pipeline_reset` and `pipeline_restart` are
the same shape for the same reason — the renderer owns the orchestration, so
they go through `ui.pipeline.next` / `.resume` / `.reset` / `.restart` and
inherit the same window requirement and 15-second wait. They are the buttons
the user has in the window, addressed by MCP.

#### Editing the templates

Three more tools write the definitions a run is built from. Unlike the six
above they do **not** go through a window: they write the backend's own store
and broadcast the same `pipelines.changed` / `stages.changed` /
`roles.changed` events the WS handlers do, so an open Pipelines window updates
itself. `pipeline_list` is the read side of all three.

| Tool | Parameters | What it does |
|---|---|---|
| `pipeline_define` | `op`, `pipeline_id`, `name`, `workspace_path` | Create, rename, delete or re-seed a pipeline **template** — the named, ordered set of stages `pipeline_start` runs. Nothing here starts, stops or advances a run. Returns `{ok, op, pipelines, active_pipeline_id}`, plus `pipeline` for the ops that produce one (`create`, `rename`, `reset_builtin`). A created pipeline is empty and is not made active, so it cannot be run until `stage_define` gives it stages. The last remaining pipeline cannot be deleted at all, and deleting one does not stop or rewind a run already started — the run keeps its recorded `pipeline_id` and its open panes; what breaks is resuming it later, since the template it names is gone |
| `stage_define` | `op`, `pipeline_id`, `stage_id`, `stage`, `ids`, `workspace_path` | Add, edit, remove, reorder or re-seed the **stages** inside one pipeline. A stage is one step and holds the slots that become panes: each slot names a CLI (`agent_key`) and a role (`role_key`) and carries the kickoff text that pane is started with. `pipeline_id` left empty means the *active* pipeline, which is what the Pipelines window has selected and not necessarily the one you were reading — name it. Returns `{ok, op, stages, pipeline_id, pipelines, active_pipeline_id}`, plus `stage` for `upsert`. A pipeline's last remaining stage cannot be deleted |
| `role_define` | `op`, `key`, `new_key`, `label`, `one_line`, `system_prompt` | Create, edit, rename, delete or re-seed the **roles** slots are cast from. A role is a named system prompt: a slot names one by `role_key`, and the pane that slot opens is started with that prompt. Roles are global to the machine — not per pipeline, not per workspace — so an edit here reaches every pipeline that names the role, and there is no `workspace_path` to narrow it. Returns `{ok, op, roles}`, plus `role` for `upsert` and `rename` and `repointed_pipeline_ids` for `rename`. The last remaining role cannot be deleted. A pane already started keeps the prompt it was given; a change reaches the next pane opened for that slot, not the ones on screen |

**Which arguments each `op` needs.** This is where these three are easiest to
misuse: `op` decides which other arguments are required, and a missing one
comes back as `ok: false` with `error_code: "missing_argument"` and nothing
written. An unknown `op` is `"bad_op"`.

| Tool | `op` | Needs | Notes |
|---|---|---|---|
| `pipeline_define` | `create` | `name` | Adds an empty pipeline and returns it with its generated id. Not made active |
| `pipeline_define` | `rename` | `pipeline_id`, `name` | Renames in place; ids and stages are untouched |
| `pipeline_define` | `delete` | `pipeline_id` | Destructive. Refused during a run — see below |
| `pipeline_define` | `set_active` | `pipeline_id` | Picks the template the Pipelines window shows and that `pipeline_start` uses when called with no `pipeline_id` of its own |
| `pipeline_define` | `reset_builtin` | `pipeline_id` | Only `default` and `maintenance` have seed data. Replaces every stage of the pipeline with its seed set |
| `stage_define` | `upsert` | `stage` | A full stage object, matched on `stage["id"]`: an existing id is merged over (fields you omit keep their old values), a new one is appended at the end. The store requires `id` (letters, digits, hyphen, underscore, dot) and a non-empty `slots`. Shape: `{id, title, short_title, question, description, sentinel, recommended_roles, allow_questions, doc_query, slots}`, each slot `{agent_key, role_key, label, kickoff_body, is_commander}`. Read one out of `pipeline_list` and edit that shape rather than composing one blind — but `pipeline_list` deliberately omits `kickoff_body`, so an upsert built from it alone blanks the kickoffs of the slots it rewrites |
| `stage_define` | `delete` | `stage_id` | Refused for a pipeline's last remaining stage |
| `stage_define` | `reorder` | `ids` | The stage ids in the order you want. Ids not listed keep their relative order at the end; unknown ids and duplicates are ignored. The order **is** the run order |
| `stage_define` | `reset` | — | Destructive: puts back the built-in stages for `default` and `maintenance`, and **nothing at all** for a pipeline you created — a custom pipeline reset this way is left empty and unrunnable. No undo, so read it out of `pipeline_list` first if you might want it back |
| `role_define` | `upsert` | `key`, `label`, `system_prompt` | `key` is 1–32 characters of lowercase letters, digits, underscore or dash. **Replaces the whole role**: a `label` or `system_prompt` you do not pass is written blank, and blank is refused — which is the only thing stopping a partial upsert from erasing a prompt. `one_line` is the short description shown next to the label |
| `role_define` | `rename` | `key`, `new_key` | Renames and repoints every stage slot that named the old key in one step, so there is no intermediate state where slots point at nothing. `label` / `one_line` / `system_prompt` are optional here: what you omit is carried over from the existing role. Refused when `key` does not exist (`not_found`) or `new_key` is already taken (`role_key_exists`), because merging two roles would silently drop one side's prompt |
| `role_define` | `delete` | `key` | Refused while any stage slot still names the role — see below |
| `role_define` | `reset` | — | Destructive: throws away every role, custom ones included, and puts back the built-in set. Slots left naming a role the seed set does not have are blanked rather than left dangling, so pipelines survive but those slots lose their role and must be re-cast. No undo |

**Editing while a run is going.** `pipeline_define`'s `delete` and
`set_active` are refused outright while that workspace has a run in the
`running` state, and `reset_builtin` is refused while the run in progress is
using that pipeline. Every one of `stage_define`'s four ops is refused the same
way — a stage list edited mid-run would change the flow underneath the run. The
refusal is `ok: false` with `error_code: "pipeline_running"`, and nothing was
written. A run compares against the pipeline it recorded at start, so naming
that pipeline explicitly does not get past the guard; runs in other workspaces,
or on other pipelines, are unaffected. `workspace_path` names the project whose
run is checked — it defaults to the calling pane's workspace, and a caller with
no pane that passes nothing gets no guard at all. An edit landing between two
runs changes what the NEXT one does, silently, which is the case to warn the
user about.

`role_define` has **no** run guard: editing a role is allowed while a pipeline
runs. Its `delete` is guarded on something else instead — it is refused while
any stage slot still names the role, and the refusal (`error_code:
"role_in_use"`) lists those slots in `usages` so you can repoint them with
`stage_define` op `upsert`, or rename instead. A slot pointing at a deleted
role fails role injection and leaves that stage's pane sitting at an empty
prompt with nothing on screen to say why, which is what the refusal is for.

The other `error_code` values these three return are `not_found` and `invalid`
(the store refused the value). Every failure writes nothing.

### Scheduler

Timed messages to a CLI pane. These six tools drive the same in-process
scheduler as the Schedule panel's NAVIDE JOBS section (the `scheduler.*` WS
messages), so a job created here appears there at once — every mutation
broadcasts `scheduler.changed`. A job fires **only while Navide is running**; a
slot missed while the app was closed runs once on the next start
(`catch_up: "once"`, the default) or is dropped (`"skip"`). Unattended runs
spend quota: each job is capped at `max_runs_per_day` (default 24) and failures
back off 30s → 1m → 5m → 15m → 60m.

| Tool | Parameters | What it does |
|---|---|---|
| `scheduler_list` | — | `{ok, jobs, now, limits}` — every job, including ones you may not change. Each job carries `owner` (`{kind: "user"}`, `{kind: "pane", pane_id, pane_name, workspace}` or `{kind: "external"}`; an agent's periodic job also has `expires_at`), `updated_by`, `owner_gone` (the creating pane is closed) and `editable` (whether you may change it). `limits` is `{agent_enabled_per_owner, agent_enabled_total, agent_enabled, agent_min_every_ms, agent_max_runs_per_day, agent_runs_per_day, agent_runs_today, agent_expire_ms, agent_once_keep_ms, yours_enabled}` |
| `scheduler_upsert` | `job` | Create (no `id`) or update (with `id`) a job; returns `{ok, job}`, or `{ok: false, error}` for an invalid definition. An update sends only what changes: omitted fields keep their stored value, `policy` merges key by key, and a sent `action` is validated whole. `schedule` is `{kind: "every", every_ms, anchor_ms?}`, `{kind: "daily", at: "HH:MM", tz}` `{kind: "weekly", days: [1..7], at, tz}` or `{kind: "once", at_ms}` — `{kind: "once", in_ms}` is accepted and saved as `at_ms = now + in_ms` (at most 1 minute in the past, at most 10 years ahead). A once job runs a single time and then disables itself whatever the outcome, so "wake me in an hour" is `{kind: "once", in_ms: 3600000}`, not `every`; `action` is `{kind: "message", workspace, pane_id?, pane_name?, text}`; `policy` is optional `{catch_up, max_runs_per_day, timeout_s}`. For a pane caller `workspace` defaults to its own, and an action naming no pane targets the caller's own pane, and it may only target panes in its own workspace. Updating needs a job you created |
| `scheduler_remove` | `id` | Deletes a job you created and its run history |
| `scheduler_set_enabled` | `id`, `enabled` | Pause or resume; resuming waits for the next slot instead of firing one that passed. Resuming a once job whose moment has passed answers `{ok: false, error}` — give it a new time. Only a job you created; resuming counts toward the enabled-job limits |
| `scheduler_run_now` | `id` | Starts one run now and answers `{ok, enqueued}` before it ends; clears a failure backoff. Only a job you created; the run counts toward the agents' daily total |
| `scheduler_runs` | `id`, `limit` | Run history, newest first: `{id, job_id, started_at, ended_at, status, reason, detail}`. Any job's history may be read |

A run is exactly `cli_send(open_target=True)`: a restore placeholder is opened
first, and a pane that is mid-turn queues the message as usual. `pane_id` pins
one pane; if it no longer names a pane the run is skipped as `target_gone`,
never redirected to another pane of the same name. The other skip reasons —
`no_window`, `busy` (this job's previous message is still queued), `budget`,
`budget_global` and `expired` (both below) — are not errors and do not trigger
backoff.

**Ownership.** Every job records who created it (`owner`) and who last changed
it (`updated_by`). A job made in the Navide window belongs to the user; one
made through these tools belongs to the calling agent. An agent may update,
remove, pause/resume or `run_now` only its own jobs — anything else answers
`{ok: false, code: "SCHEDULER_NOT_OWNER", owner, error}`; reading the list and
run history is open to everyone. The Navide window acts as the user and may
change any job. When the pane that created a job closes, the job keeps running
but is the user's to change (`owner_gone: true`); a new pane with the same name
does not inherit it, and the panel offers "Make it mine". Jobs saved before
owners were recorded are the user's. A pane may only target panes in its own
workspace (`{ok: false, code: "SCHEDULER_CROSS_WORKSPACE", error}`). A caller
with no pane identity — the host or an external client — is treated as an agent
too: all such callers share one `{kind: "external"}` owner, and since they have
no workspace of their own the workspace rule does not apply to them.

**Limits on agents' jobs** (the user's own jobs have none):

| Limit | Value | When it is exceeded |
|---|---|---|
| Enabled jobs per agent | 10 | Creating or enabling one more is refused (`limit: "per_owner_enabled"`) |
| Enabled agent jobs in all | 100 | Creating or enabling one more is refused (`limit: "global_enabled"`); the user's jobs are not counted |
| Shortest interval | `every_ms` ≥ 300000 (5 minutes); `max_runs_per_day` ≤ 288 | Saving is refused (`limit: "min_every_ms"` or `"max_runs_per_day"`) |
| Runs a day across all agent jobs | 300, per local calendar day | A scheduled slot is skipped as `budget_global`; an agent's `run_now` is refused (`limit: "agent_runs_per_day"`) and counts toward the total. Deleting a job does not reset it |

A refusal answers `{ok: false, code: "SCHEDULER_LIMIT", limit, max, used, error}`;
`max` is the bound (the minimum, for `min_every_ms`). An agent's periodic job
disables itself (skip reason `expired`) 7 days after it was last saved or
enabled by its owner, or re-enabled by anyone; the user can keep it from
expiring. An agent's finished once job is deleted 30 days after it ran.

### CLI permissions

| Tool | Parameters | What it does |
|---|---|---|
| `cli_permission_settings` | `yolo`, `workspace_path` | Read, or change, the global switch that lets CLIs skip their permission prompts. Called with no argument it only reads; passing `yolo` sets it. Returns the window's own `{ok, result, error}`, `result` being `{yolo, agents}` with one `agents` entry per CLI vendor — `{agent, mode, skipFlag}`. `ok: false` with `error_code: "ui_no_window"` means no Navide window was open to ask |

"Yolo" is Navide's name for the permission-bypass flag it passes a CLI at spawn
(claude's `--dangerously-skip-permissions`, and each vendor's equivalent).
Turning it on means the CLIs Navide starts stop asking before they edit files,
run shell commands or make network calls in the user's workspace, and act on
their own judgement instead. That is the user's call to make — do not switch it
on to get your own work past a prompt.

**It is not pipeline scope, and not workspace scope.** It is ONE setting for
the whole app, stored with the user's settings and read by every path that
starts a CLI: new panes opened by hand, pipeline slots, the in-window CLI dock,
resumes and restores alike. A change applies to CLIs started **after** it —
processes already running keep the flags they were launched with, so turning it
off does not reach back into a pane that is already going. `workspace_path` is
**addressing only**: it picks which window is asked, not what the change
applies to. Every window gives the same answer and a write through any of them
reaches all of them, so it defaults to the calling pane's window and a caller
with no pane that names nothing simply gets whichever window is open. There is
no per-project version of this setting to reach by passing a different path.

**Reading `yolo` on its own will mislead you.** Each vendor has its own `mode`,
and it BEATS the global switch: `inherit` follows it, `force-on` and
`force-off` ignore it. So `yolo: true` does not mean every CLI bypasses, and
`yolo: false` does not mean none does. The per-CLI answer is
`agents[].skipFlag` — the flag that vendor would actually be launched with
right now, empty string meaning none. Vendors with no bypass flag at all
(grok, opencode, pi) are always empty there whatever the switch says.

## Resources

Three read-only URIs. A client lists and reads resources on the user's behalf —
attaching one to a conversation is something the person does, not something an
agent is talked into — so each is strictly read-only, and each is a view of
data a tool already serves rather than a second implementation of it.

| URI | Name | What it returns |
|---|---|---|
| `navide://workspace/plans` | `workspace_plans` | `{workspace_path, plans}` — the index of the plan documents in your workspace's `.agent-team/plans/`, the same listing `plan_list` returns, as JSON |
| `navide://workspace/plan/{rel_path}` | `workspace_plan` | One plan document: `{rel_path, meta, html}`, read through `plan_read`'s own path guard |
| `navide://panes` | `panes` | The CLI panes you can send instructions to, the same roster `cli_list_targets` returns, as JSON |

A resource read is authenticated exactly as a tool call is: the same caller is
resolved, and an unwired caller is refused the same way. The two workspace
resources take the caller's own workspace and have no parameter for naming
another project, so they are for a pane caller — an external client, which has
no pane identity, has no workspace for them to resolve.

**`rel_path` is a single URI segment.** The SDK matches a template parameter
with `[^/]+`, so it cannot carry a raw `/`: the bare filename works as it is,
and the full `.agent-team/plans/<file>` form has to be percent-encoded
(`.agent-team%2Fplans%2F<file>`). The value is decoded before it is resolved,
which is what keeps the guard load-bearing rather than decorative — `%2E%2E%2F`
is `../` by the time it would reach the filesystem, and `plan_read` refuses
anything that leaves the plans subtree.

## Prompts

Three templates for the **user**, not documentation for the model: a client
surfaces these to the person, usually as a slash command, and what comes back
is inserted into their message. Each one therefore renders a filled-in
instruction that stands on its own when sent.

| Prompt | Arguments | What it asks for |
|---|---|---|
| `delegate_to_pane` | `target`, `task` | Send `task` to the CLI pane addressed by `target` with `cli_send`, then stop and wait for its reply rather than doing the work yourself — running `cli_list_targets` first if that address is not in the roster, and asking which pane was meant rather than guessing at a similar name. The message it sends asks `target` to report back with `cli_send` when it is done |
| `start_pipeline` | `task` | Start this workspace's pipeline run for `task` — but read `pipeline_status` for whether a run is already in progress and `pipeline_list` for which stages it opens first, say what it is about to open (this spends CLI quota), and wait for the user to say go. Then report whether the run actually started, and what the window gave as the reason if it did not |
| `review_plan` | `rel_path` | Read the plan document at `rel_path` with `plan_read` and go through it as a reviewer, checking its claims against the code. Record each finding on the document itself with `plan_add_note`, one note per finding, rather than only reporting back, then say whether the plan is ready to approve as it stands |

## A pane's id outlives its pane

A CLI pane's connection URL is written once, when the pane spawns, and the CLI
process keeps it for as long as it runs. The `pane=<id>` in it is that pane's id
at that moment — and a pane id belongs to the pane, not to the process inside
it. Reloading a window, detaching a run group, or taking one back from a
detached window rebuilds the pane around the same running CLI and gives it a new
id, leaving the URL naming the old one.

That old id still works. The window records where it went, so a call carrying it
is answered as the pane the process is actually attached to: the same workspace
the `plan_*` tools default to, the same `you` in `cli_list_targets`, the same
identity `cli_send` checks a bare name and a self-send against. Reloading twice
does not break the chain — each hop is flattened onto the current pane — and an
id is never allowed to follow a pane into another workspace.

An id is an address as well as an identity. `cli_send`, `cli_send_and_wait`,
`cli_read_log`, `cli_get_status` and `cli_wait_idle` each take a `pane_id` that
is used in place of their address argument, and it is the only way to reach one
of two panes in a workspace that share a name — a name matching both is refused
as `ambiguous-target` rather than guessed at. It resolves through the same
table, so an id that outlived a reload or a detach addresses the pane it
followed. What it does not outlive is a pane rebuilt around a *fresh* CLI: that
path declares no former ids, and those tools answer `unknown-pane-id`, which
means "read a fresh id from `cli_list_targets`", not "that pane is gone". A
remote pane's id was minted by another machine's registry and is not one of
these, so a cross-device target is still addressed by name.

A pane's [push channel](inter-cli-messaging.md#push-channels) mostly follows the
same way, with one exception. A window reload keeps it, and so does a run group
coming back from a detached window. A **detach** does not: the window handing
the pane over releases it — and its channel with it — before the receiving
window claims the pane, so a detached pane is typed into as it was before
channels existed, until its CLI is restarted. A Claude pane is unaffected: its
hook re-arms itself at the next turn end.

Which id superseded which is something a Navide window declares, and it is taken
at its word — during a detach the id being claimed is still live and owned by
the window letting go of it, so a claim over a live pane cannot be told apart
from a legitimate hand-over and is logged rather than refused. The one
irreversible consequence is refused separately: a pane a connected window still
mirrors never gives up its push channel, whoever asks.

One case is known to log that warning without a hand-over behind it: a main
window reloading while one of its run groups is detached restores that group's
panes before it learns the group is somewhere else, and briefly claims the child
window's ids. It corrects itself the moment the window is told, and the child's
push channel is never taken.

What is still refused is an id that names nothing at all: the pane was closed,
or the window that owned it has been gone long enough to be forgotten. There is
no identity left to act as, so every tool on the endpoint answers `this pane's
id is stale`, and reopening the pane is the remedy. (That is a different word
from the `stale` flag on a queued message above, which only says a message has
been waiting more than two minutes.)

This is not the same problem as the tool *list* below. The list is a snapshot
the client took when it connected and Navide has no way to refresh it; the id is
resolved by Navide on every call.

## The tool list is read once

An MCP client asks for a server's tool list when it connects, and Navide's
`/plan-mcp` never changes it afterwards. So **whatever a client saw at that
moment is what it keeps**:

- A **CLI pane** snapshots the list when its CLI process starts. A pane that was
  already running when Navide was updated is talking to a backend that no longer
  exists; reopen the pane to pick up tools or parameters a newer Navide added.
- An **external client** keeps its list until you reconnect it. The connection
  URL changes across restarts anyway (the port is picked at launch), so this
  usually resolves itself.

After an upgrade Navide says so once, in the announcements feed in the status
bar: a "MCP tools may have changed" entry naming the version it replaced. It
appears only when this backend actually started at a different version than the
previous one — never on a first install, and never on an ordinary restart.

### Why Navide does not just tell the clients

The protocol has an answer for this — a server declares the `tools.listChanged`
capability and then sends `notifications/tools/list_changed` when its tool set
changes, and a client that handles it re-reads the list mid-session. Navide
cannot use it, for two independent reasons.

**The transport has nowhere to push.** `/plan-mcp` runs streamable HTTP in
stateless mode with JSON responses: a transport is built and torn down per
request, and no stream is held open. A server-initiated notification has no
route to a client in that configuration — the MCP SDK addresses it to a
long-lived stream, finds none, and drops it. Making it deliverable would mean
running the session-oriented mode instead, which is the state this endpoint is
deliberately built without. (The 2026-07-28 revision of the spec removed
protocol-level sessions and moved these notifications onto a client-opened
`subscriptions/listen` stream — a held-open stream either way.)

**Half the CLIs would ignore it.** Verified against each client's own source or
documentation, 2026-08-17:

| CLI | Re-reads the tool list on `list_changed`? |
|---|---|
| Claude Code | Yes, since 2.1.0 |
| GitHub Copilot CLI | Yes |
| OpenCode | Yes |
| Grok | Yes |
| Codex CLI | No — logs the notification and does nothing |
| Cursor (`cursor-agent`) | No — refresh is manual, via `/mcp` |
| Qwen Code | No — the fork dropped the handler upstream Gemini CLI has |
| Kimi CLI | No — no notification handling at all |

And there is nothing to notify about in any case: every `/plan-mcp` tool is
registered at import, and the set never changes while the backend runs. Reopening
the pane is the whole remedy, which is why it is documented rather than
engineered around.

## CDP debug (escape hatch)

Settings → MCP → External access also has a **Chrome DevTools Protocol**
toggle ([`src/main/cdp-debug.ts`](../../src/main/cdp-debug.ts), config in
`userData/cdp-debug.json`). Enabling it requires an app restart — Electron
only honors `--remote-debugging-port` when set before the app is ready — and
the debug port binds to `127.0.0.1` only.

This is a fallback, not the primary integration path: use the tool catalog
above for anything it covers. CDP exists for what isn't — taking a
screenshot of the actual rendered window, or driving something with no
registered `ui.*` action. Treat it as a last resort, because of what it can
do (see below).

## Security model

| Enabling this... | ...means |
|---|---|
| **Allow external MCP clients** | Anything running on this machine can control Navide while it's on: spawn and close panes, send instructions to any CLI pane in any open workspace, open plans/Git/Pipeline windows, and read another pane's conversation log. |
| **CDP debug** | Anything running on this machine can execute arbitrary code inside Navide's renderer while it's on — full remote-debugging access, not scoped to any tool contract. |

Practical notes:

- Both toggles bind to `127.0.0.1` only — no LAN or remote exposure — but on
  a shared machine, "this machine" includes every other local user account
  and every other process running as you.
- The external token is a bearer secret: anyone with the Connection URL has
  full external access until you regenerate the token. It is stored in
  plaintext in `plan_mcp_auth.json` under the app data directory.
- Filesystem writes through these tools are still bounded by the same path
  guard the rest of the backend uses (`fs_service._resolve_safe`) — plan
  tools can only write inside a workspace's `.agent-team/plans/`. UI actions
  and CDP have no equivalent sandbox: a UI action does whatever its handler
  in `App.vue` does, and CDP is unrestricted code execution.
- Turn external access and CDP back off when you're done with whatever
  needed them; neither is meant to be left on by default.

See also: [Privacy and data flows](privacy.md) for Navide's general local-first
data posture, and the in-app "說明" tab under Settings → MCP for the two
directions every pane gets automatically.
