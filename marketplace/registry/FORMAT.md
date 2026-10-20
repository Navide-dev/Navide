# Navide plugin package format (`.vsix`-style)

> **Status: Manifest v2 is the package format.** Every new package is a
> Manifest v2 archive built with the SDK CLI (`navide-plugin package`, see
> [Publishing to the Navide Marketplace](../../docs/en-US/marketplace-publishing.md)).
> The Registry still reads [legacy Manifest v1](#legacy-manifest-v1) archives
> so existing rows keep working; do not author new v1 packages.
>
> `parse_manifest` (`registry/manifest.py`) routes a manifest with a
> `schemaVersion`, `permissions` or `marketplace` key to the v2 model
> (`registry/manifest_v2.py`) and anything else to v1
> (`registry/manifest_v1.py`). The archive reader is `registry/package.py`; the
> author-side packager is `packages/plugin-sdk/bin/navide-plugin.mjs`, which
> validates the same rules with `@navide/plugin-contracts` before it writes the
> archive. The runtime contract behind each field is in
> [Plugin Developer Spec v2](../../docs/en-US/plugin-development-v2.md).

## Archive layout

A package is one ZIP archive, conventionally `<id>-<version>-<target>.vsix`.
The filename carries no meaning: identity and version come from the manifest,
and the target from the publish request.

```
acme.files-1.0.0-darwin-arm64.vsix   (a ZIP archive)
├── manifest.json        (required, at the archive root)
├── README.md            (optional; shown on the listing page)
├── frontend/            (present when contributes.views exists)
│   └── main/
│       ├── index.html
│       └── main.js
├── backend/             (present when backend exists)
│   └── acme-files       (one executable for this target; acme-files.exe on win32)
└── assets/
    └── icon.png
```

The author-side staging directory also holds `artifact-files.json`, a JSON
object with exactly one key, `files`: the explicit list of files to put in the
archive. The packager never zips a directory recursively, and
`artifact-files.json` itself is not archived.

## Archive rules

Enforced by `read_package` at publish (and by the SDK packager before it
writes):

- The archive is a valid ZIP without ZIP64 records.
- `manifest.json` is a regular file at the archive root: UTF-8 without a BOM,
  one JSON object, no duplicate keys, valid against the manifest model.
- Entry paths are canonical relative POSIX paths of at most 1024 characters:
  no absolute paths, empty, `.` or `..` segments, backslashes, duplicate
  (case-folded) entries or regular-file ancestor collisions. A directory entry
  may have one trailing `/`. Symlinks and special files are refused.
- An entry is at most 50 MiB; the expanded archive is at most 200 MiB.
- These Host-owned names never appear in an archive:
  `.navide-receipt.json`, `.navide-registry-receipt.json`,
  `.navide-package.zip`, `.navide-registry-trust.json`,
  `.navide-backend-activation.json`, `.navide-quarantined.json`.
- Source-only and secret material is refused: any path under
  `node_modules`, `.venv`, `venv`, `__pycache__` or `tests`; `package.json`,
  lock files and `pyproject.toml`; `.py`, `.pyc`, `.pyo`, `.ts`, `.tsx`,
  `.vue` and `.map` files; `.env*` files and `.key`, `.pem`, `.p12`, `.pfx`
  files. (The SDK packager also refuses `vite.config.*`.)
- Every file the manifest references exists in the archive: each view
  `entry`, view `icon` and `targetSchema`, `marketplace.icon`, and the
  target's [backend entry](#targets-and-backend-entry).
- Apart from `manifest.json` and `README.md`, the SDK packager keeps files
  inside `frontend/`, `assets/` and `backend/`, plus any declared view
  `targetSchema`.
- A package without `contributes` has no `frontend/` entries; a package
  without `backend` has no `backend/` entries.

## `manifest.json` (Manifest v2)

Unknown fields are refused at every level, and so is an explicit `null`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `schemaVersion` | `2` | yes | Selects this model. |
| `apiVersion` | string | yes | The public SDK/capability API range the plugin is written against, `^1.0.0`-style: an optional `^` or `~` and `MAJOR.MINOR.PATCH`. |
| `id` | string | yes | `<namespace>.<name>[.<more>]`, each segment `[a-z0-9][a-z0-9-]*`. The Registry identity; never changes between versions. |
| `name` | string | yes | Display name, 1-80 characters, no newlines or `<` `>`. |
| `version` | string | yes | Manifest v2: full SemVer 2.0.0, including a pre-release suffix and build metadata; see [Release channels](#release-channels). (Manifest v1 accepted only `MAJOR.MINOR.PATCH`.) |
| `publisher` | string | yes | `[a-z0-9][a-z0-9-]*`; must equal the first segment of `id`, which is the namespace the publishing account owns. |
| `engines` | object | no | `{ "navide": "<range>" }`, the lowest Navide release the version supports; see [`engines.navide`](#enginesnavide). |
| `permissions` | object | yes | `{}` or the grants below. |
| `marketplace` | object | yes | Listing metadata, below. |
| `contributes` | object | one of | `{ "views": [...] }`, 1-16 views. |
| `backend` | object | one of | The native backend, below. |
| `extensionPack` | string[] | one of | An [Extension Pack](#extension-packs): 1-20 member ids. |

A manifest declares `contributes`, `backend` or both, or else it is an
Extension Pack and declares neither.

### `permissions`

| Field | Type | Notes |
|---|---|---|
| `system` | string[] | 1-4 unique namespaces from `fs`, `ui`, `aiCli`, `web`. |
| `shell` | string | `allowlist` or `full`. |
| `scopes` | object | Optional. `{"fs": {"root": ..., "read": [...], "write": [...]}}`: path patterns the package declares it reads or writes. `root` is `workspace` (default) or `repository` (the nearest enclosing Git root). At least one of `read`/`write`, each 1-16 unique safe relative patterns; `*` matches within one segment, a whole-segment `**` matches zero or more segments, and a pattern covers only what it matches. Shown to the user as a disclosure; it grants and restricts nothing. |

### `marketplace`

| Field | Type | Required | Notes |
|---|---|---|---|
| `description` | string | yes | 1-280 characters, one line, no `<` `>`. Used by search. |
| `license` | string | yes | An SPDX-style expression, up to 100 characters. |
| `repository` | string | no | An `https://` URL. |
| `homepage` | string | no | An `https://` URL. |
| `categories` | string[] | no | Up to 5 unique slugs `[a-z0-9][a-z0-9-]{0,39}`. |
| `icon` | string | no | Archive path of the listing icon. |

### `contributes.views[]`

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `[a-z][a-z0-9-]*`, unique in the package. |
| `kind` | `"custom"` | yes | |
| `location` | string | yes | `top`, `bottom`, `right`, `left`, `main`, `window` or `detail`. |
| `title` | string | yes | 1-80 characters, no newlines or `<` `>`. |
| `entry` | string | yes | Archive path of the view's HTML file. |
| `icon` | string | no | Archive path. |
| `detailView` | string | no | `left` views only: the id of a `detail` view in the same package. |
| `targetSchema` | string | no | `detail` views only: archive path of a `.json` schema. |
| `receives` | object | no | `window` views only: `{ "protocolVersion": 1, "locations": ["left" and/or "detail"], "editorTargets"?: { "protocolVersion": 1 }, "closeGuard"?: { "protocolVersion": 1 } }`. |

### `backend`

| Field | Type | Required | Notes |
|---|---|---|---|
| `entry` | string | yes | Archive path of the executable, written without an extension (see below). A script name (`.py`, `.js`, `.sh`, `.ps1`, `.bat`, …) is refused. |
| `protocolVersion` | `1` | yes | Navide Backend Wire v1. |
| `activation` | `"startup"` | yes | |
| `methods` | string[] | no | 1-64 unique package-local method names, dotted lowerCamel segments such as `files.list` (at most 128 characters). The Host forwards only declared methods. |
| `events` | string[] | no | 1-32 unique package-local event names, same form as `methods`. The Host forwards only declared events. |
| `agentTools` | object[] | no | 1 or more tools agents may call through the core navide MCP server, each forwarded to one of `methods`. Every rule (name prefix derived from the id, reserved names, plain-text title and description, integer-only `inputSchema`, `timeoutMs` 1-120000, the 1 MiB cap) is in `docs/en-US/plugin-agent-tools-contract.md` section 2; a package that breaks any of them is refused at publish. |

## Targets and backend entry

Every artifact is published for one target, the `target` query parameter of
`POST /api/publish`:

- A package **without** a backend is published once as `universal`.
- A package **with** a backend is published once per platform target,
  `<platform>-<arch>` as Node reports it. The archive holds exactly one file
  under `backend/`, the executable for that target, and its bytes must match
  the target: ELF for `linux-x64` / `linux-arm64`, PE for `win32-x64` /
  `win32-arm64`, Mach-O 64-bit for `darwin-x64` / `darwin-arm64`. A file that
  starts with `#!` is refused.
- **Windows entry rule.** One manifest serves every target, so `backend.entry`
  is written without an extension (`backend/acme-files`). For a `win32-*`
  target that bare entry names `backend/acme-files.exe`, which is the file the
  archive must contain; on every other target it names the file as written.
  An entry that already has an extension is read as written everywhere.
- **Executable bit.** On non-Windows targets the backend entry's ZIP mode has
  an executable bit; on `win32-*` the `.exe` extension stands in for it.
- A version is either one `universal` artifact or a set of platform
  artifacts, never both, and each target is published at most once (`409`
  otherwise). The App installs the artifact for its exact host target, else
  `universal`. Yanking yanks the version on every target.
- The SDK packager builds a backend package only for the build host's own
  target, so each target is packaged on a machine of that platform and
  architecture (the first-party CI matrix does this).

## Extension packs

A manifest with `extensionPack` lists 1-20 unique member ids installed
together:

- It declares no `contributes`, no `backend`, and empty `permissions` (no
  `system`, no `shell`); it is published as `universal`.
- It may not list its own id, and a member may not itself be a pack; nor may
  a pack version be published for an id another pack lists as a member. The
  Registry refuses such a publish, and approval re-checks it.
- The Registry lists every pack under the `extension-packs` category, whatever
  categories it declares. Each member is installed, verified and confirmed on
  its own, with the member's own permissions.

## `engines.navide`

`engines.navide` names the **lowest** Navide release a version supports, the
way VS Code reads `engines.vscode`: `^0.2.9`, `~0.2.9`, `>=0.2.9` and a bare
`0.2.9` all mean "0.2.9 or newer", and `*` means any release. Upper bounds are
not enforced, so a package keeps working on newer Navide releases. A Navide
release older than the minimum is not offered that version. An absent or
unreadable requirement is treated as unknown rather than incompatible. The
Registry (`registry/discovery.py`) and the App
(`src/main/plugins/pluginEngineCompat.ts`) apply the same rule.

## Release channels

Manifest v1 versions are always `MAJOR.MINOR.PATCH`, so every v1 release is
stable. Manifest v2 `version` accepts SemVer 2.0.0, including a prerelease
suffix and build metadata:

- A version with a prerelease suffix (`2.5.0-beta.1`) is a **pre-release**;
  every other version, including one with only build metadata
  (`2.5.0+build.7`), is **stable**. The API reports this per version as
  `channel` (`stable` or `pre-release`).
- `latest_version` names the newest **stable** version. Only an extension with
  no stable version at all reports its newest pre-release there.
- `latest_prerelease_version` names the newest pre-release when it is newer
  than `latest_version`, and is `null` otherwise.
- Build metadata is ignored for ordering.

## Signing

There are two deliberately separate signatures:

| Signature | Producer | Purpose | Client trust role |
|---|---|---|---|
| Publisher submission signature | Publisher | Authenticates an upload to the Registry and proves namespace ownership at publish time. | None; a publisher-supplied key never becomes a Client trust root. |
| Registry central signature | Registry signer authorized by root-signed trust metadata | Binds the complete archive digest to immutable package, version, target, publisher, signer, and signing-time identity. | Accepted only after the App verifies current trust metadata with its pre-pinned Registry root. |

A package submission carries a **detached publisher signature** supplied to `POST /api/publish` as
the `signature` query param (not stored inside the ZIP). It is the **base64
encoding of an Ed25519 signature over the package's sha256 digest** (the
64-character lowercase hex string, as ASCII bytes — the same digest the
registry computes from the uploaded bytes). The registry verifies it
against the publisher's registered Ed25519 public key
(`registry/signing.py :: Ed25519SignatureVerifier`). This authenticates the
submission only; it is not returned as the Client trust contract. Once accepted,
the registry signs the full artifact digest and immutable listing envelope with
its registry signer and returns root-signed signer/blocklist metadata. Produce
the submission signature with `navide-plugin sign <package> --key <privkey>`
(keys from `navide-plugin keygen`: PKCS#8 private key, SPKI public key, both
PEM). See the README "Security model" section for the publish gate and policy
config.

## Legacy: Manifest v1

The Registry still parses v1 manifests, so packages published before Manifest
v2 keep working; new packages should use v2. A v1 archive is a ZIP with
`manifest.json` at its root; every other file is recorded as an asset, and
`manifest.icon`, when set, must exist in the archive. The archive path rules
above apply to v1 too.

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | `<namespace>.<name>`, lowercase; regex `^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$`. |
| `name` | string | yes | Non-empty. |
| `version` | string | yes | Strict `MAJOR.MINOR.PATCH` (no pre-release/build). |
| `publisher` | string | yes | Non-empty publisher id. |
| `engines` | object | yes | Non-empty `{host: range}`, e.g. `{"navide": "^0.1.0"}`. |
| `entry` | string | no | Plugin entry file. |
| `contributes` | object | no | `{ "views": [{id,title}], "commands": [{id,title}] }`. |
| `requires` | string[] | no | Capabilities; each one of `fs, git, terminal, search, chat, ui, issues, plans`. |
| `activationEvents` | string[] | no | Each `onStartup` \| `onView:<id>` \| `onCommand:<id>`. |
| `displayName` | string | no | Falls back to `name`. |
| `description` | string | no | Used by search. |
| `categories` | string[] | no | Used by search/filter. |
| `icon` | string | no | Archive-relative path to an icon asset. |
