# Privacy and Data Flows

English | [繁體中文](../zh-TW/privacy.md) | [日本語](../ja-JP/privacy.md) | [Documentation](README.md)

Navide is **local-first**, not universally offline. Its Electron application, Python backend, terminal sessions, private project intelligence, workspace state, and orchestration logic run on your machine. Data can leave the machine when you enable or use an external service.

## Data kept locally by Navide

Depending on enabled features, Navide stores:

- Private per-user project intelligence and run artifacts under `<workspace>/.agent-team/`
- Roles, pipelines, recent workspaces, UI settings, analyzer settings, and AI provider settings in the application data directory
- Host-managed plugin storage partitions in the application data directory;
  these are keyed by authenticated plugin/package and, for workspace scope, by
  authenticated workspace, and are not sent to Navide or plugin registries
- Token-attribution and deduplication metadata derived from local CLI logs
- An activity log of what third-party Navide plugins asked the Host for, in the
  local `navide.db` (`plugin_activity`): the plugin, the `namespace.method`, the
  time, the workspace, whether it was allowed, refused or failed, a
  workspace-relative file path (a path outside the workspace is only
  `<outside-workspace>`; file contents are never stored) and, for shell calls,
  the executable and subcommand only. Detail rows are kept 7 days, then only
  per-day counts for 90 days. The bundled Plans, Git and Mini-IDE are not
  logged. It never leaves this machine
- Previews of chat messages kept for an offline pane, in the local `navide.db`
  (`channels.wake_kept`, then `channels.wake_lost` across a restart): the first
  40 characters of each message a bound chat sent while its pane was not
  online, so the chat can be told which ones were not sent. They are stored as
  typed, without masking, so a secret at the start of a message is stored too.
  They are deleted once the message is sent in or the chat has been told, when
  the chat is unbound, or when its bot is removed; while that bot stays
  disabled they wait for it. They never leave this machine
- Optional AI provider API keys in a local settings file protected with restrictive file permissions (`0600` on supported systems)

Navide does not operate a project telemetry service and does not require a Navide account.

When the Issue 16 production storage integration is enabled, uninstalling a
plugin removes its local storage after the cleanup step succeeds. A later
reinstall does not restore that deleted storage. Ordinary third-party
production plugin calls remain denied until their later grant/context
integration is enabled. The first-party `navide.git` migration is an explicit
Host-owned consumer: its Git preferences use the authenticated package and
workspace storage partitions, and an upgrade can clone the prior active
snapshot into the new candidate while retaining the old snapshot for
rollback.

## Private project intelligence

`.agent-team/` belongs to the individual user of that local workspace. It is excluded from Git and is not intended to synchronize state between human team members. It can contain private prompts, task context, session identifiers, agent output, run events, handoffs, token summaries, and future coordination metadata.

Do not remove `.agent-team/` from `.gitignore` or publish it as a substitute for intentionally authored project documentation. If an artifact must be shared, review and export only the specific specification, decision, report, patch, or evidence required.

A future portability feature should use explicit local export/import with redaction and selection controls. Navide must not silently turn private project intelligence into cloud or repository state.

## Features that may communicate externally

| Feature | Possible recipient | Data involved |
|---|---|---|
| Coding-agent CLI | The CLI vendor or configured model provider | Prompts, selected context, tool results, and provider-defined telemetry |
| Cloud AI (inline editing and code review) | Anthropic, OpenAI, Google, Groq, DeepSeek, Mistral, xAI, or a custom endpoint | Selected code, prompts, and model parameters |
| Context7 injection | Context7 and its MCP distribution/runtime dependencies | Detected library names and documentation queries |
| Web search | Search provider | Search query text |
| Git operations and Issue detection | Configured Git host, through local `git`, `gh`, or `glab` CLIs | Repository and Issue data, plus credentials handled by the CLI or Host account flow |
| Update checks | GitHub Releases | Application version and normal network metadata |
| Plugin Registry trust refresh | The selected Official Registry or an explicitly approved self-hosted Registry | The namespace/name of an installed marketplace plugin; no plugin source or archive is sent by the refresh |
| Skills package retrieval | GitHub API and codeload | Requested repository/ref and normal network metadata; downloads a public archive without uploading local skill contents |
| CLI risk DNS lookups | Operating system resolver and its configured upstream service | Declared expected hostnames and configured allowed hostnames |
| MCP servers | The configured MCP server and any service it uses | Depends entirely on that server's tools and configuration |
| Chat channels | The chat platform a pane is bound to (Telegram, Slack, Discord, ...) and everyone in that chat | Replies to messages sent from the chat; above the "Chat replies only" mirror level also local prompts, turn results, delegation text and child panes. Redaction only masks the channel's own bot credentials — API keys or other secrets in prompts or results are sent as is |

Read each provider's policy before sending private code or regulated data.

### Cross-device messaging

When you sign in to a Navide account and address a pane on another device, the
message body is sealed for that device's public key before it leaves. Navide’s
relay stores and forwards it without being able to read it — it holds no
corresponding private key.

What the relay *does* see is the metadata around the message: the sending and
receiving device ids, the workspace label and pane name on both ends, delivery
state, and timestamps. It also holds the session directory, which is how devices
find each other at all.

The absolute filesystem path of a workspace is **not** published. It used to be:
the session directory carried `workspacePath` verbatim, which in practice meant
the whole local path including your account name. Devices now publish a salted
digest instead. The salt is generated per install, kept in the local credential
vault, and never leaves the machine — so the digest is stable enough to group
panes from one workspace and cannot be turned back into a path by the relay or
by another device. An unsalted digest would not be enough here, because a path
is short and highly structured and would fall to a dictionary.

The workspace *label* (the folder's basename) and the pane name do remain
readable. They are the two halves of the `<device>/<workspace>/<pane>` address a
remote agent has to type, so hiding them would remove cross-device addressing by
name rather than protecting it. Reducing them further needs a user-chosen alias.

The production Git package invokes `git`, `gh`, and `glab` locally through a
Host-owned argv allowlist. Navide does not proxy those services or upload the
repository to Navide. GitHub or GitLab may still receive data when the local
CLI performs a remote operation or Issue query, according to the configured
remote, CLI login, and provider policy. Git account credentials remain in the
Host's protected local account store or the CLI's own credential flow; they are
not written into plugin-renderer storage. The isolated v2 Git renderer receives
only non-secret account metadata and workspace binding state. For a remote Git
operation, the Host injects the bound credential immediately before the backend
call. When no Host account is bound to the workspace, v2 can still use an
interactive credential flow owned by the Host: the Host creates an opaque,
instance-bound owner for that operation, forwards Git's prompts to the exact
originating Git view, and validates request ownership before accepting a
response. The entered secret is held only for that exchange and is never
persisted in plugin storage. A credential response from another view or for a
different workspace is rejected.

While an installed marketplace plugin is present, Navide sends that plugin's
namespace/name to its selected Registry when the app starts and every 15
minutes. The request retrieves signed trust metadata so Navide can detect
revoked publishers or packages and quarantine an installed plugin. The
destination is the App-pinned Official Registry when the Official URL is used,
or the exact self-hosted URL and root that the user explicitly approved. This
refresh does not upload plugin source, package archives, or workspace files.

Navide retains the latest signed trust snapshot locally with the plugin
installation so restart checks can continue; the Registry controls retention
of its own request logs. There is no separate refresh toggle today. Removing
the installed marketplace plugins stops this flow; other external-service
flows are governed by their own settings and configuration.

## CLI risk observation data

For vendors with declarations, the backend samples numeric endpoints of established TCP sockets attributed to active pane process trees and inventories declared local data roots. Format checks read at most 64 KiB from each candidate file locally. This feature does not intercept packets, decrypt TLS or upload file contents. Read buffers are used for format recognition; file contents and tokens are not stored in the risk records.

The local `navide.db` retains baseline and file-membership metadata, paths, sizes/classes, presence and absence observation times, network endpoint findings and counts, availability, and Ignore/Allow decisions. An allowed exact IP is also retained in that vendor's UI settings. Metadata can reveal local paths and contacted IPs even though it contains no copied file contents.

Building the expected-address snapshot performs forward DNS lookups for declared expected hostnames and any configured allowed hostnames through the operating system resolver. That resolver, and its configured upstream service, can receive those names. Numeric IP allowances need no hostname lookup. The feature does not infer destination names with reverse DNS; an address match or mismatch cannot establish traffic contents or intent.

## Credentials

Agent CLI credentials remain in each CLI's own configuration. If you enter cloud AI keys in Navide, Navide stores them locally so AI features (inline editing, code review) can use them. Settings export redacts API keys and tokens.

**Portable CLI credentials** are the exception you opt into: a value a vendor documents for carrying between machines (for example the token `claude setup-token` prints) that you paste in Settings → Accounts. Navide stores it encrypted on this device and hands it to new panes of that CLI in their environment only; it never writes it into the CLI's own login files. Removing it from a device removes it from that device.

If you switch on **Credentials** under Settings → Sync (off by default), each pasted credential is encrypted on your device with your account's sync key before it leaves and stored by Navide Cloud as ciphertext the service cannot open. Another device signed in to the same account decrypts it and keeps it encrypted at rest, again handing it to panes only. What the service can see is an opaque item id, a revision number, a timestamp and which device wrote the record — not which CLI or account the credential belongs to. Removing a credential on one device does not remove it from the cloud or your other devices, and nothing is uploaded until you switch the section on; switching accounts on a device drops what that device imported and switches the section off again.

Local file permissions reduce accidental access by other users on the same machine but do not protect against malware, a compromised user account, unrestricted agents, backups, or processes with equivalent permissions.

## Agent permissions

Agents run with the current user's operating-system permissions unless the external CLI provides and enables its own sandbox. Navide does not currently provide a complete workspace sandbox.

YOLO mode may bypass CLI confirmation or sandbox protections. Use it only in trusted, version-controlled workspaces and review commands and diffs afterward.

## Local ports and files opened for agent CLIs

Some CLIs accept an inter-CLI message through a channel other than their terminal input. Navide gives those panes what that channel needs at launch, all of it on this machine: a loopback-only HTTP port the CLI itself serves (`opencode`, `kilo`), or a per-pane file in the Navide application data directory that the CLI watches. Nothing here leaves the machine.

An `opencode` pane's port carries no password, because that CLI's own interface cannot authenticate against its own server. Any process running as you can therefore drive that pane. A `kilo` pane's port is protected by a per-pane secret passed in its environment.

A `qwen` pane's file holds the text of each message sent to it in the clear. It is removed when the pane closes, and any file an interrupted backend left behind is removed the next time Navide starts.

A `claude` pane's channel is a hook in that CLI's own settings file instead. It carries a secret Navide keeps in one owner-only file in its application data directory, which marks the hook as one this machine installed; it is not readable by other users and never leaves the machine.

Every one of these is per CLI and can be switched off in Settings → CLI Agents → Push channels, after which messages to those panes are typed into the terminal as before. See [Inter-CLI messaging](inter-cli-messaging.md) for the full trade-off.

## Context handoffs

Cross-agent handoffs can include task context and prior-stage output. Automatic secret scrubbing is not yet a complete security boundary. Do not place credentials in prompts, generated plans, logs, or files that may be handed to another agent.

## Removing local data

Private project intelligence can be removed from the workspace's `.agent-team/` directory after active sessions are stopped. Deleting it can remove resumability, run history, attribution, and accumulated context without deleting the source repository. Application-wide settings and histories live in the Navide application data directory. Back up any configuration you intend to preserve before deletion.

For vulnerability reporting, see the [Security Policy](../../SECURITY.md).

## Token Monitor local records

Token Monitor reads local Claude transcripts to summarize turn timestamps, session identifiers, models, and token counts. Its in-memory cache contains these summaries rather than prompt or response text. Local transcript records are not assigned to the current account because their account ownership cannot be verified.

Successful observations from the existing Claude quota polling service are saved in the application data directory as `claude-quota-history.sqlite3`. Records contain an account-slot identifier, observation time, plan type, quota percentages, and reset-window metadata; they contain no credentials or conversation text. Recording prunes observations older than 180 days and limits the database to 50,000 samples. This history is local to this installation and is not uploaded by Token Monitor. Opening or refreshing the monitor adds no external API or CLI requests; the existing usage service retains its own polling behavior.

### Skills installation through MCP

Preparing a public GitHub skill sends its repository and ref, plus normal connection metadata, to `api.github.com`, then downloads the resolved commit archive from `codeload.github.com`. Sources accept `owner/repo` or an HTTPS `github.com/owner/repo` URL; private repositories, arbitrary download URLs and redirects are rejected. Navide adds no GitHub authorization credentials and uploads no local skill contents during retrieval. System proxy settings may still apply. Preparing a local package only reads the selected local skill directory and makes no GitHub request.

Prepared bytes stay in backend memory and become unusable after 15 minutes or backend restart. At most eight packages may be active, with up to eight lightweight completed retry receipts held separately in memory. Installation uses the reviewed snapshot without rereading its source, writes to the existing shared Skills root, and never executes scripts or plugin hooks. A retained receipt lets a retry return the original result without another write; it expires at the original preview deadline or may be evicted earlier. Retry after expiry or eviction returns missing/expired without reinstalling. Inspection and preparation return skill text, file information and source paths to the requesting coding agent; its configured model provider may receive those results under the CLI's own data policy. Avoid secrets in skill packages.

Skills sync, when enabled, can carry eligible installed content and delivery settings to paired devices through the existing flow. The selected package uses the same limits as Skills content export: 64 files, 256 KiB per file and 512 KiB total. These limits do not guarantee that synchronization completed. Backend-generated source, digest and timestamp records are stored in a local Navide marker, survive local edits and restart, and are excluded from export and Skills sync.

### Navide Marketplace queries through MCP

`marketplace_search` and `marketplace_detail` make the Navide app send the same request the Navide Marketplace page sends to the configured Registry: the search text, category and page, or the package name. `plugins_list_installed` sends nothing out; it reads the local inventory. All three return their answer (public listing data, and the ids, versions and states of the installed Navide plugins) to the requesting coding agent, and its configured model provider may receive it under the CLI's own data policy.

### Navide Marketplace requests through MCP

`marketplace_request_install`, `_update` and `_rollback` make the Navide app look the package up the same way `marketplace_detail` does, and all request tools read the local inventory. The request, with the requesting pane's name and workspace and the agent's reason, stays in backend memory until it is decided or expires, and is shown to the user in a Navide window. `plugins_disable` and `plugins_enable` send nothing out. Every request, decision, disable and enable is recorded locally in navide.db (`plugin_agent_actions`: the plugin, the action, the caller's kind, pane id, pane name and workspace, the outcome) and kept 30 days, then the newest 10,000 rows.
