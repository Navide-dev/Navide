# Convenience features: what Navide changes on your computer

Navide writes outside its own data directory only for a named **convenience
feature** the user has allowed. Every such write goes through one gate, is
announced, is logged, and can be turned off with one click. Decided on
2026-10-10 (plan `.agent-team/plans/navide-no-silent-writes-audit_54f155.html`):

- Writing user settings is allowed when a feature needs it, but the user is
  always told. Disclosure is required; asking first is not.
- Every feature is allowed by default, so today's behaviour is kept. A one-time
  upgrade notice says so.
- Turning a feature off, or deleting its entry by hand, means "not allowed".
  Navide never re-adds it; the overview offers one-click re-allow.
- Account auto-repair is allowed with a notice and a log entry. An account the
  user changed outside Navide is never silently overridden; that case becomes a
  non-blocking prompt.

## The write gate

`backend/agent_team_backend/convenience.py` owns it. Every external write calls

```python
convenience.apply(feature_id, target, write=..., present=...)
```

which runs, in order:

1. **Allowed?** A feature that is off returns `"off"` without writing.
2. **Removed by hand?** If the ledger says Navide wrote `target` before and
   `present()` is now false, the user removed it: the feature goes off
   (reason `removed`), the event is logged and announced, nothing is written.
   A target holding several Navide entries (Claude's and Qwen's settings.json
   hold one hook per event, named `<event>:<kind>`, e.g. `PreToolUse:guard`)
   is also checked entry by entry: one the user deleted while others remain
   is logged and announced as `removed-entry` and never written back, and the
   feature stays allowed so the other hooks keep working. Turning the
   feature off and on again restores it. Copilot's hook file is Navide's
   alone, so deleting it is the whole removal.
   Only a **folder** reset is not a removal: the CLI's config folder
   (`~/.claude`, `~/.qwen`, `~/.copilot`, `~/.codex`) or the workspace's `.cursor`
   gone, or deleted and created again (a different device, inode or birth
   time than the last write saw), took Navide's entry along with everything
   else. The feature stays allowed and the write that puts the entry back is
   announced as `reset` ("re-added after a reset"). A file Navide wrote
   deleted from a folder that is still the same one — the settings.json
   Navide created, Copilot's hook file — is the user's removal. On a file
   system without birth times (Linux) a folder created again at once can get
   the old inode back; that reads as a removal, never as a silent re-add.
   The Cursor features have a target in every workspace, so a removal there
   is that workspace's alone: the target is refused (logged and announced
   once as `removed-entry`, never written there again) and the feature stays
   allowed everywhere else. The workspace's whole `.cursor` folder gone
   (`git clean -fdx`, a fresh clone, a re-created worktree) is a reset of
   that workspace, not a removal.
   A target or config folder behind a link that leads nowhere (a volume not
   mounted yet, a dotfiles checkout mid-switch) is **unknown**: neither a
   removal nor a reset. Nothing is written, turned off or forgotten, and
   `apply` returns `"unknown"` until the link leads somewhere again.
   A workspace is keyed by its canonical path (links resolved, `..`
   collapsed, each folder spelled as stored), so a refusal holds however the
   pane spells it.
   A workspace whose `.cursor` (or the config or skills folder in it, or the
   skills manifest `.navide-links`) leads outside the workspace through a
   link is never written, cleaned or gated; a `.git/info/exclude` that is a
   link is never written either. A skill named like the manifest is never
   linked there; that is logged and announced once per workspace as
   `refused-name`.
   Its panes go without the feature, so the user is told: logged and
   announced as `refused-unsafe`, once per workspace and feature, while the
   feature is allowed.
3. **Backup.** A file target is copied into
   `<app data>/convenience-backups/<feature>/<target hash>/<sha256>.bak`
   (deduplicated by content). A backup is the whole file, **including any
   secrets it holds** (an API key in `env`, an MCP server token), so backups
   are private to the user (folders 0700, files created 0600), each target
   keeps only its latest 5, and a feature turned off or an entry removed
   keeps only its latest one. A log row may name a backup that has since
   been rotated away.
4. **Write.** `write()` performs the existing write unchanged.
5. **Notify.** Only when the target's bytes changed: the first write to a
   target is announced as `first`, a later change as `repair`, and the one
   that puts the entry back after a folder reset as `reset`.
6. **Audit log.** Every write, removal detection, off and re-allow is appended.
   A row a caller triggered names its `source`.

A target that already carries Navide's entry when first seen (an upgraded
install) is added to the ledger without a write. During the startup pass it
is named in the one-time upgrade notice. A target first seen after that
notice was decided — the per-spawn features (Cursor project MCP and skills,
Codex hook trust) are only seen when their pane opens — is announced on its
own, once, as `first` ("found Navide's entry from an earlier version").

## Feature registry

| id | CLI | writes | toggle | turning it off costs |
|---|---|---|---|---|
| `claude.hooks` | claude | `~/.claude/settings.json` hooks (turn detection, Navide Guard, rewake) | yes | turn end is inferred from output instead of reported; Guard does not check Claude's tool calls; push channel cannot wake an idle Claude |
| `qwen.hooks` | qwen | `~/.qwen/settings.json` hooks | yes | same as Claude for Qwen |
| `copilot.hooks` | copilot | `~/.copilot/hooks/agent-team.json` | yes | same for Copilot |
| `codex.hook-trust` | codex | `[hooks.state]` rows in `~/.codex/config.toml` | yes | every Codex pane asks you to trust your own hooks again |
| `codex.login-promote` | codex | `~/.codex/auth.json` (hard link of a pane's login) | yes | a login made inside a pane stays in that pane |
| `cursor.project-mcp` | cursor | `<workspace>/.cursor/mcp.json` + `.git/info/exclude` | yes | Cursor panes have no Navide tools |
| `cursor.project-skills` | cursor | `<workspace>/.cursor/skills/` links + `.git/info/exclude` | yes | Cursor panes get no delivered skills |
| `credentials.auto-repair` | all | live CLI login (Keychain, `~/.claude.json`, vendor credential files) | yes | a pane can start signed out after an account switch went wrong |
| `codex.pane-homes` | codex | `~/.codex-panes/` | no (required) | — |
| `pane-shims` | kimi, grok, antigravity, muse, copilot, qwen | `~/.navide-panes/`; entries a pane creates are moved into the vendor's own directory (`~/.kimi-code`, `~/.grok`, `~/.gemini`, `~/.agents`, `~/.copilot`, `~/.qwen`) and empty seed entries are created there, each logged as `repair` with its real path (announced the first time a path changes) | no (required) | — |
| `claude.account-homes` | claude | links and moved files in `~/.claude` for signed-in accounts | no (required) | — |

Required features are listed for disclosure only. They have no switch because
the panes they serve cannot run without them.

## Persistence (navide.db)

- `convenience_features(id PRIMARY KEY, state TEXT, reason TEXT, updated_at INTEGER)`
  — `state` is `allowed` or `off`; `reason` is `default`, `user` or `removed`.
  A missing row means `allowed`/`default`.
- `convenience_targets(feature TEXT, target TEXT, written_at INTEGER, present INTEGER, folder TEXT, PRIMARY KEY(feature, target))`
  — the ledger: every target Navide wrote for a feature. `folder` names the
  reset folder the last write saw (`<device>:<inode>:<birth time>`), or is
  `reset` while a reset target waits for its next write.
- `convenience_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, feature TEXT, action TEXT, target TEXT, detail TEXT, backup TEXT, notify INTEGER, source TEXT)`
  — append-only. `action` is one of `first`, `repair`, `reset`, `removed`, `off`,
  `allowed`, `cleanup`, `cleanup-failed`, `removed-entry`, `prompt`,
  `refused-unsafe`, `refused-name`.
- `convenience_parts(feature TEXT, target TEXT, part TEXT, state TEXT, PRIMARY KEY(feature, target, part))`
  — the entries of a target with several: `state` is `written` (Navide's
  last write left it there) or `removed` (the user deleted it; never written
  back). Cleared with the target and on re-allow.
- kv `convenience.upgrade_notice` — set once the upgrade notice was published.

## WebSocket API

`convenience.list` → `{ features: Feature[], notices: LogEntry[], upgrade: UpgradeNotice | null }`

```ts
interface Feature {
  id: string                 // registry id
  cli: string                // agent key, or "all"
  toggleable: boolean
  state: 'allowed' | 'off'
  reason: 'default' | 'user' | 'removed'
  targets: { path: string; writtenAt: number; present: boolean }[]
}
interface LogEntry {
  id: number
  at: number                 // epoch seconds
  feature: string
  action: 'first' | 'repair' | 'reset' | 'removed' | 'removed-entry' | 'off' | 'allowed' | 'cleanup' | 'cleanup-failed' | 'prompt' | 'refused-unsafe' | 'refused-name'
  target: string
  detail: string             // plain English for the log; UI text comes from i18n by feature/action.
                             // For action 'prompt' (credentials.auto-repair) it is a JSON object,
                             // one of:
                             //   { agentKey, slotId, slotLabel, liveEmail, slotEmail, liveFingerprint }
                             //     the live login is another account than the slot
                             //     (emails may be null when the CLI stores none;
                             //     liveFingerprint is a hash of that live login,
                             //     never the secret)
                             //   { agentKey, reason: 'logout' }
                             //     the user signed out outside Navide (Claude, Codex);
                             //     no slotId, nothing to switch back to
  backup: string             // '' when none
  notify: boolean
  source: string             // who triggered it: 'settings' (a Navide main window,
                             //     proven by the window proof Electron main puts in
                             //     its windows' /ws URL — never the client's own word),
                             // 'ws-client' (any other client with the backend token),
                             // '' for Navide's own writes
}
interface UpgradeNotice { features: string[] } // ids in use when the upgrade ran
```

`convenience.history` `{ feature?: string, limit?: number }` → `{ entries: LogEntry[] }`

`convenience.set` `{ id, allowed: boolean }` → `{ feature: Feature }`. Off runs the
feature's removal (only Navide-marked entries) before switching off: each
target is backed up, its entry taken out, checked afterwards and logged as
`cleanup`. When an entry cannot be taken out (the file does not parse, the
write fails) it would keep working, so the switch does **not** move: the
target is logged and announced as `cleanup-failed`, the feature stays
`allowed`, and the call fails with `CLEANUP_INCOMPLETE`. Targets that were
taken back are dropped from the ledger, so writing them again later is a
`first`, never a removal. Allowed clears a `removed` reason and re-applies
startup features at once (per-spawn features apply on the next spawn).

Moving a switch is announced (`off` / `allowed`, notify true) and logged
with its `source`.

`convenience.upgrade_ack` `{}` → `{}`. Logs an `allowed` row for each feature
the notice named: it stays allowed with the user's say-so. Each row is
announced and carries its `source`, like a switch moved, so a client other
than a Navide window dismissing the notice is seen.

### Account prompts (`credentials.auto-repair`)

- The live login is read strictly: a failed read (a transient Keychain error)
  is not an empty login, so nothing is written and only the backend log says so.
- It is another account when both emails are known and differ, or, with only
  one email known, when its secret is not the slot's own (the slot's secret now,
  before the sign-in, or the pre-login copy a live-store sign-in put back). With
  no email on either side (kimi, the per-provider stores) nothing tells accounts
  apart: the login is restored, as before prompts existed. Identities, live and
  slot reads use the profile's provider scope. A prompt is never a write. Navide's active account then follows the login that stays live (the
  profile holding it, else a new one registered for it), so a later switch can
  never capture that login into the prompt's slot.
- "Switch back" is `cli_profiles.set_default { …, restore_live: true,
  restore_live_fingerprint }`, carrying the prompt's `liveFingerprint`. It is
  refused (`LIVE_CHANGED`) once another login is live, and is a normal switch
  with all its guards. When the slot is still the active account, the live
  login is first kept in the profile holding it (or one registered for it,
  never a second one for the same login), which is then switched away from;
  with nobody signed in the slot is just written back. Logged as a `repair`.
- An empty live login after Navide had published it on an earlier startup is
  the user signing out outside Navide: a `logout` prompt with only an
  acknowledgement, once per sign-out (not on every startup). The one-time promotion of legacy profile homes still
  publishes the active account.
- Every restore leaves an audit row, including one that failed part-way.
- Signing the active account in again through Navide is the user's own
  request, so its login goes live even with the switch off (still logged as a
  `repair`, and still a prompt when another account is live). A switch never
  captures live's older claude token over a newer one of the same account in
  the slot.
- The prompt detail keeps the two emails because the prompt shows them; they go
  to the audit log and the `convenience.changed` broadcast only, never the
  backend log.

Event `convenience.changed` `{ feature?: string, entry?: LogEntry }` — a write was
gated, a notice was added, or a state changed. The renderer re-reads
`convenience.list`.

## User-facing text

The overview is titled 「便利功能與 Navide 對你電腦的修改」 (en "Convenience
features and what Navide changes on your computer", ja
「便利機能と Navide があなたのコンピューターに加えた変更」). It is a tab of
Settings → CLI Extensions. Every feature has a name, a one-line benefit, what it
writes and where, the cost of turning it off, an Allowed/Off switch and its
history.

Notices read 「已依你允許的便利功能「X」，寫入 Y（為了 Z）」 and link to the
overview. A removal reads 「你移除了 Y，已關閉便利功能「X」；不會再自動加回」 with a
re-allow button. A re-add after a folder reset reads 「重置後重新加回：已依你允許的便利功能「X」，再次寫入 Y（為了 Z）」
and says the folder was deleted or created again. A workspace left alone
for safety reads 「Y 所在的 .cursor 指向專案資料夾外，為了安全，Navide 沒有在這裡設定便利功能「X」」. Terms follow `glossary.md`: never a bare 擴充/外掛; a CLI's own
hooks keep the vendor's name ("Claude hook").
