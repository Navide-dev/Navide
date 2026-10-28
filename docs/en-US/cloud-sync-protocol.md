# Cloud sync protocol (v1)

The wire contract between the Navide desktop backend (client) and
Navide-Server (server) for syncing the four Settings → INTEGRATIONS sections
across a user's devices. Both sides implement this file; neither invents
fields on its own.

Approved plan: `.agent-team/plans/cloud-sync-integrations_4d8e63.html`.

## Shape

Sync rides the existing control-plane link (`server_link.py` →
`wss://server.navide.dev/ws`). It adds message types, not a connection, so it
opens no new inbound surface. The envelope is the one already in use:

```
request   {id, type, payload}
response  {id, type: "<type>.result", ok, payload|error}
event     {type, payload, timestamp}      server push, no id
```

## Model

One **item** is one logical row in one **scope**. Scopes are exactly:

| scope | carries |
|---|---|
| `prompts` | prompt-skill records |
| `mcp` | Navide-owned MCP server records (never the native reflection) |
| `skills` | skill enable/route state (content is Phase 4, not v1) |
| `memory` | user-scope instruction-file records (never project scope) |
| `credentials` | retired: credentials and keys never leave the user's machine (see below) |
| `skill-files` | file manifests of skills too large for one `skills` record (see Blobs) |

`skill-files` is not a switch of its own: it rides with `skills`. It is a
separate scope rather than a field on the `skills` record on purpose — a
client that predates blobs stores a `skills` record as `{enabled, targets}`
and pushes that shape back, so a manifest added as a field would be silently
erased by the first old client that saw it. Old clients never pull
`skill-files`, so they keep syncing settings only and cannot damage anything.

**Account credentials and keys never leave the user's machine** (policy of
2026-10-21). MCP records, when their sync is on, still travel as ciphertext
sealed on the device; the server has no key to open them. From 0.2.32 they are
install-only: a client sends every env and header value as `""` (names kept)
and, on receive, ignores the values a record carries and keeps its own.

A credential inside the `url` or the `args` is emptied the same way, in
place, by the value rules the MCP page masks with (`native_mcp._mask_url`,
`_mask_args`): URL userinfo becomes `scheme://@host`, a secret-named query
parameter keeps its name with an empty value (`?api_key=`), a token-shaped
argument (`ghp_…`, `sk-…`) becomes `""`, the argument after a secret-named
flag (`--token X`) becomes `""`, and a secret-named pair keeps its name
(`--api-key=`, `X-Api-Key:`). Each argument keeps its position. A url or
argument with nothing detected travels exactly as written. On receive, an
emptied url or argument is filled from this machine's own server of the same
name when the record's endpoint is this machine's (below); then the url
strips to the same text, and each argument fills from the same position.
Anything else stays empty, and Settings → MCP marks the server "Needs setup".
The stripped form is what a client compares (`McpScope.snapshot` and
`inbound` both strip), so a record an earlier build sent with a credential
in it reads as the same record and is neither pushed over nor in conflict;
its credential is ignored and this machine keeps its own.

This machine's values are bound to its endpoint. A receiver fills in its own
env and header values and its url and argument credentials only when the
record runs what its own server of that name runs: the same transport, and
the same command and args (stdio) or the same url (http/sse), both compared
stripped (`McpScope`'s `_same_endpoint`, which applies the rule a settings-bundle
import restores secrets by, `mcp_settings._same_endpoint`). A record that
changed any of them, approved or not, gets none of this machine's values:
every env and header value, and every emptied credential, lands empty, and
Settings → MCP marks the server "Needs setup". Changing only env or header
names, or the on/off switch, keeps the values; a name the record adds lands
empty.

Install-only records travel under their own item ids, `i:<name>`. A 0.2.32
client never writes or deletes a `<name>` row: those rows are what clients
before 0.2.32 keep, values included, and they apply a record as it comes, so
a definition without values there would empty theirs. It reads a `<name>` row
as a definition only until it has seen that server's `i:` row. Deleting a
server deletes its `i:` row; a device before 0.2.32 keeps its copy.

Older clients cannot use an `i:` row. 0.2.18 to 0.2.31 refuse it: no MCP
server name may hold ":" (`mcp_settings._NAME_RE`), `McpScope.apply` returns
False, and the engine records nothing for a refused row. 0.2.3 to 0.2.17 do
not: their `apply` swallows the store's refusal, the engine records the row
as held, and the next push sends a delete for it. So on legacy item ids an
`i:` row is sealed under the scope `mcp-install`
(`McpScope.seal_scope`): those builds cannot open it, drop it with a log
line, and record nothing. Hashed item ids keep `mcp`, because an account
that adopted them refuses clients before protocol v3. The
`credentials` scope name stays in the protocol only so rows an older desktop
already pushed can be pulled and purged: no client engine registers an adapter
for it or names it in a push (`sync_engine.LOCAL_ONLY_SCOPES`), a switch an
older build left on reads as off, `share.publish` drops it and empties MCP
env/header values from any bundle it is handed, and the server refuses every
`sync.push` to it with `SCOPE_RETIRED` whatever its deploy settings. The notes
below describe what clients before 0.2.28 did and are kept for that purge.

The `credentials` scope is, to the server, indistinguishable from the other
four: same tables, same handlers, same ciphertext-only `body`. What differs is
on the client (`sync_scopes.CredentialsScope`, flagged `sensitive`):

- `itemId` is `c-` plus 32 random hex characters, minted when a credential is
  first pasted and carried unchanged by every device that imports it. It is
  never derived from the vendor or slot — the server's rows say nothing about
  which CLIs an account uses — and it does not change when the account key is
  rotated.
- The body is `{"v": 1, "agentKey", "slotId", "value"}` and nothing else, so
  two devices that pasted the same token agree it is the same item.
- **A client never pushes a tombstone by absence** for this scope. A credential
  missing from a device's snapshot means "not set up here" or "removed here";
  neither is a reason to sign every other device out. There is no cloud-delete
  action in v1; removal is local. A device that removed a credential keeps a
  secret-free *disabled* mark so a later pull does not quietly bring it back —
  an explicit `pull_items` naming the item is what does.
- A record that will not open fails the round rather than being skipped, so
  the cursor never steps past a secret this device did not receive. A body
  sealed under a key the device does not hold yet (`UnknownKeyId`) holds the
  cursor at that row until a paired device hands over the newer ring.
- Conflict rows are stored sealed and listed as `{agentKey, slotId}` only; the
  inventory carries the same two fields as `meta` on each side.

An item is `{itemId, rev, updatedAt, deviceId, deleted, body, sig}`:

- `itemId` — stable within the scope, `^[A-Za-z0-9._:@+-]{1,200}$`.
- `rev` — assigned by the server, monotonic per `(account, scope)`. It doubles
  as the pull cursor. Clients never invent one.
- `updatedAt` — the writing device's ISO-8601 clock. Informational only:
  ordering is `rev`, never a wall clock, because device clocks disagree.
- `deviceId` — origin device. The server rejects a push whose `deviceId` is not
  the connection's own device, so origin cannot be forged.
- `deleted` — `0|1`. Deletes are tombstones so they propagate; `body` is null.
  (The `credentials` client never emits one by absence — see the scope notes
  above.)
- `body` — base64 of the **ciphertext**. The server stores it opaquely and has
  no key. Everything readable lives inside it.
- `sig` — the origin device's signature over the item, checked by receiving
  devices, not by the server.

## Requests

### `sync.pull`

```
payload   {scope, since?: number = 0, limit?: number = 200}   limit ≤ 500
result    {scope, cursor, items: [...], more: boolean}
```

Returns items with `rev > since`, ascending, tombstones included. `more` says
another page waits. A page is also capped by bytes (768 KiB of rows, at least
one row), because the reply is one WebSocket frame and a frame over 1 MiB
closes the client's link instead of arriving; a page cut short sets `more`.

`cursor` is the `rev` of the page's last row while `more` is true, and the
account's current max `rev` for the scope once it is false. Servers before the
byte cap always answer the max, so a client pages by the highest `rev` among
the rows it received — correct against both — and takes `cursor` only from the
last page. A client must also keep `limit` small enough that a page fits a
frame on a server without the byte cap. A `cursor` below the client's own
`since` means the server never issued the revs the client has read (another
account, or a reset server); the client starts that scope over from 0.

### `sync.push`

```
payload   {scope, items: [{itemId, baseRev, updatedAt, deleted?, body?, sig, refs?}]}
result    {scope, cursor, accepted: [{itemId, rev}], conflicts: [<item>], rejected?}
```

`refs` (optional, ≤ 256) lists the blob ids the record uses. Every ref must
be a complete blob of the same account, or the item is not written and comes
back in `rejected: [{itemId, code: "MISSING_BLOB", message, missing}]` — per
item, like a conflict, and without spending a `rev`. The ids replace the
item's previous set; a tombstone (which may not carry refs) empties it. The
server cannot read the sealed record, so this list is what blob garbage
collection goes by. A push without `refs` gets exactly the old result shape.

Conflict rows are capped by bytes too; one that does not fit the reply comes
back as `rejected: [{itemId, code: "CONFLICT_DEFERRED", rev}]` with no body. A
client records nothing for a rejected item, so the next round pushes it again
and meets the conflict then.

The push `cursor` is the scope's max `rev`, which may include another device's
write that landed after this client's pull. A client moves its read cursor
only across its own accepted revs that follow on from it without a gap, and
leaves the rest to the next pull.

A pushed item carries no `deviceId`: the server stamps the connection's own
device on every row it writes. One may be sent, and then it must equal the
connection's device — a client may state its origin but never claim another's.

`baseRev` is the `rev` the pushing device last saw for that item, `0` for one
it believes is new. Per item:

- `baseRev === current rev` → write, assign the next `rev`, list in `accepted`.
- otherwise → **write nothing**, return the server's current row in
  `conflicts`.

Conflicts are per item, so one conflict never blocks the rest of the batch.
The server does not merge and does not pick a winner — that is decision ① of
the approved plan: both sides are kept and the user chooses in the UI.

A **malformed** batch is refused whole (`BAD_REQUEST`), because that is a
caller bug rather than a race; a duplicate `itemId` inside one batch counts as
malformed, since the second copy would be compared against the `rev` the first
one just created and conflict with itself.

`baseRev > 0` for a row the server does not have means the item was deleted
elsewhere while this device thought it held it. The conflict entry is then
`{itemId, rev: 0, updatedAt: null, deviceId: null, deleted: 1, body: null,
sig: null}` — `rev: 0` says "never existed here", since server revs start at 1.
A client keeping its local copy pushes from `baseRev: 0` and re-creates it.

## Event

```
sync.changed   {scope, cursor}
```

Pushed to every **other** device of the account after an accepted write. The
pusher is not notified of its own write.

## Limits

| limit | value |
|---|---|
| items per push | 64 |
| `body` per item | 512 KiB |
| push payload total | 768 KiB |
| pull page | 500 items |

These are **frame** limits wearing item clothing. A push is one WebSocket
message and the server's `maxPayload` is 1 MiB, so anything larger never
reaches a handler at all: the socket closes with 1009 and the request never
resolves. The first version of this table said 1 MiB per body and 4 MiB per
push, neither of which could ever arrive — the checks for them were dead code
on both ends. The numbers above sit under the frame cap with room for the
envelope, and both are measured on the base64 `body` **as stored**, never on
its decoded length, because invariant 2 forbids decoding it.

Over-limit is `BAD_REQUEST`. Error codes reuse the existing set:
`BAD_REQUEST`, `AUTH_REQUIRED`, `FORBIDDEN`.

## Invariants the server must keep

1. Every statement carries the account from `accountOf(ctx)`. There is no other
   source of the scope key, so a forgotten condition is a missing parameter at
   compile time rather than a silent cross-account read.
2. `body` is never parsed, logged, or indexed. The server has no key and must
   not grow one.
3. A pushed item's `deviceId` must equal `ctx.deviceId`.
4. `account-isolation.mjs` covers cross-account isolation *and* invariant 3: a
   push naming another device's id is refused.
5. `rev` is strictly increasing per `(account, scope)`. It must come from a
   locked counter row, not from `MAX(rev) + 1`: under Postgres' default READ
   COMMITTED two concurrent pushes can read the same maximum, and a cursor that
   has passed one of two rows sharing a rev can never return the other.
6. Reading an item's current `rev` and writing over it is **one atomic step**.
   Two devices pushing the same `itemId` from the same `baseRev` must end as
   one `accepted` and one `conflicts` — never two `accepted`. Comparing first
   and writing afterwards leaves a window where both pass the comparison and
   the later write silently replaces the earlier one, which is the exact
   outcome decision ① of the plan exists to prevent: the client shows no
   conflict, because the server said both were fine. Taking the scope's
   counter-row lock at the start of the push is what closes it.

## Blobs

Small skills carry their files inside the `skills` record. A skill whose
sealed record would exceed the body limit keeps only its settings there, and
its files travel as **blobs**: one blob per file, stored in object storage
(S3), named in a `skill-files` record.

**The bytes never pass through the Navide server.** It checks ownership,
signs short-lived URLs (15 minutes), records sizes and references, and
finishes multipart uploads. Uploads go straight to object storage as a
multipart upload over presigned part URLs; downloads are one presigned GET of
the whole object (resumable with an HTTP `Range`). So neither the 1 MiB frame,
the load balancer, nor the server's memory is on the data path.

### Object format (version 2)

```
segment = nonce (12) ‖ AES-256-GCM(plaintext ≤ 1 MiB) ‖ tag (16)
AAD     = "navide/blob/v2" ‖ kid ‖ blobId ‖ segment index ‖ segment count
part    = 8 whole segments (8 MiB + 224 B); only the last part is shorter
```

Part `n` therefore starts at plaintext offset `(n-1) × 8 MiB`, which makes a
resumed upload a part-level question, and every part but the last is above
S3's 5 MiB minimum. An empty file is one empty segment. The segment count is
bound into every segment, so a truncated object cannot pass as a shorter
file. The layout is reported by `blobs.caps`; clients never hard-code it.

**Blob id** = HMAC-SHA256 of the plaintext under a key derived from the
account sync key (HKDF, info `navide/blob-id/v1`), 64 hex. Within one account
identical files share one blob; across accounts the ids cannot be compared,
and without the key the server cannot confirm a guess of a file. A plain
content hash would leak both. After a key rotation new uploads get new ids.

### Manifest (`skill-files` record body, sealed like any record)

```
{v: 1, files: {"<relative path>": {blob, kid, size, x?}}}
```

`size` is the plaintext size, `x` marks an executable file. The receiver
downloads every file, opens every segment, recomputes the blob id, and only
then swaps the whole skill in; until then the record is deferred (the pull
holds the cursor on it). A tombstone drops the record and never deletes files.

### Requests

| type | payload | result |
|---|---|---|
| `blobs.caps` | — | `{version: 2, segmentBytes, segmentsPerPart, partBytes, maxBlobBytes, maxRefs, quotaBytes, usedBytes, presignTtlS}`; `UNSUPPORTED` when the server has no object storage |
| `blobs.stat` | `{blobIds: [≤256]}` | `{blobs: [{blobId, state: complete\|partial\|absent, sizeBytes?, partCount?}]}` |
| `blobs.begin` | `{blobId, sizeBytes}` (sealed size) | `{state: complete}` (dedup) or `{state: partial, partBytes, partCount, parts: [{partNumber, size}]}` |
| `blobs.presignPut` | `{blobId, partNumbers: [1..100]}` | `{urls: [{partNumber, url}], expiresAt}` |
| `blobs.commit` | `{blobId}` | `{state: complete}`; `INCOMPLETE {missing}` names parts absent or of the wrong size |
| `blobs.presignGet` | `{blobId}` | `{url, sizeBytes, expiresAt}` |

`caps`, `stat` and `presignGet` count as reads for throttling. A client that
gets `UNKNOWN_TYPE` (older server) or `UNSUPPORTED` from `blobs.caps` does
not use `skill-files` and syncs large skills' settings only.

### Storage, quota, collection

Metadata (owner, size, part count, references, upload id) lives in the
database; bytes live in S3 under `<prefix><memberId>/<blobId>/<upload suffix>`.
`quotaBytes` is per account in sealed bytes, `null` when unlimited
(`NAVIDE_BLOB_QUOTA_BYTES` unset). A blob with no reference left is deleted
24 hours after it lost the last one; an upload with no activity for 7 days is
aborted. `account.delete` removes the metadata in its transaction and queues
the account's prefix for deletion in the same commit.

## Desktop behaviour since protocol v3

The v3 wire contract (objects in S3, hashed item ids, version history) is
kept with the server; this section records how the desktop behaves next to
0.2.19, for a person checking that nothing changed for them.

**With Navide Cloud off, or no scope switched on:** no difference. No round
runs, so `sync.caps` is never sent, nothing touches object storage, and the
version history card is not shown.

**Visible with Cloud connected:**

- Settings → Navide Cloud has a collapsed *Version history* card. A restored
  MCP server or skill waits for approval like any synced record and is not
  pushed until approved; a restore is refused while an incoming change for
  the item is waiting for approval.
- Switching the Cloud account A → B → A, or signing out and back in to the
  same account, resumes from the parked state instead of reading the account
  again. Every scope is still switched off on a switch.
- Credentials never sync, on any protocol. The stored switch is reported and
  kept as before (`sync.status` adds `neverSynced`), but no round runs for
  it, the switch cannot be turned on, and item-level requests refuse it.
- `sync.inventory` answers credentials `not-connected`, connected or not,
  and never lists the cloud's copy (that would take credential traffic).
  Main answered `disabled` for a switched-off credentials scope and listed
  the cloud's items for one left on by an older build, which the CLI
  accounts page showed; that page now shows "not connected" for such a user.
  No window reads the `disabled` answer, so a switched-off scope looks the
  same as before.

**Protocol and data, only once a scope is switched on:**

- Each new connection sends `sync.caps {protocol: 3}` once. An older server's
  `UNKNOWN_TYPE`, `UNSUPPORTED`, or no answer means the v1 wire, byte for
  byte. `NAVIDE_SYNC_PROTOCOL=1` forces v1.
- On an object account, bodies go to object storage (single PUT with
  `If-None-Match: *`; 412 counts as uploaded) and come back by batched
  presigned GET over kept-alive connections, capped at the stated size, over
  https (plain http only to loopback).
- Hashed item ids are adopted only on a v3 object account whose caps does not
  say `adoptHmac: false`; an account outside the server's list stays on
  legacy ids and is asked at most once per connection.
- Database: `sync` schema steps 4–6 only add columns (with defaults) and the
  `sync_parked` table; held approvals of a parked account move to
  `sync-approvals-parked/<namespace>/` in the app data directory.

**Downgrade to 0.2.19:** it skips the newer schema steps and reads and writes
the tables as before; parked rows and approvals are left alone. An account
that adopted hashed ids refuses a v1 client (`SYNC_PROTOCOL_REQUIRED`), so
such a device stops syncing that account until it is upgraded.

Known issues, not fixed: after a declined restore, a conflict card's local
half can describe the declined version (nothing is overwritten); when two
devices migrate at once and one has an unpushed edit, the conflict may have
to be answered twice; one damaged or missing object fails its whole page and
holds the cursor until it is repaired.
