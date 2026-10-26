---
name: navide-plugin-authoring
description: Write, check and load a Navide plugin (a Manifest v2 package with custom views and an optional native backend). Use when the user wants a new Navide panel, window, tab or agent tool, or asks you to change, debug or package a Navide plugin.
---

# Writing a Navide plugin

A Navide plugin is a folder with a `manifest.json`, one HTML entry per view,
and optionally one native backend executable. Each view runs isolated in its
own Host-owned web contents and talks to Navide only through the public SDK.
The full contract is `docs/en-US/plugin-development-v2.md` in the Navide
repository (about 2,700 lines); this skill is the short path through it. When
the two disagree, the spec wins.

## 1. Start from the smallest thing that works

```text
npx navide-plugin init acme-hello --id acme.hello
```

That writes a frontend-only plugin that validates and packages as written:

```text
acme-hello/
├── manifest.json            # schemaVersion 2, one view with location "main"
├── frontend/main/index.html
├── frontend/main/main.js    # calls window.nav.ready()
├── README.md
├── artifact-files.json      # the exact list of files that go into the package
└── .gitignore
```

If the CLI is not installed, write those files by hand. The manifest:

```json
{
  "schemaVersion": 2,
  "apiVersion": "^1.0.0",
  "id": "acme.hello",
  "name": "Hello",
  "version": "0.1.0",
  "publisher": "acme",
  "engines": { "navide": ">=0.2.13" },
  "permissions": {},
  "marketplace": { "description": "Hello, a Navide plugin.", "license": "MIT" },
  "contributes": {
    "views": [
      { "id": "main", "kind": "custom", "location": "main", "title": "Hello",
        "entry": "frontend/main/index.html" }
    ]
  }
}
```

`artifact-files.json` is `{ "files": [ ...every file the package contains... ] }`.
Nothing outside that list is packaged, so a new file that is not listed is
simply missing at runtime.

## 2. "I want X" → start from Y

| Want | Manifest / API | Copy from (Navide repo) |
|---|---|---|
| A panel beside the panes | view `location`: `left`, `right`, `top` or `bottom` | `plugins/navide-git` (`left`) |
| A full tab in the stage tab bar | view `location: "main"` | the `init` scaffold |
| A separate window | view `location: "window"` | `plugins/navide-mini-ide` |
| Read or write workspace files | `permissions.system: ["fs"]`, `fs.*` capabilities; narrow with `permissions.scopes.fs` | `plugins/navide-plans` (scoped `fs`) |
| Run a command | `permissions.shell: "allowlist"`, `shell.run` | `plugins/navide-git` |
| Drive an AI CLI pane | `permissions.system: ["aiCli"]` | `plugins/navide-git` |
| Open real web pages | `permissions.system: ["web"]` (disclosed as high risk) | `plugins/navide-browser` |
| Remember settings or view state | `createPluginViewState(key, fallback)` from `@navide/plugin-sdk` (keeps state across reloads), or `storage.get` / `storage.set`; no permission to declare | spec, "SDK interface" and "Host-managed storage partitions" |
| Logic that outlives the view | `backend` (one native executable, Backend Wire v1) | `plugins/navide-plans` |
| A tool agents can call | `backend.methods` + `backend.agentTools` | `plugins/navide-browser`; spec, "Agent tools" |

The capability catalog with every method, its schema and the permission it
needs is `docs/plugin-contracts/capabilities-v1.json`.

## 3. Rules that are easy to break

- **Call `ready()` after the view has mounted.** Use
  `createPluginViewRuntimeClient().ready()` (or `viewReady()`) from
  `@navide/plugin-sdk`; the no-build scaffold calls `window.nav.ready()`.
  Without it the install fails, and a running view is reloaded once after 10
  seconds.
- **Use only the public packages**: `@navide/plugin-contracts`,
  `@navide/plugin-sdk`, `@navide/plugin-ui`. Never import Navide's renderer
  sources, and never call `window.nav` directly from built code.
- **Declare the smallest permissions.** `permissions.system` accepts only
  `fs`, `ui`, `aiCli`, `web`, `agents`, `agentMessages`; `permissions.shell`
  only `allowlist` or `full`. An undeclared call rejects with
  `CAPABILITY_DENIED`. Storage needs no declaration.
- **Navide never calls `activate`.** `definePlugin(...)` exists for types and
  tests only; put real start-up code in the view's own script.
- **A backend is one self-contained executable** at `backend.entry` (no
  `.py`, no interpreter, no extension on POSIX). Method names are lower-case
  dotted (`acme.files.search`); camelCase is refused at activation.
- **Agent tool names** start with the prefix derived from the plugin id's
  last segment with `-` removed (`acme.dev-map` → `devmap_`).
- **View titles and the plugin name** are 1–80 characters, no newlines or
  angle brackets; at most 16 views.

## 4. The loop: write → check → load → try

1. Write or edit the folder. With a build step (TypeScript, Vite, Vue), keep
   the source elsewhere and let the build write a staging folder such as
   `dist/package` with the shape above and its own `artifact-files.json`.
2. Check it: call the `plugins_validate_package` tool with the folder's
   absolute path (or run `npx navide-plugin validate <folder>`). Fix every
   error before going on; it is read-only.
3. Load it into Navide. Loading code from a folder needs **Developer Mode**,
   which only the user can turn on: call `plugins_developer_mode_open`, tell
   the user what you want to load and why, and stop. Once it is on, call
   `plugins_install_file_fill` with the folder path and a one-line `reason`;
   the user approves it in Navide's main window. You cannot approve it
   yourself.
4. Let the user try it. A loaded folder reloads by itself when its files
   change, so later edits only need step 2 again. Before the running version
   is replaced, the new views must call `ready()` in a hidden check; if they
   do not, the running version stays and the card shows why. With a build
   step, make the build write `.navide-build-complete` into the folder last:
   the folder then reloads only when that file is written again, never in
   the middle of a build.
5. To hand it over as a file, call `plugins_package` (or
   `npx navide-plugin package <folder>`); install a `.vsix` the same way with
   `plugins_install_file_fill`. Signing and publishing to the Marketplace are
   the user's decision; see `docs/en-US/marketplace-publishing.md`.

## 5. When something fails

- `plugins_validate_package` lists manifest and package errors by field.
- A refused capability rejects with a `PluginError` whose `code` says why;
  Settings → Navide Plugins → Disclosure overview → the plugin → Activity
  lists every refused call.
- A backend's stderr and restarts are in Navide's main log on lines starting
  with `[plugin-backend]`. `npx navide-plugin dev-backend <folder> --call
  <method>` runs a built backend alone, with every Host request refused.
- A view's console is reachable through Chrome DevTools Protocol (Settings →
  MCP → External access); ask the user before turning it on, because while it
  is on anything on the machine can run code in Navide.
