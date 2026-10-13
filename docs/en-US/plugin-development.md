# Plugin development guide

> **Current runtime (manifest v1 and v2).** This guide documents the manifest
> v1 runtime. v1 and v2 coexist today: the three bundled packages
> (`navide.git`, `navide.plans`, `navide.mini-ide`) ship as Manifest v2
> packages, and v1 remains only as their recovery path. The public manifest
> v2, SDK, permissions, and compatibility policy are specified separately in the
> [Plugin Developer Spec v2 draft](plugin-development-v2.md). Do not use the v2
> examples until the migration plan marks that contract as implemented.

This guide is about **Navide plugins**, which extend Navide itself, not the
CLI extensions an AI CLI installs for itself. See the [glossary](glossary.md)
for the terms user-facing text must use.

Navide plugins extend the app with new surfaces and new backend behavior. This
guide covers both plugin kinds, the manifest schema, the capability permission
model, and the packaging and signing rules.

For the package archive format alone, see
[`marketplace/registry/FORMAT.md`](../../marketplace/registry/FORMAT.md).

## Status: third-party publishing is open for Manifest v2

Third-party plugins are published to the Navide Marketplace at
`https://server.navide.dev/registry` as **Manifest v2** packages, after a
review. Follow [Publishing to the Navide Marketplace](marketplace-publishing.md)
for the whole workflow, from `navide-plugin init` to a reviewed listing. This
guide's manifest v1 runtime is legacy: the Registry still accepts v1 packages,
but new packages should use v2.

Worth knowing before you invest time:

- **The capability whitelist is centrally maintained.** `requires` accepts only
  the namespaces listed under [Capability reference](#capability-reference); a
  plugin asking for anything else is refused as scope over-reach. Adding a new
  namespace means a change to the host, not something a plugin can declare on
  its own.

**If you want to build a plugin, please get in touch first** — open a thread in
[GitHub Discussions](https://github.com/Navide-dev/Navide/discussions)
(use **Ideas**). Tell us what surface you want to extend and which capabilities
it needs. That is also the route for requesting a new capability namespace. We
would rather shape the API around a real plugin than have you build against
something that is about to move.

## Three trust domains

A plugin travels through three domains, joined by one shared manifest schema and
one capability whitelist:

| Domain | Location | Responsibility |
|---|---|---|
| Marketplace registry | `marketplace/registry/` | Publishing, Ed25519 publisher signatures, trust tiers, discovery |
| Electron main process | `src/main/plugins/` | Loader registry, capability broker, install verification, view lifecycle |
| Python backend host | `backend/agent_team_backend/plugins/` | Module loader, capability façade, backend plugins |

The governing rule is **fail-closed**: signature verification, capability scope,
and archive path safety each reject on failure. Nothing is granted implicitly.

## Two kinds of plugin

**Frontend view plugins** render a UI. They run in a fully sandboxed
`WebContentsView` with `contextIsolation: true`, `nodeIntegration: false`, and
`sandbox: true`. The only host interface they can reach is `window.nav`. Their
manifest declares an `entry` pointing at an HTML file.

**Backend plugins** extend the Python service. They register HTTP routes,
startup and shutdown hooks, or agent spawn transformers. They have no `entry`;
they ship a `backend.py` instead.

A single plugin id may exist in both forms. They are separate plugins in
separate runtimes, not two halves of one thing.

## Quick start: a frontend view plugin

### 1. Create the plugin directory

```
src/renderer/plugins/<name>/
├── index.html      # <div id="app"> plus a module script pointing at mount.ts
├── mount.ts        # mounts your app, then calls window.nav.ready()
└── plugin.json     # source-side reference manifest
```

`mount.ts` must call `window.nav.ready()` once the app is mounted, so the host
knows it can deliver queued open targets:

```ts
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
window.nav.ready()
```

### 2. Add a Vite config

Each plugin is a **separate Vite build**, not an entry in the core renderer
build. Copy `vite.git.config.ts` and change `pluginRoot`, `outDir`, and the
manifest emitted by the `emitManifest()` plugin.

The separate build exists for a specific reason: it lets you alias
`composables/useBackend` to a `capabilityBackend` shim. A single module graph
cannot diverge per entry, so reusing an existing `useBackend`-based UI inside a
plugin requires its own build. The core renderer keeps the real WebSocket
`useBackend`; the plugin build gets a shim that forwards every `send(type,
payload)` through `window.nav.callCapability`.

If you are writing fresh UI that calls `window.nav` directly, you do not need
the shim — but you still need the separate build to produce a loadable plugin
directory.

The `emitManifest()` hook writes `manifest.json` into the output directory at
`closeBundle`, so the build output is itself a valid, loadable plugin
directory.

### Build ownership and portability

A plugin-owned Vite and TypeScript configuration must resolve Navide public
packages (`@navide/plugin-contracts`, `@navide/plugin-sdk`, and
`@navide/plugin-ui`) through normal package resolution. Do not alias them to
repository `packages/*/src` paths, and never alias another plugin's source.
A copied plugin directory must build from its own configuration after its public
framework and third-party dependencies are installed; it must not need the Host
source tree or sibling plugin package metadata.

The App's monorepo build may supply an artifact version and output directory to
a plugin build explicitly. That adapter is App-owned integration only: the
plugin configuration must retain a package-owned manifest fallback for detached
builds. Factory artifacts use the App version required by the Host's exact
artifact lookup; a detached source manifest is not by itself an App factory
artifact.

### 3. Package the build

Keep Marketplace plugin builds independent from the base App build. Validate
and package their output with the public `navide-plugin` CLI, then install them
through the same catalog lifecycle used by other packages. A factory package
may be included in Electron `extraResources` only as an acquisition fallback;
after discovery it must use that same installed Manifest, catalog, grant,
instance, and capability lifecycle. Factory provenance must not bypass trust or
authorization checks.

### 4. Open contributions through the catalog

Do not add package-specific registration code to Electron main. The Host reads
the installed manifest, publishes its contributions in the catalog, and opens
them through the generic placement and capability-context path. First-party
and third-party packages use the same runtime; trust and publisher eligibility
remain independent inputs to that runtime.

### 5. Receive host parameters

The host passes context through the entry URL's query string: `workspace_path`,
`http_url`, and `theme`, plus whatever extra parameters the plugin needs. Read
them from `window.location.search`. Seeding your theme from `?theme=` before
mount avoids a flash of the wrong palette.

## Naming and window titles

A plugin's name is written down in four places, and macOS shows the result side
by side in the Window menu, Mission Control and the Dock. They must agree, or
the same surface appears under three different names in one list.

Pick one **feature name** per plugin — short, `Title-Case`, hyphenated if it has
to be (`Mini-IDE`, `Git`, `Plans`) — and use it everywhere below. It is not
derived from the plugin id: the id is a stable identifier that can never change
(changing it installs a different plugin), the feature name is what users read.

| Layer | Rule | Mini-IDE example |
|---|---|---|
| Manifest `id` | `navide.<kebab>`, permanent | `navide.mini-ide` |
| Manifest `name` | The feature name, verbatim | `Mini-IDE` |
| Manifest `displayName` | Marketplace only: `Navide <feature name>` | `Navide Mini-IDE` |
| Entry `<title>` | The feature name alone — a pre-mount fallback, shown only until the app sets a real title | `Mini-IDE` |
| `document.title` | `<context> — <feature name>`, em dash. No context yet → the feature name alone | `main.ts — Mini-IDE` |
| Host `BrowserWindow` `title` | The feature name alone (see below) | `Mini-IDE` |

`<context>` is whatever identifies *this* window among windows of the same kind:
the open file for the editor, the repository for Git, the workspace for Plans.
Put it first — a truncated Dock entry then still says which one it is. Core
windows follow the same rule (`Agent-Team — Navide`), so plugin windows need no
`Navide` prefix of their own; the menu already sits under the app name.

**A dedicated host window does not pick up your title by itself.** The window
that hosts a plugin view (`ensureMiniIdeWindow`, `ensureGitWindow`) has a blank
webContents — the UI lives in the `WebContentsView`, and its `document.title`
never reaches the window. Pass `mirrorTitle: true` to
`frontendPluginManager.open()` for a window dedicated to one plugin; the manager
then forwards the view's `page-title-updated` to `hostWindow.setTitle()`. Do
**not** pass it for a view embedded in a shared window (the main shell) — the
plugin would rename a window it does not own. The window's constructor `title`
stays the feature name: it is what shows during load, before the first title
event.

## Quick start: a backend plugin

Create a directory containing `plugin.json` and `backend.py`. The loader
requires **both** files to be present; a directory holding only `manifest.json`
is treated as a frontend install and skipped. `backend.py` is loaded directly by
path, so no `__init__.py` is needed — add one only if your `backend.py` imports
sibling modules by package path.

```python
# backend.py
def activate(context):
    context.register_route("/my-plugin", asgi_app, methods=["POST"])
    context.register_startup(on_startup)
    context.register_shutdown(on_shutdown)

def deactivate():
    ...
```

`PluginContext` offers:

| Method | Purpose |
|---|---|
| `register_route(path, asgi_app, methods)` | Mount an HTTP route |
| `register_startup(hook)` | Run at service startup (may be async) |
| `register_shutdown(hook)` | Run at service shutdown |
| `register_spawn_transformer(fn)` | Rewrite an agent's spawn command: `(agent_key, command, port, pane_id, env) -> command`. `env` is the spawn environment, mutated in place for CLIs configured by variable rather than by flag. Declaring fewer positional parameters keeps the older shapes working. |
| `clear_registrations()` | Drop registrations on deactivate |

This Python import shape is now restricted to Navide's bundled
`plugins/builtin/` directory. The service no longer scans
`AGENT_TEAM_PLUGINS_DIR`: an installed or locally created directory containing
`plugin.json` and `backend.py` cannot enter backend startup. Each bundled plugin
still loads inside its own try/except, so a failing builtin never blocks service
startup.

Installed Manifest v2 backend contributions instead reach the service through
a Host-generated activation catalog bound to the backend child process by an
exact SHA-256 digest. The Python service validates that projection but does not
import or spawn its packaged executable yet. Electron's child-process
supervisor must land before third-party or Developer Mode v2 backends can run;
until then those entries remain fail-closed.

`navide_plans` is the reference implementation: it registers a route, startup
and shutdown hooks, and a spawn transformer.

## Manifest reference

| Field | Rule | Required |
|---|---|---|
| `id` | `^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$`. The `navide.` prefix is reserved | yes |
| `name` | Non-empty string; the feature name — see [Naming and window titles](#naming-and-window-titles) | yes |
| `version` | Strict semver `MAJOR.MINOR.PATCH`, no pre-release or build metadata | yes |
| `publisher` | Non-empty publisher id | yes |
| `engines` | Non-empty object containing `navide`, e.g. `{"navide": "^0.1.0"}` | yes |
| `entry` | Frontend bundle entry point; validated against path escape | frontend only |
| `requires` | Capability namespaces; each must be in the whitelist below | no |
| `activationEvents` | Each matches `onStartup`, `onView:<id>`, or `onCommand:<id>`. **Backend plugins only** — see below | no |
| `contributes` | `{ "views": [{id, title}], "commands": [{id, title}] }` | no |
| `displayName`, `description`, `categories`, `icon` | Marketplace presentation only | no |

The authoritative schema lives in
`backend/agent_team_backend/plugins/manifest.py`. The marketplace registry
accepts the same core fields plus the presentation fields — an additive
superset, not a divergent schema.

**Filename matters**: backend plugin directories are read as `plugin.json`;
installed frontend packages are read as `manifest.json`. Under
`src/renderer/plugins/*/`, `plugin.json` is a source-side reference; the
`manifest.json` that actually ships is generated by the Vite config.

**Activation differs by kind.** A backend plugin is activated by the host at
the point its `activationEvents` call for — `wiring.py` checks the list before
running `activate()`. A frontend view has no activation events at all: its
`WebContentsView` is created the first time the host opens the view, and torn
down when the view closes. That is already the laziest possible lifecycle, so
the bundled frontend plugins declare no `activationEvents`, and you should not
either — the frontend loader never reads the field, and a declaration would
promise a lifecycle nothing implements.

## Capability reference

A plugin may only call namespaces it declares in `requires`. Anything else is
rejected with `CAP_DENIED` before it reaches the backend.

A Manifest v2 package can additionally declare the workspace paths it reads and
writes in `permissions.scopes.fs`. That field is a disclosure shown to the user,
never a grant or a restriction; see
[Declared filesystem scopes](plugin-development-v2.md#declared-filesystem-scopes-disclosure-only).
The bundled `navide.plans` package declares, relative to the repository root,
the documents directly inside `.agent-team/plans`, `.agent-team/reports`,
`.claude/loop-reports`, `.claude/plans`, `.cursor/plans`, `docs/plans` and
`docs/reports` at any depth, plus `.plans/<document>`, for reading and writing,
and the `.history` beneath those directories for reading only.

### Namespaces

| Namespace | Grants |
|---|---|
| `fs` | File read/write, directory listing, glob, archive listing, image reading — and the `git.changed` working-tree event |
| `git` | Status, log, diff, branch, stage, commit, sync, and credential events |
| `terminal` | Shell execution — the one-shot `run`, plus the interactive PTY surface (`create` / `input` / `resize` / `interrupt` / `kill` / `reattach` / `redraw` and the `terminal.output` / `terminal.exit` events) |
| `search` | Find and replace across files |
| `chat` | AI chat, editor rewrite/complete, review, analyzer models |
| `ui` | Settings get/set, settings-changed events, opening a file in the editor |
| `issues` | Cloud issue provider, list, get, create, comment, set state |
| `plans` | The `plans.changed` event (event-only; no request methods) |

`ping` is always available without declaring it, and is useful for verifying the
bridge works before wiring anything real.

`fs` and `terminal` are **sensitive**: installing a plugin that requests them
triggers an extra trust confirmation in the UI. `terminal` in particular now
grants an interactive PTY — a plugin holding it can spawn and drive a
long-running shell process in the workspace, not just one-shot commands.
Splitting the interactive PTY into a dedicated `terminal.pty` namespace (so a
plugin can be granted `run` without PTY spawning) is a possible future
refinement; today one grant covers both.

Legacy v1 compatibility is bounded to a live, authenticated legacy view whose
descriptor has no canonical Manifest v2 identity: an unknown
`terminal.reattach` id is still allowed so an app-owned PTY can be recovered,
but a stale sender, a foreign route, or a detached v2 tombstone is stripped.
The legacy `open()` entry point is only a lifecycle and plugin-id lookup
adapter; passing a v2 descriptor through it does not grant v1 PTY privileges.
Manifest v2 does not expose the raw `terminal` PTY namespace; its public AI CLI
surface is Host-mediated and instance-bound. Full isolation of legacy PTYs that
were never registered by this broker still requires a backend-side ownership
namespace and is a prerequisite for opening the legacy `terminal` grant to
marketplace plugins.

### Calling a capability

```js
const res = await window.nav.callCapability('fs', 'read_file', { path })
```

The host resolves the calling plugin's identity from the Electron sender id, not
from anything in the payload, so a plugin cannot impersonate another.

The `fs`, `git`, `search`, and `issues` namespaces map one-to-one onto backend
message types, and so do the interactive PTY methods (`terminal.create`,
`terminal.input`, `terminal.log_sent`, `terminal.resize`, `terminal.interrupt`,
`terminal.kill`, `terminal.reattach`, `terminal.redraw` →
`terminal.<method>`). The rest of `terminal`, plus `chat` and `ui`, are
remapped — the full table:

| Capability | Backend type |
|---|---|
| `terminal.run` | `shell.run` |
| `terminal.create_cancel` | `terminal.create.cancel` |
| `chat.start` / `chat.stop` | `ai.chat.start` / `ai.chat.stop` |
| `chat.enhance_prompt` / `chat.web_search` | `ai.enhance_prompt` / `ai.web.search` |
| `chat.editor_rewrite` / `chat.editor_complete` | `editor.rewrite` / `editor.complete` |
| `chat.review_start` / `chat.review_stop` | `ai.review.start` / `ai.review.stop` |
| `chat.analyzer_models` | `analyzer.models` |
| `chat.settings_get` / `chat.settings_set` | `ai.chat.settings.get` / `ai.chat.settings.set` |
| `chat.test_connection` | `ai.chat.test_connection` |
| `chat.accept_edit` | `ai.chat.accept_edit` |
| `chat.approve_command` / `chat.reject_command` | `ai.chat.approve_command` / `ai.chat.reject_command` |
| `chat.notes_get` / `chat.notes_set` | `ai.chat.notes.get` / `ai.chat.notes.set` |
| `chat.threads_get` / `chat.threads_set` | `ai.chat.threads.get` / `ai.chat.threads.set` |
| `ui.settings_get` / `ui.settings_set` | `ui.settings.get` / `ui.settings.set` |

`ui.open_in_editor` is handled by the host process directly and never reaches
the backend.

Errors arrive as one of `CAP_DENIED`, `UNKNOWN`, `BAD_REQUEST`, or
`BACKEND_ERROR`.

### Receiving events

```js
const dispose = window.nav.on('git.changed', (payload) => { ... })
```

Events are gated by namespace, so you only receive what your `requires` covers:

| Event | Requires |
|---|---|
| `git.changed` | `fs` (it is a working-tree change signal) |
| `git.credential_request`, `git.credential_cancelled` | `git` |
| `ui.settings_changed` | `ui` |
| `ai.chat.*`, `ai.review.*` | `chat` |
| `plans.changed` | `plans` |
| `terminal.output`, `terminal.exit` | `terminal` |

`terminal.output` is micro-batched by the host (a few milliseconds per PTY
session, `data` concatenated) and delivered only to the plugin whose
`terminal.create`/`terminal.reattach` bound the session; `terminal.exit`
always flushes the session's pending output first. A v2 detach retains only a
tombstone for same-tuple reattach. Events for a session no running plugin view
has bound are **dropped**, never fanned out — PTY content cannot leak to
plugins that did not bind the session.

The host also emits a synthetic `nav.backend_status` event so a plugin can track
whether the backend connection is actually live.

### Backend capability maturity

Python plugins receive capability objects built from their `requires`. These
differ in maturity:

| Capability | State |
|---|---|
| `fs`, `git`, `search`, `issues` | Available |
| `terminal.run` | Available and hardened: `cwd` must be a registered workspace root or a subdirectory, 30-second timeout, output truncated at 8000 characters |
| `terminal` PTY (`create`/`input`/…) | Frontend-broker only — routed to the core terminal service over the shared WS transport; not exposed to Python plugins |
| `chat` | Partly available — settings, notes, threads, edit approval, and editor rewrite/complete delegate to the core service; `start`, `stop`, `test_connection`, `enhance_prompt`, and `web_search` raise `CapabilityNotAvailable` |
| `ui` | Interface only — all methods raise `CapabilityNotAvailable`; the namespace exists so authorization can be recorded |
| `plans` | Empty marker |

Frontend capability calls do **not** pass through the Python plugin host. The
broker forwards them to the backend's existing handler registry. The Python
capability objects serve Python plugins only.

## The `window.nav` bridge

The plugin preload exposes exactly one global. `window.agentTeam` is not
available to plugins.

| Method | Purpose |
|---|---|
| `callCapability(ns, method, args)` | Invoke a capability; returns a promise |
| `castCapability(ns, method, args)` | Fire-and-forget capability call — no response, same scoping; meant for high-frequency paths like per-keystroke `terminal.input` |
| `on(type, cb)` | Subscribe to an event; returns a disposer |
| `ready()` | Signal that the plugin has mounted |
| `hideSelf()` | Hide or close this plugin's own view |
| `onOpenTarget(cb)` | Receive incremental open targets (e.g. a file to open) |

`hideSelf()` is scoped to the caller — a plugin can only hide itself.

When the host routes an open target to an already-running plugin in the same
workspace, it delivers it through `onOpenTarget` rather than reloading, so open
tabs and scroll positions survive. Switching workspace reloads the entry.

## Security model

**Signatures.** A package carries a detached Ed25519 signature over the
archive's sha256 digest, supplied at publish time rather than stored inside the
archive. Produce it with `navide-plugin sign <package> --key <privkey>`.

**Trust tiers.** A package is either `signed-verified` or `unsigned`. Missing
signature material always yields `unsigned` — a registry cannot raise a
package's trust tier by asserting one.

**Reserved namespace.** Plugin ids beginning with `navide.` are reserved for
first-party plugins. Marketplace packages may claim them only through the
App-authorized Official Registry path; an approved self-hosted Registry cannot
upgrade its authority by returning `registryProfile: "official"`. Use your own
publisher prefix.

**Two-phase install.** `prepareInstall` downloads, cross-checks the digest,
parses and validates the manifest, verifies the signature, and checks capability
scope — all without writing to disk. Only after the user confirms any sensitive
capabilities does `commitInstall` write the plugin. Downloaded bytes never enter
a renderer process.

**Archive safety.** Every entry path is checked against directory escape before
extraction. Size limits are 50 MB per entry and 200 MB per archive.

**Install receipts.** First-party installs carry a receipt that is re-verified
against the pinned key on every load. A package that ships its own receipt file
is rejected.

## Packaging and publishing

Packaging, signing and publishing use the SDK CLI, `navide-plugin` from
`@navide/plugin-sdk`; [Publishing to the Navide Marketplace](marketplace-publishing.md)
walks through every step:

```bash
navide-plugin validate <staging-dir>
navide-plugin package <staging-dir> [--target <platform-arch>]
navide-plugin keygen --out-dir <dir> --name <publisher>   # first time only
navide-plugin sign <package> --key <privkey>
navide-plugin login
navide-plugin publish <package> --signature <sig> [--target <platform-arch>]
```

The Python `navide-plugin` in `marketplace/registry/` (`pack`, `sign`,
`publish`, `login`) is deprecated for plugin authors and kept only for
Navide's first-party release scripts.

The archive is a ZIP with `manifest.json` at its root; its format is
[`marketplace/registry/FORMAT.md`](../../marketplace/registry/FORMAT.md).

**Registry endpoints.** Packaged Navide builds use the Official Registry at
`https://server.navide.dev/registry`. Its root key is pinned in the App build
(`resources/official-registry-root.pem`), and only that exact URL (scheme,
host, and the `/registry` path; a trailing slash is ignored) carries Official
Registry authority. Development builds default to a local self-hosted Registry
at `http://localhost:8787`. `AGENT_TEAM_MARKETPLACE_URL` overrides either
default, and plaintext HTTP is rejected outside loopback in production builds.
Publishing requires a publisher account on the registry instance you are
targeting; on the Official Registry that is a namespace claimed with your
Navide account (see [Publishing to the Navide Marketplace](marketplace-publishing.md)).

The local endpoint is not the Official Registry identity and does not inherit
the App-shipped root pin. Before Navide contacts a self-hosted Registry, set
`AGENT_TEAM_REGISTRY_ROOT_APPROVAL_FILE` to a Host-owned JSON file that binds
the exact Registry URL to a separately confirmed root key fingerprint:

```json
{
  "schemaVersion": 1,
  "registryUrl": "http://localhost:8787",
  "rootPublicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n",
  "confirmedFingerprint": "sha256:<64 lowercase hex characters>"
}
```

Unknown fields, duplicate JSON keys, a URL mismatch, or a fingerprint mismatch
fail closed. `AGENT_TEAM_MARKETPLACE_URL` selects a non-default self-hosted URL;
the approval file must name that normalized URL. The Registry response's
informational `rootFingerprint` never replaces this out-of-band approval.

The Official Registry root is provisioned separately from the publisher key.
Packaged releases must include an independent Ed25519 public key at
`resources/official-registry-root.pem`; the Host reads only
`process.resourcesPath/resources/official-registry-root.pem`. A missing or
malformed resource, or a resource that reuses the publisher key, leaves the
Official Registry path unavailable. The Registry response and runtime
environment variables cannot provide or replace this packaged pin.

## Local development

Set `AGENT_TEAM_PLUGIN_DEV=1` to expose the plugin dev menu, which registers dev
descriptors pointing at local build output and adds entries for the `noop` and
`fs_probe` probe plugins.

To load one local unpacked Manifest v2 frontend package, also set
`AGENT_TEAM_PLUGIN_DEV_PATH` to that exact package directory. Developer Mode
validates only the selected directory, requires a strict frontend package,
rejects reserved ids and backend contributions, and shows a persistent unsigned
local-only warning. It does not scan a parent directory or grant Registry
provenance, publishing, or auto-update behavior. The fixed `dist-plugins`
bundles remain Host-owned development fixtures.

`noop` verifies the IPC bridge end to end with a `ping` call. `fs_probe`
demonstrates a real capability call plus event subscription. Both are minimal
and are the fastest way to confirm your environment works before writing a real
plugin.

## Testing

Frontend and main-process tests run under Vitest; files needing a DOM declare
`// @vitest-environment happy-dom` at the top. Backend plugin tests live in
`backend/tests/`.

Two conventions are worth copying:

- **Shim interface parity.** A `capabilityBackend` shim test starts by assigning
  the shim's type to the real `useBackend` type in both directions, so an
  interface drift fails at compile time rather than at runtime.
- **Map inversion.** The host's capability map and the shim's reverse map live
  in different builds and cannot share code, so a test cross-checks that they
  are exact inverses.

## Current limits

- Plugins can be installed and removed, but not disabled — there is no
  enable/disable state.
- `chat` and `ui` backend capabilities are interface-only for Python plugins;
  see the maturity table above.
- `contributes.views` and `contributes.commands` are accepted and validated by
  the manifest schema, but are not yet rendered or dispatched by the host.
