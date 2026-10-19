# Navide Marketplace Registry

Self-hosted plugin marketplace registry for the Navide / Agent-Team project.
Standalone FastAPI service, managed with [uv]. It does **not** touch the
Electron app or `backend/agent_team_backend/` — it is purely additive under
`marketplace/`.

See [`FORMAT.md`](./FORMAT.md) for the `.vsix`-style package format.

> **Deployment status.** The Official Registry is planned at
> `https://server.navide.dev/registry` (a path prefix on the Navide server
> host); packaged App builds point there by default. See
> [Deployment](#deployment-official-registry-at-servernavidedevregistry) for
> the container, secrets and operational requirements. Known limit before
> wider use: package blobs live on the local data volume
> (`LocalStorageBackend`). Schema changes go through
> [migrations](#schema-migrations); a version may carry one artifact per
> platform target (see [Per-target artifacts](#per-target-artifacts)).
> Third-party publishing is not open — see
> [the plugin development guide](../../docs/en-US/plugin-development.md).

## Run locally

```bash
# From the repo root; creates marketplace/registry/.venv on first run.
uv --project marketplace/registry run \
  uvicorn registry.app:app --reload --port 8787
```

Data (SQLite DB + package blobs) lands in `./.registry-data` by default;
override with `REGISTRY_DATA_DIR=/some/path`.

Health check: `curl http://localhost:8787/api/health` → `{"status":"ok"}`.

The `X-Admin-Token` endpoints (`POST /api/publishers`, `/featured` and the
`/api/admin/*` review/blocklist API) fail closed: while `REGISTRY_ADMIN_TOKEN`
is unset or blank they return `401` and log a warning. Set a token and send it
as `X-Admin-Token`. For a throwaway local registry only,
`REGISTRY_ALLOW_OPEN_ADMIN=1` leaves `/api/publishers` and `/featured` open
while no token is set (the startup log warns); `/api/admin/*` stays closed, and
the `official` profile refuses to start with it.

## Run tests

```bash
uv --project marketplace/registry run pytest marketplace/registry/tests
```

## HTTP API

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/health` | Liveness probe. |
| POST | `/api/publishers` | Register/update a publisher's Ed25519 public key + bearer token. Admin-gated by `X-Admin-Token`; `401` while `REGISTRY_ADMIN_TOKEN` is unset or blank (unless `REGISTRY_ALLOW_OPEN_ADMIN`) and on a missing or wrong token. |
| POST | `/api/publish` | Upload a `.vsix` package (multipart field `package`); requires a `Bearer` publisher token and (in strict mode) a valid `signature`. Validates manifest, verifies signature, stores blob + assets, appends a version artifact for `?target=` (default `universal`) with a trust tier. 409 on a duplicate (version, target), on mixing `universal` with platform targets in one version, or on a yanked version, and `409 TESTPLACE_NOT_OPEN` for `?channel=testplace`; 400 on a `?channel=` that is unknown or does not match the version's SemVer channel; 403 on cross-namespace/bad-signature, 401 on bad/missing token. |
| GET | `/api/extensions` | Search (`q`) over name/description/categories, newest first, paginated (`offset`, `limit`). |
| GET | `/api/extensions/{namespace}/{name}` | Extension detail + full version list, registry envelopes/signatures, and root-signed trust metadata. |
| GET | `/api/extensions/{namespace}/{name}/{version}/download` | Stream one artifact's blob **and increment** its download counter plus the aggregate one. `?target=` picks the artifact exactly (no fallback to `universal`); it may be omitted only when the version has a single artifact, else `400` lists the available targets. |
| POST | `/api/extensions/{namespace}/{name}/{version}/yank` | Soft-yank a version — every target's artifact of it (excluded from latest resolution, still downloadable by exact version). |
| POST | `/api/extensions/{namespace}/{name}/rating` | Retired: returns 401. Rating needs a Navide Cloud sign-in on the website (see below). |
| POST | `/api/extensions/{namespace}/{name}/featured` | Set the curation flag `{ "featured": bool }`. Admin-gated by `X-Admin-Token` (same gate as `/api/publishers`). |

`GET /api/extensions` also accepts `category` (exact category filter) and
`sort` (`updated` default, `downloads`, `rating`). Each summary now carries
`download_count`, `rating_average`, `rating_count`, `featured`, and
`latest_targets` (the targets `latest_version` is published for); each entry in
a detail's `versions` is one artifact, carrying its `target` and
`download_count`.

## Per-target artifacts

A package version is published as **either** one `universal` artifact **or**
one artifact per platform target (`<platform>-<arch>` as Node reports it, e.g.
`darwin-arm64`, `win32-x64`) — never both. Rows are unique on
(extension, version, target); a duplicate target returns `409`, and so does a
platform artifact for a version that is universal (or the reverse). Mixing is
refused because the Client prefers an exact platform match over `universal`,
so a mixed version would install different bytes depending on what was
published when, and only a frontend-only package — which has nothing
platform-specific to split — is ever universal.

- **Storage.** New blobs live at `{namespace}/{name}/{version}/{target}/package.vsix`.
  Each row stores its own key, so artifacts published before per-target
  support keep their `{version}/package.vsix` key and still download.
- **Signing.** The registry-signed envelope already binds `target`; each
  artifact gets its own envelope, and the Client rejects an envelope whose
  target is not its own host target (or `universal`).
- **Yank** applies to the whole version, so "latest" resolves to the same
  version on every platform. A yanked version accepts no further targets.
- **Latest.** `latest_version` is the newest non-yanked version across all
  targets. A Host whose target the latest version lacks gets a clear
  "no artifact for host target" error rather than an older version.
- **Client selection** (`src/main/plugins/pluginTarget.ts`
  `selectPluginArtifact`): among the chosen version's rows, the exact host
  target, else `universal`, else an error naming the available targets. The
  download then passes `?target=` for a platform artifact.
- **Older Clients** pick the first row of a version and download without a
  target, so a multi-target version gets them a `400` (or an envelope target
  mismatch) instead of an install; universal versions are unaffected.

## Schema migrations

`registry/migrations.py` holds numbered, idempotent steps recorded in the
`schema_migrations` table; `create_db_engine` runs pending ones at startup,
after `create_all` creates any missing tables. Each step checks the live
schema before changing it (so a fresh database records every step without
work) and runs with its record in one `BEGIN IMMEDIATE` transaction, so a
failed step leaves nothing behind and concurrent starters apply it once.
Steps so far: `1` discovery counter columns, `2` registry-signing columns,
`3` rebuild `extension_version` unique on (extension, version, target).
Add a step by appending to `MIGRATIONS` with explicit SQL; never edit an
applied one.

## Discovery website (p3-discovery)

A dependency-light, server-rendered marketplace site is mounted on the **same**
FastAPI app (Jinja2 templates + self-hosted CSS in `registry/web_templates/`
and `registry/web_static/`; no JS build, no CDN assets). The `/api/*` JSON API
is untouched.

| Method | Path | Renders |
|---|---|---|
| GET | `/` | Home: Featured section, browse grid, keyword search, category filter, sort (downloads/rating/updated). Cards show displayName, publisher, description, categories, downloads, rating, trust badge, sensitive-capability warning. |
| GET | `/extensions/{namespace}/{name}` | Detail: rendered README, screenshots, rating, downloads, per-version trust tier + declared capabilities, install hint, publisher. |
| GET | `/extensions/{namespace}/{name}/{version}/assets/{path}` | Serve an image/asset extracted from the package blob (allow-listed against the version's recorded assets). |
| — | `/static/*` | Self-hosted CSS. |

**README rendering + sanitization.** READMEs are extracted from the stored
`.vsix` blob and rendered with `markdown-it-py` configured with raw HTML
**disabled** (`MarkdownIt("commonmark", {"html": False})`). Any `<script>` /
`<img onerror=…>` in a README is escaped to inert text, and dangerous link
schemes (`javascript:` etc.) are dropped by the built-in link validator, so no
user-authored active markup is ever emitted (`tests/test_web.py`).

**Ratings and reports.** A signed-in Navide Cloud member rates an extension
1-5 on its detail page (one rating per member, changeable and removable;
publishers cannot rate their own). `rating_sum` / `rating_count` cache the
member ratings only; anonymous ratings from before sign-in was required are
kept in `legacy_rating_*` for audit and never counted (migration 6). Members
report an extension from `/extensions/{namespace}/{name}/report`; admins
dismiss or act (yank / block) at `/admin/reports`, every event lands in
`report_audit`, and publishers see reports on their dashboard without the
reporter's identity. Ratings and reports are rate-limited per member.

## Security model (p3-security + p3-publish)

**Signing.** Publisher Ed25519 signatures authenticate strict-mode submissions,
but publisher keys are not part of the Client trust contract. After validating
the publisher, namespace, manifest, and complete archive, the registry signs a
canonical JSON envelope binding the archive digest, package/version/target,
publisher, signer `keyId`, and signing time. Extension detail responses include
that envelope/signature and current signer/blocklist metadata signed by the
registry root. A Client accepts this metadata only after verifying it with an
App- or user-pinned root; `rootFingerprint` in a response is informational and
MUST NOT establish trust.

The default `self-hosted-dev` profile creates persistent owner-only keys and a
persistent signer lifecycle under `REGISTRY_DATA_DIR/trust/`. Its signed metadata
is explicitly labelled `self-hosted-dev` and carries the generated root
fingerprint so an operator can approve that root out of band. It never claims
Official Registry provenance. The `official` profile never generates trust
material: startup requires an explicit deployment config whose expected root
fingerprint must match the configured root key and the root pinned into the App
build. Registry root and signer private-key files must be regular, non-symlink
files with owner-only permissions; generated files are created as `0600`.

**Publisher auth + namespace entitlement.** Publish/yank require an
`Authorization: Bearer <token>` header; the token is matched (sha256) against
`Publisher.token_hash`. A publisher may only publish/yank under **its own
namespace** — the `namespace` half of the manifest `id` must equal the
authenticated publisher (else `403`).

**Trust tier (`registry/trust.py`).** Accepted versions are `signed-verified`
after the registry signature is created. Permissive dev mode may accept a
submission without a publisher signature, but it still centrally signs the
accepted artifact before exposing it to clients.

`manifest.requires` is the declared capability allowlist; `fs` and `terminal`
are flagged as **sensitive** (filesystem/shell reach). Trust tier + capabilities
+ sensitive-capabilities are exposed per version in the extension API for the
Extensions view to warn users. This is metadata/gating only — no runtime sandbox.

### Policy config (env)

| Var | Default | Effect |
|---|---|---|
| `REGISTRY_VERIFIER` | `ed25519` | `ed25519` (real) or `accepting` (dev). |
| `REGISTRY_REQUIRE_SIGNATURE` | `true` | Reject unsigned publishes. |
| `REGISTRY_REQUIRE_AUTH` | `true` | Reject anonymous publish/yank. |
| `REGISTRY_ADMIN_TOKEN` | _(unset)_ | Gates `POST /api/publishers` and `/featured` (compared in constant time). Unset or blank refuses them and `/api/admin/*` with `401`; required and non-empty for the `official` profile. |
| `REGISTRY_ALLOW_OPEN_ADMIN` | `false` | Local dev only: with no admin token, leave `/api/publishers` and `/featured` open instead of refusing them (`/api/admin/*` stays closed). Ignored once a token is set; rejected by the `official` profile. |
| `REGISTRY_TRUST_PROFILE` | `self-hosted-dev` | `self-hosted-dev` for persistent locally generated trust material, or `official` for explicitly provisioned production material. |
| `REGISTRY_TRUST_CONFIG_FILE` | _(unset)_ | Required with `official`; path to the complete signer, root, rotation, validity, and blocklist policy below. Rejected for the default profile. |
| `REGISTRY_ROOT_PATH` | _(unset)_ | Public path prefix when served behind a reverse proxy, e.g. `/registry`. Requests are accepted with the prefix forwarded unchanged (AWS ALB) or stripped by the proxy, and every link the website emits carries it. `/registry-evil/...` is not served. Do not combine with `uvicorn --root-path`. |
| `REGISTRY_FORWARDED_ALLOW_IPS` | `*` | Container only (`deploy/entrypoint.sh` passes it to uvicorn `--forwarded-allow-ips`, with `--proxy-headers`). Lets the ALB's `X-Forwarded-Proto` through, so `og:url`, `og:image` and the dashboard's `registry_url` come out `https://`. The default `*` assumes only the ALB can reach the container port; otherwise set it to the ALB's subnet, e.g. `10.0.0.0/16`. |

### Official Registry trust deployment

Set `REGISTRY_TRUST_PROFILE=official` and point
`REGISTRY_TRUST_CONFIG_FILE` at a deployment-owned JSON file:

```json
{
  "schemaVersion": 1,
  "profile": "official",
  "expectedRootFingerprint": "sha256:<App-build-pinned-SPKI-digest>",
  "rootPrivateKeyFile": "/run/navide-keys/navide-registry-root.pem",
  "signer": {
    "keyId": "registry-2026-02",
    "privateKeyFile": "/run/navide-keys/navide-registry-signer.pem",
    "status": "active",
    "notBefore": "2026-08-01T00:00:00Z",
    "notAfter": "2027-08-01T00:00:00Z"
  },
  "trustedSigners": [
    {
      "keyId": "registry-2026-01",
      "publicKeyFile": "/etc/navide/trust/registry-2026-01.pub",
      "status": "rotating",
      "notBefore": "2025-08-01T00:00:00Z",
      "notAfter": "2026-09-01T00:00:00Z"
    }
  ],
  "blockedPublishers": ["compromised-publisher"],
  "blockedPackages": ["compromised.package", "acme.demo@1.2.3"]
}
```

All fields are required and unknown or duplicate JSON keys fail startup. The
current signer signs newly accepted artifacts. `trustedSigners` publishes prior
or staged public keys for rotation without granting them access to current
private signing material. Status is root-signed policy: `active` and
time-bounded `rotating` signers can validate artifacts, `expired` signers cannot
create new envelopes, and `revoked` signers fail closed. Package and publisher
blocklists are part of the same root-signed metadata. Changing the official
root requires a matching App build pin (or an authorization chain rooted in the
previous key); a Registry response cannot introduce its own replacement root.

The official profile also rejects verifier, signature, or publisher-auth
downgrades at startup and requires `REGISTRY_ADMIN_TOKEN`; those controls remain
configurable for `self-hosted-dev`.

`rootPrivateKeyFile` is needed by this current implementation to refresh trust
metadata. Production deployment must provide it as protected secret material;
moving root signing to an offline/HSM-backed publisher can replace this file
seam later without changing the Client wire contract.

## Packaging CLI (`navide-plugin`)

> **Deprecated for plugin authors.** The public `navide-plugin` is the SDK CLI
> (`packages/plugin-sdk/bin/navide-plugin.mjs`, shipped in
> `@navide/plugin-sdk`): `init`, `validate`, `package`, `keygen`, `sign`,
> `login`, `whoami`, `logout`, `publish`. See
> [`docs/en-US/marketplace-publishing.md`](../../docs/en-US/marketplace-publishing.md).
> This Python CLI prints a deprecation notice and stays for
> `scripts/publish-first-party-plugins.sh` and the `plugin-packages.yml` CI
> pack job: the SDK packages a backend only for its own host target, while
> `pack --target` here packs every target on one Linux runner. Both CLIs share
> `~/.config/navide-plugin/credentials.json` and produce signatures this
> Registry verifies the same way (`tests/test_sdk_cli_compat.py`).

Console entry point (see `registry/cli.py`):

```bash
navide-plugin keygen  --out-dir . --name acme        # Ed25519 keypair -> acme.key/acme.pub
navide-plugin pack    ./plugin-src --out my.vsix      # frontend-only, universal
navide-plugin pack    ./backend-src --out mac.vsix --target darwin-arm64
navide-plugin sign    my.vsix --key acme.key --out my.sig
navide-plugin publish my.vsix --registry http://localhost:8787 \
  --signature my.sig [--target darwin-arm64]
```

`keygen` writes the private key owner-only (`0600`). `publish` reads the token
from `NAVIDE_PLUGIN_TOKEN` (or a stored `login`); a `--token` argument still
works but is visible in the process list. `login` and `publish` refuse a
plain-http registry that is not on loopback unless `--insecure-http` is given.
`--target` (default
`universal`) selects the Registry target bound into the signed envelope; a
package with a native backend must be published for its exact
`<platform>-<arch>` target.

`pack` requires `plugin-src/artifact-files.json` with a canonical `files` array
that names the manifest and every file to include. For a native backend, pass
the same `--target` when packing as when publishing so the executable path and
architecture are validated. `pack` reuses the format builder in
`registry/package.py`; `sign` reuses the Ed25519 primitives in
`registry/signing.py`.

## Deployment (Official Registry at server.navide.dev/registry)

The Registry runs as one container behind the load balancer that already
serves `wss://server.navide.dev/ws`, routed by the path rule `/registry/*`.
Deployment files live in `deploy/`:

| File | Purpose |
|---|---|
| `Dockerfile` | uv-built image, non-root user (uid 10001), data volume `/data`, health check on `/api/health`. Build context: `marketplace/registry`. |
| `deploy/entrypoint.sh` | Copies the key secrets into an owner-only directory, reads the admin token from a file, starts uvicorn. |
| `deploy/compose.example.yml` | Example Compose service: env, secrets, tmpfs key directory, data volume. |
| `deploy/official-trust.example.json` | Official trust config template (paths and the pinned root fingerprint; no secrets). |

**Path prefix.** Set `REGISTRY_ROOT_PATH=/registry`. An AWS ALB forwards the
path unchanged, which the app accepts; a proxy that strips the prefix works
too. The load balancer health check is `GET /registry/api/health`.

**Secrets.** The root and signer private keys must reach the process as
regular, non-symlink, owner-only (`0600`) files; the Registry refuses to start
otherwise. Docker/Swarm secrets are mounted `0444` (Compose file secrets keep
the host file's owner and mode), so `deploy/entrypoint.sh` copies
`/run/secrets/navide-registry-root.pem` and
`/run/secrets/navide-registry-signer.pem` into `/run/navide-keys/` (a tmpfs
owned by the container user) as `0600`, and the trust config points at those
copies. With Compose file secrets, make the host files readable by uid 10001
(`chown 10001:10001 <file>; chmod 0400 <file>`). Never bake keys into the
image. The container needs:

- `REGISTRY_TRUST_PROFILE=official`
- `REGISTRY_TRUST_CONFIG_FILE` pointing at the trust config (non-secret; mount
  it read-only). Its `expectedRootFingerprint` must equal the root pinned in
  the App build, `resources/official-registry-root.pem`
  (`sha256:89dd424a…a35367`); startup fails on a mismatch.
- `REGISTRY_ADMIN_TOKEN`, or `REGISTRY_ADMIN_TOKEN_FILE` naming a secret file
  (read by the entrypoint). It gates `POST /api/publishers` and
  `/featured`; generate it randomly and keep it out of shell history.

**Data volume and backup.** `/data` holds the SQLite index (`registry.db`) and
every package blob (`packages/`). Use a named volume or host directory, back
it up (stop-the-world copy or `sqlite3 registry.db ".backup …"` plus the
`packages/` tree), and run a single worker: SQLite is the only index.

**Availability.** Root-signed trust metadata expires 24 hours after it is
generated (a fresh copy per request). Each App revalidates installed Registry
plugins against the copy from its last successful refresh; once that copy is
older than 24 hours, for example during a Registry outage longer than a day,
installed Registry plugins are quarantined until the Registry answers again. Put
uptime monitoring and alerting on `https://server.navide.dev/registry/api/health`.

### Publishing first-party plugins

One-off admin step: register the `navide` publisher with its public key and a
bearer token (the token is stored hashed; keep the plaintext for publishing):

```bash
python3 - <<'PY'
import json, os, pathlib, urllib.request
body = {
    "name": "navide",
    "display_name": "Navide",
    "public_key": pathlib.Path(os.path.expanduser(
        "~/navide-signing/plugin_publisher.pub.pem")).read_text(),
    "token": os.environ["NAVIDE_PLUGIN_TOKEN"],
}
req = urllib.request.Request(
    "https://server.navide.dev/registry/api/publishers",
    data=json.dumps(body).encode(), method="POST",
    headers={"Content-Type": "application/json",
             "X-Admin-Token": os.environ["REGISTRY_ADMIN_TOKEN"]})
print(urllib.request.urlopen(req).read().decode())
PY
```

Then, from the repository root:

```bash
NAVIDE_REGISTRY_URL=https://server.navide.dev/registry \
NAVIDE_PUBLISHER_KEY=~/navide-signing/plugin_publisher.key \
NAVIDE_PLUGIN_TOKEN=<navide publisher token> \
scripts/publish-first-party-plugins.sh
```

The script builds, packs, signs and publishes `navide.git` as `universal` and
`navide.plans` for the host target (for example `darwin-arm64`), reusing the
`navide-plugin` CLI. `--skip-build` reuses `dist-plugins/`, `--only git|plans`
publishes one. Plans carries a PyInstaller backend, so each other target must
be built on a machine of that platform and architecture.

Running the script with the same version on each platform adds that
platform's artifact to the version (see
[Per-target artifacts](#per-target-artifacts)); re-running on one platform
returns `409` for the target already published.

### Publishing platform-specific first-party plugins

`navide.plans` carries a PyInstaller backend, so every target needs its own
build. `.github/workflows/plugin-packages.yml` (manual `workflow_dispatch`,
input `ref`) builds it on a runner of each target the app ships
(`darwin-arm64`, `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`),
checks the backend's architecture, and uploads
`navide.plans-<version>-<target>.vsix` plus a `.sha256` (kept 7 days). The
workflow has no secrets: signing and publishing stay on the maintainer's Mac.

```bash
gh workflow run plugin-packages.yml -f ref=<commit or tag>
gh run list --workflow plugin-packages.yml --limit 1   # note the run id

NAVIDE_REGISTRY_URL=https://server.navide.dev/registry \
NAVIDE_PUBLISHER_KEY=~/navide-signing/plugin_publisher.key \
NAVIDE_PLUGIN_TOKEN=<navide publisher token> \
scripts/publish-first-party-plugins.sh --from-run <run id> --version <version> \
  --target "linux-x64 linux-arm64" --yes
```

Without `--yes` the script downloads the packages (`gh run download`), checks
each sha256 and the manifest id/version, and prints what it would publish.
`--target` limits it to the listed targets; leave out any target already
published for that version, which would `409` and stop the run. A single
already-packed file goes through `--package <vsix> --target <target> --version
<version>`. Both modes refuse a target outside the app's shipped list and a
package whose manifest is not the expected id and version.

A backend entry is written without an extension (`backend/navide-plans`); for
a `win32-*` target the Registry reads it as `backend/navide-plans.exe` and
takes the extension in place of the POSIX exec bit, exactly as the Host's
`backendEntryOnDisk` does. `navide-plugin pack --target <target>` applies the
same rule, so a Windows build packs and publishes like any other target.

## Third-party publishing (Phase 2)

Self-service publishing is on when the four `REGISTRY_AUTH_*`/session
settings below are set; without them the registry behaves exactly as before
(admin-created publishers only).

- **Sign in** (`/publish`, `/login`, `/auth/callback`): the registry is the
  `registry` client of navide-auth (forum.navide.dev/navide-auth). It signs the
  request with its own client secret, checks the returned signature, `client`,
  nonce (bound to a 10-minute login-state cookie), freshness and
  `email_verified`, then sets its own HttpOnly, Secure, SameSite=Lax session
  cookie (path = `REGISTRY_ROOT_PATH`). Only the member id, display name and
  email-verified flag are received; no Navide account token is involved.
- **Namespaces** (`/publisher/claim`): first come, first served; reserved words
  (`navide`, `official`, …) and look-alikes (`nav1de`, or a folded match of an
  existing namespace) are refused; at most 3 per account
  (`Publisher.navide_member_id`). A claimed namespace is review-required.
- **Review** (`/admin/review`, `GET /api/admin/review`,
  `POST /api/admin/review/{ns}/{name}/{version}/approve|reject`): uploads to a
  review-required namespace are stored `pending`, unsigned and invisible to
  every public read; approval registry-signs them, rejection needs a reason the
  publisher sees. Admin-created publishers (the official `navide` namespace)
  stay auto-approved. The queue shows name similarity (warn/block), a secret
  scan (file and line only, never the value), requested permissions and size.
  A similarity block cannot be approved; secret findings need an explicit
  false-positive acknowledgement. Target: 3 business days, no auto-approve.
  A decision carries the package digests the queue showed (`artifacts` in the
  JSON body, `artifact` form fields); if the pending set differs — a target was
  uploaded meanwhile — it is refused with 409 and the reviewer reloads.
- **Dashboard** (`/publisher/{ns}`): versions with review status and reasons,
  short-lived revocable tokens (≤ 90 days, stored as sha256), the signing
  public key, and optional DNS TXT verification
  (`_navide-verify.<domain>` = `navide-verify=<token>`) for a verified badge.
- **Blocklist** (`/admin/blocklist`, `/api/admin/blocklist`): entries join the
  trust-config lists in publish refusal and the signed trust metadata, and hide
  the package/publisher from public reads. `/removed` and `/api/removed` list
  every removal.
- **CLI**: `navide-plugin login --registry URL` opens the browser, receives a
  one-time code on a `127.0.0.1` loopback redirect (checked against a random
  `state`), and exchanges it with a PKCE verifier for a 30-day token stored in
  `~/.config/navide-plugin/credentials.json` (0600). `publish` uses it when no
  `--token`/`NAVIDE_PLUGIN_TOKEN` is given. No password is ever typed into the
  CLI.

| Variable | Default | Meaning |
|---|---|---|
| `REGISTRY_AUTH_URL` | _(unset)_ | navide-auth base, e.g. `https://forum.navide.dev/navide-auth`. |
| `REGISTRY_AUTH_SECRET` / `_FILE` | _(unset)_ | This registry's navide-auth client secret (≥ 32 chars; equals navide-auth's `REGISTRY_CONNECT_SECRET`, never the Discourse secret). |
| `REGISTRY_AUTH_RETURN_URL` | _(unset)_ | Exact callback, e.g. `https://server.navide.dev/registry/auth/callback`; must be in navide-auth's `REGISTRY_RETURN_URLS`. |
| `REGISTRY_SESSION_SECRET` / `_FILE` | _(unset)_ | Signs the session and login-state cookies (≥ 32 chars, different from the auth secret). |
| `REGISTRY_ADMIN_MEMBER_IDS` | _(empty)_ | Comma-separated Navide member ids allowed into the review queue and blocklist UI. |
| `REGISTRY_COOKIE_SECURE` | `true` | `false` only for a plain-http local run (then http auth URLs are accepted). |

## Seams left for later Phase 3 todos

- **Discovery frontend** (`p3-discovery`): ✅ built — the server-rendered
  website above. Consumes the same repository layer as `GET /api/extensions`
  (search/category/sort) and `GET /api/extensions/{ns}/{name}`.
- **Extensions view** (`p3-lifecycle`): the in-app view install/update/remove
  drives off the version list + `download` endpoint. It needs, per version:
  `download` URL (streams the blob) and the `X-Package-Digest` response header
  for integrity verification; `latest_version` (summary/detail) resolves
  updates; and the trust fields already exposed — `trust_tier`, `capabilities`,
  `sensitive_capabilities`, `signed` — to gate/warn on install. Download counts
  and ratings are now also available for in-app display.
- **CDN storage** (real storage): `registry/storage.py` — `StorageBackend`
  protocol; only `LocalStorageBackend` is implemented. Drop in S3/CDN behind
  the same protocol.

[uv]: https://docs.astral.sh/uv/
