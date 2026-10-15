# Adding a chat platform

A chat platform (Telegram, Slack, …) is one adapter file on the backend and one
spec file on the renderer, plus one registry line on each side. No shared
component or composable may contain `platform === '<name>'` or a hard-coded
platform list — everything platform-specific lives in the two per-platform files.

## Backend (`backend/agent_team_backend/channels/`)

1. Copy `_template.py` to `<id>.py` (short lowercase id). Implement the
   `base.ChannelAdapter` protocol: `start/stop`, `send_text`, `edit_text`,
   `send_typing`, `create_location`, `token_fingerprint`, and a module-level
   `create_adapter(config, secret, *, store)` factory. Optional hooks the
   manager probes with `getattr`: `link_url(code, target)` (pairing deep link),
   `known_locations()` (the "existing chat" picker), `account` (attribute).
2. Add `"<id>"` to `Platform` in `base.py` and a limit to `text.TEXT_LIMITS`.
3. Register it: one line in `PLATFORMS` in `channels/registry.py` (display order).
   `manager.PLATFORMS` is an alias of it.
4. Add `agent_team_backend.channels.<id>` to `hiddenimports` in
   `backend/agent_team_backend.spec` (adapters are loaded with
   `importlib`, which PyInstaller cannot see). `test_pyinstaller_spec.py` fails
   if a registered platform is missing.
5. Tests: `backend/tests/test_channels_<id>.py` with a fake transport or a local
   server on `127.0.0.1` — never the real platform. `test_channels_registry.py`
   checks the id imports and exposes a complete adapter.

### Two-way pane mirroring: what an adapter owes it

A bound chat mirrors everything its pane does (results, local prompts,
delegations, child panes). The manager does the routing; an adapter only has to
be honest about a few facts:

- **`capabilities`** decide the layout. `threads` + `create_location` → each child
  pane gets its own auto-created topic ("↳ name"); without them child messages ride
  the parent chat with a `↳ name` prefix. `edit` → one status message edited in
  place, else sparse new messages. `buttons` → permission buttons, else the text
  command `yes <code>` / `no <code>`. Set them from what the platform really does.
- **`rate_per_min`** (optional class attribute, default 60): the platform's sustained
  send limit per chat. Every send to a location goes through one queue
  (`mirror.Outbox`, a token bucket with a burst of 5) that paces to it and merges a
  backlog of same-source messages instead of dropping them. Set it low for strict
  platforms (Telegram groups and DingTalk robots: 20). Keep honouring 429
  `retry_after` inside the adapter — the queue never retries.
- **`send_text` must return the platform's message ids**, one per sent chunk, in
  the same form an inbound reply names them. The mirror remembers which pane
  produced which message so a reply can be routed to that child.
- **`InboundMessage.reply_to_id`**: fill it with the id of the message the user
  replied to (Discord `message_reference.message_id`, Matrix `m.in_reply_to` unless
  `is_falling_back`, Feishu `parent_id`, Telegram `reply_to_message.message_id`,
  Slack/Mattermost thread root). Leave it empty when the platform cannot tell or the
  send API does not return usable ids, and say so in the adapter's docstring
  (DingTalk and iMessage do). `@name text` routing works either way.
- Do not truncate or summarise in the adapter: chunking to `text_limit` is fine,
  everything else (verbosity, source labels, secret redaction) is the manager's.

### Attachments: `MediaAdapter` (optional)

- **Inbound**: fill `InboundMessage.attachments` with one `InboundAttachment` per
  file (kind, name, size, mime, and the `ref` your `download` needs), and emit a
  file-only message instead of dropping it. Without media support, still report
  the file with an empty `ref`: the manager then answers "此平台尚不支援媒體".
- **`download(att, dest, max_bytes)`** writes the file and returns its size; use
  `adapter_runtime.download_to` (no redirects, size cap, partial file removed).
  Send a credential only to the platform's own file host.
- **`send_file(loc, path, filename)`** posts one file and returns its message ids;
  set `upload_max_bytes` to the platform's documented per-file limit, with the
  source in a comment. The manager has already checked the path (channels/media.py).

Verify: `uv --project backend run pytest backend/tests -k "channels or pyinstaller"`.

## Renderer (`src/renderer/src/platform/channels/`)

1. Copy `_template.ts` to `<id>.ts`. The id must match the file name and the
   backend registry id. Fill in `badge`, `fields` (credential inputs) and `link`
   (pairing guide targets and i18n keys).
2. Add one import in `index.ts` and put the spec in `ORDERED` (same order as the
   backend registry).
3. Add the id to `BACKEND_IDS` in `__tests__/registry.test.ts`.
4. Add i18n keys `channels.platform.<id>`, `channels.desc.<id>`, and
   `channels.field.<key>` for each new field, in `en-US`, `zh-TW` and `ja-JP`.

Verify: `pnpm typecheck` and `pnpm test:run`.
