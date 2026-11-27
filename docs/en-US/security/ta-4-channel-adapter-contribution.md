# TA-4 — Channel adapter contribution point and bot-token custody

Status: assessment, 0.2.39. Nothing is implemented in this version.

## Scope

Chat channels (Telegram, Discord, Slack, Feishu, DingTalk, Matrix,
Mattermost, iMessage) are backend Python modules under
`backend/agent_team_backend/channels/`: one adapter file implementing the
`base.ChannelAdapter` protocol, one renderer spec, one registry line each
([docs/adding-a-chat-channel.md](../../adding-a-chat-channel.md)). The
manager owns the pipeline — sender gate and pairing, allowlists, pane
bindings, two-way mirroring, delivery, secret redaction, taint marking — and
an adapter only speaks its platform's wire protocol. Bot tokens live in the
credential vault (Keychain on macOS, DPAPI on Windows; the entry name is
described in [Chat channels → Setting up](../inter-cli-messaging.md#setting-up)),
are handed to the adapter constructor, and are registered with
`redact.add_secret` so they never reach logs.

This assessment covers letting a **plugin** provide an adapter (LINE,
WhatsApp, Teams, a company's own chat) through a contribution point, with:

- the bot token kept by the Host, the plugin receiving only a proxy;
- taint of messages in both directions;
- the interface to the existing manager;
- the list of RULE ZERO items the design touches.

Windows is out of scope by construction: a plugin adapter is backend code and
no third-party backend runs on Windows (TA-3).

## What we are building

```
chat platform ◀──HTTPS/WS──▶ Host network bridge (TA-1 option B, + credential slot)
                                   ▲ request / response, token injected by Host
                                   │
                     plugin backend (sandboxed): adapter logic only
                                   │ bridge port "channel": inbound(), status()
                                   ▼
                     channels.manager: gate → pairing → binding → pane
                                   │ send_text / edit / typing / create_location
                                   ▼ (same port, Host → plugin)
                     plugin backend → Host network bridge → chat platform
```

Contribution shape (sketch, for alignment with the schema queue):

```json
"contributes": {
  "channelAdapters": [{
    "platform": "line",
    "displayName": "LINE",
    "capabilities": { "threads": false, "edit": false, "typing": false, "buttons": true, "textLimit": 5000 },
    "credential": { "fields": [{ "key": "token", "label": "Channel access token", "secret": true }],
                    "inject": { "kind": "header", "name": "Authorization", "format": "Bearer {{secret.token}}" } },
    "hosts": ["api.line.me", "api-data.line.me"]
  }]
},
"permissions": { "system": ["agents", "agentMessages"], "network": { "hosts": ["api.line.me", "api-data.line.me"] } }
```

`agentMessages` is required because a channel adapter, by its nature, reads
every message a bound pane produces and injects text into panes — the two
things that permission already discloses as high risk.

## What can go wrong

The adapter is position 4 of the threat model (untrusted code the user
installed) that sits on the one path where outside text enters a pane
(position 1 in the model's terms: a remote party).

| Threat (STRIDE) | How | Severity |
|---|---|---|
| **Information disclosure — bot token** | If the plugin holds the token, it can send it anywhere its network reach allows, or return it inside an agent-tool result or a pane message. The built-in adapters hold it today, but they are Navide's own code. | Highest — a bot token is the account on that platform |
| **Information disclosure — pane output** | Mirroring sends everything the bound panes say to the adapter (after the manager's redaction). The plugin sees the user's work with their agents. | High (that is what `agentMessages` already says) |
| **Spoofing — sender identity** | The adapter is the only witness of who spoke on the platform. A malicious adapter reports any `sender_id` it likes — an allowlisted one — and the gate admits text the user never sent. | High |
| **Elevation — approval relay** | Permission prompts are mirrored to the chat with buttons / `yes <code>`; the code travels *through* the adapter, so a malicious adapter can answer its own prompt and approve a CLI agent's destructive command. | Highest |
| **Tampering — inbound text** | Inbound text is prompt-injection by definition; the Guard already marks a pane tainted when channel text is delivered (`guard/taint.py`), and that stays. New is that the *adapter* may rewrite a legitimate user's message. | Medium (taint already treats it as outside text) |
| **Tampering — outbound text** | The adapter can alter what the user reads in chat (drop a warning, change a status). | Medium |
| **Repudiation** | The manager's message log records `origin`; it must also record which plugin adapter carried each inbound and outbound message. | Medium |
| **DoS** | A stalled adapter blocks mirroring for its platform; the existing `STALL_WATCHDOG_S` and reconnect policy live in `adapter_runtime.py`, which a plugin adapter would not run. The Host side of the port needs the same watchdog. | Low–medium |

## Options for token custody

| Option | Where the token is | Exfiltration path | Platform coverage | Verdict |
|---|---|---|---|---|
| **A. Host-held, injected per request** | Vault only. The plugin asks the network bridge for a request with a credential slot (`{{secret.token}}`); the Host substitutes it **only** for hosts in the adapter's declared `hosts` list and only in the declared position (header / query / body field). Long-polling and WebSocket upgrades go through the same bridge with the same injection. The plugin can learn the token's fingerprint (needed as the lease key the manager already uses) and nothing else. | Only to a declared platform host — which already has it. | Any platform whose auth is "put this string here"; covers Telegram, Discord, Slack, LINE, Matrix, Mattermost, Feishu/DingTalk (app secret + fetched tenant token: the fetched token is itself stored in a vault slot the plugin names but never reads). | **Recommended** |
| **B. Plugin-held in sandbox memory** | Delivered to the plugin over the Backend Wire at start. | Any network the plugin has (TA-1), plus any channel back to the user (tool results, pane messages, its own view). | Everything | Not recommended: the token becomes plugin data |
| **C. Host performs the whole protocol** | The adapter is declarative only (URL templates). | None | Only trivial HTTP bots; no WebSocket state machines, no media | Too narrow |

Option A is the only custody model for third-party adapters. It needs TA-1's
bridge (option B there) and extends it with a credential slot; the two are one
design.

## Taint and identity

- **Inbound**: unchanged — the manager marks the pane tainted on delivery,
  records the event with the routing key, and the badge shows what came in.
  New: the `origin` column names the adapter plugin id and version.
- **Sender identity**: disclosed, not fixed — the card says "This plugin
  decides who is speaking on <platform>; your allowlist and pairing trust its
  word." The pairing code remains Host-generated and single-use, so a plugin
  cannot pair itself to a pane the user did not pair; it can only impersonate
  a sender the user already allowed.
- **Approval relay**: the one place where "disclose" is not enough, because
  the thing being approved is a CLI agent's `critical`-graded command. Two
  shapes are possible: (1) a prompt mirrored through a plugin adapter shows
  the prompt but the answer is accepted only from a Navide window or a
  built-in adapter — the card says "approvals cannot be answered from this
  chat"; (2) relay allowed, disclosed as highest, with a per-adapter switch
  in Settings → Channels, off by default. The first version uses (1): it
  withholds one convenience from one channel type and removes the one path
  where a plugin could approve a `critical` command by itself.
- **Outbound**: the manager's redaction runs before the text reaches the
  plugin (as today); the plugin receives already-redacted text.

## Interface with the existing manager

| Today (Python module) | With a plugin adapter |
|---|---|
| `importlib` load of `channels/<id>.py`; `PLATFORMS` registry; PyInstaller `hiddenimports` | Discovered from installed plugins' `contributes.channelAdapters`; `Platform` literal in `base.py` opens to `str`; `TEXT_LIMITS` from the contribution's `textLimit` |
| `create_adapter(config, secret, *, store)` gets the raw token | Host creates a *proxy adapter* object implementing `ChannelAdapter`, which forwards each method over the bridge port `channel` and never holds the secret |
| `start(emit)` runs the receive loop in-process | Plugin runs its loop in its sandbox; inbound messages arrive as bridge events validated against the `InboundMessage` shape (sizes, enum kinds, string ids) before `emit` |
| `token_fingerprint()` from the token | Host computes it from the vault value and hands the fingerprint to the plugin |
| Renderer spec `src/renderer/src/platform/channels/<id>.ts` | Derived from the contribution (`displayName`, credential fields, capabilities); the Channels settings page renders it like a built-in |
| `adapter_runtime.ReceiveLoop` watchdog | Host-side: a plugin adapter that stops reporting status for `STALL_WATCHDOG_S` is marked `recovering` and its backend restarted (C4) |

## RULE ZERO items this design touches

- Bot tokens and app secrets (vault slots `channel-*`): never leave the Host
  process; the bridge substitutes them only into requests to declared hosts.
- Permission approvals relayed from chat (see above).
- Pairing codes and sender allowlists: Host-owned, unchanged.
- Pane taint marks and the message log: Host-owned, gain an adapter column.
- CLI credentials: untouched; a plugin adapter never has a path to them that
  a plugin backend does not already have (none, under the sandbox).

## Did we do enough (acceptance when implemented)

- A plugin adapter's process memory never contains the token: a test runs a
  fake adapter that dumps every byte it received over the wire and asserts the
  token is absent while a platform request carrying it succeeded.
- A request with a credential slot to a host not in the adapter's list is
  refused before substitution; a redirect to another host drops the slot.
- A forged `sender_id` from the adapter is admitted only if the user
  allowlisted it (documented behaviour), and the inbound event records the
  adapter plugin id.
- A permission prompt mirrored through a plugin adapter cannot be approved
  from that chat (shape 1 above).
- The manager's existing tests (`backend/tests/channels/`) pass unchanged with
  a proxy adapter substituted for a built-in one.
- Tests: `backend/tests/channels/`, `src/main/plugins` (bridge port,
  contribution catalog), `packages/plugin-contracts` (schema),
  `marketplace/registry/tests`.
