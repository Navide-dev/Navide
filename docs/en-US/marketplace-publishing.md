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

> **Every view must report that it has mounted.** Navide waits 10 seconds
> after a view's HTML loads; at install and update time a view that has not
> reported ready fails the package. The scaffold's `main.js` reports ready
> itself with `window.nav.ready()`, the call
> `createPluginViewRuntimeClient().ready()` makes, so it installs as written.
> Once a view has a build step, bundle it with `@navide/plugin-sdk` and call
> `createPluginViewRuntimeClient().ready()` after mounting instead; the SDK
> factories are described under
> [SDK interface](plugin-development-v2.md#sdk-interface). Navide never calls a
> `definePlugin` activation function.

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
publisher domain, `engines.navide` of at least `>=0.2.14`, and a non-empty
`backend.methods`. A backend package may also declare `shell: "allowlist"`
(shown to users as high risk, including that git/gh/glab can contact network
hosts and send workspace data); it then needs `engines.navide` of at least
`>=0.2.25`. `shell: "full"` is not available with a backend. See
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
[Plugin development guide](plugin-development.md#packaging-and-publishing). A
packaged build honors those settings only while Developer Mode is on
(Settings → Navide Plugins); with it off it uses the Navide Marketplace.

This is one way to try a package inside Navide before publishing; the others are
Settings → Navide Plugins → **Install from .vsix file…**, which works in any
build and installs the file you pick as an unreviewed local package (it never
updates automatically), and Developer Mode → **Load from folder…**, which runs
your working folder with its view and backend and reloads it as you edit. There
is no `navide-plugin dev` command, and the development-build variable
`AGENT_TEAM_PLUGIN_DEV_PATH` writes no capability grant, so it cannot open a
Manifest v2 view and refuses a backend. A Registry or file install
grants the declared permissions and storage for that exact version when you
choose **Restart Plugin**.

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

### How Navide labels the source

Navide shows where every installed Navide plugin came from, as a badge in the
installed list and on Marketplace results and detail pages, and as a fixed
**Source and review** row on every disclosure card. Only a Registry-signed
version reads as reviewed (**Reviewed**, or **Pre-release (reviewed)**). A
package installed from a local file or a developer folder is labelled as
such, its scan line reads "Not scanned (only Navide plugins installed from the
Navide Marketplace are scanned by Navide)", and an unsigned one shows its
publisher as **Self-declared**. No source is ever called verified or safe on
these labels.

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

A publish may name its channel with `?channel=stable` or
`?channel=pre-release`; it must match the version (`400` otherwise). Leaving
it out derives the channel from the version as above. `?channel=testplace`
publishes an invite-only test build that expires after 90 days (see
[Testplace](#testplace) below); it needs a publisher token of a namespace
whose developer qualification is approved. Public listings, details and
downloads never include a testplace version. Its
Registry envelope carries `channel` and `expiresAt` inside the signature, so
an App released before Testplace refuses it, and a current App refuses it
after it expires (`TESTPLACE_EXPIRED`) or when the channel is one it does not
know (`CHANNEL_UNSUPPORTED`).

A user who has not installed your Navide plugin yet can pick **Install *version*
(pre-release)** on its Marketplace page. That installs the newest pre-release and
turns on **Get pre-releases** for your Navide plugin only; Install keeps taking
the stable version. A Navide plugin with only pre-releases is installed this
way. Navide labels a pre-release **Pre-release (reviewed)**, never unreviewed.
`navide-plugin publish` says so when the Registry records a pre-release.

### Pre-release, Testplace or a local install

Pick by who should get the build and whether it must be reviewed first.
Testplace needs Navide 0.2.27 or later on the tester's side.

| | Pre-release | Testplace | Local install |
|---|---|---|---|
| Who can install it | Everyone who turns on **Get pre-releases** for your Navide plugin, or picks **Install *version* (pre-release)** | Only the testers you invite (up to 100 per Navide plugin) | Anyone you send the `.vsix` file to |
| Review | Same review as a stable version | Automated scan only for invited testers; a public test code adds a light human review | None; Navide does not scan it |
| Signed by the Navide Marketplace | Yes | Yes | No (your publisher signature at most) |
| Label in Navide | **Pre-release (reviewed)** | **Test build, no human review, expires *date*** | **Local file**, with "not reviewed by Navide" |
| Expires | No | After 90 days; the Navide plugin is turned off and its data kept | No |
| How users get it | The Navide Marketplace, as an update or with **Install *version* (pre-release)** | The Navide Marketplace, after accepting the invitation | **Install from file**, after a separate consent |

繁體中文：

| | 預覽版 | Testplace | 本機安裝 |
|---|---|---|---|
| 誰能安裝 | 對你的 Navide 外掛打開「接收預覽版」，或選「安裝 *版本*（預覽版）」的所有人 | 只有你邀請的測試者（每個 Navide 外掛最多 100 位） | 你把 `.vsix` 檔案寄給的任何人 |
| 審核 | 和正式版相同的審核 | 受邀測試者只跑自動掃描；公開測試碼另有輕量人工審核 | 沒有；Navide 不會掃描 |
| Navide 市集簽章 | 有 | 有 | 沒有（最多只有發佈者自己的簽章） |
| Navide 裡的標記 | 「預覽版（已審核）」 | 「測試版，沒有人工審核，*日期* 到期」 | 「本機檔案」，並註明未經 Navide 審核 |
| 到期 | 不會 | 90 天後到期；Navide 外掛會停用、資料保留 | 不會 |
| 使用者怎麼取得 | 從 Navide 市集更新，或選「安裝 *版本*（預覽版）」 | 接受邀請後從 Navide 市集安裝 | 另外同意後「從檔案安裝」 |

日本語：

| | プレリリース版 | Testplace | ローカルインストール |
|---|---|---|---|
| インストールできる人 | その Navide プラグインで「プレリリースを受け取る」をオンにした人、または「*バージョン* をインストール（プレリリース）」を選んだ人全員 | 招待したテスターのみ（Navide プラグインごとに最大 100 人） | `.vsix` ファイルを受け取った人なら誰でも |
| 審査 | 正式版と同じ審査 | 招待テスターは自動スキャンのみ。公開テストコードには簡易な人による審査が加わります | なし。Navide はスキャンしません |
| Navide マーケットプレイスの署名 | あり | あり | なし（あっても発行者自身の署名のみ） |
| Navide での表示 | 「プレリリース版（審査済み）」 | 「テスト版。人による審査なし。*日付* に期限切れ」 | 「ローカルファイル」、Navide の審査を受けていない旨を表示 |
| 有効期限 | なし | 90 日後。Navide プラグインは無効になり、データは残ります | なし |
| 入手方法 | Navide マーケットプレイスからの更新、または「*バージョン* をインストール（プレリリース）」 | 招待を受け入れたあと Navide マーケットプレイスから | 別途同意したうえで「ファイルからインストール」 |

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
