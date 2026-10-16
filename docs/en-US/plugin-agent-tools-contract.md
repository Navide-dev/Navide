# Navide Plugin Agent Tools and Disclosure: Interface Contract (v1)

Status: **contract only**. This is step 0 ("介面約定") of plan B in
`.agent-team/plans/navide_b5ecff.html` (section `plan-b`). It fixes the shapes
that the parallel work lines B1 (agent tools), B2 (Navide Marketplace MCP
tools) and D (disclosure) build against. Nothing described here is wired into
the app yet:

- `plugin-manifest-v2.schema.json` still refuses `backend.agentTools`
  ([section 2.6](#26-schema-fragment-not-yet-accepted)); B1-a turns it on.
- No MCP tool, Host route, WebSocket handler, UI, Registry endpoint or database
  table exists for anything below. The reference code is types, constants and
  pure functions that nothing imports:

| Language | Module | Contents |
|---|---|---|
| TypeScript | `src/shared/pluginAgentTools.ts` | names, text rules, `validateAgentTools`, wire types, approval types |
| TypeScript | `src/shared/pluginDisclosure.ts` | `computeDisclosure`, risk rule, `canonicalContractJson`, `diffDisclosure` |
| Python | `backend/agent_team_backend/plugins/agent_tools_contract.py` | the same as `pluginAgentTools.ts`, plus the SQLite DDL |
| Python | `backend/agent_team_backend/plugins/disclosure_contract.py` | the same as `pluginDisclosure.ts` |

Both languages are held to the fixtures in
`docs/plugin-contracts/agent-tools-fixtures/` by
`src/shared/pluginAgentTools.test.ts`, `src/shared/pluginDisclosure.test.ts`
and `backend/tests/test_plugin_agent_tools_contract.py`. A change to this
contract changes the fixture first; both test suites must then go green.

The governing rule of plan B is **disclose, don't restrict**: everything a
package can do is declared, shown and consented to. The only hard rules are the
ones that stop impersonation or deception (tool-name prefixes, reserved names,
text that could fake another tool or a system message) and the DB9 stability
cap.

## 1. Vocabulary

- **Package**: a Navide plugin package (Manifest v2). User-facing text follows
  [glossary.md](glossary.md): "Navide plugin", never a bare "plugin".
- **Agent tool**: a tool a package declares in `backend.agentTools`. Once the
  user consents, it is served by the one core `navide` MCP server.
- **Core tools**: the tools the core `navide` MCP server serves today
  (`plan_*`, `cli_*`, ...). They are never third-party.
- **Disclosure** ("揭露資料"): the JSON object computed from a manifest by
  `computeDisclosure` ([section 3](#3-disclosure)).

## 2. Manifest: `backend.agentTools[]`

### 2.1 Fields

```json
"backend": {
  "entry": "bin/devmap",
  "protocolVersion": 1,
  "activation": "startup",
  "methods": ["devmap.read", "devmap.setStatus"],
  "agentTools": [
    {
      "name": "devmap_set_status",
      "method": "devmap.setStatus",
      "risk": "write",
      "title": "Set block status",
      "description": "Set one block's status (done|wip|plan) in this workspace's dev map.",
      "timeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "required": ["block_id", "status"],
        "properties": {
          "block_id": { "type": "string" },
          "status": { "enum": ["done", "wip", "plan"] }
        }
      }
    }
  ]
}
```

| Field | Required | Type | Rule |
|---|---|---|---|
| `name` | yes | string | [2.2](#22-names-and-the-prefix); unique within the package |
| `method` | yes | string | must be listed in `backend.methods`; the Host forwards the call to it |
| `risk` | yes | `"read"` \| `"write"` | shown on every disclosure surface; `write` raises the risk level to high |
| `title` | yes | string | [2.4](#24-text-rules); no length limit (DB9 only) |
| `description` | yes | string | [2.4](#24-text-rules); no length limit (DB9 only); consent shows it in full |
| `inputSchema` | yes | object | JSON Schema with `"type": "object"`; every number in it must be a safe integer ([3.7](#37-canonical-serialization)); no depth or size limit (DB9 only) |
| `timeoutMs` | no | integer | 1 to 120000 (the Host's existing backend-call bound, `MAX_BACKEND_TIMEOUT_MS`); default 30000 |

No other field is allowed. `agentTools` requires a native backend, so a package
that declares it is at least risk **high**. Frontend-only packages cannot
declare agent tools (DB13 is open).

### 2.2 Names and the prefix

- Name pattern: `^[a-z][a-z0-9]{1,15}_[a-z0-9_]{1,40}$` (whole string; Python
  uses `fullmatch` because its `$` also matches before a trailing newline).
- The **prefix** is derived from the plugin id: take the last dot segment,
  remove every `-`, and accept the result only if it matches
  `^[a-z][a-z0-9]{1,15}$`. `nerdtechnic.devmap` → `devmap`,
  `nerdtechnic.dev-map` → `devmap`, `acme.tools.devmap` → `devmap`. An id whose
  prefix cannot be derived (for example `acme.1tool`, or a last segment over 16
  characters) cannot declare agent tools.
- Every tool name must start with `<prefix>_`.
- Two packages that derive the same prefix may both install; when two
  available tools have the same name, the one installed later is not served
  (state `name-collision`, [4.1](#41-host--backend-pluginsagenttoolssync)) and
  the Navide Plugins page says why (DB1).

### 2.3 Reserved names

A derived prefix in this list is refused (`AGENT_TOOL_PREFIX_RESERVED`):

`cli_` `credentials_` `evolve_` `marketplace_` `mcp_` `memory_` `navide_`
`pipeline_` `plan_` `plugins_` `preview_` `prompt_` `role_` `scheduler_`
`share_` `skills_` `stage_` `ui_` `workspace_`

Every core tool name is also refused (`AGENT_TOOL_NAME_RESERVED`). The list is
pinned in `agent-tools-fixtures/reserved-names-v1.json` (`coreToolNames`, 80
names: `mcp_server/server.py` plus the plan and skills tools the built-in
packages install). `test_every_live_core_tool_is_reserved` fails when a core
tool exists that is neither listed nor under a reserved prefix; adding a core
tool means adding it there (or giving it a reserved prefix).

### 2.4 Text rules

- `title` and `description`: non-empty strings containing no character in
  U+0000–U+001F, U+007F–U+009F, U+2028, U+2029, and no `<` or `>`
  (`isValidAgentToolText`). These are what could fake a second tool or a system
  message in a tool list or a terminal.
- The core server prefixes every description with the source label
  `[third-party Navide plugin <id> v<version> | permissions: ...]` (D4, built by
  B1-c from the sync entry's `permissions`).
- Tool **results**: every Cc character except TAB and LF is removed
  (`sanitizeAgentToolResultText`; CR is removed too), then the result is wrapped
  as external content with the plugin id, version and permissions (D4).

### 2.5 Validation order and error codes

`validateAgentTools(manifest)` reads only `id` and `backend` and returns every
error as `{ index, field, code }`, ordered by entry index and then:

1. `agentTools` is not an array → `{index: null, field: "agentTools", code: "AGENT_TOOLS_NOT_ARRAY"}` (stop)
2. entry is not an object → `AGENT_TOOL_NOT_OBJECT` (next entry)
3. unknown fields, sorted by name → `AGENT_TOOL_FIELD_UNKNOWN`
4. missing required fields, in the order of [2.1](#21-fields) → `AGENT_TOOL_FIELD_MISSING`
5. `name`: the first of `AGENT_TOOL_PREFIX_UNDERIVABLE`, `AGENT_TOOL_NAME_INVALID`,
   `AGENT_TOOL_PREFIX_MISMATCH`, `AGENT_TOOL_PREFIX_RESERVED`, `AGENT_TOOL_NAME_RESERVED`;
   if none, `AGENT_TOOL_NAME_DUPLICATE` for a name an earlier entry used
6. `method` not in `backend.methods` → `AGENT_TOOL_METHOD_UNDECLARED`
7. `risk` → `AGENT_TOOL_RISK_INVALID`
8. `title` → `AGENT_TOOL_TEXT_INVALID`
9. `description` → `AGENT_TOOL_TEXT_INVALID`, else `AGENT_TOOL_TOO_LARGE`
10. `inputSchema` → `AGENT_TOOL_SCHEMA_INVALID`, else `AGENT_TOOL_NON_INTEGER_NUMBER`, else `AGENT_TOOL_TOO_LARGE`
11. `timeoutMs` → `AGENT_TOOL_TIMEOUT_INVALID` (booleans, strings and fractions included)

A package with any error is refused at install and publish, exactly like a
schema error.

### 2.6 Schema fragment (not yet accepted)

`agent-tools-fixtures/manifest-agent-tools.fragment.schema.json` holds the
JSON Schema that B1-a adds to `$defs.backend.properties` of
`plugin-manifest-v2.schema.json` (both copies) together with the
`agentTool` and `agentToolText` definitions. Until then the schema refuses the
field (`backend` has `additionalProperties: false`), and both test suites
assert that it still does, so the switch is a deliberate edit in B1-a. Rules the
schema cannot express (prefix, reserved names, declared method, uniqueness,
integers, DB9) stay in `validateAgentTools`.

### 2.7 DB9 stability cap

1 MiB (1,048,576 bytes, UTF-8) each for one `description`, one `inputSchema`
in its canonical spelling, and one tool result. It protects the MCP server,
not a policy; the disclosure card says the cap exists. A result over the cap
fails with `PLUGIN_TOOL_RESULT_TOO_LARGE`.

### 2.8 Consent binding (for B1-a)

The existing native-backend consent binds to the package digest and to
`permissions`, `backend.methods` and `backend.events`
(`backendPermissionsKey`). B1-a adds the canonical spelling of the disclosure's
`agentTools` array to that key **only when it is non-empty**, so a package
without agent tools keeps its existing key and its existing consent records
stay valid. Any change to any tool (name, method, risk, text, schema, timeout)
then requires new consent, and until then all of that package's tools are in
state `consent-required`.

## 3. Disclosure

### 3.1 Shape

`computeDisclosure(manifest)` returns (example: the dev map 0.2.0 in
`disclosure-cases.json`):

```json
{
  "schemaVersion": 1,
  "plugin": { "id": "nerdtechnic.devmap", "version": "0.2.0", "publisher": "nerdtechnic" },
  "summary": {
    "template": "plugin-disclosure.summary.v1",
    "clauses": [
      { "key": "nativeBackend", "params": {} },
      { "key": "files", "params": { "access": "readWrite" } },
      { "key": "shell", "params": { "mode": "allowlist", "executables": ["gh", "git", "glab"] } },
      { "key": "ui", "params": {} },
      { "key": "agentTools", "params": { "read": 1, "write": 1 } }
    ]
  },
  "risk": {
    "level": "high",
    "reasons": [
      { "key": "system.ui", "level": "low" },
      { "key": "system.fs", "level": "medium" },
      { "key": "shell.allowlist", "level": "high" },
      { "key": "nativeBackend", "level": "high" },
      { "key": "agentTools.write", "level": "high" }
    ]
  },
  "permissions": {
    "system": ["fs", "ui"],
    "shell": { "mode": "allowlist", "executables": ["gh", "git", "glab"] },
    "scopes": { "fs": { "root": "repository", "read": ["**/.git/**", "**/.navide/devmap.json"], "write": ["**/.navide/devmap.json"] } }
  },
  "nativeBackend": { "methods": ["devmap.read", "devmap.setStatus"], "events": ["devmap.changed"] },
  "network": "none",
  "agentTools": [
    { "name": "devmap_read", "method": "devmap.read", "risk": "read", "title": "Read dev map",
      "description": "Read this workspace's dev map.", "timeoutMs": 30000,
      "inputSchema": { "type": "object", "properties": {} } },
    { "name": "devmap_set_status", "...": "..." }
  ],
  "dataLocations": {
    "hostStorage": true,
    "backendDataDirectory": true,
    "projectWrites": { "root": "repository", "patterns": ["**/.navide/devmap.json"] }
  }
}
```

Every array is sorted (code-unit order; all values involved are ASCII), so the
result does not depend on the order the manifest lists things in. Absent
optional manifest arrays become `[]`.

| Field | Derivation |
|---|---|
| `plugin` | `id`, `version`, `publisher` of the manifest |
| `permissions.system` | `permissions.system`, sorted; `[]` when absent |
| `permissions.shell` | `allowlist` → `{mode: "allowlist", executables: ["gh","git","glab"]}` (the Host shell allowlist); `full` → `{mode: "full", executables: null}` (any executable); absent → `null` |
| `permissions.scopes` | `scopes.fs` with `root` defaulted to `workspace` and `read`/`write` sorted (absent → `[]`); `null` when no scopes |
| `nativeBackend` | `{methods, events}` sorted when the manifest has `backend` (also when it lists none); otherwise `null` |
| `network` | always `"none"`: the sandbox has no network and DB10 (a network permission) is deferred |
| `agentTools` | each declared tool with `timeoutMs` defaulted, sorted by `name` |
| `dataLocations.hostStorage` | always `true` (Host-managed storage partitions) |
| `dataLocations.backendDataDirectory` | `true` when `nativeBackend` is not `null` (the sandbox's private data directory) |
| `dataLocations.projectWrites` | no `fs` → `"none"`; `fs` without scopes → `"undeclared"`; scopes without `write` → `"none"`; otherwise `{root, patterns: write}` |

### 3.2 Summary clauses

The one-line summary is not free text: it is the ordered list `clauses`, and
each surface renders it from the localized i18n template
`plugin-disclosure.summary.v1` (zh-TW, en, ja; D-c owns the strings,
i18n key per clause `pluginDisclosure.summary.<key>`). Publishers cannot write
it. Clauses appear in this order, each only when it applies:

| Clause `key` | When | `params` |
|---|---|---|
| `nativeBackend` | `nativeBackend` is not `null` | `{}` |
| `files` | `system` contains `fs` | `{access: "read"}` when scopes are declared without `write`, else `{access: "readWrite"}` |
| `shell` | `shell` is not `null` | the `permissions.shell` object |
| `aiCli` | `system` contains `aiCli` | `{}` |
| `ui` | `system` contains `ui` | `{}` |
| `agentTools` | at least one tool | `{read: <count>, write: <count>}` |
| `network` | reserved for DB10; never produced in v1 | `{}` |
| `noPermissions` | none of the above | `{}` |

### 3.3 Risk level

The level is the highest level among the reasons that apply, and `low` when
none apply. Reasons are listed in this fixed order:

| Reason `key` | Applies when | Level |
|---|---|---|
| `system.ui` | `system` contains `ui` | low |
| `system.fs` | `system` contains `fs` (workspace read/write) | medium |
| `system.aiCli` | `system` contains `aiCli` | high |
| `shell.allowlist` | `shell` is `allowlist` | high |
| `nativeBackend` | the manifest has `backend` | high |
| `agentTools.write` | at least one tool has `risk: "write"` | high |
| `shell.full` | `shell` is `full` | highest |
| `network` | reserved for DB10; never produced in v1 | highest |

Every surface shows the level with colour, icon and text together (D5).

### 3.4 Registry facts and the card

Publisher verification and review/scan results are known only to the Registry
and are **not** part of the manifest disclosure, because the App cannot
recompute them. They travel beside it:

```json
{
  "manifest": { "...": "ManifestDisclosure" },
  "registry": {
    "publisher": { "name": "Nerdtechnic", "verifiedDomain": "nerdtechnic.com", "domainVerifiedAt": "2026-10-01T00:00:00Z" },
    "signature": { "signed": true, "keyId": "registry-2026" },
    "review": { "status": "approved", "reviewedAt": "2026-10-16T09:00:00Z", "nativeCodeInspected": true },
    "scan": { "secretScan": "clean", "secretFindings": 0, "similarityWarning": false, "similarTo": null, "scannedAt": "2026-10-16T08:55:00Z" }
  }
}
```

`review.status` is `approved` | `pending` | `rejected` | `not-required`;
`nativeCodeInspected` is `null` for a package without a backend;
`scan.secretScan` is `clean` | `findings` | `not-run`. `registry` is `null`
where no Registry is involved. This `DisclosureCard` is what every surface
renders: list card (summary and level), detail page, consent dialog and the B2
approval card.

### 3.5 Trust check

D-a computes the manifest disclosure at publish time and puts its canonical
spelling inside the signed envelope. D-b recomputes it at `prepareInstall` from
the manifest inside the downloaded package; if the two canonical strings
differ, the install is refused. This is the only new install-blocking rule.

### 3.6 Diff

`diffDisclosure(from, to)` flattens each disclosure into items
`{kind, key, detail}`, sorted by `kind` and then `key`:

| `kind` | `key` | One per |
|---|---|---|
| `system` | `fs` / `ui` / `aiCli` | system namespace |
| `shell` | `allowlist` / `full` | shell mode |
| `shellExecutable` | executable name | allowlisted executable |
| `fsScopeRoot` | `workspace` / `repository` | declared scopes |
| `fsScopeRead`, `fsScopeWrite` | pattern | pattern |
| `nativeBackend` | `native` | backend |
| `backendMethod`, `backendEvent` | name | name |
| `network` | value | only when not `none` |
| `agentTool` | tool name | tool; `detail` is the tool entry without `name` |

`detail` is `null` for every kind except `agentTool`. Two items are the same
only when their canonical spellings are equal, so a tool whose description or
schema changed shows up once under `removed` (old) and once under `added`
(new). The result:

```json
{
  "schemaVersion": 1,
  "from": { "id": "nerdtechnic.devmap", "version": "0.1.0", "risk": "medium" },
  "to": { "id": "nerdtechnic.devmap", "version": "0.2.0", "risk": "high" },
  "added": [ { "kind": "agentTool", "key": "devmap_read", "detail": { "...": "..." } } ],
  "removed": [],
  "unchanged": [ { "kind": "system", "key": "fs", "detail": null } ],
  "widened": true
}
```

`widened` is true when `added` is non-empty or the risk level rose. D2: an
update that is not widened installs without a dialog and shows one
notification; a widened one shows the consent dialog with only the difference.
The same function serves rollback.

### 3.7 Canonical serialization

`canonicalContractJson` is the spelling used to sign and to compare: the
existing `canonicalJson` / `confirm_token.canonical_json` rules (keys sorted,
no whitespace, every non-ASCII character escaped as `\uXXXX`, Python
`json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=True)`), with
one restriction: every number must be a safe integer (|n| ≤ 2^53 − 1). An
integral float such as `1.0` is spelled `1`; any other number is refused
(TypeScript `TypeError`, Python `CanonicalJsonError`, a `TypeError`
subclass). This is why `inputSchema` may hold only integers. Keys are compared
as strings; contract keys are ASCII, so both languages sort them the same way.
`canonical.json` pins a disclosure's spelling literally.

## 4. Host and backend messages

### 4.1 Host → backend: `plugins.agentTools.sync`

A Host event carrying the complete catalog; each one replaces the previous one.

```json
{
  "revision": 12,
  "enabled": true,
  "externalCallers": false,
  "tools": [
    {
      "pluginId": "nerdtechnic.devmap", "pluginVersion": "0.2.0",
      "name": "devmap_set_status", "title": "Set block status",
      "description": "Set one block's status (done|wip|plan) in this workspace's dev map.",
      "risk": "write", "method": "devmap.setStatus", "timeoutMs": 30000,
      "inputSchema": { "type": "object", "properties": {} },
      "state": "available",
      "permissions": { "system": ["fs", "ui"], "shell": { "mode": "allowlist", "executables": ["gh", "git", "glab"] }, "scopes": { "...": "as in 3.1" } }
    }
  ]
}
```

- `revision` increases strictly within one Host process; the backend ignores
  a snapshot whose revision is not greater than the last one it applied, and
  starts again from the first snapshot after a Host reconnect.
- `enabled` is the DB8 master switch. While it is off since start-up, the Host
  sends **nothing** (no-regression guarantee: `tools/list` equals main). When
  it is switched off, the Host sends one snapshot with `enabled: false` and
  `tools: []`.
- `externalCallers` is the DB4 switch.
- `state` is `available` | `consent-required` | `plugin-disabled` |
  `plugin-quarantined` | `plugin-revoked` | `name-collision`. Only `available`
  tools are registered (`add_tool`); every other entry is removed
  (`remove_tool`) but kept so a call can name the reason. A removed package is
  simply absent.
- `permissions` is the package version's disclosure `permissions` object, from
  which the backend builds the D4 label.
- The Host pushes on install, consent, disable, enable, quarantine, revoke,
  remove, a new version awaiting consent, and either switch.

### 4.2 Backend → Host: the agent tool call

The generic proxy tool sends the existing `agent.capability.request` event
(the one `request_host_agent_workspace_backend` already uses) with
`operation: "agentTool"`:

```json
{
  "request_id": "mcp:3f2a...",
  "operation": "agentTool",
  "target": { "plugin_id": "nerdtechnic.devmap", "workspace_path": "/Users/me/project" },
  "tool": { "name": "devmap_set_status", "plugin_version": "0.2.0", "sync_revision": 12 },
  "caller": { "kind": "pane", "paneId": "p-41", "workspace": "/Users/me/project" },
  "payload": { "arguments": { "block_id": "b1", "status": "done" } }
}
```

`caller` comes from `_resolve_caller` and is never taken from tool arguments.
`kind` is `pane` (with `paneId` and the pane's `workspace`), `external` or
`host` (both with `paneId: null`, `workspace: null`). `external` and `host`
callers need the DB4 switch.

The Host answers through the existing `resolve_agent_capability(request_id,
result)` path:

```json
{ "ok": true, "result": { "...": "plugin result" }, "meta": { "durationMs": 41, "resultBytes": 212, "crossWorkspace": false } }
```

```json
{ "ok": false, "error": "devmap is disabled", "error_code": "PLUGIN_TOOL_UNAVAILABLE", "reason": "plugin-disabled" }
```

Host checks run on every call, in this order, regardless of what the CLI has
cached: master switch → caller kind → package installed, enabled, not
quarantined, not revoked, not stopping → tool in the consented list →
workspace grant → first-write confirmation (DB3) → execution policy →
headless binding → `callBound`.

| `error_code` | Meaning |
|---|---|
| `BAD_REQUEST` | malformed request |
| `PLUGIN_TOOL_UNAVAILABLE` | not callable now; `reason` is one of `master-switch-off`, `external-callers-off`, `plugin-not-installed`, `plugin-disabled`, `plugin-quarantined`, `plugin-revoked`, `plugin-stopping`, `consent-required`, `tool-not-consented`, `name-collision` |
| `WORKSPACE_NOT_AUTHORIZED` | no grant for the target workspace |
| `WORKSPACE_WRITE_DECLINED` | the user declined the first-write confirmation |
| `EXECUTION_POLICY_DENIED` | the user's agent execution policy refused it |
| `PLUGIN_TOOL_INVALID_ARGUMENTS` | arguments do not match `inputSchema` |
| `PLUGIN_TOOL_TIMEOUT` | the backend did not answer within `timeoutMs` |
| `PLUGIN_TOOL_FAILED` | the backend answered with an error; its own code is in `plugin_error` |
| `PLUGIN_TOOL_RESULT_TOO_LARGE` | result over the DB9 cap |

The transport failures that exist today stay as they are (`host_unavailable`,
`host_timeout`, lower-case, produced by the backend itself).

### 4.3 Backend → Host: `marketplace.query`

For the B2 read-only tools (`marketplace_search`, `marketplace_detail`,
`plugins_list_installed`). The backend unicasts `marketplace.query.request` to
the authenticated Host session; the Host answers with the WebSocket message
`marketplace.query.result`.

```json
{ "request_id": "mq:91c0...", "query": { "kind": "search", "text": "dev map", "category": "productivity", "cursor": null, "limit": 20 } }
```

`query.kind` is `search` (`text`, optional `category`, `cursor`, `limit`),
`detail` (`id`, optional `version`) or `installed` (no fields). Results:

- `search` → `{kind, items: ListingItem[], nextCursor}`
- `detail` → `{kind, item: ListingItem, versions: string[], card: DisclosureCard}`
- `installed` → `{kind, items: [{id, version, enabled, quarantined, hasBackend, agentTools: [{name, state}]}]}`

`ListingItem` is `{id, version, name, description, publisher: {name,
verifiedDomain}, signed, downloads, risk, summary}`. Errors use `{ok: false,
error, error_code}` with `BAD_REQUEST` | `NOT_FOUND` | `REGISTRY_UNAVAILABLE` |
`HOST_UNAVAILABLE`. Every piece of third-party text (names, descriptions) is
wrapped as external content by the backend before an agent sees it.

## 5. Storage in `navide.db`

The DDL is `PLUGIN_AUDIT_DDL` in `agent_tools_contract.py`; B1-d and D-e
execute it inside navide.db's existing schema setup (no migration framework is
involved; every statement is `IF NOT EXISTS`). Times are Unix milliseconds;
`day` is the UTC date `YYYY-MM-DD`.

`plugin_tool_calls` (B1-d; one row per agent tool call):

| Column | Type | Content |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `at` | INTEGER | call start |
| `caller_kind` | TEXT | `pane` / `external` / `host` |
| `pane_id`, `pane_name` | TEXT | `''` when not a pane |
| `caller_workspace`, `target_workspace` | TEXT | |
| `cross_workspace` | INTEGER | 0/1 |
| `plugin_id`, `plugin_version`, `tool`, `risk` | TEXT | |
| `args_sha256`, `args_bytes` | TEXT, INTEGER | of the canonical arguments; the arguments are **not** stored |
| `outcome` | TEXT | `ok` / `error` |
| `error_code` | TEXT | `''` on success |
| `duration_ms`, `result_bytes` | INTEGER | |

Indexes `(at)` and `(plugin_id, at)`. Retention: rows older than 30 days are
deleted, then all but the newest 10,000.

`plugin_activity` (D-e; one row per broker or shell-broker call, plus one per
agent tool call with `tool_call_id` set): `id`, `at`, `plugin_id`,
`plugin_version`, `workspace`, `source` (`broker` | `shell` | `agentTool`),
`address` (`namespace.method`), `outcome` (`allowed` | `denied` | `error`),
`denied_reason`, `fs_path` (workspace-relative, no content), `shell_command`
(executable and subcommand only, no further arguments), `tool_call_id`.
Indexes `(at)` and `(plugin_id, at)`. Detail rows are kept 7 days (DB14).

`plugin_activity_daily`: `(day, plugin_id, workspace, source, address,
outcome)` primary key and `count`; filled before detail rows expire and kept
90 days, which covers "declared but unused for 30 days" and the 7-day baseline
of the 10× anomaly.

Activity is write-only: it decides nothing, and a failed write never fails the
call it records.

## 6. Approval registry (B2)

The skills `ApprovalRegistry` gains a `kind` field: `skill` |
`plugin-install` | `plugin-update` | `plugin-rollback` | `plugin-remove`.
Existing skill records are `kind: "skill"` and keep their fields and statuses
unchanged. A plugin request:

```json
{
  "approval_id": "9b1c...",
  "kind": "plugin-update",
  "owner": "plugin-update:nerdtechnic.devmap@0.2.1",
  "requester": { "paneId": "p-41", "paneName": "dev", "workspace": "/Users/me/project", "callerKind": "pane" },
  "reason": "Needed for the blocked status (written by the agent).",
  "target": { "id": "nerdtechnic.devmap", "namespace": "nerdtechnic", "name": "devmap", "version": "0.2.1", "fromVersion": "0.2.0" },
  "card": { "...": "DisclosureCard" },
  "diff": { "...": "DisclosureDiff (update and rollback only)" },
  "status": "pending",
  "error": null,
  "created_at": 1792214400.0,
  "expires_at": 1792215300.0
}
```

- `owner` is the coalescing key `<kind>:<id>@<version>` (`version` is empty for
  remove): a second request with the same key returns the pending record. There
  is no count limit.
- Plugin statuses: `pending` → `applying` → `completed` | `failed`, or
  `rejected` / `expired` (15 minutes).
- The request tools take only namespace, name and version: no consent argument
  exists. The decision is the WebSocket message
  `plugins.agent_request.decide` `{approval_id, approve, confirmation}`, where
  `confirmation` is a trust confirmation the main window mints for the action
  `plugins.agent_request.decide` (added to `TRUST_CONFIRM_ACTIONS`) with
  subject `approval_id`. Without it the backend answers
  `CONFIRMATION_REQUIRED`. On approval the main window itself runs
  `prepareInstall` → trust dialog → `commitInstall`.

## 7. Changing this contract

Edit the fixture, then both implementations, then this document; both test
suites must pass. When B1-a accepts `backend.agentTools`, it also updates
[plugin-development-v2.md](plugin-development-v2.md) (manifest field
reference) in the same PR, as for every manifest schema change.

## 8. Decisions taken in step 0

These were not fixed by the design and were decided here; each can be changed
by editing the fixture.

| Question | Decision | Why |
|---|---|---|
| Which part of the id is the "name part" | last dot segment, hyphens removed | `nerdtechnic.devmap` → `devmap` as in the design; hyphens are legal in ids but not in prefixes |
| Extra reserved prefix | `navide_` added | a package id ending in `.navide` would otherwise look official |
| `title` length | no limit (DB9 only) | the design removes text length limits |
| `timeoutMs` range | 1–120000 | the Host's existing backend-call bound; no new policy |
| Numbers in `inputSchema` | safe integers only | both languages must spell the signed disclosure identically |
| Publisher verification and review/scan | beside the disclosure (`registry`), not inside | the App cannot recompute them, and the trust check compares recomputable data only |
| Shell executables | `allowlist` → the Host allowlist `gh, git, glab`; `full` → `null` (any) | a manifest declares only the mode |
| `host` caller kind | gated by the DB4 switch, like `external` | it is not attributable to a pane either |
| Daily rollup retention | 90 days | the 30-day "never used" signal needs more than 7 days of history |
| Error-code case | new Host codes upper-case | matches the Host's existing `CAPABILITY_DENIED`, `PLUGIN_STOPPING` |
