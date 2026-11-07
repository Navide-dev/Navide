# TA-2 — Declared shell executables (`permissions.shell.executables`)

Status: assessment, 0.2.39. PR C2 implements the recommendation below.

## Scope

Today a plugin may declare `permissions.shell` as `allowlist` or `full`.
In `allowlist` mode the broker (`src/main/plugins/pluginCapabilityBroker.ts`,
`shellCommandAllowed`) accepts only the Host-owned list
`HOST_SHELL_EXECUTABLE_ALLOWLIST = ['git', 'gh', 'glab']`
(`pluginCapabilityCatalog.ts`), with the command tokenised lexically: wrapper
and interpreter tokens are followed (`env`, `sudo`, `sh -c` …), a
path-qualified token, a `$` expansion or a leading assignment makes the
command unresolvable and therefore refused. `full` mode runs anything and is
refused for backends.

C2 lets a package name the executables it needs — `npm`, `pnpm`, `node`,
`python3`, `docker`, `make`, `terraform` … — instead of choosing between three
Git-family commands and everything. This assessment covers:

- what disclosure must say when a declared executable is, in effect, any
  program (an interpreter or a package runner);
- how the Guard's risk grading and the agent Execution Policy relate to it;
- PATH resolution, and the Windows quoting and extension pitfalls;
- what is recorded about each run;
- alignment with the user's ruling of 2026-10-17 ("一律不限制": no limits on
  what a plugin may ask for; disclosure comes from the Registry's scan at
  publish time, the manifest declaration is kept to compare "declared" with
  "found").

## What we are building

```
manifest.permissions.shell = "allowlist"
manifest.permissions.shell.executables = ["npm", "node"]      ← new (C2)
        │
        ▼ install consent: lists each executable, graded
Host broker: shell.run "npm test"
        │ tokenise → top-level executables → each ∈ (HOST list ∪ declared)
        │ agent-initiated? → Execution Policy (user-owned) must also allow it
        ▼
spawn(resolved executable, args, { shell: false, cwd: bound workspace })
        └─ Activity row: executable + subcommand, outcome
```

The manifest shape has to stay compatible with the existing `shell` enum, and
with the schema queue behind it (C1 `network`, E1 `agents.events`), so
`shell` becomes either the current string or an object:

```json
"permissions": { "shell": { "mode": "allowlist", "executables": ["npm", "node"] } }
```

with the string form `"shell": "allowlist"` kept as a shorthand for
`{ "mode": "allowlist" }`. (`full` takes no `executables`.)

## What can go wrong

| Threat (STRIDE) | How | Severity |
|---|---|---|
| **Elevation — interpreter equals full shell** | `node`, `python3`, `npx`, `bun`, `sh`, `pwsh`, `make`, `docker` each run arbitrary code or arbitrary programs. A plugin declaring `node` has everything `shell: "full"` has, under a label that reads narrower. | Highest — the honest statement is "this plugin can run any program as you" |
| **Elevation — same-name executable from the workspace** | The broker already refuses path-qualified tokens; but if the Host resolved a bare name against the *workspace* or the plugin's own directory, a repository could ship `./npm` and be run under the declared name. On Windows, `cmd.exe` searches the current directory before `PATH`. | High if resolution is not Host-controlled |
| **Tampering — PATH supplied by the plugin** | Resolution against an environment the plugin influences (a `.env` the view wrote, a workspace `node_modules/.bin`) turns a declared name into an arbitrary file. | High |
| **Tampering — Windows batch shims (BatBadBut, CVE-2024-24576 class)** | `npm`, `pnpm`, `yarn`, `npx` on Windows are `npm.cmd` shims. `cmd.exe` re-parses arguments, so an argument containing `&`, `|`, `%VAR%`, `^` or a quote runs extra commands. Node ≥ 18.20/20.12 refuses to spawn `.bat`/`.cmd` with `shell: false` (`EINVAL`) for exactly this reason. | High on Windows |
| **Information disclosure — credential subcommands** | The broker refuses `git credential*`, `gh auth*`, `-c`/`-C` overrides for the Git family. A declared `npm` can run `npm token list`, `npm whoami`, `docker login`; `gcloud`, `aws` read `~/.aws`. The view's broker runs *as the user*, outside any sandbox. | High |
| **Information disclosure — RULE ZERO files** | Any executable that reads files can read CLI credential stores if pointed at them; the Guard's `credential-access` rule names them for CLI agents, the broker does not. | High |
| **Repudiation** | Without recording which executable ran with which first argument, a user cannot tell what a plugin did with the grant. Activity already records executable and subcommand for the Git family. | Medium |
| **Denial of service** | A declared `make` or `docker build` can run for hours; the broker's 30 s limit cuts it and leaves the child running (documented behaviour today). | Low — disclosed, not a new class |
| **Spoofing — case and extension** | `Git`, `GIT`, `npm.cmd`, `npm.exe` must grade and resolve as the declared name on case-insensitive filesystems; the Execution Policy already lower-cases at the enforcement boundary. | Medium |

## Options

| Option | Behaviour | Fits "disclose, don't restrict" | Verdict |
|---|---|---|---|
| **A. Any bare name, graded disclosure** | A package may declare any executable name. The consent card lists each one with a grade; names in a Host-owned interpreter/runner set are shown as "can run any program" (**highest**); every other declared name is **high**; the Git family stays **high** as today. The broker enforces exactly the declared set. | Yes — nothing is refused, everything is named | **Recommended** |
| **B. Host-curated catalogue** | Only names the Host knows (with per-name subcommand rules, as for `git`) may be declared. | No — it is a restriction, and it chases an open vocabulary (today's denylist comment in `executionPolicyAllows` already rejects that approach for the same reason) | Rejected |
| **C. Declared names, interpreters refused** | Any name except the interpreter set. | No — it refuses the most-requested use (`npm test`, `node script`) and is trivially bypassed via a declared `make` | Rejected |

Grading set (Host-owned, disclosure only, extensible in one place):
shells (`sh`, `bash`, `zsh`, `fish`, `dash`, `ksh`, `pwsh`, `powershell`,
`cmd`), interpreters (`node`, `deno`, `bun`, `python`, `python3`, `ruby`,
`perl`, `php`, `lua`, `osascript`), runners (`npx`, `pnpm`, `npm`, `yarn`,
`pip`, `pipx`, `uv`, `uvx`, `cargo`, `go`, `make`, `cmake`, `gradle`, `mvn`,
`docker`, `podman`, `kubectl`, `nix`, `brew`, `apt`, `winget`, `choco`),
privilege (`sudo`, `doas`, `su`, `runas`). A declared name outside the set
is still "high": the set changes the words, never the answer.

## Where each check lives

1. **Manifest / Registry** (`packages/plugin-contracts/src/schemas/plugin-manifest-v2.schema.json`,
   `marketplace/registry/registry/manifest_v2.py`): `executables` is an array
   of 1–32 unique bare names matching `^[a-z0-9][a-z0-9._+-]{0,63}$` (lower
   case by rule; the broker lower-cases at the boundary, so a mixed-case
   manifest would only create two spellings of one grant). No `/`, `\`, `$`,
   whitespace or extension (`npm`, not `npm.cmd`). The Registry static scan
   extracts command strings it can see in the package and reports, per
   executable, "declared", "found in code but not declared", "declared but
   not found" — the user's 10-17 ruling turned into the disclosure's shape.
2. **Disclosure** (`disclosure_contract.py` rules, `PluginDisclosureCard.vue`):
   `shell.executables.<name>` reasons, graded as above; the overall level is
   the highest reason, as today.
3. **Broker** (`pluginCapabilityBroker.ts`): the allowlist handed to
   `shellCommandAllowed` becomes `HOST_SHELL_EXECUTABLE_ALLOWLIST ∪
   grant.executables`, where the grant is the *consented* manifest (the
   capability grant store already binds consent to the permission set, so a
   version that adds an executable is staged until the user allows it again,
   exactly like adding `shell` today). The Git-family subcommand refusals
   stay as they are; no per-name rules are written for declared names.
4. **Execution Policy** (agent-initiated calls only, `executionPolicyAllows`):
   unchanged semantics. The user's policy names executables an agent may
   trigger; the Host default stays `git`/`gh`/`glab`. The Settings editor for
   the policy lists the installed plugins' declared executables as
   candidates, so a user who wants `npm` for agents can add it in one click.
   The denylist branch keeps grading against `HOST_SHELL_EXECUTABLE_ALLOWLIST`
   only: a declared name is never allowed by omission from a denylist.
5. **Resolution and spawn**: the Host resolves the bare name against a Host
   snapshot of the user's login `PATH` taken at startup (the same source the
   terminal panes use), never against the request environment, the workspace
   or the plugin directory; the current directory is excluded explicitly
   (`NoDefaultCurrentDirectoryInExePath=1` on Windows and a resolver that only
   walks `PATH` entries). The resolved absolute path is what spawns, with
   `shell: false`. On Windows, a resolution that lands on `.cmd`/`.bat`
   (every npm-family shim) is run through `cmd.exe /d /s /c` **only when every
   argument matches a conservative charset** (`[A-Za-z0-9_.:/@=+,-]`, no
   quotes, no `%`, `^`, `&`, `|`, `<`, `>`, newline); otherwise the call is
   refused with an error naming the offending argument. This is the one
   place where refusing is the fix for an exploitable bug, not a feature cut:
   the same command with those characters would run *other* commands.
   `PATHEXT` is honoured in the Host's own order (`.exe`, `.cmd`, `.bat`,
   `.com`), not the user's.
6. **Activity**: one row per call with executable and first argument
   (existing redaction in the backend), plus the Guard's static grade of the
   full command line (`guard/classify.py`, `classify()` run in-process by the
   backend when it stores the row) as an informational column — the Guard
   does not block broker calls, the user sees what the grade would have been.
7. **Windows disclosure**: the broker runs on the Host, so declared
   executables work on Windows for views; a backend's `port: "shell"` does
   not exist there (TA-3), and the card says so.

## Alignment with the 2026-10-17 ruling

- "一律不限制": no catalogue, no refused names, no subcommand rules for
  declared names. Option A.
- "上架時系統掃描，掃描後揭露說明": the Registry scan produces the
  declared-versus-found table and the grade; the manifest remains the thing
  the broker enforces and the thing the scan is compared against.
- The two refusals that remain (`shell: "full"` for backends; Windows batch
  shims with shell metacharacters) are exploitable-bug fixes, not feature
  limits, and both are stated on the card and in the docs.

## Decisions for the user

1. Confirm option A (any name, graded; interpreters disclosed as "any
   program").
2. Confirm the Windows rule for `.cmd`/`.bat` shims (conservative argument
   charset or refuse). The alternative — resolving `npm.cmd` to `node` +
   `npm-cli.js` — is npm-specific and does not generalise.
3. Whether the Execution Policy editor should offer declared executables as
   one-click candidates (recommended) or leave the user to type them.

## Did we do enough (acceptance for PR C2)

- A manifest declaring `executables` validates identically in the contracts
  schema and the Registry; a path, extension, `$`, uppercase or duplicate
  name is rejected by both with the same message.
- `shell.run "npm test"` from a view whose consented grant declares `npm`
  succeeds; the same call from a version that did not declare it is
  `CAPABILITY_DENIED`; an agent-initiated call is denied until the user's
  policy names `npm`.
- `shell.run "./npm test"`, `"NPM test"`, `"env PATH=/tmp npm test"` and a
  workspace containing `./npm` all resolve to the Host's `npm` or are refused;
  a test pins the resolver's PATH source.
- On Windows (unit-tested with a fake resolver, VM-verified per the batch 2
  VM list): `npm test` runs through the shim; `npm test "a&calc"` is refused
  with the argument named; a `.exe` result never goes through `cmd.exe`.
- The disclosure card shows each declared executable with its grade; the
  Registry scan report marks found-but-undeclared names; the Activity table
  has a row per call with the Guard grade.
- Tests: `src/main/plugins` (broker, catalog, Activity, execution policy),
  `packages/plugin-contracts`, `marketplace/registry/tests`,
  `tests/infrastructure`, `plugins` (fingerprints bump once per version).
