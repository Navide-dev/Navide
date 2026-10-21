# Plugin Developer Spec v2

> **Status: implemented for third-party publishing.** Manifest v2 is the format
> the Navide Marketplace accepts; the legacy manifest v1 runtime is documented in
> [Plugin development guide](plugin-development.md). The bundled `navide.git`,
> `navide.plans` and `navide.mini-ide` packages run on this contract, and so do
> third-party packages installed from a Registry.
>
> Installing a v2 package from a Registry and choosing **Restart Plugin**
> writes an exact package-version grant for the declared `permissions` plus
> Host-managed storage, so a third-party view can call the public catalog and
> `storage.*` (see [Host-managed storage partitions](#host-managed-storage-partitions)).
> Third-party native backends run only under the OS sandbox and consent rules
> in [Third-party backends](#third-party-backends-sandbox-consent-and-publishing).
>
> What is not available: Navide never calls a `definePlugin` activation function
> (see [SDK interface](#sdk-interface)); there is no `navide-plugin dev` command;
> the environment-variable Developer Mode of a development build
> (`AGENT_TEAM_PLUGIN_DEV_PATH`) cannot open a Manifest v2 view or run a
> backend, while a folder loaded with Settings → Navide Plugins → Developer
> Mode can (see [Backend trust](#backend-trust)); there are no command, menu or keybinding
> contribution points; `custom` is the only view kind; and a package can be
> installed and removed but not disabled.
>
> The SDK CLI (`navide-plugin`) covers the whole publishing workflow —
> `init`, `validate`, `package` (per target), `keygen`, `sign`, `login`, and
> `publish` — see [Publishing to the Navide Marketplace](marketplace-publishing.md).
> The first-party Plans build scripts package the app's production artifact
> and are not the public author workflow.
>
> **Migration decision:** Plan B (the B0-B9 checkpoint path) was approved on
> 2026-08-13. Plans A and C are not active implementation alternatives.

> **Issue 19 production first-party package:** The approved Plan B Git
> migration is now implemented as the bundled `navide.git` production case.
> It is one Manifest v2 package with two isolated `custom` views (`left` and
> `window`), and both views use the same active package version. This does not
> open third-party publishing or complete the later Skills migration,
> marketplace lifecycle, or legacy-removal work.

## Design principle: disclose, don't restrict

This is the governing rule for every plugin, permission, capability and
Marketplace decision. The product owner set it on 2026-10-04 and restated it on
2026-10-17: "disclose every permission absolutely; don't restrict", and
"disclosure means more than restriction". Effective disclosure is the core
value of the Navide Marketplace.

- **A plugin is a full program.** Each plugin has its own frontend and backend.
  The platform does not cap what a plugin may do with framework limits,
  capability allowlists or mutually exclusive permissions.
- **Every power is declared, disclosed and consented to.** Anything a plugin
  can do (files, shell commands, a native backend, network, tools offered to
  agents) is declared in its manifest. The user sees it in plain language,
  with its risk level, before installing, and grants it explicitly. A version
  that adds a power asks again and shows exactly what changed.
- **Disclosure must be effective, not merely present.** Show the disclosure
  where the decision is made (the listing and detail page, not only a dialog
  after "Install"). Show what a plugin actually did at run time, not only what
  it declared. Interrupt the user only when something changes, so warnings do
  not wear out.
- **What the platform keeps is protection against deception, not
  restriction.** Signatures and digests, the reserved `navide.` namespace,
  tool names that cannot impersonate built-in tools, caller identity, and
  labelling third-party output as external stay in force. They stop one party
  from pretending to be another; they do not limit what an honest plugin can
  do. Each such rule must state why it is protection rather than restriction.

When a new design would add a restriction, turn it into a declaration plus
disclosure instead, or bring it to the product owner as an explicit decision.
Some existing rules in this spec predate the principle and are under review:
a third-party method is callable by MCP agents only as a declared agent tool,
behind a switch that is off by default (see
[Agent tools](#agent-tools-backendagenttools)). (A backend package may now declare
`shell: "allowlist"`; see [Third-party backends](#third-party-backends-sandbox-consent-and-publishing).)

## What is public

Third-party plugins may depend only on these public package names:

- `@navide/plugin-contracts`: manifest types, capability addresses, payloads,
  error codes, and JSON Schema exports.
- `@navide/plugin-sdk`: activation, capability calls, events, lifecycle, view,
  and target APIs.
- `@navide/plugin-ui`: Vue components, shared presentation services, stable
  design tokens, and safe capability-backed UI controllers that do not expose
  Host transports.

Official and third-party packages use the same public dependency graph and the
same install, activation, update, rollback, and uninstall lifecycle. Official
status changes only Registry trust and marketplace classification; it does not
grant access to private Host modules or force an official package to be
installed. The base App must remain usable with an empty plugin catalog.

The `@navide/plugin-ui/editor` subpath provides the shared text editor and a
typed consumer-injected `EditorPort`. It does not expose Host transports,
diagnostics stores, window state, or filesystem authority. See
[Shared editor composition](editor-design.md#shared-editor-composition) for
its peer dependency, effect adapter, and restricted-preflight contract. Raw
terminal and vendor-shell modules remain Host-owned; Plugins use the public
safe AI CLI controller instead. The user reaffirmed this graph for miniIDE
migration on 2026-09-11, superseding the earlier private-feature proposal.

The package manifests declare public npm publication metadata and use normal
SemVer 2.0.0 versions, but registry publication is future work outside Issue
06. The package implementations live under
`packages/plugin-{contracts,sdk,ui}/` and have no dependency on Host
renderer sources. Third-party projects must use registry versions in a
published workflow, never `workspace:` dependencies. The Issue 06 release
gate packs those public packages and installs the tarballs in a directory
outside the Navide workspace; it does not publish to npm.

## Recommended source project

The source project is a scaffold convention, not the installed package
contract. Authors may change framework- or language-specific files, but the
generated publish staging directory must use the artifact layout defined
below.

```text
acme-files/
├── manifest.json
├── package.json
├── src/
│   ├── frontend/
│   │   ├── left/
│   │   │   └── main.ts
│   │   └── window/
│   │       └── main.ts
│   ├── backend/                 # Optional; language-specific source
│   └── shared/                  # Optional; package-private source
├── assets/
│   └── files.png
├── tests/
├── vite.config.ts               # Example frontend build configuration
└── dist/
    └── package/                 # Generated publish staging directory
```

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "tsc -p tsconfig.json && node scripts/stage-package.mjs",
    "check": "navide-plugin validate dist/package",
    "package": "navide-plugin package dist/package --out dist/acme-files.vsix"
  },
  "dependencies": {
    "@navide/plugin-contracts": "^1.0.0",
    "@navide/plugin-sdk": "^1.0.0",
    "@navide/plugin-ui": "^1.0.0"
  }
}
```

The SDK distribution includes a `navide-plugin` executable with these
commands:

```text
navide-plugin init <directory> --id <namespace.name> [--name <display name>]
navide-plugin validate <directory> [--target <target>]
navide-plugin scan <package.vsix | directory> [--target <target>] [--json]
navide-plugin package <directory> [--target <target>] [--out <file>]
navide-plugin keygen [--out-dir <directory>] [--name <name>]
navide-plugin sign <package> --key <private-key> [--out <signature>]
navide-plugin verify <package> --key <public-key> --signature <signature>
navide-plugin login [--registry <url>] [--label <label>] [--no-browser] [--insecure-http]
navide-plugin whoami [--registry <url>]
navide-plugin status [<namespace.name>[@<version>]] [--registry <url>] [--json]
navide-plugin logout [--registry <url>]
navide-plugin publish <package> [--registry <url>] [--target <target>] [--signature <file-or-value>] [--insecure-http]
navide-plugin publish <package.vsix> --via-navide [--target <target>] [--no-browser]
navide-plugin dev-backend <directory> [--call <method>] [--args <json>] [--subscribe <event,...>] [--data <directory>]
```

Every staging directory includes an `artifact-files.json` control file with one
explicit `files` array. It is not included in the archive. `validate` rejects
duplicate JSON keys, unknown manifest fields, unsafe paths, symlinks, missing
referenced files, source-only material, and package shapes that do not match
their manifest. `package` emits a deterministic `.vsix` ZIP with a root
`manifest.json`. Frontend-only packages use `universal`; backend and combined
packages must name the build host's exact platform-architecture target and
contain one self-contained executable. `sign` and `verify` use a detached
Ed25519 signature over the SHA-256 digest of the complete archive. `init`
scaffolds a frontend-only package that validates without a build step;
`login` and `publish` talk to a Registry (see
[Publishing to the Navide Marketplace](marketplace-publishing.md)). Apart from
`dev-backend`, which launches a built backend under the sandbox, the CLI has
no Host transport, process execution, or development server.

## Issue 06 external workspace workflow

The repository example at `examples/third-party-files/` is copied into a
temporary project outside the Navide workspace for the release smoke test. Its
package manifest declares SemVer ranges for the three public packages. The
smoke test replaces only those three public package ranges with local packed
tarballs and installs them with `pnpm --offline` in an isolated temporary
store. It uses the repository's installed TypeScript and Vite CLI entries for
the external project's typecheck and build; it does not install TypeScript or
Vite tarballs offline. The example itself contains no `workspace:` or private
feature dependency.

From the external project, the supported workflow is:

```text
pnpm install
pnpm run typecheck
pnpm run build
pnpm run check
pnpm run package
```

The example declares the `fs` system namespace and successfully invokes
`fs.readFile`. It also attempts `shell.run` without declaring `shell`; the Host
authorization seam rejects that call with `CAPABILITY_DENIED`. Both calls run
only in the smoke test, which calls the exported `definePlugin` object's
`activate` with an in-memory Host. Inside Navide that function is never called
and the view never reports ready (see [SDK interface](#sdk-interface)), so the
example is a build and packaging reference, not a package to install. The
example does not implement backend wire handling, subscriptions, Git
transport, or any later package lifecycle.

## Normative publish artifact

A publishable plugin is one ZIP archive conventionally named `*.vsix`. The ZIP
does not contain a wrapping package directory: `manifest.json` is located at
the archive root. The filename below is illustrative only; package identity and
version come from the manifest, never from the filename.

```text
acme.files-1.0.0-darwin-arm64.vsix
├── manifest.json                # Required at the archive root
├── frontend/                    # Present when contributes.views exists
│   ├── left/
│   │   ├── index.html
│   │   └── assets/
│   └── window/
│       ├── index.html
│       └── assets/
├── backend/                     # Present when backend exists
│   └── acme-files               # Regular executable for this OS/architecture
├── assets/
│   └── files.png
└── README.md                    # Optional; not used by the runtime
```

The publish staging directory and final archive obey these rules:

- Every `contributes.views[].entry`, view icon, marketplace icon, and
  `backend.entry` resolves to an existing regular file inside the same archive.
- Frontend-only packages omit `backend/`; backend-only packages omit
  `frontend/`; combined packages contain both. A directory name alone does not
  declare a contribution: the manifest is authoritative.
- A backend artifact targets one OS/architecture combination. Different target
  artifacts for the same plugin version are built, digested, and signed
  independently; one archive does not contain a platform selector or multiple
  backend executables.
- All archive entry names are relative POSIX paths. Absolute paths, empty,
  `.`, or `..` segments, backslashes, duplicate canonical entries, regular-file
  ancestor collisions, symlinks, and non-regular special files are rejected
  before extraction. Each entry name is at most 1024 characters. A directory
  entry may have one trailing `/`; that slash is removed for canonical
  comparison and extraction.
- `.navide-receipt.json`, `.navide-registry-receipt.json`,
  `.navide-package.zip`, `.navide-registry-trust.json`, version selectors,
  activation catalogs, storage snapshots, and active/previous state are
  Host-owned and must not appear in an author-created archive.
- Source files, tests, private keys, credentials, caches, `node_modules`, and
  build-system output not referenced by the package must be excluded. The
  packager uses an explicit canonical file list rather than recursively zipping
  the source project.
- The detached publisher signature is not stored in the ZIP. It signs the
  digest of the complete archive, so the manifest, frontend, backend, assets,
  and optional documentation are all covered.
- The normal marketplace installer rejects unsigned Manifest v2 archives.
  Unsigned local code belongs to the separate Developer Mode path and is not
  eligible for publishing or automatic updates.

### Backend source, development, and publish contract

The backend implementation language is private to the plugin. Navide does not
select an interpreter from the manifest and does not import an author's module.
The public runtime seam is one executable plus the versioned Navide backend
protocol.

| Stage | Python backend | Host-visible contract |
|---|---|---|
| Source development | Authors may use `.py` files, a virtual environment, and any Python build/test layout. | None. Source layout is not an installed interface. |
| Local testing | Turn on Developer Mode (Settings → Navide Plugins) and **Load from folder…**: the view opens with its declared grant and the backend runs in the same sandbox, after the same native backend consent, as an installed one. `navide-plugin dev-backend <directory>` still runs the executable alone, with every Host bridge request answered `CAPABILITY_DENIED`. | A developer folder's consent is bound to the folder and its manifest `permissions` and `backend`; editing files never asks again, changing either declaration does. |
| `navide-plugin package` | Python, its required modules, and the plugin code are bundled into a target-specific executable by an author-selected tool such as PyInstaller or Nuitka. | `backend.entry` names the resulting executable inside the archive. |
| Install and runtime target | No Python installation, `pip`, virtual environment, source checkout, or author build tool may be required on the user's machine. | The Electron main process supervises the executable over Backend Wire v1 without a shell. The first-party Plans backend runs directly; a third-party backend runs only under the conditions in [Third-party backends](#third-party-backends-sandbox-consent-and-publishing). |

Manifest validation rejects recognizable source or script suffixes. Package
validation also rejects empty backend entries, POSIX entries without executable
metadata, and extensionless executable files whose contents begin with a
shebang. The installer writes the declared backend entry with owner-only `0700`
mode. These checks prove archive executable intent; binary-format and exact
OS/architecture validation remain part of the canonical artifact work in B8.

The same publish rule applies to every implementation language: Go or Rust may
compile directly; Node.js requires a distributable executable that does not
depend on a separately installed Node.js runtime. The manifest does not contain
`language`, `python`, `module`, `interpreter`, or build-tool fields because none
of them are part of the Host interface.

A publishable Python backend therefore uses this shape:

```text
source project                          publish artifact
src/backend/main.py                    backend/acme-files
pyproject.toml            package      manifest.json
.venv/                    ────────>     (no .py, .venv, pip, or build config)
```

```json
{
  "backend": {
    "entry": "backend/acme-files",
    "protocolVersion": 1,
    "activation": "startup"
  }
}
```

`backend.entry: "backend/main.py"` is not a portable v2 publish artifact and
must be rejected. On POSIX targets the referenced regular file must be
executable; on Windows it must use the accepted executable format. Each
OS/architecture build is packaged, digested, signed, and published as a
separate artifact for the same plugin version.

The current v1 built-in loader is different: it discovers Python `backend.py`
files and imports them into the existing backend process. That behavior is a
legacy migration input only. It does not define the v2 package format and must
not be exposed to third-party v2 packages.

Cross-language backend support is not considered available merely because the
manifest has `backend.entry`. It becomes a public capability only after the
backend protocol, development launcher, packager, platform validation, and
cross-language conformance fixtures pass the B5/B8 release gates.

### Third-party backends: sandbox, consent, and publishing

A backend in any package other than the first-party `navide.plans` is
third-party native code. The Host never runs it directly; it starts only when
all of these hold, and they are checked again before every restart:

- Settings → Navide Plugins → "Allow third-party Navide plugins to run native backends"
  is on. It is off by default and can only be turned on there: while it is
  off, opening a plugin never prompts and never turns it on.
- The user has not disabled the plugin's backend.
- The user allowed this exact package content with this exact permission set
  (`permissions`, `backend.methods`, `backend.events`, and - only when the
  package declares any - `backend.agentTools`). The digest covers every
  file in the package (relative path and content), because a backend can read
  any package file and turn it into code at run time. Any new version that
  changes any file - frontend files included - is staged but not started until
  the user allows it again.
- The platform sandbox is available. There is no unsandboxed fallback.
- The package does not declare `permissions.shell: "full"`. A backend package
  may declare `shell: "allowlist"`; see "Shell commands from a backend" below.

| Platform | Sandbox | Contains | Does not contain |
|---|---|---|---|
| macOS | Seatbelt (`sandbox-exec`), deny by default | reads outside the package and its private data directory, writes outside the data directory, every network connection including loopback and DNS, executing anything outside the package (including files it writes to its data directory), Keychain, even the metadata of `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.claude`, `~/.codex`, `~/Library/Keychains`, `~/Documents`, `~/Downloads` | CPU and memory (see below); `stat` of other paths still succeeds, because denying metadata reads under all of `/Users` or `/private/tmp` makes a real PyInstaller backend exit at start |
| Linux | bubblewrap with every namespace unshared, only when the system `bwrap` can create unprivileged user namespaces | the same file view and no network; every process dies with the pid namespace (checked by the linux-sandbox CI workflow on Ubuntu 24.04; not yet verified on real user hosts) | CPU and memory; system binaries under `/usr` can run inside the namespaces |
| Windows | not supported yet (AppContainer is planned for v1.1) | — | — |

On macOS a process can leave the child's process tree (fork, `setsid`, fork:
the grandchild is reparented to launchd). Because the sandbox lets a process
exec only files of its own package, the Host recognises every such escapee by
its kernel executable name and the image lsof reports, counts it in the
resource limits, and kills it whenever the child stops (kill switches, idle
stop, crash, Host shutdown) and before the next child starts.

Installing or updating a package health-checks a third-party backend only when
it would also be allowed to run - switch on, not disabled, consent for this
exact content and permission set, sandbox available - and then under the same
watchdog; otherwise the package is only staged and nothing is executed.

The child's `HOME`, `TMPDIR`/`TEMP` and `XDG_*` point at its private data
directory, which is also its working directory, so a PyInstaller one-file
executable can extract itself there. Files written to the data directory can
still be loaded as code (`dlopen` or an executable mapping), though not
executed as a program; this is why consent binds to the whole package content. Its only route to the user's files is the
Host bridge: `filesystem` reads (`read_file`, `read_range`, `list_dir`,
`stat_path`) inside the workspace the view is bound to, when the package
declares `permissions.system: ["fs"]` and the user granted it. Writes
(`write_file`, chunked writes, `delete`, `rename`) additionally need a
per-workspace "allow file changes" grant, asked once in a dialog and revocable
in Settings. The only other bridge port is the shell broker described next;
every other bridge port is refused. Third-party methods are never callable by
MCP agents.

#### Shell commands from a backend

A backend package may declare `permissions.shell: "allowlist"` (DB5 of plan B:
disclosed, not refused). The consent dialog then states it as **high risk**,
the disclosure data lists `shell.allowlist` as a high risk reason (see
[plugin-agent-tools-contract.md](plugin-agent-tools-contract.md), section 3.3),
and the consent binds to it: `shell` is part of the consented permission set,
so a version that adds it is staged until the user allows it again.

The backend never executes anything itself (the sandbox lets it exec only files
of its own package). It sends the Host bridge request `port: "shell"`,
`operation: "run"`, `arguments: {"command": "<command>"}`, and the Host runs it
through the same shell broker as a view's `shell.run` in `allowlist` mode: only
`git`, `gh` and `glab` as a plain command without shell syntax, in the
workspace the view is bound to, with credential/auth subcommands, `-c`/`-C` and
the other overrides refused (the Host shell executable allowlist in
"Host-managed storage partitions" below). The
answer is `{exitCode, stdout, stderr, truncated, stdoutBytes, stderrBytes?}`,
the same as a view's `shell.run` (see "`shell.run` output size" below); a
refused command is the bridge error `CAPABILITY_DENIED`. The Host checks on every call that the package declares
`shell: "allowlist"`, that the user's capability grant for this package version
has the same shell mode, that the call comes from a live binding of this
version at its bound workspace root. Today only user-initiated calls are
served: an agent-initiated shell call is refused (third-party methods are not
agent-callable yet; B1-b of plan B opens that path, and the supervisor already
applies the user's agent execution policy to the command for it). A backend
that does not declare it is refused the port. A command the broker has already
started is not cancelled when the plugin is disabled, its permission is
revoked or the bridge request times out (30 s): it runs to completion, up to
the broker's own 30 s limit. Revocation takes effect at the next call. `shell: "full"` is not available to a backend: the broker
serves only the allowlist, and such a backend is not started
(`shell-not-allowed`).

**Network reach.** The sandbox still denies the backend process every network
connection, but a backend with `shell: "allowlist"` is **not** a backend
without network access: the broker's `git`, `gh` and `glab` commands contact
network hosts (`git fetch`/`push` to any URL the repository or command names,
`gh api`, `glab api`), so the backend can send workspace data off the machine
through them. Through git it can also read and change workspace files (for
example `git show`, `git checkout -- .`, `git clean`) without the separate
per-workspace file-change grant. The consent dialog says so plainly instead of
"it has no network access" and "changing files needs your separate
permission", which it keeps only for backends without shell, and Settings →
Navide Plugins → Native backends keeps a high-risk marker on such a plugin's
row; the
disclosure data's `network` field is still `"none"` in contract v1 and is
being revisited separately. The broker rules are exactly those of a view's
`shell.run`.

**Network reach of views.** The sandbox above is the backend's. A plugin view
is an ordinary web page on the default session: it can `fetch` any host (and
read the response where CORS allows), load images and scripts from anywhere,
and embed an external website in an `<iframe>` whose scripts run. The Host
installs no request filtering, CSP or frame-navigation rule on views (only the
frame carrier, `navide-plugin-frame://`, has a CSP), so none of this traffic is
filtered or recorded. A view that can read workspace content through its
capabilities can therefore send it off the machine, and a view can show a
remote page that looks like a sign-in page. The disclosure data's `network`
field covers only commands and the native backend, so the disclosure card of
a package with views (`contributes.views` in its manifest) states this
separately, including for a view-only package whose `network` is `"none"`; a
package without views (backend or agent tools only) gets no such line, and
where the card shows Registry listing data without the manifest (the Navide
Marketplace detail page, an agent's install request) it says so
conditionally. Making view network access a declared permission (DB10) is planned
for 0.2.27.

#### Agent tools (`backend.agentTools`)

A package with a backend may declare tools that agents call through the core
`navide` MCP server. The full rules are in
[plugin-agent-tools-contract.md](plugin-agent-tools-contract.md) section 2;
the manifest side is:

```json
"backend": {
  "entry": "backend/devmap",
  "protocolVersion": 1,
  "activation": "startup",
  "methods": ["devmap.read", "devmap.status"],
  "agentTools": [
    {
      "name": "devmap_set_status",
      "method": "devmap.status",
      "risk": "write",
      "title": "Set block status",
      "description": "Set one block's status (done|wip|plan) in this workspace's dev map.",
      "timeoutMs": 30000,
      "inputSchema": {
        "type": "object",
        "required": ["block_id", "status"],
        "properties": { "block_id": { "type": "string" }, "status": { "enum": ["done", "wip", "plan"] } }
      }
    }
  ]
}
```

| Tool field | Required | Rule |
|---|---|---|
| `name` | yes | `^[a-z][a-z0-9]{1,15}_[a-z0-9_]{1,40}$`, unique in the package, and starting with the prefix derived from the plugin id: its last dot segment with every `-` removed (`nerdtechnic.dev-map` → `devmap_`). A prefix that cannot be derived, a reserved prefix (`cli_`, `plan_`, `navide_`, the built-in packages' `git_`, `plans_`, `miniide_`, ... see the contract) and every core tool name are refused |
| `method` | yes | One of `backend.methods`, the Host forwards the call to it. It must also be a name the backend supervisor accepts (`isMethodName` in `src/main/plugins/pluginBackendSupervisor.ts`): lower-case dotted segments such as `devmap.read` or `devmap.block.status`. A camelCase method (`devmap.setStatus`) passes the `backend.methods` pattern but is refused at activation, so a tool naming one is refused at install and publish |
| `risk` | yes | `read` or `write`; shown wherever the tool is disclosed, and `write` makes the package high risk |
| `title`, `description` | yes | Non-empty plain text with no control characters, no U+2028/U+2029, no `<` or `>`, and no invisible character (bidi controls, zero-width and other format characters, variation selectors, tag characters; see the contract); no length limit apart from the 1 MiB stability cap on `description` |
| `inputSchema` | yes | JSON Schema whose `type` is `"object"`; every number in it must be a safe integer; every nested `description` and `title` string follows the same text rule; its canonical spelling is capped at 1 MiB |
| `timeoutMs` | no | Integer 1–120000; default 30000 |

A package with any invalid tool is refused at install and at publish, exactly
like a schema error. `agentTools` needs a native backend, so frontend-only
packages cannot declare it.

What the user sees and consents to: the install confirmation and the native
backend consent dialog list every declared tool with its name, the method it
calls, its full description, its declared read-only or changes-data claim (the
package's own claim), its timeout and its whole input schema, plus the number
of tools and their total size. There is no limit on the number of tools. The tools are part of
the consent: any change to any tool (name, method, risk, text, schema, timeout)
asks again. A package that declares no tools keeps exactly the consent it had
before this field existed.

Two packages can derive the same prefix. When both declare the same tool name,
the package the user first allowed with that name keeps it (a name an update
adds counts from that update); the later one's tool stays
offline, and Settings → Navide Plugins says so in both rows. A package the user
has not allowed (or not re-allowed since its tools changed), or whose native
backend the user disabled, holds no names, and a version that declares no
tools gives up its place.

Agents call these tools through the core `navide` MCP server behind two
switches in Settings → Navide Plugins → Native backends, both off by
default: **Let agents call tools from third-party Navide plugins** (agents in
your panes) and **Let external MCP clients call them too**. With the first
off, nothing is served: declared tools are validated, disclosed and consented
to, and every backend's agent methods stay empty. With it on, a tool is
served only for an installed, enabled package whose current consent covers
it; the Host re-checks the switch, the caller kind, the package state, the
consent and the tool on every call. A `write` tool asks once per package and
workspace before its first call. The result is returned as external content
labelled with the package, and the calling pane is marked tainted, like any
other external input. Methods that no tool names are never callable by
agents. See [plugin-agent-tools-contract.md](plugin-agent-tools-contract.md)
section 4.

`backend.methods` and `backend.events` declare the package-local names the
Host forwards (1–64 methods, 1–32 events, dotted lower-camel names such as
`files.search`). A name that is not declared is refused before it reaches the
child. A third-party backend that declares no methods is never started.

A third-party child with no call, subscription or bridge traffic for 10
minutes is stopped. The next call starts it again lazily, through the same
admission checks (switch, consent, sandbox, trust); an open subscription keeps
it running. The first-party Plans backend is not affected.

Before publishing, run the built backend locally with
`navide-plugin dev-backend <directory>`: it launches the backend under the same
sandbox profile, refuses undeclared methods and events, prints results, events
and stderr, and answers every Host bridge request with `CAPABILITY_DENIED`. See
[marketplace-publishing.md](marketplace-publishing.md), "Test a native backend
before publishing".

The Host samples the child's process tree every 5 seconds and kills it after
two samples over 512 MiB resident memory, more than 8 processes, a data
directory over 1 GiB, or 5 minutes of a full core. A failed child restarts
after 1 s, 5 s and 30 s; a fourth failure within 10 minutes keeps it stopped
until the user allows it again. The kill switches are the global setting, the
per-plugin disable switch, the Registry blocklist (a trust refresh revokes a
blocked package's running child and quarantines the package, and the pre-spawn
trust check refuses it) and the Registry trust metadata expiry (an expired
snapshot fails the pre-spawn trust check).

Publishing a package with a backend from a self-service namespace requires an
administrator to allowlist the publisher and a verified publisher domain
(DNS). The package must declare `engines.navide` of at least `>=0.2.14`
(`>=0.2.25` when it requests `shell: "allowlist"`; `shell: "full"` is refused),
and every version waits in the review queue, where the
reviewer must confirm having inspected the executable of every target. The
secret scan reads backend executables in full (up to 512 MiB uncompressed per
file) instead of the first 5 MiB, and name similarity also warns on names
within two edits of another publisher's extension.

### Removing a plugin

Removing a plugin (Settings → Navide Plugins, or the Navide Marketplace detail
page) stops its views and backend, then deletes the package files, its
capability grant, its native-backend consent, disable switch and per-workspace
"allow file changes" grants, all of its Host-managed storage (see "Host-managed
storage partitions"), and its activation record. A reinstall asks for every
capability and native-backend consent again.

A third-party native backend also keeps private data in
`<userData>/plugin-native-backends/data/<pluginId>/` (its `HOME`, `TMPDIR` and
`XDG_*` directories, see above). The remove dialog asks about it only when that
directory exists: it says how large the data is and where it lives, and offers
"Keep this data so a reinstall can use it again". That box starts unticked, so
the data is deleted by default. When there is no such directory the dialog is
the plain remove confirmation. Deletion removes exactly that one directory: the
Host refuses a plugin id that is not a single path component, refuses a data
root or data directory that is a symbolic link, and never follows a link inside
it, so it cannot reach the user's workspace or any other file.

For callers of the `plugins:remove` IPC, the data choice is the optional
`nativeBackendData: 'keep' | 'delete'` argument. Omitting it keeps the data, as
before this choice existed; `plugins:nativeBackendData` reports
`{ exists, bytes, path }` for the dialog.

What removal keeps:

- Publisher trust: removing a plugin keeps publisher trust. A reinstall of the
  same package from the same publisher does not ask "trust this publisher"
  again; the capability and risk confirmation is still asked.
- Pre-release channel: removing a plugin keeps its "Get pre-releases" opt-in,
  so a reinstall is offered pre-releases again.
- The global "Allow third-party Navide plugins to run native backends" switch,
  which belongs to the user, not to any plugin.
- Files the plugin wrote in the user's workspaces. The Host does not track
  them and never deletes them.

### Navide Backend Wire v1

`backend.protocolVersion: 1` selects **Navide Backend Wire v1**. This is a
small, Navide-owned profile aligned with the base message and stdio conventions
of MCP revision `2026-07-28`. It is not a complete MCP server contract and must
not be advertised as MCP-conformant.

The profile deliberately adopts only these MCP conventions:

- UTF-8 JSON-RPC 2.0 messages; request IDs are non-null strings or integers and
  are unique while in flight.
- stdio uses exactly one compact JSON-RPC message per line. Embedded newlines
  are forbidden. `Content-Length` headers and the legacy MCP
  `initialize`/`initialized` exchange are not used.
- Every request includes `_meta.io.modelcontextprotocol/protocolVersion` set to
  `2026-07-28`, `_meta.io.modelcontextprotocol/clientCapabilities`, and the
  diagnostic-only `_meta.io.modelcontextprotocol/clientInfo` when available.
- Cancellation uses `notifications/cancelled`; optional progress uses
  `notifications/progress` and the request's `_meta.progressToken`.
- stdout contains protocol frames only. Human-readable logs use stderr.
- Closing stdin is the graceful shutdown signal. The Host waits for a bounded
  period before terminating a process that does not exit.
- The Host supplies an explicit environment map for each backend process. The
  child does not inherit the Electron main process environment; invalid keys,
  non-string values, and NUL characters reject activation. Timed-out or
  cancelled request IDs are retained only for bounded late-response handling.

Navide does **not** initially implement MCP `server/discover`, tools, resources,
prompts, Multi Round-Trip Requests, MCP authorization, or the full MCP
extension negotiation model. The Host owns package authorization and runtime
identity; MCP `clientInfo` is never an authorization input.

The author-facing SDK remains transport-free:

<!-- docs-typecheck: mirrors PluginBackendClient -->
```ts
import type { Disposable, JsonValue } from '@navide/plugin-sdk'

interface PluginBackendClient {
  call<Result extends JsonValue>(
    name: string,
    args: JsonValue,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Result>

  subscribe<Payload extends JsonValue>(
    event: string,
    listener: (payload: Payload) => void,
  ): Disposable & { ready: Promise<void>; settled: Promise<void> }
}
```

`ready` resolves after the Host has accepted the subscription. A package view
may retain an existing event fallback until its package owns the equivalent
event source, and must dispose the returned subscription when its view is
destroyed. `settled` rejects if an accepted subscription ends because the
backend becomes unavailable, so the view can restore that fallback event
route. Issue 22 supplies the package-owned watcher and makes the accepted
package subscription authoritative. Legacy watcher fallback remains available
only when the package subscription cannot be accepted or later becomes
unavailable. Issue 23E uses this package-owned watcher in production Plans;
the legacy watcher remains the bounded fallback when the combined package is
unavailable.

The production adapter maps that Interface to MCP base methods plus one
Navide-owned event notification:

| Wire method | Direction | Meaning |
|---|---|---|
| `navide/health` | Host to backend | Prove that the process understands Backend Wire v1. It is not an identity or permission handshake. |
| `navide/call` | Host to backend | Invoke one package-local method with JSON arguments and Host-generated runtime context. |
| `subscriptions/listen` | Host to backend | Open one long-lived stream whose `notifications.dev.navide/pluginEvents` filter contains the approved package-local event names. |
| `notifications/subscriptions/acknowledged` | Backend to Host | Acknowledge the accepted event filter before delivering any event. |
| `notifications/navide/event` | Backend to Host | Deliver an event with `_meta.io.modelcontextprotocol/subscriptionId`; the Host validates the subscription and audience before forwarding it. |

The `subscriptions/listen` request ID is the subscription ID. The backend sends
`notifications/subscriptions/acknowledged` first, and every later event carries
that ID in `_meta.io.modelcontextprotocol/subscriptionId`. Cancellation refers
to the same request ID. A backend-initiated graceful close sends the final
`resultType: "complete"` response for the long-lived request.

Each Host-to-backend call carries a `runtime` object generated from the
authenticated binding. The frontend cannot set or override `pluginId`,
`packageVersion`, `workspaceId`, `instanceId`, `contributionKey`, or
`hostWindowId`. It also carries the Host-authenticated `initiator`: a `user`
initiator has `kind` and `id`, while an MCP-routed agent has `kind: "agent"`,
`source: "mcp"`, and an opaque `id`. The Host mints both forms from the
authenticated caller and rejects package-supplied identity fields. A call that
reaches the backend through one of its consented agent tools
(`backend.agentTools`, see `plugin-agent-tools-contract.md`) also carries
`initiator.caller`: `{kind, paneId, workspace, verifiedTo}`, where `kind` is
`pane`, `external` or `host`. It is verified only as far as `verifiedTo` says:
`pane` means the pane's own MCP token named that pane (nothing about the model
or the person behind it); `caller-kind` means only that the caller was an
external MCP client or the Host, which share one credential each. Use it for
display and your own records, not as an authorization decision; the Host has
already made that one. `caller` is additive and optional, and only packages
that declare agent tools ever receive it. `initiator`
was added after Backend Wire v1 shipped, so the v1 schema keeps it an additive
optional field: the Host always sends it, and a v1 backend must accept a
`runtime` both with and without it. Optional view/workspace fields are `null`
for startup-only backend calls that have no such binding.

```json
{"jsonrpc":"2.0","id":"req-1","method":"navide/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"navide-host","version":"0.2.0"}},"name":"plans.list","arguments":{"filter":"open"},"runtime":{"pluginId":"navide.plans","packageVersion":"1.0.0","workspaceId":"ws-1","instanceId":"view-1","contributionKey":"navide.plans.left","hostWindowId":"window-1","initiator":{"kind":"agent","source":"mcp","id":"agent-request-1"}}}}
```

A successful call response includes MCP's required `resultType` discriminator,
a `value`, and `_meta.io.modelcontextprotocol/serverInfo` with the backend
implementation name and version. Navide requires this MCP result metadata even
though the base protocol makes it optional. The final response that gracefully
closes a subscription may omit `value`, but it carries both `serverInfo` and the
subscription ID. A failed protocol request uses the standard JSON-RPC/MCP error
envelope, which has no result `_meta`, and may omit `id` when the request ID
could not be read. A handled Plugin error uses application error code `1000`
and the original request ID; its stable public `PluginError` string is placed in
`error.data.code`. Internal stack traces, Python exceptions, transport details,
and Host routes never cross the SDK Interface.

```json
{"jsonrpc":"2.0","id":"req-1","result":{"resultType":"complete","value":[{"id":"plan-1"}],"_meta":{"io.modelcontextprotocol/serverInfo":{"name":"navide.plans","version":"1.0.0"}}}}
{"jsonrpc":"2.0","id":"req-2","error":{"code":1000,"message":"Workspace is unavailable","data":{"code":"WORKSPACE_SCOPE_VIOLATION"}}}
```

The normative Backend Wire v1 schema and accepted/rejected fixture corpus are
published under `docs/plugin-contracts/` and validated together with the
Manifest v2 corpus. This contract enables backend-only and combined package
description and installation. Issues 07 and 08 add the private Electron-main
supervisor/stdio and subscription lifecycle seams; Issue 21 connects one
bundled Plans operation and event through the public SDK and Host router. Issue
22's bridge ports and child lifecycle are Host-private implementation seams.
Issue 23E consumes them for the first-party Plans package and exposes an
explicit Host-owned allowlist of Plans methods to the MCP adapter; no package
method is AI-callable by default, and adopting this wire profile does not
itself create a tool catalog. Installed third-party backends use the same wire
profile under the separate rules in
[Third-party backends](#third-party-backends-sandbox-consent-and-publishing).

After installation, frontend-only, backend-only, and combined packages appear
in the Navide Plugins installed list and can be removed there. Package inventory is
independent of frontend view descriptors, so a backend-only package remains
manageable even though it contributes no view.

The Host permits only one install or removal transaction per Plugin at a time,
including rollback. A competing operation for the same Plugin is rejected;
operations for different Plugins remain independent. An install consumes its
prepared package only after the required confirmations pass. If that attempt
fails, prepare the package again before retrying.

The exact OS/architecture identifiers, archive size limits, and deterministic
ZIP metadata are B8 decisions. Until they are published, examples must not be
treated as accepted enum values.

## Manifest

The normative schema is
[`plugin-manifest-v2.schema.json`](../plugin-contracts/plugin-manifest-v2.schema.json).

```json
{
  "schemaVersion": 2,
  "apiVersion": "^1.0.0",
  "id": "acme.files",
  "name": "Files",
  "version": "1.0.0",
  "publisher": "acme",
  "engines": { "navide": ">=0.2.0" },
  "permissions": {
    "system": ["fs", "ui"]
  },
  "marketplace": {
    "description": "Browse workspace files in the left workbench region.",
    "license": "MIT",
    "repository": "https://github.com/acme/navide-files",
    "homepage": "https://acme.example/navide-files",
    "categories": ["productivity"],
    "icon": "assets/files.png"
  },
  "contributes": {
    "views": [
      {
        "id": "left",
        "kind": "custom",
        "location": "left",
        "title": "Files",
        "entry": "frontend/left/index.html"
      }
    ]
  }
}
```

`contributes.views[].location` accepts exactly these values. The Host owns the
placement and mounts the plugin's isolated custom view into the selected
workbench region. `window` is the only value that creates a separate top-level
window.

The manifest `name` and every view `title` are plain display text with 1–80
Unicode code points; carriage returns, newlines, and angle brackets are
rejected. A manifest may declare at most 16 views.

| Value | Placement |
|---|---|
| `top` | Top workbench region |
| `bottom` | Bottom workbench region |
| `right` | Right workbench region |
| `left` | Left workbench region; use this when migrating a legacy sidebar contribution |
| `main` | Primary workbench content region |
| `detail` | Detail region filled by a composed receiver; never opens on its own |
| `window` | Separate top-level window |

`sidebar` is not a v2 location value. Unknown locations fail schema validation.

A package that contains both frontend and backend contributions uses one
manifest. `contributes` and `backend` are sibling top-level fields; the backend
does not have a second manifest:

```json
{
  "schemaVersion": 2,
  "apiVersion": "^1.0.0",
  "id": "acme.files",
  "name": "Files",
  "version": "1.0.0",
  "publisher": "acme",
  "permissions": {
    "system": ["fs"]
  },
  "marketplace": {
    "description": "Browse workspace files and maintain an index.",
    "license": "MIT"
  },
  "contributes": {
    "views": [
      {
        "id": "left",
        "kind": "custom",
        "location": "left",
        "title": "Files",
        "entry": "frontend/left/index.html"
      },
      {
        "id": "window",
        "kind": "custom",
        "location": "window",
        "title": "Files",
        "entry": "frontend/window/index.html"
      }
    ]
  },
  "backend": {
    "entry": "backend/acme-files",
    "protocolVersion": 1,
    "activation": "startup"
  }
}
```

The version axes are independent:

| Field | Meaning | When an author changes it |
|---|---|---|
| `schemaVersion` | Manifest document shape | Only when adopting another manifest schema |
| `apiVersion` | Public SDK and capability contract | When the plugin consumes another public API range |
| `version` | This plugin package release; SemVer 2.0.0 prerelease and build metadata are accepted | Every published plugin release |
| `engines.navide` | Optional product/runtime requirement | Only when the plugin needs a particular Navide product feature |
| `backend.protocolVersion` | Navide child-process wire profile; `1` freezes the MCP 2026-07-28-aligned conventions above | Only when adopting another supported Navide wire profile |
| `backend.methods` / `backend.events` | Package-local names the Host forwards to and from a third-party backend | When the backend's public methods or events change (users must consent again) |
| `backend.agentTools` | Tools agents may call through the core MCP server, each forwarded to one declared method | When any tool changes (users must consent again) |

`engines.navide` is read as the lowest Navide release the package supports,
the way VS Code reads `engines.vscode`: `^0.2.9`, `~0.2.9`, `>=0.2.9` and a
bare `0.2.9` all mean "Navide 0.2.9 or newer", and `*` means any release. An
upper bound is never enforced, so a package keeps installing on later Navide
releases (a `^0.1.0` package installs on 0.2.x). The Marketplace shows an
extension whose requirement the running Navide does not meet, but disables its
Install, and the Host refuses to install it; a requirement in any other form
is treated as unknown and does not block installation.

A `version` with a SemVer prerelease suffix (`2.5.0-beta.1`) is a
**pre-release**; any other version is **stable**. The Registry's
`latest_version` names the newest stable version (the newest pre-release only
when an extension has no stable version at all), and Navide offers a
pre-release as an install or update candidate only for an extension whose
"Get pre-releases" switch the user turned on. Build metadata (`+build.1`) does
not change the channel and is ignored for ordering.

### Manifest field reference

Every field the schema accepts at the top level and in `permissions`,
`contributes.views[]` and `backend`. **Required** means required whenever its
parent object is present. Where the schema fixes the values, **Allowed values**
lists all of them. `tests/infrastructure/pluginDocsManifest.test.ts` compares
this table with the schema, so a schema change fails CI until this table
matches.

| Field | Required | Allowed values | Notes |
|---|---|---|---|
| `schemaVersion` | yes | `2` | |
| `apiVersion` | yes | X.Y.Z, optionally prefixed with ^ or ~ | Public SDK and capability range |
| `id` | yes | Lowercase dotted id such as acme.files | |
| `name` | yes | 1–80 characters of plain text | |
| `version` | yes | SemVer 2.0.0 | |
| `publisher` | yes | Lowercase publisher id | |
| `engines` | no | Object with a required navide requirement | See `engines.navide` above |
| `permissions` | yes | Object; may be empty | Must be empty in an Extension Pack |
| `marketplace` | yes | Object with a required description and license | |
| `contributes` | no | Object with a required views array (1–16 views) | At least one of `contributes`, `backend` or `extensionPack` |
| `backend` | no | Object | See [Backend source, development, and publish contract](#backend-source-development-and-publish-contract) |
| `extensionPack` | no | 1–20 member plugin ids | See [Extension Packs](#extension-packs) |
| `permissions.system` | no | `fs`, `ui`, `aiCli`, `web` | 1–4 unique entries |
| `permissions.shell` | no | `allowlist`, `full` | Omission denies `shell.run` |
| `permissions.scopes` | no | Object with a required fs entry | Disclosure only, see below |
| `contributes.views[].id` | yes | Lowercase view id | |
| `contributes.views[].kind` | yes | `custom` | |
| `contributes.views[].location` | yes | `top`, `bottom`, `right`, `left`, `main`, `detail`, `window` | |
| `contributes.views[].title` | yes | 1–80 characters of plain text | |
| `contributes.views[].icon` | no | Package-relative path | |
| `contributes.views[].entry` | yes | Package-relative .html path | |
| `contributes.views[].detailView` | no | Id of a detail view in the same package | Only on a `left` view |
| `contributes.views[].targetSchema` | no | Package-relative .json path | Only on a `detail` view |
| `contributes.views[].receives` | no | Object | Only on a `window` view, see [Composed View Contracts](#composed-view-contracts) |
| `backend.entry` | yes | Package-relative executable path; script and source filenames are rejected | |
| `backend.protocolVersion` | yes | `1` | Navide Backend Wire v1 |
| `backend.activation` | yes | `startup` | |
| `backend.methods` | no | Up to 64 unique dotted names | The Host forwards only declared names |
| `backend.events` | no | Up to 32 unique dotted names | The Host forwards only declared names |
| `backend.agentTools` | no | 1 or more tool objects | See [Agent tools](#agent-tools-backendagenttools) |

### Extension Packs

A package whose manifest declares `extensionPack` is an **Extension Pack**: a
list of 1–20 other package ids installed together.

```json
{
  "schemaVersion": 2,
  "apiVersion": "^1.0.0",
  "id": "acme.web-dev-pack",
  "name": "Web Dev Pack",
  "version": "1.0.0",
  "publisher": "acme",
  "permissions": {},
  "marketplace": { "description": "Three extensions for web work.", "license": "MIT" },
  "extensionPack": ["acme.hello", "acme.lint-guard", "acme.notes"]
}
```

- A pack declares no `contributes`, no `backend` and empty `permissions`; it
  cannot grant anything. Each member is downloaded, verified and confirmed on
  its own, with the member's own permissions.
- A pack may not list itself, and a member may not itself be a pack: the
  Registry refuses such a publish (which also rules out cycles), and Navide
  refuses such a member at install time.
- Navide first shows a summary of the whole pack, then one confirmation per
  member with **Skip this one** and **Cancel pack**. Members missing from the
  Registry, not built for the platform or needing a newer Navide are skipped.
  Members installed before a cancel stay installed.
- Uninstalling a pack removes only the pack by default; Navide lists the
  members that were installed only because of that pack so the user can tick
  any to remove as well.
- The Registry lists every pack under the `extension-packs` category.

`permissions` contains one coarse `system` namespace array and an optional
`shell` mode. Each key appears at most once because duplicate JSON object keys
are rejected before schema validation. The manifest never declares scope: the
capability catalog assigns scope to each catalog entry, and the Host derives
the runtime workspace, plugin, and view identity from its authenticated
binding.

The top-level `name` is the display name; it is plain display text with 1–80
Unicode code points and no newlines or angle brackets.

`marketplace` is required for every v2 package and is covered by the package
signature. It is the only source of author-controlled listing metadata:

| Field | Requirement |
|---|---|
| `description` | Required plain text, 1–280 characters |
| `license` | Required SPDX expression, 1–100 characters |
| `repository` | Optional HTTPS source repository URL |
| `homepage` | Optional HTTPS project URL |
| `categories` | Optional; at most five unique lowercase slugs |
| `icon` | Optional safe package-relative path; the packaged file must exist |

The v2 manifest does not define a second `displayName`. The registry keeps the
immutable metadata snapshot for every version and presents
the latest non-yanked version. Yanking that version falls back to the previous
non-yanked version. Publisher identity comes from the verified package and
authenticated namespace, never from a marketplace field.

Views activate when the Host opens their contribution. There is no top-level
`activationEvents` field in v2. A backend-only plugin is valid and activates at
startup:

```json
{
  "schemaVersion": 2,
  "apiVersion": "^1.0.0",
  "id": "acme.skills",
  "name": "Skills",
  "version": "1.0.0",
  "publisher": "acme",
  "permissions": {},
  "marketplace": {
    "description": "Provide reusable skills to Navide agents.",
    "license": "MIT",
    "categories": ["developer-tools"]
  },
  "backend": {
    "entry": "backend/acme-skills",
    "protocolVersion": 1,
    "activation": "startup"
  }
}
```

Manifest v2 rejects `requires`, `activationEvents`, and
`contributes.commands`. The migration adapter maps legacy `onStartup` to
backend startup and `onView:*` to view contributions. Commands and
`onCommand:*` are not public until a separate command contract is specified.

All entries are package-relative regular files. Absolute paths, empty, `.`, or
`..` segments, Windows backslashes, symlink escapes, and shell command strings
are rejected. Unknown
fields, unknown permissions, duplicate JSON object keys, and unknown view kinds
fail closed. Manifest v2 initially supports only `custom` views.
`tree`/`provider` is deferred until its provider registration, item shape,
pagination, cancellation, error, and lifecycle Interface is published.

### Composed View Contracts

> Provisional. These fields are implemented and enforced by the Host, but the
> composition contract is still being stabilised; treat them as an evolving
> Interface rather than a frozen one.

A `detail` view is the region a receiver fills with plugin-rendered detail
pages. It never opens on its own: the Host mounts it only when the receiver
that owns it accepts a detail request. Three manifest fields wire the
composition, and each is valid for exactly one location:

| Field | Valid on | Meaning |
|---|---|---|
| `detailView` | `left` | Id of the `detail` view in the same package that presents this surface's detail pages |
| `targetSchema` | `detail` | Package-relative `.json` path describing the payload this detail view accepts |
| `receives` | `window` | Declares this window as a composition receiver |

```json
{
  "contributes": {
    "views": [
      { "id": "left", "kind": "custom", "location": "left", "title": "Changes",
        "entry": "frontend/left/index.html", "detailView": "detail" },
      { "id": "detail", "kind": "custom", "location": "detail", "title": "Change",
        "entry": "frontend/detail/index.html", "targetSchema": "schemas/target.json" },
      { "id": "window", "kind": "custom", "location": "window", "title": "Workspace",
        "entry": "frontend/window/index.html",
        "receives": { "protocolVersion": 1, "locations": ["left", "detail"],
                      "closeGuard": { "protocolVersion": 1 } } }
    ]
  }
}
```

`detailView` must reference a `detail` view declared in the same package. A
left surface without `detailView` has no detail region, so the Host refuses its
detail requests instead of silently dropping them. `receives.locations` lists
the source locations this receiver serves (`left` and/or `detail`, at most two,
unique); `receives.editorTargets` additionally lets the receiver accept opens
of host editor targets, and `receives.closeGuard` makes it part of the close
transaction:

The Host asks a guarded receiver before it destroys a window. The receiver
answers busy, accepts, or cancels; an accepted close is committed only after
every other receiver and provider in the same transaction accepts, so a refusal
or an unanswered request keeps the window, its views, and their uncommitted
state alive. Close, reload, and quit share a per-window preparation lock; a
refused, timed-out, or failed request reports a refusal and releases that lock
without committing a second close. Each block carries `protocolVersion: 1`
and is frozen until a later profile is published.

Declaring a contract is not registering it. A `receives` declaration without
the corresponding runtime registration fails closed: the Host refuses requests
to that surface instead of routing them to an unguarded view. The same applies
to `editorTargets` and `closeGuard` — a receiver that declares but does not
register is unavailable for that capability, never implicitly trusted.

## Agent Execution Policy

The Host has one global, agent-oriented Execution Policy. It is separate from
Manifest `permissions`, package-version Plugin Grants, and direct user actions;
it is not a per-plugin permission document. The normative v1 schema is
[`execution-policy-v1.schema.json`](../plugin-contracts/execution-policy-v1.schema.json).

The policy has exactly these fields:

```json
{
  "schemaVersion": 1,
  "mode": "allowlist",
  "system": ["fs", "ui", "aiCli"],
  "shell": ["git", "gh", "glab"]
}
```

`mode` is exactly `full`, `allowlist`, or `denylist`. `system` contains only
first-level public namespaces (`fs`, `ui`, `aiCli`, and `web`). `shell` contains exact
top-level executable names, not command strings or paths. The normative JSON
Schema describes the canonical persisted spelling
`[a-z0-9][a-z0-9._+-]*`. The contract parser also accepts ASCII uppercase
letters in input, canonicalizing them to lowercase before duplicate detection
and persistence, so `git` and `GIT` are the same entry.
Agent shell enforcement compares parsed top-level executable tokens
case-insensitively, so `GIT status` is evaluated against the `git` entry in
both allowlist and denylist modes. Entries are unique.
`full` is represented by the same shape with both arrays empty:

```json
{
  "schemaVersion": 1,
  "mode": "full",
  "system": [],
  "shell": []
}
```

The initial Host default is `allowlist` with every system namespace (`fs`,
`ui`, `aiCli`, and `web`) and only `git`, `gh`, and `glab` in `shell`. Wrappers and interpreters are not in
that default. A user policy replaces the single global default and persists at
`<userData>/execution-policy/policy.json`. The Host-owned companion
`<userData>/execution-policy/revision.json` stores the durable revision
high-water mark. A valid policy is accepted only when its `revision` exactly
matches that high-water mark; a missing or corrupt policy therefore cannot
silently roll the effective revision backward. A missing sidecar is a legacy
migration case: only a strict-valid, owner-safe `policy.json` can bootstrap it
at the existing revision, without incrementing; bootstrap is serialized by
exclusive creation, idempotent for parallel readers, and must succeed before
the legacy policy is returned. If an existing sidecar is corrupt or unsafe,
the Host fails closed at the store instance's trusted revision floor, never
reconstructs that floor from `policy.json`, and rejects ordinary set/reset
writes. A strict-valid sidecar below the instance floor is treated as rollback
or inconsistent state: reads fail closed at the floor, while a valid set/reset
may repair it at the next revision. The directory and both files are owner-only
(`0700` and `0600`). Valid updates use same-directory temporary files and
atomic replacement, writing the high-water mark before the policy so an
interrupted update fails closed at the newer revision. Unknown versions,
fields, namespaces, modes, duplicate keys or entries, oversized state, and
unsafe executable spellings fail closed. Corrupt policy or inconsistent
state with a trusted sidecar can be repaired by a valid set/reset; corrupt or
unsafe sidecars and unsafe filesystem entries such as symlinks or non-regular
files remain preserved for explicit recovery or manual cleanup. On read, the
Host repairs an existing policy directory whose mode has drifted from `0700`
before loading its files; a missing directory remains the normal missing-state
path. If the directory cannot be inspected or safely repaired, the store treats
it as unavailable, fails closed, and leaves recovery to explicit or manual
handling rather than interpreting it as a corrupt revision sidecar.

The global-policy portion of Issue 23A defines the durable contract and Host
persistence seam. Repository source selection, UI/IPC exposure, and runtime
enforcement are specified by the relevant follow-up issues; this contract does
not add rules for plugins, Plans, Git, miniIDE, methods, paths, subcommands,
arguments, globs, or regular expressions.

## Repository Policy Recommendations

A repository may provide one untrusted recommendation at the Host-defined
canonical path `.navide/execution-policy.json`. The document uses the same
strict versioned Execution Policy contract as the Host default and global user
setting. Unknown fields or versions, duplicate JSON keys or entries, invalid
modes or namespaces, unsafe executable spellings, oversized files, symlinks,
and non-regular files are invalid and never broaden authority.

Opening a repository only makes its recommendation inspectable. It never
selects the recommendation automatically. Without a per-repository selection,
the Host preserves the existing global default or user policy behavior. An
explicit Host selection chooses exactly one source: the Navide default, the
global user setting, or the repository recommendation. Sources replace one
another; they are not merged with each other, Manifest permissions, or Plugin
Grants.

The Host stores per-repository source selections and the accepted repository
document fingerprint in its owner-only user-data state at
`<userData>/execution-policy/sources.json`, with the companion
`sources-revision.json`. Selection changes use the same durable effective
policy revision as the global policy store and persist across application
restarts. The repository document is never rewritten or deleted by source
selection or by switching back to the default or user source.

The accepted fingerprint is calculated from the parser's canonical policy
representation, including normalized shell names and set-stable system and
shell entries, rather than raw file bytes. Formatting, JSON key ordering, and
equivalent entry ordering therefore do not require re-acceptance. A missing or
temporarily unavailable document resolves to an unavailable source, while an
invalid, unsupported, duplicate-key, or unsafe document resolves to a corrupt
source. A changed valid document makes a previously accepted repository source
stale. In each case the Host preserves the durable selection, leaves the
repository source inactive, and returns the empty fail-closed policy; it never
silently rewrites the selection to default or user.

To accept a repository recommendation, the Host caller must provide the
fingerprint returned by its inspection of the recommendation. The Host
re-reads the canonical document and refuses the selection with
`recommendation-stale` when the current valid fingerprint differs, without
writing source state or advancing the effective policy revision. The caller
must inspect the current recommendation again before explicitly accepting it;
the Host never accepts repository content that was not bound to the caller's
inspected fingerprint.

A recommendation using `full` additionally requires the caller's explicit
`highRiskConfirmed: true` acknowledgement. The Host checks it against the same
validated recommendation before writing a selection or advancing its revision;
otherwise it returns `high-risk-confirmation-required`. Settings resets this
acknowledgement when the workspace or inspected fingerprint changes.

The Host source snapshot distinguishes `selectedSource` (the last explicit
per-workspace choice) from `activeSource` (the source that actually supplied
the policy) and reports `active`, `stale`, `unavailable`, or `corrupt` status.
No explicit choice is represented by a null `selectedSource` and follows the
global user/default policy without creating source state. Expected source
operation refusals are typed and do not write state or advance the revision;
an explicit `user` selection requires a strict-valid global user policy. If no
such policy exists, a new selection is refused with
`user-policy-unavailable`; an existing user pin remains selected but becomes
`activeSource: null`, `status: unavailable`, and fail-closed. A malformed,
owner-unsafe, or metadata-corrupt global policy instead reports a
`status: corrupt` snapshot and never falls back to the Host default. Querying
never rewrites the pin; recovery requires restoring the global user policy or
explicitly selecting the `default` source. This does not affect an implicit
workspace with no selection, which continues to use the Host default when no
user policy exists.
An explicit Host-only full reset can clear all source selections when the
durable source high-water mark is trustworthy. The snapshot also exposes
opaque revision-aware `effectivePolicyKey` and canonical-policy
`effectivePolicyHash` identities for later Host consumers; Issue 23B does not
implement caching or enforcement. This Host source service is intentionally
not exposed through preload, IPC, renderer APIs, or Settings UI in Issue 23B;
those surfaces belong to Issue 23D.

### Runtime enforcement

The Host authenticates `user` and `agent` initiators independently from every
plugin payload. Direct user actions use the Host-owned `user` identity. An
MCP-routed agent request receives a Host-minted `agent` identity that survives
the MCP handoff, package-local Backend Wire call, and any Host capability call;
the package cannot add, remove, or replace it.

Only the `agent` initiator is evaluated against the global Execution Policy.
Manifest permissions, the capability catalog, the explicit package-version
Grant, publisher eligibility, request schemas, workspace binding, and runtime
state remain mandatory for both initiators. `full` mode bypasses only the
agent-specific namespace and executable filters. `allowlist` and `denylist`
operate on first-level `fs`, `ui`, `aiCli`, and `web` namespaces and on every resolved
top-level executable in a shell pipeline or command chain. Policy v1 does not
express subcommands, arguments, path patterns, or wrappers. The v1 shell parser
fails closed on unquoted grouping or negation syntax (`(`, `)`, `{`, `}`, `!`)
and assignment-prefixed commands (`NAME=value`); this applies to both direct
user and agent shell execution, so quote these characters or assignment-shaped
arguments when they are intended as command data. For the private Backend
Bridge, the `filesystem` port maps to the `fs` Execution Policy namespace, the
`shell` port is judged on its command, and the `web` port maps to `web`. `web`
is never admitted by omission: a `denylist` does not admit it, only `full` or
an `allowlist` that names it. All other current Bridge ports fail closed for agent Initiators until
an explicit namespace mapping is assigned; user Initiators continue through
their existing checks.

When a queued operation is held across a policy revision, the Host re-evaluates
it immediately before dispatch. An operation already dispatched keeps the
decision made for that dispatch; completed effects are not reversible. An
exact package-version Grant revocation marks that package version stopping
before draining it, rejects new work, settles pending calls and subscriptions
once with `PLUGIN_STOPPING`, stops its event routes, disables and closes its
views, and gracefully closes its child backend before the bounded force-kill
fallback. Other package versions remain independent. Factory and Official
Registry packages use these same checks and have no bypass.

### Settings and Navide Plugins surface

Settings exposes Execution Policy in its own tab. The Host default is
read-only; the user can create or edit one global user policy in `full`,
`allowlist`, or `denylist` mode. Allowlist and denylist editing has separate
first-level `system` namespace and top-level `shell` executable controls. Full
mode explains that arbitrary executables, including high-risk tools, are
allowed and cannot be saved without an explicit high-risk confirmation.

For an open workspace, Settings shows the currently effective source and the
repository recommendation as untrusted proposed configuration. Selecting the
Host default, user policy, or a valid repository recommendation is explicit;
repository acceptance is bound to the inspected canonical fingerprint. The
Host never merges sources or silently changes an unavailable selection to a
broader source. Selecting the Host default is the source-level reset; resetting
the user policy is a separate operation.

If durable global policy state is corrupt, Settings offers a separately
confirmed rebuild that removes and recreates only the Host-owned `policy.json`
and `revision.json` pair from the Host default. Workspace source selections,
`sources.json`, `sources-revision.json`, and repository policy files are
preserved. An unsafe or unavailable policy directory is reported as a manual
remediation case and never treated as permission to delete files.

Navide Plugins displays the selected agent's effective Execution Policy next to
the installed package inventory. Each v2 package separately reports its
Manifest Permissions and exact package-version Grant state, including when no
matching Grant exists. Neither display is presented as replacing the other;
policy validation, broker denials, and recovery failures remain fail-closed
and are surfaced with safe messages.

## SDK interface

Navide does not call an activation function. Each view's entry HTML loads its
own script, and that script gets the Host-backed runtime from three SDK
factories. This is how the bundled `navide.git`, `navide.plans` and
`navide.mini-ide` views are written:

```ts
import {
  createPluginBackendClient,
  createPluginCapabilityClient,
  createPluginViewRuntimeClient,
} from '@navide/plugin-sdk'

declare function mountApp(): void // your view's own render code

const runtime = createPluginViewRuntimeClient()
const context = createPluginCapabilityClient() // { capabilities, events }

mountApp()      // render the view
runtime.ready() // readiness handshake, see below

const file = await context.capabilities.invoke('fs.readFile', { path: 'README.md' })
```

| Factory | Provides |
|---|---|
| `createPluginCapabilityClient()` | `capabilities.invoke(method, params)` and `events.subscribe(event, listener)` for the public catalog |
| `createPluginViewRuntimeClient()` | `ready()`, `hide()`, `onOpenTarget`, `onBackendStatus`, `openContributionWindow`, and the composed-view receiver, detail and close methods |
| `createPluginBackendClient()` | `call` and `subscribe` for the package's own backend (see [Navide Backend Wire v1](#navide-backend-wire-v1)) |

`@navide/plugin-sdk` and `@navide/plugin-contracts` declare
`"sideEffects": false`, so a bundler keeps only the exports a view uses. The
view runtime client is one object, though: using any of its methods keeps all
of them in the bundle, including addresses such as `ui.openPluginWindow` that
the Registry scan then reports as used. A view that needs only some of the
stateless methods can import them as standalone functions instead; each does
exactly what the client method of the same row does, and the client itself is
unchanged:

| Standalone function | Same as |
|---|---|
| `viewReady()` | `createPluginViewRuntimeClient().ready()` |
| `hideView()` | `createPluginViewRuntimeClient().hide()` |
| `onOpenTarget(listener)` | `createPluginViewRuntimeClient().onOpenTarget(listener)` |
| `onBackendStatus(listener)` | `createPluginViewRuntimeClient().onBackendStatus(listener)` |
| `openContributionWindow(params)` | `createPluginViewRuntimeClient().openContributionWindow(params)` |

The receiver, detail and close methods exist only on the client.

Every view must call `ready()` once it has mounted. The Host waits 10 seconds
after the entry document finishes loading. During install and update preflight
a view that has not reported ready fails the package; in a running view the
Host reloads the view once and does not retry again.

The SDK also exports the `PluginContext` type and `definePlugin(activate)`.
`definePlugin` only returns a frozen `{ activate }` object; nothing in Navide
calls `activate`, so code inside it never runs in the app. The Host does not
supply the full `PluginContext` (`pluginId`, `instanceId`, `workspaceId`,
`startupDeadlineMs`, `lifecycle`, `view`, `appearance`, `credentials`, `ui`,
`targets`); only its `capabilities` and `events` members exist at runtime,
through `createPluginCapabilityClient()`. The examples in this document written
as `context.capabilities.invoke(...)` use that object.

`window.nav` is the private preload transport used by the SDK. Its channels,
payload wrappers, and bootstrap mechanics are not public API. Plugin code must
not call it directly. The one exception is the `navide-plugin init` scaffold:
having no build step to bundle the SDK, its `main.js` calls `window.nav.ready()`,
which is all `createPluginViewRuntimeClient().ready()` does.

## Capabilities and permissions

The normative method/event catalog is
[`capabilities-v1.json`](../plugin-contracts/capabilities-v1.json). Every entry
defines its address, request/result or event schema, required permission,
scope, visibility, and possible public errors.

Manifest v2 uses one coarse system namespace array and one shell mode:

```json
{
  "permissions": {
    "system": ["fs", "ui", "aiCli"],
    "shell": "allowlist"
  }
}
```

`system` accepts only `fs`, `ui`, `aiCli`, and `web`. It is not a map of methods or
read/write accesses: declaring `fs` allows catalog validation to consider the
filesystem methods, but does not bypass method schemas, scope checks, or Host
policy. `shell` accepts only `allowlist` or `full`; omission denies
`shell.run`. Storage, `git`, `terminal`, raw PTY, and arbitrary process access
are not Manifest v2 permissions.

| Namespace/address | Catalog methods/events | Scope |
|---|---|---|
| `system:fs` | `fs.readFile`, `fs.listDirectory`, `fs.glob`, `fs.stat`, `workspace.filesChanged` | `workspace` |
| `system:ui` | `ui.openInEditor` | `workspace` |
| `system:ui` | `ui.openExternal` | `plugin` (HTTP/HTTPS web links; Host user-gesture gate) |
| `system:aiCli` | `aiCli.listProfiles`, `startSession`, `resumeSession`, `cancelStart`, `reattachSession`, `sendInput`, `resizeSession`, `redrawSession`, `interruptSession`, `stopSession`, `output`, `exited` | `workspace` |
| `system:web` | `web.list`, `create`, `attach`, `detach`, `navigate`, `setOwner`, `takeControl`, `returnControl`, `close`, `capture`, `clearData`, `changed` | `plugin` (see [Plugin browser views](#plugin-browser-views-web)) |
| `shell` | `shell.run` | `workspace` |

**`shell.run` output size.** The Host shell broker returns at most 8000
characters of `stdout` and of `stderr` each; the rest is not returned. This
limit is unchanged. Since 0.2.25 the result says when that happened:

- `truncated` and `stdoutBytes` are present on every result. `truncated` is
  `true` when `stdout` or `stderr` was cut, and `false` when both fit in 8000
  characters.
- `stdoutBytes` is the size in UTF-8 bytes of the whole `stdout` text before
  the cut. `stderrBytes` is the same for `stderr`, present only when `stderr`
  was cut.
- That text is the output **after** the broker decoded it as UTF-8 with
  invalid bytes replaced (U+FFFD, 3 bytes each) and, for `gh` and `glab`,
  after credentials were redacted. It is not the raw byte count of what the
  command wrote: 8001 raw `0xFF` bytes give `stdoutBytes: 24003`. On the
  legacy `terminal.run` branch (Manifest v1, `output` only) `stderr` is merged
  into `stdout`, so its `stdoutBytes` counts both.
- The two units differ on purpose: what is kept is the first 8000
  **characters** (Unicode code points), while the sizes are UTF-8 **bytes**.
  For example 8001 `é` come back as 8000 `é`, with `truncated: true` and
  `stdoutBytes: 16002`.
- To compare a size with what you received, measure the received string with
  `new TextEncoder().encode(stdout).length`, not with `stdout.length`.
  JavaScript's `.length` counts UTF-16 code units: for 8001 emoji (such as
  `😀`), the 8000 kept give `stdout.length` 16000, while `stdoutBytes` is
  32004.

`exitCode`, `stdout` and `stderr` are exactly what they were before. A plugin
that needs the whole output asks for less at a time (for example `git log -n`,
a path filter). Whether the limit is lifted is the user's decision and not part
of this change.

The table shows representative entries; `capabilities-v1.json` lists all of
them (for example `fs.writeFile`, `fs.rename` and many more `ui.*` and
`shell.*` methods). Entries marked with an `eligibility` requirement there,
such as the Git account and share methods, are limited to first-party
packages.

`workspace` is a resource boundary, not raw workspace filesystem access. The
Host derives `workspaceId` from authenticated runtime binding. There is no
public `runtime` scope. Workspace events also require a Host-authenticated
event source for the same workspace; an unbound shared event is dropped.

### Plugin browser views (`web`)

Declaring `web` lets a package open real web pages inside Navide: browser
views the Host creates, owns and draws over the package's own view. The
package UI and the package's native backend share the same views, so a user
and an agent can work in one page and hand it back and forth. The request
contract lives in `src/main/plugins/webCapability.ts`; the catalog entries are
in `capabilities-v1.json`.

**Disclosure.** `web` is disclosed at risk level **high** (reason
`system.web`, summary clause `web`): the package can open and browse any
website, the sites' sign-ins are kept on this computer, an agent driving the
package uses the user's sign-ins in it (it can send requests on websites as the
user) and can read every page the package opened and its signed-in state, and
agent script already running in a page stops only when the page is reloaded
after the user takes over. All of a package's views share one partition, so an
agent's Space is signed in wherever the user signed in.
`web` is in the sensitive set (`SENSITIVE_CAPABILITIES`), so installing asks
for the second confirmation.

**Agent Execution Policy.** An agent-initiated `web` call (a view capability
or the `web` Bridge port) is admitted only in `full` mode or by an `allowlist`
that names `web`. A `denylist` never admits `web`, because a denylist written
before the namespace existed would otherwise allow it by omission. The Host
default allowlist includes `web`; a saved allowlist that predates it does not,
so such a user's agents are refused until they add `web`. Direct user actions
are not filtered.

#### View capabilities

Every address is `plugin`-scoped: the views and their browser data belong to
the package, not to a workspace. Addresses marked with a gesture are refused
with `USER_CANCELLED` unless the Host observed the user gesture itself, so an
agent or a backend can never perform them.

| Address | Request → result | Rule |
|---|---|---|
| `web.list` | `{}` → `{views: WebViewInfo[]}` | Every view of this package |
| `web.create` | `{space, url?}` → `{viewId}` | User gesture. `owner` and `control` start as `user` |
| `web.attach` | `{viewId, rect: {x, y, width, height}}` → `{ok}` | Draws the view over the caller's own view at `rect`, in coordinates relative to that view; one attached view per caller at a time |
| `web.detach` | `{viewId}` → `{ok}` | Takes the view off screen; it keeps running |
| `web.navigate` | `{viewId, url?, action?}` → `{ok}` | Exactly one of `url` or `action` (`back`, `forward`, `reload`, `stop`). A user action: on an agent-owned view, `control` passes to `user` |
| `web.setOwner` | `{viewId, owner: "agent" \| "user"}` → `{ok}` | User gesture; hands a space to an agent or takes it back |
| `web.takeControl` | `{viewId}` → `{ok}` | User gesture; an agent-owned view passes to the user, reason `manual_takeover` |
| `web.returnControl` | `{viewId}` → `{ok}` | User gesture; `control` goes back to `agent` |
| `web.close` | `{viewId}` → `{ok}` | Destroys the view |
| `web.capture` | `{viewId, maxWidth?}` → `{dataUrl}` | A thumbnail for an overview card; `maxWidth` is an integer from 64 to 2048 |
| `web.clearData` | `{}` → `{ok}` | User gesture; clears every cookie, sign-in, cache, HTTP auth answer and cached host lookup in this package's browser partition |

`space` and `viewId` are non-empty strings of at most 128 characters. A `url`
is accepted only when it is `http:` or `https:` without a user name or
password in it, or exactly `about:blank`, at most 8192 characters; any other
scheme (`javascript:`, `file:`, `data:`, `blob:`, `chrome:`, `devtools:`,
`view-source:`, …) is `INVALID_ARGUMENT`. A `rect` holds finite numbers, `x`
and `y` at least 0, `width` and `height` from 1 to 16384. Unknown fields are
`INVALID_ARGUMENT` everywhere.

The `web.changed` event carries `{views: WebViewInfo[]}` whenever any view of
the package changes. It is delivered only to views of the same package.

<!-- docs-typecheck: skip (shape reference; the SDK does not export WebViewInfo yet) -->
```ts
interface WebViewInfo {
  viewId: string
  space: string
  owner: 'agent' | 'user'      // who the space belongs to
  control: 'agent' | 'user'    // who may drive it right now
  state: 'idle' | 'running' | 'need-action' | 'done'
  note?: string                // the agent's note, for example what it needs
  url: string
  title: string
  loading: boolean
  attached: boolean
  agentScriptSinceLoad: boolean // the agent ran Runtime.evaluate or callFunctionOn
                                // since the main frame last loaded a document
}
```

#### Backend Bridge port `web`

A native backend whose package declares `web` reaches the same views through
the Bridge port `web`. The port maps to the `web` Execution Policy namespace.

Every operation runs for the pane behind the agent call: the pane id and
workspace the Host verified for that call, never an argument. A view created
through the port belongs to that pane in that workspace. Another pane, the same
pane in another workspace, and a caller that is not a pane all get
`INVALID_ARGUMENT` for it, as for an unknown `viewId`, and `list` leaves it out.
A Space the user owns, or one the user handed to agents with `web.setOwner`,
belongs to no pane: every pane sees it, and may drive it while `owner` and
`control` are `agent`. Handing a Space to agents does not pick a pane.

| Operation | Arguments → result | Rule |
|---|---|---|
| `list` | `{}` → `{views}` | A view whose `owner` is `user` is listed with `url` and `title` empty and no `note`: the agent learns that the user's Space exists and who controls it, not what is open in it. `web.list` in the package UI is unredacted |
| `create` | `{space, url?}` → `{viewId}` | `owner` and `control` are `agent`, `state` is `running`; the view runs in the background, unattached and without background throttling |
| `close` | `{viewId}` | Only a view whose `owner` is `agent` |
| `cdp` | `{viewId, method, params?}` → `{result}` | One Chrome DevTools Protocol command (`Domain.method`, at most 128 characters; `params` a plain object) from the Host allowlist (see [Host-enforced boundaries](#host-enforced-boundaries)); any other method is `CAPABILITY_DENIED`. The debugger attaches to that one view only. Refused with `USER_IN_CONTROL` while `owner` or `control` is `user`, with `reason` `user-owned`, `manual_takeover` or `permission` |
| `setState` | `{viewId, state, note?}` | `note` at most 500 characters; `need-action` also sets `control` to `user`, and reloads the page first when `agentScriptSinceLoad` is set |

#### Host-enforced boundaries

These rules are protection against deception, not limits on what an honest
package may do: each one keeps a page, a package or an agent from acting as
someone it is not.

- **One partition per package.** Every view of a package uses the persistent
  partition `persist:navide-web:<pluginId>`. It survives restarts and is
  cleared when the package is removed. Packages never share sign-ins, so one
  package cannot read the sessions another package's user signed in to.
- **The page is only a page.** Guests run sandboxed with context isolation, no
  preload and no Node.js. Only `http(s)` and `about:blank` load; that keeps
  `file:` and Host-internal pages out of a view an agent can read.
  `window.open` loads in the same view instead of opening a new window.
- **CDP is a per-method allowlist.** The Bridge `cdp` operation accepts only
  these methods, which are what the Navide Browser backend uses to read and
  drive a page: `Accessibility.getFullAXTree`, `DOM.focus`, `DOM.getBoxModel`,
  `DOM.resolveNode`, `DOM.scrollIntoViewIfNeeded`,
  `DOMSnapshot.captureSnapshot`, `Input.dispatchKeyEvent`,
  `Input.dispatchMouseEvent`, `Input.insertText`, `Page.captureScreenshot`,
  `Page.getNavigationHistory`, `Page.navigate` (its `url` follows the same
  `http(s)` rule as `web.create`), `Page.navigateToHistoryEntry`,
  `Runtime.callFunctionOn` and `Runtime.evaluate`. Every other method is
  `CAPABILITY_DENIED`. That keeps out the cookie jar (`Network.getCookies`,
  `getAllCookies`, `setCookie`, `clearBrowserCookies`, …, which would hand an
  agent the HttpOnly session tokens of sites the user signed in to), the cache,
  request interception (`Fetch.*`, `Network.setRequestInterception`), scripts
  and bindings that outlive a page (`Page.addScriptToEvaluateOnNewDocument`,
  `Runtime.addBinding`), `DOMStorage`, file chooser paths, the download
  directory and other targets. Script run with `Runtime.evaluate` still acts
  inside the page with the page's own sign-in, as the disclosure says.
- **Permission requests are denied.** Camera, microphone, location,
  notifications and other permission prompts are denied in this first
  version; on an agent-controlled view the `state` becomes `need-action` with
  reason `permission`, so the user sees why the agent stopped. Allowing them
  with disclosure is a later product decision.
- **No device or identity is handed over.** A site that asks for a client
  certificate gets none, a Bluetooth device chooser is cancelled, and HTTP
  authentication prompts are cancelled, instead of Electron's defaults (the
  first certificate in the store, the first device found).
- **The user always wins.** Any keyboard or mouse input from the user on an
  agent-controlled view sets `control` to `user` (reason `manual_takeover`);
  the agent cannot drive the view again until the user returns control. Every
  takeover (input, `web.navigate`, `web.takeControl`, a permission request,
  `need-action`) and `web.setOwner` to `user` also detaches the agent's
  debugger from the view; the agent's next `cdp` after control returns
  attaches it again. Residual risk: script the agent already started in the
  page (for example a timer from `Runtime.evaluate`) keeps running after the
  detach, because the page itself is not reloaded. A new document (a reload
  or another full navigation; not an in-page one) clears it, and the
  disclosure says so. The Host tracks it per view as `agentScriptSinceLoad`:
  set by every `Runtime.evaluate` or `Runtime.callFunctionOn`, cleared by a
  main-frame `did-navigate`. When the agent hands the view over
  (`setState` `need-action`) with the flag set, the Host reloads the page
  first. A takeover by the user (input, `web.takeControl`, a permission
  request) never reloads, so nothing the user typed is lost; while the user
  is in control with the flag set, Navide Browser shows a warning with
  "Reload" (`web.navigate {action: "reload"}`) and "Keep page".
- **Views follow the package.** Disabling or removing the package destroys all
  its views. Closing the package's window does not: views keep running in the
  background until the package closes them.

### Declared filesystem scopes (disclosure only)

A package may also declare which paths it reads or writes:

```json
{
  "permissions": {
    "system": ["fs"],
    "scopes": {
      "fs": {
        "root": "repository",
        "read": ["**/.acme/notes/*", "**/.acme/notes/.history/**"],
        "write": ["**/.acme/notes/*"]
      }
    }
  }
}
```

`scopes` is optional and additive. Its only member is `fs`:

- `root` says what the patterns are relative to: `workspace` (the default) or
  `repository`, the nearest ancestor of the workspace that contains `.git`
  (never above the user's home directory), falling back to the workspace.
- `read` and `write` (at least one) each hold 1-16 unique path patterns.
  Apart from wildcards a pattern follows the package safe-path rule (no leading
  `/`, no `.` or `..` segments, no backslashes, no trailing `/`). `*` matches
  any characters within one segment; `**`, which must be a whole segment,
  matches zero or more segments. A pattern covers only the paths it matches:
  `docs/*` is the entries directly in `docs`, `docs/**` is everything beneath
  it. A path that appears under `read` but not under `write` is read-only.
- An Extension Pack may not declare it.

The declaration is a disclosure, not a grant and not a sandbox. The Host shows
it to the user in Settings → Navide Plugins; it does not change any grant, Bridge
port, broker decision, or `system` namespace check, and nothing confines the
package to the paths it lists. Declare it truthfully and never narrower than
what the package can reach — a package with its own backend can reach anything
its process can.

### Host-managed storage partitions

Manifest v2 exposes durable JSON key/value storage through the public
`storage.get`, `storage.set`, and `storage.delete` methods. Storage is a
Host-managed grant, not a `permissions.system` namespace: a plugin must have a
Host-approved storage grant for its authenticated package version, but must not
declare a new `storage` permission in its manifest.

Current runtime status: the Host writes the storage grant together with the
package-version grant, both for the bundled packages and for a package
installed from a Registry (when **Restart Plugin** activates it), for a
package installed from a file, and for a folder loaded with Settings → Navide
Plugins → Developer Mode once the user consents. A view without such a grant,
for example one loaded through `AGENT_TEAM_PLUGIN_DEV_PATH` in a development
build, cannot open at all. The API below does not expose the first-party storage migration
seam to third-party packages.

The SDK calls accept only a partition class and key; the Host derives the
plugin identity, workspace identity, package version, and storage location
from the authenticated runtime binding:

```ts
import { createPluginCapabilityClient } from '@navide/plugin-sdk'

const context = createPluginCapabilityClient()

await context.capabilities.invoke('storage.set', {
  scope: 'plugin',
  key: 'panel-state',
  value: { collapsed: false },
})

const result = await context.capabilities.invoke('storage.get', {
  scope: 'workspace',
  key: 'filters',
})
if (result.found) console.log(result.value)
```

`storage.get` returns `{ found: true, value }` for a stored value, including a
stored top-level `null`, and `{ found: false, value: null }` when the key is
absent. `storage.set` replaces one value atomically and `storage.delete`
returns whether a value was removed. Requests cannot provide a plugin ID,
workspace ID, package version, partition path, or snapshot tier. Such fields
are rejected rather than treated as hints.

`scope: "plugin"` addresses `(authenticatedPluginId, packageVersion, tier,
key)`. All views using that authenticated plugin/package/tier binding share the
partition; another plugin, package version, or tier does not.
`scope: "workspace"` addresses
`(authenticatedPluginId, packageVersion, tier, authenticatedWorkspaceId, key)`.
Workspace storage requires a current authenticated workspace binding and never
falls back to the plugin partition. Missing or mismatched bindings fail closed
with `WORKSPACE_SCOPE_VIOLATION` or `CAPABILITY_DENIED`.

The Host stores data in its application-data directory with owner-only file
permissions. Each logical `(pluginId, packageVersion, tier)` snapshot is a
separate Host-selected directory containing one `plugin.json` file and one
hashed workspace file per workspace. Renderer/plugin identifiers are never
used as path components. Reads touch only the requested partition file, while
the snapshot quota is the sum of the canonical partition-file byte lengths.

The Host-owned layout is:

```text
<userData>/plugin-storage-v2/<plugin-key>/<package-key>/<tier>/
  plugin.json
  workspaces/<workspace-key>.json
```

`<plugin-key>`, `<package-key>`, and `<workspace-key>` are Host-generated
SHA-256 directory/file components; the raw identities never become paths.
Limits are measured in UTF-8 bytes: keys are at most 256 bytes, one canonical
JSON value is at most 1 MiB, and one package-version/tier snapshot is at most
10 MiB.
A 12 MiB per-partition physical format guard is independent of the current
quota. Exceeding a write-time limit returns the stable
`STORAGE_QUOTA_EXCEEDED` error; an unsuccessful write leaves the prior value
intact. Existing structurally valid data is not rejected merely because a
later policy quota is lower.

Durable means that the Host writes a same-directory temporary file, fsyncs the
file, atomically renames it, and fsyncs the parent directory before reporting
success. Deletes use the corresponding directory fsync. A corrupt partition
is preserved and fails only calls targeting that partition; it does not make
other plugin or workspace partitions unreadable.

Candidate, active, and previous snapshot selectors are Host-owned runtime
metadata and are part of the internal storage identity. A request can select
only the explicitly selected tier whose package version matches the
authenticated binding; equal package versions in two tiers remain separate
storage directories. The selected tier is fixed for the lifetime of a runtime
instance, so lifecycle changes destroy/reopen the instance rather than
silently retargeting it. Plugin code never sees tier, version, or storage
identity.

Package-version upgrades do not automatically carry data forward for ordinary
public packages: a new version starts with its own empty snapshot. The
first-party `navide.git` migration is an explicit Host-owned exception: before
its current package version is promoted, the Host may clone the prior active
Git snapshot into the current candidate, then retain the prior snapshot for
rollback. Plugin code cannot select or read the old tier. Issue 28 still owns
the general Host-only clone, promotion, rollback, retention, and
garbage-collection orchestration. Actual uninstall removes all storage for
that plugin after cleanup succeeds; a later reinstall does not restore the
deleted data.

Raw `ui.settings` remains a first-party legacy surface, not plugin storage.
Theme, language, workbench layout, terminal runtime state, workspace files, and
other domain data are not accessible through this API.

The Host will derive every partition identity from the authenticated runtime
binding. The `scope` argument will only select one of the two permitted
partition classes and will not override identity or authorization.

The Host derives the authorization scope, workspace root, plugin identity, and
view identity from the catalog plus authenticated runtime binding. Plugin
requests cannot supply or override any of those values. Every declared method
must pass catalog/request validation, publisher eligibility where required, the
explicit package-version user grant, and authenticated binding checks before an
execution plan is returned.

First-party identity affects eligibility only. It never grants a namespace,
selects a package version, or bypasses the user grant. Git is not an
independent permission. The Host shell executable allowlist contains the
canonical top-level executables `git`, `gh`, and `glab`; all packages,
including `navide.git`, must still declare `shell: "allowlist"` and pass the
same package-version grant and authenticated binding checks. This is one
shared catalog allowlist: adding `gh` and `glab` for Host-owned GitHub/GitLab
Issue detection also makes those executables available to every package that
already has the generic allowlist grant. The public allowlist accepts only
canonical top-level executable names and a fixed set of built-in tool
families; it does not accept wrappers, path-qualified replacements, aliases,
extensions, credential/auth commands, or unknown external subcommands. Git
configuration and execution overrides such as `-c`, `-C`, `--config-env`,
`--git-dir`, `--work-tree`, `--exec-path`, `--upload-pack`, and
`--receive-pack` are rejected, as are direct execution hooks such as
`submodule foreach`, `bisect run`, and `rebase --exec`. Host-owned Git and
Issues services use a separate trusted argv interface and are not constrained
by this public plugin policy.

This remains a command broker rather than a process sandbox. Permitted Git and
provider commands can still modify repositories, contact remotes, and invoke
repository-controlled behavior such as ordinary Git hooks. Treat
`shell: "allowlist"` as a high-trust grant and request it only when the public
catalog methods are insufficient.

### First-party production Git package (Issue 19)

The removable factory-installed `navide.git` package is the first production consumer of the
Manifest v2 custom-view and Host-owned storage seams. Its `left` contribution
is embedded in the workbench and its `window` contribution is opened in the
dedicated Git window; the Host resolves both from one active package
descriptor/version. The package uses custom views only. It does not add a
tree/provider contribution or a public `git` or `issues` permission namespace.

Repository Git operations remain the existing Host/backend service, reached
through a typed first-party bridge and the Host shell broker. GitHub and GitLab
Issue provider detection and JSON normalization remain Host-owned; their
`gh`/`glab` calls use the same shell allowlist described above. The package
cannot provide an executable, raw command, working directory, environment, or
raw terminal access through this bridge. Its AI CLI dock uses the public
`system.aiCli` semantic contract, including Host-generated session identity,
terminal dimensions, redraw dimensions, and stop force semantics.

The bridge also preserves the existing Git contribution behavior (repository
tabs, change counts, issue dispatch/spawn handoffs, pane focus, account
settings, and Git window targets) while keeping workspace and view identity
Host-owned. Factory acquisition and verified Marketplace acquisition both feed
the same Manifest, catalog, exact-version grant, instance, and capability
runtime; factory provenance is not a permission bypass. Removing Bundled Git
records a durable opt-out, and Extensions provides the explicit restore action.
When the selected, trusted, approved `navide.git` version fails to
load, mount, or report ready, the Host retires that package's v2 instances and
uses the retained legacy renderer for the remainder of the process. Trust,
signature, revocation, grant, and capability denials fail closed and never
trigger the legacy path. An invalid installed package is also not hidden by the
factory or legacy copy. `NAVIDE_GIT_RECOVERY=legacy` remains the explicit operator override.
Issue 19 does not remove the legacy implementation or implement later Skills
migration or marketplace lifecycle work.

### First-party production Plans package

Issue 23E makes `navide.plans` the first combined production package that
consumes the shared agent Execution Policy. One active Manifest v2 package
version supplies both custom Plans contributions (`left` and `window`) and the
self-contained Backend Wire executable. The package imports only the public SDK
and UI packages; the Host selects its exact package/version, grant, workspace
binding, backend methods, events, and private Bridge ports.

MCP integration uses the current core backend architecture introduced by
`4a6cc02a`. The core owns the single server and endpoint, authentication, caller
identity, tool registration lifecycle, and authenticated Host handoff. The
builtin Plans adapter registers its existing `plan_*` tools on that server
before the session manager starts. The production package does not own an MCP
server or a second tool registry: it implements Plans domain operations over
Backend Wire. The flow is agent → core MCP → Plans tool adapter → Host →
packaged Plans backend → Host capability broker. Recovery keeps the same core
MCP entrypoint.

Manual document operations use the package backend through the Host-private
`filesystem` Bridge, which maps to the existing `fs` capability boundary. User
initiated operations are not filtered by the agent Execution Policy. Agent MCP
operations use a Host-owned headless backend binding when the Plans window is
closed. The Host mints the authenticated `agent` Initiator at dispatch time,
checks the package's explicit method allowlist, re-evaluates the workspace
policy, and rejects denied work before the filesystem Bridge can produce a
side effect. Plans has no public `plans` permission.

Plans documents remain workspace files. Filter, sort, and collapse preferences
use the approved workspace storage partition with idempotent migration from
the legacy local preference keys. Backend subscriptions, workspace binding,
timeouts, cancellation, Grant revocation, and crash cleanup remain Host-owned
and settle through the same Backend Wire lifecycle. Host-owned child restart
is not implemented yet: the supervisor's restart path has no caller. Today a
backend failure moves Plans to the legacy recovery adapter, and the user can
retry v2 from the Plans panel at most twice per session. If the
combined package cannot be selected or activated, the retained legacy Plans
adapter remains available without converting or deleting workspace documents.

Plans v2 surfaces and preference writes require completed storage migration and
successful persistence of the active lifecycle record. A lifecycle read,
migration, or lifecycle persistence failure disables v2 activation and enters
recovery. Recovery reads only the lifecycle-selected previous snapshot; corrupt
or unreadable recovery state is reported as unavailable rather than replaced
with an empty snapshot. A genuinely missing migration source retains the
first-install initialization behavior.

Nested repository discovery uses the same deterministic limits in the Host,
core index, and packaged backend: two levels, 50 found roots, 2,000 directory
candidates per directory, and 2,000 candidate probes across the entire walk.
The global budget also stops scans that find no nested repositories. Top-level
Plans directories remain available without a nested scan.

Issues 25 and 26 must reuse this Execution Policy contract, its Policy Sources,
Host-minted Initiators, and the shared Host broker for miniIDE composition.
They must not introduce an IDE-specific policy, permission, or Initiator model.

### Independent plugin windows and editor capability adapters

`ui.openPluginWindow` opens an installed contribution whose declared location
is `window`. The SDK exposes it as
`createPluginViewRuntimeClient().openContributionWindow(...)`. Its closed
arguments are `contributionKey`, optional `path`, `line`, and `grant`.
The contribution key selects a resource; it does not assert caller or target
runtime identity. The Host derives the workspace from the caller binding,
checks its `ui` permission, exact-version Grant and applicable Execution
Policy, and resolves the registered target contribution. A path must be
contained by that workspace or covered by the caller's exact-file selection.
The Host creates a new target-owned selection grant when transferring an
external file. Caller grants, instance identifiers, URLs and raw query maps
are never transferred as authority.

The result is `{ ok: true }` or a structured failure with
`PLUGIN_NOT_INSTALLED` / `PLUGIN_UNAVAILABLE` and a message. An absent or
uninstalled IDE must be reported to the user; it must not silently open the
Host editor or the operating system's default editor. Explicit external-editor
preferences remain separate. Recovery for an installed plugin version is
distinct from treating an uninstalled or disabled plugin as present.
The miniIDE package declares `navide.mini-ide.window`; its complete activation
and parity verification remain part of Issue 26, not implied by this API.

Typed Git methods under `shell` use a Host-fixed Git operation mapping.
`aiCli.generateCommitMessage` retains AI authority. The Git package's public
`@navide/navide-git/composition` export is side-effect-free build-time
composition: consumers inject authority and bundle the surfaces, without an
installed Git plugin or a runtime import of its mount entry.

Issue operations use `shell.issueProvider`, `shell.listIssues`,
`shell.getIssue`, `shell.createIssue`, `shell.commentIssue`, and
`shell.setIssueState`. They reuse the existing provider services. The Host
derives repository containment and the executable policy from the authenticated
Initiator, then checks the actual `git`, `gh`, or `glab` command before each
provider subprocess. Public Issue requests share a 30-second subprocess budget
across repository detection and the provider command, beneath the Host's
35-second request timeout; once that budget expires, no further mutation
command is started. A remote mutation already submitted before a timeout may still
have an unknown outcome and must not be retried blindly. A plugin cannot supply
backend routes or policy fields.
Account operations use the fixed `ui.listGitAccounts`,
`ui.getGitAccountBinding`, `ui.addGitAccount`, `ui.bindGitAccount`, and
`ui.unbindGitAccount` methods. Responses contain masked account summaries;
stored credentials and backend authentication tokens stay with the Host.

Editor read/write metadata, expected-mtime conflicts, search, native pickers,
and review operations use the closed public capability catalog. Review request
IDs are Host-minted and instance-bound, with teardown on cancellation or
instance/backend loss. Selected-file filesystem authority remains exact-file.
External HTML preview separately retains its existing parent-directory
resource-read scope for relative assets and sibling resource URLs; it does
not grant directory listing or sibling writes, and the resource URL never
contains the backend WebSocket authentication token.

### Embedded AI CLI public mapping

`AiCliDock` currently consumes the generic terminal transport. The public
catalog exposes only the Host-mediated AI CLI addresses below:

| Public address | Meaning |
| --- | --- |
| `aiCli.listProfiles` | List the Host-allowlisted profile identifiers and labels |
| `aiCli.startSession` | Start a Host-selected, allowlisted profile |
| `aiCli.resumeSession` | Resume the detached session owned by this package/workspace/view tuple |
| `aiCli.cancelStart` | Cancel a Host-owned start request |
| `aiCli.reattachSession` | Reattach to an already Host-bound session |
| `aiCli.sendInput` | Send input to an owned session |
| `aiCli.resizeSession` | Resize an owned session |
| `aiCli.redrawSession` | Redraw an owned session |
| `aiCli.interruptSession` | Interrupt an owned session |
| `aiCli.stopSession` | Stop an owned session |
| `aiCli.readTerminalView` | Read Host-owned font, last dimensions and serialized history; no PTY/storage identity |
| `aiCli.saveTerminalView` | Save serialized history for an owned session |
| `aiCli.setTerminalFontSize` | Update the existing terminal font owner |
| `aiCli.listMentionTargets` | Project the existing qualified messaging roster for an owned session |
| `aiCli.saveClipboardImage` | Save pasted image bytes through the existing Host image store |
| `aiCli.showTerminalContextMenu` / `aiCli.reportTerminalSelection` | Use the instance's native clipboard menu and selection owner |
| `aiCli.output` / `aiCli.exited` | Directed output and exit events |

`aiCli.startSession` accepts an allowlisted `profileId`, terminal display
dimensions, the existing optional YOLO choice and an opaque start request ID.
Optional `persistView` on start/resume selects Host-owned terminal persistence;
it does not accept a storage key or process identity. `listProfiles` can opt
into `terminalView` presentation metadata and the existing embedded editor
profile set. Shared Git/Plans consumers retain their existing defaults.
The Host derives the command, arguments, working directory,
environment, credentials, workspace, pane metadata, session ID, view instance,
and event audience. Resize and redraw carry validated positive terminal
dimensions, and stop carries an explicit force value; neither permits raw PTY
or process control. Every control call validates the opaque session against
the authenticated plugin, package version, workspace, view instance, and
audience.
Directed output and exit events are delivered only to the authenticated
audience that created or reattached the session.
`shell.run`, raw command/executable/arguments/environment/working-directory
parameters, and PID control have no `aiCli` mapping and must fail closed.
The Host executor also enforces the catalog's `requiresUserGesture` flag for
`ui.openExternal` before opening a URL: the plugin preload records a Host-observed
trusted pointer or key event for its own view, and the broker refuses the address
with `USER_CANCELLED` when the request carries no such gesture from the last five
seconds. Each observed gesture permits only one `ui.openExternal` attempt;
other capability calls do not consume it. Agent- and backend-originated calls
never carry one, so an unattended view cannot hand a URL to the OS browser.
Filesystem calls used by the dock's `@`-file picker remain authorized by
the public `system:fs` catalog; they are not absorbed into the AI CLI
permission.

Terminal presentation persistence is not Plugin Storage. The Host maps the
migrated miniIDE window to the exact legacy miniIDE entry URL and default
Electron partition; other public consumers have contribution/workspace-derived
keys at the Host terminal owner. The Host renderer and legacy miniIDE renderer
remain separate origins. Minimal terminal-only bootstrap branches load no IDE
UI, and the owner stays available without a visible editor/main window.
Only fixed font/dimensions/session/history operations cross that internal
boundary. No package chooses an origin, key, raw PTY or arbitrary method.
The only miniIDE Plugin Storage migration keys remain `ide-sidebar-width`,
`ide-ai-panel-width`, and `agentTeam.search.opts`.

Persisted-session adoption requires backend-owned profile, canonical workspace
and origin metadata, checked before ownership transfer or redraw. The bundled
Mini-IDE also accepts its own pre-migration `editor` origin when recovering a
session; other origins remain excluded. Both sides compare canonical workspace
paths, including when the user opened the workspace through a symlink. Public
output stays text; the Host streams UTF-8 decoding across backend binary
batches. Clipboard images reuse the existing `dropped-files` store and media
types. Embedded terminal native file-drop behavior is not introduced by this
migration: that gesture belongs to the separate Host TerminalPane surface.

`ui.openFilePicker` preserves the embedded terminal's searchable file popup
through a Host-owned picker-only view. Its request contains `query`, untrusted
`candidates`, optional `line`, and an optional owned `sessionId`. A candidate or
a renderer's user Initiator classification does not authorize an external file.
The Host performs lookup internally; the isolated picker returns an opaque row
identifier on actual selection. The public result is only `{ opened: boolean }`.
Neither filesystem lookup results nor a selected-file grant are returned to
the calling package.

The existing direct workspace HTML behavior is separate from external-file
selection: a canonical contained `.html`/`.htm` candidate opens the installed
Plans window's read-only `filepath` preview branch without showing the picker.
That branch uses the receiver's existing `fs.previewResource` authorization
and a sandboxed resource iframe, retaining relative assets. It does not enter
the `rel_path` Plans document model or extend `plans.list`, `plans.read`,
mutation or MCP allowlists. Missing Plans is an explicit error, never a Host
preview implementation or implicit legacy replacement.

The invocation binds the source instance, workspace, optional session, and
picker sender/main frame. Navigation, workspace changes, instance/session
teardown and policy revocation invalidate dispatch. The selected canonical
identity is checked again before the receiving editor obtains an exact-file
grant. No directory/list/write authority follows from picker selection.
`@navide/plugin-ui/file-picker` exports only the popup presentation helper so
the fixed Host renderer can reuse it without loading terminal or IDE code.
Runtime focus, IME, placement and outside-click behavior remain part of the
consolidated manual migration verification.

### Issue 15 runtime boundary

The raw v1 `terminal` PTY namespace is not a Manifest v2 permission and is not
part of the public v2 catalog. Public AI CLI sessions remain Host-mediated
through the `aiCli.*` contract above. The current instance-aware PTY and event
logic is a Host-only integration seam for staged view productionization; no
renderer payload can supply an instance id or capability context, and the
shared backend event listener has no public-event source binding, so v2 events
received there fail closed. A Host producer must call the Host ingress with an
authenticated source: AI CLI output/exit uses the exact per-instance binding,
while `workspace.filesChanged` uses the reserved `host` source identity with
matching workspace and package version. The Host ingress also names the target
package id, so the event reaches eligible views for that exact package id,
version, and workspace; another package sharing the same version and workspace
never receives it.

If a view is torn down while `terminal.create` is still completing, the Host
first sends the generation-scoped create cancellation. If the backend has
already committed and later returns a successful create response, the Host
issues one force-kill for only that response's session id; it never creates a
route for the dead view. A cleanup failure leaves the session unrouted but
still owned by the Host's shared backend connection, so the ownerless-PTY
janitor cannot reclaim it while that connection lives; the PTY is released
when the connection ends and the janitor's grace period elapses.

The v2 ownership table is process-local. Within the same Host process, a view
may reattach only with its full authenticated package-version, workspace,
audience, and instance binding. After a Host app restart, an unknown v2 raw
PTY id is rejected even if the backend PTY process remains alive; durable
reattach requires a future contract covering persistent identity, version,
revocation, expiry, and a backend ownership namespace.

V2 context validation follows the descriptor's canonical package version and
view identity, not the temporary capability-policy adapter. Host-created
instance ids replace any supplied runtime, session, or pending-start instance
ids before the context reaches a running view.

The legacy `open()` entry point is only a lifecycle and plugin-id lookup
adapter. If it receives a descriptor with canonical Manifest v2 identity
(`packageVersion` and `views`), that instance uses v2 event and PTY ownership
rules: unknown reattach ids fail closed and a changed ownership tuple detaches
the route. V1 PTY compatibility applies only to descriptors without v2
identity.

Before install, Navide shows the declared system namespaces and shell mode,
resolves their catalog scope, and asks for an explicit package-version grant.
An update that adds a namespace or changes shell mode remains staged until the
user confirms the delta. Runtime calls are checked against that confirmed
package-version grant; `full` shell additionally requires a separate high-risk
confirmation. There is no package-ID auto-grant.

The legacy `git.changed` event is unusually authorized by `fs`. The v2 public
replacement is `workspace.filesChanged`; third-party code must not subscribe to
the legacy address.

## Errors

All SDK failures reject with `PluginError` containing a stable `code`, a safe
message, and optional structured details:

| Code | Meaning | Author response |
|---|---|---|
| `CAPABILITY_DENIED` | Permission was not granted | Change the manifest or remove the call |
| `METHOD_NOT_FOUND` | Address is unknown for the negotiated API | Check `apiVersion` and spelling |
| `INVALID_ARGUMENT` | Payload failed schema validation | Fix the request |
| `WORKSPACE_SCOPE_VIOLATION` | No workspace is bound, or a path/target escapes it | Use a workspace-bound runtime and a relative target |
| `USER_CANCELLED` | User rejected or cancelled the action | Stop quietly or restore UI state |
| `TIMEOUT` | Host-owned deadline expired | Retry only when safe and user-visible |
| `BACKEND_UNAVAILABLE` | Required Host/backend service is down | Disable the action and offer retry |
| `PLUGIN_STOPPING` | Runtime is draining or restarting | Do not start new work |
| `STORAGE_QUOTA_EXCEEDED` | A storage key, value, or package-version snapshot exceeds its Host limit | Reduce the stored data or remove old keys |
| `RESOURCE_LIMIT` | A Host-owned concurrency or result-size limit was reached | Reduce in-flight calls or request less data, then retry |
| `INTERNAL_ERROR` | Non-actionable Host failure | Log the correlation ID; do not inspect internals |

The v1 broker's `CAP_DENIED`, `UNKNOWN`, `BAD_REQUEST`, and `BACKEND_ERROR`
strings are internal legacy values and are mapped by the compatibility adapter.

### Where to look when something fails

- **A view's console.** Each view runs in its own web contents (a `<webview>`
  guest, or a native `WebContentsView` for `location: "window"`), so
  **View → Toggle Developer Tools** opens the DevTools of Navide's own window,
  not your view's. To read your view's console, turn on **Chrome DevTools
  Protocol** in Settings → MCP → External access, restart Navide, open
  `chrome://inspect` in Chrome, add `127.0.0.1:9223` (or the port you chose)
  under **Configure…**, and inspect the target whose URL is your view's
  `entry`. While it is on, anything on this machine can run code in Navide
  (see [CDP debug](external-mcp-control.md#cdp-debug-escape-hatch)); turn it off
  when you are done.
- **A Host refusal in a view.** The call rejects with a `PluginError` whose
  `code` is in the table above (`CAPABILITY_DENIED` for a capability the
  manifest does not declare or the user did not grant). Navide also records
  every refused call: Settings → Navide Plugins → **Disclosure overview** →
  your Navide plugin → **Activity** lists it as denied, and says when the
  manifest did not declare it.
- **A backend.** Its stderr, start failures and restarts are written to
  Navide's main log, `<userData>/logs/main.log` (on macOS
  `~/Library/Application Support/Agent-Team/logs/main.log`), on lines that start
  with `[plugin-backend]`. A call the backend makes through the Host bridge and
  the Host refuses is answered to the backend with that error code and counted
  in the same **Activity** list. Before installing, `navide-plugin
  dev-backend` prints each bridge call as `← bridge (denied in dev-backend)` and
  the backend's stderr as `[backend]` lines.

## Views and lifecycle

A package may contribute multiple views, and each view may have multiple live
instances across windows and workspaces. Closing one instance must not close
another. Cross-view state belongs in plugin/workspace storage or the plugin's
backend, never in a guessed instance key.

`custom` views render isolated content in a Host-owned `WebContentsView` and
have a package-relative HTML `entry`. The initial v2 contract does not accept
`tree`, `provider`, or another view kind. A future Host-rendered tree is an
additive contract only after authors can implement and test the complete
provider Interface.

An update is downloaded and verified in the background but is not a live code
swap. The update is staged at an immutable target-specific package directory,
receives current trust verification plus restricted frontend and backend
preflight, and is then offered through **Restart Plugin**. Navide drains only that plugin,
atomically selects one complete frontend/backend package version and its
matching storage selection, then restores native view placements from fresh
Host-owned descriptor and Grant data. Navide itself and unrelated plugins do
not restart. An older mutable Registry installation is adopted as the previous
version only after its retained archive, receipt, grant, and current Registry
trust verify; a failed check cannot turn it into an active selection.
Interrupted activation recovery, rollback to a retained previous
package, and retention/garbage collection are separate lifecycle work; a
restart never claims to undo completed external effects.

## Backend trust

A backend plugin is native local code. The first-party Plans backend runs as
an ordinary child process: process isolation limits crash impact but does not
restrict filesystem, network, subprocess, or OS access. A third-party backend
runs only inside the OS sandbox described in
[Third-party backends](#third-party-backends-sandbox-consent-and-publishing).

- Normal mode will run only complete artifacts covered by a Registry envelope
  signature that chains to a Host-pinned Registry root; publisher keys are not
  Client trust roots in v2.
- An Official Registry can claim the reserved `navide.` namespace only when
  the App build provisions an independent Registry root for the exact Official
  Registry URL and the current root-signed profile is `official`. The production
  root is provisioned as `resources/official-registry-root.pem`; a build
  without that file fails the Official Registry path closed. The
  publisher namespace key is never reused as a Registry root.
- A self-hosted Registry must have a durable Host-owned approval that binds its
  URL, root PEM, and a separately confirmed SPKI SHA-256 fingerprint before
  Navide contacts it. A self-hosted root remains a separate verification root;
  even root-signed metadata claiming `registryProfile: "official"` cannot grant
  Official Registry namespace authority. The informational fingerprint
  returned by the Registry is never a trust root.
  The approval document uses the exact fields `schemaVersion`, `registryUrl`,
  `rootPublicKeyPem`, and `confirmedFingerprint`; unknown or duplicate JSON
  fields fail closed. The local development default (`http://localhost:8787`)
  is self-hosted and therefore requires this approval too. Packaged builds
  default to the Official Registry, `https://server.navide.dev/registry`; the
  path is part of its identity, so another path on the same host is not
  official.
- Registry envelope signatures identify the Registry signer key ID. Root-signed
  trust metadata records active,
  rotating, expired, and revoked keys. Rotation has a bounded old/new overlap.
- Yank prevents new installs; revocation also blocks install, update, activation,
  and future backend spawn. A newly revoked running frontend plugin is stopped
  and quarantined; the Electron backend supervisor re-verifies the current
  root-signed trust decision immediately before every child spawn.
- The environment-variable Developer Mode exists only in development builds;
  packaged builds ignore its environment variables (the Settings switch below
  is a separate path). It accepts one explicitly selected local unpacked
  Manifest v1 or Manifest v2 frontend directory only when
  `AGENT_TEAM_PLUGIN_DEV=1` and `AGENT_TEAM_PLUGIN_DEV_PATH` names that exact
  directory. Manifest v1 is a
  bounded local compatibility path: it remains unsigned and local-only, must
  be explicitly selected by the user, and cannot obtain Registry provenance.
  Both versions reject reserved ids and backend contributions and record a
  persistent unsigned/local-only warning. The existing fixed dist-plugins
  bundles remain Host-owned app-development fixtures, not this package
  selection path. Developer Mode packages cannot publish, auto-update, execute
  backend code, or claim Registry provenance.
  Developer Mode also writes no capability grant. The Host opens a Manifest v2
  view only when a grant for that exact package id and version exists, so a
  Developer Mode v2 view is refused ("package-version capability grant is
  missing") unless a Registry install of the same id and version already left
  one behind. To run a v2 package in the app, install it from a file (next
  item) or from a Registry; a local Registry works (see
  [Publishing to the Navide Marketplace](marketplace-publishing.md)).
  Manifest v1 packages need no grant.
- **Developer Mode** (Settings → Navide Plugins → Developer Mode, off by
  default) is a main-process setting. Inside Navide only the main window's
  settings page can change it; every change made there is written to the
  plugin activity log as a Host event (`source: "host"`, `plugin_id: "host"`,
  `developerMode.on` / `.off`), which no plugin row can claim. The switch and
  the folder consents live in `.navide-plugin-developer-mode.json` in the
  plugin install root, which is checked for its shape. Any unsandboxed
  process running as the same user, an agent CLI included, can write that
  file. Since 0.2.28 Navide also keeps
  `.navide-plugin-developer-mode.sig.json` beside it: an HMAC-SHA256 of each
  entry Navide wrote itself (the switch when on, each folder consent), keyed
  by a random key that Electron `safeStorage` encrypts. An entry Navide did
  not write (the switch turned on, a folder added or edited by another
  program) is not applied: the switch stays off until the user turns it on
  on this page (with the usual confirmation), and the folder is listed as
  "Added or edited outside Navide; consent again" and loads only after the
  user consents to it again (Reload opens the consent dialog for the folder
  the entry names). Navide says so in the launch reminder and on this page,
  and writes one Host event `developerMode.externalChange` to the activity
  log when it first sees the change. Nothing is blocked: the other program's
  write is simply not taken as the user's consent. When secure storage
  refuses to sign Navide's own write (keychain access denied or locked), the
  change is still written, unsigned, and reads as "ask again" with its own
  notice; reading the settings never fails over it. Known limits: the check
  runs only after the app is ready and only while secure storage is
  available, so before the app is ready (the self-hosted Registry setting
  can be read then) and on Linux without a keyring, or with the
  `basic_text` password store, entries are taken as they are; a file from
  before 0.2.28, or one whose signature file is missing, is asked about
  again once (the switch reads as off and each folder needs consent); the
  signature covers entries, not their age, so
  restoring an older copy of both files together (for example one taken
  while the switch was on, or before a folder was removed) makes that state
  trusted again without a notice; on Windows and Linux the safeStorage key
  is readable by any process of the same user, so a determined program can
  still forge an entry there; a signature file that cannot be read or
  decrypted (another machine, a new keychain) asks about every entry again. A native backend still needs its
  own consent, and a plugin frame and a plugin's own sandboxed backend cannot
  write either file. Navide Guard grades an agent's write to this file as
  critical where the CLI runs Navide's hooks (rule `plugin-store-write`, with
  the limits listed under the local trust record below). A packaged build ignores `AGENT_TEAM_PLUGIN_DEV` and
  `AGENT_TEAM_PLUGIN_DEV_PATH` either way; with the switch on, **Load from
  folder…** opens the Host's own folder dialog. A folder loads a Manifest v2
  package (not `navide.`, not an id something else installed holds or
  another consented folder claims, and never one the root-signed takedown list
  names by id, id namespace or publisher, checked on every load, reload and
  start; with no list available the dialog says the check could not be done;
  nothing installs an id a developer folder holds until the folder is removed,
  and removing its plugin forgets the folder) with a
  grant for its declared permissions and, when it declares one, its backend
  through the unchanged sandbox, master switch and native backend consent.
  Consent is bound to the folder and the digest of the manifest's
  `permissions` and `backend`: **Reload** after a file edit asks nothing, a
  change to either declaration unloads the package and asks again, and so does
  the next start. Content is not compared, since a developer folder changes all
  the time; the dialog and a banner say so, and every launch reminds the user
  while the switch is on. Anything that can write the folder can change the
  code that runs; the sandbox bounds what it can do. Turning the switch off
  unloads every developer folder. A developer folder's id is only what its
  manifest claims, so its backend data is treated as local: the first load of
  an id sets aside data an earlier package of it kept, removing the folder
  keeps its data recorded as local, and no later install of the id (another
  folder, a file or the Marketplace) takes it over. Kept data is reused only by
  a Registry-verified id (Marketplace or pre-release).
- **Install from a file** (Settings → Navide Plugins → **Install from .vsix
  file…**) works in packaged builds too, without Developer Mode. The main
  process opens its own file dialog over the main window and reads the picked
  file once; every later step uses those bytes, never the path again. Plugin
  frames, agents (MCP) and environment variables cannot start or name a file
  install. The package passes the same ZIP checks as a Registry package (50 MB
  per entry, 200 MB per archive, no symlinks or special files, no unsafe
  paths), the Manifest v2 schema, the backend executable rules and the engine
  check; Manifest v1, extension packs and the `navide.` namespace are refused,
  and so is a publisher or package id on the root-signed takedown list (even an
  expired one). The Host fetches the current list from the Registry first;
  when that fails and no list is stored, the dialog says the takedown check
  could not be done (the next load still applies a list once one arrives). It has no Registry signature and no Navide review or scan, so
  the user always consents in a dialog that shows a fixed warning, the
  self-declared publisher and "not scanned", starts on Cancel and enables its
  consent button only after an explicit acknowledgement. The package is staged
  like a Registry candidate and its grant takes effect on **Restart Plugin**;
  a native backend still asks for its own consent and runs in the same
  sandbox. A file install never updates automatically. Installing a file over
  an installed package of the same id (or a Marketplace version over a file
  install) asks first, and the replacement keeps none of the replaced
  package's permissions: its capability grant and rollback grant, its native
  backend consent, every workspace its backend may change files in, its agent
  tool write approvals and agent tool name priority. The new package cannot
  read the replaced one's view storage either. When the source changes, the
  native backend's private data folder and the package's view storage (every
  version, so a package of the same version on another target never shares
  it) are moved aside (`<name>@set-aside-<source>-<time>` beside them; never
  deleted, never overwritten) so the new package starts empty; the question
  says so, and going back to the Marketplace offers to take that data back,
  off by default (a local file's data is never offered back: its id is only
  what the file claims). A failed move stops the replacement with nothing
  changed; if moving it back fails too, whatever is left in place is set aside
  and the native backend consent is cleared. Removing the package removes what
  was set aside with its storage, and with its backend data when the user
  chooses to delete that. An update within one source keeps both as before.
  Backend data a removal keeps records its source beside the folder
  (`<id>@kept-source.json`, owner-only, outside the backend's sandbox): a
  later install of the same id and source takes it over as before, one of the
  other source finds it set aside instead. Data a local file kept is never
  handed on, not even to another local file claiming the same id, and one
  local file replacing another hands over none either; only a Registry-verified
  id takes kept data over. Deleting or forging the record takes write access to
  the user's data folder, the same exposure as the local trust record. Data kept by a release without the
  record counts as Marketplace data, the only kind that could run a
  third-party backend before file installs existed.
  The package's own name is shown in the native backend consent with every
  line break and invisible character spelled out, below the source line. The takedown check of the Registry trust metadata covers id and
  publisher only; a package renamed to a new id is caught only by the file's
  digest, on the blocked-digest list of the local-install trust document
  (next item). Files extracted from a `.vsix` carry no quarantine
  attribute, the same as a Registry install.
- A package installed from a local file or folder is trusted through a local
  trust record, not the Registry root: the record holds the package id and
  version, the SHA-256 of every file in the installed copy, an overall content
  digest, and the time the user consented. Every load re-hashes the installed
  copy, never the file or folder the user picked, and refuses any added,
  removed, changed, or symlinked file. The Registry authority rule does not
  apply, so local and Marketplace installs never quarantine each other. The
  `navide.` namespace is refused, and the root-signed takedown list
  (`blockedPublishers`, `blockedPackages`) disables a matching local package
  by its manifest id and publisher; without root-signed metadata the takedown
  check is reported as not done. The local trust record is weaker than a
  Registry receipt. A receipt cannot be forged without a Registry signing key,
  but the local record is an unsigned file in the user's data folder: any
  unsandboxed process running as the same user, an agent CLI included, can
  write a record that matches altered content. What the record protects
  against is the installed copy being changed after the user consented; it
  does not protect against other processes of the same user. A plugin's own
  backend (inside its sandbox) and plugin frames cannot write it. It is
  evidence of consent, not a verification by Navide.
- **Blocked digests** (decision d5): the root-signed local-install trust
  document (`GET /api/trust/local-install`) lists the SHA-256 of `.vsix` files
  Navide took down as `blockedDigests: [{digest, reason}]`; a bare digest, sent
  by a Registry before 0.2.27, reads as having no reason, and so does a reason
  this release does not know. A file on the list is refused at install. A file
  install records the digest of its `.vsix` in the local trust record
  (`artifactDigest`), and every load and every trust refresh (at start, then
  every 15 minutes) checks it again, graded by the reason: `security`
  quarantines the copy, tells the user why and lets it be removed but never
  enabled again; `admin`, `qualification-revoked` or no reason asks the user
  once to keep using, disable or remove it; `developer-withdrawn` is only
  labelled. Extensions keeps a label with the reason on each one.
  Limits: a file installed before 0.2.27 that was not signed has no recorded
  digest, so a later block cannot reach it (a signed one is checked through
  the digest in its signature evidence); a developer folder has no `.vsix` and
  is never checked by digest. A record that carries the digest or a signature
  is refused by 0.2.26, so going back to 0.2.26 quarantines those local
  installs; they load again on 0.2.27 or later.
  Navide Guard grades an agent's write to these stores as critical (rule
  `plugin-store-write`, which can be lowered to high but not switched off):
  writing, deleting, moving, linking or changing the mode of the plugin
  install root (`plugins/` in Navide's data folder, Developer Mode folders and
  grants included), the local trust records (`plugin-local-trust/`), the
  native backend consent store, and the kept-source markers and set-aside
  folders beside backend data. A plugin's own backend data is not covered, and
  reading any of these stays as before. This has limits. Guard only sees tool
  calls from CLIs that run Navide's hooks. Shell commands are recognised only
  in the forms Guard parses: redirection (`>`, `>>`, `>|`, `&>`), `tee`, the
  destination of `cp`/`install`/`rsync`/`scp`/`ditto`, `mv`, `ln`, `chmod`,
  `chown`, `touch`, `truncate`, `sed -i`, `xattr -w/-d/-c`, `mkdir`, `rmdir`,
  `unlink`, `rm`, `find -delete`, `dd of=`, the output file of `curl`/`wget`
  and the destination of `git clone`, with bare file names resolved against
  the working directory. Not recognised: a computed path (`"$DIR"`,
  `$(…)`), an interpreter's inline code (`python -c`, `perl -pi`), archive
  extractors (`tar -C`, `unzip -d`), `xargs`, PowerShell cmdlets such as
  `Set-Content`, and a write through a symlink created earlier that points
  into the data folder (paths are compared as written, not resolved). With
  Guard off, agent tool calls are only audited, never blocked; approvals
  sent from a chat relay and text typed into a plain terminal pane are still
  refused for these writes, as for every critical action. The chat relay
  screens a relayed shell command fully but a relayed file-tool prompt only
  for credential paths, so a relayed `Write` into the store is not refused
  there (the existing relay model). It reduces accidental or induced agent
  writes; it does not stop other processes of the same user and does not
  replace a signed consent mechanism.
  Navide's own installs, updates, removals and rollbacks write these files
  from the main process directly and never pass through Guard.
  The installed-package `source` field (`marketplace`, `prerelease`,
  `testplace`, `local-signed`, `local-unsigned`, `developer-unpacked`,
  `factory-bundled`) is reported beside the legacy `provenance` field, which
  keeps its original three values because older Navide releases refuse any
  other.

The package archive signature covers the manifest, frontend, backend, assets,
and their digests. Each OS/architecture artifact is signed independently.

## Compatibility policy

Public packages and `apiVersion` share a major version. A major accepts additive
optional fields, methods, and events only. Navide supports the current and
previous public API major; the previous major remains supported for at least 12
months. Public deprecations are announced for at least 6 months and span at
least two Navide minor releases before removal.

The migration plan's one-minor compatibility window applies only to Navide's
internal v1 loader/adapter. It is not the third-party API support policy.

## Development and publishing flow

Issue 06 supports the following external frontend workflow:

1. Install the three public packages from their SemVer registry ranges.
2. Declare the smallest permissions and run `navide-plugin validate <directory>`.
3. Run the plugin project's `typecheck` and `build` scripts to create a
   frontend-only staging directory.
4. Run `navide-plugin package <directory> --out <file>` and inspect the root
   manifest and explicit frontend/assets file list.
5. Run the outside-workspace smoke test with an in-memory Host adapter. It
   covers one declared capability success and one undeclared capability denial.

Scaffolding, per-target backend packaging, signing, sign-in and publishing
to the Navide Marketplace are covered step by step in
[Publishing to the Navide Marketplace](marketplace-publishing.md).

There is no `navide-plugin dev` command and no in-app hot-reload loop. Test a
backend with `navide-plugin dev-backend`, whose Host bridge refuses every
request, and test the complete package inside Navide by loading its folder
with Settings → Navide Plugins → Developer Mode, installing it from a file, or
installing it from a local Registry; only the environment-variable Developer
Mode of a development build (`AGENT_TEAM_PLUGIN_DEV_PATH`) cannot open a v2
view (see [Backend trust](#backend-trust)).
