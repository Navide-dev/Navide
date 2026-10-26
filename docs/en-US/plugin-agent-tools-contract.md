# Navide Plugin Agent Tools and Disclosure: Interface Contract (v1)

Status: **contract only**. This is step 0 ("介面約定") of plan B in
`.agent-team/plans/navide_b5ecff.html` (section `plan-b`). It fixes the shapes
that the parallel work lines B1 (agent tools), B2 (Navide Marketplace MCP
tools) and D (disclosure) build against. Nothing described here is wired into
the app yet:

- B1-a turned on `backend.agentTools` in `plugin-manifest-v2.schema.json`
  ([section 2.6](#26-schema-fragment)): the Host and the
  Registry run `validateAgentTools` / `validate_agent_tools` on every manifest,
  the consent key carries the tools digest (section 2.8), and the consent
  surfaces list the tools. The Registry image is built from
  `marketplace/registry` alone, so it ships a byte-identical copy of
  `agent_tools_contract.py` (held by `test_agent_tools_contract_copy.py`).
- No MCP tool, Host route, WebSocket handler, Registry endpoint or database
  table exists for anything else below. The reference code is types, constants and
  pure functions:

| Language | Module | Contents |
|---|---|---|
| TypeScript | `src/shared/pluginAgentTools.ts` | names, text rules, `validateAgentTools`, wire types, approval types |
| TypeScript | `src/shared/pluginDisclosure.ts` | `computeDisclosure`, risk rule, `canonicalContractJson`, `diffDisclosure` |
| Python | `backend/agent_team_backend/plugins/agent_tools_contract.py` | the same as `pluginAgentTools.ts`, plus the SQLite DDL |
| Python | `backend/agent_team_backend/plugins/disclosure_contract.py` | the same as `pluginDisclosure.ts` |
| TypeScript | `src/shared/pluginDisclosureScan.ts` | scan report types, `classifyShellCommand`, `scanSentences`, `scanRiskReasons`, `cardRiskLevel`, `declaredVsScanned`, `diffScan` |
| Python | `backend/agent_team_backend/plugins/disclosure_scan_contract.py` | the same as `pluginDisclosureScan.ts` |

Both languages are held to the fixtures in
`docs/plugin-contracts/agent-tools-fixtures/` by
`src/shared/pluginAgentTools.test.ts`, `src/shared/pluginDisclosure.test.ts`,
`src/shared/pluginDisclosureScan.test.ts`,
`backend/tests/test_plugin_agent_tools_contract.py` and
`backend/tests/test_plugin_disclosure_scan_contract.py`. A change to this
contract changes the fixture first; both test suites must then go green.

The governing rule of plan B is **disclose, don't restrict**: everything a
package can do is declared, shown and consented to. The only hard rules are the
ones that stop impersonation or deception (tool-name prefixes, reserved names,
text that could fake another tool or a system message) and the DB9 stability
cap on declarations. Tool arguments and results have no size cap: their size
is disclosed and they travel in pieces
([section 4.4](#44-chunked-transfer-of-results-and-arguments)).

## 1. Vocabulary

- **Package**: a Navide plugin package (Manifest v2). User-facing text follows
  [glossary.md](glossary.md): "Navide plugin", never a bare "plugin".
- **Agent tool**: a tool a package declares in `backend.agentTools`. Once the
  user consents, it is served by the one core `navide` MCP server.
- **Core tools**: the tools the core `navide` MCP server serves today
  (`plan_*`, `cli_*`, ...). They are never third-party.
- **Disclosure** ("揭露資料"): the JSON object computed from a manifest by
  `computeDisclosure` ([section 3](#3-disclosure)). It is what the package
  *declares*.
- **Scan report** ("掃描報告"): the facts the Registry's static scan found in
  one published artifact ([section 3.8](#38-scan-report)). It is what the
  package's code *does*, as far as a static scan can tell, and it is the
  primary content of the disclosure card. The App cannot recompute it.

## 2. Manifest: `backend.agentTools[]`

### 2.1 Fields

```json
"backend": {
  "entry": "bin/devmap",
  "protocolVersion": 1,
  "activation": "startup",
  "methods": ["devmap.read", "devmap.block.status"],
  "agentTools": [
    {
      "name": "devmap_set_status",
      "method": "devmap.block.status",
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

Backend method and event names must be lowercase dotted names,
`^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$` (as `devmap.block.status`). The
manifest schema also accepts upper-case letters
(`plugin-manifest-v2.schema.json:192`,
`marketplace/registry/registry/manifest_v2.py:18`), but the Host backend
supervisor accepts only `^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$`
(`src/main/plugins/pluginBackendSupervisor.ts:655-657`, applied to the
approved method and event lists at `:2791-2794` and `:2807-2810` and to every
call at `:2374`), so a camelCase method such as `devmap.setStatus` passes
publishing and is then refused when the backend activates. The rule above is
the intersection of the two. Closing the gap in the schema is a separate
change.

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
  available tools have the same name, the one the user allowed later is not
  served (state `name-collision`, [4.1](#41-host--backend-pluginsagenttoolssync)),
  and the Navide Plugins page says why in both rows (DB1). The order is per
  name: the consent record's `agentToolNamesSince[name]`, the time the user
  first allowed a version of the package that declares that name, made unique
  across packages so there is never a tie. A name an update adds ranks from
  that update's consent, so it cannot take over a name another package already
  holds; a name the package stops declaring loses its place, and a version that
  declares no tools clears them all. Only a package whose consent covers its
  current tool set, and that the user has not disabled, holds names.

### 2.3 Reserved names

A derived prefix in this list is refused (`AGENT_TOOL_PREFIX_RESERVED`):

`cli_` `credentials_` `evolve_` `git_` `marketplace_` `mcp_` `memory_`
`miniide_` `navide_` `pipeline_` `plan_` `plans_` `plugins_` `preview_`
`prompt_` `role_` `scheduler_` `share_` `skills_` `stage_` `ui_` `window_`
`workspace_`

`git_`, `plans_` and `miniide_` are the prefixes the built-in packages
(`navide.git`, `navide.plans`, `navide.mini-ide`) derive, so a third-party
tool cannot read as first-party.

Every core tool name is also refused (`AGENT_TOOL_NAME_RESERVED`). The list is
pinned in `agent-tools-fixtures/reserved-names-v1.json` (`coreToolNames`, 80
names: `mcp_server/server.py` plus the plan and skills tools the built-in
packages install). `test_every_live_core_tool_is_reserved` fails when a core
tool exists that is neither listed nor under a reserved prefix; adding a core
tool means adding it there (or giving it a reserved prefix).

### 2.4 Text rules

- `title` and `description`: non-empty strings containing no character in
  U+0000–U+001F, U+007F–U+009F, U+2028, U+2029, no `<` or `>`, and no
  character that reorders or hides text: bidi controls and zero-width or other
  invisible characters (U+00AD, U+034F, U+061C, U+180E, U+200B–U+200F,
  U+202A–U+202E, U+2060–U+2069, U+FEFF), fillers that render as nothing
  (U+115F, U+1160, U+3164, U+FFA0, U+2800), variation selectors
  (U+FE00–U+FE0F) and tag characters (U+E0000–U+E007F) (`isValidAgentToolText`). These are
  what could fake a second tool or a system message in a tool list or a
  terminal, reorder and hide text in a dialog, or smuggle text an agent reads
  but the user does not see.
- The same rule applies to every `description` and `title` string anywhere in
  `inputSchema` (agents read the whole schema in tools/list); a violation is
  `AGENT_TOOL_TEXT_INVALID` on field `inputSchema`. Values of the data keywords
  `const`, `default`, `enum` and `examples` are not schema and are not checked.
- No other schema string refuses a package: `enum`, `const`, `default` and
  `examples` values and property names may contain anything. Instead the core
  server neutralizes every string in the schema it serves in tools/list
  (property names included, `pattern` values excepted): control characters,
  bidi controls, zero-width characters and variation selectors
  (U+FE00–U+FE0F, U+E0100–U+E01EF) are removed and boundary markers are broken,
  with the same `external_content` rules that fence results. Consent surfaces
  show such characters in schema strings spelled out (`\u{202e}`).
- Consent surfaces show each tool's `method` and its whole `inputSchema`
  (collapsible), the number of tools and their total size. Nothing limits the
  number of tools or the size of the whole declaration; DB9 applies per field
  (2.7).
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
10. `inputSchema` → `AGENT_TOOL_SCHEMA_INVALID`, else `AGENT_TOOL_NON_INTEGER_NUMBER`, else `AGENT_TOOL_TEXT_INVALID` (a nested `description`/`title`), else `AGENT_TOOL_TOO_LARGE`
11. `timeoutMs` → `AGENT_TOOL_TIMEOUT_INVALID` (booleans, strings and fractions included)

A package with any error is refused at install and publish, exactly like a
schema error.

### 2.6 Schema fragment

`agent-tools-fixtures/manifest-agent-tools.fragment.schema.json` holds the
JSON Schema that B1-a adds to `$defs.backend.properties` of
`plugin-manifest-v2.schema.json` (both copies) together with the
`agentTool` and `agentToolText` definitions; B1-a added it, and both test
suites assert that both schema copies carry it verbatim. Rules the
schema cannot express (prefix, reserved names, declared method, uniqueness,
integers, DB9) stay in `validateAgentTools`.

### 2.7 DB9 stability cap

1 MiB (1,048,576 bytes, UTF-8) each for one `description` and one
`inputSchema` in its canonical spelling (`AGENT_TOOL_STABILITY_CAP_BYTES`,
checked by `validateAgentTools`).

**Tool results and tool arguments have no size cap** (user decisions
2026-10-17: DB9 option a, "拿掉 1 MiB 回傳上限，只揭露資料大小；穩定性改用分段傳送處理",
and "傳給外掛的參數上限也拿掉"). Stability comes from the chunked transfer in
[section 4.4](#44-chunked-transfer-of-results-and-arguments), never from
refusing a call. The sizes are disclosed instead, one field each:

| Size | Measured by | Wire | Audit column |
|---|---|---|---|
| result | the Host, once (`agentToolResultBytes`, 4.2) | `meta.resultBytes` | `plugin_tool_calls.result_bytes` |
| arguments | the backend, once (`agent_tool_arguments_digest`, 5): UTF-8 bytes of the compact spelling, the same measure as `resultBytes` | none: the backend is the first hop that sees them and writes the audit row | `plugin_tool_calls.args_bytes` (with `args_sha256`) |

When the Host sends no valid `meta.resultBytes` (absent, not a non-negative
integer), the backend never measures the result itself: the size is unknown,
the agent's result carries no `meta.resultBytes`, the audit `result_bytes` is
-1, a warning is logged, and the call still succeeds. In the audit, -1 means
the Host sent no valid size and 0 means the call has no result.

The activity page shows both per call. `PLUGIN_TOOL_RESULT_TOO_LARGE` stays in
the error-code list for older readers but is no longer produced.

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
      { "key": "networkViaShell", "params": {} },
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
  "nativeBackend": { "methods": ["devmap.block.status", "devmap.read"], "events": ["devmap.changed"] },
  "network": "via-shell",
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
| `network` | `"via-shell"` when `permissions.shell` is declared, else `"none"`. The frame CSP (`connect-src 'none'`) and the backend sandbox have no network and DB10 (a network permission) is deferred, but a declared shell runs `git`/`gh`/`glab` (or, in `full` mode, any executable), which reach remote hosts. The scan report ([3.8](#38-scan-report)) names the hosts it can see |
| `agentTools` | each declared tool with `timeoutMs` defaulted, sorted by `name` |
| `dataLocations.hostStorage` | always `true` (Host-managed storage partitions) |
| `dataLocations.backendDataDirectory` | `true` when `nativeBackend` is not `null` (the sandbox's private data directory) |
| `dataLocations.projectWrites` | no `fs` → `"none"`; `fs` without scopes → `"undeclared"`; scopes without `write` → `"none"`; otherwise `{root, patterns: write}` |

### 3.2 Summary clauses

The one-line summary is not free text: it is the ordered list `clauses`, and
each surface renders it from the localized i18n template
`plugin-disclosure.summary.v1` (zh-TW, en, ja; D-c owns the strings,
i18n key per clause `pluginDisclosure.summary.<key>`). Publishers cannot write
it. These clauses summarize what the package *declares*. When a scan report
exists, every surface lists the scan sentences ([3.8](#38-scan-report)) first
and these clauses after them, under a "declared" heading; with no scan report
the surface shows the `noScan` sentence and then these clauses. Clauses appear
in this order, each only when it applies:

| Clause `key` | When | `params` |
|---|---|---|
| `nativeBackend` | `nativeBackend` is not `null` | `{}` |
| `files` | `system` contains `fs` | `{access: "read"}` when scopes are declared without `write`, else `{access: "readWrite"}` |
| `shell` | `shell` is not `null` | the `permissions.shell` object |
| `networkViaShell` | `shell` is not `null` (`network` is `"via-shell"`) | `{}` |
| `aiCli` | `system` contains `aiCli` | `{}` |
| `web` | `system` contains `web` | `{}` |
| `agents` | `system` contains `agents` | `{}` |
| `agentMessages` | `system` contains `agentMessages` | `{}` |
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
| `system.web` | `system` contains `web` (plugin browser views and their saved sign-ins) | high |
| `system.agents` | `system` contains `agents` (agent panes, lineage, message delivery records, session list; no message text) | medium |
| `system.agentMessages` | `system` contains `agentMessages` (the text of messages between agents) | high |
| `shell.allowlist` | `shell` is `allowlist` | high |
| `nativeBackend` | the manifest has `backend` | high |
| `agentTools.write` | at least one tool has `risk: "write"` | high |
| `shell.full` | `shell` is `full` | highest |
| `network` | reserved for DB10; never produced in v1 | highest |

These are the manifest reasons. The level every surface shows is
`cardRiskLevel(disclosure, scan)`: the highest of this level and the scan
reasons of [3.8](#38-scan-report). `networkViaShell` adds no reason of its own;
the `shell.*` reasons already cover it. Every surface shows the level with
colour, icon and text together (D5).

### 3.4 Registry facts and the card

Publisher verification and review/scan results are known only to the Registry
and are **not** part of the manifest disclosure, because the App cannot
recompute them. They travel beside it:

```json
{
  "manifest": { "...": "ManifestDisclosure" },
  "scan": { "...": "ScanReport (3.8), or null" },
  "registry": {
    "publisher": { "name": "Nerdtechnic", "verifiedDomain": "nerdtechnic.com", "domainVerifiedAt": "2026-10-01T00:00:00Z" },
    "signature": { "signed": true, "keyId": "registry-2026" },
    "review": { "status": "approved", "reviewedAt": "2026-10-16T09:00:00Z", "nativeCodeInspected": true },
    "scan": { "secretScan": "clean", "secretFindings": 0, "similarityWarning": false, "similarTo": null, "scannedAt": "2026-10-16T08:55:00Z" }
  }
}
```

`review.status` is `approved` | `pending` | `rejected` | `not-required`;
`scan.secretScan` is `clean` | `findings` | `not-run`. `registry` is `null`
where no Registry is involved. This `DisclosureCard` is what every surface
renders: list card (summary and level), detail page, consent dialog and the B2
approval card. `scan` is the signed scan report of the version
([3.5](#35-trust-check-the-disclosure-envelope)); the card derives its
sentences, its scan risk reasons and the declared-vs-scanned comparison
([3.9](#39-declared-vs-scanned)) from it. The `registry.scan` object above is
the older submission check (secret scan and name similarity) and is unrelated
to the static scan report.

The list card reads `disclosure` and `scan` from the Registry's listing
(`GET /api/extensions`), which carries them for `latest_version` (one
artifact's scan). Like every listing and detail field they are display data
that nothing has verified; the Host keeps them only when they are well formed
and the disclosure names that item's package and `latest_version`, and the
card says they are unverified.

`nativeCodeInspected` is derived, never entered by hand:

| Value | When |
|---|---|
| `true` | the version has a `backend` and an administrator approved it in review |
| `false` | the version has a `backend` and was published without review (auto-published) |
| `null` | the version has no `backend` |

A version published without review has no submission scan, so its
`scan.secretScan` is `not-run` and its counts are `0`. `scan` carries counts,
status and the name of a similar package only, never a secret value or file
content.

Surfaces state these values as facts (for example "自動發佈，未經人工審核" /
"Published automatically, not reviewed by a person"), not as warnings. Red
stays reserved for the three anomalies of D5.

### 3.5 Trust check: the disclosure envelope

The existing package envelope stays exactly as it is. Every App since v0.1.86
accepts only its eight fields (`assertRegistryPackageEnvelopeShape` in
`src/main/plugins/pluginRegistryTrust.ts`), so adding a field to it would make
every released App refuse every newly published version. The disclosure is
signed in a **separate disclosure envelope** instead:

```json
{
  "schemaVersion": 1,
  "artifactDigest": "<the package envelope's artifactDigest>",
  "packageId": "nerdtechnic.devmap",
  "version": "0.2.0",
  "target": "universal",
  "keyId": "registry-2026",
  "signedAt": "2026-10-16T09:00:00Z",
  "disclosureDigest": "<64 lowercase hex characters>",
  "scanDigest": "<64 lowercase hex characters, or null>"
}
```

The disclosure envelope has exactly these nine fields
(`DISCLOSURE_ENVELOPE_FIELDS`). No released App reads it, so it is defined
here with `scanDigest` from the start rather than versioned later.

- `disclosureDigest` is the lowercase hex SHA-256 of the UTF-8 bytes of
  `canonicalContractJson(disclosure)` (all ASCII, see 3.7);
  `canonical.json` pins one value as `disclosureDigestExpected`.
- `scanDigest` is the lowercase hex SHA-256 of
  `canonicalContractJson(scan)` for the scan report of the same artifact, or
  `null` when the version has no scan report (published before the scanner
  existed, or by a Registry without one). `scan-cases.json` pins one value as
  `scanDigestExpected`. The two digests are separate (DS1) so the App can
  check the part it recomputes on its own, and a rescan replaces only
  `scanDigest`.
- `artifactDigest`, `packageId`, `version`, `target` and `keyId` equal the
  package envelope of the same artifact. The disclosure envelope is signed by
  the **same Registry signer key** and in the same way (detached Ed25519 over
  the canonical JSON of the envelope), at the same moment the package envelope
  is signed: at publish, or at review approval for a review-required
  namespace. An unsigned (pending) version has neither envelope.
- The Registry version API (`VersionInfo`) gains five fields beside the
  unchanged `registry_envelope` / `registry_signature`:

| Field | Value |
|---|---|
| `disclosure` | the `ManifestDisclosure` (3.1), or `null` |
| `disclosure_envelope` | the object above, or `null` |
| `disclosure_signature` | base64 detached signature over it, or `null` |
| `scan` | the scan report of 3.8, or `null`; `null` exactly when `scanDigest` is `null` |
| `registry` | the Registry facts of 3.4, or `null` |

A version published before D-a has `null` in all three disclosure fields.
`registry` does not depend on the manifest and may be present for any
version. It is **not signed**: its values change after publish (a domain gets
verified, a review completes), it is informational, and nothing in the App
decides on it.

**D-b** at `prepareInstall`, after the existing package-envelope verification:

1. No disclosure envelope (all three fields `null`): install exactly as today.
   No disclosure card is shown for that version; its absence is shown as
   absence, never as a computed card.
2. Otherwise all three must be present. The disclosure envelope must match the
   verified package envelope on `artifactDigest`, `packageId`, `version`,
   `target` and `keyId`, and its signature must verify against that same
   signer; `sha256(canonicalContractJson(disclosure))` must equal
   `disclosureDigest`. `scan` and `scanDigest` must both be `null`, or
   `sha256(canonicalContractJson(scan))` must equal `scanDigest`; the scan
   report's `artifactDigest` and `target` must equal the envelope's.
3. D-b recomputes the disclosure from the manifest inside the downloaded
   package. If its canonical spelling differs from the signed one, the install
   is refused with `DISCLOSURE_MISMATCH`. A malformed, unsigned, mismatched or
   partly missing disclosure envelope is refused with `DISCLOSURE_INVALID`.

These two codes are the only new install-blocking rules. The App cannot rerun
the scan, so the Registry signature is the scan report's only tamper
evidence; the card says the scan was done and signed by the Registry. What the
scan found never blocks an install (DS3): it changes only the card and the
risk level. An App that predates D-b ignores the new fields and verifies the
package envelope as before.

### 3.6 Diff

`diffDisclosure(from, to)` flattens each disclosure into items
`{kind, key, detail}`, sorted by `kind` and then `key`:

| `kind` | `key` | One per |
|---|---|---|
| `system` | `fs` / `ui` / `aiCli` / `web` | system namespace |
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

`widened` is true when `added` holds anything other than a file-scope item
(`fsScopeRoot`, `fsScopeRead`, `fsScopeWrite`), when the declared file scope
grows, or when the risk level rose. A file scope is declared, never enforced:
the `fs` capability reaches the same files with or without one. So declaring
a scope for an `fs` that had none claims less and does not widen, while
dropping a scope that `fs` keeps, any new read or write pattern (a path
moving from read to write included) and a different `root` do. Scope items
are listed in `added` and `removed` either way; the diff view tags an
informational change "Declared scope (informational)".

`diffScan(from, to)` is the scan half: it flattens each scan report (`null`
counts as empty) into items `{kind, key}` and returns `{added, removed,
widened}` (`widened` when `added` is non-empty):

| `kind` | `key` |
|---|---|
| `scanShell` | `executable subcommand` (or the executable alone) |
| `scanShellDynamic` | `dynamic` |
| `scanHost` | host |
| `scanReadPath`, `scanWritePath` | path |
| `scanCapability` | capability address |
| `scanDynamicCode` | `frontend` / `backend` |

D2: an update is widened when either diff is widened, or when
`cardRiskLevel` rose. An update that is not widened installs without a dialog
and shows one notification; a widened one shows the consent dialog with only
the difference. The same functions serve rollback, and a rescan that widens
the scan of an installed version shows a notification only.

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

### 3.8 Scan report

Disclosure is driven primarily by a static scan the Registry runs on every
published artifact, not by what the package claims (user decision
2026-10-17: "不是他申請，而是上架時系統掃描，掃描後揭露說明"). The Registry
scans at publish and again at review approval, synchronously within a time
budget (DS4); a scanner upgrade is applied by a manual admin rescan (DS7).
The report holds facts only:

```json
{
  "schemaVersion": 1,
  "scanner": { "id": "navide-static-scan", "version": "1.0.0" },
  "artifactDigest": "<the package envelope's artifactDigest>",
  "target": "universal",
  "scannedAt": "2026-10-17T00:00:00Z",
  "coverage": { "filesTotal": 12, "filesScanned": 11, "bytesScanned": 834221,
                "skipped": [ { "reason": "binaryAsset", "count": 1 } ],
                "truncated": false, "timedOut": false },
  "shell": { "calls": [ { "executable": "git", "subcommand": "push", "category": "remoteWrite",
                          "source": "frontend", "evidence": "callSite", "files": 1 } ],
             "dynamic": { "count": 1, "files": 1 } },
  "network": { "hosts": [ { "host": "github.com", "source": "frontend", "count": 2 } ] },
  "files": { "readPaths": [".navide/devmap.json"], "writePaths": [".navide/devmap.json"], "dynamicPaths": 0 },
  "capabilities": [ { "address": "shell.run", "source": "frontend" } ],
  "code": { "frontend": { "eval": 0, "newFunction": 0, "dynamicImport": 0, "stringTimers": 0,
                          "obfuscationSignals": [] },
            "backend": null },
  "native": [ { "path": "backend/devmap", "format": "mach-o", "arch": "arm64",
                "libraries": ["/usr/lib/libSystem.B.dylib"], "notableImports": ["_execve"],
                "importCount": 120, "packer": null, "embeddedRuntime": null } ]
}
```

| Field | Rule |
|---|---|
| `scanner` | `id` is `navide-static-scan`; `version` changes whenever a rule changes. Shown on the card |
| `artifactDigest`, `target` | equal the package envelope of the artifact scanned |
| `coverage` | `skipped[].reason` is one of `binaryAsset`, `tooLarge`, `redacted`, `unsupported`, `scannerError` (the scanner failed on that file and went on with the others), `tooComplex` (the file hit a structural ceiling: template nesting, section, import or symbol counts); `truncated` when any bound below was hit; `timedOut` when the time budget ran out. None of them fails a publish; `scannerError` and `tooComplex` (`INCOMPLETE_SKIP_REASONS`) make the scan incomplete, as `truncated` and `timedOut` do |
| `shell.calls` | one entry per distinct `(executable, subcommand, source, evidence)`; `category` from `classifyShellCommand`; `evidence` is `callSite` (the `command` value of a `shell.run` call is a string literal) or `commandLikeString` (a literal that reads as a command); `files` counts the files it occurs in |
| `shell.dynamic` | `shell.run` calls whose command is built at run time (a template with `${}`, an identifier, an expression): count and files only |
| `network.hosts` | host names from URLs (`http(s)`, `ws(s)`, `ssh`, `git@host:`); never a path, query or credential (DS5) |
| `files` | string-literal `path` values of `fs.*` calls; a path that is not ASCII, not relative or longer than `maxPathLength` counts in `dynamicPaths` instead |
| `capabilities` | capability addresses (`namespace.method`) that occur as literals |
| `code` | per source, `null` when that source has no code: counts of `eval(`, `new Function(`, non-literal `import(`, string `setTimeout`/`setInterval`; `obfuscationSignals` names (for example `hexEscapes`, `hexIdentifiers`, `longBase64`, `charCodeStrings`) |
| `native` | one entry per native executable: format, architecture, linked libraries, notable imports, import count; `packer` (`upx`, ...) or `embeddedRuntime` (`pyinstaller`, `node-sea`, `bun`, `deno`) when the code inside cannot be scanned (DS6). Commands, hosts and capability addresses found in its strings go into `shell`, `network` and `capabilities` with `source: "backend"` |

Every string in a report is ASCII (hosts in their IDNA form, commands and
subcommands matching `^[a-z][a-z0-9-]{0,39}$`, paths in the scope pattern
character set), every array is sorted and every number is a safe integer, so
`canonicalContractJson` spells it the same way in both languages.
`classifyShellCommand` reports no subcommand for an executable outside the
Host allowlist and drops any argument that does not read as a subcommand, so
command arguments, URLs and values are never echoed.

**Never in a report**: file contents, code excerpts, full command arguments,
URL paths and queries, raw strings of a native executable. Every string the
scanner would emit is first matched against the secret-scan rules; a match is
dropped and counted under `coverage.skipped` as `redacted`.

**Bounds** (`SCAN_LIMITS`): `maxItemsPerKind` 100, `maxPaths` 50,
`maxPathLength` 200, `maxScriptBytes` 20 MiB per script file,
`maxNativeBytes` 512 MiB per executable, `timeBudgetMs` 30000 per artifact.

**Sentences.** `scanSentences(scan)` derives the ordered list a card shows;
i18n key `pluginDisclosure.scan.<key>`, zh-TW, en and ja (D-c owns the
strings). Publishers cannot write them.

| `key` | When | `params` | zh-TW example |
|---|---|---|---|
| `shell.remoteWrite` | a call with that category | `{commands}` | 這個外掛會執行 git push，可能把專案資料送到遠端。 |
| `shell.other` | an executable outside the allowlist | `{commands}` | 這個外掛會執行 curl，可以把資料送到任何網址。 |
| `shell.unknownSubcommand` | a subcommand not in the table (DS9) | `{commands}` | 這個外掛會執行 git frobnicate；這個子指令不在對照表裡，請當成可能連到遠端。 |
| `shell.remoteRead` | | `{commands}` | 這個外掛會執行 git fetch，會用你的登入身分連到遠端讀取資料。 |
| `shell.localWrite` | | `{commands}` | 這個外掛會執行 git commit，會改變你本機儲存庫的內容。 |
| `shell.local` | | `{commands}` | 這個外掛會執行 git status，讀取本機儲存庫的狀態。 |
| `shell.dynamic` | `shell.dynamic.count > 0` | `{count}` | 有 1 處指令是在執行時才組出來的，靜態掃描無法完全判斷會執行什麼。 |
| `files.write` | write paths or dynamic paths | `{paths, dynamic}` | 這個外掛會寫入 .navide/devmap.json。 |
| `files.read` | read paths | `{paths}` | 這個外掛會讀取 .navide/devmap.json。 |
| `network.hosts` | at least one host | `{hosts}` | 程式碼裡出現這些網址：github.com。外掛頁框與原生 backend 都不能直接連網，這些網址可能用來開啟瀏覽器，或交給 git／gh 等指令。 |
| `code.eval.frontend` / `code.eval.backend` | a non-zero count | `{count}` | 程式碼會在執行時產生並執行程式碼（1 處）。（frontend：外掛頁框的安全政策會擋下這類呼叫） |
| `code.obfuscated` | any obfuscation signal | `{signals}` | 程式碼有混淆跡象，掃描結果可能不完整。 |
| `native.summary` | each native executable | `{path, format, arch, libraries}` | 原生 backend（mach-o arm64）連結了 libSystem。 |
| `native.unscannable` | packer or embedded runtime | `{path, reason, detail}` | 原生 backend 內嵌 Python 執行環境，裡面的程式碼無法掃描。 |
| `coverage.incomplete` | timed out, truncated, obfuscated, packed, embedded runtime, or a `scannerError` / `tooComplex` skip | `{reasons}` | 掃描不完整：有部分內容沒有掃到。 |
| `notFound.shell`, `notFound.network`, `notFound.files`, `notFound.dynamicCode` | nothing of that kind was found | `{}` | 靜態掃描未發現 shell 指令。 |
| `coverage` | always, last | `{scannerVersion, scannedAt, filesScanned, filesTotal}` | 上架時由 Navide Registry 掃描（掃描器 1.0.0，2026-10-17，11／12 個檔案）。靜態掃描看不到執行時才決定的行為，以下不代表完整清單。 |
| `noScan` | the version has no scan report (not produced by `scanSentences`) | `{}` | 這個版本上架時尚未有系統掃描，以下只有外掛自己的宣告。 |

Honest limits: a kind with no finding is always `notFound.<kind>` ("靜態掃描未
發現"), never rendered as "none", "no" or an empty space; `coverage` is
always shown and cannot be collapsed; `shell.dynamic` is itself a disclosure
item; an incomplete scan always shows "掃描不完整" with its reasons.

**Scan risk reasons.** `scanRiskReasons(scan, disclosure)` in this fixed
order; `cardRiskLevel` takes the highest of these and the manifest level
([3.3](#33-risk-level)):

| Reason `key` | Applies when | Level |
|---|---|---|
| `scan.shell.remoteWrite` | a `remoteWrite` call | highest |
| `scan.shell.other` | an `other` call | highest |
| `scan.shell.dynamic` | dynamic commands and a declared shell | high; highest with `shell: "full"` |
| `scan.shell.remoteRead` | a `remoteRead` call | high |
| `scan.shell.localWrite` | a `localWrite` call | high |
| `scan.shell.unknownSubcommand` | an `unknownSubcommand` call | high |
| `scan.code.eval.backend` | eval-like code in the backend | high |
| `scan.incomplete` | any `coverage.incomplete` reason (DS2) | high |

### 3.9 Declared vs scanned

`declaredVsScanned(disclosure, scan)` returns `{undeclared, declaredNotSeen}`,
each a sorted list of `{kind, key}`. `undeclared` is shown first on the card,
in red: the code does something the manifest does not declare. The Host
still refuses the undeclared call at run time, but the mismatch itself is the
strongest warning a card can carry (the D5 "used but not declared" red).
`declaredNotSeen` is grey and worded "宣告了，靜態掃描未發現" (it may be
dynamic or unused), never "unused". Neither ever blocks an install or a
publish (DS3).

| Finding | `kind` / `key` |
|---|---|
| any shell call while `permissions.shell` is absent | `shell` / the command |
| dynamic commands while `permissions.shell` is absent | `shellDynamic` / `dynamic` |
| `shell.*` capability address while `permissions.shell` is absent | `shell` / `shell.run` |
| an executable outside the allowlist while shell is `allowlist` | `shellExecutable` / the executable |
| an `fs`, `ui`, `aiCli` or `web` capability address whose namespace is not in `system` | `system` / the namespace |
| read or write paths while `system` lacks `fs` | `system` / `fs` |
| a write path matching no `scopes.fs.write` pattern (scopes declared) | `fsScopeWrite` / the path |
| a read path matching no `scopes.fs.read` or `write` pattern (scopes declared) | `fsScopeRead` / the path |
| declared shell, but no call, no dynamic command and no `shell.*` address | `declaredNotSeen`: `shell` / the mode |
| a declared `system` namespace with no address of it (for `fs`, also no path) | `declaredNotSeen`: `system` / the namespace |

Scope patterns match by `scopePatternMatches`: `**` is zero or more whole
path segments, `*` any run of characters inside one segment, everything else
literal. `fs` declared without scopes ("undeclared" project writes) flags no
path.

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
      "risk": "write", "method": "devmap.block.status", "timeoutMs": 30000,
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

`caller` may also carry `verifiedTo` (`pane` for a pane caller, `caller-kind`
for `external` and `host`), the label the core attaches from its credential
check. It is optional; a value that does not match the caller kind, or any
other extra key, makes the Host refuse the request. The Host never keeps the
sent label: it derives its own from `kind` for the initiator it passes on.
Both sides test against the same wire fixture,
`docs/plugin-contracts/agent-tools-fixtures/agent-tool-call-requests.json`.

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
| `PLUGIN_TOOL_TIMEOUT` | `reason` `execution`: the plugin did not answer within `timeoutMs`; `reason` `transfer-idle`: a transfer of pieces stalled for `AGENT_TOOL_CHUNK_IDLE_MS` (4.4, Timing) |
| `PLUGIN_TOOL_FAILED` | the backend answered with an error; its own code is in `plugin_error` |
| `PLUGIN_TOOL_RESULT_TOO_LARGE` | no longer produced: results have no cap (2.7) |
| `PLUGIN_TOOL_CHUNKS_INVALID` | the pieces of the arguments or of the result could not be joined (4.4); `reason` is `summary`, `seq`, `count`, `short`, `bytes` or `json` |

A call whose package stops being callable while its backend is being bound
(the bind is refused or cancelled) answers `PLUGIN_TOOL_UNAVAILABLE` with the
reason the checks then give, or `plugin-stopping` for a bind or call the stop
cancelled; it is never reported as `PLUGIN_TOOL_FAILED`, which is the plugin's
own failure. A call running when Navide closes every backend (a quit) is
cancelled the same way and also answers `plugin-stopping`. Any other bind
failure keeps its own error, even when the deadline passes or the workspace
closes meanwhile.

An agent tool call cannot use `shell.run` (0.2.25): the backend's bridge
request is refused with `CAPABILITY_DENIED` ("Shell capability is denied."),
for a read tool and a write tool alike, whatever the package declares. The
Host shell port serves only a user-initiated call from a live view.
Opening it to agent calls widens what agents can do, so it is the user's
decision, disclosed in the consent dialog first.

The transport failures that exist today stay as they are (`host_unavailable`,
`host_timeout`, lower-case, produced by the backend itself); the backend also
produces `result_helper_failed` for a result in pieces its helper process
could not handle (4.4, R2).

`meta.resultBytes` is `agentToolResultBytes(result)`: the UTF-8 byte length of
the compact `JSON.stringify` spelling of the result value the Host received
(`null` when the plugin returned nothing), measured once, by the Host. For a
result longer than one piece, which the Host forwards without parsing (4.4,
R1), it is the byte count of that text: the summary's `bytes` of the pieces as
the plugin sent them, or of the compact spelling of a one-frame value. It is
`0` in the `meta` of an error response that carries no result. The backend
does not measure again; it forwards the Host's number to the audit row. When
the Host sends no valid `meta.resultBytes` the size is unknown and the audit
row stores `-1` (2.7).

Before sending, the core server checks the arguments against the consented
`inputSchema` in a worker thread, never on its event loop, and the Host checks
them again. Known limits of the core check, by design (no size or count limit
replaces them):

- It never runs a plugin-supplied regular expression: `pattern` values and
  `patternProperties` (with the `additionalProperties` beside it) are left to
  the plugin backend. A backtracking pattern could otherwise hold a thread for
  every caller.
- `uniqueItems` is checked in linear time (items compared by canonical JSON,
  `1` equal to `1.0`, `true` not equal to `1`); jsonschema's pairwise check is
  quadratic. The other keywords cost at most the size of the arguments times
  the size of the schema.
- Values of `const`, `default`, `enum` and `examples` are data: never checked
  as schema text, never rewritten for the check (tools/list serves dangerous
  ones neutralized, below).
- An invalid-arguments message names the failing keyword and the value's size,
  never the value, and only property names the schema declares (any other key
  shows as `*`).
- A Host `error_code` outside the table above is reported as
  `PLUGIN_TOOL_FAILED`, its text fenced like a result.

tools/list serves the schema with only dangerous strings rewritten: a string
that `neutralize_external_text` changes beyond NFKC (control, Cf and tag
characters, a boundary line, a `---MARKER---` token) or that poses as a source
label is served neutralized; every other string, property names included, is
served exactly as declared (NFKC detects, it never rewrites). Before the
check, arguments are mapped back to the declared values: an `enum` or `const`
string, or a property name (along `properties`, `additionalProperties` and
`items`), that is the served spelling of exactly one declared value becomes
that value, so the plugin receives what it declared; a declared value sent as
is stays. When two declared values are served as the same text, a call that
sends it is refused with `PLUGIN_TOOL_INVALID_ARGUMENTS` (an "ambiguous"
message, logged), never guessed, also when one of them is that text itself
(`ab` and `a\u200bb` are both served `ab`). Property names served alike merge
in tools/list; registering such a tool logs a warning. Values under other
keywords are not mapped.

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

The B2 request tools (section 6) use `detail` and `installed` to resolve their
target: the Registry must list the requested version, and update, rollback
and remove need the package installed.

### 4.3.1 Backend → Host: `plugins.agent_action` (B2-c)

For `plugins_disable` / `plugins_enable`. The backend unicasts
`plugins.agent_action.request` to the authenticated Host session:

```json
{ "request_id": "pa:5d1e...", "action": "disable", "plugin_id": "nerdtechnic.devmap",
  "requester": { "paneId": "p-41", "paneName": "dev", "workspace": "/Users/me/project", "callerKind": "pane" } }
```

The Host answers with the WebSocket message `plugins.agent_action.result`:
`{request_id, ok: true, pluginId, pluginVersion, disabled, changed}` or `{request_id,
ok: false, error, error_code}` with `BAD_REQUEST` | `NOT_INSTALLED` |
`BUILTIN_PLUGIN` | `ACTION_FAILED` | `HOST_UNAVAILABLE`. Only installed
Marketplace packages qualify: the bundled Navide plugins (the reserved
`navide.*` namespace) are refused with `BUILTIN_PLUGIN` by the backend before
it asks, and by the Host again. The Host switches the package exactly as the
user's switch on the Navide Plugins page does (enable keeps the consent the user already
gave). When that changed the package (`changed: true`) it tells the user which
caller did it (pane name, or "external MCP client" / "Navide Host") with a
one-click undo; a package already in that state is left alone, nobody is told
and the audit records `no-op`. The undo acts only while the package is still
in the state the agent left it in. The requester's pane name and workspace go
through `neutralize_external_text`.

Who disabled a package decides whether an agent may enable it (B2-c option B).
The Host keeps, beside the Disabled list (whose file format older Navide
versions read and which stays as it is), who disabled each Marketplace package
in `.navide-disabled-source.json`: `{by: "user" | "agent", at (Unix ms), agent:
{callerKind, paneId, paneName} | null}`. The user's Navide Plugins switch, and the
undo on an agent notice, record `user`; `plugins_disable` records `agent` with
the caller. Enabling removes the entry. A disabled package with no entry
(disabled before this was recorded, or an unreadable file) reads as the user.
`enable` of a package an agent disabled proceeds as above. `enable` of a
package the user disabled changes nothing: the Host answers `{ok: false,
error_code: "APPROVAL_REQUIRED", error, pluginId, pluginVersion, disabled}`, and
the backend files a `plugin-enable` request (section 6) for the user's
decision and answers the agent `{ok: false, error_code: "APPROVAL_REQUIRED",
error, approval_id, status: "pending", expires_at}`. A second `enable` returns
the same pending request.

`update` (O1, user ruling 2026-10-20) is asked by `marketplace_request_update`
after its own checks (installed, newer, not bundled) and before it files a
request. It carries one more key, `version`. The Host verifies that Registry
version exactly as the window's install does and updates at once only when
nothing it discloses changes: the disclosure diff against the installed
version adds and removes nothing and keeps the risk level, and the source,
the views, an already trusted publisher and the absence of a local install or
a version waiting for a restart are all unchanged. It then commits through the
window's own commit, tells the user which caller updated the package from
which version with a one-click downgrade (it drops the version waiting for a
restart, or rolls back to the replaced version; it does nothing once the
package changed again), and answers `{ok: true, updated: true, pluginId,
fromVersion, pluginVersion}`; the backend audits `update` and answers the
agent `{ok: true, status: "completed", applied: true, pluginId, fromVersion,
pluginVersion, note}`. Anything else — a change, a diff that cannot be
computed, a preparation failure, an install of the same id in progress, a
failed commit (`ACTION_FAILED`, audited as `error`), no answer — files the
`plugin-update` request exactly as before (fail closed). The Host's refusal is
`{ok: false, error_code: "APPROVAL_REQUIRED", error, pluginId, pluginVersion}`.
Since live activation the update also switches at once; when the switch fails
the old version runs again, the update stays staged with a "switch failed" row
in the main window, the Host answers `{ok: true, updated: true, switched:
false, switchError, pluginId, fromVersion, pluginVersion}`, and the backend
answers the agent `{ok: false, status: "staged", applied: false, error_code:
"SWITCH_FAILED", error, pluginId, fromVersion, pluginVersion}` (audited as
`error` with `ACTION_FAILED`), without the Host's text and without filing a request.

### 4.4 Chunked transfer of results and arguments

A result or an argument object of any size reaches the other end intact. A
payload larger than one piece travels as ordered pieces and is joined at the
receiving end, so no single message grows with the payload (uvicorn's 16 MiB
WebSocket message, a child's own frame reader) and other calls are never held
behind a large one. The pieces
are a transport unit, not a cap: nothing refuses a call because of the size of
its arguments or its result, and the receiver holds as much as memory allows.
Both directions use the same piece format, the same piece size and the same
two functions.

**Pieces.** The sender spells the value as compact JSON text
(`JSON.stringify`; Python `json.dumps(separators=(",", ":"),
ensure_ascii=False, allow_nan=False)`) and cuts it with
`splitAgentToolPayloadText(text)` into pieces of at most
`AGENT_TOOL_CHUNK_BYTES` = 131,072 UTF-8 bytes, never inside a code point.
Even with every byte escaped as `\u00XX` a piece's frame stays below 1 MiB,
the frame size child readers use. Each piece is `{seq, data}` with `seq` counting from 0.
The receiver joins them with `reassembleAgentToolPayloadText(pieces,
summary)`, which orders the pieces by `seq` and checks
that `seq` runs `0..chunks-1` exactly once each and that the joined text has
`summary.bytes` UTF-8 bytes. Every piece but the last must be full: at least
`AGENT_TOOL_CHUNK_BYTES` − 3 UTF-8 bytes, which is what the splitter always
produces (a piece ends early only when the next code point, up to 4 bytes,
does not fit). This is a format rule, not a limit: it stops a sender from
dripping a value one byte at a time to keep the idle timer alive and so stretch
a call past `timeoutMs` (R1 is the only hop whose sender is not Navide).
Senders must send pieces in `seq` order (0, 1, 2, …), so a valid transfer has
at most one short piece and it comes last. Receivers therefore check every
piece in arrival order with `agentToolChunkArrival(shortSeen, data, chunkBytes,
seq, expectedSeq)`: a piece whose `data` is not a string, or whose `seq` is not
the next one expected (a repeat, a step back or a skip), is `seq`; any piece
after a short one is `short`; both fail the call at once, without waiting for
the final message (which a dripping or looping sender would never send). A
short piece does not restart the idle timer (see Timing). Counts (`seq`,
`chunks`, `bytes`) are safe integers; an integral float such as `1.0` counts,
because `JSON.parse` gives TypeScript the integer `1` for it. A piece that is
not an object (`null` included) is `seq`, never an exception. Before cutting,
a sender written in Python escapes lone surrogates (`\ud800`) the way
`JSON.stringify` does (`agent_tool_payload_text`), since UTF-8 cannot carry them. The joined pieces are checked
again by `reassembleAgentToolPayloadText`. The summary `{chunks, bytes}`
travels in the message that completes the transfer.
A mismatch is `PLUGIN_TOOL_CHUNKS_INVALID` with `reason` `summary` | `seq` |
`count` | `short` | `bytes`; joined text that does not parse as JSON is the same code with
`reason` `json`. It fails that one call and nothing else. A value whose text
fits in one piece is sent exactly as before, with no pieces.

Six hops carry an agent tool call; the agent's own hops (MCP HTTP) cannot be
cut into pieces because the agent CLI is the client, so they carry no limit
instead:

| Direction | Hop | How a large value travels |
|---|---|---|
| arguments | agent → backend (MCP HTTP request) | one request body; no body limit (A1) |
| arguments | backend → Host (WebSocket event) | pieces (A2) |
| arguments | Host → plugin child (Backend Wire) | pieces when the child supports them, else one frame (A3) |
| result | plugin child → Host (Backend Wire) | pieces (R1) |
| result | Host → backend (WebSocket request) | pieces (R2) |
| result | backend → agent (MCP HTTP response) | one response; no limit (R3) |

#### Arguments

**A1: agent → backend (MCP HTTP).** The MCP endpoint accepts a `tools/call`
request body of any size: Navide builds its `StreamableHTTPSessionManager`
with `max_request_body_size=sys.maxsize` (the SDK needs a positive integer;
its default is 4 MiB). This applies to the whole `/mcp` endpoint.

**A2: backend → Host (WebSocket session).** When the compact spelling of
`payload.arguments` is longer than one piece, the backend first sends the
event `agent.capability.request_chunk` once per piece,

```json
{"request_id": "mcp:3f2a...", "seq": 0, "data": "{\"rows\":[..."}
```

and then the `agent.capability.request` event of 4.2 with
`payload.arguments` replaced by `payload.argumentChunks`:

```json
{"request_id": "mcp:3f2a...", "operation": "agentTool", "target": {"...": "..."}, "tool": {"...": "..."}, "caller": {"...": "..."}, "payload": {"argumentChunks": {"chunks": 81, "bytes": 10612345}}}
```

Each piece is its own WebSocket message and each send is awaited before the
next, so other sessions' and other panes' messages interleave with the pieces.
The backend spells and cuts the arguments in a worker thread, then sends the
pieces and the request in order. Cancelling the MCP call stops that sequence:
a cancelled call's request is never sent, so the plugin does not run it (the
audit row records `cancelled`). A call cancelled after its request was sent
is not stopped: the Host is not told, the plugin runs it to the end, the core
refuses its result pieces (`accepted: false`) and discards its answer, and the
audit row still records `cancelled`, since nobody waits for that answer.
The Host keeps the pieces by `request_id` and
accepts them only on the authenticated Host session; it joins them when the
request arrives, then runs the checks of 4.2 on the joined arguments exactly
as on inline ones. It drops the pieces it holds when the request arrives, the
session closes, or no piece or request has come for `AGENT_TOOL_CHUNK_IDLE_MS`
(the pieces of a cancelled call). A join failure answers the request with
`{ok: false, error_code: "PLUGIN_TOOL_CHUNKS_INVALID", reason}`. The Host's
client for this session sets the `ws` option `maxPayload: 0` (no message limit;
the library default is 100 MiB).

**A3: Host → plugin child (Backend Wire).** A child that can receive pieces
says so in the `_meta` of its `navide/health` success response:
`"io.navide/argumentChunks": {}`. For such a child, when the compact spelling of
the arguments is longer than one piece, the Host allocates the `navide/call`
id, writes the notification

```json
{"jsonrpc":"2.0","method":"notifications/navide/argumentChunk","params":{"requestId":"<navide/call id>","seq":0,"data":"{\"rows\":[..."}}
```

once per piece, and then the `navide/call` request with `arguments` left out
and the summary in its `_meta`:

```json
{"jsonrpc":"2.0","id":"<navide/call id>","method":"navide/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{"io.navide/resultChunks":{}},"io.navide/argumentChunks":{"chunks":81,"bytes":10612345}},"name":"devmap.block.import","runtime":{"...":"..."}}}
```

The Host writes each piece as its own frame once its output queue is empty, so
frames of other calls interleave and the queue's existing backlog bound is
never exceeded. A control frame (a request, a response, a cancellation) that
does not fit the backlog waits for the queue to drain; an overflow never fails
the child (today `writeFrame` fails it with `BACKEND_UNAVAILABLE`). The
argument transfer runs on the idle timer, and `timeoutMs` starts only when the
`navide/call` itself is written (see Timing). On timeout or cancellation the
Host stops writing pieces and sends the existing `notifications/cancelled` for
that id; the child drops the pieces it holds for that id (a cancellation of an
id it never saw a request for is ignored, as today). A child that cannot join its pieces answers the call
with the error `{"code": 1000, "message": "...", "data": {"code":
"PLUGIN_TOOL_CHUNKS_INVALID", "details": {"reason": "bytes"}}}`.

For a child that does not advertise the capability the Host sends the
`navide/call` with the arguments inline in one frame, whatever its size: a
single frame larger than the output queue's backlog bound is written alone
once the queue is empty, never refused (today it is refused with
`RESOURCE_LIMIT`). Whether such a child can read it is the child's own matter.

#### Results

**R1: plugin child → Host (Backend Wire).** The Host advertises support in
every `navide/call` it sends:
`params._meta["io.modelcontextprotocol/clientCapabilities"]["io.navide/resultChunks"] = {}`.
A child may send pieces only when it sees that capability; a Host without it
treats an unknown notification as a protocol error. For each piece the child
writes the notification

```json
{"jsonrpc":"2.0","method":"notifications/navide/resultChunk","params":{"requestId":"<navide/call id>","seq":0,"data":"{\"rows\":[..."}}
```

and after the last piece the ordinary success response with no `value` and the
summary in `_meta`:

```json
{"jsonrpc":"2.0","id":"<navide/call id>","result":{"resultType":"complete","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"devmap","version":"0.2.0"},"io.navide/resultChunks":{"chunks":81,"bytes":10612345}}}}
```

The child writes each piece as its own frame and may write frames of other
requests (responses, progress, events) between them, so other calls to the same
child are never held behind a large result. The Host keeps the pieces of each
pending call in that call's entry; pieces for an id that is not pending (the
call was cancelled, timed out or already settled) are dropped and counted, not
a protocol error. The first piece ends the call's `timeoutMs`; from there the
transfer runs on the idle timer (see Timing). On timeout or cancellation the
Host sends the existing
`notifications/cancelled`, drops the pieces held so far, and the child should
stop sending pieces for that id. The child is not restarted for any of this.

The Host reads child frames of any size: the 1 MiB `maxFrameBytes` check on
the child's stdout, which today fails the process with `PROTOCOL_ERROR` and
restarts it, is removed. A child that does not send pieces and answers with
one large frame therefore still delivers its result and keeps running; it only
holds its other calls behind that frame. A frame that is not valid JSON-RPC
stays a protocol error, whatever its size.

A frame over 1 MiB, and a result piece frame over 16 KiB, is joined, decoded,
checked (the same checks as any frame) and parsed in a worker thread; the
frames after it wait their turn, so the order is kept, and a child that exits
right after writing them still has them handled first. For an agent tool the
Host's main thread never parses a large result: it keeps the result as text,
the pieces as they came (their data as UTF-8 bytes) or the worker's compact
spelling of a one-frame value cut into pieces, and forwards that text to the
core (R2), which has it parsed once. A piece's data is UTF-8 by then, so a
lone surrogate in it arrives as U+FFFD: pieces must be well-formed UTF-16
text, as `splitAgentToolPayloadText` makes them. Every other caller (the
built-in Plans, Git and mini-IDE views, a third-party view) receives the parsed
value, so for them the main thread still decodes and parses a large result
once, as before DB9 within the old 1 MiB bound; only the frame parsing has
moved off it. Reading a child's stdout yields to other work after about 8 ms
in one event-loop turn (pacing, not a limit: every byte is read).

**R2: Host → backend (WebSocket session).** When the Host's response
`result` spells longer than one piece, the Host sends the request message
`agent.capability.result_chunk` once per piece,

```json
{"request_id": "mcp:3f2a...", "seq": 0, "data": "{\"rows\":[..."}
```

waiting for each one's response before sending the next (the backend answers
`{"ok": true, "accepted": true}`, or `accepted: false` when the request id is
no longer pending, at which point the Host stops sending), then the existing
`agent.capability.result` with `result` replaced by `resultChunks`:

```json
{"request_id": "mcp:3f2a...", "response": {"ok": true, "resultChunks": {"chunks": 81, "bytes": 10612345}, "meta": {"durationMs": 2310, "resultBytes": 10612345, "crossWorkspace": false}}}
```

Each piece is a separate WebSocket message, so other panes' requests and
results interleave with the pieces on the same session; the one-at-a-time
send gives flow control without a credit scheme. The backend accepts pieces
only from the authenticated Host session and only for a pending request id,
keeps them with that request's waiter and, when the final message arrives,
checks them against the summary and hands them on, unjoined, to the agent tool
proxy. The pieces are the plugin's own text, which the Host does not parse, so
the core parses it with the Host's rules (no `NaN`, no `Infinity`, no number
that only parses as an infinity): text that breaks them answers the call with
`PLUGIN_TOOL_CHUNKS_INVALID`, reason `json`. Parsing, spelling for the agent
and neutralizing such a result run in a helper process the backend starts
the first time a result comes in pieces (`<backend> --agent-tool-result-worker`;
a backend that never gets one starts no process, and the helper exits when
the backend does, its stdin closing), so the event loop only moves bytes; the
agent sees exactly the text the in-process functions would give. While it
works the helper writes an empty frame every 2 s, and the backend waits 30 s
for each frame (a time window, not a size limit). A helper that crashes or
hangs is stopped and that call answers `result_helper_failed` (lower-case,
produced by the backend), `reason` `crashed` or `timeout`, with the result's
size in `error`; the work is not redone in the backend, where a result that
hung the helper would hang the event loop, and the next call starts the
helper again: a result that breaks the helper fails alone and keeps no other
Navide plugin's result from it. A new helper must first write
`{"ready": true}` within 30 s (a onefile build unpacks itself on every
start). A helper that cannot be used, because it does not start or does not
say it is ready (a broken build), leaves a result up to 1 MiB (what the
backend handled before DB9) to be handled in the backend as then; a larger
one answers `result_helper_failed`, `reason` `unavailable`. Each failed start is logged and recorded as
`AGENT_TOOL_RESULT_HELPER_UNAVAILABLE` in the error ledger, and the next start
is tried after 60 s. The helper's state (`idle`, `ready` or `unavailable`,
with `lastError` and `since`) goes to the Host on every change (the
`agent.tools.result_helper` event); the Host starts every new backend session
from `idle`, and a backend whose helper is not idle sends its state again once
the Host session is registered; `plugins:backendResourceUsage` discloses
it as `backend.resultHelper`, Resource Manager shows it, and the first
`unavailable` in a session raises a notice. The helper runs in a tree of its
own (its own session on POSIX, a kill-on-close job on Windows); stopping it
closes its stdin, then after 2 s kills the whole tree, the helper alive or
not (a onefile build runs Python under a bootloader, and what the helper
started may still run). A helper whose backend is gone (killed outright, so
its stdin may not close while the helper is busy) kills its own tree. The backend's wait is the one described under Timing:
every piece restarts it. When it ends (idle, MCP client gone) the pieces are
dropped and later ones answer `accepted: false`. Results that fit one piece
keep the current single message.

**R3: backend → agent (MCP HTTP).** The MCP server returns the joined
result in one `tools/call` response. FastMCP's streamable HTTP transport has no
response-size limit, so nothing is cut here; how much of a large result an
agent CLI shows is that CLI's own behaviour and outside Navide.

#### Timing

Time never acts as a size limit. Two clocks, and nothing else:

- **Execution**: `timeoutMs` measures only the plugin's own work. The Host
  starts it when the `navide/call` frame is written (after the last argument
  piece, A3) and stops it at the child's first result frame (its first
  `notifications/navide/resultChunk` or its final response). On expiry the call
  fails as today with `PLUGIN_TOOL_TIMEOUT`, `reason: "execution"`.
- **Transfer**: every transfer of pieces runs on an idle timer of
  `AGENT_TOOL_CHUNK_IDLE_MS` = 30,000 ms that every piece restarts. It tells a
  stalled peer from a slow one: a value of any size passes as long as pieces
  keep moving, and the timer only fires after 30 s without one. On R1 it
  starts at the child's first result frame, whether that first piece is full
  or short. Only a full piece restarts it; a short piece (the last one, 4.4
  Pieces) does not, so a sender cannot hold a call open by trickling bytes. On expiry the
  call fails with `PLUGIN_TOOL_TIMEOUT`, `reason: "transfer-idle"`, the pieces
  held so far are dropped, and the Host sends `notifications/cancelled` to the
  child. Where each hop restarts it: A2 — the Host, on each
  `agent.capability.request_chunk` of a request id it holds pieces for, until
  the request arrives; A3 — the Host, each time a piece leaves its output queue;
  R1 — the Host, on each `notifications/navide/resultChunk`; R2 — the Host, on
  each `agent.capability.result_chunk` response, and the backend, on each piece
  it receives.

The backend cannot see A3, the plugin's work or R1, so the Host tells it the
call is alive: it sends the request `agent.capability.progress`
`{"request_id": "...", "phase": "arguments" | "execution" | "result"}` after
each argument piece it writes to the child (`arguments`), when it writes the
`navide/call` (`execution`) and after each result piece it receives from the
child (`result`). The backend accepts it only from the authenticated Host
session, like the pieces, and answers `{"ok": true, "accepted": true}`, or
`accepted: false` for a request id that is no longer pending. The backend's
wait for a request restarts on every Host message about it (progress, result
piece, result) and lasts `max(timeoutMs, AGENT_TOOL_CHUNK_IDLE_MS)` + 5 s, so
neither a long execution nor a long transfer ends it while data still moves.
A call whose arguments and result fit one piece sends `execution` progress only
and otherwise behaves as today.

#### Wire schema

`backend-wire-v1.schema.json` gains the two notifications, the summary-only
success response, the `navide/call` without `arguments` and the health
capability together with the Host's parser change (the contract gate test pins
every valid wire fixture to the parser), in the implementation PR.

## 5. Storage in `navide.db`

The DDL is `PLUGIN_AUDIT_DDL` in `agent_tools_contract.py`; B1-d and D-e
execute it inside navide.db's existing schema setup (no migration framework is
involved; every statement is `IF NOT EXISTS`). Times are Unix milliseconds;
`day` is the UTC date `YYYY-MM-DD`.

`plugin_tool_calls` (B1-d; one row per agent tool call):

| Column | Type | Content |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `at` | INTEGER | call **end** (Unix ms): the row is written once the call is over, with its duration and result size; the call ran over `[at − duration_ms, at]` |
| `caller_kind` | TEXT | `pane` / `external` / `host` |
| `pane_id`, `pane_name` | TEXT | `''` when not a pane |
| `caller_workspace`, `target_workspace` | TEXT | |
| `cross_workspace` | INTEGER | 0/1 |
| `plugin_id`, `plugin_version`, `tool`, `risk` | TEXT | |
| `args_sha256`, `args_bytes` | TEXT, INTEGER | `agent_tool_arguments_digest(arguments)`. `args_bytes`: UTF-8 byte length of the compact spelling the arguments travel in (`agent_tool_payload_text`, as `resultBytes` measures results), so `{"q":"中文"}` is 14. `args_sha256`: SHA-256 of the canonical spelling (`canonicalContractJson`; for arguments holding a fractional number, the same sorted, compact, ASCII spelling with the numbers as Python's `json` writes them), so key order does not change it. The arguments are **not** stored. This is the only arguments-size field (2.7) |
| `outcome` | TEXT | `ok` / `error` |
| `error_code` | TEXT | `''` on success; otherwise a code of 4.2, `host_unavailable`, `host_timeout`, `result_helper_failed`, or `cancelled` (the caller cancelled the call before it was answered; arguments still in transfer are not sent on, so the plugin does not run it; once the request was sent the plugin may already be running it and finishes it, see 4.4), anything else `other` |
| `duration_ms`, `result_bytes` | INTEGER | `result_bytes` = the Host's `meta.resultBytes` (4.2); `0` when the call has no result; `-1` when the Host sent no valid size (unknown) |

Indexes `(at)` and `(plugin_id, at)`. Retention: rows older than 30 days are
deleted, then all but the newest 10,000.

`plugin_activity` (D-e; one row per agent tool call with `tool_call_id` set,
and the broker and shell-broker rows an earlier version wrote, until they
expire): `id`, `at`, `plugin_id`,
`plugin_version`, `workspace`, `source` (`broker` | `shell` | `agentTool`),
`address` (`namespace.method`; never `backend.…`, see below),
`outcome` (`allowed` | `denied` | `error`),
`denied_reason` (only for `denied`: a `PLUGIN_TOOL_UNAVAILABLE` reason, a
call error code, or `undeclared` for a use the manifest did not declare;
`PLUGIN_ACTIVITY_DENIED_REASONS`, anything else is `other`), `fs_path`
(workspace-relative, no content), `shell_command`
(executable and subcommand only, no further arguments), `tool_call_id`.
Indexes `(at)` and `(plugin_id, at)`. Detail rows are kept 7 days (DB14).

`plugin_activity_counts` (final review part 2, H1; broker and shell-broker
calls). Counted, never one row per call: a plugin needs no permission to be
refused, so it can make refused calls as fast as it likes. The Host counts
calls per `(plugin, version, workspace, source, address, outcome,
denied_reason, fs_path, shell_command, minute)` within each batch and sends
the row of `plugin_activity` with `count` and `at` (the latest call counted);
the backend redacts it and adds `count` into the row of that key and minute
(`minute`, `count`, `last_at`; created by `PLUGIN_AUDIT_DDL` like the other
activity tables). Text the plugin wrote is never a key, because it has no
limit on its length or on how many different values there are, and a refused
or failed call cost the plugin nothing. Three fixed values take its place;
the counts stay exact:

- `<unknown>` (`PLUGIN_ACTIVITY_UNKNOWN_ADDRESS`), in `address`: the plugin
  called a capability Navide does not have, one address of the public
  catalog, a Host action or a backend-mapped call (`ping`, which answers any
  method name, is not one address either). Its `source` is kept.
- `<denied>` (`PLUGIN_ACTIVITY_DENIED_TARGET`), in `fs_path` / `shell_command`:
  the call was refused (`outcome` `denied`), so the path or command it named is
  not kept.
- `<failed>` (`PLUGIN_ACTIVITY_FAILED_TARGET`), in `fs_path` /
  `shell_command`: the call failed (`outcome` `error`) and changed nothing, so
  the path or command it named is not kept. A failed call keeps its redacted
  path and command by default, as an allowed call does (it may have done
  something before it failed, and an address added later is covered the same
  way); it is `<failed>` only when it is known to have changed nothing:
  - its address is read-only (`PLUGIN_ACTIVITY_READ_ONLY_ADDRESSES`, each
    checked to write nothing to disk and start no process: `fs.readFile`,
    `fs.readImage`, `fs.listDirectory`, `fs.listFilesFlat`, `fs.glob`,
    `fs.stat`, `fs.statPath`, `fs.listArchive`, `fs.previewResource`,
    `fs.convertOffice` and their legacy snake_case names; `fs.findInFiles`
    runs a search process and is not in it);
  - its address is `<unknown>` (no capability Navide has, such as `fs.bogus`
    answered with `METHOD_NOT_FOUND`);
  - the Host answered it before handing it to any handler (the planner
    refused it, answered it or threw, or a check before it ran refused it):
    the broker marks that answer itself, never by its error code, and the Host
    sends `<failed>`, which the backend keeps as it is.

  Only an `fs` call's `path` and a `shell` call's `command` are recorded at
  all; other namespaces keep no text.
- `<missing>` (`PLUGIN_ACTIVITY_MISSING_TARGET`), in `fs_path`: a read was
  allowed but its result found nothing usable there: `exists: false` (as
  `fs.stat` / `fs.statPath` answer for a path that does not exist) or
  `ok: false` (as `fs.readFile`, `fs.readImage` and `fs.listDirectory` answer
  a missing or unusable path, inside a successful call). Its `outcome` stays
  `allowed`, as before; only the path is not kept. Only these reads: a write
  keeps its path whatever it answered, since it may have changed something
  before it failed.

A fixed value means this only with its own outcome (`<denied>` with `denied`,
`<failed>` with `error`, `<missing>` with `allowed`, `<unknown>` with anything
but `allowed`). An `allowed` call keeps its redacted path and command: that IO
happened, so the number of different values follows the work the plugin really
did. A plugin's own path or command that is spelled like a fixed value is
recorded as `./<value>` (the Host sends it so and the backend writes it so
after redaction), so it is never read as one. Displays show each fixed value
as what it means, set apart from a real path, command or address (the
activity page words them and styles them differently), and only with its own
outcome. Kept and
rolled up into `plugin_activity_daily` / `plugin_activity_denied_daily` like
detail rows (7 days, by the UTC day of `minute`); a row is rolled up when its
`minute` is before the cutoff, so the calls of the minute the cutoff falls in
leave the detail up to 59 s early. A removed plugin's rows go with
`forget_plugin`. `count` is an integer from 1 to 2^63 − 1 (SQLite's INTEGER
range); a row outside it is skipped. Every report field below reads `plugin_activity` and
`plugin_activity_counts` together, with the same values as one row per call;
a window reads the minute it starts in whole.

`plugin_backend_call_minutes` (D-e; calls into a third-party plugin's own
backend, whichever path made them: its frontend, an agent tool, an agent
capability request). Counted, never one row per call: the Host counts calls
per `(plugin, version, workspace, address, outcome, minute)` within each batch
and sends rows `{at, plugin_id, plugin_version, workspace, source: "backend",
address, outcome, count}` (`at`: start of the minute, Unix ms); the backend
adds `count` into the row of that minute (`PLUGIN_BACKEND_CALLS_DDL`, its own
schema component). `address` is `backend.<method>`, so a method named like a
system namespace (`fs.read`) never counts as a use of it; a `backend` row
without that prefix, or another source with it, is skipped. A call of a method
the manifest does not declare is counted under the one address
`backend.<undeclared>` (`PLUGIN_BACKEND_CALL_UNDECLARED_ADDRESS`), its name
not kept: the name is the caller's free text with no limit on its length or on
how many different names there are, so it cannot be a key; the number of keys
follows the declared methods only. The report shows those calls as "called
undeclared methods N times". `outcome` is `allowed` | `denied` | `cancelled`
(the caller cancelled it; not a refusal) | `error` (a call to an undeclared
method is an error: the backend host answers it as an invalid argument). The same flush also adds
each count into `plugin_backend_call_days` (per UTC day, with the latest
minute as `last_at`), which is what the report reads: a few rows per method a
day however busy the plugin, so a report stays fast at any call rate. The
minute rows are written and never read by the report: they keep the 7-day
per-minute detail for inspecting a burst (for example, which minute a spike of
calls came in). Minute rows are kept 7 days, like detail rows; day rows as long as
`plugin_activity_daily` (90 days); a removed plugin's rows of both go with
`forget_plugin`. The bundled `navide.*` packages are not recorded.

`plugin_activity_daily`: `(day, plugin_id, workspace, source, address,
outcome)` primary key and `count`; filled before detail rows expire and kept
90 days, which covers "declared but unused for 30 days" and the 7-day baseline
of the 10× anomaly.

`plugin_activity_denied_daily` (D-e): `(day, plugin_id, workspace, source,
address, denied_reason)` primary key and `count`; the refusals among the detail rows, by reason, rolled up in the
same transaction as `plugin_activity_daily` and kept as long (90 days), so the
reason of a refusal ("used but not declared" above all) outlives the 7 days of
detail. It was added after the first tables: every open runs the audit DDL (all
`CREATE … IF NOT EXISTS`), so an older `navide.db` gains it and keeps its rows.

`plugin_tool_first_seen` (D-e): `(plugin_id, tool, workspace)` primary key and
`first_at`; the earliest call of each `risk: write` agent tool in each target
workspace, written with the call rows. It is not pruned with them, so
`writeToolNewWorkspace` flags a workspace once, not again each time its old
calls expire, and no count limits it. When a plugin is removed the Host sends
`plugin.activity.forget` (`PLUGIN_ACTIVITY_FORGET_MESSAGE`, Host-authenticated,
`{plugin_id}`) and that plugin's rows go: a reinstalled plugin's first writes
are new again. The forget is best effort: with no registered Host session, or
when the send fails, it is not sent again, and the rows stay. The report does
not depend on it: given the report request's `installedAt`, a first-seen row
older than the install counts as absent, and the first write since the install
is read from `plugin_tool_calls` (section 5.1). Like every other audit table it
is created by the open-time DDL.

A `plugin.activity.record` row the backend skips (malformed, a bad `at`, or
refused by the redaction) is counted, and the counts by reason are logged;
never the row's content.

The agent-tool row of `plugin_activity` carries no size of its own: the activity
page shows the sizes of each call from `plugin_tool_calls.args_bytes` and
`result_bytes` through `tool_call_id`.

Rules for every surface that shows these rows (the activity page, disclosure
views, exports):

- A size of `-1` (`result_bytes`, or `args_bytes` should it ever be unknown)
  is shown as "unknown", never as "-1 bytes", and is never added into a sum.
  Every statistic and rollup (the D-e daily rollup, D-f trends, averages,
  totals) leaves `-1` out and counts the unknown rows separately.
- `fs_path`, `shell_command`, `address`, `denied_reason`, `pane_name`, the
  workspace paths and every other stored text are shown as plain text: never
  turned into a link, never rendered as HTML (`v-html`, `innerHTML`). A stored
  `javascript:` or `mailto:` string is shown as those characters.

Backend resource usage (`plugins:backendResourceUsage`) is Host state, not a
table: `children.current` counts the **bound views** (each owns at most one
child process; a view whose child has not started yet, or has stopped while
idle, still counts), not live processes; `children.retained` counts children
whose close failed and that may still be running.

`views[].child.stdoutPending` (`{bytes, peakBytes}`) is the size of a stdout
frame the child has started but not ended (no newline yet), held in Host
memory. Frames have no size limit (4.4, R1), so a child that never ends a
frame (a bug, or binary data written to stdout) grows it without bound; before
DB9 such a child was restarted at 1 MiB. It is disclosed, never cut off.
Proposed notification for the resource watchdog (line 5, watchdog C), handled
like its other resource items: when `stdoutPending.bytes` passes
**256 MiB, or 1/8 of the machine's memory if that is lower**, notify the user,
who chooses to stop the plugin or let it continue; nothing is terminated
automatically.

`plugin_agent_actions` (B2-c; one row per attempt to request, decide, finish,
disable or enable a change to a Navide plugin). Its DDL is
`PLUGIN_AGENT_ACTIONS_DDL`, run as its own schema component
(`plugin_agent_actions`, version 1): an older navide.db gets the table at start
and no other table changes. If it cannot be created, only this record is off
(`PLUGIN_AGENT_ACTIONS_AUDIT_DISABLED` in the diagnostics) and the backend
starts as usual.

| Column | Type | Content |
|---|---|---|
| `id` | INTEGER PK | autoincrement |
| `at` | INTEGER | when |
| `plugin_id`, `plugin_version` | TEXT | `plugin_version` `''` when not known |
| `action` | TEXT | `disable` / `enable` / `request-install` / `request-update` / `request-rollback` / `request-remove` / `decide-approve` / `decide-reject` / `finish-completed` / `finish-failed` / `finish-late-completed` / `finish-late-failed` / `request-developer-application` / `request-plugin-publish` / `request-plugin-yank` / `request-testplace-invite` / `publish-loopback` |
| `caller_kind` | TEXT | `pane` / `external` / `host`, or `user` (a person in a Navide window: decide, finish) |
| `caller_pane_id`, `caller_pane_name`, `caller_workspace` | TEXT | `''` when not a pane |
| `approval_id` | TEXT | the request's id, `''` when none |
| `outcome` | TEXT | `allowed` / `no-op` (allowed, already in that state) / `denied` / `error` |
| `error_code` | TEXT | `''` when allowed or no-op; otherwise one of `PLUGIN_AGENT_ACTION_AUDIT_ERROR_CODES`, anything else `other` |

Indexes `(at)` and `(plugin_id, at)`. Retention is `plugin_tool_calls`'s: 30
days, then the newest 10,000. Every text is shown as plain text.

Activity is write-only: it decides nothing, and a failed write never fails the
call it records.

The Host's capability broker records the broker and shell-broker rows of
third-party plugins (the bundled `navide.*` packages are not recorded) and sends
them in batches, about once a second, as `plugin.activity.record`
(`PLUGIN_ACTIVITY_RECORD_MESSAGE`, Host-authenticated, `{rows: [{plugin_id,
plugin_version, workspace, source: "broker" | "shell", address, outcome,
denied_reason?, fs_path?, shell_command?, at?}]}`; answered `{ok, accepted}`).
`at` is when the call completed on the Host (Unix ms); the backend clamps it to
its own now, and dates a row without one when it arrives. Raw
paths and command lines cross the local Host session only; the backend keeps
their redacted form. `denied_reason` is `undeclared` when the broker refused a
namespace or shell use the manifest did not declare. A refused cast is recorded;
a dispatched cast (terminal input) is not.

The activity page reads it back with `plugins.activity.report`
(`PLUGIN_ACTIVITY_REPORT_MESSAGE`), section 5.1.

### 5.1 Reading activity: `plugins.activity.report`

The activity page and the disclosure overview (D-f) read one plugin's report.
The backend accepts `plugins.activity.report` only from the Host's
authenticated session (`host_authenticated`); the main window asks the Host
over IPC, whose handler passes `assertAuthorized` (as
`plugins:backendCallConcurrency` does). Request `{plugin_id, declared}`, where
the Host fills `declared` (`[{kind, key}]`: `system` names, `shell` mode,
`backendMethod` keys `backend.<method>`, `agentTool` names) from the installed
manifest, since the backend has no third-party manifest; without `declared`,
`declaredUnused` is `[]`. Calls into a plugin's own backend, whichever path
made them, are counted in `plugin_backend_call_days` under address
`backend.<method>` (section 5), so a `backendMethod` entry reads "declared but
never called" only when the method was not called at all, whatever the
outcome. (Before those calls were recorded, the Host sent no `backendMethod`
entries, since they could only ever read unused.) The Host also sends
`installedAt` (Unix ms, when the package was installed): `writeToolNewWorkspace`
then counts only writes since then, so a first-seen row left by an earlier
install of the same id counts as absent. It is the time of the install since
the id was last removed: the Host records it in its own
`.navide-install-scans.json` (owner-only, `0600`) when a fresh install becomes
active (the activation finds no version of the id in place: no registered
package, no active selection, no legacy backend-only install), keeps it
through updates (over any layout, legacy included) and rollbacks, records
nothing for a candidate that is staged and then discarded or fails to
activate, and drops it when the plugin is removed. An id installed before
this was recorded has none, and Manifest v1 packages (installed in place,
without the staged activation) never have one; the request then carries no
`installedAt` and the backend keeps its earlier behaviour. Answer `PluginActivityReport`
(`src/shared/pluginActivity.ts`; fixture
`docs/plugin-contracts/agent-tools-fixtures/activity-report.json`). The backend
(D-e) builds it from the tables above and does the aggregation and the
anomaly checks; the renderer rebuilds it from validated fields and refuses a
malformed one whole.

| Field | Content |
|---|---|
| `schemaVersion` | `1` |
| `pluginId`, `generatedAt` | the plugin; when the report was made (Unix ms) |
| `window` | `{from, to}`: the detail window the lists cover (7 days) |
| `totals` | `{calls, denied, errors}` of `plugin_activity` and `plugin_activity_counts` within `window` |
| `historicalPeakConcurrency` | the largest number of the plugin's `plugin_tool_calls` that overlapped in time within `window`, from recorded call intervals. **Historical only**: the number in flight now is read live from the Host (`plugins:backendCallConcurrency`), never from a report, because running calls are not recorded yet |
| `undeclaredSince` | start of the window `undeclared` covers (30 days) |
| `toolCalls[]` | `plugin_tool_calls` rows, newest first: `id`, `at`, `callerKind`, `paneId`, `paneName`, `callerWorkspace`, `targetWorkspace`, `crossWorkspace`, `pluginVersion`, `tool`, `risk`, `outcome`, `errorCode`, `durationMs`, `argsBytes`, `resultBytes` |
| `files[]` | fs paths, newest first: `path` (workspace-relative), `address`, `workspace`, `outcome`, `count`, `lastAt` |
| `commands[]` | shell commands (executable and subcommand only), newest first: `command`, `workspace`, `outcome`, `count`, `lastAt` |
| `daily[]` | oldest first, up to the 90 days kept: `day` (`YYYY-MM-DD`, UTC), `calls`, `denied`, `errors` (daily rows plus the detail rows not yet rolled up) |
| `declaredUnused[]` | declared but not called in 30 days: `kind` (`system` / `shell` / `backendMethod` / `agentTool`), `key`, `lastUsedAt` (or null) |
| `undeclared[]` | one entry per `(source, address, workspace)` with at least one `denied_reason = 'undeclared'` within 30 days: `count` (the `undeclared` refusals only), `lastAt`, `reasons[]` (`{reason, count}`: every `denied_reason` of that entry within 30 days, `undeclared` included, largest first) |
| `anomalies[]` | marked only, never acted on: `kind`, `at`, `workspace`, `tool`, `count`, `baseline` (null where not applicable). `volumeSpike`: `at` = that day 00:00 UTC, `workspace` `''`, `count` = calls that day, `baseline` = the 7-day daily average. `writeToolNewWorkspace`: `at` = the first call there, `tool`. `undeclaredDenied`: one per workspace, `at` = the last refusal, `count` = refusals within 7 days |
| `agentActions` | B2-c's `plugin_agent_actions` rows (`at`, `action`, `callerKind`, `paneId`, `paneName`, `workspace`, `version`), or `null` until that table exists |
| `backendCalls` | calls into the plugin's own backend, from `plugin_backend_call_days`: `methods[]` (`address`, `outcome`, `count`, `lastAt`) from the UTC day `window` starts in (so it can reach up to a day before `window.from`; calls of undeclared methods are one entry, `backend.<undeclared>`), and `daily[]` (`day`, `calls`, `denied`, `errors`, `cancelled`) for every day kept. They are **not** part of `totals`, `daily` or `volumeSpike`, which keep their meaning (broker, shell and agent-tool activity) |

`argsBytes` and `resultBytes` are `-1` (`UNKNOWN_BYTES`) when the size is not
known: such a value is shown as "unknown", never summed, averaged or counted
in a statistic. Every string is shown as plain text: no link is made from a
path or a command, and nothing is rendered as HTML.

### 5.2 Resource thresholds: notice, then the user decides

The Host samples every third-party native backend's process tree
(`pluginBackendResourceWatchdog.ts`). The thresholds are unchanged: resident
memory of the tree over 512 MiB on two consecutive samples, more than 8
processes, CPU at or over 0.95 cores sustained for 5 minutes, the private data
directory over 1 GiB. Going over one no longer stops the backend on its own:
the Host tells the user which Navide plugin, which item and how much it uses
now, and offers **Stop** and **Keep running**. The backend keeps running,
unthrottled, until the user answers. Bundled `navide.*` plugins are not
watched (unchanged).

- **Stop** runs exactly the stop that used to happen automatically.
- **Keep running** raises that item's notice level to twice the larger of the
  level just crossed and the usage at that moment; for CPU the usage value
  doubles and the 5-minute window stays. This decides only when to tell the
  user again; it limits nothing. The raised level is not lowered when usage
  falls back; it returns to the default when the backend starts again.
- While a notice waits for an answer, the same item is not announced again.
  A notice counts as delivered only when a main window has shown it; until
  then it is kept and sent again when a window finishes loading. It is kept in
  memory only: after a restart the watchdog measures again and, if the backend
  is still over, raises a new notice.

Every step is recorded, with no path or command line: the Host sends
`plugin.resource.decision` (`PLUGIN_RESOURCE_DECISION_MESSAGE`,
`src/shared/pluginResourceDecision.ts`; Host-authenticated, in batches)
`{rows: [{plugin_id, plugin_version, item, usage, threshold, decision, at}]}`,
answered `{ok, accepted}`. A failed send is logged and never holds up the
user's choice. Fixture:
`docs/plugin-contracts/agent-tools-fixtures/resource-decisions.json`.

| Field | Content |
|---|---|
| `item` | `memory` / `cpu` / `processes` / `disk`: the watchdog's four thresholds (#367's counts have no threshold); `stdoutPending`: the stdout a plugin's children have sent without a newline yet (review M2 on #375), read from #375's `views[].child.stdoutPending.bytes` summed over the plugin's children (0 until #375 lands); threshold the smaller of 256 MiB and an eighth of the machine's memory; noticed like the others (Keep running doubles it, never lowered) |
| `usage`, `threshold` | non-negative finite numbers; `memory`, `disk` and `stdoutPending` in bytes, `processes` a count, `cpu` in cores (fractional). `threshold` is the level this notice was raised at |
| `decision` | `notified` (raised, no answer yet), `continue`, `terminate` |
| `at` | Host Unix ms (the backend clamps a future time to now) |

The backend stores them in `plugin_resource_decisions` (`CREATE TABLE IF NOT
EXISTS`), kept 90 days like the daily rows, and removes a plugin's rows with
`plugin.activity.forget`.

Backend side (`PLUGIN_RESOURCE_DECISION_MESSAGE`, `PLUGIN_RESOURCE_ITEMS`,
`PLUGIN_RESOURCE_DECISIONS` in `agent_tools_contract.py`): a row is accepted
only with exactly these seven fields and types; any other field, such as a
path, refuses the whole row. The Host's `parsePluginResourceDecisionRow`
checks the same seven fields and types but drops an extra field instead of
refusing the row, so a row the Host built never carries one. Known gaps:
`plugin_id` and `plugin_version` get no format check beyond being strings
(non-empty for the id), and an internal `ValueError` message can carry the
refused value; it reaches only the backend log. Accepted rows are
queued and written by the audit's batched flush, in a transaction of their own
so a failure there never drops the activity rows. A skipped row is counted in
the log, never with its content. Columns: `id`, `at`, `plugin_id`,
`plugin_version`, `item`, `usage` (REAL), `threshold` (REAL), `decision`;
indexes `(at)` and `(plugin_id, at)`.

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
  `rejected` / `expired` (15 minutes, `pending` only). Only `applying` ends as
  `completed` or `failed`; every other transition is refused. `applying` does
  not expire.
- `target.id` is `<namespace>.<name>`. `reason` and the requester's `paneId`,
  `paneName` and `workspace` are strings (`null` allowed for the requester
  fields), stored with every Cc character except TAB and LF, every bidi or
  zero-width (Cf) character and U+2028 / U+2029 removed; no length limit. The
  card labels `reason` as written by the agent.
- The request tools take only namespace, name and version: no consent argument
  exists. The decision is the WebSocket message
  `plugins.agent_request.decide` `{approval_id, approve, confirmation}`, where
  `confirmation` is a trust confirmation the main window mints for the action
  `plugins.agent_request.decide` (added to `TRUST_CONFIRM_ACTIONS`) with
  subject `<approval_id>:approve` or `<approval_id>:reject` matching `approve`,
  as `skills.install_approval.decide` binds its decision: a confirmation minted
  to reject cannot be spent to approve. Without it the backend answers
  `CONFIRMATION_REQUIRED`. On approval the main window itself runs
  `prepareInstall` → trust dialog → `commitInstall`.

B2-c tools and messages:

- `plugin-enable` (option B): filed by `plugins_enable` for a package the user
  disabled. `owner` `plugin-enable:<id>@<installed version>`, `target.version`
  the installed version, `fromVersion` null, `card` the Registry card of that
  version (null when not listed), `reason` empty. Every plugin record carries
  `disabled`: for `plugin-enable`, `{by: "user" | "agent", at (Unix seconds,
  null when not recorded), agent: {callerKind, paneId, paneName} | null}` (an
  agent source that cannot be named reads as the user); null for every other
  kind. On approval the window turns the user's Enable switch on (its own
  action); a rejection leaves the package disabled. Recovery counts it
  `completed` when the package is installed and enabled.

- `marketplace_request_install` / `_update` / `_rollback` `(namespace, name,
  version, reason)` and `plugins_request_remove` `(namespace, name, reason)`
  file a request. The backend checks the grammar (package id, SemVer), refuses
  the `navide.*` namespace (`BUILTIN_PLUGIN`), and takes the target from the
  Host (4.3): install needs the package not installed, update a newer and
  rollback an older version than the installed one, remove an installed
  package (`NOT_INSTALLED` otherwise); install, update and rollback need the
  version listed by the Registry (`NOT_FOUND` otherwise). `card` is the
  Registry listing's card, unverified (prepareInstall verifies). `reason` and
  the requester are stored through `neutralize_external_text`. A tool returns
  only `{ok, approval_id, status, expires_at, note}`: a coalesced request
  names its first requester, whose pane, workspace and reason no other caller
  sees. Each new or coalesced request is broadcast to the main windows only
  as `plugins.agent_request` (the record).
- `marketplace_request_status (approval_id, wait_s 0-60)` returns `{ok,
  approval_id, kind, target: {id, version}, status, error, expires_at}`,
  waiting while the request is `pending` or `applying`. For a result
  recorded late (see `finished_late` under `plugins.agent_request.finish`)
  it also returns `finished_late: true` and `settled: {status, error}`;
  `status` and `error` are then the late, actual result. Every other answer
  has exactly the seven fields above. `settled.error` is fenced like `error`
  unless it is Navide's own word (`interrupted`, `not-applied`).
- `plugins.agent_requests.list` (main windows only, `FORBIDDEN` otherwise)
  returns `{requests, applyingInLiveWindow}`: the `pending` and `applying`
  plugin requests, and the ids of the applying ones a still-connected main
  window approved and is carrying out. A main window sends its page-load id
  (`window_id`, stable across reconnects, new on reload) with
  `ui.invoke.ready`; `decide` records it for an approval. On its first
  connection a main window settles every other `applying` request against the
  installed packages: remove and the package is gone, or update / rollback /
  install and the installed version equals `target.version` → `completed`;
  anything else → `failed` with error `interrupted`. A main window also does
  this when the backend sends `plugins.agent_requests.recover`
  (`PLUGIN_APPROVAL_RECOVER_EVENT`, `{approval_ids}`), which it sends to the
  main windows still open when a main window that was carrying out approved
  requests goes away, so they do not wait for another window to open. Either
  way, a request is settled only if it is still unclaimed when the window
  looks again after a grace (`RECOVERY_GRACE_MS`, a time window, not a
  limit) taken from the WebSocket reconnect backoff (`reconnectDelayMs` in
  `src/shared/wsClient.ts`): the first three reconnect waits (1.5 + 3 + 6 s)
  plus one base wait for the handshake, 12 s. A window that was only
  reconnecting claims its request back within that time.
- A rollback restores the version Extensions keeps for rollback: the window
  asks the same confirmation as the Extensions pane first (cancelled →
  `failed`, `not-applied`), and rolls back only when that is `target.version`,
  else it finishes `failed` with the reason (it never installs a version the
  user did not approve).
- `plugins.agent_request.finish` `{approval_id, status: completed | failed,
  error, confirmation}` (window): the confirmation is minted for the action
  `plugins.agent_request.finish` (in `TRUST_CONFIRM_ACTIONS`) with subject
  `<approval_id>:<status>`, so a confirmation to report failure cannot report
  success; only `applying` moves. The result is broadcast as
  `plugins.agent_request_resolved` `{approval_id, status, error}`.
  One exception, so the record matches what happened: when another window
  settled the request (recovery) and the window that was carrying it out
  reports afterwards, that window's result is taken, once. The record then
  carries `finished_late: true` and `settled` `{status, error}` (what recovery
  had said); the resolved event carries both too, the audit row is
  `finish-late-completed` / `finish-late-failed`, and the window's card says
  the result came late. Any other window is still refused
  (`PLUGIN_APPROVAL_NOT_APPLYING`).

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
| Where the disclosure is signed | a separate disclosure envelope, same signer key; the 8-field package envelope is unchanged | released Apps reject any extra package-envelope field; user decision 2026-10-17 (option B) |
| `nativeCodeInspected` | `true` = backend + admin-approved, `false` = backend auto-published, `null` = no backend | the Registry records review per version but no separate inspection flag; user decision 2026-10-17 |
| Shell executables | `allowlist` → the Host allowlist `gh, git, glab`; `full` → `null` (any) | a manifest declares only the mode |
| `host` caller kind | gated by the DB4 switch, like `external` | it is not attributable to a pane either |
| Daily rollup retention | 90 days | the 30-day "never used" signal needs more than 7 days of history |
| Error-code case | new Host codes upper-case | matches the Host's existing `CAPABILITY_DENIED`, `PLUGIN_STOPPING` |
| What drives the disclosure card | the Registry's static scan (3.8) first, manifest declarations beside it (3.9) | user decision 2026-10-17: the system scans at publish, the package does not apply |
| Shell scope | no sub-scopes: the broker rules stay those of `shell.run` (`allowlist` = `gh, git, glab`; `full` = any) | user decision 2026-10-17 ("一律不限制") |
| Manifest `network` | `via-shell` whenever shell is declared, else `none` | a declared shell reaches remote hosts through git/gh/glab even without a network permission |
| Scan report content | facts only; sentences, reasons and the comparison are derived by pure functions in both languages | the App renders what it can check against the signed facts, and wording changes need no rescan |
| DS1 How the scan is signed | separate `scanDigest` in the disclosure envelope | the App checks the recomputable half alone; a rescan replaces only `scanDigest` |
| DS2 Incomplete scan | at least `high` (`scan.incomplete`) plus a visible "掃描不完整" | what cannot be seen is not evidence of no risk |
| DS3 Undeclared findings | disclosed (red), never block publish or install | disclose, don't restrict; the Host refuses undeclared calls at run time anyway |
| DS4 When the scan runs | synchronously in the publish (and approval) request, `timeBudgetMs` 30000 | the result is signed with the version; a timeout is disclosed, not fatal |
| DS5 Network detail | host names only | URL paths and queries can carry tokens |
| DS6 Embedded runtimes and packed executables | disclosed as "無法掃描", not unpacked | unpacking is deferred work |
| DS7 Rescan | manual admin rescan; old reports are kept | a scanner upgrade is a deliberate operation |
| DS8 Envelope | the 9-field disclosure envelope ships first, `scanDigest` may be `null` | D-a, D-b and D-c can merge before the scanner without another envelope change |
| DS2 for scanner failures and ceilings | new `coverage.skipped` reasons `scannerError` and `tooComplex`, both incomplete (at least high, "掃描不完整"); added in the scanner PR, existing values unchanged | a scanner crash or a hostile structure must never leave a version without a report or with a report that looks complete (review of #355) |
| DS9 Unknown subcommand | `unknownSubcommand`, worded "may reach a remote", level high | an unknown subcommand cannot be shown to be local |
| DB9 result cap | none; size disclosed as `resultBytes`, stability from chunked transfer (4.4) | user decision 2026-10-17 (DB9 option a) |
| Argument cap | none on any hop; size disclosed as `args_bytes`, arguments travel in pieces (4.4) | user decision 2026-10-17 ("傳給外掛的參數上限也拿掉") |
| Transfer time | `timeoutMs` covers the plugin's execution only; transfers run on a 30 s idle timer restarted by every piece, and `agent.capability.progress` keeps the backend's wait alive | time must not turn into a size limit (review of #358, M2); the idle timer detects a dead peer, it does not bound a size |
| Piece counts and odd input | an integral float counts (`1.0` = `1`); a non-object piece is `seq`; a repeated, skipped or backward `seq` fails on arrival; Python escapes lone surrogates like `JSON.stringify` | both languages give the same answer for every input (#358 review L1–L3, INFO) |
| Child frame size | no limit on the Host's reader; the 1 MiB `maxFrameBytes` failure is removed | a size must never kill or restart a child (user decision 2026-10-17); pieces stay the normal path for interleaving |
| Piece size | 131,072 UTF-8 bytes on every hop, both directions | worst-case escaping keeps a piece frame under 1 MiB, the frame size child readers use (the built-in Plans backend's `MAX_FRAME_BYTES`); small enough that other calls interleave |
| Arguments-size field | `args_bytes` only, measured by the backend as UTF-8 bytes of the compact spelling (the `resultBytes` measure); `args_sha256` stays canonical; no `meta.argsBytes` | one number for one fact, in the same unit as the result size; the backend sees the arguments first and writes the audit row |
| Who measures the size | the Host, once, compact JSON (`agentToolResultBytes`) | one number from the hop that sees the plugin's value; the backend's spelling differs |
| Example backend method names | lowercase dotted (`devmap.block.status`) | the Host supervisor refuses upper-case method names (2.1) |
