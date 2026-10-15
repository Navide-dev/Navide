# Publishing to the Navide Marketplace

This guide takes a plugin from an empty directory to a listing on the Navide
Marketplace (`https://server.navide.dev/registry`). Every step uses one tool,
the `navide-plugin` CLI from `@navide/plugin-sdk`.

```text
init → validate → package → test on a local registry
     → sign in with Navide Cloud → claim a namespace → keygen + register key
     → navide-plugin login → sign → publish → review → listed
```

For what a plugin can do at runtime, see the
[Plugin Developer Spec v2](plugin-development-v2.md). For the exact archive and
manifest rules the Registry enforces, see
[`marketplace/registry/FORMAT.md`](../../marketplace/registry/FORMAT.md).

## Prerequisites

- **Node.js 20 or newer** and npm (or pnpm).
- **A Navide account with a verified email** — the same one you use for the
  Navide forum and Navide Cloud. Publishing signs in through it; the CLI never
  asks for your password.
- **For local testing only:** a checkout of the Navide repository and
  [uv](https://docs.astral.sh/uv/), to run a throwaway Registry.

### Install the CLI

`@navide/plugin-sdk` and `@navide/plugin-contracts` are not on the npm
registry yet. Until they are, build them from a Navide checkout and install the
tarballs into your plugin project:

```bash
# in the Navide checkout
pnpm install
pnpm run build:public-packages
npm pack ./packages/plugin-contracts ./packages/plugin-sdk --pack-destination /tmp/navide-sdk

# in your plugin project
npm init -y
npm install --save-dev /tmp/navide-sdk/navide-plugin-contracts-1.0.0.tgz \
  /tmp/navide-sdk/navide-plugin-sdk-1.0.0.tgz
npx navide-plugin
```

The last command prints the usage of every command. The rest of this guide
writes `navide-plugin`; run it as `npx navide-plugin` (or through a
`package.json` script).

> The Registry repository also contains an older Python `navide-plugin`
> (`marketplace/registry/registry/cli.py`). It is deprecated for plugin
> authors and prints a notice saying so; it stays only for Navide's own
> first-party release scripts. Both CLIs read the same credentials file and
> produce signatures the Registry verifies the same way.

## 1. Create a plugin

```bash
navide-plugin init acme-hello --id acme.hello
```

`--id` is `<namespace>.<name>`: lowercase letters, digits and hyphens. The
namespace is the one you will claim on the Marketplace, and the id never
changes once published. `--name "Acme Hello"` sets the display name (default:
derived from the id). `init` refuses a directory that is not empty.

It writes a frontend-only plugin that validates and packages as is:

```text
acme-hello/
├── manifest.json          # Manifest v2: id, version 0.1.0, one main view
├── frontend/main/index.html
├── frontend/main/main.js
├── README.md              # shown on your listing page
├── artifact-files.json    # the exact files that go into the package
└── .gitignore             # keeps *.key, *.vsix and *.sig out of Git
```

Edit `manifest.json` — `marketplace.description`, `marketplace.license`,
`permissions`, views — following FORMAT.md. Keep `permissions` to what the
plugin actually calls; the reviewer sees every permission you request.

For a real project with a build step (TypeScript, Vite, Vue), keep your source
elsewhere and let the build write a staging directory such as `dist/package`
with this same shape; the
[Recommended source project](plugin-development-v2.md#recommended-source-project)
shows one. Every file the package contains must be listed in
`artifact-files.json` — the packager never zips a directory recursively, so
source files, keys and `node_modules` cannot slip in.

## 2. Validate and package

```bash
navide-plugin validate acme-hello
navide-plugin package acme-hello
```

`package` writes `acme.hello-0.1.0-universal.vsix` (`--out` picks another
path). The archive is deterministic: packaging the same files again gives the
same bytes and therefore the same digest.

### Packages with a native backend: one package per target

A frontend-only plugin is published once, as `universal`. A plugin with a
`backend` is published once per platform target — `darwin-arm64`,
`linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64` are the targets Navide
ships for — and each package contains the one executable built for that
target:

```bash
navide-plugin package dist/package --target darwin-arm64
```

The SDK packages a backend only for the machine it runs on (`--target` must
equal the host's `<platform>-<arch>`), so build and package each target on a
machine of that platform, for example a CI matrix with one runner per target.
Write `backend.entry` without an extension (`backend/acme-hello`); on
`win32-*` targets the package must contain `backend/acme-hello.exe` instead.
See FORMAT.md, "Targets and backend entry".

### Test a native backend before publishing

A backend runs in Navide only inside the OS sandbox, after the user allows it,
and only answers the methods and events it declares. Publishing one also needs
an administrator to allow your namespace for native backends, a verified
publisher domain, `engines.navide` of at least `>=0.2.14`, a non-empty
`backend.methods`, and no `shell` permission. See
[plugin-development-v2.md](plugin-development-v2.md), "Third-party backends".

`dev-backend` runs your built backend the same way, so what works here works
in Navide:

```bash
# one call, then exit (exit code 1 when the call fails)
navide-plugin dev-backend dist/package --call files.search --args '{"query":"todo"}'

# subscribe first, then watch events arrive while the call runs
navide-plugin dev-backend dist/package --subscribe files.indexProgress --call files.index

# interactive: type `<method> [json]`, `:subscribe <event>`, or `:quit`
navide-plugin dev-backend dist/package
```

- It uses the exact sandbox profile Navide uses: `sandbox-exec` on macOS;
  `bwrap` on Linux, and a clear refusal when bubblewrap or unprivileged user
  namespaces are unavailable; Windows is not supported yet.
- The backend's `HOME` and `TMPDIR` are a private data directory
  (`<directory>/.navide-dev/data`, or `--data <directory>`), which is also the
  only writable place. It has no network access and cannot read your home
  folder.
- Calls to methods, and subscriptions to events, that `manifest.json` does not
  declare are refused before they reach the backend, as in Navide.
- The Host bridge is not emulated: each `navide/host/call` the backend makes
  is printed and answered with `CAPABILITY_DENIED`.
- Results print as `← result`, events as `← event`, and the backend's stderr
  as `[backend]` lines.

## 3. Test against a local registry

A local Registry exercises the same publish checks as the Marketplace without
an account. From the Navide checkout:

```bash
node -p 'require("crypto").randomBytes(24).toString("base64url")' > /tmp/navide-registry-admin-token
REGISTRY_DATA_DIR=/tmp/navide-registry REGISTRY_ADMIN_TOKEN="$(cat /tmp/navide-registry-admin-token)" \
  uv --project marketplace/registry run uvicorn registry.app:app --port 8787
```

In another terminal, from your plugin project, create a key and register
yourself as a local publisher (on a local Registry the admin token stands in
for the Navide Cloud steps in section 4):

```bash
navide-plugin keygen --out-dir keys --name acme
export NAVIDE_PLUGIN_TOKEN="$(node -p 'require("crypto").randomBytes(24).toString("base64url")')"
node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({name:"acme",token:process.env.NAVIDE_PLUGIN_TOKEN,public_key:fs.readFileSync("keys/acme.pub","utf8")}))' \
  | curl -sS -X POST http://127.0.0.1:8787/api/publishers \
      -H @<(printf 'X-Admin-Token: %s\n' "$(cat /tmp/navide-registry-admin-token)") \
      -H "Content-Type: application/json" --data-binary @-

navide-plugin sign acme.hello-0.1.0-universal.vsix --key keys/acme.key
navide-plugin publish acme.hello-0.1.0-universal.vsix --registry http://127.0.0.1:8787 \
  --signature acme.hello-0.1.0-universal.vsix.sig
curl -sS "http://127.0.0.1:8787/api/extensions?q=hello"
```

`publish` reads the token from `NAVIDE_PLUGIN_TOKEN`, so it never appears on
a command line; the throwaway Registry's admin token stays in
`/tmp/navide-registry-admin-token` and reaches curl through a header file for
the same reason.

A publisher created with the admin token is trusted, so its versions are
listed at once; a namespace claimed on the Marketplace is reviewed first
(section 5). To install from the local Registry in a development build of
Navide, point the app at it as described under **Registry endpoints** in the
[Plugin development guide](plugin-development.md#packaging-and-publishing).

## 4. Publish to the Marketplace

### Sign in and claim a namespace

1. Open <https://server.navide.dev/registry/publish> and sign in with your
   Navide account.
2. Open **Claim a namespace** (`/publisher/claim`), check a name and claim it.
   Namespaces are first come, first served; reserved words (`navide`,
   `official`, …) and look-alikes of an existing namespace are refused, and an
   account holds at most three. The namespace must equal the first segment of
   your plugin id and its `publisher` field.

### Create and register your signing key

```bash
navide-plugin keygen --out-dir keys --name acme
```

This writes `keys/acme.key` (private, owner-only, never overwritten) and
`keys/acme.pub`. Paste the contents of `keys/acme.pub` into **Signing key** on
your namespace's dashboard (`/publisher/acme`) and press **Save public key**.
Keep `acme.key` out of Git and out of your package; anyone holding it can sign
submissions for your namespace.

### Log in from the CLI

```bash
navide-plugin login
```

The CLI opens the Marketplace in your browser and waits. Pick the namespace,
press **Authorize**, and the browser hands a one-time code back to the CLI on
a `127.0.0.1` port; the CLI exchanges it (with a PKCE verifier) for a publish
token valid for 30 days. The token is stored in
`~/.config/navide-plugin/credentials.json` (mode `0600`;
`$XDG_CONFIG_HOME` or `$NAVIDE_PLUGIN_CONFIG_DIR` move it). On a machine
without a browser, add `--no-browser` and open the printed URL yourself — the
browser must run on the same machine, because the code returns to
`127.0.0.1`.

```bash
navide-plugin whoami     # namespace and token expiry
navide-plugin logout     # forget the stored token
```

`logout` only deletes the local copy. To invalidate a token on the Registry,
revoke it under **Publisher tokens** on the dashboard. For CI, create a token
there and pass it as `NAVIDE_PLUGIN_TOKEN` instead of logging in.

Commands that talk to a Registry use `--registry`, then
`$NAVIDE_REGISTRY_URL`, then `https://server.navide.dev/registry`. `login` and
`publish` send your token, so they refuse a plain `http://` Registry unless it
is on loopback (`127.0.0.1`, `localhost`, `[::1]`); `--insecure-http`
overrides that for a local development host and prints a warning.

### Sign and publish

```bash
navide-plugin sign acme.hello-0.1.0-universal.vsix --key keys/acme.key
navide-plugin publish acme.hello-0.1.0-universal.vsix \
  --signature acme.hello-0.1.0-universal.vsix.sig
```

The signature is an Ed25519 signature over the package's SHA-256 digest; the
Registry checks it against the key you registered and refuses the upload with
`403 invalid package signature` if they do not match. `publish` takes the
token from `NAVIDE_PLUGIN_TOKEN`, then `login`. A `--token` argument still
works, but it is visible to other processes and kept in shell history, so
`publish` warns when you use it.

For a backend plugin, sign and publish each target's package with its target:

```bash
navide-plugin publish acme.hello-0.1.0-darwin-arm64.vsix --target darwin-arm64 \
  --signature acme.hello-0.1.0-darwin-arm64.vsix.sig
```

A successful upload answers `201` with `"review_status":"pending"`.

## 5. Review

Every version from a claimed namespace is reviewed by a person before it is
public. Until then it is invisible to search, the listing page and the Navide
app. The reviewer sees:

- **Signature** — whether the upload carried a valid publisher signature.
- **Name similarity** — your extension's name compared with existing ones. A
  near-copy of another extension's name blocks approval; a merely similar name
  is shown as a warning.
- **Secret scan** — the package contents are scanned for API keys, tokens and
  private key blocks (AWS, GitHub, Slack, Google, Stripe, Anthropic, OpenAI,
  npm, PEM private keys). Findings list the file and line only, never the
  value. A finding is not approved unless the reviewer marks it a false
  positive, so remove real secrets and publish a new version.
- **Permissions** — every `permissions` entry, with sensitive ones flagged.
- **Size** — against the 200 MiB limit.

The target is a decision within **3 business days**; there is no automatic
approval. Approval signs the version with the Registry key and lists it.
A rejection carries a reason, shown next to the version under **Versions &
review status** on your dashboard; fix it and publish a new version (a
version number, once used, cannot be reused).

All targets of one version are decided together. If you upload another target
while a version waits, the reviewer reloads and decides on the full set.

## 6. Pre-releases

A version with a SemVer pre-release suffix is a pre-release:

```json
"version": "0.2.0-beta.1"
```

Pre-releases go through the same review. They never become the
`latest_version` while a stable version exists; the Registry reports the
newest one as `latest_prerelease_version` until a newer stable version is
published, and Navide installs it only for users who turn on **Get
pre-releases** for your extension. Build metadata (`1.0.0+build.7`) does not make a
version a pre-release.

## 7. Extension packs

An Extension Pack installs a set of plugins together. It is a manifest with
`extensionPack` and nothing else to run:

```json
{
  "schemaVersion": 2,
  "apiVersion": "^1.0.0",
  "id": "acme.starter-pack",
  "name": "Starter Pack",
  "version": "1.0.0",
  "publisher": "acme",
  "permissions": {},
  "marketplace": { "description": "Acme's starter plugins.", "license": "MIT" },
  "extensionPack": ["acme.hello"]
}
```

With `{"files": ["manifest.json"]}` as its `artifact-files.json`, it packages,
signs and publishes like any frontend-only plugin (as `universal`). A pack has
no views, backend or permissions, lists 1–20 members, may not list itself, and
may not contain another pack. Navide confirms each member separately, with
that member's own permissions. Packs are listed under the `extension-packs`
category.

## 8. Yank a version

Yanking withdraws a version on every target: Navide no longer installs it or
updates to it, and it accepts no further targets. Copies already installed are
not removed. Use a dashboard token (or the one `login` stored) as
`NAVIDE_PLUGIN_TOKEN`; the header goes to `curl` on standard input so the
token stays out of the process list:

```bash
printf 'Authorization: Bearer %s\n' "$NAVIDE_PLUGIN_TOKEN" \
  | curl -sS -X POST -H @- https://server.navide.dev/registry/api/extensions/acme/hello/0.2.0-beta.1/yank
```

A yank cannot be undone; publish a new version instead.

## 9. How users report an extension

Anyone signed in with a Navide account can report a listing with **Report it**
on the extension's page on the Marketplace website
(`/extensions/<namespace>/<name>/report`); a signed-out visitor is sent to
sign in first and then returned to the form. A report names one reason —
malware, impersonation, spam, broken, or other — with optional details. A
member keeps at most one open report per extension and files at most 5
reports an hour.

Reports appear under **Reports from users** on your dashboard with their
status and the moderator's resolution; the reporter's identity is not shown.
Moderators handle them in the admin queue (`/admin/reports`) and either
dismiss a report or act on it: yank the version, or block the package or the
publisher. Removals, and why, are listed publicly at
<https://server.navide.dev/registry/removed>.

## Troubleshooting

| Message | Cause and fix |
|---|---|
| `navide-plugin: ... is not a safe package-relative path` / `is outside the frontend/assets/backend package boundary` | A path in `artifact-files.json` escapes the package layout. Keep files under `frontend/`, `assets/` or `backend/`, plus `manifest.json` and `README.md`. |
| `... is source-only or secret material` | A `.ts`, `.vue`, `.map`, `package.json`, lock file, `node_modules`, `tests`, `.env` or key file is listed. Ship build output only. |
| `manifest references '...', but that file does not exist` | A view `entry`, icon or the backend entry is missing from the staging directory or from `artifact-files.json`. |
| `backend package target '...' must match the build host target '...'` | Package each backend target on a machine of that platform and architecture. |
| `frontend-only package target must be 'universal'` | Drop `--target` for a plugin without a backend. |
| `private key must have owner-only permissions` | `chmod 600 keys/acme.key`. |
| `EEXIST: file already exists` from `keygen` | `keygen` never replaces a key. Use the existing one, or another `--name`. |
| `publish needs NAVIDE_PLUGIN_TOKEN or navide-plugin login` | Run `navide-plugin login`, or set `NAVIDE_PLUGIN_TOKEN`. |
| `refusing to send a publish token to http://... over plain http` | Use the Registry's `https://` URL. Plain http is accepted only for a loopback Registry, or with `--insecure-http` on a local development host. |
| `401 invalid publisher token` | The token expired (30 days) or was revoked. Run `navide-plugin login` again; `whoami` shows the expiry. |
| `403 package signature is required` / `403 invalid package signature` | Sign the exact file you upload with the key whose `.pub` is on your dashboard. Re-packaging after signing changes the digest — sign again. |
| `403 publisher 'x' is not entitled to namespace 'y'` | The plugin id's namespace is not the one the token belongs to. Log in again and pick the right namespace, or fix the id. |
| `409 ...` on publish | That version and target already exist (or the version is universal and you sent a platform target, or the reverse). Bump the version. |
| `login state mismatch` / `login timed out waiting for the browser` | Start `navide-plugin login` again and finish in the browser within 5 minutes; the authorize page must be opened on the same machine. |
| The authorize page says you need a namespace | Claim one first (section 4). |
| The version is not in search | It is waiting for review (`review_status: pending`) or was rejected; check **Versions & review status**. |

## Command reference

```text
navide-plugin init <directory> --id <namespace.name> [--name <display name>]
navide-plugin validate <directory> [--target <target>]
navide-plugin package <directory> [--target <target>] [--out <file>]
navide-plugin keygen [--out-dir <directory>] [--name <name>]
navide-plugin sign <package> --key <private-key> [--out <signature>]
navide-plugin verify <package> --key <public-key> --signature <signature>
navide-plugin login [--registry <url>] [--label <label>] [--no-browser] [--insecure-http]
navide-plugin whoami [--registry <url>]
navide-plugin logout [--registry <url>]
navide-plugin publish <package> [--registry <url>] [--target <target>] [--signature <file-or-value>] [--insecure-http]
navide-plugin dev-backend <directory> [--call <method>] [--args <json>] [--subscribe <event,...>] [--data <directory>]
```
