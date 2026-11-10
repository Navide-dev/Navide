# TA-3 — Windows backends without a sandbox

Status: assessment, 0.2.39. Nothing is implemented in this version; on
Windows third-party backends stay unavailable and the disclosure card says so.

## Scope

`resolveBackendSandbox` (`src/main/plugins/pluginBackendSandbox.ts`) answers
`available: false` on `win32` ("third-party backends are not supported on
Windows yet") and the Host refuses to start the child: there is no
unsandboxed fallback by design. This assessment covers:

- whether AppContainer is a practical sandbox for a PyInstaller-style backend
  started from Electron;
- the attack surface of the alternative, a "no sandbox, highest-risk
  disclosure" mode;
- how either relates to the install consent card, which is the switch for
  third-party agent tools;
- what Windows users lose while nothing ships.

## What Windows users lose today

Everything that lives in a third-party backend: `backend.agentTools` (an
agent cannot call any third-party plugin's tools on Windows), the backend's
bridge ports (`shell`, and `network` if TA-1 ships), automatic backend
restart, pipeline nodes provided by plugins, channel adapters
(TA-4). What still works: views, their `shell.run` (the broker runs in the
Host), declared executables and network hosts from a view, first-
party backends (the Plans backend runs directly on every platform; it is
Navide's own code, shipped and signed with the app).

## Option A — AppContainer

Windows' process sandbox for non-UWP code: a process started with a
`SECURITY_CAPABILITIES` attribute runs under an AppContainer SID; it can open
only objects whose ACL grants that SID (or `ALL APPLICATION PACKAGES`), gets
network only through declared capabilities (`internetClient`,
`privateNetworkClientServer`), and cannot see other processes' windows or the
user profile. Low-privilege AppContainer (LPAC) removes the `ALL APPLICATION
PACKAGES` default grants too.

| Aspect | Finding |
|---|---|
| Starting the child | Node/Electron has no API for `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`. A small native helper is needed: a signed `.exe` (C/C++ or C#) that calls `CreateAppContainerProfile` / `DeriveAppContainerSidFromAppContainerName`, builds the attribute list and `CreateProcess`es the backend, or an N-API addon doing the same in-process. The helper is Host code, shipped in the installer and covered by the code-signing step. |
| File access | The Host grants the AppContainer SID read+execute on the package directory and read+write on the private data directory (`icacls` equivalent via `SetNamedSecurityInfo`), nothing else. `%TEMP%`/`%TMP%` already point into the data directory (`sandboxedEnvironment`), which PyInstaller one-file needs for extraction. The user profile, Documents, `%APPDATA%` (Navide's own data, the plugin store, the trust store) are unreadable by default — stronger than Seatbelt's metadata-only denial. |
| Network | Declared per capability at process creation: none (parity with today's macOS/Linux), `internetClient` (any host; parity with TA-1 option A), or none plus the Host bridge (TA-1 option B — the recommended shape works unchanged, because the bridge is a pipe, not a socket). Loopback is **blocked** for AppContainers unless a loopback exemption is registered (`CheckNetIsolation`), which is itself a useful property. |
| Resource watchdog | `pluginBackendResourceWatchdog.ts` identifies escaped processes on macOS by kernel exec image. On Windows the equivalent is a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and `BREAKAWAY` denied, created by the same helper; the AppContainer SID doubles as the process-tree marker (`GetTokenInformation(TokenAppContainerSid)`). |
| Known failure modes | Python under AppContainer: named pipes and `multiprocessing` need the pipe ACL to include the SID; `ssl` loads the Windows cert store fine; some wheels write to `%LOCALAPPDATA%` and fail (they get a clear `ERROR_ACCESS_DENIED`). Chromium's own sandbox and Firefox's use AppContainer in production, so the mechanism is mature; what is unverified is PyInstaller one-file inside it, on real user machines, and that needs the Windows VM round in the release loop. |
| Effort | Medium–large: helper + signing + ACL management + Job Object + a `win32` branch in `resolveBackendSandbox` + VM verification. Until it ships, third-party backends stay unavailable on Windows. |

## Option B — "No sandbox, highest-risk disclosure" mode

The backend runs as the user, exactly like any installed Windows program. The
controls that remain are the ones every desktop app relies on: publisher
vetting (Cloud application, admin review), Registry static scan and secret
scan of the executable, the signed disclosure envelope, the user's consent
bound to the exact package content, the Activity rows of every bridge call.

| Threat (STRIDE) | With no sandbox | What remains |
|---|---|---|
| **Information disclosure** | The backend reads anything the user can: CLI credential stores (`~/.claude`, `%APPDATA%`), SSH keys, browser profiles, the whole disk. The Host's bridge is irrelevant: direct Win32 calls bypass it. | Nothing technical; disclosure and vetting only |
| **Tampering** | Writes anywhere the user can, including Navide's plugin install root and trust store — the Guard grades a CLI agent doing this as `critical` (`plugin-store-write`); a backend doing it is invisible. | Package signing of installed plugins detects a tampered package at next load, not the tampering |
| **Elevation** | A backend can start any program, including `powershell`, and persist (Run key, scheduled task). | None |
| **Repudiation** | No Activity for direct OS actions (the Host sees only bridge calls). | The scan report at publish time is the only record of what the code *could* do |
| **Spoofing** | It can speak to the backend WebSocket and the hooks endpoint only with the tokens, which it can read from the 0600-equivalent files as the same user. Position 2 of the threat model (another OS user) still holds; position 3 collapses into "the plugin is the user". | — |
| **DoS** | CPU/memory watchdog needs a Job Object to be meaningful (kill the tree). | Job Object is small to add and worth adding regardless |

This is honest and consistent with "disclose, don't restrict" — the user
decides, with the card saying in one sentence "On Windows this plugin's
backend runs with all your rights; Navide cannot limit or see what it does" —
but it is a different product promise than macOS and Linux give, and a
plugin reviewed under the sandbox assumption (scan reports list what the
*bridge* could reach) is reviewed under false premises on Windows.

## Relationship with the install consent card

On Windows under option B the install consent card is the **only** gate
between an agent-requested install and a process with the user's full rights,
so:

- the no-sandbox line must be on the card itself, not in Settings, and must
  be present in the agent install request text the user approves in the main
  window;
- an install requested by an agent is still approved by a user gesture in a
  real window (`isAppWindowSender`), never by the agent's confirmation; this
  is already so and must stay test-pinned;
- the disclosure risk level on Windows is **highest** whatever the manifest
  declares, because the manifest describes bridge access the backend does not
  need.

## Recommendation

1. Keep "no backend on Windows" for 0.2.39 and 0.2.40, with the explicit
   card line "This plugin's backend is not available on Windows" and the
   plugin's views, agent-less, still working.
2. Build option A (AppContainer helper + Job Object) as the Windows sandbox,
   verified in the Windows VM round, before any third-party backend runs on
   Windows. Its network model (none / bridge / `internetClient`) lines up with
   TA-1 so one disclosure vocabulary serves all three platforms.
3. Offer option B only if A proves infeasible on real machines, and then as a
   per-package, highest-risk, main-window-gesture consent with the Job Object
   watchdog in place and the sentence above on the card. Not recommended as
   a default or as an interim.

## Did we do enough (acceptance when A is implemented)

- A Windows VM test starts a real PyInstaller backend under the helper and
  proves: reads outside package/data fail with `ERROR_ACCESS_DENIED`; writes
  outside data fail; a `connect()` to `127.0.0.1:<backend port>` fails; a
  child spawned by the backend is killed with the job; `%TEMP%` extraction
  works.
- `resolveBackendSandbox` on `win32` returns `kind: 'appcontainer'` only when
  the helper is present and signed; otherwise the existing `available: false`.
- The disclosure card on Windows reads the same as on macOS/Linux for the
  same manifest; the "not available on Windows" line disappears only for
  packages whose backend actually started.
- Tests: `src/main/plugins` (sandbox resolution, supervisor spawn, watchdog),
  `tests/infrastructure` (docs), Windows VM round in the release loop.
