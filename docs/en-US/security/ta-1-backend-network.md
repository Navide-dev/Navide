# TA-1 — Backend sandbox network access

Status: assessment, 0.2.39. No backend network access is implemented in this
version. The view-side declaration (`permissions.network.hosts`, enforced by
the frame CSP) ships as PR C1 and is the shape any backend version must reuse.

## Scope

How a third-party backend, which today runs with no network at all, could be
allowed to reach the hosts its manifest declares:

- the macOS Seatbelt profile (`src/main/plugins/pluginBackendSandbox.ts`,
  `buildSeatbeltProfile`): `(deny default)` plus `bsd.sb`, which grants no
  `network*` rule, so the child has no outbound, no inbound, no loopback and
  no DNS;
- the Linux bubblewrap vector (`buildBubblewrapArgs`): `--unshare-all`
  unshares the network namespace, so the child has only a loopback interface
  of its own and no resolver;
- how a declaration of hosts could be made real at the sandbox layer
  (direct connection versus a Host-side proxy), including DNS;
- how data leaving the machine is noticed and recorded (Activity);
- the relationship with the view-side C1, which is a different process with a
  different enforcement point (the renderer's CSP).

Out of scope: Windows (no backend runs there at all, see TA-3), the browser
plugin's `web` namespace (a Host-owned browser partition, already disclosed as
high risk), and the shell broker's `git`/`gh`/`glab` network reach, which is
already documented in
[plugin-development-v2.md, "Network reach"](../plugin-development-v2.md#third-party-backends-sandbox-consent-and-publishing).

## What we are building (the two network paths of one plugin)

```
 view (renderer, navide-plugin-frame://)      backend (sandboxed child)
   fetch(host)                                  socket(host)
     │ CSP connect-src = declared hosts (C1)      │ Seatbelt / bwrap: denied today
     ▼                                            ▼
   network                                      (this assessment)
```

A plugin that wants GitHub status in its panel can do it from the view (C1).
A plugin whose backend polls a CI server, pulls a feed on a schedule, or
serves an agent tool that calls an API needs the backend path; today its only
network reach is indirect, through the shell broker's `gh api` / `glab api`,
which is both narrower (three executables) and wider (any host the command
names) than a declared host list.

## What can go wrong

Attacker positions are those of the threat model; the plugin author, or
whoever compromised the plugin's build, is position 4 (untrusted code the
user installed) with position 3's reach once the backend has a bridge.

| Threat (STRIDE) | How, with network access | Severity |
|---|---|---|
| **Information disclosure — exfiltration** | The backend reads workspace content through its granted `fs` capability and sends it to a host it controls. This is the whole reason network is a declared permission: with no declaration the sandbox is the control; with one, the declaration and the user's consent are. | High — it is the plugin's declared purpose turned against the user |
| **Information disclosure — SSRF to local services** | A backend that can open sockets can reach `127.0.0.1`: the backend WebSocket (token-protected), the hooks HTTP endpoint (0600 header file), a pane's MCP URL, a local Registry during development, other apps' debug ports. The token controls hold, but the attack surface of every local listener is now exposed to third-party code. | High if loopback is reachable; low if not |
| **Spoofing — DNS rebinding** | The declared host resolves to a public address at check time and to `127.0.0.1` or a LAN address at connect time. | Medium |
| **Tampering — supply chain in flight** | The backend fetches code or models over plain HTTP and executes what it gets. Within the sandbox it can only exec its own package, but it can load data files as code (already documented for the data directory). | Medium |
| **Denial of service** | Unbounded downloads fill the data directory or the user's bandwidth; the resource watchdog meters CPU and memory, not bytes on the wire. | Low–medium |
| **Repudiation** | Without a record, "the plugin sent my files somewhere" cannot be answered either way. | Medium |
| **Elevation** | Network access lets the backend talk to a Host-owned local service it should reach only through the broker. | Covered by the SSRF row |

What the sandboxes can and cannot express:

- **Seatbelt** can allow network by protocol, port and literal IP address
  (`(allow network-outbound (remote tcp "*:443"))`), never by hostname. A
  declared host list therefore cannot be enforced inside the Seatbelt
  profile; it can only choose between "no network", "ports/IPs" and "all".
- **bubblewrap** is binary: `--unshare-net` (today) or `--share-net` (the
  host's network, every interface, loopback included). There is no in-between
  without a netns helper (`slirp4netns`, `pasta`) and its own firewall rules,
  which pulls in privileges and distribution differences the Linux sandbox
  deliberately avoids.
- **DNS** inside an unshared netns does not work; with `--share-net` it uses
  the host resolver, and `/etc/resolv.conf` would have to be bound read-only.

So a hostname allowlist is never a sandbox rule. It is either a Host-side
proxy or a Host-side bridge.

## Options

| Option | Mechanism | Enforces declared hosts | SSRF / loopback | Activity | Platform parity | Verdict |
|---|---|---|---|---|---|---|
| **A. Open the sandbox** | Seatbelt `(allow network*)`; bwrap `--share-net` + `--ro-bind /etc/resolv.conf` | No. Disclosure would read "this backend can reach any host", level highest (the Registry disclosure contract already reserves `network` as highest). | Loopback reachable; every local listener's token is the only control | None: the Host sees no traffic | macOS and Linux | Only as an explicitly consented "highest" mode; not the default shape |
| **B. Host bridge port** | A new bridge port `network`, operation `fetch`, next to the existing `shell` port: the backend asks the Host to perform one HTTP(S) request; the Host checks the URL's host against `permissions.network.hosts`, performs it with its own client, returns status, headers and a size-capped body. | Yes, per request, before any socket opens | The Host refuses literal IPs, `localhost`, loopback, link-local, RFC 1918 and ULA ranges unless the manifest names them explicitly (and the disclosure then says "local network"); it resolves once and connects to the resolved address, and re-checks every redirect target | One row per request: host, method, status, bytes in/out, outcome | Identical on macOS, Linux and (when a backend exists) Windows; nothing in the sandbox changes | **Recommended** |
| **C. Local forward proxy** | Sandbox allows loopback only (Seatbelt `(allow network-outbound (remote ip "localhost:*"))`; bwrap needs a netns helper, so Linux is left out); the Host runs an HTTP CONNECT proxy per backend and sets `HTTPS_PROXY` in the child's environment. | Yes, by CONNECT target | Loopback is reachable by construction; the proxy must refuse everything but itself | Per CONNECT, host only (TLS is opaque) | macOS only without extra tooling; libraries that ignore proxy variables bypass it silently | Not recommended |

Why B over A: the whole point of a declaration is that the user consents to
*those* hosts, and only the Host can check a hostname. B also matches how the
backend already does everything it is not allowed to do itself (`port:
"shell"`): one request, one check, one Activity row, the same `CAPABILITY_DENIED`
on refusal. Streaming and WebSocket clients are not covered by B in a first
version; a plugin that needs them declares the fact and waits, or runs that
part in its view (C1), where the renderer's networking stack handles both.

## Relationship with C1 (view CSP)

One declaration, two enforcement points:

- `permissions.network.hosts` is an array of hostnames (`api.github.com`,
  optionally a leading `*.` wildcard for one label). The same JSON Schema
  rule validates it in `plugin-manifest-v2.schema.json` and in the Registry's
  `manifest_v2.py`; the Registry static scan lists the hosts it can see in
  package code and the disclosure shows "declared" next to "found in code".
- The view honours it through the frame CSP's `connect-src` (C1); the
  backend would honour it through the bridge check (this assessment, option
  B). Declaring hosts without a backend grants only the view path.
- The disclosure card lists the hosts once and says what can reach them:
  "its views" today, "its views and its backend" once B ships. The risk level
  for a declared host list is **highest**, the level the disclosure contract
  already reserved for `network` (data a view can read through its
  capabilities can leave the machine to a named party); whether a list of
  named public hosts should read one level lower than a local or private
  address, or than a future "any host" mode, is a wording decision for the
  user (below), not a change to the enforcement.

## Decisions for the user

1. Ship backend network as option B (Host bridge) in a later version, or not
   at all (views only)? The recommendation is B.
2. Whether a plugin may declare local or private addresses at all (default
   recommendation: allowed, disclosed as highest; a plugin for a local Ollama
   or a LAN appliance is a legitimate use).
3. Whether the Activity row stores the full URL path or host only (the shell
   rows keep executable and subcommand only; the same restraint — host and
   method — is recommended, because paths carry identifiers; C1 records the
   host only).
4. Whether a declared list of public hosts should read **high** on the card
   while a local or private address, or an "any host" mode, reads
   **highest**. C1 ships with one level, highest, as the contract reserved.

## Did we do enough (acceptance for the implementing PR)

- A request to an undeclared host, to a literal IP, to `localhost`, to a
  loopback / link-local / private address, or to a redirect landing on any of
  those is refused before a socket opens, and the refusal is an Activity row.
- The sandbox profiles are unchanged by option B (a test asserts the Seatbelt
  profile still has no `network` rule and the bwrap vector still contains
  `--unshare-all`).
- Response bodies are capped (same order as `shell.run` output, documented),
  and a timed-out request is reported as such rather than hanging the bridge.
- The disclosure card, the Registry disclosure JSON (`network` field) and the
  agent install request text all name the declared hosts; the scan report
  lists the hosts found in code that are not declared.
- Revoking the plugin's grant or disabling the plugin stops new requests at
  the next call; an in-flight request completes (same rule as the shell
  broker, documented).
- Tests: `src/main/plugins` (bridge, broker, Activity), `packages/plugin-contracts`
  (schema), `marketplace/registry/tests` (`manifest_v2`, `static_scan`,
  disclosure), `tests/infrastructure` (docs examples).
