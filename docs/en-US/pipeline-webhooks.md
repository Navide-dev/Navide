# Pipeline webhooks

Another system can start a pipeline: by HTTP with a key, from GitHub with a
signature, or from a form a person fills in. Set it up in **Settings ▸
Webhooks**. It is off by default, and nothing listens until the switch is on and
a trigger is enabled.

## What you need

- **Navide Guard on.** Webhooks refuse to turn on without it, and a request that
  arrives while Guard is off gets `503`.
- **Navide open, with a window on the workspace.** Without one a request gets
  `503`; Navide does not open a window for it.
- **A pipeline whose steps all use Claude Code,** sub-pipelines included. Other
  CLIs are refused when you enable the trigger and on every request, and a pane a
  run opens cannot use one either. Guard's hook is tested on Claude Code only.
  Codex has no mode that asks before every call, and Copilot and Qwen have not
  been measured.
- **An approval gate as the first step,** or tick **Start without approval**.

App Lock on means a request gets `503`.

## Reaching it from outside

Navide listens on `127.0.0.1` only, on its own port. To reach it from another
machine, run your own tunnel to that port and enter the tunnel's name as the
**Public hostname**; requests naming any other host are refused. With a tunnel
anyone on the internet can reach the address, and the key or signature on each
trigger is then the only thing stopping them.

## Calling a trigger

```sh
curl -X POST 'http://127.0.0.1:<port>/webhook/<id>' \
  -H 'Authorization: Bearer <key>' \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'
```

The key is shown once and kept only as a hash. If you lose it, replace it.
Bodies are limited to 64 KiB of JSON, plain text or urlencoded data.

| Answer | Meaning |
|---|---|
| `202` | Accepted. The run is starting; the result is not sent back. |
| `404` | Unknown trigger, wrong key or foreign host, all alike. |
| `409` | A run is already going in the workspace, or the pipeline is no longer allowed. Nothing is queued. |
| `413`, `415`, `400` | Too large, wrong type, or not what it says. |
| `429` | Over the limit. The defaults are 6 a minute and 20 a day; the most is 60 and 500. |
| `503` | Guard off, App Lock on, or no window on the workspace. |

Every request, refused ones too, is in the trigger's **Activity**: time, outcome,
size and a hash of the body, never the key, headers or body.

## GitHub

Choose **GitHub** as the source and tick the events that should start a run. In
the repository's **Settings ▸ Webhooks**, paste the address and the secret and
choose `application/json`. GitHub needs a public address, so set up a tunnel
first.

Only `X-Hub-Signature-256` counts, and it is checked before the body is parsed.
`ping` answers `200` and an event you did not tick `204`; neither starts a run.
Bodies can be up to 1 MiB. A delivery with the same body as one in the last 24
hours answers `200` and runs nothing, so a redelivery from GitHub's page will not
start a second run within a day; **Activity** shows it as a duplicate.

An agent gets a short list of fields: event, action, repository, ref, sender,
title, URL and number. Issue and pull request bodies, comments and commit
messages are left out, because anyone can write them. The title stays, and is
treated as untrusted.

The secret is stored encrypted, under a key in the macOS Keychain or Windows
DPAPI. On Linux that key is a file only permissions protect, so any program
running as you can read it; you confirm this when you enable the trigger. If the
key is gone, for example after moving to another machine, the trigger turns off
and you replace the secret. Nothing is regenerated for you.

## Forms

Choose **Form** and add fields: text, long text, number, email, date, list or
checkbox. Files, passwords and custom HTML are not available.

The address is the only key, so it is shown once; replace it if it gets out. A
form opens on this computer only unless you tick it public. A public form's
address ends up in browser history and tunnel logs, and anyone holding it can
start a run.

## How a run behaves

- **Everything the request sent is untrusted.** It reaches the agent as marked
  data, with control characters and `{{` neutralised. That wording only asks the
  agent not to obey it. What limits an agent that does is the rest of this list.
- **Every tool call waits for you.** Panes start with the CLI's own prompts on,
  whatever your permission settings say, and so does any pane they open. A custom
  launch command is refused.
- **That holds when a conversation comes back.** Navide remembers every session a
  run used, so a pane reopened after a restart, a Rebuild, a channel wake or an
  account switch asks too. A reopen that names no session, such as `--continue`,
  loses the bypass in any workspace that has had a webhook run. Two things are
  out of reach: picking a run's session with `/resume` inside a pane already in
  bypass, and typing the command in a terminal yourself. Neither passes through
  Navide when the CLI starts.
- **Unattended ends with the trigger.** A pane keeps the bypass only while its
  trigger exists and is still unattended. Otherwise it asks, however it started.
- **Nobody there means it stops.** A gate or a prompt nobody answers stops the
  run after the trigger's wait, 30 minutes by default, and a run stops after 4
  hours whatever it is doing. Nothing is approved on anyone's behalf. Phone and
  chat channels cannot approve for a webhook run.
- **The pipeline stays tainted.** A pipeline ever bound to a trigger is treated as
  influenced by external content from then on, even when you start it by hand and
  after the trigger is deleted.
- **The data stays out of `pipeline.log`,** which records its size and hash. It is
  in the run's stored task and the pane's conversation, so do not send secrets.

## Unattended

Off by default, per trigger, and macOS and Linux only for now. Turning it on
means:

- The agent skips permission prompts, so nobody confirms its tool calls.
- It works on external content, which can try to steer it.
- Guard stops only commands it recognises. It cannot stop an agent that writes a
  script and then runs it.
- If Guard's hook cannot answer, the call is refused. If the hook process itself
  is killed or hangs, the call goes through. This guards against hook failures,
  not against an agent working around them: an agent can change its own pane's
  environment.

Panes an agent opens from such a run do not get the bypass.
