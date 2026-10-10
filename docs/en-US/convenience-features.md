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
   A deleted **file** is not a removal when it is the user's own file Navide
   merges into (Claude's and Qwen's settings.json): resetting the CLI's
   config folder took Navide's entry along with everything else, so the
   target is forgotten, the feature stays allowed and the next write is
   announced as `first`, like a fresh install. For Copilot, whose hook file
   is Navide's alone, only the whole `~/.copilot` folder gone counts as a
   reset; the folder still there without the hook file is a removal.
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
   target is announced as `first`, a later change as `repair`.
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
- `convenience_targets(feature TEXT, target TEXT, written_at INTEGER, PRIMARY KEY(feature, target))`
  — the ledger: every target Navide wrote for a feature.
- `convenience_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, feature TEXT, action TEXT, target TEXT, detail TEXT, backup TEXT, notify INTEGER, source TEXT)`
  — append-only. `action` is one of `first`, `repair`, `removed`, `off`,
  `allowed`, `cleanup`, `cleanup-failed`, `removed-entry`, `prompt`.
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
  action: 'first' | 'repair' | 'removed' | 'removed-entry' | 'off' | 'allowed' | 'cleanup' | 'cleanup-failed' | 'prompt'
  target: string
  detail: string             // plain English for the log; UI text comes from i18n by feature/action.
                             // For action 'prompt' (credentials.auto-repair) it is a JSON object:
                             // { agentKey, slotId, slotLabel, liveEmail, slotEmail }
  backup: string             // '' when none
  notify: boolean
  source: string             // who triggered it: 'settings' (a Navide main window),
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

`convenience.upgrade_ack` `{}` → `{}`. Logs an `allowed` row (not announced)
for each feature the notice named: it stays allowed with the user's say-so.

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
re-allow button. Terms follow `glossary.md`: never a bare 擴充/外掛; a CLI's own
hooks keep the vendor's name ("Claude hook").
