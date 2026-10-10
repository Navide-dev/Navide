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
3. **Backup.** A file target is copied into
   `<app data>/convenience-backups/<feature>/<sha256>.bak` (deduplicated).
4. **Write.** `write()` performs the existing write unchanged.
5. **Notify.** Only when the target's bytes changed: the first write to a
   target is announced as `first`, a later change as `repair`.
6. **Audit log.** Every write, removal detection, off and re-allow is appended.

A target that already carries Navide's entry when first seen (an upgraded
install) is added to the ledger silently: nothing was written, so there is
nothing to announce.

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
| `pane-shims` | kimi, grok, antigravity, muse | `~/.navide-panes/` and adopted entries in the vendor's own directory | no (required) | — |
| `claude.account-homes` | claude | links and moved files in `~/.claude` for signed-in accounts | no (required) | — |

Required features are listed for disclosure only. They have no switch because
the panes they serve cannot run without them.

## Persistence (navide.db)

- `convenience_features(id PRIMARY KEY, state TEXT, reason TEXT, updated_at INTEGER)`
  — `state` is `allowed` or `off`; `reason` is `default`, `user` or `removed`.
  A missing row means `allowed`/`default`.
- `convenience_targets(feature TEXT, target TEXT, written_at INTEGER, PRIMARY KEY(feature, target))`
  — the ledger: every target Navide wrote for a feature.
- `convenience_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, feature TEXT, action TEXT, target TEXT, detail TEXT, backup TEXT, notify INTEGER)`
  — append-only. `action` is one of `first`, `repair`, `removed`, `off`,
  `allowed`, `cleanup`, `prompt`.
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
  action: 'first' | 'repair' | 'removed' | 'off' | 'allowed' | 'cleanup' | 'prompt'
  target: string
  detail: string             // plain English for the log; UI text comes from i18n by feature/action.
                             // For action 'prompt' (credentials.auto-repair) it is a JSON object:
                             // { agentKey, slotId, slotLabel, liveEmail, slotEmail }
  backup: string             // '' when none
  notify: boolean
}
interface UpgradeNotice { features: string[] } // ids in use when the upgrade ran
```

`convenience.history` `{ feature?: string, limit?: number }` → `{ entries: LogEntry[] }`

`convenience.set` `{ id, allowed: boolean }` → `{ feature: Feature }`. Off runs the
feature's removal (only Navide-marked entries) before switching off; allowed
clears a `removed` reason and re-applies startup features at once (per-spawn
features apply on the next spawn).

`convenience.upgrade_ack` `{}` → `{}`.

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
